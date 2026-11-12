'use strict';
// Optional provider integration. Imports and construction are passive. The
// calibrated prep/finish and registration selectors live in entra-flow/pages.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {runPrep, runFinish, EntraStop} = require('./entra-flow.js');
const {classifyStage} = require('./entra-pages.js');
const {inspectErrorIsDisconnect} = require('./entra-adapter-errors.js');
const {AttemptEvidence} = require('./evidence.js');
const {ActorBrowser} = require('./actors.js');
const {captureEvidence} = require('./capture-evidence.js');
const {captureCookies, LIMITS: COOKIE_LIMITS} = require('./cookies.js');
const fillSource = fs.readFileSync(path.join(__dirname, 'browser-fill.function.js'), 'utf8');
const readinessSource = fs.readFileSync(path.join(__dirname, 'browser-readiness.function.js'), 'utf8');

function httpsOrigin(value) {
  try { const u = new URL(value); return u.origin === value && u.protocol === 'https:'; }
  catch { return false; }
}

// Same SHA-1 / six-digit / 30-second software OATH calculation used by the
// original returning-user and registration recipes; reject malformed seeds.
function totp(secret, time = Date.now()) {
  if (typeof secret !== 'string') throw new EntraStop('totp_credential_required');
  secret = secret.replace(/\s+/g, '').toUpperCase().replace(/=+$/, '');
  if (!/^[A-Z2-7]{16,128}$/.test(secret)) throw new EntraStop('invalid_totp_credential');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map(c => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const digest = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function inspectDocument() {
  if (!window.__treadwayEntraDocument) window.__treadwayEntraDocument = [...crypto.getRandomValues(new Uint32Array(4))].map(x => x.toString(16)).join('-');
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  return {
    documentId: window.__treadwayEntraDocument,
    origin: location.origin, host: location.host, path: location.pathname,
    ready: document.readyState,
    inputs: [...document.querySelectorAll('input:not([type=hidden])')].filter(visible).map(e =>
      ({type: e.type, name: e.name, id: e.id, im: e.getAttribute('inputmode')})),
    links: [...document.querySelectorAll('button,a,[role=button],input[type=submit]')].filter(visible).map(e =>
      ({id: e.id, txt: (e.innerText || e.value || '').trim().slice(0, 150)})),
    // Private working state only; it never enters the public receipt.
    body: (document.body?.innerText || '').slice(0, 20000),
  };
}

const pagePrelude = `const has=(inputs,pred)=>(inputs||[]).some(pred);const classifyStage=${classifyStage.toString()};const inspect=${inspectDocument.toString()};`;

function safeScreen(snap, config) {
  if (!snap) return null;
  return {stage: classifyStage(snap, config), origin: snap.origin || null,
    path: typeof snap.path === 'string' ? snap.path.split(/[?#]/)[0].slice(0, 200) : null,
    ready: snap.ready, inputTypes: [...new Set((snap.inputs || []).map(x => x.type))],
    passwordFieldPresent: (snap.inputs || []).some(x => x.name === 'passwd'),
    emailFieldPresent: (snap.inputs || []).some(x => x.name === 'loginfmt'),
    serviceErrorCodes: [...new Set((snap.body || '').match(/AADSTS\d+/g) || [])].slice(0, 5)};
}

const HELP = {
  email_no_transition: 'The email action was acknowledged, but the password screen was not observed. Inspect the retained transition and readiness evidence before another attempt.',
  prep_stuck: 'No supported next screen was established within the preparation window. The last screen and transition history are included; the cause is unestablished.',
  password_uncertain: 'A submitted action has no definitive observed outcome. Reconcile the session before any further credential submission.',
  transition_deadline: 'The observation deadline expired. No further action was intentionally started after expiry; reconcile any earlier dispatched action.',
  untrusted_idp_origin: 'The current origin differs from the configured trusted identity-provider origins. Check the redirect and explicit origin configuration.',
  screen_changed: 'The document or screen changed before the dependent action. Inspect the new screen; no automatic resubmission was made.',
  target_disconnected: 'The selected browser target disconnected. Inspect browser lifecycle evidence and reconcile any action already dispatched.',
  totp_store_required: 'MFA setup was detected. Configure a private TOTP store with stage and confirm operations to retain the new seed before verification.',
  totp_credential_required: 'A code challenge was detected. Supply this identity’s TOTP credential or an explicit code provider.',
  totp_enrollment_pending: 'A prior enrollment has a retained candidate seed. Reconcile that enrollment before submitting another code; the candidate was preserved.',
  credential_resolution_incomplete: 'The configured credential provider could not supply this identity. Inspect provider availability; no fallback identity or login retry was used.',
  blocked: 'The identity provider reported a lock, rejection or password-change requirement. Resolve that explicit condition before continuing.',
};

function createPrincipalVerifier(session, {origin, actor, generation, probe, expected, timeoutMs = 5000} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000)
    throw new Error('bounded_principal_probe_timeout_required');
  const browser = new ActorBrowser(session, {name: actor, generation, origin, probe, expected});
  return async () => {
    const started = Date.now();
    const metadata = (value = {}, error = null) => ({
      status: Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : null,
      complete: value.complete === true,
      bodyTruncated: typeof value.bodyTruncated === 'boolean' ? value.bodyTruncated : null,
      dispatched: typeof value.dispatched === 'boolean' ? value.dispatched : null,
      error: error || (['request_observation_incomplete', 'request_deadline'].includes(value.error) ? value.error : null),
      errorType: ['TypeError', 'AbortError', 'TimeoutError', 'Error'].includes(value.errorType) ? value.errorType : null,
      timeoutMs, elapsedMs: Date.now() - started,
    });
    let observation;
    try {observation = await browser.request(browser.probe, {verify: false, timeoutMs});}
    catch (error) {
      if (error.observation?.prerequisiteError === 'actor_origin_differs')
        return {state: 'context_changed', observation: metadata(error.observation, 'actor_origin_differs')};
      return {state: 'unknown', observation: metadata(error.observation,
        error.code === 'CDP_COMMAND_TIMEOUT' ? 'command_timeout' : 'principal_observation_incomplete')};
    }
    const safe = metadata(observation);
    if (!observation.complete) return {state: 'unknown', observation: safe};
    if (observation.status === 401) return {state: 'invalid', observation: safe};
    if (observation.status !== 200 || !observation.body || typeof observation.body !== 'object')
      return {state: 'unknown', observation: safe};
    const principal = {};
    for (const [key, wanted] of Object.entries(expected)) {
      let actual = observation.body;
      for (const part of key.split('.')) actual = actual && typeof actual === 'object' && Object.hasOwn(actual, part) ? actual[part] : undefined;
      if (typeof actual !== typeof wanted || actual !== wanted) return {state: 'mismatch', observation: safe};
      principal[key] = actual;
    }
    return {state: 'valid', principal, observation: safe};
  };
}

async function bounded(callback, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(callback), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new EntraStop(code)), Math.max(1, milliseconds));
    })]);
  } finally {clearTimeout(timer);}
}

