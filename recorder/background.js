// Background service worker: owns the active journey, the SafeYOLO test
// context, the event log and Jev calls.
importScripts('lib/fields.js', 'lib/jev.js', 'lib/test-context.js');

const Context = globalThis.TreadwayTestContext;
const Jev = globalThis.TreadwayJev;
const Fields = globalThis.TreadwayFields;

const DEFAULT_SETTINGS = { safeyoloKey: '', jevKey: '', targetHosts: [], ttlMinutes: 20 };

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

// Session storage survives service-worker restarts but not a browser restart.
// Writes are serialised so concurrent page events are never lost.
let queue = Promise.resolve();
function updateJourneys(change) {
  const next = queue.then(async () => {
    const stored = await chrome.storage.session.get(['journey', 'finished']);
    const state = { journey: stored.journey || null, finished: stored.finished || null };
    const result = await change(state);
    await chrome.storage.session.set(state);
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

async function readSettings() {
  const stored = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, stored.settings);
}

function appendEvent(state, event) {
  if (!state.journey) return false;
  state.journey.events.push(Object.assign({ at: new Date().toISOString() }, event));
  return true;
}

function notifyPanel(message) {
  chrome.runtime.sendMessage(Object.assign({ kind: 'panel-notice' }, message)).catch(() => undefined);
}

async function broadcastRecording(active) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { kind: 'recording', active }).catch(() => undefined);
}

async function startJourney({ persona, journeyName }) {
  const settings = await readSettings();
  if (!settings.safeyoloKey) throw new Error('Add the SafeYOLO agent API key in Settings first');
  // Checked before SafeYOLO is called, so a refused start leaves the running context alone.
  const before = await chrome.storage.session.get(['journey', 'finished']);
  if (before.journey) throw new Error('Stop the current journey first');
  if (before.finished) throw new Error('Save or discard the stopped journey first');
  const current = await Context.readContext(fetch, settings.safeyoloKey);
  const startedAt = new Date();
  const context = Context.buildContext({ agent: current.agent, persona, journey: journeyName, startedAt });
  const declared = await Context.declareContext(fetch, settings.safeyoloKey, context.header, Math.round(settings.ttlMinutes * 60));
  const journey = {
    journey: journeyName,
    context: context.header,
    contextFields: context.fields,
    persona: { id: persona.id, role: persona.role, label: persona.label, secrets: persona.secrets },
    startedAt: startedAt.toISOString(),
    expiresAt: new Date(Date.now() + declared.expires_in * 1000).toISOString(),
    events: [],
  };
  await updateJourneys((state) => {
    if (state.journey) throw new Error('Stop the current journey first');
    if (state.finished) throw new Error('Save or discard the stopped journey first');
    state.journey = journey;
    appendEvent(state, { type: 'context_declared', context: journey.context, expires_in: declared.expires_in });
  });
  await broadcastRecording(true);
  return journey;
}

async function stopJourney() {
  const settings = await readSettings();
  if (!(await chrome.storage.session.get('journey')).journey) throw new Error('No journey is running');
  let clearError = null;
  try {
    await Context.clearContext(fetch, settings.safeyoloKey);
  } catch (error) {
    clearError = error.message;
  }
  const finished = await updateJourneys((state) => {
    if (!state.journey) throw new Error('No journey is running');
    appendEvent(state, clearError ? { type: 'context_clear_failed', error: clearError } : { type: 'context_cleared' });
    state.journey.stoppedAt = new Date().toISOString();
    state.finished = state.journey;
    state.journey = null;
    return state.finished;
  });
  await broadcastRecording(false);
  return { finished, clearError };
}

