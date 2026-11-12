'use strict';
// Entra returning-user flow logic over an abstract `io`, so the REAL driver logic
// is unit-testable with only the browser boundary replaced .
//
// io contract:
//   inspect() -> {host,path,ready,inputs,body}
//   waitReady({selectors|predicate,timeoutMs}) -> resolves, or THROWS on timeout
//   fill(sel,val) -> throws unless the value is set (verified replace)
//   click(sel) -> 'clicked' | 'absent' | 'uncertain'   (tri-state receipt)
//       'clicked'   = the element existed, was enabled, and .click() ran
//       'absent'    = the element was not present/enabled (confirmed no action)
//       'uncertain' = the attempt's acknowledgement was lost (may have executed)
//   clickTile(email) -> same tri-state
//   navigate(url); getCookie(name)->value|null; writeToken(value);
//   now()->ms; sleep(ms); totp()->code
//
// Transition waits use STAGE-SPECIFIC predicates (no baked-in !passwd tautology):
// each wait observes the actual expected next condition, and a timeout STOPS the
// action rather than letting the loop resubmit without observed progression.
const { classifyStage, STOP_STAGES } = require('./entra-pages.js');
const SUBMIT = '#idSIButton9';

// Trusted-origin gate: credential/MFA actions run ONLY on an exact configured HTTPS IdP
// origin (reject missing/foreign/HTTP). Never trust an arbitrary redirect origin.
function requireIdp(snap, ctx) {
  const o = snap && snap.origin;
  if (typeof o !== 'string' || !o.startsWith('https://')) return false;
  const trusted = ctx.idpOrigins || (ctx.idpOrigin ? [ctx.idpOrigin] : []);
  return trusted.includes(o);
}

class EntraStop extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Re-observe after every await. Browser adapters must also check this binding
// inside the operation that consumes it; a previous screen check is insufficient.
async function current(io, ctx, stage, deadline, afterPasswordSubmit = false) {
  const snap = await io.inspect();
  if (io.now() >= deadline) throw new EntraStop('transition_deadline');
  if (snap.ready === 'disconnected') throw new EntraStop('target_disconnected');
  if (snap.ready !== 'complete') throw new EntraStop('screen_changed');
  if (!requireIdp(snap, ctx)) throw new EntraStop('untrusted_idp_origin');
  if (classifyStage(snap, { ...ctx, afterPasswordSubmit }) !== stage) throw new EntraStop('screen_changed');
  io.bind?.(snap, { stage, deadline, afterPasswordSubmit });
  return snap;
}

async function ready(io, selectors, deadline) {
  const timeoutMs = deadline - io.now();
  if (timeoutMs <= 0) throw new EntraStop('transition_deadline');
  await io.waitReady({ selectors, timeoutMs });
}

async function authorizeSubmission(io, kind) {
  if (typeof io.beforeSubmit !== 'function') throw new EntraStop('submission_guard_required');
  const decision = await io.beforeSubmit(kind);
  if (decision !== true && decision?.allowed !== true) throw new EntraStop('submission_refused');
}

async function waitFor(io, predicate, timeoutMs) {
  if (timeoutMs <= 0) return false;
  try { await io.waitReady({ predicate, timeoutMs }); return true; }
  catch (e) { if (e.code !== 'READINESS_TIMEOUT') throw e; return false; }
}

const BODY = `((document.body&&document.body.innerText)||'')`;
const P = {
  passwordAppeared: `!!document.querySelector('input[name=passwd]')`,
  leftPassword: rh => `location.host===${JSON.stringify(rh)} || !document.querySelector('input[name=passwd]') || /account or password is incorrect|didn.?t work|verify your identity|enter the code|authenticator app|stay signed in|pick an account/i.test(${BODY})`,
  leftTotp: rh => `location.host===${JSON.stringify(rh)} || !document.querySelector('input[type=tel]') || /stay signed in|pick an account|incorrect|didn.?t work/i.test(${BODY})`,
  leftKmsi: rh => `location.host===${JSON.stringify(rh)} || /pick an account/i.test(${BODY})`,
};

