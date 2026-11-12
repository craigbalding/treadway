'use strict';
// Pure, unit-testable adapter-error classifiers for the entra recipe io boundary.
// navigateErrorIsTolerable: tolerate ONLY the in-flight redirect load-event deadline
// ("CDP event Page.loadEventFired deadline; ...") - published CDP command timeouts use
// error.code==='CDP_COMMAND_TIMEOUT' with different text and MUST propagate, as must any
// other error. inspectErrorIsDisconnect: a dead/detached/closed CDP socket must stay
// VISIBLE (not be hidden as transient 'loading' for the whole deadline); a transient
// eval failure during navigation (e.g. execution context destroyed) is tolerable 'loading'.
function navigateErrorIsTolerable(e) {
  if (e && e.code === 'CDP_COMMAND_TIMEOUT') return false;          // a Page.navigate command timeout propagates
  return /CDP event Page\.loadEventFired deadline/i.test(String(e && e.message || e));
}
function inspectErrorIsDisconnect(e) {
  const m = String(e && e.message || e);
  return /socket is closed|socket closed|socket failed|client closed|session detached|command not sent/i.test(m);
}
module.exports = { navigateErrorIsTolerable, inspectErrorIsDisconnect };
