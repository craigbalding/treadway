const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = process.env.FORM_BROWSER_MODULE_ROOT || path.join(__dirname, '../src/treadway/browser');
const {runPrep, runFinish} = require(path.join(root, 'entra-flow.js'));
const {EntraLogin, totp, createPrincipalVerifier} = require(path.join(root, 'entra.js'));
const {AttemptEvidence} = require(path.join(root, 'evidence.js'));
const {seedStore} = require(path.join(root, 'entra-runner.js'));
const IDP = 'https://login.microsoftonline.com', APP = 'https://workboard.example.invalid';
const ctx = {email: 'member@example.invalid', password: 'synthetic-password', idpOrigins: [IDP],
  appOrigin: APP, returnHost: 'workboard.example.invalid', prepMs: 90000, transitionMs: 30000, postSubmitMs: 10000};
const page = (body, inputs = [], links = []) => ({body, inputs, links, origin: IDP, host: 'login.microsoftonline.com', path: '/login', ready: 'complete'});
const PW = page('Enter password', [{type: 'password', name: 'passwd'}]);
const CODE = page('Enter the code', [{type: 'tel', id: 'idTxtBx_SAOTCC_OTC'}]);
const ARRIVED = {...page('Dashboard'), origin: APP, host: ctx.returnHost, path: '/home'};
const foreign = p => ({...p, origin: 'https://foreign.example.invalid'});

function fake(initial, destinations = []) {
  let screen = initial, time = 10000;
  const calls = [];
  return {
    calls, now: () => time, sleep: async ms => {time += ms;}, advance: ms => {time += ms;},
    set: p => {screen = p;}, inspect: async () => screen,
    waitReady: async () => {}, fill: async (selector) => {calls.push(['fill', selector]);},
    click: async selector => {calls.push(['click', selector]); if (destinations.length) screen = destinations.shift(); return 'clicked';},
    clickText: async pattern => {calls.push(['text', pattern.source]); if (destinations.length) screen = destinations.shift(); return 'clicked';},
    totp: () => '123456', beforeSubmit: async () => true,
    verifyPrincipal: async () => ({state: 'valid', principal: {id: 'synthetic'}}),
  };
}
const stops = code => e => e.code === code;

test('principal verifier keeps safe response metadata for every state and honors its explicit probe budget', async () => {
  const options = {origin: APP, actor: 'member', generation: 'synthetic', probe: '/principal', expected: {'user.id': 'member'}, timeoutMs: 20000};
  for (const [status, complete, bodyTruncated, body, state] of [
    [200, true, false, {user: {id: 'member'}, token: 'private-token'}, 'valid'],
    [200, true, false, {user: {id: 'unexpected-private-principal'}}, 'mismatch'],
    [401, true, false, {}, 'invalid'], [428, true, false, {token: 'private-token'}, 'unknown'],
    [200, false, true, {token: 'private-token'}, 'unknown'],
  ]) {
    const calls = [];
    const session = {cdp: {send: async (method, params, budget) => {
      calls.push({method, params, budget});
      return {result: {value: {status, complete, bodyTruncated, dispatched: true, body}}};
    }}};
    const result = await createPrincipalVerifier(session, options)();
    assert.equal(result.state, state);
    assert.equal(result.observation.status, status); assert.equal(result.observation.complete, complete);
    assert.equal(result.observation.bodyTruncated, bodyTruncated); assert.equal(result.observation.timeoutMs, 20000);
    assert.equal(calls[0].budget.timeoutMs, 21000);
    assert(calls[0].params.expression.includes('"timeoutMs":20000'));
    assert(!JSON.stringify(result).includes('private-token'));
    assert(!JSON.stringify(result).includes('unexpected-private-principal'));
  }
  for (const timeoutMs of [0, -1, 60001, true, '20000', Infinity])
    assert.throws(() => createPrincipalVerifier({}, {...options, timeoutMs}), /bounded_principal_probe/);
});

test('principal verifier exposes a known browser fetch deadline without response contents', async () => {
  const vm = require('node:vm');
  const session = {cdp: {send: async (method, params) => ({result: {value: await vm.runInNewContext(params.expression, {
    location: {origin: APP}, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () =>
      reject(Object.assign(new Error('private-fetch-detail'), {name: 'AbortError'})))),
  })}})}};
  const result = await createPrincipalVerifier(session, {origin: APP, actor: 'member', generation: 'synthetic',
    probe: '/principal', expected: {'user.id': 'member'}, timeoutMs: 5})();
  assert.equal(result.state, 'unknown'); assert.equal(result.observation.error, 'request_deadline');
  assert.equal(result.observation.errorType, 'AbortError'); assert.equal(result.observation.status, null);
  assert.equal(JSON.stringify(result).includes('private-fetch-detail'), false);
});