// SafeYOLO answers 428 on a target host once the declared context expires.
// MVP: renew the declaration and ask the person to resubmit; no automatic retry.
let renewing = null;
async function renewAfter428(details) {
  const stored = await chrome.storage.session.get('journey');
  const journey = stored.journey;
  if (!journey || renewing) return;
  const settings = await readSettings();
  if (!Context.hostMatches(new URL(details.url).hostname, settings.targetHosts)) return;
  renewing = (async () => {
    try {
      const declared = await Context.declareContext(fetch, settings.safeyoloKey, journey.context, Math.round(settings.ttlMinutes * 60));
      const expiresAt = new Date(Date.now() + declared.expires_in * 1000).toISOString();
      await updateJourneys((state) => {
        if (!state.journey || state.journey.context !== journey.context) return;
        state.journey.expiresAt = expiresAt;
        appendEvent(state, { type: 'context_renewed', after: { url: details.url, method: details.method, status: 428 }, expires_in: declared.expires_in });
      });
      notifyPanel({ level: 'warning', text: 'Test context had expired and is renewed. Resubmit the last action (' + details.method + ' ' + details.url + ').' });
    } catch (error) {
      notifyPanel({ level: 'error', text: 'Could not renew the test context: ' + error.message });
    } finally {
      renewing = null;
    }
  })();
}

chrome.webRequest.onCompleted.addListener((details) => {
  if (details.statusCode === 428 && details.tabId >= 0) renewAfter428(details);
}, { urls: ['<all_urls>'] });

async function classifyFields(fields) {
  const settings = await readSettings();
  if (!settings.jevKey) return {};
  const stored = await chrome.storage.session.get('personaFieldTypes');
  const choices = Object.assign({}, Fields.FIELD_TYPES);
  for (const type of stored.personaFieldTypes || []) if (!choices[type]) choices[type] = type.replace(/_/g, ' ');
  return Jev.classifyWithJev({ apiKey: settings.jevKey, fields, choices, fetch });
}

async function fillActiveTab({ values }) {
  const settings = await readSettings();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab');
  await chrome.storage.session.set({ personaFieldTypes: Object.keys(values) });
  const answer = await chrome.tabs.sendMessage(tab.id, { kind: 'fill', values, classify: Boolean(settings.jevKey) }, { frameId: 0 });
  if (!answer) throw new Error('The page did not answer; reload it so the recorder can attach');
  if (answer.error) throw new Error(answer.error);
  await updateJourneys((state) => {
    appendEvent(state, { type: 'fill', url: answer.url, filled: answer.report.filled, manual: answer.report.manual, classifyError: answer.report.classifyError });
  });
  return answer.report;
}

function withSecretReference(journey, event) {
  if (event.type === 'field' && event.redacted) {
    const reference = journey.persona.secrets[event.fieldType];
    if (reference) return Object.assign({}, event, { secretReference: reference });
  }
  return event;
}

const handlers = {
  'recording?': async () => {
    const stored = await chrome.storage.session.get('journey');
    return { active: Boolean(stored.journey) };
  },
  'page-event': (message, sender) => updateJourneys((state) => {
    if (!state.journey) return;
    appendEvent(state, Object.assign({ tab: sender.tab && sender.tab.id }, withSecretReference(state.journey, message.event)));
  }),
  status: async () => {
    const stored = await chrome.storage.session.get(['journey', 'finished']);
    return { journey: stored.journey || null, finished: stored.finished || null };
  },
  start: (message) => startJourney(message),
  stop: () => stopJourney(),
  marker: (message) => updateJourneys((state) => {
    if (!appendEvent(state, { type: 'marker', marker: message.marker, name: message.name || undefined })) {
      throw new Error('Start a journey before adding markers');
    }
  }),
  fill: (message) => fillActiveTab(message),
  classify: async (message) => ({ types: await classifyFields(message.fields) }),
  saved: () => updateJourneys((state) => {
    state.finished = null;
  }),
};

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const handler = handlers[message.kind];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message, sender))
    .then((result) => reply(result === undefined ? { ok: true } : result))
    .catch((error) => reply({ error: error.message }));
  return true;
});