class EntraLogin {
  constructor(session, {appOrigin, signinUrl, idpOrigins = ['https://login.microsoftonline.com', 'https://mysignins.microsoft.com'],
    credentials, verifyPrincipal, principal, beforeSubmit, totpStore, codeProvider, prepMs = 90000,
    transitionMs = 30000, postSubmitMs = 150000, evidenceRoot, screenshotMask = 'none', exportCookies = false, onDiagnostic} = {}) {
    if (!verifyPrincipal && principal) verifyPrincipal = createPrincipalVerifier(session, {...principal, origin: appOrigin});
    if (!session?.cdp || !httpsOrigin(appOrigin) || !Array.isArray(idpOrigins) || !idpOrigins.length || !idpOrigins.every(httpsOrigin) ||
        typeof credentials !== 'function' || typeof verifyPrincipal !== 'function' || typeof beforeSubmit !== 'function')
      throw new Error('explicit_entra_session_origins_credentials_verifier_and_submission_guard_required');
    if (signinUrl && ![appOrigin, ...idpOrigins].includes(new URL(signinUrl).origin)) throw new Error('signin_origin_differs');
    if (![prepMs, transitionMs, postSubmitMs].every(n => Number.isSafeInteger(n) && n > 0 && n <= 300000)) throw new Error('bounded_entra_deadlines_required');
    if (principal?.timeoutMs !== undefined && (!Number.isSafeInteger(principal.timeoutMs) || principal.timeoutMs <= 0 || principal.timeoutMs > 60000))
      throw new Error('bounded_principal_probe_timeout_required');
    if (!['none', 'credentials'].includes(screenshotMask)) throw new Error('explicit_screenshot_mask_policy_required');
    if (typeof exportCookies !== 'boolean' || (exportCookies &&
        (typeof principal?.actor !== 'string' || !principal.actor || typeof principal?.generation !== 'string' || !principal.generation)))
      throw new Error('cookie_export_actor_generation_required');
    this.session = session;
    this.options = {appOrigin, signinUrl: signinUrl || appOrigin, idpOrigins: [...idpOrigins], credentials, verifyPrincipal,
      beforeSubmit, totpStore, codeProvider, prepMs, transitionMs, postSubmitMs, evidenceRoot, screenshotMask,
      exportCookies, cookieBinding: principal && {actor: principal.actor, generation: principal.generation},
      principalTimeoutMs: principal?.timeoutMs === undefined ? 10000 : principal.timeoutMs + 1000, onDiagnostic};
    this.running = false;
  }

