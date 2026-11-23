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
  const [form, setForm] = React.useState({ firstName: '', family: '', email: '', dob: '', pps: '', card: '', country: '', eircode: '', phone: '', reason: '', password: '' });
  const [saved, setSaved] = React.useState(null);
  const bind = (key, extra) => ({ value: form[key], onChange: (event) => setForm({ ...form, [key]: event.target.value }), ...extra });
  async function submit(event) {
    event.preventDefault();
    const response = await fetch('/api/claims', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    setSaved(response.status);
  }
  return h('form', { onSubmit: submit, 'data-testid': 'claim-form' },
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
    h('button', { type: 'submit' }, 'Submit claim'),
    saved === null ? null : h('p', { id: 'saved' }, 'Saved ' + saved));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`;

// A plain HTTP forward proxy standing in for SafeYOLO: Agent API on the
// reserved host, test-context enforcement (declared context or 428) on the app.
function fakeSafeyolo() {
  const state = { declared: null, calls: [], appRequests: [] };
  const assets = {
    '/react.js': path.join(repositoryRoot, 'node_modules/react/umd/react.development.js'),
    '/react-dom.js': path.join(repositoryRoot, 'node_modules/react-dom/umd/react-dom.development.js'),
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://' + request.headers.host);
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const json = (status, value) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (url.hostname === '_safeyolo.proxy.internal') {
        state.calls.push({ method: request.method, authorization: request.headers.authorization, body: body ? JSON.parse(body) : null });
        if (request.headers.authorization !== 'Bearer agent-key') return json(401, { error: 'Unauthorized' });
        if (request.method === 'GET') return json(200, { agent: AGENT, context: state.declared });
        if (request.method === 'DELETE') {
          state.declared = null;
          return json(200, { status: 'cleared' });
        }
        const granted = Math.min(JSON.parse(body).ttl, 900);
        state.declared = JSON.parse(body).context;
        return json(200, { agent: AGENT, context: state.declared, expires_in: granted });
      }
      if (url.hostname === 'app.example.test') {
        state.appRequests.push({ method: request.method, path: url.pathname, context: state.declared });
        if (!state.declared) return json(428, { error: 'Test context required' });
        if (assets[url.pathname]) {
          response.writeHead(200, { 'Content-Type': 'text/javascript' });
          return response.end(fs.readFileSync(assets[url.pathname]));
        }
        if (url.pathname === '/api/claims') return json(201, { id: 'claim-1' });
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

test('records a journey, fills a React form and renews an expired context', { skip: missing, timeout: 60000 }, async (t) => {
  const proxy = await fakeSafeyolo();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-recorder-'));
  const context = await playwright.chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    proxy: { server: 'http://127.0.0.1:' + proxy.port, bypass: '<-loopback>' },
    args: ['--disable-extensions-except=' + extensionRoot, '--load-extension=' + extensionRoot],
  });
  t.after(async () => {
    await context.close();
    proxy.server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ settings: { safeyoloKey: 'agent-key', jevKey: '', targetHosts: ['app.example.test'], ttlMinutes: 20 } }));

  const panel = await context.newPage();
  const panelErrors = [];
  panel.on('pageerror', (error) => panelErrors.push(error.message));
  await panel.goto('chrome-extension://' + extensionId + '/sidepanel.html');
  const ask = (message) => panel.evaluate((value) => chrome.runtime.sendMessage(value), message);

  const persona = (await panel.evaluate((text) => TreadwayPersonas.parsePersonas(text), fs.readFileSync(path.join(extensionRoot, 'examples/personas.json'), 'utf8')))[0];
  const started = await ask({ kind: 'start', persona, journeyName: 'Submit expense claim' });
  assert.equal(started.error, undefined, started.error);
  assert.match(started.context, /^run=submit-expense-claim-\d{8}T\d{6}Z;agent=browser-agent;role=submitter;test=submit-expense-claim;persona=casey-submitter$/);
  assert.equal(proxy.state.declared, started.context);
  assert.deepEqual(proxy.state.calls.map((call) => call.method), ['GET', 'POST']);
  assert.equal(proxy.state.calls[1].body.ttl, 1200);

  const app = await context.newPage();
  await app.goto('http://app.example.test/claims/new');
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
  });
  assert.equal(await app.getByLabel('Phone').getAttribute('data-treadway-manual'), 'did not stick');

  await ask({ kind: 'marker', marker: 'authenticated' });
  await app.getByLabel('Reason for claim').fill('Synthetic travel claim');
  await app.getByLabel('Reason for claim').blur();
  await app.getByLabel('Password').fill('typed-secret');
  await app.getByLabel('Password').blur();
  assert.equal(await app.getByLabel('Reason for claim').getAttribute('data-treadway-manual'), null);
  await ask({ kind: 'marker', marker: 'step', name: 'submit claim' });

  // The declared context lapses; SafeYOLO answers 428 and the recorder renews.
  proxy.state.declared = null;
  await app.getByRole('button', { name: 'Submit claim' }).click();
  await app.getByText('Saved 428').waitFor();
  await waitFor(() => proxy.state.declared === started.context, 'context renewed after 428');
  await app.getByRole('button', { name: 'Submit claim' }).click();
  await app.getByText('Saved 201').waitFor();

  const { finished } = await ask({ kind: 'stop' });
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
  assert.equal(password.redacted, true);
  assert.equal(password.value, undefined);
  assert.equal(password.secretReference, 'CASEY_SUBMITTER_PASSWORD');
  assert.equal(JSON.stringify(finished).includes('typed-secret'), false, 'typed secrets never reach the log');
  const click = finished.events.find((event) => event.type === 'click' && event.tag === 'button');
  assert.deepEqual(click.selectors.role, { role: 'button', name: 'Submit claim' });
  assert.equal(finished.events.find((event) => event.type === 'context_renewed').after.status, 428);
  assert.deepEqual(panelErrors, []);
  assert.deepEqual((await ask({ kind: 'saved' })), { ok: true });
});

async function waitFor(check, label) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
