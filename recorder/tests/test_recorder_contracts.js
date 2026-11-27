'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/background-harness.js');
const Network = require('../lib/network.js');

const base = { requestId: 'chrome-1', tabId: 7, frameId: 0, documentId: 'doc-a',
  url: 'https://app.example.test/claims', method: 'POST', type: 'xmlhttprequest', timeStamp: 1000 };
const headers = (id) => [{ name: 'X-SafeYolo-Request-Id', value: id }];

test('a missing read receiver reattaches content scripts, but an uncertain message does not retry', async () => {
  let attached = false; let injections = 0;
  const h = createHarness({
    executeScript: async () => { attached = true; injections++; },
    frameMessage: async () => {
      if (!attached) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { flushed: true, failures: [] };
    },
  });
  await h.start();
  assert.ok(injections > 0);
  let retries = 0;
  const uncertain = createHarness({
    executeScript: async () => { retries++; }, frameMessage: async () => { throw new Error('Message port closed'); },
  });
  await uncertain.start();
  assert.equal(retries, 0);
});

test('retired local-agent requests cannot queue, apply or complete work', async () => {
  const h = createHarness();
  await h.start();
  const before = JSON.stringify(h.session);
  for (const kind of ['assistance-request', 'assistance-check', 'assistance-finished', 'persona-work-request', 'persona-work-ack', 'persona-work-proposed']) {
    assert.match((await h.command({ kind, persona: h.persona })).error, /retired/);
  }
  assert.equal(JSON.stringify(h.session), before);
  assert.equal(h.local.pendingPersonaWork, undefined);
});

