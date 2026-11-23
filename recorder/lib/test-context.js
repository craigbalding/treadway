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
    const options = { method, headers: { Authorization: 'Bearer ' + apiKey } };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetchFunction(SAFEYOLO_CONTEXT_URL, options);
    } catch (error) {
      throw new Error('Cannot reach the SafeYOLO Agent API (is this browser using the SafeYOLO proxy?): ' + error.message);
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      parsed = null;
    }
    if (response.status !== 200 || !parsed) {
      const detail = parsed ? [parsed.error, parsed.detail].filter(Boolean).join(': ') : text.slice(0, 200);
      throw new Error('SafeYOLO ' + method + ' test context failed with HTTP ' + response.status + (detail ? ' (' + detail + ')' : ''));
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

  function hostMatches(host, patterns) {
    const name = String(host).toLowerCase();
    return patterns.some((pattern) => {
      const value = String(pattern).trim().toLowerCase();
      if (!value) return false;
      if (value.startsWith('*.')) return name.endsWith(value.slice(1)) && name.length > value.length - 1;
      return name === value;
    });
  }

  const api = { SAFEYOLO_CONTEXT_URL, slug, buildContext, readContext, declareContext, clearContext, hostMatches };
  root.TreadwayTestContext = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
