'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
let playwright;
try { playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright'); } catch (_) { /* Explicitly skipped without browser dependencies. */ }
const extension = path.resolve(__dirname, '..');
async function until(check, timeout = 12000) {
  const deadline = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); } while (Date.now() < deadline);
  throw new Error('Fixture observation timed out');
}
test('owned live stream catches late saved events, resumes privately and stops at generation change', { timeout: 60000 }, async t => {
  if (!playwright) { if (process.env.RECORDER_REQUIRE_BROWSER) assert.fail('Playwright required'); t.skip('Playwright unavailable'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-stream-'));
  const profile = path.join(directory, 'profile'); const file = path.join(directory, 'live.jsonl'); const sessionFile = path.join(directory, 'session.json');
  const proxy = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  let context, child;
  const stop = async () => { if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } child = null; };
  t.after(async () => { await stop(); await context?.close(); proxy.closeAllConnections(); proxy.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  context = await playwright.chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', chromiumSandbox: true,
    ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}),
    proxy: { server: 'http://127.0.0.1:' + proxy.address().port, bypass: '<-loopback>' },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--remote-debugging-port=0'] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const id = new URL(worker.url()).host;
  const [port, browserPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
  const owner = { session: { generation: 'fixture-generation', port: Number(port), browser_path: browserPath } };
  fs.writeFileSync(sessionFile, JSON.stringify(owner), { mode: 0o600 });
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ settings: { safeyoloKey: 'synthetic-agent-key', jevKey: 'synthetic-jev-key' } });
    await chrome.storage.session.set({ journey: { journey: 'Local stream fixture', contextFields: { run: 'sample-live-run' },
      persona: { id: 'sample-person', secrets: {} }, startedAt: '2026-11-24T10:00:00Z', revision: 1,
      // Keep unrelated Chromium startup traffic outside this injected protocol
      // fixture; real Start/Stop/network handling is covered by contract tests.
      contextStatus: 'fixture', events: [{ eventId: 'sample-live-run:e1', type: 'marker', name: 'Initial' }] }, requests: {} });
  });
  const panel = await context.newPage(); await panel.goto('chrome-extension://' + id + '/sidepanel.html');
  let stderr = '';
  const start = () => {
    child = spawn(process.execPath, [path.join(extension, 'stream.mjs'), sessionFile, file, id, '40'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', data => { stderr += data; });
  };
  const lines = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  start(); await until(() => lines().some(item => item.eventId === 'sample-live-run:e1'));
  await until(async () => (await panel.locator('#live-output-status').textContent()).includes('connected'));
  const began = Date.now();
  await worker.evaluate(() => updateJourneys(state => appendEvent(state.journey, { type: 'marker', name: 'New event' })));
  await until(() => lines().some(item => item.eventId === 'sample-live-run:e2'), 3000);
  assert(Date.now() - began < 3000, 'new journal data available without Stop+Save');
  await worker.evaluate(async () => {
    await updateJourneys(state => { state.finished = state.journey; state.journey = null; state.finished.stoppedAt = new Date().toISOString(); });
    await updateJourneys(state => { appendEvent(state.finished, { type: 'network_completed', chromeRequestId: 'sample-late' }); state.finished.lastSavedRevision = state.finished.revision; state.finished = null; });
  });
  await until(() => lines().some(item => item.schema === 'treadway.journal-state/1' && item.stream.state === 'saved'));
  assert(lines().some(item => item.eventId === 'sample-live-run:e3'));
  assert.equal((await worker.evaluate(() => chrome.storage.session.get('finished'))).finished, null);
  await stop(); const count = lines().length;
  start(); await until(() => fs.existsSync(file + '.status.json') && JSON.parse(fs.readFileSync(file + '.status.json')).state === 'connected');
  await new Promise(resolve => setTimeout(resolve, 1400));
  assert.equal(lines().length, count, 'restart does not duplicate delivered events or state');
  owner.session.generation = 'different-generation'; fs.writeFileSync(sessionFile, JSON.stringify(owner));
  await until(() => child.exitCode !== null);
  assert.equal(child.exitCode, 1, stderr);
  assert.match(stderr, /generation changed/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(new Set(lines().filter(item => item.eventId).map(item => item.eventId)).size, 3);
  assert(!fs.readFileSync(file, 'utf8').includes('synthetic-agent-key'));
  await until(async () => (await panel.locator('#live-output-status').textContent()).includes('disconnected'), 8000);
});