  async run() {
    if (this.running) throw new Error('entra_flow_already_running');
    this.running = true;
    const o = this.options, started = Date.now(), transitions = [], actions = [];
    const journal = new AttemptEvidence({root: o.evidenceRoot, kind: 'entra'});
    // Prove evidence persistence before any application request or browser action.
    let evidence;
    try { evidence = journal.start(); }
    catch { this.running = false; throw new Error('private_attempt_evidence_unavailable; no login started'); }
    let last = null, binding = null, phase = 'existing_session', credential, pendingSeed = null, screenshotDue = true;
    const screenshots = [];
    let redactionReady = false;
    const sensitive = new Set();
    const remember = value => { if (typeof value === 'string' && value) sensitive.add(value); return value; };
    const redact = value => {
      if (typeof value === 'string') {
        for (const secret of [...sensitive].sort((a,b) => b.length-a.length)) value = value.split(secret).join('[REDACTED]');
        return value.replace(/(Secret key:\s*)[A-Z2-7 ]{10,128}/gi, '$1[REDACTED]').replace(/\botpauth:\/\/[^\s<>"']+/gi, '[REDACTED]').replace(/\b\d{6,8}\b/g, '[CODE]');
      }
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /password|secret|token|cookie|authorization/i.test(k) && !['boolean','number'].includes(typeof v) ? '[REDACTED]' : redact(v)]));
      return value;
    };
    const config = {...o, returnHost: new URL(o.appOrigin).host};
    const diagnostic = {phase, lastScreen: null, transitions, actions};
    const retainPrincipalObservation = result => {
      const value = result?.observation;
      if (!value || typeof value !== 'object') return;
      diagnostic.principalObservation = {
        status: Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : null,
        complete: value.complete === true,
        bodyTruncated: typeof value.bodyTruncated === 'boolean' ? value.bodyTruncated : null,
        dispatched: typeof value.dispatched === 'boolean' ? value.dispatched : null,
        error: ['actor_origin_differs', 'command_timeout', 'principal_observation_incomplete', 'request_observation_incomplete', 'request_deadline'].includes(value.error) ? value.error : null,
        errorType: ['TypeError', 'AbortError', 'TimeoutError', 'Error'].includes(value.errorType) ? value.errorType : null,
        timeoutMs: Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0 ? value.timeoutMs : null,
        elapsedMs: Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : null,
      };
    };
    const overallDeadline = started + o.prepMs + o.postSubmitMs + 30000;
    const call = (callback, code, limit = 10000) => bounded(callback, Math.min(limit, Math.max(1, overallDeadline - Date.now())), code);
    const privateScreen = () => {
      if (!redactionReady) return {...diagnostic.lastScreen, text: 'not_retained_before_credential_resolution'};
      return redact({...diagnostic.lastScreen, body: last?.body || '',
        controls: (last?.links || []).map(x => ({id: x.id, label: x.txt})).slice(0, 40)});
    };
    let maskCleanupIncomplete = false;
    const capture = async () => {
      if (maskCleanupIncomplete) return;
      if (!last?.documentId) return;
      const stage = classifyStage(last, config);
      const image = await captureEvidence(this.session, {
        file: path.join(evidence.directory, `step-${String(screenshots.length + 1).padStart(3, '0')}-${stage}.png`),
        documentId: last.documentId, stage, sensitive: [...sensitive], mask: o.screenshotMask,
        observe: async () => {const snap = await evaluate(`(()=>{${pagePrelude}return inspect();})()`); return {documentId: snap.documentId, stage: classifyStage(snap, config)};},
      });
      screenshots.push(image); journal.record({kind: 'screenshot', image}); screenshotDue = false;
      if (image.maskCleanup === 'incomplete') {
        maskCleanupIncomplete = true;
        diagnostic.maskCleanup = 'incomplete';
        throw new EntraStop('screenshot_mask_cleanup_incomplete');
      }
    };
    const evaluate = async (expression, timeoutMs = 3000) => {
      let r;
      try {r = await this.session.cdp.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}, {timeoutMs});}
      catch (error) {
        error.browserError = {name: error.name || 'CDPError', message: String(error.message || '').split('\n')[0].slice(0, 500)};
        throw error;
      }
      if (r.exceptionDetails) {
        const error = new EntraStop('browser_evaluation_failed');
        error.browserError = {name: r.exceptionDetails.exception?.className || 'JavaScriptError',
          message: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').split('\n')[0].slice(0, 500)};
        throw error;
      }
      if (!r.result || !Object.hasOwn(r.result, 'value')) throw new EntraStop('browser_receipt_incomplete');
      return r.result?.value;
    };
    const inspect = async () => {
      try {
        last = await evaluate(`(()=>{${pagePrelude}return inspect();})()`);
      } catch (e) {
        if (inspectErrorIsDisconnect(e)) throw new EntraStop('target_disconnected');
        // Only a known navigation race is a loading observation. A timeout or
        // unrelated evaluation failure must keep its actual failure category.
        if (!/execution context was destroyed|cannot find context with specified id/i.test(String(e.message))) throw e;
        last = {ready: 'loading', inputs: [], links: [], body: ''};
      }
      const exposedSeed = (last.body || '').match(/Secret key:\s*([A-Z2-7 ]{16,128})/i)?.[1];
      if (exposedSeed) {remember(exposedSeed); remember(exposedSeed.replace(/\s+/g, ''));}
      const screen = redact(safeScreen(last, config));
      if (!redactionReady) {
        // Reuse can succeed without reading credentials. Before resolution,
        // retain structural facts only: arbitrary page strings may be secrets.
        screen.path = null;
        if (![o.appOrigin, ...o.idpOrigins].includes(screen.origin)) screen.origin = 'unconfigured';
      }
      diagnostic.lastScreen = screen;
      if (!transitions.length || JSON.stringify(transitions.at(-1).screen) !== JSON.stringify(screen)) {
        transitions.push({atMs: Date.now() - started, screen});
        if (transitions.length > 32) transitions.shift();
        journal.record({kind: 'screen_observed', atMs: Date.now() - started, screen: privateScreen()});
        screenshotDue = true;
      }
      if (screenshotDue && last.ready === 'complete') await capture();
      return last;
    };
    const action = async (kind, value, selector) => {
      if (!binding) throw new EntraStop('screen_binding_required');
      const b = binding, remaining = b.deadline - Date.now();
      if (remaining <= 0) throw new EntraStop('transition_deadline');
      // Origin, document, stage and deadline are checked in the same browser
      // evaluation as the action. This closes redirects during readiness waits.
      const expression = `(()=>{${pagePrelude}
        const b=${JSON.stringify(b)},s=inspect();
        if(Date.now()>=b.deadline)return {error:'transition_deadline'};
        if(s.documentId!==b.documentId||s.origin!==b.origin||s.ready!=='complete'||classifyStage(s,b.config)!==b.stage)return {error:'screen_changed'};
        ${kind === 'fill' ? `return (${fillSource})(${JSON.stringify({origin: b.origin, selector, value})});` : ''}
        ${kind === 'readSeed' ? `const account=s.body.match(/Account name:\\s*([^\\n\\r]+)/i);if(!account)return {error:'enrollment_account_unobserved'};if(account[1].trim().toLowerCase()!==b.username.toLowerCase())return {error:'enrollment_account_differs'};const m=s.body.match(/Secret key:\\s*([A-Z2-7 ]{16,128})/i);return {secret:m?m[1].replace(/\\s+/g,''):null};` : ''}
        ${['click', 'tile', 'text'].includes(kind) ? `let es=${kind === 'click' ? `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))` : kind === 'tile' ? `Array.from(document.querySelectorAll('[data-test-id]')).filter(e=>e.getAttribute('data-test-id')===${JSON.stringify(value)})` : `Array.from(document.querySelectorAll('button,a,[role=button],input[type=submit]')).filter(e=>new RegExp(${JSON.stringify(value?.source)},${JSON.stringify(value?.flags)}).test((e.innerText||e.value||'').trim()))`};
          es=es.filter(e=>e.getClientRects().length&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');
          if(es.length!==1)return {clicked:false,ambiguous:es.length>1};es[0].click();return {clicked:true};` : ''}
      })()`;
      const entry = {operation: kind, stage: b.stage, atMs: Date.now() - started, dispatch: 'unknown'};
      if (kind !== 'readSeed') actions.push(entry);
      if (kind !== 'readSeed') journal.record({kind: 'action_started', action: entry});
      if (kind !== 'readSeed') screenshotDue = true;
      let result;
      try { result = await evaluate(expression, Math.min(3000, remaining)); }
      catch (e) { entry.outcome = 'unknown'; throw e; }
      if (result?.error) { entry.dispatch = 'refused'; throw new EntraStop(result.error); }
      if (kind === 'fill' && result?.ok !== true) { entry.dispatch = 'unknown'; throw new EntraStop('field_readback_incomplete'); }
      if (result?.ambiguous) { entry.dispatch = 'refused'; throw new EntraStop('action_ambiguous'); }
      if (['click', 'tile', 'text'].includes(kind) && typeof result?.clicked !== 'boolean') throw new EntraStop('browser_receipt_incomplete');
      entry.dispatch = result?.clicked === false ? 'absent' : 'acknowledged';
      if (kind !== 'readSeed') screenshotDue = true;
      if (kind !== 'readSeed') journal.record({kind: 'action_observed', action: entry});
      return kind === 'readSeed' ? remember(result?.secret) : kind === 'fill' ? result : result?.clicked ? 'clicked' : 'absent';
    };
    const finishResult = async result => {
      if (last && screenshotDue) {
        try {await capture();}
        catch {result = {...result, status: 'diagnostic_capture_incomplete'}; diagnostic.finalCapture = 'incomplete';}
      }
      const receipt = {authentication: {state: 'unknown'}, ...result, ...(result.principal ? {principal: redact(result.principal)} : {}), evidence, screenshots, elapsedMs: Date.now() - started,
        diagnostic: {...diagnostic, phase, elapsedMs: Date.now() - started},
        nextStep: result.nextStep || HELP[result.status] || 'Use the recorded screen, actions and verification result to resolve this condition before another login.'};
      if (o.onDiagnostic) {
        try { receipt.additionalEvidence = redact(await call(() => o.onDiagnostic(receipt), 'diagnostic_callback_deadline', 5000)); }
        catch { receipt.diagnosticPersistence = 'failed'; }
      }
      try {
        if (last) journal.record({kind: 'final_screen', screen: privateScreen()});
        journal.finish(receipt);
      } catch { receipt.evidencePersistence = 'incomplete'; }
      return receipt;
    };
    const completeVerified = async result => {
      if (result.status !== 'verified') return finishResult(result);
      result = {...result, authentication: {state: 'verified'},
        authenticationState: {required: o.exportCookies, complete: false, status: 'not_requested'}};
      if (o.exportCookies) {
        phase = 'authentication_state';
        journal.record({kind: 'authentication_verified', reused: result.reused === true});
        journal.record({kind: 'cookie_export_started'});
        try {
          const snapshot = await captureCookies(this.session, {origin: o.appOrigin, ...o.cookieBinding});
          // Keep raw credentials exclusively in the private artifact, never the receipt.
          const artifact = path.join(evidence.directory, 'browser-cookies.json');
          const fd = fs.openSync(artifact, 'wx', 0o600);
          try {fs.writeFileSync(fd, JSON.stringify(snapshot, null, 2) + '\n'); fs.fsyncSync(fd);}
          finally {fs.closeSync(fd);}
          const directory = fs.openSync(evidence.directory, 'r');
          try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
          result.authenticationState = {required: true, complete: true, status: 'captured', artifact,
            cookieCount: snapshot.cookies.length, limits: snapshot.limits};
          journal.record({kind: 'cookie_export_completed', state: result.authenticationState});
        } catch {
          result.status = 'authentication_state_incomplete';
          result.authenticationState = {required: true, complete: false, status: 'unknown', limits: [...COOKIE_LIMITS]};
          result.nextStep = 'Authentication was verified, but required browser state export is incomplete. Preserve the profile and retry observation/export; do not force another login.';
          journal.record({kind: 'cookie_export_incomplete', outcome: 'unknown'});
        }
      }
      return finishResult(result);
    };
    try {
      let initial = await inspect();
      if (initial.origin !== o.appOrigin && !o.idpOrigins.includes(initial.origin)) {
        phase = 'application_context';
        const deadline = Date.now() + Math.min(o.transitionMs, o.prepMs);
        const navigation = await this.session.cdp.send('Page.navigate', {url: o.appOrigin},
          {timeoutMs: Math.min(15000, deadline - Date.now())});
        if (navigation.errorText) throw new EntraStop('navigation_failed');
        while (Date.now() < deadline) {
          initial = await inspect();
          if (initial.ready === 'complete' && (initial.origin === o.appOrigin || o.idpOrigins.includes(initial.origin))) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (initial.ready !== 'complete' || (initial.origin !== o.appOrigin && !o.idpOrigins.includes(initial.origin)))
          throw new EntraStop('application_context_unestablished');
      }
      if (initial.origin === o.appOrigin && initial.ready === 'complete') {
        const existing = await call(() => o.verifyPrincipal(), 'principal_observation_deadline', o.principalTimeoutMs);
        retainPrincipalObservation(existing);
        if (existing?.state === 'valid') {
          const after = await inspect();
          if (after.ready !== 'complete' || after.origin !== o.appOrigin) throw new EntraStop('application_context_changed');
          return await completeVerified({status: 'verified', reused: true, principal: existing.principal});
        }
        if (existing?.state === 'context_changed') {
          journal.record({kind: 'principal_context_changed', dispatched: false});
          initial = await inspect();
          if (initial.ready !== 'complete' || !o.idpOrigins.includes(initial.origin))
            throw new EntraStop('application_context_changed');
        } else if (!['invalid', 'missing'].includes(existing?.state))
          return await finishResult({status: 'principal_not_verified', verification: existing?.state || 'unknown'});
      }
      if (o.idpOrigins.includes(initial.origin)) config.signinUrl = null;
      phase = 'credentials'; credential = await call(() => o.credentials(), 'credential_resolution_deadline');
      if (!credential || typeof credential.username !== 'string' || typeof credential.password !== 'string') throw new EntraStop('credentials_unavailable');
      remember(credential.password); remember(credential.totpSecret);
      redactionReady = true;
      config.email = credential.username; config.password = credential.password; config.hasTotp = !!credential.totpSecret;
      const io = {
        inspect, bind: (snap, bound) => {binding = {...bound, documentId: snap.documentId, origin: snap.origin, username: config.email,
          config: {appOrigin: o.appOrigin, afterPasswordSubmit: bound.afterPasswordSubmit}};},
        waitReady: async opts => {
          const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs));
          let result;
          try {result = await evaluate(`(${readinessSource})(${JSON.stringify({...opts, timeoutMs: Math.max(1, timeoutMs - 100)})})`, timeoutMs);}
          catch (error) {
            if (/execution context was destroyed|cannot find context with specified id/i.test(String(error.message))) throw new EntraStop('screen_changed');
            throw error;
          }
          if (!result?.ready) {
            diagnostic.readiness = {unmet: result?.unmet || ['condition_unknown'], timeoutMs};
            throw new EntraStop('READINESS_TIMEOUT');
          }
          return result;
        },
        fill: (sel, val) => action('fill', val, sel), click: sel => action('click', null, sel),
        clickTile: email => action('tile', email), clickText: re => action('text', {source: re.source, flags: re.flags}),
        navigate: async url => {
          const r = await this.session.cdp.send('Page.navigate', {url}, {timeoutMs: Math.min(15000, o.prepMs)});
          if (r.errorText) throw new EntraStop('navigation_failed');
        },
        beforeSubmit: kind => call(() => o.beforeSubmit(kind), 'submission_guard_deadline', binding ? binding.deadline - Date.now() : 10000),
        verifyPrincipal: async () => {
          const result = await call(() => o.verifyPrincipal(), 'principal_observation_deadline',
            Math.min(o.principalTimeoutMs, binding ? binding.deadline - Date.now() : o.principalTimeoutMs));
          retainPrincipalObservation(result);
          return result;
        },
        now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, Math.max(1, ms))),
        totp: async seed => remember(seed ? totp(seed) : o.codeProvider ? await call(() => o.codeProvider(), 'code_provider_deadline') : credential.totpSecret ? totp(credential.totpSecret) : null),
        readEnrollmentSecret: () => action('readSeed'),
      };
      if (o.totpStore?.stage && o.totpStore?.confirm) {
        io.stageTotp = async secret => {pendingSeed = await call(() => o.totpStore.stage({username: credential.username, secret}), 'totp_store_deadline');};
        io.confirmTotp = async () => call(() => o.totpStore.confirm(pendingSeed), 'totp_confirmation_deadline');
      }
      phase = 'prep'; const prep = await runPrep(io, config);
      if (!['ready_to_submit', 'challenge', 'already_app'].includes(prep.status)) return await finishResult(prep);
      phase = 'finish'; return await completeVerified(await runFinish(io, config));
    } catch (e) {
      const known = e instanceof EntraStop;
      const code = known ? e.code : e.code === 'CDP_COMMAND_TIMEOUT' ? 'browser_command_timeout' : inspectErrorIsDisconnect(e) ? 'target_disconnected' : 'operation_incomplete';
      // Error messages from providers/browser pages may contain secrets. Retain
      // safe machine fields; raw exceptions never cross this receipt boundary.
      diagnostic.error = {code, ...(e.method ? {method: e.method} : {}), ...(e.timeoutMs ? {timeoutMs: e.timeoutMs} : {})};
      if (e.browserError) diagnostic.error.browser = redactionReady ? redact(e.browserError) : {
        name: ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'JavaScriptError'].includes(e.browserError.name) ? e.browserError.name : 'BrowserError',
        message: 'not_retained_before_credential_resolution',
      };
      // Observe once more after a failed/unknown action; it may have changed the
      // page before its acknowledgement was lost. This is read-only recovery.
      screenshotDue = true;
      try {await inspect();} catch {diagnostic.finalObservation = 'incomplete';}
      return await finishResult({status: code, outcome: 'unknown'});
    } finally {
      journal.close(); credential = null; pendingSeed = null; config.password = null; this.running = false;
    }
  }
}

module.exports = {EntraLogin, totp, safeScreen, createPrincipalVerifier};
