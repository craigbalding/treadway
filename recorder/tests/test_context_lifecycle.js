'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/background-harness');
const alarm = 'treadway-context-renew';

test('standalone recording starts, journals and stops without SafeYolo requests or renewal alarms', async () => {
  const h = createHarness({ settings: { safeyoloMode: 'off' } });
  const started = await h.start();
  assert.equal(started.safeyolo.enabled, false);
  assert.equal(started.context, null);
  assert.equal(started.contextStatus, 'active');
  assert.equal(h.calls.length, 0);
  assert.equal(h.scheduled.size, 0);
  const stopped = await h.command({ kind: 'stop' });
  assert.ok(stopped.finished.stoppedAt);
  assert.equal(h.calls.length, 0);
  assert.equal(stopped.finished.handoff.requestBodies, 'not_captured_by_recorder');
});

test('granted context lease schedules automatic extension until stop clears the alarm', async () => {
  const h = createHarness();
  await h.start();
  assert.ok(h.scheduled.get(alarm).when > Date.now());
  assert.ok(h.scheduled.get(alarm).when < Date.now() + 1200000);
  const before = h.calls.filter(call => call.method === 'POST').length;
  await h.alarm(alarm);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, before + 1);
  assert.ok(h.session.journey.events.some(event => event.type === 'context_renewed' && event.source === 'automatic'));
  assert.ok(h.scheduled.has(alarm));
  await h.command({ kind: 'stop' });
  assert.equal(h.scheduled.has(alarm), false);
  const after = h.calls.length;
  await h.alarm(alarm);
  assert.equal(h.calls.length, after);
});

test('automatic renewal refuses a foreign declaration and does not keep retrying', async () => {
  const h = createHarness();
  await h.start();
  h.external.context = 'run=foreign;agent=fixture-agent;role=tester';
  const before = h.calls.filter(call => call.method === 'POST').length;
  await h.alarm(alarm);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, before);
  assert.equal(h.session.journey.contextRenewalStatus, 'failed');
  assert.equal(h.scheduled.has(alarm), false);
  assert.ok(h.notices.some(notice => notice.level === 'error'));
});

test('service worker startup re-arms an active recording and leaves stopped state idle', async () => {
  const first = createHarness();
  await first.start();
  const second = createHarness({ session: first.session });
  await second.idle();
  assert.ok(second.scheduled.has(alarm));
  const stopped = createHarness({ session: { finished: first.session.journey } });
  await stopped.idle();
  assert.equal(stopped.scheduled.size, 0);
  assert.equal(stopped.calls.length, 0);
});

test('installed native helper crash refuses Start rather than silently recording standalone', async () => {
  const h = createHarness({ settings: { safeyoloKey: '' }, nativeMessage: async () => { throw new Error('Native host has exited.'); } });
  const answer = await h.start();
  assert.match(answer.error, /helper connection failed/);
  assert.equal(h.session.journey, undefined);
});

test('missing native host is optional, and no-token helper preserves manual key integration', async () => {
  const absent = createHarness({ settings: { safeyoloKey: '' }, nativeMessage: async () => { throw new Error('Specified native messaging host not found.'); } });
  assert.equal((await absent.start()).safeyolo.enabled, false);
  const manual = createHarness({ nativeMessage: async () => ({ available: false }) });
  assert.equal((await manual.start()).safeyolo.mode, 'key');
  assert.ok(manual.calls.some(call => call.method === 'POST'));
});

test('worker recovery does not retry an unconfirmed renewal', async () => {
  const first = createHarness();
  await first.start();
  first.session.journey.contextRenewalStatus = 'unconfirmed';
  const second = createHarness({ session: first.session });
  await second.idle();
  assert.equal(second.scheduled.size, 0);
  assert.equal(second.calls.length, 0);
});

test('configured API keys are scrubbed from event storage and ordinary status/Stop exports', async () => {
  const keys = ['fixture-key', 'fixture-jev-key', 'fixture-llm-key'];
  const h = createHarness({ settings: { jevKey: keys[1], llmKey: keys[2] } });
  await h.start();
  await h.command({ kind: 'page-event', event: { type: 'fill', filled: [], manual: [],
    classifyError: keys.join(' '), nested: { [keys[2]]: keys[1] } } });
  const status = await h.command({ kind: 'status' });
  const stopped = await h.command({ kind: 'stop' });
  for (const value of [h.session, status, stopped.finished]) for (const key of keys) assert.equal(JSON.stringify(value).includes(key), false);
  assert.ok(JSON.stringify(stopped.finished).includes('API credential redacted'));
});

test('missing inference configuration is readiness information and does not block standalone recording', async () => {
  const h = createHarness({ settings: { safeyoloMode: 'off' } });
  const readiness = await h.command({ kind: 'inference-settings-check' });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.error, undefined);
  assert.ok(readiness.reason);
  assert.equal((await h.start()).contextStatus, 'active');
});

test('a stalled native response or manual response body has a bounded failure without a declaration', async () => {
  for (const mode of ['native', 'manual-body']) {
    const nominal = [];
    const h = createHarness({ setTimeout: (callback, ms) => { nominal.push(ms); return setTimeout(callback, Math.min(ms, 5)); },
      ...(mode === 'native' ? { nativeMessage: () => new Promise(() => {}) } : { textHook: () => new Promise(() => {}) }) });
    const result = await h.start();
    assert.ok(result.error);
    assert.equal(h.session.journey, undefined);
    assert.equal(h.calls.some(call => call.method === 'POST'), false);
    assert.ok(nominal.includes(20000));
  }
});
