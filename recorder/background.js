// Owns the recording journal and passive request/flow-store references.
importScripts('lib/fields.js', 'lib/jev.js', 'lib/test-context.js', 'lib/network.js', 'lib/personas.js', 'lib/credentials.js', 'lib/assistance.js');
const Context = globalThis.TreadwayTestContext;
const Jev = globalThis.TreadwayJev;
const Fields = globalThis.TreadwayFields;
const Network = globalThis.TreadwayNetwork;
const DEFAULT_SETTINGS = { safeyoloKey: '', jevKey: '', ttlMinutes: 20, recordSecrets: true };

// Storage updates and context transitions have separate queues: a network response
// may be recorded while an API call runs, but Start/Stop/Renew cannot interleave.
let journalQueue = Promise.resolve();
let transitionQueue = Promise.resolve();
function transition(operation) {
  const next = transitionQueue.then(operation);
  transitionQueue = next.catch(() => undefined);
  return next;
}
function updateJourneys(change) {
  const next = journalQueue.then(async () => {
    const stored = await chrome.storage.session.get(['journey', 'finished', 'requests']);
    const state = { journey: stored.journey || null, finished: stored.finished || null, requests: stored.requests || {} };
    const result = await change(state);
    await chrome.storage.session.set(state);
    return result;
  });
  journalQueue = next.catch(() => undefined);
  return next;
}
async function readSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, (await chrome.storage.local.get('settings')).settings);
}
function appendEvent(journey, event) {
  if (!journey) return null;
  journey.revision = (journey.revision || 0) + 1;
  const entry = Object.assign({ at: new Date().toISOString(), stepId: journey.currentStepId || 'step-0' }, event, {
    eventId: journey.contextFields.run + ':e' + journey.revision, receivedAt: new Date().toISOString(),
  });
  journey.events.push(entry);
  return entry;
}
function notifyPanel(message) {
  chrome.runtime.sendMessage(Object.assign({ kind: 'panel-notice' }, message)).catch(() => undefined);
}
function networkChanged(state, journey) {
  if (state.finished === journey) notifyPanel({ level: 'info', refreshSavedJourney: true });
}
function pendingRequests(state, run) {
  return Object.values(state.requests).filter((request) => request.run === run);
}
async function pageRead(tabId, kind, frameId = 0, extra = {}) {
  const message = { kind, ...extra };
  try { return await chrome.tabs.sendMessage(tabId, message, { frameId }); }
  catch (error) {
    // A known missing receiver means the read never ran. Reattach after an
    // extension update without navigating away from the human's current form.
    if (!/Receiving end does not exist|Could not establish connection/i.test(error.message)) throw error;
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] },
      files: ['lib/fields.js', 'lib/form-runtime.js', 'lib/choice-binding.js', 'lib/page-fill.js', 'content.js'] });
    return chrome.tabs.sendMessage(tabId, message, { frameId });
  }
}
function forExport(state, journey) {
  if (!journey) return null;
  const pending = Object.entries(state.requests).filter(([, request]) => request.run === journey.contextFields.run)
    .map(([id, request]) => ({ chromeRequestId: id, url: request.url, stepId: request.stepId,
      startedAt: request.startedAt, safeyoloRequestId: request.lastResponse ? request.lastResponse.safeyoloRequestId : null }));
  return Object.assign({}, journey, { networkCapture: { pending,
    complete: Boolean(journey.stoppedAt) && pending.length === 0 &&
      !journey.events.some((event) => event.type === 'network_capture_incomplete') } });
}
function journalFor(state, run) {
  return [state.journey, state.finished].find((journey) => journey && journey.contextFields.run === run);
}
async function broadcastRecording(active, recordSecrets) {
  const tabs = await chrome.tabs.query({});
  const results = await Promise.all(tabs.map(async (tab) => {
    // Address every frame separately, so Stop can drain each content script's
    // outstanding event messages instead of receiving one arbitrary frame reply.
    let frames;
    try { frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }); } catch (_) { frames = []; }
    return Promise.all((frames || []).map(async (frame) => {
      try {
        return await pageRead(tab.id, 'recording', frame.frameId, { active, recordSecrets });
      } catch (_) { return { unavailable: true, tabId: tab.id, frameId: frame.frameId }; }
    }));
  }));
  return results.flat();
}
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

