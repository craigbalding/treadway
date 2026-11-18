'use strict';
// Explicit provider lifecycle operations. No retry, launch fallback or mutation replay.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {parseEndpoint, connectEndpoint} = require('./remote-transport');
const {makeCdpClient} = require('./cdp');
const {ActorBrowser} = require('./actors');

const {fail, retain, available, budget, attachExact, verifyPagePrincipal} = require('./reconnect-common');

function validatePolicy(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'allowedOrigins') || !Array.isArray(value.allowedOrigins) ||
      value.allowedOrigins.length > 8 || new Set(value.allowedOrigins).size !== value.allowedOrigins.length)
    fail('remote_reconnect_policy_invalid');
  for (const origin of value.allowedOrigins) {
    const {parsed} = parseEndpoint(origin, {fresh: false});
    if (parsed.origin !== origin) fail('remote_reconnect_policy_invalid');
  }
  return {allowedOrigins: [...value.allowedOrigins]};
}

function returnedEndpoint(raw, original, policy, token) {
  if (typeof raw !== 'string' || raw.length > 32768) fail('remote_reconnect_endpoint_invalid');
  const {endpoint, parsed} = parseEndpoint(raw, {fresh: false});
  const initial = parseEndpoint(original, {fresh: false});
  const source = initial.parsed;
  if (parsed.origin !== source.origin && !policy.allowedOrigins.includes(parsed.origin))
    fail('remote_reconnect_authority_refused');
  // Never send a returned credential over a TLS downgrade, even if allowlisted.
  if (source.protocol === 'wss:' && parsed.protocol !== 'wss:') fail('remote_reconnect_tls_downgrade');
  const selected = value => {
    if (value === initial.endpoint) fail('remote_reconnect_launch_endpoint_refused');
    return {endpoint: value, sameOrigin: parsed.origin === source.origin};
  };
  if (token === undefined || token === null) return selected(endpoint);
  if (typeof token !== 'string' || !token || token.length > 8192 || /[\x00-\x20\x7f]/.test(token))
    fail('remote_reconnect_auth_invalid');
  const values = parsed.searchParams.getAll('token');
  if (values.length && (values.length !== 1 || values[0] !== token)) fail('remote_reconnect_auth_conflict');
  const separator = endpoint.includes('?') ? (/[?&]$/.test(endpoint) ? '' : '&') : '?';
  return selected(values.length ? endpoint : endpoint + separator + 'token=' + encodeURIComponent(token));
}

