'use strict';
// A real extension capture, then a calibrated Robot/HttpSession flow. Local only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawn } = require('node:child_process');
let playwright;
try { playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright'); } catch (_) {}
if (!playwright && process.env.RECORDER_REQUIRE_BROWSER === '1') throw Error('Playwright required');
const root = path.join(__dirname, '../..'), extension = path.join(root, 'recorder');
async function until(check) {
  const deadline = Date.now() + 15000;
  while (!await check()) { if (Date.now() > deadline) throw Error('capture-to-HTTP observation incomplete'); await new Promise(resolve => setTimeout(resolve, 100)); }
}
test('an actual standalone recording becomes an HTTP-first Robot flow with fresh-principal persistence checks',
  { skip: !playwright, timeout: 90000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-capture-http-'));
    const profile = path.join(directory, 'profile'), downloads = path.join(directory, 'downloads');
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true }); fs.mkdirSync(downloads);
    fs.writeFileSync(path.join(profile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
    const saved = new Map(), calls = [];
    const fields = { given_name: 'Alex', family_name: 'Example', application_note: 'Synthetic teaching project experience.' };
    const persona = { id: 'captured-fixture-person', role: 'participant', label: 'Alex Example', facts: fields };
    const server = http.createServer((request, response) => {
      const actor = request.headers.cookie?.match(/fixture_actor=([^;]+)/)?.[1];
      const url = new URL(request.url, 'http://fixture.invalid');
      function json(status, value) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
      if (url.pathname === '/api/me') return json(200, { id: actor, role: 'participant' });
      if (url.pathname === '/api/applications' && request.method === 'POST') {
        let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
          const value = JSON.parse(body), id = 'application-' + (saved.size + 1);
          const record = { id, owner: actor, ...value }; saved.set(id, record); calls.push({ actor, body: value }); json(201, { id });
        }); return;
      }
      if (url.pathname.startsWith('/api/applications/')) {
        const value = saved.get(url.pathname.split('/').at(-1));
        return value && value.owner === actor ? json(200, value) : json(404, {});
      }
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'fixture_actor=captured-fixture-person; Path=/; HttpOnly; SameSite=Lax' });
      response.end(`<!doctype html><form onsubmit="event.preventDefault();window.submissions=(window.submissions||0)+1;fetch('/api/applications',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(this)))}).then(r=>r.json()).then(r=>document.querySelector('#saved').textContent=r.id)">
        <label style="display:block">Given name<input name="given_name" required></label>
        <label style="display:block">Surname<input name="family_name" required></label>
        <label style="display:block">Application note<textarea name="application_note" required></textarea></label>
        <button>Save application</button></form><output id="saved"></output>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    let context;
    t.after(async () => { await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
    context = await playwright.chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', chromiumSandbox: true,
      ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}),
      ...(process.env.HTTP_PROXY ? { proxy: { server: process.env.HTTP_PROXY, bypass: process.env.NO_PROXY || '' } } : {}),
      args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
    const control = await context.browser().newBrowserCDPSession(); await control.send('Browser.setDownloadBehavior', { behavior: 'default' }); await control.detach();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = new URL(worker.url()).host;
    await worker.evaluate(persona => chrome.storage.local.set({ captureStorage: 'downloads', personaText: JSON.stringify({ personas: [persona] }), settings: { safeyoloMode: 'off', recordSecrets: false } }), persona);
    const panel = await context.newPage(); await panel.goto('chrome-extension://' + id + '/sidepanel.html');
    await panel.locator('#persona option').waitFor({ state: 'attached' }); await panel.locator('#journey-name').fill('Demonstrate local application'); await panel.locator('#start').click();
    await until(async () => !(await panel.locator('#fill').isDisabled()));
    const app = await context.newPage(); await app.goto(origin + '/form'); await app.bringToFront();
    await panel.locator('#fill').click(); await until(async () => !(await panel.locator('#fill').isDisabled()));
    for (const [name, value] of Object.entries(fields)) assert.equal(await app.locator('[name=' + name + ']').inputValue(), value);
    assert.equal(calls.length, 0, 'filling never submits');
    await app.getByRole('button', { name: 'Save application' }).click(); await app.locator('#saved').filter({ hasText: 'application-1' }).waitFor();
    assert.deepEqual(saved.get('application-1'), { id: 'application-1', owner: persona.id, ...fields });
    await panel.locator('#stop').click();
    const output = path.join(downloads, 'Treadway/journeys');
    await until(() => fs.existsSync(output) && fs.readdirSync(output).some(name => name.endsWith('.json')));
    const capture = path.join(output, fs.readdirSync(output).find(name => name.endsWith('.json')));
    const child = spawn(process.env.TREADWAY_PYTHON || 'python3', ['-m', 'robot', '--outputdir', path.join(directory, 'robot'),
      '--variable', 'ORIGIN:' + origin, '--variable', 'CAPTURE:' + capture, path.join(root, 'recorder/examples/http-first/recorded-applications.robot')],
    { env: { ...process.env, PYTHONPATH: path.join(root, 'src') + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '') }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    let log = ''; child.stdout.on('data', part => { log += part; }); child.stderr.on('data', part => { log += part; });
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, 0, log);
    assert.equal(calls.length, 2, 'one browser demonstration + one fresh HTTP replay; wrong principal dispatched nothing');
    assert.deepEqual(calls[1], { actor: 'fresh-fixture-person', body: fields });
    assert.deepEqual(saved.get('application-2'), { id: 'application-2', owner: 'fresh-fixture-person', ...fields });
  });
