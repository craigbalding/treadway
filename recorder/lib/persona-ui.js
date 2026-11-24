// Editable persona management. Storage and agent transport are supplied by the
// side panel so folder and Downloads modes share one implementation.
(function (root) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const pointer = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  const REVIEWS = 'personaWorkReview';
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

  function mount({ container, getPersonas, refreshPersonas, persist, ask, exportRequest, say }) {
    const M = root.TreadwayPersonaManager;
    if (!M) throw new Error('Persona management library is unavailable');
    let selected = new Set();
    let inspecting = null, original = null, draft = null, dirty = false;
    let currentStatus = {}, work = null, review = null, busy = false;
    let requestDraft = null;
    let reviewKey = '';
    let validationTimer = null;
    const list = element('div', { id: 'persona-manager-list' });
    const editor = element('div', { id: 'persona-editor' });
    const reviewBox = element('div', { id: 'persona-review' });
    const workLine = element('p', { id: 'persona-work-status', class: 'persona-status', role: 'status' }, 'No persona work pending');
    const brief = element('textarea', { id: 'persona-brief', rows: 2, placeholder: 'What the application does; a sentence or two is enough.' });
    const market = element('input', { id: 'persona-market', placeholder: 'Client market or audience (optional)' });
    const actor = element('input', { id: 'persona-actor', placeholder: 'Intended user role (optional)' });
    const instructions = element('textarea', { id: 'persona-instructions', rows: 2, placeholder: 'New context, preferences or corrections to consider (optional)' });
    const requestCard = element('div', { class: 'persona-card' });
    requestCard.append(element('h3', {}, 'Application context'), label('Application brief', brief), label('Market', market), label('Role', actor), label('Additional context', instructions));
    const createButton = button('New persona', () => run(newDraft), { id: 'persona-new' });
    const createAgent = button('Create with agent', () => run(() => requestWork('create')), { id: 'persona-create-agent' });
    const enrich = button('Enrich selected', () => run(() => requestWork('enrich')), { id: 'persona-enrich' });
    const cancel = button('Cancel request', () => run(cancelWork), { id: 'persona-cancel-work', hidden: true });
    const toolbar = element('div', { class: 'persona-toolbar' }); toolbar.append(createButton, createAgent, enrich, cancel);
    container.append(element('p', { class: 'persona-help' }, 'Inspect and edit a persona, or select several to enrich from new application context. Your corrections are preserved and agent changes are reviewed before saving.'), toolbar, list, requestCard, workLine, reviewBox, editor);

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
      const pending = work && !['completed', 'cancelled', 'failed'].includes(work.status);
      createButton.disabled = busy || currentStatus.fillBusy;
      createAgent.disabled = busy || pending || currentStatus.fillBusy;
      enrich.disabled = busy || pending || currentStatus.fillBusy || !selected.size;
      cancel.hidden = !pending; cancel.disabled = busy;
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
      if (!personas.length) list.append(element('p', { class: 'persona-muted' }, 'No personas yet. Create a draft or ask your agent to prepare one.'));
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
        derived.append(element('summary', {}, 'Jev’s saved answers (' + deductions.length + ')'), element('p', { class: 'persona-muted' }, 'These are answers to specific controls, including their wording. Edit the facts or profile context to correct them; saving those changes invalidates earlier deductions.'));
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
      card.append(element('p', { class: 'persona-muted' }, original ? 'Existing identity and verification contact bindings are preserved. Persona edits do not change an application account.' : 'A draft can be saved and edited now. Ask the agent to add coherent histories and context before using an incomplete draft.'));
      const actions = element('div', { class: 'persona-toolbar persona-actions' });
      actions.append(button(original ? 'Save changes' : 'Create draft', caught(saveDraft), { id: 'persona-save', 'data-mutation': 'true' }),
        button('Validate with Jev', caught(validateDraft), { id: 'persona-validate' }),
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
    async function requestWork(operation) {
      let targets;
      if (operation === 'create') {
        if (!draft || original) newDraft();
        requestDraft = M.createPersona(draft); targets = [requestDraft];
      } else {
        targets = getPersonas().filter(p => selected.has(p.id));
        if (!targets.length) throw new Error('Select one or more personas to enrich');
        if (dirty) throw new Error('Save or discard the open persona edits before requesting enrichment');
      }
      const result = await ask({ kind: 'persona-work-request', operation, personaIds: targets.map(p => p.id), personas: targets,
        brief: brief.value.trim(), market: market.value.trim(), actor: actor.value.trim(), instructions: instructions.value.trim() });
      work = result.request || result;
      if (operation === 'create') await chrome.storage.local.set({ personaWorkPrivateDraft: { requestId: work.requestId, persona: requestDraft } });
      try {
        if (new TextEncoder().encode(JSON.stringify(work, null, 2)).length > 2 * 1024 * 1024) throw new Error('This persona bundle is too large for the agent inbox. Select fewer personas or use smaller portraits.');
        await exportRequest(work);
      }
      catch (error) { await ask({ kind: 'persona-work-cancel', requestId: work.requestId }).catch(() => {}); throw error; }
      await syncWork(); say('Persona request sent to your agent. You can continue your current journey.');
    }
    async function cancelWork() {
      if (!work) return;
      await ask({ kind: 'persona-work-cancel', requestId: work.requestId });
      review = null; await chrome.storage.local.remove([REVIEWS, 'personaWorkPrivateDraft']); await syncWork(); renderReview();
    }
    async function syncWork() {
      const response = await ask({ kind: 'persona-work-status' }); work = response.request || null;
      if (!review) review = (await chrome.storage.local.get(REVIEWS))[REVIEWS] || null;
      workLine.textContent = !work ? 'No persona work pending' : ({ queued: 'Waiting for your agent', accepted: 'Agent acknowledged; preparing persona changes', proposed: 'Agent changes are ready to review', completed: 'Persona work complete', cancelled: 'Persona request cancelled', failed: 'Persona request failed' }[work.status] || work.status) + ' · ' + work.operation + (work.error ? ' · ' + String(work.error).slice(0, 500) : '');
      if (review && (!work || review.requestId !== work.requestId || ['cancelled', 'failed', 'completed'].includes(work.status))) review = null;
      renderReview(); syncControls();
    }
    function renderReview() {
      const nextKey = review ? JSON.stringify(review) : '';
      if (nextKey === reviewKey) { syncControls(); return; } reviewKey = nextKey;
      reviewBox.replaceChildren(); if (!review) return;
      const chosen = new Map();
      reviewBox.append(element('h3', {}, 'Review agent changes'));
      for (const entry of review.entries) {
        const card = element('div', { class: 'persona-card' }); card.append(element('h4', {}, entry.candidate.label));
        if (entry.isNew) {
          card.append(element('p', {}, 'New persona candidate: review additions and any changes to your draft.'), checks(localChecks(M, entry.candidate)));
        }
        {
          const paths = new Set(entry.proposal.additions); chosen.set(entry.candidate.id, paths);
          if (entry.isNew && entry.base.label === 'New persona' && entry.proposal.changes.some(change => change.path === '/label')) paths.add('/label');
          for (const change of entry.proposal.changes) {
            const line = element('div', { class: 'persona-proposal' });
            const choose = element('input', { type: 'checkbox', checked: paths.has(change.path), 'data-proposal-path': change.path });
            choose.addEventListener('change', () => choose.checked ? paths.add(change.path) : paths.delete(change.path));
            line.append(label((change.operatorOverride ? 'Your correction · ' : '') + change.kind + ': ' + displayPath(change.path), choose),
              element('pre', {}, 'Current: ' + format(change.previous) + '\nProposed: ' + format(change.value))); card.append(line);
          }
          if (!entry.proposal.changes.length) card.append(element('p', {}, 'No changes proposed.'));
        }
        reviewBox.append(card);
      }
      reviewBox.append(button('Apply reviewed changes', caught(async () => {
        const current = getPersonas(); const output = [], expected = [];
        for (const entry of review.entries) {
          if (entry.isNew) output.push(M.applyEnrichment(entry.base, entry.proposal, { accept: [...chosen.get(entry.candidate.id)], expectedRevision: entry.proposal.baseRevision }));
          else {
            const persona = current.find(p => p.id === entry.candidate.id); if (!persona) throw new Error('Persona no longer exists');
            output.push(M.applyEnrichment(persona, entry.proposal, { accept: [...chosen.get(persona.id)], expectedRevision: entry.proposal.baseRevision })); expected.push(entry.base);
          }
        }
        await ask({ kind: 'persona-work-check', requestId: review.requestId });
        await persist(output, expected);
        await ask({ kind: 'persona-work-finished', requestId: review.requestId, result: { personaIds: output.map(p => p.id), revisions: output.map(p => M.revisionOf(p)) } });
        await chrome.storage.local.remove([REVIEWS, 'personaWorkPrivateDraft']); review = null; dirty = false; draft = null; original = null; editor.replaceChildren(); renderList(); await syncWork(); say('Reviewed persona changes saved.');
      }), { id: 'persona-apply-reviewed', disabled: busy || currentStatus.fillBusy }));
    }
    async function complete({ requestId, personas: candidates, candidates: alias }) {
      if (refreshPersonas) await refreshPersonas();
      const { request } = await ask({ kind: 'persona-work-check', requestId });
      candidates ||= alias;
      if (!Array.isArray(candidates) || !candidates.length) throw new Error('Agent completion requires persona candidates');
      const requested = request.personas || []; const entries = [];
      const privateDraft = (await chrome.storage.local.get('personaWorkPrivateDraft')).personaWorkPrivateDraft;
      const ids = new Set();
      for (const candidate of candidates) {
        if (!candidate?.id || ids.has(candidate.id) || !request.personaIds.includes(candidate.id)) throw new Error('Unexpected or duplicate persona candidate'); ids.add(candidate.id);
        if (request.operation === 'create') {
          const binding = requested.find(p => p.id === candidate.id);
          if (binding && (candidate.role !== binding.role || ['email', 'username'].some(key => binding.facts?.[key] && candidate.facts?.[key] !== binding.facts[key]))) throw new Error('Candidate changed a supplied identity binding');
          if (getPersonas().some(p => p.id === candidate.id)) throw new Error('New persona ID is already in use');
          const supplied = privateDraft?.requestId === requestId && privateDraft.persona?.id === candidate.id ? privateDraft.persona : binding;
          const base = M.createPersona({ ...(supplied || { id: candidate.id, role: candidate.role, facts: {} }),
            credentials: { ...(candidate.credentials || {}), ...(supplied?.credentials || {}) },
            secrets: { ...(candidate.secrets || {}), ...(supplied?.secrets || {}) } });
          const parsedCandidate = M.createPersona(candidate, { source: 'agent' });
          const proposal = M.proposeEnrichment(base, parsedCandidate, { expectedRevision: M.revisionOf(base) });
          entries.push({ isNew: true, base, proposal, candidate: parsedCandidate });
        } else {
          const base = getPersonas().find(p => p.id === candidate.id);
          const requestedBase = requested.find(p => p.id === candidate.id);
          const binding = request.personaBindings?.[candidate.id];
          if (!base || !requestedBase || M.revisionOf(base) !== M.revisionOf(requestedBase) ||
            (binding && (M.revisionOf(base) !== binding.revision || M.inputSignature(base) !== binding.inputSignature))) throw new Error('Persona changed while the agent was working; request fresh enrichment');
          const proposal = M.proposeEnrichment(base, candidate, { expectedRevision: M.revisionOf(requestedBase) });
          entries.push({ isNew: false, base: clone(base), proposal, candidate });
        }
      }
      if (ids.size !== request.personaIds.length) throw new Error('Return a candidate for every requested persona');
      review = { requestId, entries, createdAt: new Date().toISOString() };
      await chrome.storage.local.set({ [REVIEWS]: review });
      await ask({ kind: 'persona-work-proposed', requestId, proposal: { personas: candidates } });
      await syncWork(); say('Agent persona changes are ready to inspect and approve.');
      return { requestId, status: 'proposed', personaIds: [...ids] };
    }
    root.treadwayCompletePersonaWork = async input => {
      try { return await complete(input); }
      catch (error) {
        say('Agent persona changes were not applied: ' + error.message, 'error');
        workLine.textContent = 'Agent persona changes were not applied: ' + error.message;
        await ask({ kind: 'persona-work-failed', requestId: input.requestId, error: error.message }).catch(() => {});
        await syncWork().catch(() => {});
        throw error;
      }
    };
    root.treadwayAcknowledgePersonaWork = async ({ requestId }) => { const result = await ask({ kind: 'persona-work-ack', requestId }); await syncWork(); return { requestId, status: result.request?.status || 'accepted' }; };
    root.treadwayPersonaWorkStatus = async ({ requestId }) => {
      const response = await ask({ kind: 'persona-work-status' });
      const request = response.request;
      if (!request || request.requestId !== requestId) return { requestId, status: 'unknown' };
      const names = { queued: 'pending', accepted: 'acknowledged', proposed: 'review', completed: 'completed', cancelled: 'cancelled', failed: 'failed' };
      return { requestId, status: names[request.status] || 'unknown', result: request.result, error: request.error };
    };
    function update(status) { currentStatus = status || {}; renderList(); }
    renderList(); syncWork().catch(error => say(error.message, 'error'));
    return { update, reload: renderList, syncWork, complete };
  }
  root.TreadwayPersonaUI = { mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);
