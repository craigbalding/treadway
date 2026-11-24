'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
let playwright;
try { playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright'); } catch (_) {}
if (!playwright && process.env.RECORDER_REQUIRE_BROWSER === '1') throw new Error('playwright is required for persona history checks');
const root = path.join(__dirname, '..');
test('generic history facts do not spill into additional rows when a peer is already populated or appears later', { skip: !playwright, timeout: 30000 }, async t => {
  const browser = await playwright.chromium.launch({ headless: true, chromiumSandbox: true,
    ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}),
    ...(process.env.HTTP_PROXY ? { proxy: { server: process.env.HTTP_PROXY } } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  async function fixture(html) {
    await page.goto('about:blank'); await page.setContent('<!doctype html>' + html);
    for (const file of ['fields.js', 'form-runtime.js', 'choice-binding.js', 'page-fill.js']) await page.addScriptTag({ path: path.join(root, 'lib', file) });
  }
  const values = { institution: { value: 'Shared Academy', source: 'persona' } };
  const fill = input => page.evaluate(values => TreadwayPageFill.fillAll(document, { values }), input);
  await fixture('<label>Institution<input name="primaryCollege" value="Existing Academy"></label><label>Institution<input name="additionalCollege"></label>');
  let report = await fill(values);
  assert.deepEqual(await page.locator('input').evaluateAll(inputs => inputs.map(input => input.value)), ['Existing Academy', '']);
  assert.equal(report.filled.length, 0); assert.equal(report.manual.length, 1);
  assert.match(report.manual[0].reason, /explicit persona binding/);

  await fixture('<label>Institution<input name="primaryCollege" oninput="if(!document.querySelector(\'#additional\')){const label=document.createElement(\'label\');label.textContent=\'Institution\';label.innerHTML+=\'<input id=additional name=additionalCollege>\';document.body.append(label)}"></label>');
  report = await fill(values);
  assert.deepEqual(await page.locator('input').evaluateAll(inputs => inputs.map(input => input.value)), ['Shared Academy', '']);
  assert.equal(report.filled.length, 1); assert.equal(report.manual.length, 1);
  assert.match(report.manual[0].reason, /explicit persona binding/);

  await fixture('<label>Institution<input name="primary_institution" value="Existing Academy"></label><label>Institution<input name="additional_institution"></label>');
  report = await fill({ primary_institution: { value: 'Existing Academy', source: 'persona' }, additional_institution: { value: 'Distinct Academy', source: 'persona' } });
  assert.deepEqual(await page.locator('input').evaluateAll(inputs => inputs.map(input => input.value)), ['Existing Academy', 'Distinct Academy']);
  assert.equal(report.filled.length, 1); assert.equal(report.manual.length, 0);
});
