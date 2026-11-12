'use strict';
// Tests the ACTUAL driver logic (entra-flow runPrep/runFinish) with only the browser
// boundary faked; the fake EVALUATES generated predicate strings against a page model and
// uses an ADVANCING fake clock (sleep advances now) so deadline-based loops terminate.
const { runPrep, runFinish } = require(require('node:path').join(process.env.FORM_BROWSER_MODULE_ROOT || require('node:path').join(__dirname,'../src/treadway/browser'), 'entra-flow.js'));
const { adaptedClick } = require(require('node:path').join(process.env.FORM_BROWSER_MODULE_ROOT || require('node:path').join(__dirname,'../src/treadway/browser'), 'entra-io.js'));

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}: got ${JSON.stringify(got)}`);
  if (!ok) fails++;
}

const RH = 'workboard.example.invalid';
const IDP = 'https://login.microsoftonline.com';          // trusted IdP origin
const APPO = 'https://' + RH;                              // trusted full app origin
const EMAIL = { host: 'login.microsoftonline.com', origin: IDP, ready: 'complete', path: '/authorize', inputs: [{ name: 'loginfmt', type: 'email', id: 'i0116' }], btns: ['idSIButton9'], body: 'Sign in' };
const EMAIL_RETRY = { ...EMAIL, body: 'Sign in\nThere was an issue looking up your account. Tap Next to try again.' };
const PW = { host: 'login.microsoftonline.com', origin: IDP, ready: 'complete', path: '/login', inputs: [{ name: 'passwd', type: 'password' }], btns: ['idSIButton9'], body: 'Enter password' };
const PWERR = { ...PW, body: 'Your account or password is incorrect.' };
const TOTP = { host: 'login.microsoftonline.com', origin: IDP, ready: 'complete', path: '/login', inputs: [{ id: 'idTxtBx_SAOTCC_OTC', type: 'tel' }], btns: ['idSubmit_SAOTCC_Continue', 'idSIButton9'], body: 'Enter the code displayed in your authenticator app' };
const KMSI = { host: 'login.microsoftonline.com', origin: IDP, ready: 'complete', path: '/login', inputs: [{ type: 'checkbox', id: 'KmsiCheckboxField' }], btns: ['idBtn_Back', 'idSIButton9'], body: 'Stay signed in? Do this to reduce the number of times you are asked to sign in.' };
const APP = { host: RH, origin: APPO, ready: 'complete', path: '/en', inputs: [], btns: [], body: 'Dashboard' };
// Foreign / untrusted pages (phishing-shaped): same inputs/body, WRONG origin.
const PW_FOREIGN = { ...PW, host: 'foreign.example.invalid', origin: 'https://foreign.example.invalid' };
const TOTP_FOREIGN = { ...TOTP, host: 'foreign.example.invalid', origin: 'https://foreign.example.invalid' };
const APP_HTTP = { ...APP, origin: 'http://' + RH };       // host matches but not the full HTTPS app origin
const CTX = { email: 'member@example.invalid', password: 'synthetic-password', returnHost: RH, idpOrigins: [IDP], appOrigin: APPO, transitionMs: 2000, postSubmitMs: 5000, lookupAttempts: 8 };

function qs(page, sel) {
  sel = sel.trim();
  if (sel.includes(',')) return sel.split(',').some(s => qs(page, s)) ? {} : null;
  let m;
  if ((m = sel.match(/^input\[name=(\w+)\]$/))) return (page.inputs || []).find(i => i.name === m[1]) || null;
  if ((m = sel.match(/^input\[type=(\w+)\]$/))) return (page.inputs || []).find(i => i.type === m[1]) || null;
  if ((m = sel.match(/^#(.+)$/))) return ((page.inputs || []).some(i => i.id === m[1]) || (page.btns || []).includes(m[1])) ? {} : null;
  return null;
}
function evalPredicate(page, predicate) {
  const document = { querySelector: s => qs(page, s), body: { innerText: page.body || '' } };
  const location = { host: page.host || '', origin: page.origin || '' };
  return !!(new Function('document', 'location', 'return (' + predicate + ')'))(document, location);
}

function fakeIO(page0, clicks = [], tiles = [], clock0 = 10000) {
  let page = page0, clock = clock0;
  const cq = clicks.slice(), tq = tiles.slice();
  const log = { clicks: 0, fills: 0, principals: [] };
  return {
    log, get page() { return page; },
    async inspect() { return page; },
    async waitReady(o) {
      if (o && o.predicate) { if (!evalPredicate(page, o.predicate)) throw Object.assign(new Error('no transition'), {code:'READINESS_TIMEOUT'}); return { ready: true }; }
      for (const s of (o.selectors || [])) if (!qs(page, s)) throw new Error('readiness failed: ' + s);
      return { ready: true };
    },
    async fill() { log.fills++; return { ok: true }; },
    async click() { log.clicks++; const a = cq.length ? cq.shift() : { state: 'clicked' }; if (a.to) page = a.to; return a.state; },
    async clickTile() { log.clicks++; const a = tq.length ? tq.shift() : { state: 'clicked' }; if (a.to) page = a.to; return a.state; },
    async navigate() {}, async verifyPrincipal() { log.principals.push('observed'); return {state:'valid',principal:{id:'synthetic'}}; },
    beforeSubmit: async () => true, now() { return clock; }, async sleep(ms) { clock += (ms || 1); }, totp() { return '123456'; },
  };
}

(async () => {
  // --- runPrep: email stages (unchanged semantics) ---
  let io = fakeIO(EMAIL, [{ state: 'clicked' }]);
  let r = await runPrep(io, CTX);
  check('email unchanged -> email_no_transition', r.status, 'email_no_transition');
  check('email ONE Next click', io.log.clicks, 1);

  io = fakeIO(EMAIL_RETRY, Array.from({ length: 8 }, () => ({ state: 'clicked' })));
  r = await runPrep(io, CTX);
  check('email recoverable-forever -> email_stuck', r.status, 'email_stuck');
  check('email bounded retries (<=8)', io.log.clicks <= 8, true);

  io = fakeIO(EMAIL, [{ state: 'clicked', to: PW }]);
  r = await runPrep(io, CTX);
  check('email->password -> ready_to_submit', r.status, 'ready_to_submit');

  // runPrep password stage on a FOREIGN origin -> untrusted_idp_origin, NO password fill
  io = fakeIO(EMAIL, [{ state: 'clicked', to: PW_FOREIGN }]);
  r = await runPrep(io, CTX);
  check('prep foreign password origin -> untrusted_idp_origin', r.status, 'untrusted_idp_origin');
  check('prep foreign: password NOT filled (only the trusted email loginfmt)', io.log.fills, 1);

  // --- runFinish ---
  io = fakeIO(PW, [{ state: 'clicked' }]);                  // stays on password (persist)
  r = await runFinish(io, CTX);
  check('finish no-transition -> password_uncertain', r.status, 'password_uncertain');
  check('finish one submit, no resubmit', io.log.clicks, 1);
  check('finish no principal assertion', io.log.principals.length, 0);

  io = fakeIO(PW, [{ state: 'uncertain' }]);
  r = await runFinish(io, CTX);
  check('finish submit ack-lost -> submit_uncertain', r.status, 'submit_uncertain');

  io = fakeIO(PW, [{ state: 'clicked', to: KMSI }, { state: 'clicked', to: APP }]);
  r = await runFinish(io, CTX);
  check('finish password->KMSI->app -> verified', r.status, 'verified');
  check('finish principal observed', io.log.principals, ['observed']);

  // disconnected target mid-flow -> bail immediately (NOT a 150s loop), stays visible
  const DISC = { host: '', origin: '', ready: 'disconnected', inputs: [], btns: [], body: '' };
  io = fakeIO(PW, [{ state: 'clicked', to: DISC }]);
  r = await runFinish(io, CTX);
  check('finish disconnected target -> target_disconnected', r.status, 'target_disconnected');
  check('finish disconnected: no principal assertion', io.log.principals.length, 0);

  io = fakeIO(PW, [{ state: 'clicked', to: PWERR }]);
  r = await runFinish(io, CTX);
  check('finish rejected -> password_rejected', r.status, 'password_rejected');

  // stuck KMSI: click No once, then keep-poll to deadline -> password_uncertain (not 24x)
  io = fakeIO(PW, [{ state: 'clicked', to: KMSI }, { state: 'clicked' }]);
  r = await runFinish(io, CTX);
  check('finish stuck KMSI -> password_uncertain', r.status, 'password_uncertain');
  check('finish KMSI clicked once (<=3)', io.log.clicks <= 3, true);

  // TOTP code submit ack-lost -> stop
  io = fakeIO(PW, [{ state: 'clicked', to: TOTP }, { state: 'uncertain' }]);
  r = await runFinish(io, CTX);
  check('finish totp ack-lost -> code_submit_uncertain', r.status, 'code_submit_uncertain');

  // SECURITY: password submitted on trusted IdP, then a FOREIGN totp page -> refuse, do not fill the code
  io = fakeIO(PW, [{ state: 'clicked', to: TOTP_FOREIGN }]);
  r = await runFinish(io, CTX);
  check('finish foreign TOTP origin -> untrusted_idp_origin', r.status, 'untrusted_idp_origin');
  check('finish foreign TOTP: only the password was filled (no code fill)', io.log.fills, 1);

  // SECURITY: an http:// page on the app host is NOT the trusted app origin -> not verified
  io = fakeIO(PW, [{ state: 'clicked', to: APP_HTTP }]);
  r = await runFinish(io, CTX);
  check('finish http app-host -> NOT verified', r.status !== 'verified', true);
  check('finish http app-host: no principal assertion', io.log.principals.length, 0);

  // DEADLINE: TOTP window-sleep must be capped and no MFA fill/click past the deadline.
  // clock near a 30s boundary (left<6) + tiny remaining budget => totp_deadline, no code fill.
  const CTX_TIGHT = { ...CTX, postSubmitMs: 3000 };
  io = fakeIO(PW, [{ state: 'clicked', to: TOTP }], [], 25000);   // 25s -> left=5 (<6); deadline=28000
  r = await runFinish(io, CTX_TIGHT);
  check('finish TOTP deadline-cross -> totp_deadline', r.status, 'totp_deadline');
  check('finish TOTP deadline: NO code fill (only password)', io.log.fills, 1);

  // --- adapter tri-state boundary ---
  check('eval true -> clicked', await adaptedClick(async () => true), 'clicked');
  check('eval false -> absent', await adaptedClick(async () => false), 'absent');
  check('eval throws -> uncertain', await adaptedClick(async () => { throw new Error('transport lost'); }), 'uncertain');

  console.log();
  if (fails) { console.log(`FAILURES: ${fails}`); process.exit(1); }
  console.log('ALL REAL-DRIVER FLOW TESTS PASSED');
})();
