'use strict';
// Loads the unpacked extension in Chromium behind a fake SafeYOLO proxy and a
// synthetic React form. Needs Playwright (RECORDER_PLAYWRIGHT or `playwright`)
// and the repository's devDependencies (react, react-dom).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

let playwright = null;
try {
  playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright');
} catch (_) {
  playwright = null;
}

const extensionRoot = path.join(__dirname, '..');
const repositoryRoot = path.join(extensionRoot, '..');
const AGENT = 'browser-agent';

const formPage = `<!doctype html><html><head><meta charset="utf-8"><title>Claim form</title></head><body>
<div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>
const h = React.createElement;
function Field({ label, name, ...rest }) {
  return h('label', { style: { display: 'block' } }, label, h('input', { name, ...rest }));
}
function App() {
  const [form, setForm] = React.useState({ firstName: '', family: '', email: '', dob: '', pps: '', card: '', country: '', eircode: '', phone: '', reason: '', password: '', opaque: '' });
  const [saved, setSaved] = React.useState(null);
  const bind = (key, extra) => ({ value: form[key], onChange: (event) => setForm({ ...form, [key]: event.target.value }), ...extra });
  async function submit(event) {
    event.preventDefault();
    const response = await fetch('/api/claims', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    setSaved(response.status);
  }
  return h('form', { key: location.search.includes('remount=1') ? JSON.stringify(form) : 'stable', onSubmit: submit, 'data-testid': 'claim-form' },
    h(Field, { label: 'First name', name: 'firstName', ...bind('firstName') }),
    h(Field, { label: 'Surname', name: 'f2', autoComplete: 'family-name', ...bind('family') }),
    h(Field, { label: 'Contact', name: 'f3', type: 'email', ...bind('email') }),
    h(Field, { label: 'Date of birth', name: 'f4', type: 'date', ...bind('dob') }),
    h(Field, { label: 'PPS Number', name: 'f5', ...bind('pps') }),
    h(Field, { label: 'Card number', name: 'f6', ...bind('card') }),
    h('label', null, 'Country', h('select', { name: 'country', ...bind('country') },
      h('option', { value: '' }, 'Choose'), h('option', { value: 'IE' }, 'Ireland'), h('option', { value: 'FR' }, 'France'))),
    form.country === 'IE' ? h(Field, { label: 'Eircode', name: 'eircode', ...bind('eircode') }) : null,
    // Rejects every edit, so the recorder must hand it back to the person.
    h(Field, { label: 'Phone', name: 'phone', value: form.phone, onChange: () => setForm({ ...form }) }),
    h(Field, { label: 'Reason for claim', name: 'reason', ...bind('reason') }),
    h(Field, { label: 'Password', name: 'password', type: 'password', ...bind('password') }),
    h(Field, { label: 'Code', name: 'opaque', ...bind('opaque') }),
    h('button', { type: 'submit' }, 'Submit claim'),
    saved === null ? null : h('p', { id: 'saved' }, 'Saved ' + saved));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`;