test('concurrent Starts declare only the accepted journey', async () => {
  const h = createHarness();
  const answers = await Promise.all([h.start('First journey'), h.start('Second journey')]);
  assert.equal(answers.filter((answer) => !answer.error).length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(h.session.journey.context, h.external.context);
});

test('Start retains an uncertain declaration so Stop can reconcile it', async () => {
  const h = createHarness({ fetchHook: async (_url, options) => { if (options.method === 'POST') throw new Error('lost reply'); } });
  assert.match((await h.start()).error, /Cannot reach the SafeYolo Agent API/);
  assert.equal(h.session.journey.contextStatus, 'declaration_unconfirmed');
  assert.match((await h.start('Again')).error, /Stop/);
  await h.command({ kind: 'stop' });
  assert.equal(h.session.journey, null);
});

test('Stop does not clear a different declared context', async () => {
  const h = createHarness(); await h.start();
  h.external.context = 'run=other;agent=fixture-agent';
  const result = await h.command({ kind: 'stop' });
  assert.equal(result.clearSkipped, 'different_declared_context');
  assert.equal(h.external.context, 'run=other;agent=fixture-agent');
  assert.equal(h.calls.filter((call) => call.method === 'DELETE').length, 0);
});

test('UI observations keep actual frame/document, source time and unique event IDs', async () => {
  const h = createHarness(); await h.start();
  await h.command({ kind: 'page-event', event: { type: 'click', at: '2026-11-23T00:00:00.000Z', frameId: 999 } },
    { tab: { id: 7 }, frameId: 2, documentId: 'doc-child' });
  await h.command({ kind: 'page-event', event: { type: 'click' } }, { tab: { id: 7 }, frameId: 3, documentId: 'doc-other' });
  const entries = h.session.journey.events.filter((entry) => entry.type === 'click');
  assert.deepEqual(entries.map((entry) => entry.frameId), [2, 3]);
  assert.equal(entries[0].documentId, 'doc-child');
  assert.equal(entries[0].at, '2026-11-23T00:00:00.000Z');
  assert.notEqual(entries[0].eventId, entries[1].eventId);
});

test('SPA history and fragment transitions are recorded with browser provenance', async () => {
  const h = createHarness(); await h.start();
  await h.emit('webNavigation', 'onHistoryStateUpdated', { ...base, url: 'https://app.example.test/next' });
  await h.emit('webNavigation', 'onReferenceFragmentUpdated', { ...base, url: 'https://app.example.test/next#step' });
  assert.deepEqual(h.session.journey.events.filter((entry) => entry.type === 'navigation').map((entry) => entry.how),
    ['history_state_updated', 'fragment_updated']);
});

test('network responses join exact flow IDs and preserve every redirect leg', async () => {
  const h = createHarness(); await h.start();
  await h.command({ kind: 'marker', marker: 'step', name: 'Save claim', expectedOutcome: 'reload shows claim' });
  await h.command({ kind: 'page-event', event: { type: 'click' } });
  await h.emit('webRequest', 'onBeforeRequest', base);
  await h.emit('webRequest', 'onHeadersReceived', { ...base, statusCode: 303, responseHeaders: headers('req-first') });
  await h.emit('webRequest', 'onBeforeRedirect', { ...base, statusCode: 303, redirectUrl: 'https://app.example.test/claims/1' });
  await h.command({ kind: 'marker', marker: 'step', name: 'Another step' });
  const next = { ...base, method: 'GET', url: 'https://app.example.test/claims/1', timeStamp: 1100 };
  await h.emit('webRequest', 'onBeforeRequest', next);
  await h.emit('webRequest', 'onHeadersReceived', { ...next, statusCode: 200, responseHeaders: headers('req-second') });
  await h.emit('webRequest', 'onCompleted', { ...next, statusCode: 200, responseHeaders: headers('req-second') });
  const responses = h.session.journey.events.filter((entry) => entry.type === 'network_response');
  assert.deepEqual(responses.map((entry) => entry.safeyoloRequestId), ['req-first', 'req-second']);
  assert.deepEqual(responses.map((entry) => entry.responseIndex), [1, 2]);
  assert.ok(responses.every((entry) => entry.stepId === 'step-1'));
  assert.ok(responses.every((entry) => entry.chromeRequestId === 'chrome-1'));
  assert.ok(responses[0].precedingUiEventId);
  assert.equal(responses[0].uiAssociation, 'preceding_event_only_not_causality');
  assert.equal(Object.keys(h.session.requests).length, 0);
});

test('missing/ambiguous headers, cached responses and request failures stay explicit', async () => {
  assert.equal(Network.flowReference([]).flowCorrelation, 'missing_header');
  assert.equal(Network.flowReference([...headers('req-a'), ...headers('req-b')]).flowCorrelation, 'ambiguous_header');
  const h = createHarness(); await h.start();
  await h.emit('webRequest', 'onBeforeRequest', base);
  await h.emit('webRequest', 'onCompleted', { ...base, statusCode: 200, fromCache: true, responseHeaders: headers('req-old-cache') });
  const response = h.session.journey.events.find((entry) => entry.type === 'network_response');
  assert.equal(response.fromCache, true); assert.equal(response.safeyoloRequestId, 'req-old-cache');
  const failure = { ...base, requestId: 'chrome-failed' };
  await h.emit('webRequest', 'onBeforeRequest', failure);
  await h.emit('webRequest', 'onErrorOccurred', { ...failure, error: 'net::ERR_CONNECTION_RESET' });
  const error = h.session.journey.events.find((entry) => entry.type === 'network_error');
  assert.equal(error.flowCorrelation, 'no_response_headers');
  assert.equal(error.safeyoloRequestId, null);
});

test('response and completion after Stop remain bound; stale save cannot discard them', async () => {
  const h = createHarness(); const started = await h.start();
  await h.command({ kind: 'marker', marker: 'step', name: 'Save' });
  await h.emit('webRequest', 'onBeforeRequest', base);
  const stopped = await h.command({ kind: 'stop' });
  assert.equal(stopped.finished.networkCapture.complete, false);
  assert.equal(stopped.pendingRequests, 1);
  await h.command({ kind: 'saved', run: started.contextFields.run, revision: stopped.finished.revision });
  assert.ok(h.session.finished);
  await h.emit('webRequest', 'onHeadersReceived', { ...base, statusCode: 201, responseHeaders: headers('req-late') });
  await h.emit('webRequest', 'onCompleted', { ...base, statusCode: 201 });
  const status = await h.command({ kind: 'status' });
  assert.equal(status.finished.networkCapture.complete, true);
  assert.equal(status.finished.events.find((entry) => entry.safeyoloRequestId === 'req-late').stepId, 'step-1');
  const stale = await h.command({ kind: 'saved', run: started.contextFields.run, revision: stopped.finished.revision });
  assert.equal(stale.newerEvents, true); assert.ok(h.session.finished);
  await h.command({ kind: 'saved', run: started.contextFields.run, revision: status.finished.revision });
  assert.equal(h.session.finished, null);
});

test('operator can finish an incomplete capture without fabricating network completion', async () => {
  const h = createHarness(); const started = await h.start();
  await h.emit('webRequest', 'onBeforeRequest', base);
  await h.command({ kind: 'stop' });
  const closed = await h.command({ kind: 'finish-incomplete' });
  assert.equal(closed.finished.networkCapture.complete, false);
  assert.equal(closed.finished.networkCapture.pending.length, 0);
  assert.equal(closed.finished.events.at(-1).type, 'network_capture_incomplete');
  await h.command({ kind: 'saved', run: started.contextFields.run, revision: closed.finished.revision });
  assert.equal(h.session.finished, null);
});

test('only a SafeYOLO context block renews; ordinary application 428 does not', async () => {
  const h = createHarness(); await h.start();
  await h.emit('webRequest', 'onBeforeRequest', base);
  await h.emit('webRequest', 'onHeadersReceived', { ...base, statusCode: 428, responseHeaders: headers('req-app428') });
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1);
  await h.emit('webRequest', 'onCompleted', { ...base, statusCode: 428 });
  const blocked = { ...base, requestId: 'blocked' };
  await h.emit('webRequest', 'onBeforeRequest', blocked);
  await h.emit('webRequest', 'onHeadersReceived', { ...blocked, statusCode: 428,
    responseHeaders: [...headers('req-blocked'), { name: 'X-Blocked-By', value: 'test-context' }] });
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 2);
  assert.equal(h.session.journey.events.find((entry) => entry.type === 'context_renewed').after.safeyoloRequestId, 'req-blocked');
});

