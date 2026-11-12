const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/treadway/browser/browser-readiness.function.js'), 'utf8');

function page(options) {
  const element = {
    disabled: false, readOnly: false,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    closest: () => null,
    getAttribute: () => null,
  };
  const context = {
    options, Date, setInterval, clearInterval,
    window: { hydrated: false },
    document: { readyState: 'complete', querySelector: () => element },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  };
  return { context, element, run: () => vm.runInNewContext(source + '(options)', context) };
}

test('waits for usable controls and observed hydration, then returns immediately', async () => {
  const fixture = page({ selectors: ['#login'], predicate: 'window.hydrated === true', timeoutMs: 1000 });
  fixture.element.disabled = true;
  fixture.context.document.readyState = 'loading';
  const resultPromise = fixture.run();
  setTimeout(() => {
    fixture.context.document.readyState = 'complete';
    fixture.element.disabled = false;
    fixture.context.window.hydrated = true;
  }, 15);
  const result = await resultPromise;
  assert.equal(result.ready, true);
  assert.ok(result.elapsedMs < 1000);
});

test('hidden and disabled controls cannot satisfy a readiness gate', async () => {
  const fixture = page({ selectors: ['#login'], timeoutMs: 15 });
  fixture.element.disabled = true;
  fixture.context.getComputedStyle = () => ({ display: 'none', visibility: 'hidden', opacity: '0' });
  const result = await fixture.run();
  assert.equal(result.ready, false);
  assert.ok(result.unmet.includes('element_hidden'));
  assert.ok(result.unmet.includes('element_disabled'));
});

test('a missing control or failed application condition does not become ready after time passes', async () => {
  const fixture = page({ selectors: ['#login'], predicate: 'window.hydrated === true', timeoutMs: 15 });
  fixture.context.document.querySelector = () => null;
  const result = await fixture.run();
  assert.equal(result.ready, false);
  assert.ok(result.unmet.includes('element_missing'));
  assert.ok(result.unmet.includes('application_not_ready'));
});

test('the public CDP helper throws rather than advancing after a failed gate', async () => {
  const { waitForReady } = require('../src/treadway/browser/cdp.js');
  let calls = 0;
  const cdp = { send: async (method, params) => {
    calls++;
    assert.equal(method, 'Runtime.evaluate');
    const fixture = page({});
    fixture.context.document.querySelector = () => null;
    const result = await vm.runInNewContext(params.expression, fixture.context);
    return { result: { value: result } };
  }};
  await assert.rejects(waitForReady(cdp, { selectors: ['#missing'], timeoutMs: 15 }), /element_missing/);
  assert.equal(calls, 1);
});

test('an unspecified readiness condition cannot stand in for a rendered application', async () => {
  const { waitForReady } = require('../src/treadway/browser/cdp.js');
  const cdp = { send: () => { throw new Error('no condition should have been evaluated'); } };
  await assert.rejects(waitForReady(cdp), /observed selectors or an application predicate/);
});