test('configured long principal budget is not silently shortened by the Entra callback wrapper', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-principal-budget-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  t.mock.timers.enable({apis: ['setTimeout']});
  const flow = new EntraLogin({cdp: {send: async () => ({result: {value: ARRIVED}})}}, {appOrigin: APP, evidenceRoot: dir,
    principal: {timeoutMs: 20000}, credentials: async () => {throw new Error('must not resolve');},
    verifyPrincipal: async () => new Promise(resolve => setTimeout(() => resolve({state: 'valid', principal: {id: 'member'}}), 12000)),
    beforeSubmit: async () => false});
  const result = flow.run();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(12000);
  assert.equal((await result).status, 'verified');
});

test('incomplete principal response metadata reaches the retained receipt without arbitrary callback fields', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-principal-evidence-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const flow = new EntraLogin({cdp: {send: async () => ({result: {value: ARRIVED}})}}, {appOrigin: APP, evidenceRoot: dir,
    credentials: async () => {throw new Error('must not resolve');}, beforeSubmit: async () => false,
    verifyPrincipal: async () => ({state: 'unknown', observation: {status: 428, complete: true, bodyTruncated: false,
      body: {token: 'private-token'}, error: 'private-error-token', dispatched: true, timeoutMs: 20000, elapsedMs: 12}})});
  const result = await flow.run();
  assert.equal(result.status, 'principal_not_verified');
  assert.equal(result.diagnostic.principalObservation.status, 428);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(JSON.stringify(result).includes('private-error-token'), false);
  const retained = JSON.parse(fs.readFileSync(path.join(result.evidence.directory, 'receipt.json')));
  assert.equal(retained.diagnostic.principalObservation.complete, true);
});

