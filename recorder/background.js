// Owns the recording journal and passive request/flow-store references.
importScripts('lib/fields.js', 'lib/personas.js', 'lib/persona-manager.js', 'lib/persona-work.js', 'lib/jev.js', 'lib/test-context.js', 'lib/safeyolo.js', 'lib/network.js', 'lib/credentials.js', 'lib/assistance.js', 'lib/journal-stream.js');
importScripts('lib/schema-validator.js', 'lib/inference.js');
const Context = globalThis.TreadwayTestContext;
const Jev = globalThis.TreadwayJev;
const Fields = globalThis.TreadwayFields;
const Network = globalThis.TreadwayNetwork;
const DEFAULT_SETTINGS = { safeyoloKey: '', safeyoloMode: 'auto', jevKey: '', ttlMinutes: 20, recordSecrets: true,
  llmProvider: 'openai', llmModel: 'gpt-6-luna', llmKey: '', llmBaseURL: '', llmTimeoutMs: 30000 };
const RENEW_ALARM = 'treadway-context-renew';
const inferenceRequests = new Map();
const exportKeys = new Set();

// Storage updates and context transitions have separate queues: a network response
// may be recorded while an API call runs, but Start/Stop/Renew cannot interleave.
let journalQueue = Promise.resolve();
let transitionQueue = Promise.resolve();
let fillInProgress = null;
let completionInProgress = null;
let personaEditLease = null;
let personaWorkQueue = Promise.resolve();
function personaWorkTransition(action) {
  const next = personaWorkQueue.then(action); personaWorkQueue = next.catch(() => undefined); return next;
}
function assertNoPersonaEdit() {
  if (personaEditLease && personaEditLease.expiresAt > Date.now()) throw new Error('Finish the persona edit before filling');
  personaEditLease = null;
}
async function personaWorkCheck(requestId) {
  const { pendingPersonaWork: request } = await chrome.storage.local.get('pendingPersonaWork');
  if (!request || request.requestId !== requestId || TreadwayPersonaWork.terminal(request)) throw new Error('Persona request is cancelled, completed or no longer current');
  return request;
}
function workState(requestId, status, extra = {}) {
  return personaWorkTransition(async () => {
    const request = await personaWorkCheck(requestId);
    const allowed = { queued: ['accepted', 'proposed', 'cancelled', 'failed'],
      accepted: ['accepted', 'proposed', 'cancelled', 'failed'], proposed: ['proposed', 'completed', 'cancelled', 'failed'] };
    if (!allowed[request.status]?.includes(status)) throw new Error('Persona work transition is no longer valid');
    const next = { ...request, ...extra, status, updatedAt: new Date().toISOString() };
    await chrome.storage.local.set({ pendingPersonaWork: next }); notifyPanel({ refreshPersonaWork: true }); return { request: next };
  });
}
function assertNoConfiguredKeys(value, settings) {
  const keys = [settings.safeyoloKey, settings.jevKey, settings.llmKey].filter(Boolean);
  const contains = item => typeof item === 'string' ? keys.some(key => item.includes(key)) :
    item && typeof item === 'object' && Object.entries(item).some(([key, child]) => contains(key) || contains(child));
  if (contains(value)) throw new Error('Persona context contains a configured API credential; remove it before using the recorder');
}
function transition(operation) {
  const next = transitionQueue.then(operation);
  transitionQueue = next.catch(() => undefined);
  return next;
}
function updateJourneys(change) {
  const next = journalQueue.then(async () => {
    const stored = await chrome.storage.session.get(['journey', 'finished', 'requests', 'journalArchive', 'journalEvictions']);
    const state = { journey: stored.journey || null, finished: stored.finished || null, requests: stored.requests || {}, journalArchive: stored.journalArchive || [], journalEvictions: stored.journalEvictions || [] };
    const previous = state.finished;
    const result = await change(state);
    if (previous && previous !== state.finished) {
      const outcome = previous.lastSavedRevision === previous.revision ? 'saved' : 'discarded';
      const retained = TreadwayJournalStream.retain(state.journalArchive, forExport(state, previous), outcome);
      state.journalArchive = retained.archive;
      state.journalEvictions = [...state.journalEvictions, ...retained.evicted].slice(-100);
    }
    try { await chrome.storage.session.set(state); }
    catch (error) {
      if (!state.journalArchive.length || !/quota|storage.*limit/i.test(error.message)) throw error;
      // Optional catch-up retention must not prevent saving the main capture.
      state.journalEvictions = [...state.journalEvictions, ...state.journalArchive.map(item => ({
        run: item.record.contextFields.run, revision: item.record.revision, reason: 'archive_storage_quota' }))].slice(-100);
      state.journalArchive = [];
      await chrome.storage.session.set(state);
    }
    return result;
  });
  journalQueue = next.catch(() => undefined);
  return next;
}
async function readSettings() {
  const settings = Object.assign({}, DEFAULT_SETTINGS, (await chrome.storage.local.get('settings')).settings);
  for (const key of [settings.safeyoloKey, settings.jevKey, settings.llmKey]) if (key) exportKeys.add(key);
  return settings;
}
function appendEvent(journey, event) {
  if (!journey) return null;
  journey.revision = (journey.revision || 0) + 1;
  const entry = TreadwayJournalStream.scrub(Object.assign({ at: new Date().toISOString(), stepId: journey.currentStepId || 'step-0' }, event, {
    eventId: journey.contextFields.run + ':e' + journey.revision, receivedAt: new Date().toISOString(),
  }), [...exportKeys]);
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
  const requests = journey.events.filter(event => event.type === 'network_response').map(event => ({
    eventId: event.eventId, chromeRequestId: event.chromeRequestId,
    safeyoloRequestId: event.safeyoloRequestId || null, flowCorrelation: event.flowCorrelation || 'missing_header' }));
  const lastFill = [...journey.events].reverse().find(event => event.type === 'fill');
  const lastFillError = [...journey.events].reverse().find(event => event.type === 'fill_error');
  const handoff = { schema: 'treadway.handoff/1', run: journey.contextFields.run, title: journey.journey,
    persona: journey.persona, personaRevisions: (journey.personaRevisions || []).map(({ revision, inputSignature }) => ({ revision, inputSignature })),
    builds: journey.builds, requests,
    fillObservation: lastFill ? { eventId: lastFill.eventId, execution: lastFill.execution, blocked: lastFill.blocked } : null,
    fillError: lastFillError ? { eventId: lastFillError.eventId, error: lastFillError.error } : null,
    unresolved: (lastFill?.manual || []).map(({ binding, field, reason, required }) => ({ binding, field, reason, required })),
    expectedOutcomes: journey.events.filter(event => event.type === 'marker' && event.expectedOutcome)
      .map(({ eventId, stepId, expectedOutcome }) => ({ eventId, stepId, expectedOutcome })),
    requestBodies: journey.safeyolo?.enabled === false ? 'not_captured_by_recorder' : 'retrieve_by_exact_safeyolo_request_id_and_check_retention' };
  return TreadwayJournalStream.scrub(Object.assign({}, journey, { handoff, networkCapture: { pending,
    complete: Boolean(journey.stoppedAt) && pending.length === 0 &&
      !journey.events.some((event) => event.type === 'network_capture_incomplete') } }), [...exportKeys]);
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
    persona = TreadwayPersonas.parsePersonas(JSON.stringify({ personas: [persona] }))[0];
    const settings = await readSettings();
    assertNoConfiguredKeys(persona, settings);
    // This check and the declaration are covered by the SAME transition lock.
    const before = await chrome.storage.session.get(['journey', 'finished']);
    if (before.journey) throw new Error('Stop the current journey first');
    if (before.finished) throw new Error('Save or close the stopped journey first');
    const integration = await TreadwaySafeyolo.connect(settings);
    const current = integration.current || { agent: 'standalone' };
    if (integration.enabled && current.context) throw new Error('Another declared context is active; finish it before starting a recording');
    const startedAt = new Date();
    const context = Context.buildContext({ agent: current.agent, persona, journey: journeyName, startedAt });
    const journey = {
      journey: journeyName, context: integration.enabled ? context.header : null, contextFields: context.fields,
      safeyolo: { enabled: integration.enabled, mode: integration.mode },
      builds: { extension: chrome.runtime.getManifest().version },
      persona: { id: persona.id, role: persona.role, label: persona.label, secrets: persona.secrets,
        revision: TreadwayPersonaManager.revisionOf(persona) },
      personaRevisions: [{ revision: TreadwayPersonaManager.revisionOf(persona),
        inputSignature: TreadwayPersonaManager.inputSignature(persona), profile: TreadwayPersonaManager.semanticContext(persona) }],
      startedAt: startedAt.toISOString(), contextStatus: 'declaring', currentStepId: 'step-0',
      nextStep: 0, revision: 0, recordSecrets: settings.recordSecrets, events: [],
    };
    // An uncertain declaration is recoverable with Stop; a second Start never
    // silently overwrites it or retries a potentially applied declaration.
    await updateJourneys((state) => { state.journey = journey; });
    try {
      const declared = integration.enabled ? await Context.declareContext(integration.request, settings.safeyoloKey, context.header, Math.round(settings.ttlMinutes * 60)) : null;
      await updateJourneys((state) => {
        state.journey.contextStatus = 'active';
        if (declared) state.journey.expiresAt = new Date(Date.now() + declared.expires_in * 1000).toISOString();
        appendEvent(state.journey, declared ? { type: 'context_declared', context: journey.context, expires_in: declared.expires_in } :
          { type: 'recording_started', integration: 'standalone' });
      });
    } catch (error) {
      await updateJourneys((state) => {
        state.journey.contextStatus = 'declaration_unconfirmed';
        appendEvent(state.journey, { type: 'context_declare_failed', error: error.message });
      });
      throw error;
    }
    await broadcastRecording(true, journey.recordSecrets);
    await scheduleRenewal();
    return (await chrome.storage.session.get('journey')).journey;
  });
}
function stopJourney() {
  // Cancel pending inference immediately, before a transition waiting on a
  // renewal can delay the content-script drain.
  for (const controller of inferenceRequests.values()) controller.abort();
  if (completionInProgress) completionInProgress.cancelled = true;
  if (fillInProgress) {
    fillInProgress.cancelled = true;
    pageRead(fillInProgress.tabId, 'cancel-fill').catch(() => undefined);
  }
  return transition(async () => {
    if (chrome.alarms) await chrome.alarms.clear(RENEW_ALARM);
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
      const own = (await chrome.storage.session.get('journey')).journey;
      if (own.safeyolo?.enabled !== false) {
        const request = TreadwaySafeyolo.requestFor(own);
        const current = await Context.readContext(request, settings.safeyoloKey);
        if (Context.sameContext(current.context, own.context)) await Context.clearContext(request, settings.safeyoloKey);
        else if (current.context) clearSkipped = 'different_declared_context';
      }
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
    if (!journey || journey.contextStatus !== 'active' || journey.safeyolo?.enabled === false) {
      if (expectedRun) return null;
      throw new Error('Start an active journey before renewing its context');
    }
    const run = journey.contextFields.run;
    if (expectedRun && run !== expectedRun) return null;
    const settings = await readSettings();
    let declarationAttempted = false;
    try {
      const request = TreadwaySafeyolo.requestFor(journey);
      const current = await Context.readContext(request, settings.safeyoloKey);
      if (current.agent !== journey.contextFields.agent) throw new Error('The API key belongs to a different agent');
      if (current.context && !Context.sameContext(current.context, journey.context)) throw new Error('A different journey owns the declared context; coordinate before renewing');
      declarationAttempted = true;
      const declared = await Context.declareContext(request, settings.safeyoloKey, journey.context, Math.round(settings.ttlMinutes * 60));
      await updateJourneys((state) => {
        if (!state.journey || state.journey.contextFields.run !== run) return;
        state.journey.expiresAt = new Date(Date.now() + declared.expires_in * 1000).toISOString();
        state.journey.contextRenewalError = null;
        state.journey.contextRenewalStatus = 'confirmed';
        appendEvent(state.journey, { type: 'context_renewed', source,
          ...(after ? { after } : {}),
          expires_in: declared.expires_in });
      });
      await scheduleRenewal();
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

async function scheduleRenewal() {
  if (!chrome.alarms) return;
  const { journey } = await chrome.storage.session.get('journey');
  if (!journey || journey.contextStatus !== 'active' || !journey.safeyolo?.enabled ||
      ['failed', 'unconfirmed'].includes(journey.contextRenewalStatus)) {
    await chrome.alarms.clear(RENEW_ALARM); return;
  }
  const expiry = Date.parse(journey.expiresAt);
  if (!Number.isFinite(expiry)) return;
  // Renew halfway through the remaining granted lease, never from a UI timer.
  await chrome.alarms.create(RENEW_ALARM, { when: Math.max(Date.now() + 1000, Date.now() + (expiry - Date.now()) / 2) });
}
if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== RENEW_ALARM) return;
    chrome.storage.session.get('journey').then(({ journey }) => journey && renewJourneyContext({ expectedRun: journey.contextFields.run, source: 'automatic' }))
      .catch(() => notifyPanel({ level: 'error', text: 'Automatic context renewal failed. Check the recording before continuing.' }));
  });
  // The stored recording owns renewal after service-worker suspension. Do not
  // revive a stopped recording or replace a different declared context.
  scheduleRenewal().catch(() => undefined);
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
      url: details.url, tabId: details.tabId, frameId: details.frameId, resourceType: details.type,
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
  assertNoConfiguredKeys(fields, settings);
  const stored = await chrome.storage.session.get(['personaFieldTypes', 'personaFieldSources']);
  const choices = {};
  for (const type of [...(stored.personaFieldTypes || Object.keys(Fields.FIELD_TYPES)), ...Fields.SECRET_TYPES]) {
    if (stored.personaFieldSources?.[type]?.derivedFrom && stored.personaFieldTypes?.includes(stored.personaFieldSources[type].derivedFrom)) continue;
    choices[type] = Fields.FIELD_TYPES[type] || type.replace(/_/g, ' ');
  }
  return Jev.classifyWithJev({ apiKey: settings.jevKey, fields, choices, fetch });
}
async function fillActiveTab(message) {
  if (fillInProgress || completionInProgress) throw new Error('A fill is already running');
  assertNoPersonaEdit();
  const fill = { token: crypto.randomUUID() }; fillInProgress = fill;
  try { return await performFillActiveTab(message, fill); }
  finally { if (fillInProgress === fill) fillInProgress = null; }
}
async function performFillActiveTab({ values, persona, assistanceId, boundValues, historyBindings, previousReport,
  expectedDocumentInstanceId, expectedUrl, expectedFormContext }, fill) {
  if (assistanceId) await checkAssistance(assistanceId);
  const journey = (await chrome.storage.session.get('journey')).journey;
  if (!journey || journey.contextStatus !== 'active') throw new Error('Start a journey before filling');
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab');
  Object.assign(fill, { tabId: tab.id, run: journey.contextFields.run });
  let prepared = null;
  const settings = await readSettings();
  if (persona) {
    persona = TreadwayPersonas.parsePersonas(JSON.stringify({ personas: [persona] }))[0];
    assertNoConfiguredKeys(persona, settings);
    if (persona.id !== journey.persona.id || persona.role !== journey.persona.role) throw new Error('Fill persona does not match this journey');
    const needs = await pageRead(tab.id, 'inspect-fill');
    if (!needs) throw new Error('The page did not answer the fill inspection');
    prepared = await TreadwayCredentials.prepare({ persona, ...needs, crypto,
      read: async () => (await chrome.storage.local.get('personaCredentials')).personaCredentials,
      write: async all => chrome.storage.local.set({ personaCredentials: all }),
    });
    assertNoConfiguredKeys(prepared.persona, settings);
    values = TreadwayPersonas.personaValues(prepared.persona);
    assertNoConfiguredKeys(values, settings);
    Object.assign(fill, { profile: TreadwayPersonaManager.semanticContext(prepared.persona),
      personaRevision: TreadwayPersonaManager.revisionOf(prepared.persona) });
    await updateJourneys(state => {
      const current = state.journey;
      if (!current || current.contextFields.run !== journey.contextFields.run) return;
      const changed = Object.entries(prepared.persona.secrets).some(([key, value]) => current.persona.secrets[key] !== value);
      const signature = TreadwayPersonaManager.inputSignature(prepared.persona);
      current.personaRevisions ||= [];
      if (!current.personaRevisions.some(item => item.revision === fill.personaRevision && item.inputSignature === signature)) {
        current.personaRevisions.push({ revision: fill.personaRevision, inputSignature: signature, profile: fill.profile });
        appendEvent(current, { type: 'persona_revision', personaId: persona.id, personaRevision: fill.personaRevision, inputSignature: signature });
      }
      current.persona.revision = fill.personaRevision;
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
  assertNoConfiguredKeys(values, settings);
  await chrome.storage.session.set({ personaFieldTypes: Object.keys(values), personaFieldSources:
    Object.fromEntries(Object.entries(values).map(([type, entry]) => [type, { derivedFrom: entry.derivedFrom || null }])) });
  if (assistanceId) await checkAssistance(assistanceId);
  const answer = await chrome.tabs.sendMessage(tab.id, { kind: 'fill', values, fillToken: fill.token,
    boundValues, historyBindings, previousReport, expectedDocumentInstanceId, expectedUrl, expectedFormContext,
    ...(prepared ? { profile: { context: fill.profile, revision: fill.personaRevision,
      deductions: TreadwayPersonaManager.usableDeductions(prepared.persona) } } : {}) }, { frameId: 0 });
  if (!answer) throw new Error('The page did not answer; reload it so the recorder can attach');
  if (answer.error) throw new Error(answer.error);
  const current = (await chrome.storage.session.get('journey')).journey;
  if (prepared && !answer.report.interrupted && current?.contextFields.run === fill.run && current.contextStatus === 'active') {
    prepared.persona = TreadwayPersonaManager.recordDeductions(prepared.persona, answer.report.deductions || [], { expectedRevision: fill.personaRevision });
  }
  // The content script journals the result with Chrome's actual sender frame
  // and document identity BEFORE it answers, including partial/error reports.
  return Object.assign({}, answer.report, { documentInstanceId: answer.documentInstanceId, url: answer.url, formContext: answer.formContext },
    prepared ? { preparedPersona: prepared.persona, generatedPassword: prepared.generated } : {});
}

async function runInference({ requestId, schema, messages, purpose }) {
  if (typeof requestId !== 'string' || !requestId || inferenceRequests.has(requestId)) throw new Error('Inference request ID is missing or already active');
  const controller = new AbortController(); inferenceRequests.set(requestId, controller);
  try {
    const settings = await readSettings();
    assertNoConfiguredKeys({ schema, messages }, settings);
    if (!globalThis.TreadwayInference) throw new Error('Structured inference is not available in this build');
    const data = await TreadwayInference.infer({ settings, schema, messages, signal: controller.signal });
    if (controller.signal.aborted) throw new Error('Inference cancelled');
    assertNoConfiguredKeys(data, settings);
    return { data };
  } finally { inferenceRequests.delete(requestId); }
}

async function completeFill(message) {
  if (fillInProgress || completionInProgress) throw new Error('A fill is already running');
  const pending = { requestId: message.requestId }; completionInProgress = pending;
  try { return await prepareMissingFill(message); }
  finally { if (completionInProgress === pending) completionInProgress = null; }
}
async function prepareMissingFill({ requestId, persona, report }) {
  assertNoPersonaEdit();
  if (fillInProgress) throw new Error('Wait for the current fill to finish');
  const { journey } = await chrome.storage.session.get('journey');
  if (!journey || journey.contextStatus !== 'active') throw new Error('Start a journey before completing missing fields');
  persona = TreadwayPersonas.parsePersonas(JSON.stringify({ personas: [persona] }))[0];
  if (persona.id !== journey.persona.id || persona.role !== journey.persona.role) throw new Error('Persona does not match the recording');
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active application tab');
  const before = await pageRead(tab.id, 'inspect-assistance');
  if (!before?.documentInstanceId || !Array.isArray(before.fields)) throw new Error('The page did not answer the form inspection');
  const dataReasons = ['no persona value', 'unclassified', 'profile lookup needs a sourced query', 'option match not confirmed'];
  const blocking = report?.blocked?.binding && (report.manual || []).find(entry => JSON.stringify(entry.binding) === JSON.stringify(report.blocked.binding));
  if (report?.interrupted || blocking && !dataReasons.includes(blocking.reason)) return { persona, boundValues: [], skipped: true };
  // The executor stops at required gaps. Prepare independent missing text facts
  // together without applying later inputs ahead of the blocked prerequisite.
  const manual = [...(report?.manual || [])];
  const values = TreadwayPersonas.personaValues(persona);
  const independent = before.fields.filter(live => live.required && !live.hasValue && !live.disabled && !live.secret &&
    ['input', 'textarea'].includes(live.field.tag) && live.role !== 'combobox' &&
    !['radio', 'checkbox', 'file', 'hidden'].includes(live.field.inputType) &&
    !manual.some(entry => JSON.stringify(entry.binding) === JSON.stringify(live.binding)));
  const unknown = independent.filter(live => !Fields.ruleType(live.field)?.type || !values[Fields.ruleType(live.field)?.type]);
  const matched = unknown.length ? await classifyFields(unknown.map((live, index) => ({ ...live.field, key: 'pending_' + index }))) : {};
  if (completionInProgress?.cancelled || (await chrome.storage.session.get('journey')).journey?.contextFields.run !== journey.contextFields.run) throw new Error('Fill completion cancelled');
  for (const live of independent) {
    const index = unknown.indexOf(live);
    const type = matched['pending_' + index]?.type || Fields.ruleType(live.field)?.type;
    if (!values[type]) manual.push({ binding: live.binding, field: live.field, type, reason: 'no persona value' });
  }
  const gaps = manual.filter(entry => dataReasons.includes(entry.reason))
    .map(entry => ({ entry, live: before.fields?.find(field => JSON.stringify(field.binding) === JSON.stringify(entry.binding)) }))
    .filter(({ entry, live }) => live?.required && !live.hasValue && !live.disabled && !live.secret &&
      !/password|secret|token|one.?time|otp|api.?key|email|phone|username|consent|declaration|attest/i.test([entry.type, live.field.label, live.field.name].join(' ')) &&
      !persona.facts?.[entry.type])
    .filter(({ entry, live }) => (!entry.type || manual.filter(other => other.type === entry.type).length === 1) &&
      (!live.field.label || before.fields.filter(other => other.required && Fields.normalise(other.field.label) === Fields.normalise(live.field.label)).length === 1));
  if (!gaps.length) return { persona, boundValues: [], expectedDocumentInstanceId: before.documentInstanceId, expectedUrl: before.url };
  const inputs = gaps.map(({ entry, live }, index) => ({ key: 'g' + index, field: live.field, type: entry.type,
    reason: entry.reason, required: true }));
  notifyPanel({ fillProgress: 'Completing missing required persona details', count: inputs.length });
  const result = await runInference({ requestId, purpose: 'fill-completion',
    schema: { type: 'object', additionalProperties: false, properties: { answers: { type: 'array', items: {
      type: 'object', additionalProperties: false, properties: { key: { type: 'string', enum: inputs.map(item => item.key) }, value: { type: 'string' } }, required: ['key', 'value'] } } }, required: ['answers'] },
    messages: [{ role: 'system', content: 'Complete missing required details for a synthetic testing persona. Use its rich profile consistently. Return only answers supported by that profile or plausible synthetic additions that do not contradict it. Empty value means abstain. Never invent verification contacts, credentials, consents, declarations, or replace existing facts. For displayed categorical options choose an exact observed label. No code, selectors or actions.' },
      { role: 'user', content: JSON.stringify({ persona: TreadwayPersonaManager.semanticContext(persona), fields: inputs }) }] });
  const current = (await chrome.storage.session.get('journey')).journey;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!current || current.contextFields.run !== journey.contextFields.run || current.contextStatus !== 'active' || active?.id !== tab.id) throw new Error('Recording or active tab changed while preparing values');
  const after = await pageRead(tab.id, 'inspect-assistance');
  if (after.documentInstanceId !== before.documentInstanceId || after.url !== before.url || after.formContext !== before.formContext) throw new Error('The form changed while preparing values');
  const seen = new Set(), facts = {}, boundValues = [];
  for (const answer of result.data.answers) {
    if (seen.has(answer.key)) throw new Error('Inference returned duplicate field answers');
    seen.add(answer.key);
    const index = inputs.findIndex(item => item.key === answer.key), gap = gaps[index];
    if (!gap || !answer.value.trim()) continue;
    const live = after.fields.find(field => JSON.stringify(field.binding) === JSON.stringify(gap.entry.binding));
    if (!live || live.hasValue || live.disabled) throw new Error('A field changed while preparing values');
    // Store a reusable semantic key, not a per-call namespace that only an
    // ephemeral binding can match on the next visit to the same form.
    const type = gap.entry.type || Fields.normalise(live.field.label || live.field.name || live.field.id)
      .replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '_').slice(0, 80);
    if (!type || ['__proto__', 'constructor', 'prototype'].includes(type)) continue;
    if (Object.hasOwn(persona.facts || {}, type) || Object.hasOwn(facts, type)) continue;
    facts[type] = answer.value;
    boundValues.push({ binding: gap.entry.binding, type, value: answer.value, source: 'llm' });
  }
  const proposal = TreadwayPersonaManager.proposeEnrichment(persona, { facts });
  if (proposal.conflicts.length) throw new Error('Generated values conflict with existing persona details; review the persona');
  const candidate = TreadwayPersonaManager.applyEnrichment(persona, proposal, { source: 'llm' });
  if (TreadwayPersonaManager.preflight(candidate).checks.some(check => check.status === 'fail')) throw new Error('Generated values failed persona consistency checks');
  return { persona: candidate, boundValues, expectedDocumentInstanceId: before.documentInstanceId, expectedUrl: before.url, expectedFormContext: before.formContext };
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
async function readJournalPage(options = {}) {
  await journalQueue;
  const stored = await chrome.storage.session.get(['journey', 'finished', 'requests', 'journalArchive', 'journalEvictions']);
  const state = { ...stored, requests: stored.requests || {} };
  state.journey = forExport(state, state.journey);
  state.finished = forExport(state, state.finished);
  const settings = await readSettings();
  const page = TreadwayJournalStream.read(state, options, [settings.safeyoloKey, settings.jevKey, settings.llmKey]);
  await chrome.storage.session.set({ liveStream: { state: 'connected', lastReadAt: new Date().toISOString(), output: String(options.output || '').slice(0, 200) } });
  return page;
}
// Only an attached, owned extension worker can call this global through CDP.
globalThis.treadwayReadJournal = readJournalPage;
globalThis.treadwayJournalStreamError = async (error) => {
  await chrome.storage.session.set({ liveStream: { state: 'error', lastReadAt: new Date().toISOString(), error: String(error).slice(0, 300) } });
  notifyPanel({ refreshLiveStream: true });
};
const handlers = {
  'journal-read': (message, sender) => {
    if (sender.url !== 'chrome-extension://' + chrome.runtime.id + '/sidepanel.html') throw new Error('Journal reads require the recorder panel or owned worker');
    return readJournalPage(message);
  },
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
    const state = await chrome.storage.session.get(['journey', 'finished', 'requests', 'liveStream']);
    state.requests = state.requests || {};
    const journey = state.journey || state.finished;
    const page = [...(journey?.events || [])].reverse().find(event => event.contentVersion);
    return { journey: forExport(state, state.journey), finished: forExport(state, state.finished), liveStream: state.liveStream || null, fillBusy: Boolean(fillInProgress || completionInProgress),
      runtime: { version: chrome.runtime.getManifest().version, ready: true, contentVersion: page?.contentVersion || null,
        contentReady: page ? page.contentVersion === chrome.runtime.getManifest().version : null },
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
  'journey-page-context': async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !/^https?:/.test(tab.url || '')) return { available: false };
    return pageRead(tab.id, 'journey-page-context');
  },
  'fill-complete': message => completeFill(message),
  'inference-request': message => runInference(message),
  'inference-cancel': ({ requestId }) => {
    if (completionInProgress?.requestId === requestId) completionInProgress.cancelled = true;
    const controller = inferenceRequests.get(requestId); controller?.abort(); return { cancelled: Boolean(controller) };
  },
  'inference-settings-check': async () => {
    const settings = await readSettings();
    if (!globalThis.TreadwayInference) return { provider: settings.llmProvider, model: settings.llmModel, ready: false, models: [], reason: 'Structured inference is not available in this build' };
    try {
      TreadwayInference.checkConfiguration(settings);
      return { provider: settings.llmProvider, model: settings.llmModel, ready: true,
        models: TreadwayInference.availableModels(settings.llmProvider) };
    } catch (_) { return { provider: settings.llmProvider, model: settings.llmModel, ready: false,
      models: TreadwayInference.availableModels(settings.llmProvider), reason: 'Configure a supported model, endpoint and API key' }; }
  },
  'cancel-fill': async () => {
    for (const controller of inferenceRequests.values()) controller.abort();
    if (completionInProgress) completionInProgress.cancelled = true;
    const fill = fillInProgress;
    if (fill) { fill.cancelled = true; await pageRead(fill.tabId, 'cancel-fill'); }
    return { cancelled: Boolean(fill) };
  },
  'highlight-field': async ({ binding, frameId = 0 }) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !binding) throw new Error('No application field is selected');
    return pageRead(tab.id, 'highlight-field', frameId, { binding });
  },
  'fill-await-dependencies': async ({ fillToken }) => {
    const fill = fillInProgress;
    if (!fill || fill.token !== fillToken) return { ready: false };
    const deadline = Date.now() + 15000;
    let quietSince = null;
    while (Date.now() < deadline) {
      const state = await chrome.storage.session.get(['journey', 'requests']);
      if (fill.cancelled || fillInProgress !== fill || state.journey?.contextFields.run !== fill.run || state.journey.contextStatus !== 'active') return { ready: false };
      const pending = Object.values(state.requests || {}).some(request => request.run === fill.run && request.tabId === fill.tabId &&
        ['xmlhttprequest', 'fetch'].includes(request.resourceType));
      if (pending) quietSince = null;
      else if (quietSince === null) quietSince = Date.now();
      else if (Date.now() - quietSince >= 250) return { ready: true };
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { ready: false };
  },
  'persona-edit-begin': () => {
    if (fillInProgress) throw new Error('Wait for Fill all to finish before changing personas');
    assertNoPersonaEdit();
    personaEditLease = { token: crypto.randomUUID(), expiresAt: Date.now() + 300000 };
    return { token: personaEditLease.token };
  },
  'persona-edit-end': ({ token }) => {
    if (personaEditLease?.token !== token) throw new Error('Persona edit lease changed');
    personaEditLease = null; return { ok: true };
  },
  'persona-work-request': message => personaWorkTransition(async () => {
    if (fillInProgress) throw new Error('Wait for Fill all before requesting persona work');
    const { pendingPersonaWork } = await chrome.storage.local.get('pendingPersonaWork');
    if (!TreadwayPersonaWork.terminal(pendingPersonaWork)) throw new Error('Complete or cancel the current persona request first');
    const request = TreadwayPersonaWork.request(message, { id: 'persona-' + crypto.randomUUID(), extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version });
    assertNoConfiguredKeys(request, await readSettings());
    await chrome.storage.local.set({ pendingPersonaWork: request }); return { request };
  }),
  'persona-work-status': async () => {
    const { pendingPersonaWork: request } = await chrome.storage.local.get('pendingPersonaWork'); return { request: request || null, status: request?.status || 'idle' };
  },
  'persona-work-check': async ({ requestId }) => ({ request: await personaWorkCheck(requestId) }),
  'persona-work-ack': ({ requestId }) => workState(requestId, 'accepted'),
  'persona-work-proposed': ({ requestId, proposal }) => workState(requestId, 'proposed', { proposal: { personaIds: (proposal?.personas || []).map(persona => persona.id) } }),
  'persona-work-finished': ({ requestId, result }) => workState(requestId, 'completed', { result }),
  'persona-work-cancel': ({ requestId }) => workState(requestId, 'cancelled'),
  'persona-work-failed': ({ requestId, error }) => workState(requestId, 'failed', { error: String(error || 'Persona work failed').slice(0, 500) }),
  'persona-preflight': async ({ persona }) => {
    persona = TreadwayPersonas.parsePersonas(JSON.stringify({ personas: [persona] }))[0];
    const local = TreadwayPersonaManager.preflight(persona); const settings = await readSettings();
    if (!settings.jevKey) return { ...local, checks: [...local.checks, { id: 'semantic.not_checked', status: 'uncertain', message: 'Add the Jev key to check narrative consistency' }] };
    const profile = TreadwayPersonaManager.semanticContext(persona); assertNoConfiguredKeys(profile, settings);
    try { const semantic = await Jev.reviewPersona({ apiKey: settings.jevKey, profile, fetch }); return { checks: [...local.checks, ...semantic.checks] }; }
    catch (error) { return { checks: [...local.checks, { id: 'semantic.unavailable', status: 'uncertain', message: error.message }] }; }
  },
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
  classify: async (message) => ({ types: message.fillToken && fillInProgress?.token !== message.fillToken ? {} : await classifyFields(message.fields) }),
  decide: async (message) => {
    const { journey } = await chrome.storage.session.get('journey');
    if (!journey || journey.contextStatus !== 'active') return { decisions: {} };
    const settings = await readSettings();
    if (!settings.jevKey) return { decisions: {} };
    assertNoConfiguredKeys(message.jobs, settings);
    if (message.fillToken && fillInProgress?.token !== message.fillToken) return { decisions: {} };
    const profile = message.fillToken ? fillInProgress?.profile : undefined;
    if (profile) assertNoConfiguredKeys(profile, settings);
    return { decisions: await Jev.decideWithJev({ apiKey: settings.jevKey, jobs: message.jobs, profile, fetch }) };
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
  if (/^(assistance-|persona-work-)/.test(message.kind || '')) {
    reply({ error: 'Local agent assistance is retired. Use Fill all or the persona manager with configured inference.' });
    return false;
  }
  const handler = handlers[message.kind];
  if (!handler) return false;
  Promise.resolve().then(readSettings).then(() => handler(message, sender))
    .then((result) => reply(result === undefined ? { ok: true } : result))
    .catch((error) => reply({ error: error.message }));
  return true;
});
