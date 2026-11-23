// Side panel: settings, persona picker, journey controls and saving the
// journey file into the chosen folder.
(function () {
  'use strict';

  const Personas = globalThis.TreadwayPersonas;
  const $ = (id) => document.getElementById(id);
  let personas = [];
  let folder = null;
  let storageMode = 'downloads';
  let status = { journey: null, finished: null };
  let saveQueue = Promise.resolve();
  let saving = false;

  // ---- messages -----------------------------------------------------------
  function say(text, level) {
    const item = document.createElement('li');
    item.textContent = new Date().toLocaleTimeString() + ' ' + text;
    if (level) item.className = level;
    $('messages').prepend(item);
  }

  async function ask(message) {
    const answer = await chrome.runtime.sendMessage(message);
    if (answer && answer.error) throw new Error(answer.error);
    return answer;
  }

  function guarded(action) {
    return async (event) => {
      const button = event && event.currentTarget;
      if (button) button.disabled = true;
      try {
        await action();
      } catch (error) {
        say(error.message, 'error');
      } finally {
        if (button) button.disabled = false;
        await refresh();
      }
    };
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.kind === 'panel-notice') {
      if (message.text) say(message.text, message.level);
      refresh().then(saveUpdatedSnapshot).catch((error) => say(error.message, 'error'));
    }
  });

  // ---- folder (File System Access API, handle kept in IndexedDB) ---------
  function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('treadway-recorder', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('handles');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function storedHandle(handle) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('handles', handle ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('handles');
      const request = handle ? store.put(handle, 'folder') : store.get('folder');
      request.onsuccess = () => resolve(handle || request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  // Permission prompts need a click, so every caller runs from a button.
  async function folderWithPermission() {
    if (!folder) throw new Error('Choose the personas folder in Settings first');
    const options = { mode: 'readwrite' };
    if ((await folder.queryPermission(options)) !== 'granted' && (await folder.requestPermission(options)) !== 'granted') {
      throw new Error('The recorder needs read and write access to the folder ' + folder.name);
    }
    return folder;
  }

  async function loadPersonas() {
    if (storageMode === 'downloads') {
      const { personaText = '' } = await chrome.storage.local.get('personaText');
      if (!personaText.trim()) {
        personas = [];
        renderPersonas();
        return;
      }
      personas = Personas.parsePersonas(personaText);
      renderPersonas();
      return;
    }
    const directory = await folderWithPermission();
    let file;
    try {
      file = await (await directory.getFileHandle('personas.json')).getFile();
    } catch (_) {
      throw new Error('No personas.json in folder ' + directory.name);
    }
    personas = Personas.parsePersonas(await file.text());
    renderPersonas();
    say('Loaded ' + personas.length + ' persona(s) from ' + directory.name + '/personas.json');
  }

  function renderPersonas() {
    const select = $('persona');
    const previous = select.value;
    select.replaceChildren(...personas.map((persona) => {
      const option = document.createElement('option');
      option.value = persona.id;
      option.textContent = persona.label + ' (' + persona.role + ')';
      return option;
    }));
    if (personas.some((persona) => persona.id === previous)) select.value = previous;
  }

  function selectedPersona() {
    const persona = personas.find((candidate) => candidate.id === $('persona').value);
    if (!persona) throw new Error('Load personas and pick one first');
    return persona;
  }

  function saveJourneyFile(record) {
    const operation = saveQueue.then(() => writeJourneyFile(record));
    saveQueue = operation.catch(() => undefined);
    return operation;
  }
  async function writeJourneyFile(record) {
    if (!record) throw new Error('No stopped journey to save');
    saving = true;
    try {
      const latest = await ask({ kind: 'status' });
      // Another queued write may already have saved and closed this run. Never
      // overwrite its newer file with an old snapshot retained by a caller.
      if (!latest.finished || latest.finished.contextFields.run !== record.contextFields.run) return;
      record = latest.finished;
      const name = record.contextFields.run + '.json';
      const text = JSON.stringify(Object.assign({ format: 'treadway-journey-events/2' }, record), null, 2) + '\n';
      let destination;
      if (storageMode === 'downloads') {
        const download = await TreadwayDownloadExport.save(text, record.contextFields.run);
        destination = download.filename;
        $('storage-status').textContent = 'Last saved: ' + destination;
      } else {
        const directory = await folderWithPermission();
        const journeys = await directory.getDirectoryHandle('journeys', { create: true });
        const handle = await journeys.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        destination = directory.name + '/journeys/' + name;
      }
      const result = await ask({ kind: 'saved', run: record.contextFields.run, revision: record.revision });
      say('Saved ' + record.events.length + ' events to ' + destination);
      if (result.pendingRequests) say(result.pendingRequests + ' request(s) still pending; this snapshot will update while the panel is open.');
    } finally { saving = false; }
  }
  async function saveUpdatedSnapshot() {
    const record = status.finished;
    if (!record || saving || record.lastSavedRevision === undefined || record.lastSavedRevision === record.revision) return;
    if (storageMode === 'downloads' || (folder && (await folder.queryPermission({ mode: 'readwrite' })) === 'granted')) {
      await saveJourneyFile(record);
    }
  }

  // ---- settings -------------------------------------------------------------
  async function loadSettings() {
    const { settings = {}, captureStorage, personaText = '' } = await chrome.storage.local.get(['settings', 'captureStorage', 'personaText']);
    // Preserve an existing folder setup. Fresh profiles use the dialog-free mode.
    storageMode = captureStorage === 'folder' || captureStorage === 'downloads' ? captureStorage : folder ? 'folder' : 'downloads';
    $('storage-mode').value = storageMode;
    $('personas-json').value = personaText;
    renderStorageChoice();
    $('safeyolo-key').value = settings.safeyoloKey || '';
    $('jev-key').value = settings.jevKey || '';
    $('ttl-minutes').value = settings.ttlMinutes || 20;
    $('record-secrets').checked = settings.recordSecrets !== false;
    if (!settings.safeyoloKey) $('settings-section').open = true;
  }

  async function saveSettings() {
    const ttlMinutes = Number($('ttl-minutes').value);
    if (!(ttlMinutes >= 1)) throw new Error('Test context timer must be at least 1 minute');
    const captureStorage = $('storage-mode').value;
    const personaText = $('personas-json').value;
    const parsed = captureStorage === 'downloads' ? Personas.parsePersonas(personaText) : null;
    const settings = {
      safeyoloKey: $('safeyolo-key').value.trim(),
      jevKey: $('jev-key').value.trim(),
      ttlMinutes,
      recordSecrets: $('record-secrets').checked,
    };
    await chrome.storage.local.set({ settings, captureStorage, personaText });
    storageMode = captureStorage;
    if (parsed) { personas = parsed; renderPersonas(); }
    else await loadPersonas();
    say('Settings saved');
  }

  // ---- journey ---------------------------------------------------------------
  async function refresh() {
    status = await ask({ kind: 'status' });
    const running = Boolean(status.journey);
    const line = $('status');
    if (running) {
      const journey = status.journey;
      line.textContent = 'Recording "' + journey.journey + '" as ' + journey.persona.label + ' (' + journey.persona.role + '). Context ' +
        journey.context + ', expires ' + new Date(journey.expiresAt).toLocaleTimeString() + '. ' + journey.events.length + ' events.';
      line.className = 'status recording';
    } else {
      line.textContent = status.finished ? 'Journey stopped; ' + status.pendingRequests + ' pending request(s); save the latest snapshot or finish incomplete.' : 'No journey running';
      line.className = 'status idle';
    }
    $('start').disabled = running || Boolean(status.finished) || !personas.length;
    $('stop').disabled = !running;
    const active = running && status.journey.contextStatus === 'active';
    for (const id of ['fill', 'authenticated', 'step', 'step-name', 'step-expected', 'observed-account']) $(id).disabled = !active;
    $('persona').disabled = running;
    $('journey-name').disabled = running;
    $('pending').hidden = !status.finished;
    $('finish-incomplete').hidden = !status.pendingRequests;
  }

  async function start() {
    const persona = selectedPersona();
    const journeyName = $('journey-name').value.trim();
    if (!journeyName) throw new Error('Type a journey name');
    if (storageMode === 'folder') await folderWithPermission();
    const journey = await ask({ kind: 'start', persona, journeyName });
    say('Started. SafeYOLO test context: ' + journey.context);
  }

  async function stop() {
    const { finished, clearError, clearSkipped } = await ask({ kind: 'stop' });
    if (clearError) say('Journey stopped, but SafeYOLO did not clear the context: ' + clearError, 'warning');
    if (clearSkipped) say('Journey stopped; a different declared context was left intact.', 'warning');
    await saveJourneyFile(finished);
  }

  async function fill() {
    const persona = personas.find((candidate) => candidate.id === status.journey.persona.id);
    if (!persona) throw new Error('Persona ' + status.journey.persona.id + ' is no longer in personas.json');
    const report = await ask({ kind: 'fill', values: Personas.personaValues(persona) });
    say('Filled ' + report.filled.length + ' field(s); ' + report.manual.length + ' highlighted for you to fill.');
    for (const entry of report.manual) {
      const where = entry.selectors.role ? entry.selectors.role.name : entry.selectors.css;
      say('Fill "' + where + '" by hand: ' + entry.reason + (entry.type ? ' (' + entry.type + ')' : ''), 'warning');
    }
    if (report.classifyError) say('Jev could not classify fields: ' + report.classifyError, 'warning');
  }

  async function marker(kind) {
    const name = kind === 'step' ? $('step-name').value.trim() : undefined;
    if (kind === 'step' && !name) throw new Error('Type a step name');
    await ask({ kind: 'marker', marker: kind, name,
      expectedOutcome: kind === 'step' ? $('step-expected').value.trim() : undefined,
      observedAccount: kind === 'authenticated' ? $('observed-account').value.trim() : undefined });
    say(kind === 'step' ? 'Step marker: ' + name : 'Marked authenticated');
    if (kind === 'step') $('step-name').value = '';
    if (kind === 'step') $('step-expected').value = '';
  }

  // ---- wiring ------------------------------------------------------------------
  function renderStorageChoice() {
    const folderSelected = $('storage-mode').value === 'folder';
    $('folder-settings').hidden = !folderSelected;
    $('downloads-settings').hidden = folderSelected;
    $('storage-status').textContent = folderSelected ? 'Folder mode uses the native directory picker.' :
      'Files: Treadway/journeys in Chrome\'s Downloads directory.';
  }
  $('storage-mode').addEventListener('change', renderStorageChoice);
  $('example-personas').addEventListener('click', guarded(async () => {
    const response = await fetch('examples/personas.json');
    if (!response.ok) throw new Error('Could not load example personas');
    $('personas-json').value = await response.text();
    say('Example personas loaded into the editor. Edit them and Save settings to use them.');
  }));
  $('choose-folder').addEventListener('click', guarded(async () => {
    folder = await storedHandle(await window.showDirectoryPicker({ id: 'treadway-recorder', mode: 'readwrite' }));
    storageMode = 'folder';
    await chrome.storage.local.set({ captureStorage: storageMode });
    $('folder-name').textContent = folder.name;
    await loadPersonas();
  }));
  $('reload-personas').addEventListener('click', guarded(loadPersonas));
  $('save-settings').addEventListener('click', guarded(saveSettings));
  $('start').addEventListener('click', guarded(start));
  $('stop').addEventListener('click', guarded(stop));
  $('fill').addEventListener('click', guarded(fill));
  $('authenticated').addEventListener('click', guarded(() => marker('authenticated')));
  $('step').addEventListener('click', guarded(() => marker('step')));
  $('save-again').addEventListener('click', guarded(() => saveJourneyFile(status.finished)));
  $('finish-incomplete').addEventListener('click', guarded(async () => {
    const result = await ask({ kind: 'finish-incomplete' });
    await saveJourneyFile(result.finished);
  }));
  $('discard').addEventListener('click', guarded(async () => {
    if (!window.confirm('Discard the stopped journey without saving its events?')) return;
    await ask({ kind: 'discard' });
    say('Discarded the stopped journey');
  }));

  (async () => {
    folder = await storedHandle();
    await loadSettings();
    if (storageMode === 'downloads') await loadPersonas();
    else if (folder) {
      $('folder-name').textContent = folder.name;
      // Reading needs permission; without a click only an already granted handle works.
      if ((await folder.queryPermission({ mode: 'readwrite' })) === 'granted') await loadPersonas().catch((error) => say(error.message, 'error'));
      else say('Click "Reload personas" to give the recorder access to ' + folder.name);
    }
    await refresh();
    setInterval(() => refresh().then(saveUpdatedSnapshot).catch(() => undefined), 5000);
  })().catch((error) => say(error.message, 'error'));
})();
