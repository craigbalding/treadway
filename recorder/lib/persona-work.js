// Agent work packets are local private transport, not a text-generation API.
(function (root) {
  'use strict';
  const SECRET = /password|secret|token|one.?time.?code|api.?key/i;
  const terminal = work => !work || ['completed', 'cancelled', 'failed'].includes(work.status);
  function safePersona(persona) {
    const clone = JSON.parse(JSON.stringify(persona)); const forbidden = [];
    function collect(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (SECRET.test(key) && typeof item === 'string' && item.length) forbidden.push(item);
        else collect(item);
      }
    }
    collect(clone);
    function clean(value) {
      if (typeof value === 'string') { for (const secret of forbidden) value = value.split(secret).join('[credential redacted]'); return value; }
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['credentials', 'secrets', 'revisions', 'deductions'].includes(key) && !SECRET.test(key)).map(([key, item]) => [key, clean(item)]));
      return value;
    }
    const result = clean(clone); result.credentialTypes = Object.keys(persona.credentials || {});
    return result;
  }
  function request(message, { id, extensionId, version, now = new Date() }) {
    if (!['create', 'enrich'].includes(message.operation) || !Array.isArray(message.personas) || !message.personas.length || message.personas.length > 30) throw new Error('Choose up to 30 personas for one work request');
    const personas = message.personas.map(persona => root.TreadwayPersonas.parsePersonas(JSON.stringify({ personas: [persona] }))[0]);
    if (new Set(personas.map(persona => persona.id)).size !== personas.length || (message.operation === 'create' && personas.length !== 1)) throw new Error('Invalid persona work targets');
    const text = {};
    for (const key of ['brief', 'market', 'actor', 'instructions']) {
      const value = message[key] || '';
      if (typeof value !== 'string' || value.length > 8000) throw new Error('Invalid persona work context');
      text[key] = value;
    }
    const packet = { schema: 'treadway.persona-work/1', requestId: id, operation: message.operation, extensionId, version,
      createdAt: now.toISOString(), status: 'queued', ...text,
      personaIds: personas.map(persona => persona.id), personas: personas.map(safePersona),
      personaBindings: Object.fromEntries(personas.map(persona => [persona.id, {
        revision: root.TreadwayPersonaManager.revisionOf(persona), inputSignature: root.TreadwayPersonaManager.inputSignature(persona) }])),
      baseRevisions: Object.fromEntries(personas.map(persona => [persona.id, root.TreadwayPersonaManager.revisionOf(persona)])) };
    if (JSON.stringify(packet).length * 3 > 2 * 1024 * 1024) throw new Error('Persona request is too large; select fewer personas or smaller portraits');
    return packet;
  }
  const api = { terminal, safePersona, request };
  root.TreadwayPersonaWork = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
