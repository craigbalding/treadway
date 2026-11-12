const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {promisify} = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const {widgetFixture, browserRoot} = require('./browser-fixture.js');
const {EntraLogin, createPrincipalVerifier, totp} = require(path.join(browserRoot, 'entra.js'));

const APP = 'https://workboard.example.invalid', IDP = 'https://idp.example.invalid';
function loginPage(enrollment) {
  const stages = enrollment ? ['email', 'password', 'other', 'manual', 'seed', 'code', 'complete', 'kmsi'] : ['email', 'password', 'code', 'kmsi'];
  const pages = {
    email: '<h1>Sign in</h1><input name="loginfmt" type="email"><button id="idSIButton9">Next</button>',
    password: '<h1>Enter password</h1><input name="passwd" type="password"><button id="idSIButton9">Sign in</button>',
    other: '<h1>Keep your account secure</h1><button>Set up a different authentication app</button>',
    manual: '<h1>Scan the QR code</h1><button>Can\'t scan the QR code?</button>',
    seed: '<h1>Keep your account secure</h1><p>Account name: member@example.invalid</p><p>Secret key: JBSWY3DPEHPK3PXP</p><button>Next</button>',
    code: '<h1>Keep your account secure</h1><p>Enter the code</p><input id="idTxtBx_SAOTCC_OTC" type="tel"><button id="idSubmit_SAOTCC_Continue">Verify</button>',
    complete: '<h1>You\'re all set</h1><button>Done</button>',
    kmsi: '<h1>Stay signed in?</h1><button id="idBtn_Back">No</button>',
  };
  return `<!doctype html><body><script>
    const stages=${JSON.stringify(stages)},pages=${JSON.stringify(pages)};let index=0;
    function draw(){
      const stage=stages[index];document.body.innerHTML=pages[stage];
      document.querySelector('button').onclick=async()=>{
        if(stage==='password'||stage==='code'){
          const value=document.querySelector('input').value;
          const result=await fetch('/submitted',{method:'POST',body:JSON.stringify({kind:stage==='code'?'totp':'password',value})});
          if(!result.ok){document.body.insertAdjacentHTML('beforeend',stage==='code'?'<p>Verification code is incorrect</p>':'<p>Your account or password is incorrect</p>');return;}
        }
        if(stage==='kmsi'){location.href=${JSON.stringify(APP + '/home')};return;}
        setTimeout(()=>{index++;draw();},stage==='email'?120:20);
      };
    }draw();
  </script></body>`;
}

async function syntheticRoutes(cdp, enrollment = true) {
    const state = {enrollment, authenticated: false, submitted: [], transportErrors: []};
    const {submitted, transportErrors} = state;
    const paused = request => {
      (async () => {
        const url = new URL(request.request.url);
        let body, status = 200, type = 'text/html', extraHeaders = [];
        if (url.origin === APP && url.pathname === '/principal') {
          type = 'application/json'; status = state.authenticated ? 200 : 401;
          body = state.authenticated ? JSON.stringify({user: {email: 'member@example.invalid'}, access_token: 'synthetic-private-token'}) : '{}';
        } else if (url.origin === APP && url.pathname === '/home') {
          body = '<h1>Workboard</h1><p>No locked tasks</p>';
          if(state.authenticated) extraHeaders = [
            {name: 'Set-Cookie', value: 'session=synthetic-root-cookie; Path=/; Secure; HttpOnly; SameSite=Lax'},
            {name: 'Set-Cookie', value: 'session=synthetic-api-cookie; Path=/api; Secure; HttpOnly; SameSite=Strict'},
            {name: 'Set-Cookie', value: 'preference=synthetic-preference; Path=/; Secure'}];
        }
        else if (url.origin === APP) body = state.authenticated ? '<h1>Workboard</h1><p>No locked tasks</p>' : `<script>location.href=${JSON.stringify(IDP + '/login')}</script>`;
        else if (url.origin === IDP && url.pathname === '/submitted') {
          const submission=JSON.parse(request.request.postData);submitted.push(submission.kind);
          const accepted=submission.kind==='password'?submission.value==='synthetic-browser-password':
            [-30000,0,30000].some(offset=>submission.value===totp('JBSWY3DPEHPK3PXP',Date.now()+offset));
          if(!accepted)status=401;
          if (accepted && submission.kind === 'totp') state.authenticated = true;
          type = 'text/plain'; body = 'ok';
        } else if (url.origin === IDP) body = loginPage(state.enrollment);
        else {status = 404; body = 'unknown synthetic route';}
        await cdp.send('Fetch.fulfillRequest', {requestId: request.requestId, responseCode: status,
          responseHeaders: [{name: 'Content-Type', value: type},...extraHeaders], body: Buffer.from(body).toString('base64')});
      })().catch(e => transportErrors.push(e.message));
    };
    cdp.on('Fetch.requestPaused', paused);
    await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*'}]});
    return state;
}

