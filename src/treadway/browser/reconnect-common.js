'use strict';
// Shared exact-page reconnect guards and private evidence; providers own routing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {verifyPrincipal} = require('./state-snapshot');
function fail(code) { throw Object.assign(new Error(code), {code}); }
function retain(worker, prefix, value) {
  const reference = prefix + '-' + crypto.randomUUID() + '.json';
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > 1024 * 1024) fail('remote_reconnect_evidence_limit');
  const fd = fs.openSync(path.join(worker.root, reference), 'wx', 0o600);
  try { fs.writeSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return {reference, sha256: crypto.createHash('sha256').update(raw).digest('hex')};
}
function available(actor, {allowUnknownPending = false} = {}) {
  if (!actor.reconnectPolicy || actor.mode !== 'fresh') fail('remote_reconnect_not_enabled');
  if (actor.client || actor.driveLease || actor.pending.size && !(allowUnknownPending && actor.uncertain)) fail('remote_actor_busy');
}
function budget(actor, timeoutMs, capabilityDeadline = Infinity) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('remote_reconnect_deadline_invalid');
  const deadline = Math.min(performance.now() + timeoutMs, actor.deadline, capabilityDeadline);
  return () => {
    if (!['preparing_reconnect', 'reconnecting'].includes(actor.state)) fail('remote_reconnect_cancelled');
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) fail('remote_reconnect_deadline');
    return remaining;
  };
}
async function attachExact(worker, actor, remaining) {
  const {targetInfo} = await actor.cdp.send('Target.getTargetInfo', {targetId: actor.targetId}, {timeoutMs: remaining()});
  if (targetInfo?.targetId !== actor.targetId || targetInfo.type !== 'page' || targetInfo.browserContextId !== actor.contextId)
    fail('remote_target_context_differs');
  actor.scopeConfirmed = true;
  const {sessionId} = await actor.cdp.send('Target.attachToTarget', {targetId: actor.targetId, flatten: true}, {timeoutMs: remaining()});
  if (typeof sessionId !== 'string' || !sessionId) fail('remote_page_attachment_incomplete');
  actor.attachments.set(sessionId, null);
  return sessionId;
}


async function verifyPagePrincipal(worker, actor, sessionId, remaining, principal) {
    const page = actor.cdp.session(sessionId);
    const session = {cdp: {send: (method, params, options = {}) => page.send(method, params,
      {...options, timeoutMs: Math.min(options.timeoutMs || remaining(), remaining())})}};
    let observation;
    try { observation = await verifyPrincipal(session, {actor: actor.name, generation: actor.generation, principal}, remaining); }
    catch (error) {
      const evidence = retain(worker, 'reconnect-observation', {actor: actor.name, generation: actor.generation,
        principalBinding: principal, complete: false, ...(error.observation ? {observation: error.observation} : {})});
      worker.record({kind: 'reconnect_principal_incomplete', actor: actor.name, generation: actor.generation, evidence});
      fail(error.message === 'browser_state_actual_principal_differs' ? 'remote_reconnect_actual_principal_differs' : 'remote_reconnect_principal_incomplete');
    }
    const evidence = retain(worker, 'reconnect-observation', {actor: actor.name, generation: actor.generation,
      principalBinding: principal, complete: true, observation});
    return evidence;
}
module.exports = {fail, retain, available, budget, attachExact, verifyPagePrincipal};
