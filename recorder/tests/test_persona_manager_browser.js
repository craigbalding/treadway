'use strict';
// Real unpacked-extension UI and agent completion against an owned local
// Chromium fixture. No target application or external provider is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let playwright;
try { playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright'); } catch (_) {}
if (!playwright && process.env.RECORDER_REQUIRE_BROWSER === '1') throw new Error('playwright is required for persona manager browser checks');
const extension = path.join(__dirname, '..');
const fixture = { personas: [
  { id: 'alpha', role: 'applicant', label: 'Alex Example', referenceDate: '2026-11-24',
    facts: { given_name: 'Alex', family_name: 'Example', email: 'alex@example.test', city: 'Original Town' },
    credentials: { password: 'NeverChangeFixture!7' },
    description: 'Alex is currently employed at Example Academy and seeks occasional assessment work while retaining a regular teaching role.',
    preferences: { minimum_remote_days: 2 }, histories: { education: [{ id: 'degree-a', institution: 'Example Academy', qualification: 'Honours bachelor', awardDate: '2005-06-30' }] } },
  { id: 'beta', role: 'reviewer', label: 'Sam Sample', facts: { given_name: 'Sam', email: 'sam@example.test' },
    description: 'Sam reviews synthetic applications for a fictional service and is available for a mixture of home and office work.' },
] };

async function proxyFixture() {
  let context = null;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://' + request.headers.host); let body = '';
    request.on('data', part => body += part);
    request.on('end', () => {
      const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.hostname === '_safeyolo.proxy.internal') {
        if (request.method === 'GET') return json(200, { agent: 'browser-agent', context });
        if (request.method === 'DELETE') { context = null; return json(200, { status: 'cleared' }); }
        const declaration = JSON.parse(body); context = Object.fromEntries(declaration.context.split(';').map(part => part.split('=')));
        return json(200, { agent: 'browser-agent', context, expires_in: declaration.ttl });
      }
      if (url.hostname === 'app.example.test') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        return response.end('<!doctype html><label>Given name<input name="givenName" autocomplete="given-name"></label><button onclick="window.submissions=(window.submissions||0)+1">Save</button>');
      }
      response.writeHead(404); response.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}
async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
  throw new Error(message);
}

