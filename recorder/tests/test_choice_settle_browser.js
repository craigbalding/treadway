'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let playwright;
try { playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright'); } catch (_) {}
const repository = path.join(__dirname, '../..');
const assets = {
  '/react.js': 'node_modules/react/umd/react.development.js',
  '/react-dom.js': 'node_modules/react-dom/umd/react-dom.development.js',
  '/mui.js': 'node_modules/@mui/material/umd/material-ui.development.js',
};
const available = playwright && Object.values(assets).every(file => fs.existsSync(path.join(repository, file)));
if (!available && process.env.RECORDER_REQUIRE_BROWSER === '1') throw new Error('Playwright and MUI fixtures are required for choice settlement checks');
const html = `<!doctype html><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/mui.js"></script><script>
const h=React.createElement,{FormControl,InputLabel,Select,MenuItem,TextField}=MaterialUI;
function App(){const [region,setRegion]=React.useState(''),[postcode,setPostcode]=React.useState('');
 return h('form',{style:{width:500,margin:30}},
 h(FormControl,{fullWidth:true},h(InputLabel,{id:'region-label'},'Region'),h(Select,{id:'region',labelId:'region-label',value:region,label:'Region',MenuProps:{transitionDuration:600},onChange:e=>{window.choiceApplied=true;setRegion(e.target.value)}},h(MenuItem,{value:'Example county'},'Example county'))),
 h(TextField,{name:'postcode',label:'Postcode',value:postcode,onChange:e=>setPostcode(e.target.value),fullWidth:true}));}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));</script>`;

test('a selected modal choice finishes closing before another control is filled', { skip: !available, timeout: 45000 }, async t => {
  const browser = await playwright.chromium.launch({ headless: true, chromiumSandbox: true,
    ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => {
    const resource = assets[new URL(route.request().url()).pathname];
    return route.fulfill({ contentType: resource ? 'application/javascript' : 'text/html',
      body: resource ? fs.readFileSync(path.join(repository, resource)) : html });
  });
  async function fixture() {
    await page.goto('http://app.example.test/profile');
    await page.waitForSelector('input[name="postcode"]');
    for (const file of ['fields.js', 'form-runtime.js', 'choice-binding.js', 'page-fill.js']) {
      await page.addScriptTag({ path: path.join(repository, 'recorder/lib', file) });
    }
  }
  const values = { region: { value: 'Example county', source: 'persona' }, postcode: { value: '12345', source: 'persona' } };
  await t.test('the real MUI exit transition does not falsely occlude the following input', async () => {
    await fixture();
    const report = await page.evaluate(values => TreadwayPageFill.fillAll(document, { values }), values);
    assert.equal(report.filled.length, 2, JSON.stringify(report.manual));
    assert.equal(report.manual.length, 0);
    assert.equal(await page.locator('input[name="postcode"]').inputValue(), '12345');
    assert.equal(await page.locator('[role="listbox"]').count(), 0);
  });
  await t.test('another persistent cover still blocks the following input', async () => {
    await fixture();
    await page.evaluate(() => document.addEventListener('click', event => {
      if (!event.target.closest('[role="option"]')) return;
      setTimeout(() => {
        const cover = document.createElement('div'); cover.style = 'position:fixed;inset:0;z-index:99999;background:white';
        document.body.append(cover);
      }, 50);
    }, true));
    const report = await page.evaluate(values => TreadwayPageFill.fillAll(document, { values }), values);
    assert.equal(report.filled.length, 1);
    assert(report.manual.some(entry => entry.type === 'postcode' && entry.reason === 'control_occluded'));
    assert.equal(await page.locator('input[name="postcode"]').inputValue(), '');
  });
  await t.test('Stop during the exit transition prevents filling the next control', async () => {
    await fixture();
    const pending = page.evaluate(values => {
      window.abortFill = new AbortController();
      return TreadwayPageFill.fillAll(document, { values, signal: abortFill.signal });
    }, values);
    await page.waitForFunction(() => window.choiceApplied === true);
    await page.evaluate(() => abortFill.abort());
    const report = await pending;
    assert.equal(report.interrupted, true);
    assert.equal(await page.locator('input[name="postcode"]').inputValue(), '');
  });
  await t.test('an unconfirmed close never restores over a possibly committed selection', async () => {
    await page.goto('about:blank');
    await page.setContent('<label>Institution<input name="institution" role="combobox" aria-controls="choices" aria-expanded="false"></label>' +
      '<ul id="choices" role="listbox" style="display:none"><li role="option">Example Academy</li></ul>');
    for (const file of ['fields.js', 'form-runtime.js', 'choice-binding.js', 'page-fill.js']) {
      await page.addScriptTag({ path: path.join(repository, 'recorder/lib', file) });
    }
    await page.evaluate(() => {
      const input = document.querySelector('input'), list = document.querySelector('ul');
      const show = visible => { input.setAttribute('aria-expanded', String(visible)); list.style.display = visible ? 'block' : 'none'; };
      input.addEventListener('input', () => show(Boolean(input.value)));
      document.addEventListener('keydown', event => { if (event.key === 'Escape') show(false); });
      list.firstElementChild.addEventListener('click', () => { input.value = 'Example Academy'; window.selectionCommitted = true; });
    });
    const report = await page.evaluate(() => TreadwayPageFill.fillAll(document, {
      values: { institution: { value: 'Example Academy', source: 'persona' } },
    }));
    assert.equal(report.filled.length, 0);
    assert(report.manual.some(entry => entry.reason === 'choice popup did not close'));
    assert.equal(await page.evaluate(() => window.selectionCommitted), true);
    assert.equal(await page.locator('input').inputValue(), 'Example Academy');
  });
});
