'use strict';
// The production click boundary, factored out so the executed-but-ack-lost case
// is actually TESTABLE . Maps a browser eval into the tri-state click
// contract used by entra-flow:
//   eval resolves true  -> 'clicked'  (element existed, enabled, .click() ran)
//   eval resolves false -> 'absent'   (element not present/enabled: no action)
//   eval THROWS         -> 'uncertain'(transport/eval ack lost: may have run)
// 'uncertain' must never be collapsed into 'absent' — a caller may only fall
// back / retry on a confirmed 'absent', never on 'uncertain'.
async function adaptedClick(doEval) {
  try {
    const r = await doEval();
    return r === true ? 'clicked' : 'absent';
  } catch (e) {
    return 'uncertain';
  }
}
module.exports = { adaptedClick };