test('real sandboxed browser uses the same Entra flow for login, enrollment and existing-session reuse',
  {skip: !process.env.CHROME_BIN, timeout: 60000}, async t => {
    const fixture = await widgetFixture('react');
    const evidenceRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'treadway-entra-acceptance-'));
    let complete = false;
    t.after(async () => {
      await fixture.close();
      if (complete) fs.rmSync(evidenceRoot, {recursive: true, force: true});
      else t.diagnostic('Retained synthetic failure evidence: ' + evidenceRoot);
    });
    const synthetic = await syntheticRoutes(fixture.session.cdp);
    const {submitted, transportErrors} = synthetic;
    const verifier = createPrincipalVerifier(fixture.session, {origin: APP, actor: 'member',
      generation: fixture.browserSession.generation, probe: '/principal', expected: {'user.email': 'member@example.invalid'}});
    const store = [], decisions = [];
    const options = {appOrigin: APP, signinUrl: APP + '/sign-in', idpOrigins: [IDP], evidenceRoot,
      principal: {actor: 'member', generation: fixture.browserSession.generation, probe: '/principal', expected: {'user.email': 'member@example.invalid'}},
      credentials: async () => ({username: 'member@example.invalid', password: 'synthetic-browser-password'}),
      beforeSubmit: async kind => {decisions.push(kind); return true;},
      totpStore: {stage: async ({secret}) => {store.push(secret); return 'synthetic-candidate';}, confirm: async ref => store.push(ref)},
      // First-enrollment verification must use its new seed, not this old provider.
      codeProvider: async () => 'not-a-valid-code', exportCookies: true, postSubmitMs: 20000};
    const first = await new EntraLogin(fixture.session, options).run();
    assert.equal(first.status, 'verified', JSON.stringify(first));
    assert.deepEqual(store, ['JBSWY3DPEHPK3PXP', 'synthetic-candidate']);
    assert.deepEqual(decisions, ['password', 'totp']);
    assert.deepEqual(submitted, ['password', 'totp']);
    assert.equal(first.screenshots.some(x => x.status === 'captured' && x.maskPolicy === 'none'), true);
    assert.equal(first.authentication.state, 'verified');
    const captured = JSON.parse(fs.readFileSync(first.authenticationState.artifact));
    assert.deepEqual(captured.cookies.filter(c=>c.name==='session').map(c=>c.path).sort(), ['/', '/api']);
    assert.equal(captured.cookies.some(c=>c.name==='preference'), true);
    assert.equal(captured.cookies.filter(c=>c.name==='session').every(c=>c.httpOnly&&c.secure), true);
    const evidence = fs.readFileSync(path.join(first.evidence.directory, 'events.jsonl'), 'utf8');
    for (const secret of ['synthetic-browser-password', 'JBSWY3DPEHPK3PXP', 'synthetic-private-token', 'synthetic-root-cookie']) assert.equal(evidence.includes(secret), false);
    const before = submitted.length;
    // A restarted persistent profile opens an inert marker, not the application.
    await fixture.session.navigate('data:text/html,synthetic-profile-return');
    const reused = await new EntraLogin(fixture.session, {...options, verifyPrincipal: verifier,
      credentials: async () => {throw new Error('must reuse without reading credentials');}}).run();
    assert.equal(reused.status, 'verified', JSON.stringify(reused)); assert.equal(reused.reused, true);
    assert.equal(submitted.length, before);
    assert.notEqual(reused.evidence.directory, first.evidence.directory);
    assert.equal(reused.authenticationState.complete, true);
    assert.notEqual(reused.authenticationState.artifact, first.authenticationState.artifact);
    // Reset only the synthetic fixture, then exercise returning-user MFA with
    // the same entry point and the newly provisioned seed.
    synthetic.enrollment = false; synthetic.authenticated = false;
    await fixture.session.navigate(IDP + '/login');
    const returning = await new EntraLogin(fixture.session, {...options,
      codeProvider: undefined, screenshotMask: 'credentials',
      credentials: async () => ({username: 'member@example.invalid', password: 'synthetic-browser-password', totpSecret: store[0]})}).run();
    assert.equal(returning.status, 'verified', JSON.stringify(returning));
    assert.equal(returning.screenshots.some(x=>x.status==='captured'&&x.masked&&x.file.includes('-password.png')), true);
    // Exercise the installed native Robot keyword against this same synthetic
    // authenticated session. Its native JSON output must retain observations.
    const refs = path.join(evidenceRoot, 'identities.json');
    fs.writeFileSync(refs, JSON.stringify({providers: {env: {type: 'environment'}}, identities: {member: {
      expected: {'user.email': 'member@example.invalid'}, credentials: {
        username: {provider: 'env', name: 'ENTRA_BROWSER_USERNAME'}, password: {provider: 'env', name: 'ENTRA_BROWSER_PASSWORD'}}}}}), {mode: 0o600});
    const config = path.join(evidenceRoot, 'entra.json');
    fs.writeFileSync(config, JSON.stringify({credentials: refs,
      application: {origin: APP, principal_probe: '/principal', idp_origins: [IDP]},
      browser: {root: path.join(fixture.root, 'browsers'), existing_session: fixture.browserSession.name, generation: fixture.browserSession.generation}}));
    const suite = path.join(evidenceRoot, 'flow.robot');
    fs.writeFileSync(suite, `*** Settings ***\nLibrary    treadway.entra_robot.EntraLibrary    ${config}\n*** Test Cases ***\nReuse\n    \${result}=    Sign In With Entra    member\n    Should Be Equal    \${result}[status]    verified\n`);
    const robotOutput = path.join(evidenceRoot, 'robot');
    await execFile(process.env.TREADWAY_PYTHON || 'python3', ['-m', 'robot', '--outputdir', robotOutput, '--output', 'output.json', suite],
      {timeout: 20000, env: {...process.env, PYTHONPATH: path.dirname(path.dirname(browserRoot))}});
    const nativeResult = fs.readFileSync(path.join(robotOutput, 'output.json'), 'utf8');
    assert.equal(nativeResult.includes('synthetic-browser-password'), false);
    assert.equal(nativeResult.includes('synthetic-private-token'), false);
    assert.equal(nativeResult.includes('robotEvidence'), true);
    assert.equal(nativeResult.includes('authenticationState'), true);
    // A wrong software code is rejected by the fixture; the flow must stop once.
    synthetic.enrollment = false; synthetic.authenticated = false;
    await fixture.session.navigate(IDP + '/login');
    const submissionsBefore = submitted.length;
    const rejected = await new EntraLogin(fixture.session, {...options, codeProvider: async()=> 'not-a-valid-code'}).run();
    assert.equal(rejected.status, 'code_rejected', JSON.stringify(rejected));
    assert.deepEqual(submitted.slice(submissionsBefore), ['password', 'totp']);
    for (const account of ['', '<p>Account name: another@example.invalid</p>']) {
      await fixture.session.eval(`document.body.innerHTML=${JSON.stringify('<h1>Keep your account secure</h1>' + account + '<p>Secret key: JBSWY3DPEHPK3PXP</p><button>Next</button>')}`);
      const refused = await new EntraLogin(fixture.session, options).run();
      assert.equal(refused.status, account ? 'enrollment_account_differs' : 'enrollment_account_unobserved');
      assert.equal(submitted.length, submissionsBefore + 2);
    }
    assert.deepEqual(transportErrors, []);
    complete = true;
  });

