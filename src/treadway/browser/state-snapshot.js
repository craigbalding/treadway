'use strict';
// Scoped state is credential material. These functions return private data only.
const crypto = require('node:crypto');
const {ActorBrowser} = require('./actors');
const {appliesToHost, validateCookies} = require('./cookies');
const MAX_BYTES = 8 * 1024 * 1024;
const COMPONENTS = new Set(['cookies', 'localStorage', 'sessionStorage']);
const LIMITS = ['Selected application cookies and Web Storage only; not a browser profile',
  'Session storage belongs to this page, not all tabs', 'Cookies have domain/path scope, not port isolation',
  'IndexedDB, service workers, HTTP cache and filesystem state are not captured'];
function fail(code) { throw new Error(code); }
function canonical(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && u.origin === value; }
  catch { return false; }
}
function validateBinding(binding) {
  if (!binding || !['projectId', 'application', 'identityRef', 'providerBinding'].every(key =>
    typeof binding[key] === 'string' && binding[key].length > 0 && binding[key].length <= 1024) ||
    !Array.isArray(binding.origins) || !binding.origins.length || binding.origins.length > 8 ||
    !binding.origins.every(canonical) || new Set(binding.origins).size !== binding.origins.length ||
    !Array.isArray(binding.components) || !binding.components.length ||
    !binding.components.every(c => COMPONENTS.has(c)) || new Set(binding.components).size !== binding.components.length)
    fail('browser_state_binding_required');
  if (binding.origins.length !== 1 && binding.components.some(c => c !== 'cookies')) fail('multi_origin_web_storage_unsupported');
  return binding;
}
function sameBinding(a, b) {
  return ['projectId', 'application', 'identityRef', 'providerBinding'].every(k => a[k] === b[k]) &&
    ['origins', 'components'].every(k => JSON.stringify([...a[k]].sort()) === JSON.stringify([...b[k]].sort()));
}
function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 20000 || entries.some(e => !Array.isArray(e) || e.length !== 2 ||
    !e.every(v => typeof v === 'string')) || new Set(entries.map(e => e[0])).size !== entries.length)
    fail('browser_web_storage_incomplete');
}
function validateSnapshot(snapshot, binding) {
  validateBinding(binding);
  if (!snapshot || snapshot.version !== 'treadway.browser-state/1' || snapshot.complete !== true ||
    typeof snapshot.sourceGeneration !== 'string' || !snapshot.sourceGeneration || snapshot.sourceGeneration.length > 100)
    fail('browser_state_snapshot_incomplete');
  validateBinding(snapshot.binding);
  if (!sameBinding(snapshot.binding, binding)) fail('browser_state_snapshot_binding_differs');
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BYTES) fail('bounded_browser_state_required');
  if (binding.components.includes('cookies')) {
    validateCookies(snapshot.cookies);
    for (const cookie of snapshot.cookies) {
      if (!binding.origins.some(origin => appliesToHost(cookie, new URL(origin).hostname)) || cookie.partitionKeyOpaque)
        fail('browser_state_cookie_scope_unsupported');
      if (!cookie.path.startsWith('/') ||
        cookie.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(cookie.sameSite) ||
        cookie.priority !== undefined && !['Low', 'Medium', 'High'].includes(cookie.priority) ||
        cookie.sourceScheme !== undefined && !['Unset', 'NonSecure', 'Secure'].includes(cookie.sourceScheme) ||
        cookie.sourcePort !== undefined && (!Number.isInteger(cookie.sourcePort) || cookie.sourcePort < -1 || cookie.sourcePort > 65535))
        fail('browser_state_cookie_parameters_unsupported');
      if (cookie.partitionKey !== undefined && (!cookie.partitionKey ||
        !canonical(cookie.partitionKey.topLevelSite) || typeof cookie.partitionKey.hasCrossSiteAncestor !== 'boolean'))
        fail('browser_state_cookie_partition_unsupported');
    }
  }
  for (const origin of binding.origins) for (const component of binding.components.filter(c => c !== 'cookies'))
    validateEntries(snapshot.storage?.[origin]?.[component]);
  return snapshot;
}
function budget(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail('bounded_browser_state_deadline_required');
  const deadline = performance.now() + timeoutMs;
  return () => { const left = Math.ceil(deadline - performance.now()); if (left <= 0) fail('browser_state_deadline'); return left; };
}
function optionsFor(input) {
  validateBinding(input.binding);
  if (!input.principal || !input.binding.origins.includes(input.principal.origin) ||
    Object.keys(input.principal).some(key => !['origin', 'probe', 'expected', 'maxBodyBytes'].includes(key)) ||
    typeof input.actor !== 'string' || !input.actor || typeof input.generation !== 'string' || !input.generation)
    fail('browser_state_principal_binding_required');
  // Validate the application's probe and expectations before any CDP traffic.
    new ActorBrowser(null, {...input.principal, name: input.actor, generation: input.generation});
  return input;
}
async function principal(session, input, remaining) {
  const actor = new ActorBrowser(session, {...input.principal, name: input.actor, generation: input.generation});
  const result = await actor.request(input.principal.probe, {verify: false, timeoutMs: Math.max(1, remaining() - 1000)});
  if (!result.complete || result.status !== 200 || !Object.entries(input.principal.expected).every(([key, expected]) => {
    let value = result.body; for (const part of key.split('.')) value = value?.[part]; return value === expected;
  })) throw Object.assign(new Error('browser_state_actual_principal_differs'), {observation: result});
  return {status: result.status, observed: result.body};
}
async function value(session, expression, remaining) {
  const response = await session.cdp.send('Runtime.evaluate', {expression, returnByValue: true}, {timeoutMs: remaining()});
  if (response.exceptionDetails || !Object.hasOwn(response.result || {}, 'value')) fail('browser_state_observation_incomplete');
  return response.result.value;
}
async function captureState(session, input) {
  optionsFor(input);
  const remaining = budget(input.timeoutMs ?? 10000);
  const before = await value(session, '({origin:location.origin,timeOrigin:performance.timeOrigin})', remaining);
  if (before.origin !== input.principal.origin) fail('browser_state_origin_differs');
  const verified = await principal(session, input, remaining);
  const snapshot = {version: 'treadway.browser-state/1', complete: true, binding: input.binding,
    sourceGeneration: input.generation, observedAt: new Date().toISOString(), principal: verified,
    cookies: [], storage: {}, limits: [...LIMITS]};
  if (input.binding.components.includes('cookies')) {
    const result = await session.cdp.send('Storage.getCookies', session.target?.browserContextId ?
      {browserContextId: session.target.browserContextId} : {}, {timeoutMs: remaining()});
    validateCookies(result.cookies);
    snapshot.cookies = result.cookies.filter(cookie => input.binding.origins.some(origin => appliesToHost(cookie, new URL(origin).hostname)));
  }
  for (const origin of input.binding.origins) {
    snapshot.storage[origin] = {};
    for (const component of input.binding.components.filter(c => c !== 'cookies')) {
      const result = await session.cdp.send('DOMStorage.getDOMStorageItems',
        {storageId: {securityOrigin: origin, isLocalStorage: component === 'localStorage'}}, {timeoutMs: remaining()});
      validateEntries(result.entries); snapshot.storage[origin][component] = result.entries;
    }
  }
  const after = await value(session, '({origin:location.origin,timeOrigin:performance.timeOrigin})', remaining);
  if (before.origin !== after.origin || before.timeOrigin !== after.timeOrigin) fail('browser_state_document_changed');
  await principal(session, input, remaining);
  return validateSnapshot(snapshot, input.binding);
}
function cookieParameters(cookie) {
  const result = {};
  for (const key of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey'])
    if (Object.hasOwn(cookie, key)) result[key] = cookie[key];
  if (!cookie.session) result.expires = cookie.expires;
  return result;
}
function restoreWebStorage(storage, marker) {
  try {
    const state = storage[location.origin];
    if (!state) return;
    for (const component of Object.keys(state)) if (globalThis[component].length !== 0) throw new Error('not_empty');
    for (const [component, entries] of Object.entries(state)) for (const [key, value] of entries) globalThis[component].setItem(key, value);
    globalThis[marker] = true;
  } catch { globalThis[marker] = false; }
}
async function restoreState(session, snapshot, input) {
  optionsFor(input); validateSnapshot(snapshot, input.binding);
  const landing = new URL(input.landingUrl);
  if (landing.origin !== input.principal.origin || landing.username || landing.password) fail('browser_state_landing_origin_differs');
  const remaining = budget(input.timeoutMs ?? 10000);
  const href = await value(session, 'location.href', remaining);
  if (href !== 'about:blank' && href !== 'data:text/html,treadway-' + input.generation) fail('browser_state_fresh_target_required');
  const existing = await session.cdp.send('Storage.getCookies', session.target?.browserContextId ?
    {browserContextId: session.target.browserContextId} : {}, {timeoutMs: remaining()});
  if (!Array.isArray(existing.cookies) || existing.cookies.length) fail('browser_state_fresh_context_required');
  let script;
  let firstError;
  const marker = '__treadwayState_' + crypto.randomBytes(12).toString('hex');
  try {
    if (input.binding.components.includes('cookies')) await session.cdp.send('Storage.setCookies', {
      cookies: snapshot.cookies.map(cookieParameters), ...(session.target?.browserContextId ? {browserContextId: session.target.browserContextId} : {})},
      {timeoutMs: remaining()});
    if (input.binding.components.some(c => c !== 'cookies')) {
      script = (await session.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(${restoreWebStorage.toString()})(${JSON.stringify(snapshot.storage)},${JSON.stringify(marker)})`}, {timeoutMs: remaining()})).identifier;
      if (typeof script !== 'string' || !script) fail('browser_state_script_incomplete');
    }
    await session.navigate(input.landingUrl, {timeoutMs: remaining()});
    if (script && await value(session, `globalThis[${JSON.stringify(marker)}]`, remaining) !== true) fail('browser_web_storage_restore_incomplete');
    const verified = await principal(session, input, remaining);
    return {restored: true, components: input.binding.components, sourceGeneration: snapshot.sourceGeneration,
      generation: input.generation, principal: verified, limits: [...LIMITS]};
  } catch (error) { firstError = error; throw error; }
  finally {
    if (script) {
      try { await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: script}, {timeoutMs: 1000}); }
      catch { if (firstError) firstError.stateCleanupIncomplete = true; else fail('browser_state_script_cleanup_incomplete'); }
    }
  }
}
module.exports = {captureState, restoreState, validateSnapshot, validateBinding, verifyPrincipal: principal};

if (require.main === module) (async () => {
  const fs = require('node:fs'); const {connectSession} = require('./connection'); let session;
  try {
    const raw = fs.readFileSync(0); if (raw.length > MAX_BYTES + 65536) fail('bounded_browser_state_required');
    const input = JSON.parse(raw); optionsFor(input);
    if (!['capture', 'restore'].includes(input.operation)) fail('browser_state_operation_required');
    if (input.operation === 'restore') validateSnapshot(input.snapshot, input.binding);
    session = await connectSession(input.connection, {commandTimeoutMs: input.timeoutMs ?? 10000});
    const result = input.operation === 'capture' ? await captureState(session, input) : await restoreState(session, input.snapshot, input);
    process.stdout.write(JSON.stringify({complete: true, result}));
  } catch (error) {
    const code = /^(?:browser_|multi_origin_)[a-z_]+$/.test(error.message) ? error.message : 'browser_state_operation_incomplete';
    process.stdout.write(JSON.stringify({complete: false, code, ...(error.stateCleanupIncomplete ? {cleanupIncomplete: true} : {})})); process.exitCode = 1;
  } finally { session?.close(); }
})();
