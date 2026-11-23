// Private, persistent test-persona credentials. No model or network calls.
(function (root) {
  'use strict';
  let queue = Promise.resolve();
  function password(crypto, maximumLength) {
    const length = maximumLength > 0 ? Math.min(20, maximumLength) : 20;
    if (length < 8) throw new Error('Password field limit is too short for a generated test password');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    const bytes = crypto.getRandomValues(new Uint8Array(length - 4));
    return 'Aa7!' + Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
  }
  function key(persona) {
    return JSON.stringify([persona.id, persona.role, persona.facts.email || '', persona.facts.username || '']);
  }
  function prepare({ persona, needsNewPassword, maximumLength, read, write, crypto }) {
    const operation = queue.then(async () => {
      const prepared = JSON.parse(JSON.stringify(persona));
      prepared.credentials = prepared.credentials || {};
      prepared.secrets = prepared.secrets || {};
      const all = (await read()) || {};
      const binding = key(prepared);
      const cached = all[binding];
      let chosen = prepared.credentials.new_password || prepared.credentials.password ||
        prepared.facts.new_password || prepared.facts.password || cached?.password;
      let generated = false;
      if (!chosen && needsNewPassword) { chosen = password(crypto, maximumLength); generated = true; }
      if (chosen) {
        prepared.credentials.password ||= chosen;
        prepared.credentials.new_password ||= chosen;
        prepared.secrets.password ||= cached?.reference || prepared.id + ':password';
        prepared.secrets.new_password ||= prepared.credentials.password === prepared.credentials.new_password ?
          prepared.secrets.password : prepared.id + ':new_password';
        all[binding] = { password: chosen, reference: prepared.secrets.new_password };
        // Persist before returning any value that can be filled into a page.
        await write(all);
      }
      return { persona: prepared, generated, stored: Boolean(chosen) };
    });
    queue = operation.catch(() => undefined);
    return operation;
  }
  const api = { prepare, password, key };
  root.TreadwayCredentials = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