function startJourney({ persona, journeyName }) {
  return transition(async () => {
    const settings = await readSettings();
    if (!settings.safeyoloKey) throw new Error('Add the SafeYOLO agent API key in Settings first');
    // This check and the declaration are covered by the SAME transition lock.
    const before = await chrome.storage.session.get(['journey', 'finished']);
    if (before.journey) throw new Error('Stop the current journey first');
    if (before.finished) throw new Error('Save or close the stopped journey first');
    const current = await Context.readContext(fetch, settings.safeyoloKey);
    const startedAt = new Date();
    const context = Context.buildContext({ agent: current.agent, persona, journey: journeyName, startedAt });
    const journey = {
      journey: journeyName, context: context.header, contextFields: context.fields,
      persona: { id: persona.id, role: persona.role, label: persona.label, secrets: persona.secrets },
      startedAt: startedAt.toISOString(), contextStatus: 'declaring', currentStepId: 'step-0',
      nextStep: 0, revision: 0, recordSecrets: settings.recordSecrets, events: [],
    };
    // An uncertain declaration is recoverable with Stop; a second Start never
    // silently overwrites it or retries a potentially applied declaration.
    await updateJourneys((state) => { state.journey = journey; });
    try {
      const declared = await Context.declareContext(fetch, settings.safeyoloKey, context.header, Math.round(settings.ttlMinutes * 60));
      await updateJourneys((state) => {
        state.journey.contextStatus = 'active';
        state.journey.expiresAt = new Date(Date.now() + declared.expires_in * 1000).toISOString();
        appendEvent(state.journey, { type: 'context_declared', context: journey.context, expires_in: declared.expires_in });
      });
    } catch (error) {
      await updateJourneys((state) => {
        state.journey.contextStatus = 'declaration_unconfirmed';
        appendEvent(state.journey, { type: 'context_declare_failed', error: error.message });
      });
      throw error;
    }
    await broadcastRecording(true, journey.recordSecrets);
    return (await chrome.storage.session.get('journey')).journey;
  });
}
function stopJourney() {
  return transition(async () => {
    const settings = await readSettings();
    await updateJourneys((state) => {
      if (!state.journey) throw new Error('No journey is running');
      state.journey.contextStatus = 'stopping';
      state.journey.captureStoppedAt = new Date().toISOString();
    });
    const drains = await broadcastRecording(false, settings.recordSecrets);
    let clearError = null;
    let clearSkipped = null;
    try {
      const current = await Context.readContext(fetch, settings.safeyoloKey);
      const own = (await chrome.storage.session.get('journey')).journey;
      if (Context.sameContext(current.context, own.context)) await Context.clearContext(fetch, settings.safeyoloKey);
      else if (current.context) clearSkipped = 'different_declared_context';
    } catch (error) { clearError = error.message; }
    return updateJourneys((state) => {
      const journey = state.journey;
      appendEvent(journey, { type: 'content_flush', frames: drains });
      appendEvent(journey, clearError ? { type: 'context_clear_failed', error: clearError } :
        clearSkipped ? { type: 'context_clear_skipped', reason: clearSkipped } : { type: 'context_cleared' });
      journey.stoppedAt = new Date().toISOString();
      journey.contextStatus = clearError ? 'clear_unconfirmed' : clearSkipped ? 'not_owned' : 'cleared';
      state.finished = journey;
      state.journey = null;
      return { finished: forExport(state, journey), clearError, clearSkipped,
        pendingRequests: pendingRequests(state, journey.contextFields.run).length };
    });
  });
}

