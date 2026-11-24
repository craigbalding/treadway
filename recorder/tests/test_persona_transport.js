'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const bridge = import(pathToFileURL(path.join(__dirname, '../assist.mjs')).href);
const extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const requestId = 'persona-11111111-2222-3333-4444-555555555555';
const request = () => ({ schema: 'treadway.persona-work/1', requestId, extensionId, operation: 'enrich', status: 'queued',
  personaIds: ['casey'], personas: [{ id: 'casey', role: 'applicant', revision: 1, facts: { given_name: 'Casey' } }] });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-work-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requestFile = path.join(directory, requestId + '.json'), sessionFile = path.join(directory, 'session.json'), payloadFile = path.join(directory, 'proposal.json');
  fs.writeFileSync(requestFile, JSON.stringify(request()));
  fs.writeFileSync(sessionFile, JSON.stringify({ session: { generation: 'owner-one', port: 9222, browser_path: '/devtools/browser/owned-fixture' } }));
  fs.writeFileSync(payloadFile, JSON.stringify({ personas: [{ id: 'casey', role: 'applicant', facts: { given_name: 'Casey' }, description: 'Richer context' }] }));
  return { directory, requestFile, sessionFile, payloadFile };
}
function connection(t, handlers, options = {}) {
  const previous = globalThis.WebSocket; let closed = false;
  globalThis.WebSocket = class extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) {
      const message = JSON.parse(text);
      queueMicrotask(async () => {
        let result;
        if (message.method === 'Target.getTargets') result = { targetInfos: options.targets || [{ targetId: 'panel-one', url: `chrome-extension://${extensionId}/sidepanel.html` }] };
        else if (message.method === 'Target.attachToTarget') result = { sessionId: 'attached-panel' };
        else if (message.method === 'Target.detachFromTarget') result = {};
        else if (message.method === 'Runtime.evaluate') {
          try { result = { result: { value: await vm.runInNewContext(message.params.expression, { globalThis: handlers }) } }; }
          catch (error) { result = { exceptionDetails: { text: error.message } }; }
        }
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result }) }));
      });
    }
    close() { closed = true; this.dispatchEvent(new Event('close')); }
  };
  t.after(() => { globalThis.WebSocket = previous; });
  return { closed: () => closed };
}

test('watch discovers persona work and still accepts the original assistance schema', async t => {
  const f = fixture(t), { watch, readRequest } = await bridge;
  const found = await watch(f.directory, { timeout: 0.1, interval: 0.01 });
  assert.equal(found.requestId, requestId); assert.match(found.instruction, /acknowledge/); assert.match(found.instruction, /operator review/);
  const old = { schema: 'treadway.assistance/1', requestId: 'assist-1234', extensionId, run: 'test-run', target: { tabId: 1, documentInstanceId: 'doc' }, form: [] };
  fs.writeFileSync(f.requestFile, JSON.stringify(old)); assert.equal(readRequest(f.requestFile).run, 'test-run');
  fs.writeFileSync(f.requestFile, JSON.stringify({ ...request(), personaIds: ['casey', 'casey'] }));
  assert.throws(() => readRequest(f.requestFile), /Invalid persona/);
});

test('acknowledgement and proposal completion use exact paired panel helpers once', async t => {
  const f = fixture(t), { acknowledge, complete, watch } = await bridge; let status = 'pending', completions = 0;
  const c = connection(t, {
    treadwayPersonaWorkStatus: ({ requestId }) => ({ requestId, status }),
    treadwayAcknowledgePersonaWork: ({ requestId }) => ({ requestId, status: status = 'acknowledged' }),
    treadwayCompletePersonaWork: ({ requestId, personas }) => { completions++; assert.equal(personas[0].description, 'Richer context'); return { requestId, status: status = 'proposed' }; },
  });
  assert.equal((await acknowledge(f.requestFile, f.sessionFile)).status, 'acknowledged');
  assert.equal((await complete(f.requestFile, f.sessionFile, f.payloadFile)).status, 'proposed');
  assert.equal(completions, 1); assert(c.closed()); assert(fs.existsSync(f.requestFile + '.done'));
  assert.equal((await watch(f.directory, { timeout: 0.02, interval: 0.01 })).timeout, true);
});

test('cancelled, failed, completed and superseded work closes inbox without touching personas', async t => {
  const f = fixture(t), { complete } = await bridge; let status = 'cancelled', calls = 0;
  connection(t, { treadwayPersonaWorkStatus: ({ requestId }) => ({ requestId, status }),
    treadwayCompletePersonaWork: () => { calls++; throw Error('must not apply'); } });
  for (const value of ['cancelled', 'failed', 'completed', 'unknown', 'review']) {
    status = value;
    const result = await complete(f.requestFile, f.sessionFile, '/missing/payload-not-needed.json');
    assert.equal(result.status, value); assert.equal(result.terminal, true);
    assert.equal(JSON.parse(fs.readFileSync(f.requestFile + '.done')).status, value);
  }
  assert.equal(calls, 0);
});

test('changed browser generation stops mutation and uncertain status does not consume inbox', async t => {
  const f = fixture(t), { complete } = await bridge; let calls = 0;
  connection(t, { treadwayPersonaWorkStatus: ({ requestId }) => {
    fs.writeFileSync(f.sessionFile, JSON.stringify({ session: { generation: 'owner-two', port: 9222, browser_path: '/devtools/browser/owned-fixture' } }));
    return { requestId, status: 'pending' };
  }, treadwayCompletePersonaWork: () => { calls++; return { requestId, status: 'proposed' }; } });
  await assert.rejects(complete(f.requestFile, f.sessionFile, f.payloadFile), /generation changed/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(f.requestFile + '.done'), false);
});

test('unconfirmed helper failure is not retried or consumed; confirmed failed status is consumed', async t => {
  const f = fixture(t), { complete } = await bridge; let status = 'pending', calls = 0, confirmed = false;
  connection(t, { treadwayPersonaWorkStatus: ({ requestId }) => ({ requestId, status }),
    treadwayCompletePersonaWork: () => { calls++; if (confirmed) status = 'failed'; throw Error('outcome not confirmed'); } });
  await assert.rejects(complete(f.requestFile, f.sessionFile, f.payloadFile), /outcome not confirmed/);
  assert.equal(calls, 1); assert.equal(fs.existsSync(f.requestFile + '.done'), false);
  confirmed = true;
  assert.equal((await complete(f.requestFile, f.sessionFile, f.payloadFile)).status, 'failed');
  assert.equal(calls, 2); assert(fs.existsSync(f.requestFile + '.done'));
});

test('form-assistance completion keeps the existing facts-to-Fill-all bridge', async t => {
  const f = fixture(t), { complete } = await bridge;
  const old = { schema: 'treadway.assistance/1', requestId: 'assist-1234', extensionId, run: 'test-run', target: { tabId: 1, documentInstanceId: 'doc' }, form: [] };
  fs.writeFileSync(f.requestFile, JSON.stringify(old)); fs.writeFileSync(f.payloadFile, JSON.stringify({ full_name: 'Casey Example' }));
  connection(t, { treadwayCompleteAssistance: ({ requestId, facts }) => ({ requestId, filled: facts.full_name ? 1 : 0 }) });
  assert.equal((await complete(f.requestFile, f.sessionFile, f.payloadFile)).filled, 1);
});
