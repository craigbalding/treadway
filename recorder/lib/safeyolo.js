// Optional integration. Native messaging keeps the sandbox bearer token outside
// extension storage; a manually configured key supports other managed browsers.
(function (root) {
  'use strict';
  const HOST = 'com.treadway.safeyolo';
  async function native(operation, body) {
    if (!root.chrome?.runtime?.sendNativeMessage) {
      const error = new Error('SafeYolo helper is not installed'); error.nativeUnavailable = true; throw error;
    }
    let timer, answer;
    try {
      answer = await Promise.race([
        root.chrome.runtime.sendNativeMessage(HOST, { operation, ...(body ? { body } : {}) }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SafeYolo helper response was not confirmed')), 20000); }),
      ]);
    } catch (error) {
      const failure = new Error('SafeYolo helper connection failed');
      failure.nativeUnavailable = /Specified native messaging host not found|Native messaging host.*not found/i.test(error.message);
      throw failure;
    } finally { clearTimeout(timer); }
    if (!answer || answer.error) {
      const error = new Error(answer?.error || 'SafeYolo helper did not answer');
      error.helperAvailable = Boolean(answer); throw error;
    }
    return answer;
  }
  function transport(mode) {
    return async (url, options = {}) => {
      if (url !== root.TreadwayTestContext.SAFEYOLO_CONTEXT_URL) throw new Error('Unsupported SafeYolo operation');
      const operation = { GET: 'read', POST: 'declare', DELETE: 'clear' }[options.method];
      if (!operation) throw new Error('Unsupported SafeYolo operation');
      const response = await native(operation, options.body ? JSON.parse(options.body) : undefined);
      return { status: response.status, text: async () => JSON.stringify(response.data) };
    };
  }
  async function connect(settings) {
    if (settings.safeyoloMode === 'off') return { enabled: false, mode: 'standalone' };
    let helperAvailable = false;
    try {
      const health = await native('health');
      if (health.available !== false) {
        helperAvailable = health.status === 200 && health.data?.agent_api === 'ok';
        if (!helperAvailable) { const error = new Error('SafeYolo helper health was not confirmed'); error.helperAvailable = true; throw error; }
      }
    } catch (error) {
      if (!error.nativeUnavailable) throw error;
      // A missing optional helper is normal on standalone Chrome.
    }
    if (helperAvailable) {
      const request = transport('native');
      const current = await root.TreadwayTestContext.readContext(request, '');
      if (typeof current.agent !== 'string' || !current.agent) throw new Error('SafeYolo identity was not confirmed');
      return { enabled: true, mode: 'native', current, request };
    }
    if (settings.safeyoloKey) {
      const current = await root.TreadwayTestContext.readContext(root.fetch, settings.safeyoloKey);
      if (typeof current.agent !== 'string' || !current.agent) throw new Error('SafeYolo identity was not confirmed');
      return { enabled: true, mode: 'key', current, request: root.fetch };
    }
    return { enabled: false, mode: 'standalone' };
  }
  function requestFor(journey) { return journey.safeyolo?.mode === 'native' ? transport('native') : root.fetch; }
  const api = { HOST, connect, requestFor };
  root.TreadwaySafeyolo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
