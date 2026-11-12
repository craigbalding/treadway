'use strict';
// A private browser snapshot, not a principal assertion or a flattened Cookie header.
// Storage.getCookies includes HttpOnly cookies and cookies at every application path.
const LIMITS = ['Cookies have domain/path scope, not port isolation',
  'Other live documents may change cookies after observation',
  'Local storage, session storage and identity-provider cookies are not exported',
  'Partitioned cookies are retained but unsupported by the HTTP replay bridge'];

function appliesToHost(cookie, hostname) {
  if (typeof cookie?.domain !== 'string') return false;
  const domain = cookie.domain.toLowerCase();
  return domain === hostname || domain === '.' + hostname ||
    (domain.startsWith('.') && hostname.endsWith(domain));
}

async function captureCookies(session, {origin, actor, generation, timeoutMs = 5000} = {}) {
  const url = new URL(origin);
  if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol) ||
      typeof actor !== 'string' || !actor || typeof generation !== 'string' || !generation ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)
    throw new Error('explicit_cookie_snapshot_binding_required');
  const deadline = Date.now() + timeoutMs;
  const send = (method, params) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('cookie_snapshot_deadline');
    return session.cdp.send(method, params, {timeoutMs: remaining});
  };
  const observe = async () => {
    const response = await send('Runtime.evaluate', {expression: '({origin:location.origin,timeOrigin:performance.timeOrigin})', returnByValue: true});
    const value = response.result?.value;
    if (response.exceptionDetails || value?.origin !== origin || typeof value.timeOrigin !== 'number')
      throw new Error('cookie_snapshot_context_differs');
    return value;
  };
  const before = await observe();
  const context = session.target?.browserContextId;
  const response = await send('Storage.getCookies', context ? {browserContextId: context} : {});
  if (!Array.isArray(response.cookies) || response.cookies.some(cookie => !cookie || typeof cookie.domain !== 'string'))
    throw new Error('cookie_snapshot_incomplete');
  const cookies = response.cookies.filter(cookie => appliesToHost(cookie, url.hostname));
  for (const cookie of cookies) {
    if (!['name', 'value', 'path'].every(key => typeof cookie[key] === 'string') ||
        !['secure', 'httpOnly', 'session'].every(key => typeof cookie[key] === 'boolean') ||
        typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires))
      throw new Error('cookie_snapshot_incomplete');
  }
  const after = await observe();
  if (before.timeOrigin !== after.timeOrigin) throw new Error('cookie_snapshot_context_changed');
  return {version: 'treadway.cookies/1', complete: true, actor, generation, origin,
    observedAt: new Date().toISOString(), cookies: JSON.parse(JSON.stringify(cookies)), limits: [...LIMITS]};
}

module.exports = {captureCookies, appliesToHost, LIMITS};