test('prep rechecks trusted origin after password readiness; no password entry on redirect', async () => {
  const io = fake(PW); io.waitReady = async () => io.set(foreign(PW));
  await assert.rejects(runPrep(io, ctx), stops('untrusted_idp_origin'));
  assert.equal(io.calls.length, 0);
});
test('MFA readiness redirect is refused before code entry', async () => {
  const io = fake(CODE); io.waitReady = async () => io.set(foreign(CODE));
  await assert.rejects(runFinish(io, ctx), stops('untrusted_idp_origin'));
  assert.equal(io.calls.length, 0);
});
test('MFA fill crossing deadline never submits afterward', async () => {
  const io = fake(CODE); io.fill = async () => {io.calls.push(['fill']); io.advance(2000);};
  await assert.rejects(runFinish(io, {...ctx, postSubmitMs: 1000}), stops('transition_deadline'));
  assert.deepEqual(io.calls, [['fill']]);
});
test('password and MFA submission guards require an explicit positive decision', async () => {
  for (const screen of [PW, CODE]) for (const decision of [false, undefined, {allowed: false}]) {
    const io = fake(screen); io.beforeSubmit = async () => decision;
    await assert.rejects(runFinish(io, ctx), stops('submission_refused'));
    assert.equal(io.calls.some(x => x[0] === 'click'), false);
  }
});
test('principal response cannot establish arrival after redirect or expiry', async () => {
  for (const change of [io => io.set(foreign(ARRIVED)), io => io.advance(2000)]) {
    const io = fake(ARRIVED);
    io.verifyPrincipal = async () => {change(io); return {state: 'valid', principal: {id: 'synthetic'}};};
    await assert.rejects(runFinish(io, {...ctx, postSubmitMs: 1000}), e => ['application_context_changed', 'transition_deadline'].includes(e.code));
  }
});
test('HTTP on the application hostname never establishes already_app', async () => {
  const io = fake({...ARRIVED, origin: APP.replace('https:', 'http:')});
  const result = await runPrep(io, {...ctx, prepMs: 1000});
  assert.equal(result.status, 'prep_stuck');
});
test('slow email-to-password transition uses one submission and a bounded observation', async () => {
  const io = fake(page('Sign in', [{type: 'email', name: 'loginfmt'}]));
  io.waitReady = async options => {
    if (options.predicate) {
      assert.ok(options.timeoutMs >= 24000);
      io.advance(24000); io.set(PW);
    }
  };
  const result = await runPrep(io, ctx);
  assert.equal(result.status, 'ready_to_submit');
  assert.equal(io.calls.filter(x => x[0] === 'click').length, 1);
});
test('same finish handles first-login Other app, manual seed, verification and app arrival', async () => {
  const other = page('Keep your account secure', [], [{txt: 'Set up a different authentication app'}]);
  const manual = page('Scan the QR code', [], [{txt: "Can't scan the QR code?"}]);
  const secret = page('Secret key: SYNTHETICSEEDONLY');
  const complete = page("You're all set", [], [{txt: 'Done'}]);
  const io = fake(other, [manual, secret, CODE, complete, ARRIVED]);
  const stored = [];
  io.readEnrollmentSecret = async () => 'JBSWY3DPEHPK3PXP';
  io.stageTotp = async value => stored.push(['candidate', value]);
  io.confirmTotp = async () => stored.push(['confirmed']);
  const result = await runFinish(io, ctx);
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.enrollment, {candidateStored: true, confirmed: true});
  assert.deepEqual(stored, [['candidate', 'JBSWY3DPEHPK3PXP'], ['confirmed']]);
  assert.equal(JSON.stringify(result).includes('JBSWY3DPEHPK3PXP'), false);
  assert.equal(io.calls.filter(x => x[0] === 'click').length, 1);
});
test('MFA registration requires a private store and never replaces an existing seed implicitly', async () => {
  const registration = page('Keep your account secure');
  const io = fake(registration);
  assert.equal((await runFinish(io, ctx)).status, 'totp_store_required');
  io.stageTotp = async () => {}; io.confirmTotp = async () => {};
  assert.equal((await runFinish(io, {...ctx, hasTotp: true})).status, 'existing_totp_registration_conflict');
  assert.deepEqual(io.calls, []);
});
test('OATH calculation matches the published RFC 6238 SHA1 vector (six digits)', () => {
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
  assert.throws(() => totp('invalid!seed'), /invalid_totp_credential/);
});
test('evidence keeps failed and successful attempts separately with private permissions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-evidence-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const a = new AttemptEvidence({root: dir}), b = new AttemptEvidence({root: dir});
  const first = a.start(); a.record({kind: 'error', code: 'READINESS_TIMEOUT'}); a.finish({status: 'incomplete'});
  const second = b.start(); b.finish({status: 'verified'});
  assert.notEqual(first.directory, second.directory);
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.directory, 'receipt.json'))).status, 'incomplete');
  assert.equal(fs.statSync(path.join(first.directory, 'events.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
});
test('Entra construction is passive; credential-provider failures still retain a private receipt', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-entra-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const calls = [];
  const flow = new EntraLogin({cdp: {send: async () => ({result: {value: PW}})}}, {appOrigin: APP, evidenceRoot: dir,
    credentials: async () => {calls.push('credentials'); throw new Error('private-provider-token');},
    verifyPrincipal: async () => {calls.push('probe'); return {state: 'missing'};}, beforeSubmit: async () => {calls.push('submit');}});
  assert.deepEqual(calls, []);
  const receipt = await flow.run();
  assert.deepEqual(calls, ['credentials']);
  assert.equal(receipt.status, 'operation_incomplete');
  const raw = fs.readFileSync(path.join(receipt.evidence.directory, 'receipt.json'), 'utf8');
  assert.equal(raw.includes('private-provider-token'), false);
  assert.equal(receipt.diagnostic.phase, 'credentials');
});

test('initial evidence is structural until credentials are resolved; a provider failure cannot leak page strings', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-initial-redaction-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const secret = 'synthetic-private-before-resolution';
  const snap = {...PW, path: '/' + secret, body: 'Enter password ' + secret, links: [{txt: secret, id: secret}]};
  const flow = new EntraLogin({cdp: {send: async () => ({result: {value: snap}})}}, {appOrigin: APP, evidenceRoot: dir,
    credentials: async () => {throw new Error(secret);}, verifyPrincipal: async () => ({state: 'invalid'}), beforeSubmit: async () => false});
  const receipt = await flow.run();
  assert.equal(JSON.stringify(receipt).includes(secret), false);
  assert.equal(fs.readFileSync(path.join(receipt.evidence.directory, 'events.jsonl'), 'utf8').includes(secret), false);
});

