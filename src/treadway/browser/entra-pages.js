'use strict';
// Pure Entra screen classifier for the returning-user recipe. No browser here:
// it maps an inspect snapshot {host,path,inputs,links,body} to a stage so the
// recipe decides the next single action. Kept pure so it is unit-testable.
//
// Design points :
//  - A password field still present AFTER a submit, with no recognised error,
//    is 'password_persist' => uncertain. The recipe must NOT resubmit; it
//    returns control. (item 2)
//  - 'password_change' and 'mfa_register' are UNEXPECTED for a returning user
//    (already done once) => stop, never re-enrol / re-rotate. (impl expectations)
//  - RETURN_HOST alone is 'app_host' NOT proven login; identity is verified
//    separately by the wrapper via the session probe. (item 4)

function has(inputs, pred) { return (inputs || []).some(pred); }

function classifyStage(snap, { returnHost = null, appOrigin = null, afterPasswordSubmit = false } = {}) {
  const s = snap || {};
  const body = (s.body || '');
  const inputs = s.inputs || [];
  const hasPasswd = has(inputs, x => x.type === 'password' || x.name === 'passwd');
  const hasLogin = has(inputs, x => x.name === 'loginfmt');
  const hasCode = has(inputs, x => x.type === 'text' || x.type === 'tel' || /numeric/.test(x.im || '') ||
                                   /otc|code/i.test(x.id || '') || /otc|code/i.test(x.name || ''));
  const B = re => re.test(body);

  // Application text is not an IdP screen. Establish the configured application
  // context first; its read-only principal probe decides authentication.
  const app = typeof appOrigin === 'string' && appOrigin.startsWith('https://') && s.origin === appOrigin;
  if (app && !/\/sign-in|\/login/i.test(s.path || '')) return 'app_host';

  if (B(/locked|too many|try again later|temporarily/i)) return 'locked';
  // Unexpected returning-user controls: already completed once. Never repeat.
  if (hasPasswd && B(/update your password|your password has expired|enter new password|current password/i))
    return 'password_change';
  if (hasPasswd && B(/your account or password is incorrect|didn.?t work|password is incorrect|incorrect password/i)) return 'password_error';
  if (hasCode && B(/code is incorrect|verification code is incorrect|that code didn.?t work|code.*expired/i)) return 'code_error';
  if (hasCode && !hasPasswd && !hasLogin && B(/enter.*code|verification code|one-time|enter the code/i)) return 'totp';
  const links = (s.links || []).map(x => typeof x === 'string' ? x : x.txt || '');
  if (B(/secret key:/i)) return 'registration_secret';
  if (links.some(x => /(?:use|set up) a different (?:authentication|authenticator) app/i.test(x)))
    return 'registration_other_app';
  if (links.some(x => /can.?t scan (?:the )?(?:qr|bar)/i.test(x))) return 'registration_manual';
  if (B(/authenticator app added|you.re all set|successfully registered|registration complete/i))
    return 'registration_complete';
  if ((s.links || []).some(x => x.id === 'idSubmit_ProofUp_Redirect') || B(/more information required/i)) return 'registration_redirect';
  if (B(/install microsoft authenticator/i)) return 'registration_install';
  if (B(/start by adding your account|set up your account in app/i)) return 'registration_add_account';
  if (B(/scan the qr code/i)) return 'registration_qr';
  if (B(/keep your account secure/i)) return 'registration_intro';

  // Recognised credential errors
  if (hasPasswd && B(/your account or password is incorrect|didn.?t work|password is incorrect|incorrect password/i))
    return 'password_error';
  if (hasCode && B(/code (is|didn.?t|is incorrect)|verification code is incorrect|that code didn.?t work|expired/i))
    return 'code_error';

  // host===returnHost is NOT proof of the authenticated app: the /sign-in shell
  // is served on the app host before the redirect to Entra. Exclude sign-in paths
  // (and a visible sign-in/redirect shell) so prep keeps waiting for the Entra form.
  // App success requires the exact configured FULL app origin (reject host-only/foreign/
  // HTTP). A host label alone is insufficient.
  if (hasLogin) return 'email';
  if (B(/pick an account/i)) return 'picker';
  if (B(/stay signed in/i)) return 'kmsi';
  if (hasCode && B(/enter.*code|verification code|authenticator app|one-time|verify your identity|enter the code/i))
    return 'totp';
  if (hasPasswd) {
    // Still on the password screen. After we already submitted once with no
    // recognised error, this is an uncertain outcome - do not resubmit.
    return afterPasswordSubmit ? 'password_persist' : 'password';
  }
  return 'unknown';
}

// Stages that are an uncertain/failed attempt outcome the recipe must surface
// (never auto-retry a credential or MFA submission).
const STOP_STAGES = new Set([
  'password_error', 'code_error', 'locked',
  'password_change', 'password_persist',
]);

module.exports = { classifyStage, STOP_STAGES };