function renewJourneyContext({ expectedRun, after, source = 'operator' } = {}) {
  return transition(async () => {
    const stored = await chrome.storage.session.get('journey');
    const journey = stored.journey;
    if (!journey || journey.contextStatus !== 'active') {
      if (expectedRun) return null;
      throw new Error('Start an active journey before renewing its context');
    }
    const run = journey.contextFields.run;
    if (expectedRun && run !== expectedRun) return null;
    const settings = await readSettings();
    let declarationAttempted = false;
    try {
      const current = await Context.readContext(fetch, settings.safeyoloKey);
      if (current.agent !== journey.contextFields.agent) throw new Error('The API key belongs to a different agent');
      if (current.context && !Context.sameContext(current.context, journey.context)) throw new Error('A different journey owns the declared context; coordinate before renewing');
      declarationAttempted = true;
      const declared = await Context.declareContext(fetch, settings.safeyoloKey, journey.context, Math.round(settings.ttlMinutes * 60));
      await updateJourneys((state) => {
        if (!state.journey || state.journey.contextFields.run !== run) return;
        state.journey.expiresAt = new Date(Date.now() + declared.expires_in * 1000).toISOString();
        state.journey.contextRenewalError = null;
        state.journey.contextRenewalStatus = 'confirmed';
        appendEvent(state.journey, { type: 'context_renewed', source,
          ...(after ? { after } : {}),
          expires_in: declared.expires_in });
      });
      return (await chrome.storage.session.get('journey')).journey;
    } catch (error) {
      await updateJourneys((state) => {
        if (!state.journey || state.journey.contextFields.run !== run) return;
        state.journey.contextRenewalError = error.message;
        state.journey.contextRenewalStatus = declarationAttempted ? 'unconfirmed' : 'failed';
        appendEvent(state.journey, { type: 'context_renew_failed', source, declarationAttempted,
          error: error.message, ...(after ? { after } : {}) });
      });
      throw error;
    }
  });
}

let renewing = null;
function renewAfter428(details, run) {
  if (renewing) return renewing;
  renewing = renewJourneyContext({ expectedRun: run, source: 'proxy_block',
    after: Object.assign({ status: 428 }, Network.metadata(details), Network.flowReference(details.responseHeaders)),
  }).then((journey) => {
    if (journey) notifyPanel({ level: 'warning', text: 'SafeYOLO blocked this request before dispatch; its test context is renewed. Resubmit the blocked action when ready (' + details.method + ' ' + details.url + ').' });
  }).catch((error) => {
      notifyPanel({ level: 'error', text: 'Could not renew the test context: ' + error.message });
  }).finally(() => { renewing = null; });
  return renewing;
}

