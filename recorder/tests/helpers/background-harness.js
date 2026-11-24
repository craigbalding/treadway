'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const recorder = path.join(__dirname, '..', '..');
function event() {
  const callbacks = [];
  return { addListener(fn) { callbacks.push(fn); }, emit(details) { for (const fn of callbacks) fn(details); } };
}
function createHarness(options = {}) {
  const session = {};
  const notices = [];
  const calls = [];
  const external = { context: null };
  const apiContext = () => typeof external.context === 'string' ? Object.fromEntries(
    external.context.split(';').map(part => part.split('='))) : external.context;
  const webRequest = Object.fromEntries(['onBeforeRequest', 'onHeadersReceived', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred'].map((key) => [key, event()]));
  const webNavigation = Object.fromEntries(['onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onCommitted'].map((key) => [key, event()]));
  webNavigation.getAllFrames = async () => [{ frameId: 0, documentId: 'doc-a' }, { frameId: 2, documentId: 'doc-child' }];
  let listener;
  const context = vm.createContext({
    console, Date, URL, Promise, AbortSignal, setTimeout, clearTimeout, crypto: webcrypto,
    fetch: async (url, request) => {
      calls.push({ method: request.method, ...(request.body ? { body: JSON.parse(request.body) } : {}) });
      if (options.fetchHook) await options.fetchHook(url, request);
      let value;
      if (request.method === 'GET') value = { agent: 'fixture-agent', context: apiContext() };
      else if (request.method === 'DELETE') { external.context = null; value = { status: 'cleared' }; }
      else { external.context = JSON.parse(request.body).context; value = { context: apiContext(), expires_in: 1200 }; }
      return { status: 200, text: async () => JSON.stringify(value) };
    },
    chrome: {
      sidePanel: { setPanelBehavior: async () => {} }, webRequest, webNavigation,
      scripting: { executeScript: async options_ => { if (options.executeScript) return options.executeScript(options_); } },
      tabs: { query: async () => [{ id: 7, url: 'https://app.example.test/form' }],
        sendMessage: async (_id, message) => {
          if (options.frameMessage) return options.frameMessage(message);
          return { flushed: true, failures: [] };
        } },
      runtime: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', getManifest: () => ({ version: '0.1.5' }),
        sendMessage: async (message) => { notices.push(message); }, onMessage: { addListener(fn) { listener = fn; } } },
      storage: {
        local: { get: async () => ({ settings: { safeyoloKey: 'fixture-key', ttlMinutes: 20, ...options.settings } }) },
        session: {
          get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(session[key])])),
          set: async (data) => Object.assign(session, structuredClone(data)),
        },
      },
    },
  });
  context.importScripts = (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(path.join(recorder, file), 'utf8'), context, { filename: file }));
  vm.runInContext(fs.readFileSync(path.join(recorder, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  const sender = { tab: { id: 7 }, frameId: 0, documentId: 'doc-a' };
  function command(message, from = sender) {
    return new Promise((resolve) => listener(message, from, (answer) => resolve(structuredClone(answer))));
  }
  async function idle() {
    await new Promise((resolve) => setImmediate(resolve));
    await vm.runInContext('journalQueue.then(() => transitionQueue).then(() => journalQueue)', context);
    await new Promise((resolve) => setImmediate(resolve));
  }
  async function emit(group, name, details) { ({ webRequest, webNavigation })[group][name].emit(details); await idle(); }
  const persona = { id: 'fixture-persona', role: 'submitter', label: 'Fixture person', secrets: { one_time_code: 'FIXTURE_OTP', password: 'FIXTURE_PASSWORD' } };
  return { session, external, notices, calls, command, emit, idle, persona,
    start: (journeyName = 'Submit fixture') => command({ kind: 'start', persona, journeyName }) };
}
module.exports = { createHarness };
