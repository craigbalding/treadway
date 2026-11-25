'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
let playwright;
try { playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright'); } catch (_) {}
if (!playwright && process.env.RECORDER_REQUIRE_BROWSER === '1') throw new Error('Playwright is required for inline row checks');
const root = path.join(__dirname, '..');

test('human-order filling uses labelled rows without confusing control height with row order', { skip: !playwright, timeout: 45000 }, async t => {
  const browser = await playwright.chromium.launch({ headless: true, chromiumSandbox: true,
    ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  async function fixture(html) {
    await page.goto('about:blank');
    await page.setContent('<!doctype html>' + html);
    for (const file of ['fields.js', 'form-runtime.js', 'choice-binding.js', 'page-fill.js']) {
      await page.addScriptTag({ path: path.join(root, 'lib', file) });
    }
  }
  const given = '<label>Given name<input id="given" name="given_name"></label>';
  const notes = '<label>Counter notes<textarea id="notes" name="notes" required></textarea></label>';
  const email = '<label>Email<input id="email" name="email" type="email"></label>';
  const facts = Object.fromEntries(Object.entries({ given_name: 'Riley', notes: 'Synthetic background', email: 'riley@example.test', city: 'Harbor' })
    .map(([type, value]) => [type, { value, source: 'persona' }]));
  const order = () => page.evaluate(() => TreadwayPageFill.orderedFields(document).map(element => element.id));
  const fill = values => page.evaluate(values => TreadwayPageFill.fillAll(document, { values }), values);

  await t.test('inline Given name fills before the taller required gap and downstream Email remains untouched', async () => {
    await fixture('<form>' + given + notes + email + '</form>');
    const geometry = await page.evaluate(() => ({
      input: document.getElementById('given').getBoundingClientRect().top,
      textarea: document.getElementById('notes').getBoundingClientRect().top,
      givenLabel: document.getElementById('given').labels[0].getClientRects()[0].top,
      notesLabel: document.getElementById('notes').labels[0].getClientRects()[0].top,
    }));
    assert(geometry.textarea < geometry.input, 'exercise baseline-aligned controls with different top edges');
    assert.equal(geometry.givenLabel, geometry.notesLabel);
    assert.deepEqual(await order(), ['given', 'notes', 'email']);
    const { notes: omitted, ...values } = facts;
    const report = await fill(values);
    assert.deepEqual(report.filled.map(entry => entry.type), ['given_name']);
    assert.equal(report.manual.length, 1);
    assert.equal(report.manual[0].required, true);
    assert.equal(report.manual[0].binding.id, 'notes');
    assert.equal(report.blocked.reason, 'earlier required field unresolved');
    assert.equal(await page.locator('#given').inputValue(), 'Riley');
    assert.equal(await page.locator('#email').inputValue(), '');
  });
  await t.test('actual block rows remain top down', async () => {
    await fixture('<style>label{display:block}</style><form>' + given + notes + email + '</form>');
    assert.deepEqual(await order(), ['given', 'notes', 'email']);
    const report = await fill(facts);
    assert.deepEqual(report.filled.map(entry => entry.binding.id), ['given', 'notes', 'email']);
  });
  await t.test('a tall first control stays before a later control sharing its baseline', async () => {
    await fixture('<form>' + notes.replace('<textarea ', '<textarea rows="5" ') + given + '</form>');
    assert.deepEqual(await order(), ['notes', 'given']);
    const report = await fill(facts);
    assert.deepEqual(report.filled.map(entry => entry.binding.id), ['notes', 'given']);
  });
  await t.test('a spanning textarea does not make distinct lower grid rows appear to be its row', async () => {
    await fixture('<form style="display:grid;grid-template-columns:300px 300px">' +
      notes.replace('<label>', '<label style="grid-row:span 2">').replace('<textarea ', '<textarea rows="5" ') +
      given + '<label>City<input id="city" name="city"></label></form>');
    const boxes = await page.evaluate(() => ({
      textareaBottom: document.getElementById('notes').getBoundingClientRect().bottom,
      cityTop: document.getElementById('city').getBoundingClientRect().top,
    }));
    assert(boxes.textareaBottom > boxes.cityTop, 'exercise overlapping control boxes in distinct grid rows');
    assert.deepEqual(await order(), ['notes', 'given', 'city']);
    const report = await fill(facts);
    assert.deepEqual(report.filled.map(entry => entry.binding.id), ['notes', 'given', 'city']);
  });
  await t.test('CSS visual reordering still overrides source order', async () => {
    await fixture('<form style="display:flex;gap:10px">' + given.replace('<label>', '<label style="order:2">') +
      notes.replace('<label>', '<label style="order:1">') + '</form>');
    assert.deepEqual(await order(), ['notes', 'given']);
    const report = await fill(facts);
    assert.deepEqual(report.filled.map(entry => entry.binding.id), ['notes', 'given']);
  });
  await t.test('right-to-left labelled rows retain their reading direction', async () => {
    await fixture('<form dir="rtl">' + given.replace('Given name', 'שם פרטי') +
      notes.replace('Counter notes', 'הערות') + email.replace('Email', 'דואר') + '</form>');
    const positions = await page.evaluate(() => ['given', 'notes', 'email'].map(id => document.getElementById(id).getBoundingClientRect().left));
    assert(positions[0] > positions[1] && positions[1] > positions[2], 'exercise actual right-to-left control positions');
    assert.deepEqual(await order(), ['given', 'notes', 'email']);
    const report = await fill(facts);
    assert.deepEqual(report.filled.map(entry => entry.binding.id), ['given', 'notes', 'email']);
  });
  await t.test('multiple labels cannot supply a misleading detached row anchor', async () => {
    await fixture('<label for="given" style="position:absolute;top:0">Detached duplicate label</label>' +
      '<div style="margin-top:80px">' + given + '</div>' +
      '<label style="position:absolute;top:40px">City<input id="city" name="city"></label>');
    assert.equal(await page.locator('#given').evaluate(element => element.labels.length), 2);
    assert.deepEqual(await order(), ['city', 'given']);
    const report = await fill(facts);
    assert.deepEqual(report.filled.map(entry => entry.binding.id), ['city', 'given']);
  });
});
