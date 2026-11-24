'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
let playwright;
try { playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright'); } catch (_) {}
if (!playwright && process.env.RECORDER_REQUIRE_BROWSER === '1') throw new Error('playwright is required for persona inference browser checks');
const extension = path.join(__dirname, '..');
const radio = (name, legend) => '<fieldset><legend>' + legend + '</legend><label>Yes<input type="radio" name="' + name + '" value="yes"></label><label>No<input type="radio" name="' + name + '" value="no"></label></fieldset>';
const profileHtml = ageOnly => '<!doctype html><div role="tab" aria-selected="true" id="stage">Working preferences</div><form onsubmit="event.preventDefault();window.submitted=true">' + radio('retired', 'Retired') +
  (ageOnly ? '' : '<label>Remote working days<select name="remote_days"><option value="">Choose</option><option value="1">1</option><option value="2">2</option><option value="3">3</option></select></label>' +
    '<label>Days available<select name="available_days"><option value="">Choose</option><option value="2">2</option><option value="3">3</option><option value="5">5</option></select></label>') + '<button>Save</button></form>';
const persona = { id: 'profile-persona', role: 'participant', label: 'Taylor Example', referenceDate: '2026-11-24',
  facts: { given_name: 'Taylor', family_name: 'Example', email: 'private@example.test', date_of_birth: '1984-06-15' },
  credentials: { password: 'NeverSendCredentials!9' },
  description: 'Taylor is currently employed at Example Academy, teaching throughout the year, and seeks supplementary assessment work. Taylor requires at least two working days at home each week and is available for additional work three days per week.',
  preferences: { minimum_remote_days: 2 }, circumstances: { available_days_per_week: 3 },
  domains: { identity: { passport: { number: 'SYNTHETIC-NUMBER-ONLY', issuing_country: 'EX' } } } };
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
  throw new Error(message);
}

