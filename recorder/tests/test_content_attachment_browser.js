'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let playwright;
try { playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright'); } catch (_) {}
if (!playwright && process.env.RECORDER_REQUIRE_BROWSER === '1') throw new Error('Playwright is required for attachment ownership checks');
const extension = path.join(__dirname, '..');
async function until(check, description, timeout = 10000) {
  const end = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); } while (Date.now() < end);
  throw new Error('Attachment fixture timed out: ' + description);
}

test('full content reinjection preserves one attachment, filler ownership and human-change journal', { skip: !playwright, timeout: 45000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-attachment-'));
  let context;
  t.after(async () => { await context?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  context = await playwright.chromium.launchPersistentContext(path.join(directory, 'profile'), {
    headless: true, channel: 'chromium', chromiumSandbox: true,
    ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}),
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ captureStorage: 'downloads',
    settings: { safeyoloMode: 'off', safeyoloKey: '', jevKey: '', llmKey: '', recordSecrets: false },
    personaText: JSON.stringify({ personas: [{ id: 'riley', role: 'participant', facts: { given_name: 'Riley' } }] }),
  }));
  const app = await context.newPage();
  await app.route('http://app.example.test/**', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><label>Given name<input name="given_name"></label>' }));
  await app.goto('http://app.example.test/attachment');
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url === 'http://app.example.test/attachment').id);
  const inspect = () => worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { kind: 'inspect-assistance' }), tabId);
  const original = await until(async () => { try { return await inspect(); } catch (_) { return false; } }, 'initial manifest attachment');
  await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId },
    func: () => { globalThis.fixtureOriginalPageFill = globalThis.TreadwayPageFill; } }), tabId);

  const panel = await context.newPage();
  await panel.goto('chrome-extension://' + extensionId + '/sidepanel.html');
  await panel.locator('#persona option').first().waitFor({ state: 'attached' });
  await panel.locator('#journey-name').fill('Content attachment ownership');
  await app.bringToFront(); await panel.locator('#start').click();
  await until(() => worker.evaluate(async () => (await chrome.storage.session.get('journey')).journey?.contextStatus === 'active'), 'recording started');

  // Reproduce both receiver repair and a later manifest injection: every file
  // is evaluated again, rather than only reloading the listener entry point.
  for (let pass = 0; pass < 2; pass++) {
    await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId },
      files: ['lib/fields.js', 'lib/form-runtime.js', 'lib/choice-binding.js', 'lib/page-fill.js', 'content.js'] }), tabId);
    assert.equal((await inspect()).documentInstanceId, original.documentInstanceId);
    const identity = await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId },
      func: () => ({ samePageFill: globalThis.fixtureOriginalPageFill === globalThis.TreadwayPageFill,
        alive: globalThis.__treadwayRecorderAttachment.alive() }) }), tabId);
    assert.deepEqual(identity[0].result, { samePageFill: true, alive: true });
  }

  await app.bringToFront(); await panel.locator('#fill').click();
  await until(async () => await panel.locator('#fill').isEnabled() && await panel.locator('#cancel-fill').isHidden(), 'one Fill all completed');
  assert.equal(await app.getByLabel('Given name').inputValue(), 'Riley');
  const beforeHuman = await worker.evaluate(async () => (await chrome.storage.session.get('journey')).journey.events);
  assert.equal(beforeHuman.filter(event => event.type === 'fill').length, 1);
  assert.equal(beforeHuman.filter(event => event.type === 'field' && event.source === 'human').length, 0,
    'own-action guards survive reinjection');

  await app.getByLabel('Given name').fill('Operator correction');
  await app.getByLabel('Given name').blur();
  await until(() => worker.evaluate(async () => (await chrome.storage.session.get('journey')).journey.events.some(event =>
    event.type === 'field' && event.source === 'human' && event.phase === 'change')), 'operator change journaled');
  // Stop drains every content receiver before returning the final event list.
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ kind: 'stop' }));
  assert.equal(stopped.error, undefined);
  const fills = stopped.finished.events.filter(event => event.type === 'fill');
  const changes = stopped.finished.events.filter(event => event.type === 'field' && event.source === 'human' && event.phase === 'change');
  assert.equal(fills.length, 1, 'one button invocation produces one final fill event');
  assert.equal(fills[0].filled.length, 1); assert.equal(fills[0].filled[0].retained, true);
  assert.equal(changes.length, 1, 'one operator change produces one change event');
  assert.equal(changes[0].value, 'Operator correction');
  assert.equal(fills[0].documentInstanceId, original.documentInstanceId);
  assert.equal(changes[0].documentInstanceId, original.documentInstanceId);
  assert.equal(fills[0].documentId, changes[0].documentId);
});