test('initial CDP error text is not retained before credential redaction is available', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-initial-error-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  let credentialReads = 0;
  const secret = 'synthetic-sensitive-initial-observation';
  const flow = new EntraLogin({cdp: {send: async () => {throw new Error(secret);}}}, {appOrigin: APP, evidenceRoot: dir,
    credentials: async () => {credentialReads++; return {};}, verifyPrincipal: async () => ({state: 'invalid'}), beforeSubmit: async () => false});
  const result = await flow.run();
  assert.equal(credentialReads, 0); assert.equal(result.status, 'operation_incomplete');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(fs.readFileSync(path.join(result.evidence.directory, 'events.jsonl'), 'utf8').includes(secret), false);
});

test('a valid application with IdP-like prose reuses without credential resolution', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-app-context-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const snap = {...ARRIVED, body: "No locked tasks. You're all set."};
  const flow = new EntraLogin({cdp: {send: async () => ({result: {value: snap}})}}, {appOrigin: APP, evidenceRoot: dir,
    credentials: async () => {throw new Error('must not resolve');}, verifyPrincipal: async () => ({state: 'valid', principal: {id: 'member'}}), beforeSubmit: async () => false});
  const receipt = await flow.run();
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.reused, true);
});

test('optional mask cleanup failure terminates once with a retained receipt and no credential action', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-mask-cleanup-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const snap = {...PW, documentId: 'synthetic-document'};
  let credentials = 0, masks = 0;
  const session = {cdp: {send: async (method, params) => {
    if (method === 'Page.captureScreenshot') throw new Error('synthetic-capture-failure');
    if (params.expression.includes('const s=window[')) throw new Error('synthetic-restore-failure');
    if (params.expression.includes('const state={nodes:')) {masks++; return {result: {value: true}};}
    if (params.expression.includes('requestAnimationFrame')) return {result: {value: true}};
    return {result: {value: snap}};
  }}};
  const result = await new EntraLogin(session, {appOrigin: APP, evidenceRoot: dir, screenshotMask: 'credentials',
    credentials: async () => {credentials++; return {username: 'member@example.invalid', password: 'synthetic'};},
    verifyPrincipal: async () => ({state: 'invalid'}), beforeSubmit: async () => true}).run();
  assert.equal(result.status, 'screenshot_mask_cleanup_incomplete');
  assert.equal(result.diagnostic.maskCleanup, 'incomplete');
  assert.equal(credentials, 0); assert.equal(masks, 1);
  assert.equal(fs.existsSync(path.join(result.evidence.directory, 'receipt.json')), true);
});

test('missing/malformed click acknowledgement stays unknown, retains a final image and never falls back', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-entra-receipt-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const response of [{result: {}}, {result: {value: {}}}]) {
    let clicks = 0, imagesAfterClick = 0;
    const session = {cdp: {send: async (method, options) => {
      if (method === 'Page.captureScreenshot') {
        if (clicks) imagesAfterClick++;
        return {data: Buffer.from('synthetic-image-boundary').toString('base64')};
      }
      const e = options.expression;
      if (e.includes('const b=')) {
        if (e.includes('let es=')) {clicks++; return response;}
        return {result: {value: {ok: true}}};
      }
      if (!e.includes('const inspect=')) return {result: {value: {ready: true}}};
      return {result: {value: {...PW, documentId: 'synthetic-document'}}};
    }}};
    const receipt = await new EntraLogin(session, {appOrigin: APP, evidenceRoot: dir,
      credentials: async () => ({username: ctx.email, password: ctx.password}),
      verifyPrincipal: async () => ({state: 'missing'}), beforeSubmit: async () => true}).run();
    assert.equal(receipt.status, 'browser_receipt_incomplete', JSON.stringify(receipt));
    assert.equal(clicks, 1);
    assert.ok(imagesAfterClick > 0);
    assert.equal(receipt.diagnostic.actions.at(-1).dispatch, 'unknown');
  }
});

test('TOTP staging persists privately, confirms once and refuses another identity', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-entra-store-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = seedStore(dir), value = {username: ctx.email, secret: 'JBSWY3DPEHPK3PXP'};
  const ref = await store.stage(value);
  assert.equal(fs.statSync(ref).mode & 0o777, 0o600);
  assert.deepEqual(seedStore(dir).candidate(), value);
  assert.throws(() => store.seedFor(ctx.email), /totp_enrollment_pending/);
  assert.throws(() => store.seedFor('another@example.invalid'), /totp_store_identity_differs/);
  await store.confirm(ref);
  assert.deepEqual(seedStore(dir).read(), value);
  assert.equal(seedStore(dir).seedFor(ctx.email), value.secret);
  assert.equal(fs.existsSync(ref), false);
  assert.throws(() => store.seedFor(ctx.email, 'OTHERSEEDVALUE'), /totp_credential_conflict/);
});