async function runPrep(io, ctx) {
  const out = { phase: 'prep', steps: [] };
  const deadline = io.now() + (ctx.prepMs || 90000);
  if (ctx.signinUrl) await io.navigate(ctx.signinUrl);
  while (io.now() < deadline) {
    try {
    let snap = await io.inspect();
    if (snap.ready === 'disconnected') return { ...out, status: 'target_disconnected' };
    if (snap.ready !== 'complete') { await io.sleep(600); continue; }
    const stage = classifyStage(snap, ctx);
    if (STOP_STAGES.has(stage)) return { ...out, status: 'blocked', stage };
    if (stage === 'app_host') return { ...out, status: 'already_app' };
    if (stage === 'totp' || stage === 'kmsi' || stage.startsWith('registration_'))
      return { ...out, status: 'challenge', stage };

    if (stage === 'email') {
      out.steps.push('email');
      await ready(io, ['input[name=loginfmt]'], deadline);
      await current(io, ctx, stage, deadline);
      await io.fill('input[name=loginfmt]', ctx.email);
      let advanced = false;
      for (let k = 0; k < (ctx.lookupAttempts || 1) && !advanced; k++) {
        await ready(io, [SUBMIT], deadline);
        await current(io, ctx, stage, deadline);
        const c = await io.click(SUBMIT);
        if (c === 'uncertain') return { ...out, status: 'email_submit_uncertain' };  // ack lost -> stop
        if (c === 'absent') return { ...out, status: 'email_next_absent' };
        // Observe the SPECIFIC expected transition: the password field appears.
        advanced = await waitFor(io, P.passwordAppeared, Math.min(ctx.transitionMs || 30000, deadline - io.now()));
        if (advanced) break;
        const b = (await io.inspect()).body || '';
        if (/doesn.?t exist|couldn.?t find|can.?t find an account|no account/i.test(b))
          return { ...out, status: 'account_not_found' };
        // Retry Next ONLY on a positively observed, recoverable Entra response.
        if (/issue looking up your account|tap next to try again|please try again/i.test(b)) { await io.sleep(2000); continue; }
        // No observed transition and no recoverable signal -> STOP (no blind resubmit).
        return { ...out, status: 'email_no_transition' };
      }
      if (!advanced) return { ...out, status: 'email_stuck' };
      continue;
    }

    if (stage === 'picker') {
      out.steps.push('picker');
      await current(io, ctx, stage, deadline);
      const c = await io.clickTile(ctx.email);
      if (c === 'uncertain') return { ...out, status: 'picker_uncertain' };
      if (c === 'absent') return { ...out, status: 'picker_no_tile' };
      if (!await waitFor(io, P.passwordAppeared + ` || location.origin===${JSON.stringify(ctx.appOrigin)}`, Math.min(ctx.transitionMs || 30000, deadline - io.now())))
        return { ...out, status: 'picker_no_transition' };          // stop, do not re-click
      continue;
    }

    if (stage === 'password') {
      if (!requireIdp(snap, ctx)) return { ...out, status: 'untrusted_idp_origin', origin: snap && snap.origin };
      await ready(io, ['input[name=passwd]'], deadline);
      await current(io, ctx, stage, deadline);
      await io.fill('input[name=passwd]', ctx.password);
      await ready(io, [SUBMIT], deadline);
      await current(io, ctx, stage, deadline);
      out.steps.push('password_filled');
      return { ...out, status: 'ready_to_submit' };                        // STOP before submit
    }
    await io.sleep(800);
    } catch (e) {
      // A read-only check can observe the next trusted screen while waiting.
      // Reclassify within this same bounded attempt; never resubmit a mutation.
      if (!(e instanceof EntraStop) || e.code !== 'screen_changed') throw e;
      await io.sleep(Math.max(1, Math.min(100, deadline - io.now())));
    }
  }
  return { ...out, status: 'prep_stuck' };
}

