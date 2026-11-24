'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
let playwright;
try { playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright'); } catch (_) {}
if (!playwright && process.env.RECORDER_REQUIRE_BROWSER === '1') throw new Error('playwright is required for widget regression checks');
const root = path.join(__dirname, '..');

test('fill readback distinguishes retention from validation and instant scroll preserves hit guards', { skip: !playwright, timeout: 30000 }, async t => {
  const browser = await playwright.chromium.launch({ headless: true, chromiumSandbox: true,
    ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}),
    ...(process.env.HTTP_PROXY ? { proxy: { server: process.env.HTTP_PROXY } } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  async function fixture(html) {
    await page.goto('about:blank'); await page.setContent('<!doctype html>' + html);
    for (const file of ['fields.js', 'form-runtime.js', 'choice-binding.js', 'page-fill.js']) await page.addScriptTag({ path: path.join(root, 'lib', file) });
  }
  const fill = values => page.evaluate(values => TreadwayPageFill.fillAll(document, { values }), values);
  await t.test('a retained value with application validation is not reported as did-not-stick or success', async () => {
    await fixture('<label>Given name<input name="givenName" aria-invalid="true" aria-errormessage="name-error" aria-describedby="name-hint"></label><p id="name-error">Application-specific rule rejected this value.</p><p id="name-hint">The associated validation helper describes the required format.</p>');
    const report = await fill({ given_name: { value: 'Retained name', source: 'persona' } });
    assert.equal(report.filled.length, 0); assert.equal(report.manual.length, 1);
    const entry = report.manual[0];
    assert.equal(entry.reason, 'validation error'); assert.equal(entry.retained, true);
    assert.equal(entry.value, 'Retained name'); assert.equal(entry.expectedValue, 'Retained name'); assert.equal(entry.observedValue, 'Retained name');
    assert.equal(entry.validation.ariaInvalid, 'true'); assert.equal(entry.validation.invalid, true);
    assert.deepEqual(entry.validation.messages, ['Application-specific rule rejected this value.']);
    assert.deepEqual(entry.validation.descriptions, ['The associated validation helper describes the required format.']);
    assert.equal(entry.source, 'persona');
  });
  await t.test('native constraint failure is retained separately from value equality', async () => {
    await fixture('<label>Email<input name="email" type="email"></label>');
    const report = await fill({ email: { value: 'not-an-email', source: 'persona' } });
    assert.equal(report.filled.length, 0); const entry = report.manual[0];
    assert.equal(entry.reason, 'validation error'); assert.equal(entry.retained, true);
    assert.equal(entry.validation.nativeValid, false); assert(entry.validation.nativeIssues.includes('typeMismatch'));
    assert.equal(entry.observedValue, 'not-an-email');
  });
  await t.test('a framework rejecting the edit still reports actual value loss', async () => {
    await fixture('<label>Given name<input name="givenName" oninput="this.value=\'\'"></label>');
    const report = await fill({ given_name: { value: 'Attempted name', source: 'persona' } });
    const entry = report.manual[0];
    assert.equal(entry.reason, 'did not stick'); assert.equal(entry.retained, false);
    assert.equal(entry.expectedValue, 'Attempted name'); assert.equal(entry.observedValue, '');
    assert.equal(entry.validation.invalid, false);
  });
  await t.test('validation arising after a later field demotes earlier success with the right reason', async () => {
    await fixture('<label>Given name<input id="given" name="givenName"></label><label>Surname<input name="surname" oninput="document.getElementById(\'given\').setAttribute(\'aria-invalid\',\'true\')"></label>');
    const report = await fill({ given_name: { value: 'Alex', source: 'persona' }, family_name: { value: 'Example', source: 'persona' } });
    assert.equal(report.filled.length, 1); assert.equal(report.filled[0].type, 'family_name');
    const entry = report.manual.find(item => item.type === 'given_name');
    assert.equal(entry.reason, 'validation error'); assert.equal(entry.retained, true);
    assert.equal(entry.expectedValue, 'Alex'); assert.equal(entry.observedValue, 'Alex');
  });
  await t.test('a later required asterisk preserves the same control binding and retained value', async () => {
    await fixture('<label id="first-label" for="first">Given name</label><input id="first" name="givenName">' +
      '<label>Surname<input name="surname" oninput="document.getElementById(\'first-label\').textContent=\'Given name *\';document.getElementById(\'first\').required=true"></label>');
    const report = await fill({ given_name: { value: 'Alex', source: 'persona' }, family_name: { value: 'Example', source: 'persona' } });
    assert.equal(report.filled.length, 2); assert.equal(report.manual.length, 0);
    const entry = report.filled.find(item => item.type === 'given_name');
    assert.equal(entry.retained, true); assert.equal(entry.observedValue, 'Alex');
    assert.equal(await page.evaluate(binding => TreadwayPageFill.resolveField(document, binding)?.id, entry.binding), 'first');
    assert.equal(await page.evaluate(() => TreadwayPageFill.describeField(document.getElementById('first')).label), 'Given name *', 'raw observation retains the decoration');
  });
  await t.test('a genuine question change is reported as unknown binding, not inferred value loss', async () => {
    await fixture('<label id="first-label" for="first">Given name</label><input id="first" name="givenName">' +
      '<label>Surname<input name="surname" oninput="document.getElementById(\'first-label\').textContent=\'A different question\'"></label>');
    const report = await fill({ given_name: { value: 'Alex', source: 'persona' }, family_name: { value: 'Example', source: 'persona' } });
    const entry = report.manual.find(item => item.type === 'given_name');
    assert.equal(entry.reason, 'field changed'); assert.equal(entry.observedValue, null); assert.equal(entry.retained, null);
    assert.equal(await page.locator('#first').inputValue(), 'Alex', 'a failed binding is not evidence of value loss');
  });
  await t.test('normalising decoration never chooses between ambiguous controls', async () => {
    await fixture('<label>Given name<input id="duplicate" name="givenName"></label>' +
      '<label>Given name *<input id="duplicate" name="givenName"></label>');
    const report = await fill({ given_name: { value: 'Alex', source: 'persona' } });
    assert.equal(report.filled.length, 0); assert(report.manual.every(entry => entry.reason === 'field changed'));
    assert.deepEqual(await page.locator('input').evaluateAll(nodes => nodes.map(node => node.value)), ['', '']);
  });
  await t.test('CSS smooth scrolling cannot leave the prepared hit point offscreen', async () => {
    await fixture('<style>html{scroll-behavior:smooth}body{height:3200px;margin:0}#deep{position:absolute;top:2200px;left:80px;width:220px;height:40px}</style><input id="deep" aria-label="Deep field">');
    const result = await page.evaluate(() => {
      const ref = TreadwayFormRuntime('locate', { selector: '#deep' }).ref;
      const hit = TreadwayFormRuntime('prepare', { ref });
      return { hit, scrolled: scrollY, at: document.elementFromPoint(hit.x, hit.y).id };
    });
    assert(result.scrolled > 1500); assert(result.hit.y >= 0 && result.hit.y <= 600); assert.equal(result.at, 'deep');
    await page.evaluate(() => {
      const cover = document.createElement('div'); cover.style = 'position:fixed;inset:0;background:white;z-index:99999'; document.body.append(cover);
    });
    const blocked = await page.evaluate(() => {
      try { TreadwayFormRuntime('prepare', { ref: TreadwayFormRuntime('locate', { selector: '#deep' }).ref }); return null; }
      catch (error) { return error.message; }
    });
    assert.equal(blocked, 'control_occluded', 'real occlusion must still block preparation');
  });
});
