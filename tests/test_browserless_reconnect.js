const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {BrowserWorker} = require('../src/treadway/browser/browser-worker');
const {connectSession, observeSession} = require('../src/treadway/browser/connection');
const {returnedEndpoint, validatePolicy} = require('../src/treadway/browser/browserless-reconnect');
const {protocolFixture} = require('./remote-protocol-fixture');

const principal = {origin: 'https://app.example.invalid', probe: '/principal', expected: {principal: 'member'}};
async function fixture(t, options = {}) {
  const service = await protocolFixture(t, {sharedBrowser: true, reconnectSupport: true});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-reconnect-'));
  const worker = new BrowserWorker({root, projectId: 'project-one', runId: 'run-one', ...options});
  await worker.start();
  t.after(async () => { await worker.shutdown(); fs.rmSync(root, {recursive: true, force: true}); });
  return {worker, service, root};
}
const enabled = {allowedOrigins: []};
async function idle(worker, actor = 'member') {
  const deadline = performance.now() + 1000;
  while (worker.actors.get(actor).client) {
    assert.ok(performance.now() < deadline, 'previous operation did not detach');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('returned capabilities preserve opaque query parameters and require explicit authority/auth policy', () => {
  const source = 'wss://browser.example.invalid/chromium?token=launch-secret';
  const raw = 'wss://browser.example.invalid/reconnect/one?x=%2B+&x=2&sig=a%2fb';
  assert.equal(returnedEndpoint(raw, source, enabled, 'synthetic+token').endpoint, raw + '&token=synthetic%2Btoken');
  assert.equal(returnedEndpoint(raw + '&token=synthetic', source, enabled, 'synthetic').endpoint, raw + '&token=synthetic');
  assert.throws(() => returnedEndpoint(raw + '&token=other', source, enabled, 'synthetic'), /auth_conflict/);
  assert.throws(() => returnedEndpoint(raw + '&token=synthetic&token=synthetic', source, enabled, 'synthetic'), /auth_conflict/);
  assert.throws(() => returnedEndpoint('wss://other.example.invalid/private', source, enabled), /authority_refused/);
  assert.throws(() => returnedEndpoint(source, source, enabled), /launch_endpoint_refused/);
  assert.throws(() => returnedEndpoint('ws://other.example.invalid/private', source,
    {allowedOrigins: ['ws://other.example.invalid']}), /tls_downgrade/);
  assert.equal(returnedEndpoint('wss://other.example.invalid/private', source,
    {allowedOrigins: ['wss://other.example.invalid']}).sameOrigin, false);
  assert.throws(() => validatePolicy({allowedOrigins: ['wss://browser.example.invalid/path']}), /policy_invalid/);
});

test('reconnect is opt-in; no extension call or capability is created implicitly', async t => {
  const {worker, service} = await fixture(t);
  const {connection} = await worker.acquire({actor: 'member', endpoint: service.endpoint});
  await assert.rejects(worker.prepareReconnect(connection), /not_enabled/);
  assert.equal(service.seen.find(event => event.method === 'Target.createBrowserContext').params.disposeOnDetach, true);
  assert.equal(service.seen.some(event => event.method === 'Browserless.reconnect'), false);
});

test('explicit reconnect uses the returned URL once and retains exact generation, page and state', async t => {
  const {worker, service, root} = await fixture(t);
  const {connection} = await worker.acquire({actor: 'member', endpoint: service.endpoint, reconnect: enabled,
    headers: {Authorization: 'Bearer synthetic'}});
  const browser = await connectSession(connection);
  await browser.eval('save:retained'); browser.close();
  await idle(worker);
  const prepared = await worker.prepareReconnect(connection, {timeoutMs: 3000, token: 'synthetic'});
  assert.equal(JSON.stringify(prepared).includes('ws:'), false);
  const capabilityFile = path.join(root, 'reconnect-' + prepared.reference + '.json');
  assert.equal(fs.statSync(capabilityFile).mode & 0o077, 0);
  assert.equal(fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').includes('Bearer synthetic'), false);
  assert.deepEqual(await worker.reconnect(connection, {principal}), {reconnected: true, generation: connection.generation,
    principalVerified: true, reconciliationRequired: false});
  const after = await connectSession(connection);
  assert.equal(await after.eval('read'), 'retained'); after.close();
  await idle(worker);
  assert.deepEqual(service.upgrades.map(item => item.url), ['/tenant/chromium?token=synthetic',
    '/reconnect/exact?existing=%2B+&x=1&x=2&token=synthetic']);
  assert.equal(service.seen.filter(event => event.method === 'Target.createBrowserContext').length, 1);
  assert.equal(service.seen.find(event => event.method === 'Target.createBrowserContext').params.disposeOnDetach, false);
  assert.equal(service.seen.filter(event => event.method === 'Target.createTarget').length, 1);
  assert.deepEqual(service.writes, ['retained']);
  await assert.rejects(worker.reconnect(connection, {principal}), /capability_unavailable/);
});

test('changed target or principal refuses reconnect without selecting a replacement page', async t => {
  for (const changed of ['target', 'principal']) {
    const {worker, service} = await fixture(t);
    const {connection} = await worker.acquire({actor: changed, endpoint: service.endpoint, reconnect: enabled});
    await worker.prepareReconnect(connection, {timeoutMs: 3000});
    if (changed === 'target') service.browsers[0].targets.delete(worker.actors.get(changed).targetId);
    else service.controls.principal = 'another-member';
    await assert.rejects(worker.reconnect(connection, {principal}), changed === 'target' ? /target_context_differs/ : /actual_principal_differs/);
    await assert.rejects(connectSession(connection), /session_unavailable/);
    assert.equal(service.seen.some(event => event.method === 'Target.getTargets'), false);
    assert.equal(service.seen.filter(event => event.method === 'Target.createTarget').length, 1);
    const cleanup = await worker.release(connection);
    assert.equal(cleanup.contextDisposed, changed === 'principal');
  }
});

test('a missing write reply stays quarantined after successful reconnect and is never replayed', async t => {
  const {worker, service} = await fixture(t);
  const {connection} = await worker.acquire({actor: 'member', endpoint: service.endpoint, reconnect: enabled});
  await worker.prepareReconnect(connection, {timeoutMs: 3000});
  const browser = await connectSession(connection);
  await assert.rejects(browser.cdp.send('Runtime.evaluate', {expression: 'lose-reply'}, {timeoutMs: 30}));
  browser.close(); await idle(worker);
  const restored = await worker.reconnect(connection, {principal});
  assert.equal(restored.reconciliationRequired, true);
  await assert.rejects(connectSession(connection), /reconciliation_required/);
  const observer = await observeSession(connection);
  await observer.cdp.send('Storage.getCookies'); observer.close();
  assert.deepEqual(service.writes, ['committed']);
});

test('reconnect can retire an orphaned pending command without waiting for its deadline or clearing uncertainty', async t => {
  const {worker, service} = await fixture(t);
  const {connection} = await worker.acquire({actor: 'member', endpoint: service.endpoint, reconnect: enabled});
  await worker.prepareReconnect(connection, {timeoutMs: 3000});
  const browser = await connectSession(connection);
  const pending = browser.cdp.send('Runtime.evaluate', {expression: 'lose-reply'}, {timeoutMs: 5000}).catch(() => 'unknown');
  const deadline = performance.now() + 1000;
  while (!service.writes.length) {
    assert.ok(performance.now() < deadline); await new Promise(resolve => setTimeout(resolve, 1));
  }
  browser.close(); await idle(worker);
  assert.equal(worker.actors.get('member').pending.size, 1);
  const result = await worker.reconnect(connection, {principal, timeoutMs: 1000});
  assert.equal(result.reconciliationRequired, true);
  assert.equal(await pending, 'unknown');
  assert.deepEqual(service.writes, ['committed']);
  assert.equal(worker.inspect(connection).commands.at(-1).outcome, 'unknown');
  await assert.rejects(connectSession(connection), /reconciliation_required/);
});

test('expired or rejected capabilities never reconnect via the launch URL or extend the session deadline', async t => {
  const {worker, service} = await fixture(t, {sessionMs: 1000});
  const {connection} = await worker.acquire({actor: 'member', endpoint: service.endpoint, reconnect: enabled});
  const deadline = worker.actors.get('member').deadline;
  await worker.prepareReconnect(connection, {timeoutMs: 5000});
  assert.ok(worker.actors.get('member').reconnectCapability.deadline <= deadline);
  worker.actors.get('member').reconnectCapability.deadline = performance.now() - 1;
  await assert.rejects(worker.reconnect(connection, {principal}), /capability_unavailable/);
  assert.equal(service.browsers.length, 1);
  assert.equal(worker.actors.get('member').deadline, deadline);
});

test('an unsupported extension is a known refusal; an unobserved prepare reply remains uncertain', async t => {
  for (const kind of ['refused', 'unsupported', 'lost']) {
    const {worker, service} = await fixture(t);
    const {connection} = await worker.acquire({actor: 'member', endpoint: service.endpoint, reconnect: enabled});
    if (kind === 'lost') service.controls.dropReconnectReply = true;
    else if (kind === 'unsupported') service.controls.unsupportedExtension = true;
    else service.controls.reconnectError = 'Feature unavailable';
    await assert.rejects(worker.prepareReconnect(connection, {timeoutMs: 200}));
    assert.equal(worker.inspect(connection).reconciliationRequired, kind === 'lost');
    await assert.rejects(worker.reconnect(connection, {principal}), /capability_unavailable/);
    assert.equal(service.browsers.length, 1);
    assert.equal(service.seen.filter(event => event.method === 'Browserless.reconnect').length, 1);
  }
});

test('cross-authority capabilities are refused before their handshake and provider errors are kept private', async t => {
  const {worker, service, root} = await fixture(t);
  const {connection} = await worker.acquire({actor: 'member', endpoint: service.endpoint, reconnect: enabled});
  service.controls.reconnectEndpoint = 'wss://other.example.invalid/reconnect/private?token=secret-returned';
  await assert.rejects(worker.prepareReconnect(connection, {timeoutMs: 2000}), /authority_refused/);
  assert.equal(service.browsers.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').includes('secret-returned'), false);
  const retained = fs.readdirSync(root).filter(name => name.startsWith('reconnect-provider-'));
  assert.equal(retained.length, 1);
  assert.equal(fs.statSync(path.join(root, retained[0])).mode & 0o077, 0);
});