async function runFinish(io, ctx) {
  const out = { phase: 'finish', steps: [], enrollment: {candidateStored: false, confirmed: false} };
  const deadline = io.now() + (ctx.postSubmitMs || 150000);
  const registration = { secret: null, confirmed: false, actions: new Set() };
  let snap = await io.inspect();
  const firstStage = classifyStage(snap, ctx);
  if (firstStage === 'password') {
  await current(io, ctx, 'password', deadline);
  await io.fill('input[name=passwd]', ctx.password);                       // recheck equality
  await ready(io, [SUBMIT], deadline);
  await authorizeSubmission(io, 'password');
  await current(io, ctx, 'password', deadline);
  const c = await io.click(SUBMIT);
  if (c === 'uncertain') return { ...out, status: 'submit_uncertain' };    // ack lost -> stop, reservation kept
  if (c === 'absent') return { ...out, status: 'submit_not_present' };
  out.steps.push('password_submitted');
  } else if (!['app_host', 'totp', 'kmsi', 'picker'].includes(firstStage) && !firstStage.startsWith('registration_')) {
    return { ...out, status: 'not_on_password', stage: firstStage };
  }
  // One bounded observation window: handle each definitive stage
  // exactly once, treat transitional 'unknown'/'password_persist' as keep-polling (never a
  // premature bail), and never resubmit a credential/MFA. password_uncertain only if the
  // whole deadline elapses without a definitive landed/rejected outcome.
  let totpSubmitted = false, kmsiDone = false, pickerDone = false;
  while (io.now() < deadline) {
    try {
    snap = await io.inspect();
    if (io.now() >= deadline) throw new EntraStop('transition_deadline');
    if (snap.ready === 'disconnected') return { ...out, status: 'target_disconnected' };
    if (snap.ready !== 'complete') { await io.sleep(700); continue; }
    const st = classifyStage(snap, { returnHost: ctx.returnHost, appOrigin: ctx.appOrigin, afterPasswordSubmit: true });
    if (st === 'app_host') {
      const observation = await io.verifyPrincipal();
      snap = await io.inspect();
      if (io.now() >= deadline) throw new EntraStop('transition_deadline');
      if (snap.ready !== 'complete' || classifyStage(snap, ctx) !== 'app_host') throw new EntraStop('application_context_changed');
      if (observation?.state === 'valid') return { ...out, status: 'verified', principal: observation.principal };
      if (observation?.state === 'missing' || observation?.state === 'invalid') { await io.sleep(Math.min(800, deadline - io.now())); continue; }
      return { ...out, status: 'principal_not_verified', verification: observation?.state || 'unknown' };
    }
    if (st === 'password_error') return { ...out, status: 'password_rejected' };
    if (st === 'code_error') return { ...out, status: 'code_rejected' };
    if (st === 'locked' || st === 'password_change')
      return { ...out, status: 'blocked', stage: st };
    if (st.startsWith('registration_')) {
      if (!io.stageTotp || !io.confirmTotp) return { ...out, status: 'totp_store_required', stage: st };
      if (ctx.hasTotp && !registration.secret) return { ...out, status: 'existing_totp_registration_conflict', stage: st };
      await current(io, ctx, st, deadline, true);
      if (st === 'registration_secret' && !registration.secret) {
        registration.secret = await io.readEnrollmentSecret();
        if (!registration.secret) return { ...out, status: 'enrollment_secret_unavailable' };
        await io.stageTotp(registration.secret);
        out.enrollment.candidateStored = true;
        await current(io, ctx, st, deadline, true);
      }
      if (st === 'registration_complete' && !registration.confirmed) {
        if (!registration.secret) return { ...out, status: 'enrollment_confirmation_unbound' };
        await io.confirmTotp(); registration.confirmed = true;
        out.enrollment.confirmed = true;
        await current(io, ctx, st, deadline, true);
      }
      // The calibrated registration steps are one-shot; a persistent screen is
      // observed until the deadline rather than clicked repeatedly.
      if (registration.actions.has(st)) { await io.sleep(Math.min(800, deadline - io.now())); continue; }
      const patterns = {
        registration_other_app: /(?:use|set up) a different (?:authentication|authenticator) app/i,
        registration_manual: /can.?t scan (?:the )?(?:qr|bar)/i,
        registration_secret: /^next$/i,
        registration_intro: /^next$/i,
        registration_redirect: /^next$/i,
        registration_install: /^next$/i,
        registration_add_account: /^next$/i,
        registration_qr: /^next$/i,
        registration_complete: /^(done|next)$/i,
      };
      registration.actions.add(st);
      let cc = await io.clickText(patterns[st]);
      if (cc === 'absent' && st === 'registration_redirect') {
        await current(io, ctx, st, deadline, true);
        cc = await io.click('#idSubmit_ProofUp_Redirect');
      }
      if (cc !== 'clicked') return { ...out, status: cc === 'uncertain' ? 'registration_action_uncertain' : 'registration_action_absent', stage: st };
      out.steps.push(st);
      continue;
    }
    if (st === 'totp' && !totpSubmitted) {
      if (!requireIdp(snap, ctx)) return { ...out, status: 'untrusted_idp_origin', origin: snap && snap.origin };
      if (io.now() >= deadline) return { ...out, status: 'totp_deadline' };
      await ready(io, ['input[type=tel],input[type=text]'], deadline);
      const left = 30 - (Math.floor(io.now() / 1000) % 30);
      if (left < 6) {
        const remaining = deadline - io.now();
        if (remaining <= 0) return { ...out, status: 'totp_deadline' };
        await io.sleep(Math.min((left + 1) * 1000, remaining));           // cap MFA-window wait to remaining budget
      }
      if (io.now() >= deadline) return { ...out, status: 'totp_deadline' };   // no MFA fill/submit past deadline
      // RE-CHECK stage/origin/disconnect after the waits, immediately before the code fill.
      snap = await current(io, ctx, 'totp', deadline, true);
      const input = snap.inputs.find(x => x.type === 'tel' || /otc|code/i.test(x.id || '') || x.im === 'numeric');
      if (!input) return { ...out, status: 'totp_input_ambiguous' };
      const sel = input.id ? '[id=' + JSON.stringify(input.id) + ']' : 'input[type=tel]';
      const code = await io.totp(registration.secret);
      if (!code) return { ...out, status: 'totp_credential_required' };
      await current(io, ctx, 'totp', deadline, true);
      await io.fill(sel, code); totpSubmitted = true; out.steps.push('totp_filled');
      await authorizeSubmission(io, 'totp');
      await current(io, ctx, 'totp', deadline, true);
      let cc = await io.click('#idSubmit_SAOTCC_Continue');
      if (cc === 'uncertain') return { ...out, status: 'code_submit_uncertain' };
      if (cc === 'absent') { await current(io, ctx, 'totp', deadline, true); cc = await io.click(SUBMIT); if (cc === 'uncertain') return { ...out, status: 'code_submit_uncertain' }; }
      if (cc === 'absent') return { ...out, status: 'code_submit_absent' };
      out.steps.push('totp_submitted');
      await io.sleep(1500); continue;                                      // keep polling for the transition
    }
    if (st === 'kmsi' && !kmsiDone) {
      await current(io, ctx, st, deadline, true);
      out.steps.push('kmsi_no'); kmsiDone = true;
      let cc = await io.click('#idBtn_Back');
      if (cc === 'uncertain') return { ...out, status: 'kmsi_uncertain' };
      if (cc === 'absent') return { ...out, status: 'kmsi_no_absent' };
      await io.sleep(1500); continue;
    }
    if (st === 'picker' && !pickerDone) {
      await current(io, ctx, st, deadline, true);
      out.steps.push('picker'); pickerDone = true;
      const cc = await io.clickTile(ctx.email);
      if (cc === 'uncertain') return { ...out, status: 'picker_uncertain' };
      if (cc === 'absent') return { ...out, status: 'picker_no_tile' };
      await io.sleep(1500); continue;
    }
    // transitional 'unknown'/'password_persist'/already-handled stage -> keep polling
    await io.sleep(1000);
    } catch (e) {
      if (!(e instanceof EntraStop) || e.code !== 'screen_changed') throw e;
      await io.sleep(Math.max(1, Math.min(100, deadline - io.now())));
    }
  }
  snap = await io.inspect();
  const fst = classifyStage(snap, { returnHost: ctx.returnHost, appOrigin: ctx.appOrigin, afterPasswordSubmit: true });
  return { ...out, status: fst === 'password_error' ? 'password_rejected' : 'password_uncertain', stage: fst };
}

module.exports = { runPrep, runFinish, waitFor, P, SUBMIT, current, ready, EntraStop };