function recordRequestStart(details) {
  if (details.tabId < 0) return Promise.resolve();
  return updateJourneys((state) => {
    const existing = state.requests[details.requestId];
    if (existing) {
      // Chrome reuses its ID across redirect/authentication legs. Keep the
      // original run/step binding even if the person has moved on.
      existing.legStartedAt = Network.at(details.timeStamp);
      existing.url = details.url;
      existing.lastResponse = null;
      return;
    }
    const journey = state.journey;
    if (!journey || journey.contextStatus !== 'active') return;
    const preceding = [...journey.events].reverse().find((event) =>
      ['click', 'submit', 'field'].includes(event.type) && event.tabId === details.tabId &&
      event.frameId === details.frameId && (!details.documentId || event.documentId === details.documentId));
    const request = {
      run: journey.contextFields.run, stepId: journey.currentStepId,
      startedAt: Network.at(details.timeStamp), legStartedAt: Network.at(details.timeStamp),
      responseIndex: 0, precedingUiEventId: preceding ? preceding.eventId : null,
      url: details.url, tabId: details.tabId, frameId: details.frameId,
    };
    state.requests[details.requestId] = request;
    appendEvent(journey, Object.assign({ type: 'network_request', stepId: request.stepId,
      precedingUiEventId: request.precedingUiEventId, uiAssociation: 'preceding_event_only_not_causality' }, Network.metadata(details)));
  });
}
function recordResponse(state, details, request) {
  const journey = journalFor(state, request.run);
  if (!journey) return null;
  const event = appendEvent(journey, Object.assign({
    type: 'network_response', stepId: request.stepId, requestStartedAt: request.startedAt,
    legStartedAt: request.legStartedAt, responseIndex: ++request.responseIndex,
    status: details.statusCode, fromCache: Boolean(details.fromCache),
    precedingUiEventId: request.precedingUiEventId, uiAssociation: 'preceding_event_only_not_causality',
  }, Network.metadata(details), Network.flowReference(details.responseHeaders)));
  request.lastResponse = { eventId: event.eventId, ...Network.flowReference(details.responseHeaders) };
  networkChanged(state, journey);
  return event;
}
function recordHeaders(details) {
  return updateJourneys((state) => {
    const request = state.requests[details.requestId];
    if (!request) return null;
    const event = recordResponse(state, details, request);
    return event ? request.run : null;
  }).then((run) => {
    if (run && Network.isContextBlock(details)) return renewAfter428(details, run);
  });
}
function recordNetworkEnd(details, failed) {
  if (details.tabId < 0) return Promise.resolve();
  return updateJourneys((state) => {
    const request = state.requests[details.requestId];
    if (!request) return;
    const journey = journalFor(state, request.run);
    if (journey) {
      if (!failed && !request.lastResponse) recordResponse(state, details, request);
      appendEvent(journey, Object.assign({
        type: failed ? 'network_error' : 'network_completed', stepId: request.stepId,
        requestStartedAt: request.startedAt, responseEventId: request.lastResponse ? request.lastResponse.eventId : null,
        safeyoloRequestId: request.lastResponse ? request.lastResponse.safeyoloRequestId : null,
        flowCorrelation: request.lastResponse ? request.lastResponse.flowCorrelation : 'no_response_headers',
        ...(failed ? { error: details.error } : { status: details.statusCode, fromCache: Boolean(details.fromCache) }),
      }, Network.metadata(details)));
      networkChanged(state, journey);
    }
    delete state.requests[details.requestId];
  });
}
function recordRedirect(details) {
  return updateJourneys((state) => {
    const request = state.requests[details.requestId];
    if (!request) return;
    const journey = journalFor(state, request.run);
    if (journey) appendEvent(journey, Object.assign({ type: 'network_redirect', stepId: request.stepId,
      responseEventId: request.lastResponse ? request.lastResponse.eventId : null, redirectUrl: details.redirectUrl,
      status: details.statusCode }, Network.metadata(details)));
    request.lastResponse = null;
  });
}
function listen(event, handler, extra) {
  event.addListener((details) => {
    handler(details).catch((error) => notifyPanel({ level: 'error', text: 'Recording journal: ' + error.message }));
  }, { urls: ['<all_urls>'] }, ...(extra ? [extra] : []));
}
listen(chrome.webRequest.onBeforeRequest, recordRequestStart);
listen(chrome.webRequest.onHeadersReceived, recordHeaders, ['responseHeaders']);
listen(chrome.webRequest.onBeforeRedirect, recordRedirect);
listen(chrome.webRequest.onCompleted, (details) => recordNetworkEnd(details, false), ['responseHeaders']);
listen(chrome.webRequest.onErrorOccurred, (details) => recordNetworkEnd(details, true));
function navigation(how, details) {
  return updateJourneys((state) => {
    if (state.journey && state.journey.contextStatus === 'active') appendEvent(state.journey, {
      type: 'navigation', how, at: Network.at(details.timeStamp), url: details.url,
      tabId: details.tabId, frameId: details.frameId, documentId: details.documentId,
    });
  });
}
for (const [event, how] of [[chrome.webNavigation.onHistoryStateUpdated, 'history_state_updated'],
  [chrome.webNavigation.onReferenceFragmentUpdated, 'fragment_updated'], [chrome.webNavigation.onCommitted, 'committed']]) {
  event.addListener((details) => { navigation(how, details).catch(() => undefined); });
}