test('a late blocked response after Stop cannot redeclare the stopped context', async () => {
  const h = createHarness(); await h.start();
  await h.emit('webRequest', 'onBeforeRequest', base);
  await h.command({ kind: 'stop' });
  await h.emit('webRequest', 'onHeadersReceived', { ...base, statusCode: 428,
    responseHeaders: [{ name: 'X-Blocked-By', value: 'test-context' }] });
  assert.equal(h.external.context, null);
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1);
});

test('discovered sign-in origins are captured and can renew without a host list or request retry', async () => {
  // An old saved host list must not gate a newly encountered identity provider.
  const h = createHarness({ settings: { targetHosts: ['app.example.test'] } }); await h.start();
  const signIn = { ...base, requestId: 'signin', url: 'https://identity.example.test/register', method: 'GET', type: 'main_frame' };
  await h.emit('webNavigation', 'onCommitted', signIn);
  await h.emit('webRequest', 'onBeforeRequest', signIn);
  await h.emit('webRequest', 'onHeadersReceived', { ...signIn, statusCode: 428,
    responseHeaders: [...headers('req-signin-block'), { name: 'X-Blocked-By', value: 'test-context' }] });
  assert.ok(h.session.journey.events.some(e => e.type === 'navigation' && e.url === signIn.url));
  assert.ok(h.session.journey.events.some(e => e.type === 'network_request' && e.url === signIn.url));
  assert.equal(h.session.journey.events.find(e => e.type === 'context_renewed').after.safeyoloRequestId, 'req-signin-block');
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 2);
  assert.ok(h.calls.filter(call => call.method === 'POST').every(call => call.body.context === h.session.journey.context));
  assert.equal(h.session.journey.events.filter(e => e.type === 'network_request').length, 1, 'renewal does not replay the request');
});

