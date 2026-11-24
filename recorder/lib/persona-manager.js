// Rich persona editing, provenance, preflight and safe model context.
// Pure browser/CommonJS helpers: no network, storage or application effects.
(function (root) {
  'use strict';
  const Personas = root.TreadwayPersonas || (typeof require === 'function' ? require('./personas.js') : null);
  const EDITABLE = new Set(['label', 'referenceDate', 'description', 'portrait', 'facts', 'domains', 'preferences', 'circumstances', 'histories']);
  const clone = value => JSON.parse(JSON.stringify(value));
  const normalise = value => Personas.parsePersonas(JSON.stringify({ personas: [value] }))[0];
  const revisionOf = persona => persona.revision || 1;
  const pointerPart = value => String(value).replace(/~/g, '~0').replace(/\//g, '~1');
  const parts = pointer => pointer.split('/').slice(1).map(value => value.replace(/~1/g, '/').replace(/~0/g, '~'));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function currentTime(options) { return options?.now ? new Date(options.now).toISOString() : new Date().toISOString(); }
  function expected(persona, options) {
    if (options?.expectedRevision !== undefined && options.expectedRevision !== revisionOf(persona)) throw new Error('Persona revision changed; reload before applying changes');
  }
  function signature(value) {
    function stable(item) {
      if (Array.isArray(item)) return item.map(stable);
      if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])]));
      return item;
    }
    let hash = 2166136261;
    for (const char of JSON.stringify(stable(value))) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
    return 'profile-' + (hash >>> 0).toString(16).padStart(8, '0');
  }
  function inputSignature(persona) {
    return signature(Object.fromEntries([...EDITABLE].map(key => [key, persona[key]])));
  }
  function editablePatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Persona changes must be an object');
    return Object.fromEntries(Object.entries(patch).filter(([key, value]) => EDITABLE.has(key) && value !== undefined).map(([key, value]) => [key, Personas.jsonData(value, 'changes.' + key)]));
  }
  function assertIdentity(before, after, options) {
    if (before.id !== after.id || before.role !== after.role) throw new Error('Persona id and role are immutable; create another persona');
    if ([...new Set([...Object.keys(before.facts), ...Object.keys(after.facts)])].some(key => /^(password|new_password|one_time_code)$|api.?key|secret|token/i.test(key) && before.facts[key] !== after.facts[key])) throw new Error('Persona edits cannot change credential facts');
    if (!options?.allowIdentityChange && ['email', 'username'].some(key => Boolean(before.facts[key]) && before.facts[key] !== after.facts[key])) {
      throw new Error('Identity contact changed; an explicit operator identity change is required');
    }
  }
  function walkDiff(before, after, path = '', changes = []) {
    if (equal(before, after)) return changes;
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) walkDiff(before[key], after[key], path + '/' + pointerPart(key), changes);
    } else changes.push({ path, ...(before === undefined ? {} : { previous: clone(before) }),
      ...(after === undefined ? { remove: true } : { value: clone(after) }) });
    return changes;
  }
  function previousSnapshot(persona) {
    const values = new Set();
    const credentialKey = key => /password|credential|token|api.?key|one.?time|\botp\b|secret/i.test(key);
    function collect(value, credential = false, rootObject = false) {
      if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
        if (rootObject && key === 'secrets') continue; // Named secret references.
        collect(item, credential || credentialKey(key));
      } else if (credential && typeof value === 'string' && value.length >= 3) values.add(value);
    }
    const { revisions: priorRevisions, deductions: priorDeductions, ...active } = persona;
    collect(active, false, true);
    function scrub(text) {
      for (const value of [...values].sort((a, b) => b.length - a.length)) text = text.split(value).join('[private]');
      return text.replace(/\b(?:sk_|sgw_)[A-Za-z0-9_-]{8,}\b/g, '[private token]');
    }
    function clean(value, rootObject = false) {
      if (typeof value === 'string') return scrub(value);
      if (Array.isArray(value)) return value.map(item => clean(item));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => (rootObject && key === 'secrets') || !credentialKey(key))
        .map(([key, item]) => [key, rootObject && key === 'secrets' ? Object.fromEntries(Object.entries(item).map(([type, reference]) => [type, typeof reference === 'string' ? scrub(reference) : reference])) : clean(item)]));
      return value;
    }
    const { credentials, deductions, revisions, ...snapshot } = persona;
    return clean(snapshot, true);
  }
  function updated(before, candidate, changes, source, options) {
    if (!changes.length) return normalise(before);
    candidate.revision = revisionOf(before) + 1;
    candidate.deductions = {};
    candidate.provenance = { ...before.provenance };
    for (const change of changes) candidate.provenance[change.path] = { source, revision: candidate.revision, at: currentTime(options) };
    candidate.revisions = [...(before.revisions || []).map(entry => ({ ...entry, ...(entry.snapshot ? { snapshot: previousSnapshot(entry.snapshot) } : {}) })), { revision: revisionOf(before), changedAt: currentTime(options),
      source, paths: changes.map(change => change.path), snapshot: previousSnapshot(before) }];
    return normalise(candidate);
  }
  function createPersona(input, options = {}) {
    const persona = normalise({ ...input, revision: 1, provenance: {}, overrides: [], deductions: {}, revisions: [] });
    const changes = walkDiff({}, Object.fromEntries([...EDITABLE].map(key => [key, persona[key]])));
    persona.provenance = Object.fromEntries(changes.map(change => [change.path, { source: options.source || 'operator', revision: 1, at: currentTime(options) }]));
    if (options.source !== 'agent' && options.source !== 'generated') {
      function leaves(value, path, result = []) {
        if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) leaves(item, path + '/' + pointerPart(key), result);
        else if (value !== '' && value !== undefined) result.push(path);
        return result;
      }
      persona.overrides = [...EDITABLE].flatMap(key => leaves(persona[key], '/' + key));
    }
    return normalise(persona);
  }
  function editPersona(persona, patch, options = {}) {
    expected(persona, options);
    if ((patch.id !== undefined && patch.id !== persona.id) || (patch.role !== undefined && patch.role !== persona.role)) throw new Error('Persona id and role are immutable; create another persona');
    const before = normalise(persona), candidate = normalise({ ...before, ...editablePatch(patch) });
    assertIdentity(before, candidate, options);
    const changes = walkDiff(Object.fromEntries([...EDITABLE].map(key => [key, before[key]])), Object.fromEntries([...EDITABLE].map(key => [key, candidate[key]])));
    candidate.overrides = [...new Set([...(before.overrides || []), ...changes.map(change => change.path)])];
    return updated(before, candidate, changes, 'operator', options);
  }
  function isOverride(persona, path) {
    return (persona.overrides || []).some(value => path === value || path.startsWith(value + '/') || value.startsWith(path + '/'));
  }
  function proposeEnrichment(persona, patch, options = {}) {
    expected(persona, options);
    if ((patch.id !== undefined && patch.id !== persona.id) || (patch.role !== undefined && patch.role !== persona.role)) throw new Error('Enrichment cannot change persona identity');
    const before = normalise(persona), candidate = clone(before), changes = [];
    function merge(current, proposed, path) {
      if (equal(current, proposed)) return clone(current);
      if (current && proposed && typeof current === 'object' && typeof proposed === 'object' && !Array.isArray(current) && !Array.isArray(proposed)) {
        const result = clone(current);
        for (const [key, value] of Object.entries(proposed)) result[key] = merge(current[key], value, path + '/' + pointerPart(key));
        return result;
      }
      if (Array.isArray(current) && Array.isArray(proposed) && current.every(item => item && typeof item.id === 'string') && proposed.every(item => item && typeof item.id === 'string')) {
        const result = clone(current);
        for (const record of proposed) {
          const index = result.findIndex(item => item.id === record.id);
          if (index < 0) result.push(merge(undefined, record, path + '/' + result.length));
          else result[index] = merge(result[index], record, path + '/' + index);
        }
        return result;
      }
      const operatorOverride = isOverride(before, path);
      changes.push({ path, ...(current === undefined ? {} : { previous: clone(current) }), value: clone(proposed),
        kind: (current === undefined || current === null || current === '') && !operatorOverride ? 'addition' : 'conflict', operatorOverride });
      return clone(proposed);
    }
    for (const [key, value] of Object.entries(editablePatch(patch))) candidate[key] = merge(before[key], value, '/' + key);
    assertIdentity(before, candidate);
    normalise(candidate);
    return { personaId: before.id, baseRevision: revisionOf(before), inputSignature: inputSignature(before),
      changes, additions: changes.filter(item => item.kind === 'addition').map(item => item.path),
      conflicts: changes.filter(item => item.kind === 'conflict').map(item => item.path), candidate };
  }
  function setPointer(object, pointer, value) {
    const keys = parts(pointer); let target = object;
    for (const key of keys.slice(0, -1)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe change path');
      if (target[key] === undefined) target[key] = {};
      target = target[key];
    }
    const key = keys.at(-1);
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe change path');
    target[key] = clone(value);
  }
  function applyProposal(persona, proposal, selectedPaths, options = {}) {
    expected(persona, options);
    if (!proposal || proposal.personaId !== persona.id || proposal.baseRevision !== revisionOf(persona) || proposal.inputSignature !== inputSignature(persona)) throw new Error('Enrichment proposal is stale; rediscover against the current persona');
    const selected = new Set(selectedPaths === undefined ? proposal.additions : selectedPaths);
    if ([...selected].some(path => !proposal.changes.some(change => change.path === path))) throw new Error('Unknown enrichment change');
    const before = normalise(persona), candidate = clone(before), changes = proposal.changes.filter(change => selected.has(change.path));
    for (const change of changes) {
      if (!/^\/(?:label|referenceDate|description|portrait|facts|domains|preferences|circumstances|histories)(?:\/|$)/.test(change.path)) throw new Error('Enrichment change is outside editable profile');
      setPointer(candidate, change.path, change.value);
    }
    assertIdentity(before, candidate);
    // Accepted conflicts explicitly replace an operator override; it remains
    // marked as such so later discovery cannot silently change it again.
    return updated(before, candidate, changes, 'agent_enrichment', options);
  }
  function applyEnrichment(persona, proposal, options = {}) {
    return applyProposal(persona, proposal, options.accept, options);
  }
  function privatePath(path) {
    const lower = String(path).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    const leaf = lower.split(/[/.]/).at(-1);
    if (/credentials|secrets|password|token|api.?key|one.?time|\botp\b/.test(lower)) return true;
    if (/^(?:has_|is_|requires_|needs_)|(?:_status|_verified)$|^(?:status|issuer|issuing_country|country|expiry|expires|scheme|type)$/.test(leaf)) return false;
    if (/email|username|phone|address_line|street|postcode|postal_code|zip_code|ppsn|ssn|iban|social_security|national_insurance|routing_number|sort_code|swift|^bic$|^nino$|^passport$|^passport_number$|^account_number$|^bank_account$|^tax_(?:id|number)$|^card_/.test(leaf)) return true;
    return /passport|national.?id|bank|registration|driver.*licen[sc]e|tax|(?:^|\/)ids?(?:\/|$)|identifier|document/.test(lower) && /^(?:number|identifier|value|id|account_number)$/.test(leaf);
  }
  function semanticContext(persona) {
    const values = new Set();
    function collect(value, path = '') {
      if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) collect(item, path + '/' + key);
      else if (privatePath(path) && typeof value === 'string' && value.length >= 3) values.add(value);
    }
    collect(persona);
    function scrub(value) {
      let text = value;
      for (const item of [...values].sort((a, b) => b.length - a.length)) {
        text = text.split(item).join('[private]');
        const compact = item.replace(/[\s-]/g, '');
        if (compact.length >= 7 && /^[A-Za-z0-9+]+$/.test(compact)) {
          const pattern = [...compact].map(char => char === '+' ? '\\+' : char).join('[\\s-]*');
          text = text.replace(new RegExp(pattern, 'gi'), '[private]');
        }
      }
      return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[private email]')
        .replace(/\b(?:sk_|sgw_)[A-Za-z0-9_-]{8,}\b/g, '[private token]');
    }
    function clean(value, path = '') {
      if (typeof value === 'string') return scrub(value);
      if (Array.isArray(value)) return value.map((item, index) => clean(item, path + '/' + index));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !privatePath(path + '/' + key)).map(([key, item]) => [key, clean(item, path + '/' + key)]));
      return value;
    }
    return clean({ revision: revisionOf(persona), referenceDate: persona.referenceDate, description: persona.description,
      facts: persona.facts, domains: persona.domains, preferences: persona.preferences,
      circumstances: persona.circumstances, histories: persona.histories });
  }
  function recordDeductions(persona, entries, options = {}) {
    expected(persona, options);
    const result = normalise(persona);
    const list = Array.isArray(entries) ? entries : Object.entries(entries || {}).map(([key, entry]) => ({ key, ...entry }));
    for (const entry of list) {
      const key = entry.key || entry.bindingKey;
      if (typeof key !== 'string' || !key || key.length > 160 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid deduction binding key');
      if (entry.type && (result.facts[entry.type] !== undefined || isOverride(result, '/facts/' + pointerPart(entry.type)))) continue;
      if (!Number.isFinite(entry.confidence) || entry.confidence < 0.51 || entry.confidence > 1 || !Number.isFinite(entry.fit) || entry.fit < 0.8 || entry.fit > 1) continue;
      if (privatePath(entry.type || '') || entry.credential) continue;
      const value = entry.value === undefined ? entry.selectedLabel : entry.value;
      if (!['string', 'boolean', 'number'].includes(typeof value) || (typeof value === 'string' && (!value || value.length > 1000))) throw new Error('Invalid categorical deduction');
      result.deductions[key] = { ...Personas.jsonData(clone(entry), 'deduction'), key, value, source: 'jev',
        personaRevision: revisionOf(persona), inputSignature: inputSignature(persona), recordedAt: currentTime(options) };
    }
    return result;
  }
  function usableDeductions(persona) {
    return Object.fromEntries(Object.entries(persona.deductions || {}).filter(([, value]) => value.personaRevision === revisionOf(persona) && value.inputSignature === inputSignature(persona)));
  }
  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  }
  function ibanValid(value) {
    const compact = String(value).replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
    let mod = 0;
    for (const char of compact.slice(4) + compact.slice(0, 4)) for (const digit of /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char) mod = (mod * 10 + Number(digit)) % 97;
    return mod === 1;
  }
  function preflight(persona) {
    const p = normalise(persona), checks = [];
    const add = (id, status, path, message) => checks.push({ id, status, path, message });
    add('profile.context', p.description.trim().length >= 80 ? 'pass' : 'uncertain', '/description', p.description.trim().length >= 80 ? 'Contextual description supplied' : 'Add enough circumstances and preferences to support unforeseen questions');
    const dob = p.facts.date_of_birth, ref = p.referenceDate;
    if (dob) add('identity.birthdate', validDate(dob) ? 'pass' : 'fail', '/facts/date_of_birth', validDate(dob) ? 'Birth date is a valid calendar date' : 'Birth date must be YYYY-MM-DD');
    if (validDate(dob) && validDate(ref)) {
      add('identity.birthdate_reference', dob <= ref ? 'pass' : 'fail', '/facts/date_of_birth', dob <= ref ? 'Birth precedes the reference date' : 'Birth date is after the reference date');
      if (p.facts.age !== undefined) {
        const age = Number(ref.slice(0, 4)) - Number(dob.slice(0, 4)) - Number(ref.slice(5) < dob.slice(5));
        add('identity.age', Number(p.facts.age) === age ? 'pass' : 'fail', '/facts/age', Number(p.facts.age) === age ? 'Age agrees with birth/reference dates' : 'Age contradicts birth/reference dates');
      }
    } else add('profile.reference_date', ref ? 'uncertain' : 'uncertain', '/referenceDate', 'Set a reference date for age, current status and validity checks');
    if (p.facts.ppsn) add('identity.ppsn_checksum', Personas.ppsnValid(p.facts.ppsn) ? 'pass' : 'fail', '/facts/ppsn', 'PPSN local format/checksum check; this does not establish allocation');
    function inspect(value, path = '') {
      if (!value || typeof value !== 'object') return;
      const code = value.bankCountry || value.bank_country || (/bank|account/i.test(path) ? value.countryCode || value.country_code || value.country : undefined);
      if (value.iban && typeof code === 'string' && /^[A-Z]{2}$/.test(code)) add('bank.country:' + path,
        String(value.iban).replace(/\s/g, '').slice(0, 2).toUpperCase() === code ? 'pass' : 'fail', path,
        'The account IBAN agrees with its own bank country, independently of residence');
      const issue = value.issueDate || value.issue_date || value.startDate || value.start_date;
      const expiry = value.expiryDate || value.expiry_date || value.endDate || value.end_date;
      if (validDate(issue) && validDate(expiry)) add('record.dates:' + path, issue <= expiry ? 'pass' : 'fail', path,
        issue <= expiry ? 'Record dates are ordered' : 'Record expiry/end precedes issue/start');
      for (const [key, item] of Object.entries(value)) {
        const at = path + '/' + pointerPart(key);
        if (/Date$|_date$|^date$|^validUntil$|^validFrom$/.test(key) && typeof item === 'string' && item) add('record.date:' + at, validDate(item) ? 'pass' : 'fail', at, 'Record date uses a valid YYYY-MM-DD value');
        if (/^iban$/i.test(key) && item) add('bank.iban_checksum:' + at, ibanValid(item) ? 'pass' : 'fail', at, 'IBAN syntax/checksum check; bank and account acceptance remain separate');
        if (['height_cm', 'weight_kg'].includes(key) && item !== '') add('physical.positive:' + at, Number(item) > 0 ? 'pass' : 'fail', at, 'Physical measurement must be positive in the named unit');
        inspect(item, at);
      }
    }
    inspect({ facts: p.facts, domains: p.domains });
    for (const [kind, records] of Object.entries(p.histories)) for (let index = 0; index < records.length; index++) {
      const record = records[index], path = '/histories/' + pointerPart(kind) + '/' + index;
      const start = record.startDate || record.start_date, end = record.endDate || record.end_date || record.awardDate || record.award_date;
      if (start && end && validDate(start) && validDate(end)) add('history.order:' + kind + ':' + record.id, start <= end ? 'pass' : 'fail', path, start <= end ? 'History dates are ordered' : 'History ends before it starts');
      for (const [key, value] of Object.entries(record)) if (/Date$|_date$|^date$|^validUntil$|^validFrom$/.test(key) && typeof value === 'string' && value) {
        add('history.date:' + kind + ':' + record.id + ':' + key, validDate(value) ? 'pass' : 'fail', path + '/' + key, 'History dates use valid YYYY-MM-DD values');
        if (validDate(value) && validDate(dob)) add('history.birth:' + kind + ':' + record.id + ':' + key, value >= dob ? 'pass' : 'fail', path + '/' + key, value >= dob ? 'History occurs after birth' : 'History date precedes birth');
      }
    }
    // Only named links in the canonical core are references. Application
    // identifiers and residence/citizenship/visa/bank countries stay distinct.
    const identity = p.domains.identity || {}, banking = p.domains.banking || {};
    const collections = {
      citizenshipId: identity.citizenships, passportId: identity.passports,
      nationalIdId: identity.nationalIds, visaId: identity.visas, permitId: identity.permits,
      residenceId: identity.residences || p.histories.residence,
      bankAccountId: banking.accounts,
    };
    function checkLinks(value, path) {
      if (!value || typeof value !== 'object') return;
      if (!Array.isArray(value)) for (const [key, records] of Object.entries(collections)) {
        if (value[key] === undefined || value[key] === null || value[key] === '') continue;
        const matches = Array.isArray(records) ? records.filter(record => record && record.id === value[key]) : [];
        add('core.link:' + path + '/' + key, typeof value[key] === 'string' && matches.length === 1 ? 'pass' : 'fail', path + '/' + key,
          matches.length === 1 ? 'Explicit core reference resolves to one record' : 'Explicit core reference is missing or ambiguous: ' + key);
        if (key === 'citizenshipId' && matches.length === 1 && /\/passports\/\d+$/.test(path)) {
          const issuer = value.issuingCountry || value.issuing_country || value.issuerCountry || value.issuer_country;
          const citizenCountry = matches[0].country || matches[0].countryCode || matches[0].country_code;
          if (issuer && citizenCountry) {
            const agrees = String(issuer).trim().toUpperCase() === String(citizenCountry).trim().toUpperCase();
            add('identity.passport_issuer:' + path, agrees ? 'pass' : 'uncertain', path,
              agrees ? 'Passport issuer agrees with the linked citizenship country' :
                'Passport issuer differs from the linked citizenship country; check representations and document context. This is not a legal-entitlement determination.');
          }
        }
      }
      for (const [key, item] of Object.entries(value)) checkLinks(item, path + '/' + pointerPart(key));
    }
    checkLinks(identity, '/domains/identity');
    checkLinks(banking, '/domains/banking');
    checkLinks(p.histories.residence || [], '/histories/residence');
    return { ready: checks.every(check => check.status !== 'fail'), complete: checks.every(check => check.status === 'pass'), checks };
  }
  const api = { EDITABLE: [...EDITABLE], revisionOf, revision: revisionOf, inputSignature, createPersona, editPersona, edit: editPersona,
    proposeEnrichment, propose: proposeEnrichment, snapshot: previousSnapshot, applyEnrichment, applyProposal, semanticContext, recordDeductions, usableDeductions, preflight, ibanValid };
  root.TreadwayPersonaManager = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
