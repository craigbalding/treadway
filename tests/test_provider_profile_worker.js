const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {protocolFixture} = require('./remote-protocol-fixture');
const {BrowserWorker} = require('../src/treadway/browser/browser-worker');
const {connectSession} = require('../src/treadway/browser/connection');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function fixture(t) {
  const service = await protocolFixture(t, {profileSupport: true});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-provider-'));
  const worker = new BrowserWorker({root, projectId: 'project-one', runId: 'run-one', cleanupMs: 200});
  await worker.start();
  t.after(async () => { await worker.shutdown(); fs.rmSync(root, {recursive: true, force: true}); });
  const body = {ttl: 180000, processKeepAlive: 0, headless: true, browser: 'chromium'};
  const reply = await fetch(service.sessionApi, {method: 'POST', body: JSON.stringify(body)});
  const session = await reply.json();
  const file = path.join(root, 'provider-http-' + crypto.randomUUID() + '.json');
  fs.writeFileSync(file, JSON.stringify({version: 'treadway.browserless-http/1', method: 'POST', requestBody: body,
    status: 201, complete: true, outcome: 'replied', responseBodyBase64: Buffer.from(JSON.stringify(session)).toString('base64')}), {mode: 0o600});
  const cap = {version: 'treadway.browserless-session/1', binding: {projectId: 'project-one'}, state: 'created',
    scope: 'isolated-provider-profile', session, creation: {file: path.basename(file), sha256: digest(file)}};
  const capability = path.join(root, 'provider-session-' + crypto.randomUUID() + '.json');
  fs.writeFileSync(capability, JSON.stringify(cap), {mode: 0o600});
  return {service, worker, capability, session, profile: {file: capability, sha256: digest(capability)}};
}

test('a verified provider profile permits owned browser shutdown and preserves unrelated clients', async t => {
  const {service, worker, session, profile} = await fixture(t);
  const {connection: sentinel} = await worker.acquire({actor: 'sentinel', endpoint: service.endpoint});
  const other = await connectSession(sentinel); await other.eval('save:unrelated'); other.close();
  const {connection} = await worker.acquire({actor: 'member', endpoint: session.connect, mode: 'provider-session', profile});
  const browser = await connectSession(connection);
  await browser.eval('save:retained-profile');
  await assert.rejects(browser.cdp.send('Browser.close'), /method_unsupported/);
  browser.close();
  const cleanup = await worker.release(connection);
  assert.equal(cleanup.profileReleased, true);
  assert.equal(cleanup.profileRetained, true);
  assert.equal(cleanup.contextDisposed, false);
  assert.equal(service.profiles.get(session.id).state.value, 'retained-profile');
  const still = await connectSession(sentinel); assert.equal(await still.eval('read'), 'unrelated'); still.close();
  assert.equal(service.seen.filter(event => event.method === 'Browser.close').length, 1);
});

test('lost profile shutdown acknowledgement remains incomplete even if its socket closed', async t => {
  const {service, worker, session, profile} = await fixture(t);
  const {connection} = await worker.acquire({actor: 'member', endpoint: session.connect, mode: 'provider-session', profile});
  service.controls.loseProfileCloseReply = true;
  const cleanup = await worker.release(connection);
  assert.equal(cleanup.connectionClosed, true);
  assert.equal(cleanup.profileReleased, false);
  assert.equal(cleanup.profileRetained, false);
  assert.equal(cleanup.complete, false);
});

test('altered, public or differently bound provenance is refused before default-profile connection', async t => {
  const {service, worker, session, profile, capability} = await fixture(t);
  const before = service.upgrades.length;
  fs.chmodSync(capability, 0o644);
  await assert.rejects(worker.acquire({actor: 'public', endpoint: session.connect, mode: 'provider-session', profile}), /profile_evidence_required/);
  fs.chmodSync(capability, 0o600);
  const value = JSON.parse(fs.readFileSync(capability)); value.binding.projectId = 'another-project';
  fs.writeFileSync(capability, JSON.stringify(value));
  await assert.rejects(worker.acquire({actor: 'changed', endpoint: session.connect, mode: 'provider-session', profile}), /profile_evidence_required/);
  await assert.rejects(worker.acquire({actor: 'foreign', endpoint: session.connect, mode: 'provider-session',
    profile: {...profile, sha256: digest(capability)}}), /profile_evidence_required/);
  assert.equal(service.upgrades.length, before);
});