test('test-secret logging is explicit and reference mode also protects classified OTPs', async () => {
  for (const recordSecrets of [true, false]) {
    const h = createHarness({ settings: { recordSecrets } }); await h.start();
    await h.command({ kind: 'page-event', event: { type: 'field', fieldType: 'one_time_code',
      secret: true, value: 'SYNTHETIC-CODE' } });
    const entry = h.session.journey.events.at(-1);
    assert.equal(entry.secretReference, 'FIXTURE_OTP');
    assert.equal(entry.value, recordSecrets ? 'SYNTHETIC-CODE' : undefined);
    assert.equal(entry.redacted, recordSecrets ? undefined : true);
  }
});

test('manual renewal preserves the journey and its history without dispatching an application request', async () => {
  const h = createHarness(); const started = await h.start();
  await h.command({ kind: 'page-event', event: { type: 'click' } });
  const prior = h.session.journey.events.map(e => e.eventId);
  h.external.context = null; // An expired declaration can be renewed in-place.
  const renewed = await h.command({ kind: 'renew-context' });
  assert.equal(renewed.context, started.context);
  assert.equal(renewed.startedAt, started.startedAt);
  assert.deepEqual(renewed.events.slice(0, prior.length).map(e => e.eventId), prior);
  assert.equal(renewed.events.at(-1).type, 'context_renewed');
  assert.equal(renewed.events.at(-1).source, 'operator');
  assert.equal(renewed.events.some(e => e.type === 'network_request'), false);
  assert.equal(renewed.contextRenewalStatus, 'confirmed');
});

test('manual renewal leaves another owner intact and cannot run after Stop', async () => {
  const h = createHarness(); await h.start();
  h.external.context = 'run=another;agent=fixture-agent';
  assert.match((await h.command({ kind: 'renew-context' })).error, /different journey/);
  assert.equal(h.external.context, 'run=another;agent=fixture-agent');
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
  await h.command({ kind: 'stop' });
  assert.match((await h.command({ kind: 'renew-context' })).error, /active journey/);
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
});

test('a lost renewal response stays unconfirmed and is never automatically retried', async () => {
  let fail = false;
  const h = createHarness({ fetchHook: async (_url, options) => {
    if (fail && options.method === 'POST') throw new Error('lost renewal reply');
  } });
  await h.start(); fail = true;
  assert.match((await h.command({ kind: 'renew-context' })).error, /Cannot reach the SafeYolo Agent API/);
  await h.idle();
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 2);
  assert.equal(h.session.journey.contextRenewalStatus, 'unconfirmed');
  assert.equal(h.session.journey.events.at(-1).type, 'context_renew_failed');
  assert.equal(h.session.journey.events.at(-1).declarationAttempted, true);
});

test('reference-mode journals redact automatic credential fill results including failed readbacks', async () => {
  const h = createHarness({ settings: { recordSecrets: false } }); await h.start();
  const secret = { type: 'new_password', secret: true, value: 'SyntheticPassword!7',
    expectedValue: 'SyntheticPassword!7', observedValue: 'SyntheticPassword!7', secretReference: 'FIXTURE_NEW_PASSWORD' };
  await h.command({ kind: 'page-event', event: { type: 'fill', filled: [secret], manual: [{ ...secret, reason: 'did not stick' }],
    skipped: [{ ...secret, reason: 'control disabled after fill' }] } });
  const event = h.session.journey.events.at(-1);
  assert.equal(JSON.stringify(event).includes('SyntheticPassword!7'), false);
  assert.equal(event.filled[0].secretReference, 'FIXTURE_NEW_PASSWORD');
  assert.equal(event.manual[0].redacted, true);
  assert.equal(event.skipped[0].redacted, true);
});

test('Jev decisions cannot dispatch after the recorder stops', async () => {
  const h = createHarness({ settings: { jevKey: 'synthetic-provider-key' } });
  await h.start(); await h.command({ kind: 'stop' });
  const before = h.calls.length;
  const result = await h.command({ kind: 'decide', jobs: [{ key: 'grade', type: 'classification',
    field: { label: 'Grade' }, intent: 'Upper second', options: [{ label: '2.1' }] }] });
  assert.deepEqual(result, { decisions: {} });
  assert.equal(h.calls.length, before);
});