test('profile answers use the same Fill all path, support gates, revision cache and Stop guards', { skip: !playwright, timeout: 90000 }, async t => {
  let declared = null;
  const proxy = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://' + request.headers.host); let body = '';
    request.on('data', part => body += part); request.on('end', () => {
      const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.hostname === '_safeyolo.proxy.internal') {
        if (request.method === 'GET') return json(200, { agent: 'browser-agent', context: declared });
        if (request.method === 'DELETE') { declared = null; return json(200, { status: 'cleared' }); }
        const value = JSON.parse(body); declared = Object.fromEntries(value.context.split(';').map(part => part.split('=')));
        return json(200, { agent: 'browser-agent', context: declared, expires_in: value.ttl });
      }
      if (url.hostname === 'app.example.test') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        if (url.pathname === '/repeated-history') return response.end('<label>Institution<input name="firstCollege"></label><label>Institution<input name="secondCollege"></label>');
        if (url.pathname === '/bound-history') return response.end('<label>Institution<input name="primary_institution"></label><label>Institution<input name="secondary_institution"></label>');
        return response.end(profileHtml(url.pathname === '/age-only'));
      }
      response.writeHead(404); response.end();
    });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-profile-inference-'));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-profile-output-'));
  fs.mkdirSync(path.join(profile, 'Default')); fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
  let context, panel; let complete = false;
  t.after(async () => {
    if (!complete && panel) t.diagnostic(await panel.evaluate(() => document.querySelector('#messages')?.textContent).catch(e => e.message));
    await context?.close(); proxy.closeAllConnections(); proxy.close(); fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(downloads, { recursive: true, force: true });
  });
  context = await playwright.chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', chromiumSandbox: true,
    ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}),
    proxy: { server: 'http://127.0.0.1:' + proxy.address().port, bypass: '<-loopback>' },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging'] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const id = new URL(worker.url()).host;
  await worker.evaluate(async persona => {
    await chrome.storage.local.set({ captureStorage: 'downloads', personaText: JSON.stringify({ personas: [persona] }),
      settings: { safeyoloKey: 'fixture-agent-key', jevKey: 'fixture-jev-key', ttlMinutes: 20, recordSecrets: false } });
    const nativeFetch = globalThis.fetch; globalThis.fixtureRequests = []; globalThis.fixtureLowSupport = false;
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://api.typesafe.ai/v1/systemone') return nativeFetch(url, options);
      const request = JSON.parse(options.body); fixtureRequests.push(request); const answers = {};
      for (const key of Object.keys(request.state.fields || {})) {
        answers[key] = { type: 'choice', choice: 'given_name', confidence: 0.99 };
        answers[key + '__fits'] = { type: 'noul', noul: 0.01 };
      }
      for (const [key, widget] of Object.entries(request.state.widgets || {})) {
        const wanted = { retired: 'No', remote_days: '2', available_days: '3' }[widget.field.name];
        const choice = Object.entries(widget.options).find(([, label]) => label === wanted)?.[0] || 'o999';
        answers[key] = { type: 'choice', choice, confidence: widget.field.name === 'remote_days' ? 0.51 : 0.99 };
        answers[key + '__fits'] = { type: 'noul', noul: globalThis.fixtureLowSupport ? 0.05 : widget.field.name === 'available_days' ? 0.8 : 0.95 };
        answers[key + '__action'] = { type: 'choice', choice: 'select', confidence: 0.99 };
      }
      const response = new Response(JSON.stringify({ answers }), { status: 200 });
      if (request.state.widgets && globalThis.fixtureDefer) {
        globalThis.fixtureDefer = false;
        return new Promise(resolve => { globalThis.fixtureReleaseDecision = () => resolve(response); });
      }
      return response;
    };
  }, persona);
  const browserCDP = await context.browser().newBrowserCDPSession(); await browserCDP.send('Browser.setDownloadBehavior', { behavior: 'default' }); await browserCDP.detach();
  panel = await context.newPage(); const errors = []; panel.on('pageerror', e => errors.push(e.message));
  await panel.goto('chrome-extension://' + id + '/sidepanel.html');
  await panel.locator('#persona option').waitFor({ state: 'attached' });
  await panel.locator('#journey-name').fill('Infer synthetic profile answers'); await panel.locator('#start').click();
  await until(async () => !(await panel.locator('#fill').isDisabled()), 'journey not active');
  const app = await context.newPage(); await app.goto('http://app.example.test/profile'); await app.bringToFront();
  await app.evaluate(() => {
    window.nativeChanges = [];
    document.addEventListener('change', event => window.nativeChanges.push({ name: event.target.name, trusted: event.isTrusted }));
  });
  const readPersona = () => panel.evaluate(async () => JSON.parse((await chrome.storage.local.get('personaText')).personaText).personas[0]);
  const lastFill = () => panel.evaluate(async () => [...((await chrome.storage.session.get('journey')).journey?.events || [])].reverse().find(e => e.type === 'fill'));
  async function fillAndWait(previousId) {
    const reports = await panel.locator('#messages li').filter({ hasText: 'Filled ' }).count();
    await app.bringToFront(); await panel.locator('#fill').click();
    await until(async () => { const fill = await lastFill(); return fill && fill.eventId !== previousId; }, 'fill was not journaled');
    await until(async () => await panel.locator('#messages li').filter({ hasText: 'Filled ' }).count() > reports, 'Fill all has not completed');
    return lastFill();
  }
  let result = await fillAndWait();
  assert.equal(await app.locator('[name="retired"]:checked').getAttribute('value'), 'no');
  assert.equal(await app.locator('[name="remote_days"]').inputValue(), '2'); assert.equal(await app.locator('[name="available_days"]').inputValue(), '3');
  assert.equal(result.filled.length, 3); assert.equal(result.manual.length, 0); assert.equal(result.personaRevision, 1);
  const saved = await readPersona(); assert.equal(Object.keys(saved.deductions).length, 3);
  assert(Object.values(saved.deductions).every(entry => entry.personaRevision === 1 && entry.source === 'jev'));
  const recorded = await panel.evaluate(async () => (await chrome.storage.session.get('journey')).journey.personaRevisions);
  assert(recorded.some(entry => entry.revision === 1));
  const requestText = await worker.evaluate(() => JSON.stringify(fixtureRequests));
  for (const secret of ['NeverSendCredentials!9', 'private@example.test', 'SYNTHETIC-NUMBER-ONLY', 'fixture-agent-key', 'fixture-jev-key']) assert.equal(requestText.includes(secret), false);
  const calls = await worker.evaluate(() => fixtureRequests.length);
  assert((await app.evaluate(() => window.nativeChanges)).some(event => event.name === 'retired' && event.trusted), 'native radio click emits a trusted change in this browser');
  const humanFields = () => panel.evaluate(async () => ((await chrome.storage.session.get('journey')).journey?.events || []).filter(event => event.type === 'field' && event.source === 'human'));
  assert.deepEqual(await humanFields(), [], 'extension-origin native changes must not be labeled human');
  await app.evaluate(() => {
    document.querySelectorAll('input[type="radio"]').forEach(input => { input.checked = false; });
    document.querySelectorAll('select').forEach(select => { select.value = ''; });
  });
  result = await fillAndWait(result.eventId);
  assert.equal(result.filled.length, 3, 'extension changes must not leave a false human-edit guard on the same document');
  assert.equal(result.manual.length, 0);
  assert.equal(await worker.evaluate(() => fixtureRequests.length), calls);
  assert.deepEqual(await humanFields(), []);
  await app.reload(); result = await fillAndWait(result.eventId);
  assert.equal(await worker.evaluate(() => fixtureRequests.length), calls, 'unchanged form/profile should reuse decisions without provider calls');
  assert.equal(result.filled.length, 3); assert(result.filled.every(entry => entry.optionDecision.source === 'cache'));
  await app.reload();
  await app.evaluate(() => document.querySelector('#stage').textContent = 'Updated work preferences');
  result = await fillAndWait(result.eventId);
  assert((await worker.evaluate(() => fixtureRequests.length)) > calls, 'a changed same-route wizard step must not reuse earlier answers');

  async function editPersona(patch) {
    await panel.evaluate(async patch => {
      const { token } = await chrome.runtime.sendMessage({ kind: 'persona-edit-begin' });
      try {
        const { personaText } = await chrome.storage.local.get('personaText'); const data = JSON.parse(personaText);
        const current = TreadwayPersonas.parsePersonas(personaText)[0];
        data.personas[0] = TreadwayPersonaManager.editPersona(current, patch, { expectedRevision: current.revision });
        await chrome.storage.local.set({ personaText: JSON.stringify(data) });
      } finally { await chrome.runtime.sendMessage({ kind: 'persona-edit-end', token }); }
    }, patch);
  }
  await editPersona({ facts: { ...saved.facts, retired: 'Yes' } });
  assert.equal(Object.keys((await readPersona()).deductions).length, 0);
  await app.reload(); const beforeExplicit = await worker.evaluate(() => fixtureRequests.length); result = await fillAndWait(result.eventId);
  assert.equal(await app.locator('[name="retired"]:checked').getAttribute('value'), 'yes', 'explicit operator fact wins over employed narrative');
  const explicitRequests = await worker.evaluate(from => fixtureRequests.slice(from), beforeExplicit);
  assert(explicitRequests.every(request => !Object.values(request.state.widgets || {}).some(widget => widget.field.name === 'retired')));
  assert.equal(result.personaRevision, 2);

  const historyBase = await readPersona();
  await editPersona({ facts: { ...historyBase.facts, institution: 'Generic Academy' } });
  await app.goto('http://app.example.test/repeated-history'); result = await fillAndWait(result.eventId);
  assert.deepEqual(await app.locator('input').evaluateAll(inputs => inputs.map(input => input.value)), ['', ''], 'one generic fact must not populate two history rows');
  assert.equal(result.filled.length, 0); assert.equal(result.manual.length, 2);
  assert(result.manual.every(entry => entry.reason.includes('explicit persona binding')));
  const historyFacts = { ...(await readPersona()).facts, primary_institution: 'First Academy', secondary_institution: 'Second Academy' }; delete historyFacts.institution;
  await editPersona({ facts: historyFacts });
  await app.goto('http://app.example.test/bound-history'); result = await fillAndWait(result.eventId);
  assert.deepEqual(await app.locator('input').evaluateAll(inputs => inputs.map(input => input.value)), ['First Academy', 'Second Academy']);
  assert.equal(result.filled.length, 2); assert.equal(result.manual.length, 0);

  const current = await readPersona(); const ageFacts = { ...current.facts, age: '42' }; delete ageFacts.retired;
  await editPersona({ facts: ageFacts, description: 'Taylor is 42 years old and enjoys reading.', preferences: {}, circumstances: {}, domains: {}, histories: {} });
  await worker.evaluate(() => globalThis.fixtureLowSupport = true);
  await app.goto('http://app.example.test/age-only'); result = await fillAndWait(result.eventId);
  assert.equal(await app.locator('[name="retired"]:checked').count(), 0, 'high Choice with insufficient evidence must abstain');
  assert.equal(result.filled.length, 0); assert.equal(result.manual.length, 1); assert.equal(Object.keys((await readPersona()).deductions).length, 0);

  await editPersona({ description: persona.description, preferences: persona.preferences, circumstances: persona.circumstances });
  await worker.evaluate(() => { globalThis.fixtureLowSupport = false; globalThis.fixtureDefer = true; globalThis.fixtureReleaseDecision = null; });
  await app.reload(); await app.bringToFront(); await panel.locator('#fill').click();
  await until(() => worker.evaluate(() => typeof fixtureReleaseDecision === 'function'), 'deferred human-edit decision did not begin');
  await app.locator('[name="retired"][value="yes"]').check();
  await until(async () => (await humanFields()).some(event => event.checked === true && event.value === 'yes'), 'real operator edit during provider wait was not recorded');
  await worker.evaluate(() => fixtureReleaseDecision());
  await until(async () => { const fill = await lastFill(); return fill && fill.eventId !== result.eventId; }, 'human-edited fill did not finish');
  result = await lastFill();
  await until(async () => !(await panel.locator('#fill').isDisabled()), 'human-edited fill did not release controls');
  assert.equal(await app.locator('[name="retired"]:checked').getAttribute('value'), 'yes', 'real operator choice wins while inference waits');
  assert.equal(result.filled.length, 0); assert.equal(result.manual.length, 0, 'operator already completed the control');
  assert.equal(Object.keys((await readPersona()).deductions).length, 0, 'stale inference must not become a saved deduction');

  await worker.evaluate(() => { globalThis.fixtureDefer = true; globalThis.fixtureReleaseDecision = null; });
  await app.reload(); await app.bringToFront(); await panel.locator('#fill').click();
  await until(() => worker.evaluate(() => typeof fixtureReleaseDecision === 'function'), 'deferred decision did not begin');
  await panel.locator('#stop').click();
  await until(async () => await panel.evaluate(async () => !(await chrome.runtime.sendMessage({ kind: 'status' })).journey), 'Stop did not complete');
  await worker.evaluate(() => fixtureReleaseDecision());
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await app.locator('[name="retired"]:checked').count(), 0, 'late provider response must not act after Stop');
  assert.equal(Object.keys((await readPersona()).deductions).length, 0);
  assert.equal(await app.evaluate(() => Boolean(window.submitted)), false); assert.deepEqual(errors, []);
  complete = true;
});