// A plain HTTP forward proxy standing in for SafeYOLO: Agent API on the
// reserved host, test-context enforcement (declared context or 428) on the app.
function fakeSafeyolo() {
  const state = { declared: null, calls: [], appRequests: [], flowCounter: 0, flows: new Map() };
  const apiContext = () => state.declared ? Object.fromEntries(state.declared.split(';').map(part => part.split('='))) : null;
  const assets = {
    '/react.js': path.join(repositoryRoot, 'node_modules/react/umd/react.development.js'),
    '/react-dom.js': path.join(repositoryRoot, 'node_modules/react-dom/umd/react-dom.development.js'),
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://' + request.headers.host);
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const requestId = 'req-fixture-' + (++state.flowCounter);
      response.setHeader('X-SafeYolo-Request-Id', requestId);
      const json = (status, value) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (url.hostname === '_safeyolo.proxy.internal') {
        state.calls.push({ method: request.method, authorization: request.headers.authorization, body: body ? JSON.parse(body) : null });
        if (request.headers.authorization !== 'Bearer agent-key') return json(401, { error: 'Unauthorized' });
        if (request.method === 'GET') return json(200, { agent: AGENT, context: apiContext() });
        if (request.method === 'DELETE') {
          state.declared = null;
          return json(200, { status: 'cleared' });
        }
        const granted = Math.min(JSON.parse(body).ttl, 900);
        state.declared = JSON.parse(body).context;
        return json(200, { agent: AGENT, context: apiContext(), expires_in: granted });
      }
      if (url.hostname === 'identity.example.test') {
        state.appRequests.push({ host: url.hostname, method: request.method, path: url.pathname, context: state.declared });
        if (!state.declared) {
          response.setHeader('X-Blocked-By', 'test-context');
          return json(428, { error: 'Test context required' });
        }
        if (url.pathname === '/context-check') return json(200, { ready: true });
        response.writeHead(200, { 'Content-Type': 'text/html' });
        return response.end('<label>Verification address<input name="verificationEmail" type="email"></label>' +
          '<button onclick="location.href=\'http://app.example.test/claims/new' + url.search + '\'">Continue</button>');
      }
      if (url.hostname === 'app.example.test') {
        state.appRequests.push({ method: request.method, path: url.pathname, context: state.declared });
        if (!state.declared) {
          response.setHeader('X-Blocked-By', 'test-context');
          return json(428, { error: 'Test context required' });
        }
        if (assets[url.pathname]) {
          response.writeHead(200, { 'Content-Type': 'text/javascript' });
          return response.end(fs.readFileSync(assets[url.pathname]));
        }
        if (url.pathname === '/sign-in') {
          response.writeHead(302, { Location: 'http://identity.example.test/register' + url.search });
          return response.end();
        }
        if (url.pathname === '/api/claims') return json(201, { id: 'claim-1' });
        if (url.pathname === '/add-details') {
          response.writeHead(200, { 'Content-Type': 'text/html' });
          return response.end('<form id="details" onsubmit="event.preventDefault()">' +
            '<label>Given name<input name="given" autocomplete="given-name"></label>' +
            '<label>Surname<input name="surname" autocomplete="family-name"></label>' +
            '<label>Display Name<input name="displayName"></label>' +
            '<label>Show me as<input name="publicLabel"></label>' +
            '<label>New password<input type="password" name="newPassword" autocomplete="new-password"></label>' +
            '<label>Confirm password<input type="password" name="confirmPassword" autocomplete="new-password"></label>' +
            '<button>Finish</button></form>');
        }
        if (url.pathname === '/api/delayed') { state.releaseResponse = () => json(200, { done: true }); return; }
        if (url.pathname === '/frame') {
          response.writeHead(200, { 'Content-Type': 'text/html' });
          return response.end('<label>Frame value<input name="frameValue"></label><button>Frame action</button>');
        }
        response.writeHead(200, { 'Content-Type': 'text/html' });
        return response.end(formPage);
      }
      response.writeHead(502);
      response.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

const missing = !playwright ? 'playwright is not installed' :
  !fs.existsSync(path.join(repositoryRoot, 'node_modules/react/umd')) ? 'run npm ci for react fixtures' : false;
if (missing && process.env.RECORDER_REQUIRE_BROWSER === '1') throw new Error(missing);

for (const mode of ['stable', 'remount']) {
test('records ' + mode + ' React controls, exact flows, frames and secret policy', { skip: missing, timeout: 60000 }, async (t) => {
  const proxy = await fakeSafeyolo();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-recorder-'));
  const downloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-recorder-downloads-'));
  if (mode === 'remount') {
    fs.mkdirSync(path.join(profile, 'Default'));
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
      download: { default_directory: downloadRoot, prompt_for_download: false, directory_upgrade: true },
    }));
  }
  let context;
  t.after(async () => {
    if (context) await context.close();
    proxy.server.closeAllConnections();
    proxy.server.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(downloadRoot, { recursive: true, force: true });
  });
  context = await playwright.chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    chromiumSandbox: true,
    ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}),
    proxy: { server: 'http://127.0.0.1:' + proxy.port, bypass: '<-loopback>' },
    args: ['--disable-extensions-except=' + extensionRoot, '--load-extension=' + extensionRoot],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate((recordSecrets) => chrome.storage.local.set({ settings: { safeyoloKey: 'agent-key', jevKey: '', ttlMinutes: 20, recordSecrets } }), mode === 'remount');
  if (mode === 'remount') {
    // Exercise Chrome's real profile destination, rather than Playwright's
    // download interception (which substitutes a GUID in its artifact folder).
    const control = await context.browser().newBrowserCDPSession();
    await control.send('Browser.setDownloadBehavior', { behavior: 'default' });
    await control.detach();
  }

  const panel = await context.newPage();
  const panelErrors = [];
  panel.on('pageerror', (error) => panelErrors.push(error.message));
  await panel.goto('chrome-extension://' + extensionId + '/sidepanel.html');
  // Exercise the real panel writer with an origin-private directory handle.
  // This avoids an OS folder chooser while keeping File System Access + IDB real.
  if (mode === 'stable') await panel.evaluate(async (text) => {
    const folder = await navigator.storage.getDirectory();
    const writable = await (await folder.getFileHandle('personas.json', { create: true })).createWritable();
    await writable.write(text); await writable.close();
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('treadway-recorder', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('handles');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('handles', 'readwrite');
      transaction.objectStore('handles').put(folder, 'folder');
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, fs.readFileSync(path.join(extensionRoot, 'examples/personas.json'), 'utf8'));
  else await panel.evaluate(async (text) => {
    await chrome.storage.local.set({ captureStorage: 'downloads', personaText: text });
  }, fs.readFileSync(path.join(extensionRoot, 'examples/personas.json'), 'utf8'));
  await panel.reload();
  await panel.locator('#persona option').first().waitFor({ state: 'attached' });
  if (mode === 'remount') {
    await panel.evaluate(() => {
      window.pickerCalls = 0;
      window.showDirectoryPicker = () => { window.pickerCalls += 1; throw new Error('Native picker must not be used'); };
    });
    assert.equal(await panel.locator('#folder-settings').isHidden(), true);
    await panel.locator('#settings-section summary').click();
    const pasted = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'examples/personas.json'), 'utf8'));
    pasted.personas[0].label = 'Pasted fixture persona';
    await panel.locator('#personas-json').fill(JSON.stringify(pasted));
    await panel.locator('#save-settings').click();
    await panel.locator('#messages').getByText('Settings saved', { exact: false }).first().waitFor();
    assert.match(await panel.locator('#persona option').first().textContent(), /Pasted fixture persona/);
    assert.equal(await panel.evaluate(async () => JSON.parse((await chrome.storage.local.get('personaText')).personaText).personas[0].label), 'Pasted fixture persona');
  }
  const ask = (message) => panel.evaluate((value) => chrome.runtime.sendMessage(value), message);

  const persona = (await panel.evaluate((text) => TreadwayPersonas.parsePersonas(text), fs.readFileSync(path.join(extensionRoot, 'examples/personas.json'), 'utf8')))[0];
  persona.secrets.one_time_code = 'FIXTURE_CODE';
  const started = await ask({ kind: 'start', persona, journeyName: 'Submit expense claim' });
  assert.equal(started.error, undefined, started.error);
  assert.match(started.context, /^run=submit-expense-claim-\d{8}T\d{6}Z-[a-f0-9]{8};agent=browser-agent;role=submitter;test=submit-expense-claim;persona=casey-submitter$/);
  assert.equal(proxy.state.declared, started.context);
  assert.deepEqual(proxy.state.calls.map((call) => call.method), ['GET', 'POST']);
  assert.equal(proxy.state.calls[1].body.ttl, 1200);

  await waitFor(async () => (await panel.locator('#context-clock').getAttribute('data-state')) === 'active', 'context clock starts active');
  const displayExpiry = async (milliseconds) => {
    await worker.evaluate(async (milliseconds) => {
      const { journey } = await chrome.storage.session.get('journey');
      journey.expiresAt = new Date(Date.now() + milliseconds).toISOString();
      await chrome.storage.session.set({ journey });
      await chrome.runtime.sendMessage({ kind: 'panel-notice' }).catch(() => undefined);
    }, milliseconds);
  };
  await displayExpiry(65000);
  await waitFor(async () => (await panel.locator('#context-clock').getAttribute('data-state')) === 'warning', 'context expiry warning visible');
  const apiCallsBeforeTick = proxy.state.calls.length;
  const firstTick = await panel.locator('#context-countdown').textContent();
  await waitFor(async () => (await panel.locator('#context-countdown').textContent()) !== firstTick, 'countdown ticks without API calls');
  assert.equal(proxy.state.calls.length, apiCallsBeforeTick);
  await displayExpiry(-1000);
  proxy.state.declared = null;
  await waitFor(async () => (await panel.locator('#context-clock').getAttribute('data-state')) === 'expired', 'expired context is red and explicit');
  assert.match(await panel.locator('#context-notice').textContent(), /expired/);
  assert.equal(await panel.locator('#context-countdown').textContent(), '0:00');
  await panel.getByRole('button', { name: 'Renew context', exact: true }).click();
  await waitFor(async () => (await panel.locator('#context-clock').getAttribute('data-state')) === 'active', 'manual renewal resets the timer');
  const renewed = (await ask({ kind: 'status' })).journey;
  assert.equal(renewed.context, started.context);
  assert.equal(renewed.startedAt, started.startedAt);
  assert.equal(renewed.events.at(-1).source, 'operator');
  assert.equal(proxy.state.appRequests.length, 0, 'renewal never dispatches an application request');

  const app = await context.newPage();
  await app.goto('http://app.example.test/sign-in' + (mode === 'remount' ? '?remount=1' : ''));
  await app.getByLabel('Verification address').waitFor();
  await waitFor(async () => (await ask({ kind: 'status' })).journey.events.some(e =>
    e.type === 'page' && e.url.includes('identity.example.test/register')), 'discovered sign-in page recorded');
  await app.getByLabel('Verification address').fill('casey@example.test');
  // No host list was configured. A newly discovered origin can renew context,
  // while the blocked request itself is observed once and never auto-replayed.
  proxy.state.declared = null;
  assert.equal(await app.evaluate(async () => (await fetch('/context-check')).status), 428);
  await waitFor(() => proxy.state.declared === started.context, 'context renewed on discovered sign-in origin');
  assert.equal(proxy.state.appRequests.filter(r => r.host === 'identity.example.test' && r.path === '/context-check').length, 1);
  await app.getByRole('button', { name: 'Continue', exact: true }).click();
  await app.getByLabel('First name').waitFor();
  await app.bringToFront();

  const values = await panel.evaluate((value) => TreadwayPersonas.personaValues(value), persona);
  const report = await ask({ kind: 'fill', values });
  assert.equal(report.error, undefined, report.error);
  const filled = Object.fromEntries(report.filled.map((entry) => [entry.selectors.name, entry]));
  assert.equal(await app.getByLabel('First name').inputValue(), 'Casey');
  assert.equal(await app.getByLabel('Surname').inputValue(), 'Example');
  assert.equal(await app.getByLabel('Contact').inputValue(), 'casey.submitter@example.test');
  assert.equal(await app.getByLabel('Date of birth').inputValue(), '1988-04-12');
  assert.equal(await app.getByLabel('PPS Number').inputValue(), values.ppsn.value);
  assert.equal(await app.getByLabel('Card number').inputValue(), values.card_number.value);
  assert.equal(await app.getByLabel('Country').inputValue(), 'IE');
  assert.equal(await app.getByLabel('Eircode').inputValue(), 'D01 X2Y3', 'a field revealed by an earlier fill is filled in a later round');
  assert.equal(filled['input[name="f5"]'].source, 'generated');
  assert.equal(filled['input[name="firstName"]'].source, 'persona');
  assert.equal(filled['input[name="f2"]'].by, 'autocomplete');
  const manual = Object.fromEntries(report.manual.map((entry) => [entry.selectors.name, entry.reason]));
  assert.deepEqual(manual, {
    'input[name="phone"]': 'did not stick',
    'input[name="reason"]': 'unclassified',
    'input[name="password"]': 'secret',
    'input[name="opaque"]': 'unclassified',
  });
  assert.equal(report.filled.length, 8, 'one success per actual live field, including remounts');
  assert.equal(await app.getByLabel('Phone').getAttribute('data-treadway-manual'), 'did not stick');

  // Stub only the provider response. The actual background classifier and
  // page helper must carry its secret decision into later human input events.
  await worker.evaluate(async () => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (url !== 'https://api.typesafe.ai/v1/systemone') return nativeFetch(url, options);
      const request = JSON.parse(options.body);
      globalThis.fixtureJevRequests ||= [];
      globalThis.fixtureJevRequests.push(request);
      return Promise.resolve(new Response(JSON.stringify({ answers: Object.fromEntries(
        Object.entries(request.state.fields).map(([key, field]) => [key, {
          type: 'choice', choice: field.label === 'Code' ? 'one_time_code' : field.name === 'publicLabel' ? 'display_name' : 'other',
          confidence: field.name === 'publicLabel' ? 0.52 : 0.99,
        }])) }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    };
    const stored = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...stored.settings, jevKey: 'fixture-provider-key' } });
  });
  const classified = await ask({ kind: 'fill', values });
  assert.ok(classified.manual.some((entry) => entry.type === 'one_time_code' && entry.reason === 'secret'));

  await ask({ kind: 'marker', marker: 'authenticated' });
  await app.getByLabel('Reason for claim').fill('Synthetic travel claim');
  await app.getByLabel('Reason for claim').blur();
  await app.getByLabel('Password').fill('typed-secret');
  await app.getByLabel('Password').blur();
  await app.getByLabel('Code', { exact: true }).fill('typed-one-time-code');
  await app.getByLabel('Code', { exact: true }).blur();
  assert.equal(await app.getByLabel('Reason for claim').getAttribute('data-treadway-manual'), null);
  await ask({ kind: 'marker', marker: 'step', name: 'submit claim' });
  await app.evaluate(() => {
    history.pushState({}, '', '/claims/review');
    history.replaceState({}, '', '/claims/review?ready=1');
    for (let index = 0; index < 2; index += 1) {
      const frame = document.createElement('iframe'); frame.src = '/frame'; frame.id = 'child-' + index;
      document.body.append(frame);
    }
  });
  await app.frameLocator('#child-0').getByLabel('Frame value').fill('First frame');
  await app.frameLocator('#child-0').getByRole('button', { name: 'Frame action' }).click();
  await app.frameLocator('#child-1').getByLabel('Frame value').fill('Second frame');
  await app.frameLocator('#child-1').getByRole('button', { name: 'Frame action' }).click();
  await app.bringToFront();

  // The declared context lapses; SafeYOLO answers 428 and the recorder renews.
  proxy.state.declared = null;
  await app.getByRole('button', { name: 'Submit claim' }).click();
  await app.getByText('Saved 428').waitFor();
  await waitFor(() => proxy.state.declared === started.context, 'context renewed after 428');
  await app.getByRole('button', { name: 'Submit claim' }).click();
  await app.getByText('Saved 201').waitFor();
  await app.evaluate(() => {
    const file = document.createElement('input'); file.type = 'file'; file.name = 'receipt';
    document.body.append(file);
  });
  const uploadPath = path.join(profile, 'synthetic.txt');
  fs.writeFileSync(uploadPath, 'invented receipt');
  // A real fixture path uses Chromium's file chooser protocol and emits trusted
  // events, unlike Playwright's buffer-based synthetic input/change dispatch.
  await app.locator('input[type=file]').setInputFiles(uploadPath);

  // Actual Fill all button: missing registration credentials are created and
  // persisted once, Display Name defaults to full name, and Jev picks a close
  // ordinary label above the operator's 0.51 confidence floor.
  const details = await context.newPage();
  await details.goto('http://app.example.test/add-details');
  await details.getByLabel('New password', { exact: true }).waitFor();
  await details.bringToFront();
  await panel.locator('#fill').click();
  await waitFor(async () => (await details.getByLabel('Confirm password', { exact: true }).inputValue()).length > 0, 'password pair automatically filled');
  await panel.locator('#messages').getByText('Generated and saved a test password for this persona.', { exact: false }).first().waitFor();
  const generatedPassword = await details.getByLabel('New password', { exact: true }).inputValue();
  assert.equal(await details.getByLabel('Confirm password', { exact: true }).inputValue(), generatedPassword);
  assert.equal(await details.getByLabel('Display Name', { exact: true }).inputValue(), 'Casey Example');
  assert.equal(await details.getByLabel('Show me as', { exact: true }).inputValue(), 'Casey Example');
  assert.equal(await details.getByLabel('Given name', { exact: true }).inputValue(), 'Casey');
  assert.equal(proxy.state.appRequests.filter(r => r.method === 'POST' && r.path === '/add-details').length, 0);
  assert.equal(await worker.evaluate(password => JSON.stringify(globalThis.fixtureJevRequests).includes(password), generatedPassword), false,
    'Jev sees descriptors and choices, never the generated password');
  assert.equal(await worker.evaluate(async password => JSON.stringify((await chrome.storage.local.get('personaCredentials')).personaCredentials).includes(password), generatedPassword), true);
  if (mode === 'remount') assert.equal(await panel.evaluate(async () => JSON.parse((await chrome.storage.local.get('personaText')).personaText).personas[0].credentials.new_password), generatedPassword);
  await details.locator('form').evaluate(form => form.reset());
  await panel.locator('#fill').click();
  await waitFor(async () => (await details.getByLabel('Confirm password', { exact: true }).inputValue()) === generatedPassword, 'saved credential reused after reset');
  await waitFor(async () => (await ask({ kind: 'status' })).journey.events.filter(e => e.type === 'fill' && e.filled.some(f => f.type === 'new_password')).length >= 2, 'second credential fill journaled');
  await details.getByLabel('New password', { exact: true }).fill('HumanChosenPassword!8');
  await details.getByLabel('Confirm password', { exact: true }).fill('');
  await panel.locator('#fill').click();
  await waitFor(async () => (await details.getByLabel('Confirm password', { exact: true }).getAttribute('data-treadway-manual')) === 'saved password differs from existing input', 'human password choice is preserved');
  assert.equal(await details.getByLabel('New password', { exact: true }).inputValue(), 'HumanChosenPassword!8');
  assert.equal(await details.getByLabel('Confirm password', { exact: true }).inputValue(), '');

  await app.evaluate(() => { window.delayed = fetch('/api/delayed'); });
  await waitFor(() => Boolean(proxy.state.releaseResponse), 'pending request reaches fixture');
  await panel.locator('#stop').click();
  await panel.locator('#messages').getByText(/Saved \d+ events/).first().waitFor();
  const readFile = async () => {
    let value;
    await waitFor(async () => {
      if (mode === 'remount') {
        try { value = JSON.parse(fs.readFileSync(path.join(downloadRoot, 'Treadway', 'journeys', started.contextFields.run + '.json'), 'utf8')); }
        catch (_) { value = false; }
      } else value = await panel.evaluate(async (run) => {
        try {
          const folder = await navigator.storage.getDirectory();
          const journeys = await folder.getDirectoryHandle('journeys');
          return JSON.parse(await (await (await journeys.getFileHandle(run + '.json')).getFile()).text());
        } catch (_) { return false; } // Reacquire if an atomic save replaced the snapshot.
      }, started.contextFields.run);
      return value;
    }, 'readable saved snapshot');
    return value;
  };
  const pendingSnapshot = await readFile();
  assert.equal(pendingSnapshot.format, 'treadway-journey-events/2');
  assert.equal(pendingSnapshot.networkCapture.complete, false);
  assert.ok(pendingSnapshot.networkCapture.pending.some((request) => request.url.endsWith('/api/delayed')));
  proxy.state.releaseResponse();
  await waitFor(async () => (await readFile()).networkCapture.complete, 'late outcome saved');
  const finished = await readFile();
  assert.equal(JSON.stringify(finished).includes(generatedPassword), mode === 'remount', 'automatic password fill obeys the run secret policy');
  assert.equal(JSON.stringify(finished).includes('HumanChosenPassword!8'), mode === 'remount', 'manual password edits obey the same policy');
  assert.ok(finished.events.some(e => e.type === 'credential_prepared'));
  assert.ok(finished.events.some(e => e.type === 'fill' && e.filled.some(f => f.type === 'display_name' && f.by === 'jev' && f.confidence === 0.52)));
  assert.ok(finished.revision > pendingSnapshot.revision, 'the saved file includes late outcomes: ' +
    JSON.stringify({ pendingRevision: pendingSnapshot.revision, finalRevision: finished.revision,
      complete: finished.networkCapture.complete, late: finished.events.filter((event) => event.url?.endsWith('/api/delayed')).map((event) => event.type) }));
  assert.equal(proxy.state.declared, null, 'stop clears the declared context');
  assert.equal(proxy.state.calls.at(-1).method, 'DELETE');
  const types = finished.events.map((event) => event.type);
  for (const type of ['context_declared', 'page', 'fill', 'marker', 'field', 'click', 'submit', 'context_renewed', 'context_cleared']) {
    assert.ok(types.includes(type), 'event log has ' + type + ': ' + types.join(','));
  }
  const human = finished.events.filter((event) => event.type === 'field');
  const reason = human.find((event) => event.selectors.name === 'input[name="reason"]');
  assert.deepEqual([reason.source, reason.value], ['human', 'Synthetic travel claim']);
  const password = human.find((event) => event.selectors.name === 'input[name="password"]');
  assert.equal(password.redacted, mode === 'stable' ? true : undefined);
  assert.equal(password.value, mode === 'stable' ? undefined : 'typed-secret');
  assert.equal(password.secretReference, 'CASEY_SUBMITTER_PASSWORD');
  assert.equal(JSON.stringify(finished).includes('typed-secret'), mode === 'remount', 'the selected test-secret policy applies consistently');
  const otp = human.find((event) => event.fieldType === 'one_time_code');
  assert.ok(otp, 'Jev-only classification survives later remounts and human entry');
  assert.equal(otp.secretReference, 'FIXTURE_CODE');
  assert.equal(otp.value, mode === 'stable' ? undefined : 'typed-one-time-code');
  const frameFields = human.filter((event) => event.field && event.field.name === 'frameValue');
  assert.equal(new Set(frameFields.map((event) => event.frameId)).size, 2);
  assert.equal(new Set(frameFields.map((event) => event.documentId)).size, 2);
  assert.ok(finished.events.some((event) => event.type === 'navigation' && event.how === 'history_state_updated' && event.url.includes('/claims/review')));
  const click = finished.events.find((event) => event.type === 'click' && event.selectors.role?.name === 'Submit claim');
  assert.deepEqual(click.selectors.role, { role: 'button', name: 'Submit claim' });
  assert.equal(finished.events.find((event) => event.type === 'context_renewed' && event.source === 'proxy_block').after.status, 428);
  assert.equal(await panel.locator('#context-clock').isHidden(), true, 'no active timer remains after Stop');
  const responses = finished.events.filter((event) => event.type === 'network_response');
  assert.ok(responses.some(e => e.url.includes('identity.example.test/register') && e.status === 200 && e.safeyoloRequestId));
  assert.ok(finished.events.some(e => e.type === 'network_redirect' && e.redirectUrl.includes('identity.example.test/register')));
  assert.ok(human.some(e => e.value === 'casey@example.test' && e.field?.name === 'verificationEmail'));
  assert.ok(responses.length > 0);
  assert.ok(responses.every((event) => event.safeyoloRequestId && event.chromeRequestId));
  assert.ok(responses.every((event) => Number.isInteger(event.tabId) && Number.isInteger(event.frameId)));
  assert.ok(finished.events.find((event) => event.type === 'field').documentId);
  const upload = human.find((event) => event.fixtureBinding === 'operator_selected_file');
  assert.equal(upload.files[0].name, 'synthetic.txt');
  assert.equal(upload.value, undefined);
  assert.deepEqual(panelErrors, []);
  await waitFor(async () => !(await ask({ kind: 'status' })).finished, 'latest save acknowledged');
  assert.equal((await ask({ kind: 'status' })).finished, null);
  if (mode === 'remount') {
    assert.equal(await panel.evaluate(() => window.pickerCalls), 0);
    assert.equal(fs.readdirSync(path.join(downloadRoot, 'Treadway', 'journeys')).length, 1,
      'late outcomes replace the same saved recording');
  }

  if (mode === 'stable') {
    const fixture = await context.newPage();
    await fixture.setContent('<form><label>Current password<input name="currentPassword" type="password" autocomplete="current-password"></label>' +
      '<label>New password<input name="newPassword" type="password" autocomplete="new-password"></label>' +
      '<label>Confirm password<input name="confirmPassword" type="password" autocomplete="new-password"></label></form>');
    await fixture.addScriptTag({ path: path.join(extensionRoot, 'lib/fields.js') });
    await fixture.addScriptTag({ path: path.join(extensionRoot, 'lib/page-fill.js') });
    const rotation = await fixture.evaluate(async () => {
      const report = await TreadwayPageFill.fillAll(document, { values: {
        password: { value: 'OldSyntheticPassword!1', credential: true, source: 'credential' },
        new_password: { value: 'NewSyntheticPassword!2', credential: true, source: 'credential' },
      } });
      return { filled: report.filled.length, values: [...document.querySelectorAll('input')].map(input => input.value) };
    });
    assert.equal(rotation.filled, 3);
    assert.deepEqual(rotation.values, ['OldSyntheticPassword!1', 'NewSyntheticPassword!2', 'NewSyntheticPassword!2']);
    await fixture.setContent(`<form>
      <label>First name<input name="given" autocomplete="given-name" data-test-id='first"name'></label>
      <label>Email<input name="email" type="email"></label>
      <label>Country<select name="country"><option value="">Choose</option><option value="a">Ireland</option><option value="b">Ireland</option></select></label>
      <label>Countries<select name="countries" multiple autocomplete="country-name"><option value="IE">Ireland</option></select></label>
      <label>Agree<input type="checkbox"></label><label>Choice<input type="radio"></label>
      </form>`);
    await fixture.addScriptTag({ path: path.join(extensionRoot, 'lib/fields.js') });
    await fixture.addScriptTag({ path: path.join(extensionRoot, 'lib/page-fill.js') });
    const checked = await fixture.evaluate(async () => {
      const helper = TreadwayPageFill;
      const given = document.querySelector('[name=given]');
      const selectors = helper.selectorsFor(given);
      document.querySelector('[name=email]').addEventListener('input', () => { given.value = ''; });
      const report = await helper.fillAll(document, { values: {
        given_name: { value: 'Casey', source: 'persona' }, email: { value: 'casey@example.test', source: 'persona' },
        country: { value: 'Ireland', source: 'persona' },
      } });
      return { report, correctTestId: document.querySelector(selectors.testId) === given,
        roles: ['checkbox', 'radio'].map((type) => helper.selectorsFor(document.querySelector('[type=' + type + ']')).role.role) };
    });
    assert.equal(checked.correctTestId, true);
    assert.deepEqual(checked.roles, ['checkbox', 'radio']);
    assert.equal(checked.report.filled.length, 1, 'later reset invalidates earlier fill success');
    assert.ok(checked.report.manual.some((entry) => entry.reason === 'ambiguous option'));
    assert.ok(checked.report.manual.some((entry) => entry.reason === 'multiple selection requires human'));
    assert.ok(checked.report.manual.some((entry) => entry.field.name === 'given' && entry.reason === 'did not stick'));
  }
});
}

async function waitFor(check, label) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