async function prepare(worker, actor, {timeoutMs = 30000, token} = {}) {
  available(actor);
  if (actor.state !== 'ready' || actor.uncertain) fail('remote_reconciliation_required');
  if (actor.reconnectCapability && !actor.reconnectCapability.used) fail('remote_reconnect_already_prepared');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('remote_reconnect_deadline_invalid');
  const ttl = Math.min(timeoutMs, Math.floor(actor.deadline - performance.now()));
  if (ttl < 1) fail('remote_reconnect_deadline');
  actor.state = 'preparing_reconnect';
  const remaining = budget(actor, Math.min(ttl, worker.acquireMs));
  let sessionId, sent = false, replied = false;
  worker.record({kind: 'reconnect_prepare_intent', actor: actor.name, generation: actor.generation});
  try {
    sessionId = await attachExact(worker, actor, remaining);
    sent = true;
    const result = await actor.cdp.send('Browserless.reconnect', {timeout: ttl}, {sessionId, timeoutMs: remaining()});
    replied = true;
    remaining();
    const evidence = retain(worker, 'reconnect-provider', {actor: actor.name, generation: actor.generation, result});
    worker.record({kind: 'reconnect_provider_replied', actor: actor.name, generation: actor.generation, evidence});
    if (!result || result.error || typeof result.browserWSEndpoint !== 'string') fail('remote_reconnect_unavailable');
    if (result.auth && parseEndpoint(result.browserWSEndpoint, {fresh: false}).parsed.searchParams.get('auth') !== result.auth)
      fail('remote_reconnect_auth_contract_unsupported');
    const capability = returnedEndpoint(result.browserWSEndpoint, actor.initialEndpoint, actor.reconnectPolicy, token);
    const reference = crypto.randomUUID();
    const record = {version: 'treadway.browser-reconnect/1', projectId: worker.projectId, runId: worker.runId,
      actor: actor.name, generation: actor.generation, contextId: actor.contextId, targetId: actor.targetId,
      endpoint: capability.endpoint};
    const fd = fs.openSync(path.join(worker.root, 'reconnect-' + reference + '.json'), 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    actor.reconnectCapability = {...capability, reference, used: false,
      deadline: Math.min(actor.deadline, performance.now() + ttl)};
    worker.record({kind: 'reconnect_prepared', actor: actor.name, generation: actor.generation, reference});
    return {prepared: true, reference, generation: actor.generation, remainingMs: Math.max(0, Math.floor(actor.reconnectCapability.deadline - performance.now()))};
  } catch (error) {
    if (error.code === 'CDP_PROTOCOL_ERROR' && error.protocolCode === -32601) {
      replied = true;
      error = Object.assign(new Error('remote_reconnect_unavailable'), {code: 'remote_reconnect_unavailable'});
    }
    if (sent && !replied) actor.uncertain = true;
    worker.record({kind: 'reconnect_prepare_incomplete', actor: actor.name, generation: actor.generation, dispatchUnknown: sent && !replied});
    throw error;
  } finally {
    if (sessionId) await worker.detachPage(actor, sessionId);
    if (actor.state === 'preparing_reconnect') actor.state = 'ready';
  }
}

async function reconnect(worker, actor, {timeoutMs = 10000, principal} = {}) {
  // Closing a lost operation does not cancel its accepted browser command. An
  // explicit reconnect may retire that transport, retaining every unknown fact.
  available(actor, {allowUnknownPending: true});
  if (!['ready', 'transport_lost'].includes(actor.state)) fail('remote_session_unavailable');
  // Existing principal mechanics validate the application binding before network I/O.
  try { new ActorBrowser(null, {...principal, name: actor.name, generation: actor.generation}); }
  catch { fail('remote_reconnect_principal_binding_required'); }
  const capability = actor.reconnectCapability;
  if (!capability || capability.used || performance.now() >= Math.min(actor.deadline, capability.deadline))
    fail('remote_reconnect_capability_unavailable');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('remote_reconnect_deadline_invalid');
  actor.state = 'reconnecting';
  const remaining = budget(actor, timeoutMs, capability.deadline);
  capability.used = true;
  worker.record({kind: 'reconnect_intent', actor: actor.name, generation: actor.generation, reference: capability.reference});
  let sessionId, opened = false;
  try {
    actor.scopeConfirmed = false;
    const old = actor.ws;
    actor.intentionalClose = old;
    if (old.readyState !== old.CLOSED) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('remote_reconnect_disconnect_incomplete'),
          {code: 'remote_reconnect_disconnect_incomplete'})), Math.min(worker.cleanupMs, remaining()));
        old.once('close', () => { clearTimeout(timer); resolve(); });
        old.close();
      });
    }
    delete actor.intentionalClose;
    actor.attachments.clear();
    const ws = await connectEndpoint(capability.endpoint, {...actor.transportOptions,
      headers: capability.sameOrigin ? actor.transportOptions.headers : {}, fresh: false,
      signal: actor.abort.signal, timeoutMs: remaining()});
    if (actor.state !== 'reconnecting') { ws.terminate(); fail('remote_reconnect_cancelled'); }
    actor.ws = ws; actor.cdp = makeCdpClient(ws, {nextCommandId: actor.nextCommandId}); opened = true;
    worker.watchTransport(actor, ws);
    sessionId = await attachExact(worker, actor, remaining);
    const evidence = await verifyPagePrincipal(worker, actor, sessionId, remaining, principal);
    if (actor.state !== 'reconnecting') fail('remote_reconnect_cancelled');
    worker.record({kind: 'reconnect_ready', actor: actor.name, generation: actor.generation, reference: capability.reference, evidence});
    actor.state = 'ready';
    return {reconnected: true, generation: actor.generation, principalVerified: true, reconciliationRequired: actor.uncertain};
  } catch (error) {
    worker.record({kind: 'reconnect_incomplete', actor: actor.name, generation: actor.generation, reference: capability.reference});
    if (actor.state === 'reconnecting') actor.state = opened && actor.scopeConfirmed ? 'revalidation_failed' : 'transport_lost';
    throw error;
  } finally {
    if (sessionId) await worker.detachPage(actor, sessionId);
    if (!actor.scopeConfirmed) { actor.cdp?.close(); actor.ws?.terminate(); }
  }
}

module.exports = {validatePolicy, returnedEndpoint, prepare, reconnect};