async function classifyFields(fields) {
  const { journey } = await chrome.storage.session.get('journey');
  if (!journey || journey.contextStatus !== 'active') return {};
  const settings = await readSettings();
  if (!settings.jevKey) return {};
  const stored = await chrome.storage.session.get(['personaFieldTypes', 'personaFieldSources']);
  const choices = {};
  for (const type of [...(stored.personaFieldTypes || Object.keys(Fields.FIELD_TYPES)), ...Fields.SECRET_TYPES]) {
    if (stored.personaFieldSources?.[type]?.derivedFrom && stored.personaFieldTypes?.includes(stored.personaFieldSources[type].derivedFrom)) continue;
    choices[type] = Fields.FIELD_TYPES[type] || type.replace(/_/g, ' ');
  }
  return Jev.classifyWithJev({ apiKey: settings.jevKey, fields, choices, fetch });
}
async function fillActiveTab({ values, persona, assistanceId }) {
  if (assistanceId) await checkAssistance(assistanceId);
  const journey = (await chrome.storage.session.get('journey')).journey;
  if (!journey || journey.contextStatus !== 'active') throw new Error('Start a journey before filling');
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab');
  let prepared = null;
  if (persona) {
    persona = TreadwayPersonas.parsePersonas(JSON.stringify({ personas: [persona] }))[0];
    if (persona.id !== journey.persona.id || persona.role !== journey.persona.role) throw new Error('Fill persona does not match this journey');
    const needs = await pageRead(tab.id, 'inspect-fill');
    if (!needs) throw new Error('The page did not answer the fill inspection');
    prepared = await TreadwayCredentials.prepare({ persona, ...needs, crypto,
      read: async () => (await chrome.storage.local.get('personaCredentials')).personaCredentials,
      write: async all => chrome.storage.local.set({ personaCredentials: all }),
    });
    values = TreadwayPersonas.personaValues(prepared.persona);
    await updateJourneys(state => {
      const current = state.journey;
      if (!current || current.contextFields.run !== journey.contextFields.run) return;
      const changed = Object.entries(prepared.persona.secrets).some(([key, value]) => current.persona.secrets[key] !== value);
      if (prepared.generated || changed) {
        current.persona.secrets = Object.assign({}, current.persona.secrets, prepared.persona.secrets);
        appendEvent(current, { type: 'credential_prepared', source: 'extension', generated: prepared.generated,
          secretReferences: prepared.persona.secrets, storage: 'private_persona_profile' });
      }
    });
    const current = (await chrome.storage.session.get('journey')).journey;
    if (!current || current.contextFields.run !== journey.contextFields.run || current.contextStatus !== 'active') {
      throw new Error('Recording stopped before filling');
    }
  }
  await chrome.storage.session.set({ personaFieldTypes: Object.keys(values), personaFieldSources:
    Object.fromEntries(Object.entries(values).map(([type, entry]) => [type, { derivedFrom: entry.derivedFrom || null }])) });
  if (assistanceId) await checkAssistance(assistanceId);
  const answer = await chrome.tabs.sendMessage(tab.id, { kind: 'fill', values }, { frameId: 0 });
  if (!answer) throw new Error('The page did not answer; reload it so the recorder can attach');
  if (answer.error) throw new Error(answer.error);
  // The content script journals the result with Chrome's actual sender frame
  // and document identity BEFORE it answers, including partial/error reports.
  return Object.assign({}, answer.report, prepared ? { preparedPersona: prepared.persona, generatedPassword: prepared.generated } : {});
}
async function checkAssistance(id) {
  const { pendingAssistance: pending, journey } = await chrome.storage.session.get(['pendingAssistance', 'journey']);
  if (!pending || pending.requestId !== id || pending.completed || !journey ||
    journey.contextStatus !== 'active' || journey.contextFields.run !== pending.run) throw new Error('Assistance request is no longer active');
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id !== pending.target.tabId) throw new Error('Return to the requested application tab before applying assistance');
  const current = await pageRead(tab.id, 'inspect-assistance');
  const bindings = fields => JSON.stringify(fields.map(item => {
    const { tag, inputType, name, id, label, autocomplete } = item.field;
    return { tag, inputType, name, id, label, autocomplete };
  }));
  if (current?.url !== pending.target.url || current.documentInstanceId !== pending.target.documentInstanceId ||
    bindings(current.fields) !== bindings(pending.form)) {
    throw new Error('The requested form changed; request assistance again');
  }
  return pending;
}
function withSecretReference(journey, event) {
  if (event.type === 'fill') {
    const clean = entries => (entries || []).map(entry => {
      if (!entry.secret && !Fields.SECRET_TYPES.has(entry.type)) return entry;
      const result = Object.assign({}, entry, { secret: true,
        secretReference: entry.secretReference || journey.persona.secrets[entry.type] || journey.persona.id + ':' + entry.type });
      if (!journey.recordSecrets) {
        for (const key of ['value', 'expectedValue', 'observedValue']) delete result[key];
        result.redacted = true;
      }
      return result;
    });
    return Object.assign({}, event, { filled: clean(event.filled), manual: clean(event.manual), skipped: clean(event.skipped) });
  }
  if (event.type !== 'field') return event;
  if (event.secret || event.redacted) {
    const reference = journey.persona.secrets[event.fieldType];
    const result = Object.assign({}, event, reference ? { secretReference: reference } : {});
    if (!journey.recordSecrets) { delete result.value; result.redacted = true; }
    return result;
  }
  return event;
}
const handlers = {
  'recording?': async () => {
    const journey = (await chrome.storage.session.get('journey')).journey;
    return { active: Boolean(journey && journey.contextStatus === 'active'), recordSecrets: journey ? journey.recordSecrets : false };
  },
  'page-event': (message, sender) => updateJourneys((state) => {
    const journey = state.journey;
    if (!journey || !['active', 'stopping'].includes(journey.contextStatus)) return;
    appendEvent(journey, Object.assign({}, withSecretReference(journey, message.event), {
      tabId: sender.tab && sender.tab.id, frameId: sender.frameId, documentId: sender.documentId,
    }));
  }),
  status: async () => {
    await journalQueue;
    const state = await chrome.storage.session.get(['journey', 'finished', 'requests']);
    state.requests = state.requests || {};
    const journey = state.journey || state.finished;
    return { journey: forExport(state, state.journey), finished: forExport(state, state.finished),
      pendingRequests: journey ? pendingRequests(state, journey.contextFields.run).length : 0 };
  },
  start: (message) => startJourney(message),
  'renew-context': () => renewJourneyContext(),
  stop: () => stopJourney(),
  marker: async (message) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const frames = tab ? await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []) : [];
    const frame = (frames || []).find((candidate) => candidate.frameId === 0);
    return updateJourneys((state) => {
      const journey = state.journey;
      if (!journey || journey.contextStatus !== 'active') throw new Error('Start a journey before adding markers');
      if (message.marker === 'step') journey.currentStepId = 'step-' + (++journey.nextStep);
      appendEvent(journey, { type: 'marker', marker: message.marker, name: message.name || undefined,
        expectedOutcome: message.expectedOutcome || undefined, source: 'operator_annotation' });
      Object.assign(journey.events[journey.events.length - 1], { tabId: tab && tab.id, frameId: 0,
        documentId: frame && frame.documentId, url: tab && tab.url,
        observedAccount: message.observedAccount || undefined });
    });
  },
  fill: (message) => fillActiveTab(message),
  'assistance-request': async ({ persona }) => {
    const { journey, pendingAssistance } = await chrome.storage.session.get(['journey', 'pendingAssistance']);
    if (!journey || journey.contextStatus !== 'active') throw new Error('Start a journey before asking for help');
    if (persona.id !== journey.persona.id || persona.role !== journey.persona.role) throw new Error('Assistance persona does not match this journey');
    if (pendingAssistance && !pendingAssistance.completed && pendingAssistance.run === journey.contextFields.run) {
      try { await checkAssistance(pendingAssistance.requestId); return pendingAssistance; }
      catch (_) { /* A fresh click may replace an obsolete document request. */ }
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error('No active application tab');
    const snapshot = await pageRead(tab.id, 'inspect-assistance');
    if (!snapshot?.documentInstanceId) throw new Error('The page did not answer the assistance inspection');
    const request = TreadwayAssistance.request({ id: 'assist-' + crypto.randomUUID(), journey, persona, target: tab,
      snapshot, extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version });
    await chrome.storage.session.set({ pendingAssistance: request });
    await updateJourneys(state => appendEvent(state.journey, { type: 'assistance_requested', requestId: request.requestId,
      tabId: tab.id, url: snapshot.url, documentInstanceId: snapshot.documentInstanceId }));
    return request;
  },
  'assistance-check': ({ requestId }) => checkAssistance(requestId),
  'assistance-finished': async ({ requestId, filled, manual }) => {
    const { pendingAssistance } = await chrome.storage.session.get('pendingAssistance');
    if (!pendingAssistance || pendingAssistance.requestId !== requestId) throw new Error('Unknown assistance request');
    await chrome.storage.session.set({ pendingAssistance: { ...pendingAssistance, completed: true } });
    await updateJourneys(state => {
      if (state.journey?.contextFields.run === pendingAssistance.run) appendEvent(state.journey,
        { type: 'assistance_completed', requestId, filled, manual });
    });
  },
  classify: async (message) => ({ types: await classifyFields(message.fields) }),
  decide: async (message) => {
    const { journey } = await chrome.storage.session.get('journey');
    if (!journey || journey.contextStatus !== 'active') return { decisions: {} };
    const settings = await readSettings();
    if (!settings.jevKey) return { decisions: {} };
    return { decisions: await Jev.decideWithJev({ apiKey: settings.jevKey, jobs: message.jobs, fetch }) };
  },
  'fill-progress': (message) => {
    const phases = { classify: 'Matching persona fields', inspect: 'Reading available choices',
      decide: 'Matching choices with Jev', apply: 'Applying and checking values', done: 'Fill complete' };
    if (phases[message.phase]) notifyPanel({ fillProgress: phases[message.phase], count: Number(message.count) || 0 });
  },
  saved: (message) => updateJourneys((state) => {
    const finished = state.finished;
    if (!finished || message.run !== finished.contextFields.run) return { pendingRequests: 0 };
    const pending = pendingRequests(state, finished.contextFields.run);
    finished.lastSavedRevision = message.revision;
    if (!pending.length && message.revision === finished.revision) state.finished = null;
    return { pendingRequests: pending.length, newerEvents: message.revision !== finished.revision };
  }),
  'finish-incomplete': () => updateJourneys((state) => {
    if (!state.finished) throw new Error('No stopped journey');
    const pending = pendingRequests(state, state.finished.contextFields.run);
    for (const request of pending) {
      const id = Object.keys(state.requests).find((key) => state.requests[key] === request);
      appendEvent(state.finished, { type: 'network_capture_incomplete', chromeRequestId: id,
        stepId: request.stepId, url: request.url, requestStartedAt: request.startedAt,
        safeyoloRequestId: request.lastResponse ? request.lastResponse.safeyoloRequestId : null,
        reason: 'operator_finished_before_network_outcome' });
      delete state.requests[id];
    }
    return { finished: forExport(state, state.finished) };
  }),
  discard: () => updateJourneys((state) => {
    if (state.finished) {
      const run = state.finished.contextFields.run;
      for (const [id, request] of Object.entries(state.requests)) if (request.run === run) delete state.requests[id];
    }
    state.finished = null;
  }),
};
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const handler = handlers[message.kind];
  if (!handler) return false;
  Promise.resolve().then(() => handler(message, sender))
    .then((result) => reply(result === undefined ? { ok: true } : result))
    .catch((error) => reply({ error: error.message }));
  return true;
});