for (const mode of ['downloads', 'folder']) {
test('persona manager creates, edits, enriches and fills through the extension in ' + mode + ' mode', { skip: !playwright, timeout: 90000 }, async t => {
  const local = await proxyFixture();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-persona-ui-'));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-persona-downloads-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
  let browser, panel, complete = false;
  t.after(async () => {
    if (!complete && panel) t.diagnostic(await panel.evaluate(() => ({ messages: document.querySelector('#messages')?.textContent,
      work: document.querySelector('#persona-work-status')?.textContent, editor: document.querySelector('#persona-editor-state')?.textContent })).catch(e => ({ error: e.message })));
    await browser?.close(); local.server.closeAllConnections(); local.server.close(); fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(downloads, { recursive: true, force: true });
  });
  browser = await playwright.chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', chromiumSandbox: true,
    ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}),
    proxy: { server: 'http://127.0.0.1:' + local.port, bypass: '<-loopback>' },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging'] });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  await worker.evaluate(async ({ text, mode }) => chrome.storage.local.set({ personaText: text, captureStorage: mode,
    settings: { safeyoloKey: 'fixture-agent-key', jevKey: '', ttlMinutes: 20, recordSecrets: false } }), { text: JSON.stringify(fixture), mode });
  const browserCDP = await browser.browser().newBrowserCDPSession();
  await browserCDP.send('Browser.setDownloadBehavior', { behavior: 'default' }); await browserCDP.detach();
  panel = await browser.newPage(); const errors = []; panel.on('pageerror', e => errors.push(e.message));
  await panel.goto('chrome-extension://' + id + '/sidepanel.html');
  if (mode === 'folder') {
    await panel.evaluate(async text => {
      const dir = await navigator.storage.getDirectory();
      const out = await (await dir.getFileHandle('personas.json', { create: true })).createWritable(); await out.write(text); await out.close();
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('treadway-recorder', 1); r.onupgradeneeded = () => r.result.createObjectStore('handles'); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
      await new Promise((resolve, reject) => { const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').put(dir, 'folder'); tx.oncomplete = resolve; tx.onerror = reject; }); db.close();
    }, JSON.stringify(fixture)); await panel.reload();
  }
  const read = () => panel.evaluate(async mode => {
    if (mode === 'downloads') return JSON.parse((await chrome.storage.local.get('personaText')).personaText);
    const dir = await navigator.storage.getDirectory(); return JSON.parse(await (await (await dir.getFileHandle('personas.json')).getFile()).text());
  }, mode);
  const requestPath = async requestId => {
    let file;
    await until(async () => {
      const items = await worker.evaluate(id => chrome.downloads.search({ filenameRegex: id }), requestId);
      file = items.find(item => item.state === 'complete')?.filename; return file && fs.existsSync(file);
    }, 'persona request was not exported');
    return file;
  };
  await panel.locator('[data-inspect-persona="alpha"]').waitFor({ state: 'attached' });
  await panel.locator('#persona-manager summary').first().click();
  await panel.locator('[data-inspect-persona="alpha"]').click();
  await panel.locator('[data-persona-field="/facts/city"]').fill('Operator Town');
  await panel.locator('#persona-edit-description').fill(fixture.personas[0].description + ' Alex requires at least two working days at home each week.');
  await panel.locator('#persona-save').click();
  await until(async () => (await panel.locator('#persona-editor-state').textContent()).includes('Revision 2'), 'manual correction save not acknowledged');
  await until(async () => (await read()).personas[0].facts.city === 'Operator Town', 'manual correction not persisted');
  let alpha = (await read()).personas[0];
  assert.equal(alpha.revision, 2); assert.equal(alpha.credentials.password, 'NeverChangeFixture!7');
  assert(alpha.overrides.includes('/facts/city'));

  await panel.locator('[data-persona-id="alpha"]').check();
  await panel.locator('[data-persona-id="beta"]').check();
  await panel.locator('#persona-brief').fill('A fictional recruitment service accepts applicants and reviewers.');
  await panel.locator('#persona-instructions').fill('Add concrete education and availability context while preserving my corrections.');
  await panel.locator('#persona-enrich').click();
  await until(async () => (await panel.locator('#persona-work-status').textContent()).includes('Waiting for your agent'), 'work not queued');
  const pending = await panel.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'persona-work-status' })).request);
  assert.equal(pending.operation, 'enrich'); assert.deepEqual(pending.personaIds.sort(), ['alpha', 'beta']);
  await panel.evaluate(requestId => globalThis.treadwayAcknowledgePersonaWork({ requestId }), pending.requestId);
  await until(async () => (await panel.locator('#persona-work-status').textContent()).includes('Agent acknowledged'), 'acknowledgement not shown');
  const current = (await read()).personas;
  const candidates = current.map(p => ({ ...p, facts: { ...p.facts, ...(p.id === 'alpha' ? { city: 'Agent Town', qualification_level: 'Honours bachelor' } : { availability: 'Three days per week' }) } }));
  // Use the same owned-session completion CLI the paired agent uses.
  const [port, browserPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
  const sessionFile = path.join(profile, 'owned-session.json');
  fs.writeFileSync(sessionFile, JSON.stringify({ session: { generation: 'persona-manager-fixture', port: Number(port), browser_path: browserPath } }));
  const payload = path.join(profile, 'candidates.json'); fs.writeFileSync(payload, JSON.stringify({ personas: candidates }));
  const requestFile = await requestPath(pending.requestId);
  assert.equal(fs.readFileSync(requestFile, 'utf8').includes('NeverChangeFixture!7'), false, 'request must not export credentials');
  const bridge = await import(pathToFileURL(path.join(extension, 'assist.mjs')).href);
  const watched = await bridge.watch(path.dirname(requestFile), { timeout: 0.2, interval: 0.01 });
  assert.equal(watched.requestId, pending.requestId, 'normal harness watcher must discover the exported persona request');
  const completed = await bridge.complete(requestFile, sessionFile, payload);
  assert.equal(completed.requestId, pending.requestId);
  await panel.locator('#persona-apply-reviewed').waitFor();
  const cityChange = panel.locator('[data-proposal-path="/facts/city"]');
  assert.equal(await cityChange.isChecked(), false, 'operator correction must not be preselected for replacement');
  await panel.locator('#persona-apply-reviewed').click();
  await until(async () => (await panel.locator('#persona-work-status').textContent()).includes('Persona work complete'), 'enrichment save not acknowledged');
  await until(async () => (await read()).personas[0].facts.qualification_level === 'Honours bachelor', 'accepted additions missing');
  alpha = (await read()).personas[0];
  assert.equal(alpha.facts.city, 'Operator Town'); assert.equal(alpha.credentials.password, 'NeverChangeFixture!7');
  assert.equal((await read()).personas[1].facts.availability, 'Three days per week');

  // A queued request can be cancelled, and a late completion cannot write.
  await panel.locator('#persona-enrich').click();
  await until(async () => (await panel.locator('#persona-work-status').textContent()).includes('Waiting for your agent'), 'second request missing');
  const cancelled = await panel.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'persona-work-status' })).request);
  await panel.locator('#persona-cancel-work').click();
  const beforeCancel = JSON.stringify(await read());
  const late = await panel.evaluate(async ({ requestId, personas }) => {
    try { await globalThis.treadwayCompletePersonaWork({ requestId, personas }); return null; } catch (e) { return e.message; }
  }, { requestId: cancelled.requestId, personas: (await read()).personas });
  assert(late); assert.equal(JSON.stringify(await read()), beforeCancel);
  const cancelledReceipt = await bridge.complete(await requestPath(cancelled.requestId), sessionFile, payload);
  assert.equal(cancelledReceipt.status, 'cancelled'); assert.equal(JSON.stringify(await read()), beforeCancel);

  // Agent-backed creation is a real work request, review and persistence path.
  await panel.locator('#persona-actor').fill('part time applicant');
  await panel.locator('#persona-new').click();
  await panel.locator('#persona-edit-id').fill('agent-created');
  let facts = panel.locator('[data-path="/facts"]');
  await facts.locator('input[aria-label="New field in /facts"]').fill('email');
  await facts.getByRole('button', { name: 'Add field', exact: true }).click();
  await panel.locator('[data-persona-field="/facts/email"]').fill('riley.new@example.test');
  await panel.locator('#persona-create-agent').click();
  await until(async () => (await panel.locator('#persona-work-status').textContent()).includes('Waiting for your agent'), 'create request missing');
  const creation = await panel.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'persona-work-status' })).request);
  assert.equal(creation.operation, 'create');
  assert.equal(creation.actor, 'part time applicant'); assert.equal(creation.personas[0].role, 'participant');
  const createFile = await requestPath(creation.requestId);
  assert.equal((await bridge.watch(path.dirname(createFile), { timeout: 0.2, interval: 0.01 })).requestId, creation.requestId);
  await bridge.acknowledge(createFile, sessionFile);
  const created = { ...creation.personas[0], label: 'Riley Generated',
    description: 'Riley currently teaches at Example Academy and seeks additional assessment work. Riley needs at least two days working from home each week.',
    facts: { ...creation.personas[0].facts, given_name: 'Riley', family_name: 'Generated' },
    preferences: { minimum_remote_days: 2 },
    credentials: { password: 'GeneratedFixture!9', new_password: 'GeneratedFixture!9' },
    secrets: { password: 'RILEY_TEST_PASSWORD', new_password: 'RILEY_TEST_PASSWORD' } };
  fs.writeFileSync(payload, JSON.stringify({ personas: [created] }));
  await bridge.complete(createFile, sessionFile, payload);
  await panel.locator('#persona-apply-reviewed').click();
  await until(async () => (await panel.locator('#persona-work-status').textContent()).includes('Persona work complete'), 'creation save not acknowledged');
  await until(async () => (await read()).personas.some(p => p.id === 'agent-created'), 'agent-created persona not saved');
  const savedNew = (await read()).personas.find(p => p.id === 'agent-created');
  assert.equal(savedNew.label, 'Riley Generated'); assert.equal(savedNew.facts.email, 'riley.new@example.test');
  assert.equal(savedNew.credentials.password, 'GeneratedFixture!9'); assert.equal(savedNew.preferences.minimum_remote_days, 2);

  // Editable creation is available without asking an agent or pasting JSON.
  await panel.locator('#persona-new').click();
  await panel.locator('#persona-edit-id').fill('manual-persona');
  await panel.locator('#persona-edit-role').fill('operator-test');
  await panel.locator('#persona-edit-label').fill('Morgan Manual');
  facts = panel.locator('[data-path="/facts"]');
  await facts.locator('input[aria-label="New field in /facts"]').fill('given_name');
  await facts.getByRole('button', { name: 'Add field', exact: true }).click();
  await panel.locator('[data-persona-field="/facts/given_name"]').fill('Morgan');
  await panel.locator('#persona-save').click();
  await until(async () => (await panel.locator('#persona-editor-state').textContent()).includes('Revision 1'), 'draft save not acknowledged');
  await until(async () => (await read()).personas.some(p => p.id === 'manual-persona'), 'manual persona not saved');
  await panel.evaluate(async () => chrome.storage.local.set({ personaCredentials: {
    [JSON.stringify(['manual-persona', 'operator-test', '', ''])]: { password: 'RetainedCacheFixture!1', reference: 'MANUAL_TEST_PASSWORD' } } }));
  facts = panel.locator('[data-path="/facts"]');
  await facts.locator('input[aria-label="New field in /facts"]').fill('email');
  await facts.getByRole('button', { name: 'Add field', exact: true }).click();
  await panel.locator('[data-persona-field="/facts/email"]').fill('morgan.manual@example.test');
  await panel.locator('#persona-save').click();
  await until(async () => (await panel.locator('#persona-editor-state').textContent()).includes('Revision 2'), 'missing contact addition not acknowledged');
  const bound = (await read()).personas.find(p => p.id === 'manual-persona');
  assert.equal(bound.role, 'operator-test');
  assert.equal(bound.facts.email, 'morgan.manual@example.test'); assert.equal(bound.credentials.password, 'RetainedCacheFixture!1');
  assert.equal(bound.secrets.password, 'MANUAL_TEST_PASSWORD');
  await panel.locator('#persona').selectOption('manual-persona');
  await panel.locator('#journey-name').fill('Populate synthetic profile'); await panel.locator('#start').click();
  await until(async () => !(await panel.locator('#fill').isDisabled()), 'journey not active');
  const app = await browser.newPage(); await app.goto('http://app.example.test/profile'); await app.bringToFront();
  await panel.locator('#fill').click();
  await until(async () => await app.locator('input').inputValue() === 'Morgan', 'normal Fill all did not use created persona');
  await until(async () => (await panel.locator('#messages').textContent()).includes('Filled 1 field(s)'), 'Fill all report not acknowledged');
  assert.equal((await read()).personas.find(p => p.id === 'manual-persona').credentials.password, 'RetainedCacheFixture!1');
  assert.equal(await app.evaluate(() => window.submissions || 0), 0);
  assert.deepEqual(errors, []);
  complete = true;
});
}