test('native fresh login resolves credentials privately and exports complete browser state',
  {skip: !process.env.CHROME_BIN, timeout: 60000}, async t => {
    const fixture = await widgetFixture('react');
    const evidenceRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'treadway-native-entra-'));
    let complete = false;
    t.after(async () => {
      await fixture.close();
      if (complete) fs.rmSync(evidenceRoot, {recursive: true, force: true});
      else t.diagnostic('Retained native synthetic failure evidence: ' + evidenceRoot);
    });
    const synthetic = await syntheticRoutes(fixture.session.cdp, false);
    const refs = path.join(evidenceRoot, 'identities.json');
    fs.writeFileSync(refs, JSON.stringify({providers: {env: {type: 'environment'}}, identities: {member: {
      expected: {'user.email': 'member@example.invalid'}, credentials: {
        username: {provider: 'env', name: 'ENTRA_BROWSER_USERNAME'},
        password: {provider: 'env', name: 'ENTRA_BROWSER_PASSWORD'},
        totp_secret: {provider: 'env', name: 'ENTRA_BROWSER_TOTP'}}}}}), {mode: 0o600});
    const config = path.join(evidenceRoot, 'entra.json');
    fs.writeFileSync(config, JSON.stringify({credentials: refs,
      application: {origin: APP, principal_probe: '/principal', idp_origins: [IDP]},
      browser: {root: path.join(fixture.root, 'browsers'), existing_session: fixture.browserSession.name,
        generation: fixture.browserSession.generation}}));
    const suite = path.join(evidenceRoot, 'fresh.robot');
    fs.writeFileSync(suite, `*** Settings ***\nLibrary    treadway.entra_robot.EntraLibrary    ${config}\n*** Test Cases ***\nFresh\n    \${result}=    Sign In With Entra    member\n    Should Be Equal    \${result}[status]    verified\n    Should Be True    \${result}[authenticationState][complete]\n`);
    const robotOutput = path.join(evidenceRoot, 'robot');
    await execFile(process.env.TREADWAY_PYTHON || 'python3', ['-m', 'robot', '--outputdir', robotOutput, '--output', 'output.json', suite],
      {timeout: 45000, env: {...process.env, PYTHONPATH: path.dirname(path.dirname(browserRoot)),
        ENTRA_BROWSER_USERNAME: 'member@example.invalid', ENTRA_BROWSER_PASSWORD: 'synthetic-browser-password',
        ENTRA_BROWSER_TOTP: 'JBSWY3DPEHPK3PXP'}});
    assert.deepEqual(synthetic.submitted, ['password', 'totp']);
    assert.equal(synthetic.authenticated, true);
    assert.deepEqual(synthetic.transportErrors, []);
    const nativeResult = fs.readFileSync(path.join(robotOutput, 'output.json'), 'utf8');
    for (const secret of ['synthetic-browser-password', 'JBSWY3DPEHPK3PXP', 'synthetic-private-token', 'synthetic-root-cookie'])
      assert.equal(nativeResult.includes(secret), false);
    const attempts = fs.readdirSync(path.join(robotOutput, 'treadway'));
    assert.equal(attempts.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(robotOutput, 'treadway', attempts[0], 'receipt.json')));
    assert.equal(receipt.authentication.state, 'verified');
    const snapshot = JSON.parse(fs.readFileSync(receipt.authenticationState.artifact));
    assert.deepEqual(snapshot.cookies.filter(c=>c.name==='session').map(c=>c.path).sort(), ['/', '/api']);
    assert.equal(snapshot.cookies.some(c=>c.name==='preference'), true);
    assert.equal(snapshot.actor, 'member');
    assert.equal(snapshot.generation, fixture.browserSession.generation);
    complete = true;
  });
