const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {BrowserWorker} = require('../src/treadway/browser/browser-worker');
const {connectSession, observeSession} = require('../src/treadway/browser/connection');
const {makeCdpClient} = require('../src/treadway/browser/cdp');
const {connectEndpoint} = require('../src/treadway/browser/remote-transport');
const {protocolFixture} = require('./remote-protocol-fixture');

async function fixture(t) {
  const service = await protocolFixture(t, {sharedBrowser: true});
  const operator = makeCdpClient(await connectEndpoint(service.endpoint));
  const contextId = (await operator.send('Target.createBrowserContext')).browserContextId;
  const targetId = (await operator.send('Target.createTarget', {browserContextId: contextId, url: 'about:blank'})).targetId;
  const sessionId = (await operator.send('Target.attachToTarget', {targetId, flatten: true})).sessionId;
  await operator.send('Runtime.evaluate', {expression: 'save:operator-state'}, {sessionId});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-borrowed-'));
  const worker = new BrowserWorker({root, projectId: 'project-a', runId: 'run-one'});
  await worker.start();
  t.after(async () => { await worker.shutdown(); operator.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {service, worker, operator, sessionId, contextId, targetId};
}

test('borrowed drive uses exact target and detaches without creating or deleting operator resources', async t => {
  const {service, worker, operator, sessionId, contextId, targetId} = await fixture(t);
  const before = service.seen.length;
  const {connection, capabilities} = await worker.acquire({actor: 'member', endpoint: service.endpoint, mode: 'borrowed',
    borrowed: {contextId, targetId, scope: 'context', permission: 'drive'}});
  assert.equal(capabilities.freshContext, false);
  const browser = await connectSession(connection);
  assert.equal(await browser.eval('read'), 'operator-state');
  await browser.eval('save:borrowed-edit');
  browser.close();
  const cleanup = await worker.release(connection);
  assert.equal(cleanup.attachmentDetached, true);
  assert.equal(cleanup.contextDisposed, false);
  assert.equal(cleanup.complete, true);
  assert.equal((await operator.send('Runtime.evaluate', {expression: 'read'}, {sessionId})).result.value, 'borrowed-edit');
  assert.equal(service.seen.slice(before).some(event => ['Target.createTarget', 'Target.createBrowserContext',
    'Target.disposeBrowserContext', 'Target.closeTarget', 'Browser.close'].includes(event.method)), false);
});

test('borrowed observation cannot initialize JavaScript or promote itself to driving', async t => {
  const {service, worker, contextId, targetId} = await fixture(t);
  const {connection} = await worker.acquire({actor: 'observer', endpoint: service.endpoint, mode: 'borrowed',
    borrowed: {contextId, targetId, scope: 'context', permission: 'observe'}});
  const before = service.seen.length;
  await assert.rejects(connectSession(connection), /remote_observation_entry_required/);
  // Closing a rejected initialization releases only that IPC attachment.
  await new Promise(resolve => setTimeout(resolve, 20));
  const browser = await observeSession(connection);
  assert.deepEqual(await browser.cdp.send('Storage.getCookies'), {cookies: []});
  await assert.rejects(browser.cdp.send('Runtime.evaluate', {expression: 'save:forbidden'}), /remote_observation_only/);
  await assert.rejects(browser.cdp.send('Storage.setCookies', {cookies: []}), /remote_observation_only/);
  await assert.rejects(browser.cdp.send('Browser.close'), /remote_observation_only/);
  browser.close();
  assert.equal(service.seen.slice(before).some(event => event.method === 'Runtime.evaluate'), false);
  assert.deepEqual(service.writes, ['operator-state']);
});

test('wrong context, missing target and undeclared scope never cause a fresh allocation or adoption', async t => {
  const {service, worker, contextId, targetId} = await fixture(t);
  const before = service.seen.length;
  await assert.rejects(worker.acquire({actor: 'wrong-context', endpoint: service.endpoint, mode: 'borrowed',
    borrowed: {contextId: 'foreign', targetId, scope: 'context', permission: 'drive'}}), /remote_target_context_differs/);
  await assert.rejects(worker.acquire({actor: 'missing', endpoint: service.endpoint, mode: 'borrowed',
    borrowed: {contextId, targetId: 'missing', scope: 'context', permission: 'drive'}}), /remote_target_context_differs/);
  await assert.rejects(worker.acquire({actor: 'no-scope', endpoint: service.endpoint, mode: 'borrowed',
    borrowed: {contextId, targetId, permission: 'drive'}}), /remote_borrowed_binding_required/);
  assert.equal(service.seen.slice(before).some(event => ['Target.createTarget', 'Target.createBrowserContext',
    'Target.disposeBrowserContext', 'Target.getTargets'].includes(event.method)), false);
});

test('a page replaced after acquisition is not adopted at the operation boundary', async t => {
  const {service, worker, contextId, targetId} = await fixture(t);
  const {connection} = await worker.acquire({actor: 'member', endpoint: service.endpoint, mode: 'borrowed',
    borrowed: {contextId, targetId, scope: 'context', permission: 'drive'}});
  // Model an operator closing the selected page while a different page remains.
  service.browsers[0].targets.delete(targetId);
  service.browsers[0].targets.set('replacement', {targetId: 'replacement', type: 'page', browserContextId: contextId});
  const before = service.seen.length;
  await assert.rejects(connectSession(connection), /remote_target_context_differs/);
  const cleanup = await worker.release(connection);
  assert.equal(cleanup.contextDisposed, false);
  assert.equal(service.browsers[0].targets.has('replacement'), true);
  assert.equal(service.seen.slice(before).some(event => ['Target.createTarget', 'Target.getTargets',
    'Target.attachToTarget', 'Target.disposeBrowserContext', 'Browser.close'].includes(event.method)), false);
});

test('borrowed unknown write stays quarantined after detach and is never replayed', async t => {
  const {service, worker, operator, sessionId, contextId, targetId} = await fixture(t);
  const {connection} = await worker.acquire({actor: 'member', endpoint: service.endpoint, mode: 'borrowed',
    borrowed: {contextId, targetId, scope: 'context', permission: 'drive'}});
  const browser = await connectSession(connection);
  await assert.rejects(browser.cdp.send('Runtime.evaluate', {expression: 'lose-reply'}, {timeoutMs: 50}), /unknown|timed out/);
  browser.close();
  const cleanup = await worker.release(connection);
  assert.equal(cleanup.contextDisposed, false);
  assert.equal(cleanup.uncertainDispatches, true);
  assert.deepEqual(service.writes, ['operator-state', 'committed']);
  assert.equal((await operator.send('Runtime.evaluate', {expression: 'read'}, {sessionId})).result.value, 'committed');
  await assert.rejects(connectSession(connection), /remote_session_unavailable/);
  assert.deepEqual(service.writes, ['operator-state', 'committed']);
});

test('an explicitly observational connection remains read-only even when the actor can drive', async t => {
  const {service, worker, contextId, targetId} = await fixture(t);
  const {connection} = await worker.acquire({actor: 'member', endpoint: service.endpoint, mode: 'borrowed',
    borrowed: {contextId, targetId, scope: 'context', permission: 'drive'}});
  const browser = await observeSession(connection);
  await assert.rejects(browser.cdp.send('Runtime.evaluate', {expression: 'save:forbidden'}),
    error => error.code === 'remote_observation_only' && error.outcome === 'not_dispatched');
  browser.close();
  assert.deepEqual(service.writes, ['operator-state']);
});

test('release with an in-flight command records uncertainty before closing its client', async t => {
  const {service, worker, contextId, targetId} = await fixture(t);
  const {connection} = await worker.acquire({actor: 'member', endpoint: service.endpoint, mode: 'borrowed',
    borrowed: {contextId, targetId, scope: 'context', permission: 'drive'}});
  const browser = await connectSession(connection);
  const pending = browser.cdp.send('Runtime.evaluate', {expression: 'lose-reply'}, {timeoutMs: 1000}).then(
    () => ({unexpected: true}), () => ({incomplete: true}));
  const deadline = performance.now() + 1000;
  while (service.writes.length < 2) {
    assert.ok(performance.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5));
  }
  const cleanup = await worker.release(connection);
  assert.equal(cleanup.uncertainDispatches, true);
  assert.equal(cleanup.contextDisposed, false);
  assert.deepEqual(await pending, {incomplete: true});
  assert.deepEqual(service.writes, ['operator-state', 'committed']);
});
