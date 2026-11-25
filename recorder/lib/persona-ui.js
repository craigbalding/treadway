// Editable persona management. Storage and structured inference are supplied by the
// side panel so folder and Downloads modes share one implementation.
(function (root) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const pointer = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  const REVIEWS = 'personaInferenceReview', WORK = 'personaInferenceWork';
  const EDITABLE = ['label', 'referenceDate', 'description', 'portrait', 'facts', 'domains', 'preferences', 'circumstances', 'histories'];
  const IDENTITY_FACTS = new Set(['email', 'username', 'password', 'new_password', 'one_time_code']);

  function element(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'onClick') node.addEventListener('click', value);
      else if (key in node && !key.startsWith('data-')) node[key] = value;
      else node.setAttribute(key, value);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(label, action, attrs = {}) {
    return element('button', { type: 'button', onClick: event => {
      try { Promise.resolve(action(event)).catch(() => {}); } catch (error) { console.error(error); }
    }, ...attrs }, label);
  }
  function label(text, input) { const node = element('label', {}, text); node.append(input); return node; }
  function format(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  function displayName(value) { return String(value).replace(/[_-]+/g, ' ').replace(/^\w/, char => char.toUpperCase()); }
  function displayPath(path) { return path.split('/').slice(1).map(part => displayName(part.replace(/~1/g, '/').replace(/~0/g, '~'))).join(' › '); }
  function patchOf(persona) { return Object.fromEntries(EDITABLE.filter(key => persona[key] !== undefined).map(key => [key, clone(persona[key])])); }
  function localChecks(manager, persona) {
    try { return manager.preflight(persona).checks; }
    catch (error) { return [{ id: 'draft.schema', status: 'fail', message: error.message }]; }
  }
  function safePortrait(src) { return typeof src === 'string' && (/^data:image\/(png|jpeg|webp|svg\+xml);/i.test(src) || /^(examples\/|assets\/)/.test(src)); }

  function mount({ container, getPersonas, refreshPersonas, persist, ask, say }) {
    const M = root.TreadwayPersonaManager, AI = root.TreadwayPersonaInference;
    const owner = root.crypto.randomUUID();
    if (!M) throw new Error('Persona management library is unavailable');
    let selected = new Set();
    let inspecting = null, original = null, draft = null, dirty = false;
    let currentStatus = {}, work = null, review = null, busy = false;
    let requestDraft = null;
    let reviewKey = '';
    let validationTimer = null;
    let workQueue = Promise.resolve();
    const list = element('div', { id: 'persona-manager-list' });
    const editor = element('div', { id: 'persona-editor' });
    const reviewBox = element('div', { id: 'persona-review' });
    const workLine = element('p', { id: 'persona-work-status', class: 'persona-status', role: 'status' }, 'No persona work pending');
    const brief = element('textarea', { id: 'persona-brief', rows: 2, placeholder: 'What the application does; a sentence or two is enough.' });
    const market = element('input', { id: 'persona-market', placeholder: 'Client market or audience (optional)' });
    const actor = element('input', { id: 'persona-actor', placeholder: 'Intended user role (optional)' });
    const contact = element('input', { id: 'persona-contact-email', type: 'email', placeholder: 'An address you can receive (kept local)' });
    const instructions = element('textarea', { id: 'persona-instructions', rows: 2, placeholder: 'New context, preferences or corrections to consider (optional)' });
    const requestCard = element('div', { class: 'persona-card' });
    requestCard.append(element('h3', {}, 'Application context'), label('Application brief', brief), label('Market', market), label('Role', actor), label('Verification email for a new persona (optional)', contact), label('Additional context', instructions));
    const createButton = button('New persona', () => run(newDraft), { id: 'persona-new' });
    const createAgent = button('Create with AI', () => requestWork('create'), { id: 'persona-create-ai' });
    const enrich = button('Enrich selected', () => requestWork('enrich'), { id: 'persona-enrich' });
    const cancel = button('Cancel request', () => cancelWork(), { id: 'persona-cancel-work', hidden: true });
    const toolbar = element('div', { class: 'persona-toolbar' }); toolbar.append(createButton, createAgent, enrich, cancel);
    container.append(element('p', { class: 'persona-help' }, 'Inspect and edit a persona, or select several to enrich from new application context. Your corrections are preserved and generated changes are reviewed before saving.'), toolbar, list, requestCard, workLine, reviewBox, editor);

    async function run(action) {
      if (busy) return;
      busy = true; syncControls();
      try { return await action(); }
      catch (error) { say(error.message, 'error'); workLine.textContent = error.message; throw error; }
      finally { busy = false; syncControls(); }
    }
    // Event handlers must report failures without leaving rejected promises.
    const caught = action => () => { run(action).catch(() => {}); };
    function syncControls() {
      const pending = work && ['running', 'review'].includes(work.status);
      createButton.disabled = busy || currentStatus.fillBusy;
      createAgent.disabled = busy || pending || currentStatus.fillBusy;
      enrich.disabled = busy || pending || currentStatus.fillBusy || !selected.size;
      cancel.hidden = !pending; cancel.disabled = false;
      for (const node of editor.querySelectorAll('[data-mutation]')) node.disabled = busy || Boolean(currentStatus.fillBusy);
      const apply = reviewBox.querySelector('#persona-apply-reviewed'); if (apply) apply.disabled = busy || Boolean(currentStatus.fillBusy);
    }
    function renderList() {
      const personas = getPersonas();
      selected = new Set([...selected].filter(id => personas.some(p => p.id === id)));
      list.replaceChildren(...personas.map(persona => {
        const line = element('div', { class: 'persona-line' });
        const checkbox = element('input', { type: 'checkbox', checked: selected.has(persona.id), 'aria-label': 'Select ' + persona.label, 'data-persona-id': persona.id });
        checkbox.addEventListener('change', () => { checkbox.checked ? selected.add(persona.id) : selected.delete(persona.id); syncControls(); });
        line.append(checkbox, button(persona.label + ' · ' + persona.role + ' · r' + M.revisionOf(persona), caught(() => inspect(persona.id)), { class: 'persona-inspect', 'data-inspect-persona': persona.id }));
        return line;
      }));
      if (!personas.length) list.append(element('p', { class: 'persona-muted' }, 'No personas yet. Create a draft or generate one from your application context.'));
      syncControls();
    }
    function touch() {
      dirty = true; const line = editor.querySelector('#persona-editor-state'); if (line) line.textContent = 'Unsaved changes';
      clearTimeout(validationTimer);
      validationTimer = setTimeout(() => { if (draft) editor.querySelector('#persona-checks')?.replaceWith(checks(localChecks(M, draft))); }, 150);
    }
    function inspect(id) {
      if (dirty && !root.confirm('Discard unsaved persona edits?')) return;
      const persona = getPersonas().find(p => p.id === id);
      if (!persona) throw new Error('Persona is no longer available');
      inspecting = id; original = clone(persona); draft = clone(persona); requestDraft = null; dirty = false; renderEditor();
    }
    function newDraft() {
      if (dirty && !root.confirm('Discard unsaved persona edits?')) return;
      const id = 'persona-' + root.crypto.randomUUID().slice(0, 8);
      const input = { id, role: 'participant', label: 'New persona', seed: id,
        facts: {}, description: '', domains: {}, preferences: {}, circumstances: {}, histories: {},
        referenceDate: new Date().toISOString().slice(0, 10) };
      draft = M.createPersona(input); inspecting = null; original = null; requestDraft = draft; dirty = true; renderEditor();
    }
    function inputField(title, value, onChange, attrs = {}) {
      const input = element(attrs.multiline ? 'textarea' : 'input', { value: value ?? '', ...(attrs.multiline ? { rows: 4 } : {}), ...attrs });
      input.addEventListener('input', () => { onChange(input.value); touch(); }); return label(title, input);
    }
    function renderEditor() {
      editor.replaceChildren(); if (!draft) return;
      const card = element('div', { class: 'persona-card' });
      card.append(element('h3', { id: 'persona-editor-heading' }, original ? 'Edit ' + draft.label : 'New persona draft'), element('p', { id: 'persona-editor-state', class: 'persona-muted' }, dirty ? 'Unsaved changes' : 'Revision ' + M.revisionOf(draft)));
      if (safePortrait(draft.portrait?.src)) card.append(element('img', { src: draft.portrait.src, alt: draft.portrait.alt || draft.label, class: 'persona-portrait' }));
      card.append(inputField('Persona ID', draft.id, v => { draft.id = v; draft.seed = v; }, { id: 'persona-edit-id', readOnly: Boolean(original) }),
        inputField('Role', draft.role, v => { draft.role = v; }, { id: 'persona-edit-role', readOnly: Boolean(original) }),
        inputField('Label', draft.label, v => { draft.label = v; }, { id: 'persona-edit-label' }),
        inputField('Reference date', draft.referenceDate, v => { draft.referenceDate = v; }, { id: 'persona-edit-reference-date', type: 'date' }),
        inputField('Profile description', draft.description, v => { draft.description = v; }, { id: 'persona-edit-description', multiline: true }));
      const photo = element('input', { id: 'persona-edit-portrait', type: 'file', accept: 'image/png,image/jpeg,image/webp' });
      photo.addEventListener('change', () => {
        const file = photo.files[0]; if (!file) return;
        if (file.size > 256 * 1024) { say('Choose a portrait smaller than 256 KiB.', 'error'); return; }
        const reader = new FileReader(); reader.onload = () => {
          if (!safePortrait(reader.result)) { say('Unsupported portrait image.', 'error'); return; }
          draft.portrait = { src: reader.result, alt: draft.label, generator: 'operator-upload' }; touch(); renderEditor();
        }; reader.readAsDataURL(file);
      });
      card.append(label('Portrait', photo));
      for (const key of ['facts', 'domains', 'preferences', 'circumstances', 'histories']) {
        draft[key] ||= {};
        const section = element('details', { class: 'persona-tree', open: key === 'facts' });
        section.append(element('summary', {}, key === 'facts' ? 'Facts' : key[0].toUpperCase() + key.slice(1)), tree(draft[key], '/' + key, value => { draft[key] = value; touch(); }, { facts: key === 'facts', history: key === 'histories' }));
        card.append(section);
      }
      const deductions = Object.values(draft.deductions || {});
      if (deductions.length) {
        const derived = element('details', { class: 'persona-tree', id: 'persona-derived-answers' });
        derived.append(element('summary', {}, 'Saved inferred answers (' + deductions.length + ')'), element('p', { class: 'persona-muted' }, 'These are answers to specific controls, including their wording. Edit the facts or profile context to correct them; saving those changes invalidates earlier deductions.'));
        const usable = M.usableDeductions(draft);
        for (const answer of deductions.slice(0, 100)) {
          const item = element('div', { class: 'persona-proposal' });
          const question = answer.field?.groupLabel || answer.field?.label || answer.field?.name || answer.type || 'Observed control';
          item.append(element('strong', {}, question + ' → ' + (answer.selectedLabel ?? answer.value)), element('p', { class: 'persona-muted' },
            'Confidence ' + answer.confidence + ' · support ' + answer.fit + ' · persona revision ' + answer.personaRevision +
            ' · ' + (usable[answer.key] ? 'current' : 'stale; will be rechecked')));
          derived.append(item);
        }
        card.append(derived);
      }
      card.append(element('p', { class: 'persona-muted' }, original ? 'Existing identity and verification contact bindings are preserved. Persona edits do not change an application account.' : 'A draft can be saved and edited now. Use Create with AI to add coherent histories and context before using an incomplete draft.'));
      const actions = element('div', { class: 'persona-toolbar persona-actions' });
      actions.append(button(original ? 'Save changes' : 'Create draft', caught(saveDraft), { id: 'persona-save', 'data-mutation': 'true' }),
        button('Check consistency', caught(validateDraft), { id: 'persona-validate' }),
        button('Discard edits', caught(() => { draft = null; dirty = false; original = null; editor.replaceChildren(); }), { id: 'persona-discard-edits' }));
      card.append(actions, checks(localChecks(M, draft))); editor.append(card); syncControls();
    }
    function tree(value, path, set, options = {}) {
      const box = element('div', { class: 'persona-tree', 'data-path': path });
      const array = Array.isArray(value);
      const historyList = options.history && array && path.split('/').length === 3;
      for (const [key, entry] of Object.entries(value)) {
        const childPath = path + '/' + pointer(key);
        const locked = options.facts && Boolean(original) && IDENTITY_FACTS.has(key) &&
          (!['email', 'username'].includes(key) || Boolean(original.facts?.[key]));
        const update = next => { value[key] = next; set(value); };
        const remove = () => { array ? value.splice(Number(key), 1) : delete value[key]; set(value); renderEditor(); };
        if (entry !== null && typeof entry === 'object') {
          const section = element('details', { open: true });
          const heading = element('summary', {}, array ? entry.label || entry.id || 'Record ' + (Number(key) + 1) : displayName(key));
          section.append(heading, tree(entry, childPath, update, { history: options.history }));
          section.append(button(array ? 'Remove record' : 'Remove ' + key, remove, { disabled: locked })); box.append(section);
        } else {
          const row = element('div', { class: 'persona-leaf' });
          let control;
          if (typeof entry === 'boolean') {
            control = element('select', { 'data-persona-field': childPath });
            for (const val of ['true', 'false']) control.append(element('option', { value: val }, val)); control.value = String(entry);
            control.addEventListener('change', () => { update(control.value === 'true'); touch(); });
          } else {
            control = element('input', { value: entry === null ? '' : entry, type: options.facts && /password|one_time_code/.test(key) ? 'password' : typeof entry === 'number' ? 'number' : 'text', readOnly: locked, 'data-persona-field': childPath });
            control.addEventListener('input', () => { update(typeof entry === 'number' ? Number(control.value) : control.value); touch(); });
          }
          row.append(label(displayName(key), control), button('Remove', remove, { disabled: locked, 'aria-label': 'Remove ' + childPath })); box.append(row);
        }
      }
      const add = element('div', { class: 'persona-add' });
      const keyInput = element('input', { placeholder: array ? 'New record' : 'New field name', 'aria-label': 'New field in ' + path });
      const type = element('select', { 'aria-label': 'Value type in ' + path });
      for (const name of options.facts ? ['text'] : ['text', 'number', 'boolean', 'object', 'array']) type.append(element('option', { value: name }, name));
      if (path === '/histories') type.value = 'array';
      if (historyList) type.value = 'object';
      add.append(keyInput, type, button(array ? 'Add item' : 'Add field', () => {
        const key = array ? value.length : keyInput.value.trim();
        if (key === '' || ['__proto__', 'prototype', 'constructor'].includes(String(key))) { say('Use a valid field name.', 'error'); return; }
        if (!array && Object.hasOwn(value, key)) { say('That field already exists.', 'error'); return; }
        let next = { text: '', number: 0, boolean: false, object: {}, array: [] }[type.value];
        if (historyList && type.value === 'object') next = { id: 'record-' + root.crypto.randomUUID().slice(0, 8), label: keyInput.value.trim() || 'New record' };
        value[key] = next; set(value); touch(); renderEditor();
      })); box.append(add); return box;
    }
    function checks(items = []) {
      const list = element('ul', { class: 'persona-checks', id: 'persona-checks' });
      for (const check of items) list.append(element('li', { 'data-state': check.status }, check.status + ': ' + (check.message || check.id) + (check.path ? ' (' + check.path + ')' : '')));
      return list;
    }
    async function saveDraft() {
      if (!draft) return;
      const updated = original ? M.editPersona(original, patchOf(draft), { expectedRevision: M.revisionOf(original) }) : M.createPersona(draft);
      await persist([updated], original ? [original] : []);
      dirty = false; inspect(updated.id); renderList(); say('Saved persona ' + updated.label + ' at revision ' + M.revisionOf(updated));
    }
    async function validateDraft() {
      if (!draft) return;
      const result = await ask({ kind: 'persona-preflight', persona: draft });
      editor.querySelector('#persona-checks')?.replaceWith(checks(result.checks));
    }
    function saveWork(next, expectedStatus) {
      const result = workQueue.then(async () => {
        const latest = (await chrome.storage.local.get(WORK))[WORK];
        if (expectedStatus && (latest?.requestId !== next.requestId || latest.status !== expectedStatus)) return false;
        work = next; await chrome.storage.local.set({ [WORK]: next }); renderWork(); return true;
      });
      workQueue = result.catch(() => undefined); return result;
    }
    function renderWork() {
      workLine.textContent = !work ? 'No persona generation pending' : ({ running: 'Generating persona proposals…', review: 'Generated changes are ready to review', completed: 'Persona changes saved', cancelled: 'Persona request cancelled', failed: 'Persona generation failed' }[work.status] || work.status) + (work.error ? ' · ' + work.error : '');
      renderReview(); syncControls();
    }
    async function requestWork(operation) {
      if (busy || ['running', 'review'].includes(work?.status)) return;
      let targets, current;
      busy = true; syncControls();
      try {
        if (!AI) throw new Error('Persona inference is unavailable. Reload the recorder.');
        const readiness = await ask({ kind: 'inference-settings-check' });
        if (!readiness.ready) throw new Error(readiness.reason || readiness.error || 'Configure inference in Settings before generating a persona.');
        if (operation === 'create') {
          if (!draft || original) newDraft();
          if (contact.value.trim()) {
            if (!contact.checkValidity()) throw new Error('Use a valid verification email address.');
            if (draft.facts.email && draft.facts.email !== contact.value.trim()) throw new Error('Edit the draft to change its existing contact before generating.');
            draft.facts.email = contact.value.trim();
          }
          requestDraft = AI.prepareDraft(draft); draft = clone(requestDraft); targets = [requestDraft]; renderEditor();
        } else {
          targets = getPersonas().filter(p => selected.has(p.id));
          if (!targets.length) throw new Error('Select one or more personas to enrich');
          if (dirty) throw new Error('Save or discard persona edits before requesting enrichment');
        }
        const context = { brief: brief.value.trim(), market: market.value.trim(), actor: actor.value.trim(), instructions: instructions.value.trim() };
        const request = AI.buildRequest({ operation, personas: targets, context });
        current = { requestId: 'persona-' + root.crypto.randomUUID(), operation, owner, status: 'running',
          createdAt: new Date().toISOString(), bases: clone(targets) };
        await saveWork(current);
        // Keep cancellation available while the background owns the provider call.
        busy = false; syncControls();
        const { data } = await ask({ kind: 'inference-request', requestId: current.requestId, purpose: 'persona-' + operation,
          schema: request.schema, messages: request.messages });
        const latest = (await chrome.storage.local.get(WORK))[WORK];
        if (latest?.requestId !== current.requestId || latest.status !== 'running') return;
        if (refreshPersonas) await refreshPersonas();
        const candidates = AI.readCandidates(data, { personas: current.bases, operation });
        const entries = [];
        for (const candidate of candidates) {
          let base = current.bases.find(p => p.id === candidate.id);
          if (operation === 'create') {
            if (getPersonas().some(p => p.id === candidate.id)) throw new Error('The new persona ID is already in use');
            if (!draft || draft.id !== base.id || M.inputSignature(draft) !== M.inputSignature(base)) throw new Error('The draft changed during generation. Request a fresh proposal.');
          } else {
            const saved = getPersonas().find(p => p.id === base.id);
            if (!saved || M.revisionOf(saved) !== M.revisionOf(base) || M.inputSignature(saved) !== M.inputSignature(base)) throw new Error('Persona changed during generation. Request fresh enrichment.');
            base = saved;
          }
          entries.push({ isNew: operation === 'create', base: clone(base), candidate,
            proposal: M.proposeEnrichment(base, candidate, { expectedRevision: M.revisionOf(base) }) });
        }
        review = { requestId: current.requestId, entries, createdAt: new Date().toISOString() };
        await chrome.storage.local.set({ [REVIEWS]: review });
        if (!await saveWork({ ...current, status: 'review' }, 'running')) { review = null; await chrome.storage.local.remove(REVIEWS); return; }
        say('Generated persona changes are ready to inspect and review.');
      } catch (error) {
        const latest = (await chrome.storage.local.get(WORK))[WORK];
        if (current && latest?.requestId === current.requestId && latest.status !== 'cancelled') await saveWork({ ...current, status: 'failed', error: error.message });
        if (!current || latest?.status !== 'cancelled') say(error.message, 'error');
      } finally { busy = false; syncControls(); }
    }
    async function cancelWork() {
      if (!work || !['running', 'review'].includes(work.status)) return;
      const previous = work;
      review = null; await chrome.storage.local.remove(REVIEWS);
      await saveWork({ ...previous, status: 'cancelled' });
      if (previous.status === 'running') await ask({ kind: 'inference-cancel', requestId: previous.requestId }).catch(() => {});
      say('Persona request cancelled. No proposed changes were saved.');
    }
    async function syncWork() {
      const saved = await chrome.storage.local.get([WORK, REVIEWS]); work = saved[WORK] || null;
      review = saved[REVIEWS] || null;
      if (work?.status === 'running' && work.owner !== owner) {
        const requestId = work.requestId;
        await saveWork({ ...work, status: 'cancelled', error: 'The panel closed before completion. Start a new request when ready.' });
        await ask({ kind: 'inference-cancel', requestId }).catch(() => {});
      }
      if (review && (work?.requestId !== review.requestId || work.status !== 'review')) review = null;
      renderWork();
    }
    function renderReview() {
      const nextKey = review ? JSON.stringify(review) : '';
      if (nextKey === reviewKey) { syncControls(); return; } reviewKey = nextKey;
      reviewBox.replaceChildren(); if (!review) return;
      const chosen = new Map();
      reviewBox.append(element('h3', {}, 'Review generated changes'));
      for (const entry of review.entries) {
        const card = element('div', { class: 'persona-card' }); card.append(element('h4', {}, entry.candidate.label));
        if (safePortrait(entry.candidate.portrait?.src)) card.append(element('img', { src: entry.candidate.portrait.src, alt: entry.candidate.portrait.alt || entry.candidate.label, class: 'persona-portrait' }));
        const paths = new Set(entry.proposal.additions); chosen.set(entry.candidate.id, paths);
        if (entry.isNew && entry.base.label === 'New persona') {
          for (const change of entry.proposal.changes) if (change.path === '/label' || change.path === '/portrait/alt') paths.add(change.path);
        }
        card.append(checks(localChecks(M, entry.candidate)));
        for (const change of entry.proposal.changes) {
          const line = element('div', { class: 'persona-proposal' });
          const choose = element('input', { type: 'checkbox', checked: paths.has(change.path), 'data-proposal-path': change.path });
          choose.addEventListener('change', () => choose.checked ? paths.add(change.path) : paths.delete(change.path));
          line.append(label((change.operatorOverride ? 'Your correction · ' : '') + change.kind + ': ' + displayPath(change.path), choose),
            element('pre', {}, change.path === '/portrait/src' ? 'Portrait preview shown above.' : 'Current: ' + format(change.previous) + '\nProposed: ' + format(change.value))); card.append(line);
        }
        if (!entry.proposal.changes.length) card.append(element('p', {}, 'No changes proposed.'));
        reviewBox.append(card);
      }
      reviewBox.append(button('Apply reviewed changes', caught(async () => {
        const saved = (await chrome.storage.local.get(WORK))[WORK];
        if (saved?.requestId !== review.requestId || saved.status !== 'review') throw new Error('This proposal is no longer current');
        const current = getPersonas(), output = [], expected = [];
        for (const entry of review.entries) {
          let base = entry.base;
          if (!entry.isNew) {
            base = current.find(p => p.id === base.id); if (!base) throw new Error('Persona no longer exists'); expected.push(entry.base);
          }
          output.push(M.applyEnrichment(base, entry.proposal, { accept: [...chosen.get(entry.candidate.id)], expectedRevision: entry.proposal.baseRevision }));
        }
        await persist(output, expected);
        await saveWork({ ...saved, status: 'completed', revisions: output.map(p => ({ id: p.id, revision: M.revisionOf(p) })) });
        await chrome.storage.local.remove(REVIEWS); review = null; dirty = false; draft = null; original = null;
        editor.replaceChildren(); renderList(); renderWork(); say('Reviewed persona changes saved.');
      }), { id: 'persona-apply-reviewed', disabled: busy || currentStatus.fillBusy }));
    }
    root.addEventListener('pagehide', () => {
      if (work?.status === 'running' && work.owner === owner) {
        chrome.storage.local.set({ [WORK]: { ...work, status: 'cancelled' } });
        ask({ kind: 'inference-cancel', requestId: work.requestId }).catch(() => {});
      }
    });
    function update(status) { currentStatus = status || {}; renderList(); }
    renderList(); syncWork().catch(error => say(error.message, 'error'));
    return { update, reload: renderList, syncWork };
  }
  root.TreadwayPersonaUI = { mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);
