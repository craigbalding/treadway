// Request bundles for the existing agent session. No model API is called.
(function (root) {
  'use strict';
  const SECRET = /password|secret|token|one_time_code|api.?key/i;
  function safeEntry(entry) {
    const result = { ...entry };
    if (entry.secret || SECRET.test(entry.type || '')) {
      for (const key of ['value', 'expectedValue', 'observedValue']) delete result[key];
      result.redacted = true;
    }
    return result;
  }
  function request({ id, journey, persona, target, snapshot, extensionId, version }) {
    const last = [...journey.events].reverse().find(event => event.type === 'fill' &&
      event.tabId === target.id && event.documentInstanceId === snapshot.documentInstanceId);
    return {
      schema: 'treadway.assistance/1', requestId: id, createdAt: new Date().toISOString(), extensionId, version,
      run: journey.contextFields.run, stepId: journey.currentStepId,
      target: { tabId: target.id, url: snapshot.url, documentInstanceId: snapshot.documentInstanceId },
      persona: (root.TreadwayPersonaWork || (typeof require === 'function' ? require('./persona-work.js') : null)).safePersona(persona),
      personaRevision: persona.revision || 1,
      inputSignature: (root.TreadwayPersonaManager || (typeof require === 'function' ? require('./persona-manager.js') : null)).inputSignature(persona),
      form: snapshot.fields,
      lastFill: last ? { filled: last.filled.map(safeEntry), manual: last.manual.map(safeEntry),
        classifyError: last.classifyError } : null,
    };
  }
  function mergeFacts(persona, facts) {
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new Error('Assistance facts must be an object');
    for (const [key, value] of Object.entries(facts)) {
      if (SECRET.test(key) || ['email', 'username'].includes(key)) throw new Error('Assistance cannot change identity or credentials');
      if (typeof value !== 'string' || !value.trim()) throw new Error('Assistance facts must be non-empty strings');
    }
    const manager = root.TreadwayPersonaManager || (typeof require === 'function' ? require('./persona-manager.js') : null);
    const proposal = manager.proposeEnrichment(persona, { facts }, { expectedRevision: manager.revisionOf(persona) });
    if (proposal.conflicts.length) throw new Error('Assistance conflicts with existing persona facts; review changes in Manage personas');
    return manager.applyEnrichment(persona, proposal, { expectedRevision: manager.revisionOf(persona) });
  }
  const api = { request, mergeFacts };
  root.TreadwayAssistance = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
