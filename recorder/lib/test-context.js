// SafeYOLO declared test context: building the context string and calling the
// Agent API at http://_safeyolo.proxy.internal/api/test-context/current.
(function (root) {
  'use strict';

  const SAFEYOLO_CONTEXT_URL = 'http://_safeyolo.proxy.internal/api/test-context/current';
  const SAFE_TOKEN = /^[A-Za-z0-9_.:-]+$/;

  function slug(text) {
    const value = String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '');
    if (!value) throw new Error('Journey name needs at least one letter or digit');
    return value;
  }

  function timestamp(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  }

  // Values may contain only [A-Za-z0-9_.:-]; SafeYOLO rejects anything else.
  // run is unique per recording; test names the journey across recordings.
  function buildContext({ agent, persona, journey, startedAt }) {
    const test = slug(journey);
    const fields = {
      run: test + '-' + timestamp(startedAt) + '-' + root.crypto.randomUUID().slice(0, 8),
      agent,
      role: persona.role,
      test,
      persona: persona.id,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) {
        throw new Error('Test context ' + key + ' must use only letters, digits and _ . : -');
      }
    }
    return {
      fields,
      header: Object.entries(fields).map(([key, value]) => key + '=' + value).join(';'),
    };
  }

  async function callSafeyolo(fetchFunction, apiKey, method, body) {
    const controller = new AbortController();
    const options = { method, signal: controller.signal, headers: { Authorization: 'Bearer ' + apiKey } };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response, text, timer;
    try {
      [response, text] = await Promise.race([
        (async () => { const result = await fetchFunction(SAFEYOLO_CONTEXT_URL, options); return [result, await result.text()]; })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('SafeYolo response unconfirmed')); }, 20000); }),
      ]);
    } catch (error) {
      throw new Error('Cannot reach the SafeYolo Agent API; check the browser proxy and integration');
    } finally { clearTimeout(timer); }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      parsed = null;
    }
    if (response.status !== 200 || !parsed) {
      throw new Error('SafeYolo ' + method + ' test context failed with HTTP ' + response.status);
    }
    return parsed;
  }

  // GET also tells us the agent name SafeYOLO trusts for this API key.
  function readContext(fetchFunction, apiKey) {
    return callSafeyolo(fetchFunction, apiKey, 'GET');
  }

  // Returns {context, expires_in}; SafeYOLO caps ttl at its policy maximum.
  function declareContext(fetchFunction, apiKey, header, ttlSeconds) {
    return callSafeyolo(fetchFunction, apiKey, 'POST', { context: header, ttl: ttlSeconds });
  }

  function clearContext(fetchFunction, apiKey) {
    return callSafeyolo(fetchFunction, apiKey, 'DELETE');
  }

  // The Agent API returns a context object, while declarations use a header.
  // Compare every field, including safe extension metadata, independent of order.
  function contextKey(value) {
    let entries;
    if (typeof value === 'string') {
      entries = [];
      for (const part of value.split(';').map(part => part.trim()).filter(Boolean)) {
        const equal = part.indexOf('=');
        if (equal < 1) return null;
        entries.push([part.slice(0, equal).trim(), part.slice(equal + 1).trim()]);
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) entries = Object.entries(value);
    else return null;
    const fields = new Map();
    for (const [key, entry] of entries) {
      if (!SAFE_TOKEN.test(key) || typeof entry !== 'string' || !SAFE_TOKEN.test(entry) || fields.has(key)) return null;
      fields.set(key, entry);
    }
    if (!fields.has('run') || !fields.has('agent') || fields.size > 20) return null;
    return JSON.stringify([...fields].sort(([a], [b]) => a.localeCompare(b)));
  }

  function sameContext(left, right) {
    const key = contextKey(left);
    return key !== null && key === contextKey(right);
  }

  const api = { SAFEYOLO_CONTEXT_URL, slug, buildContext, readContext, declareContext, clearContext, sameContext };
  root.TreadwayTestContext = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
