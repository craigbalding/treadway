const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {navigateFixture} = require('./fixture-navigation.js');
const URL = 'http://fixture.example.invalid/';

function fixture({replace = true, usable = true, destination = URL, navigationError} = {}) {
  const control = {disabled: false, readOnly: false, getBoundingClientRect: () => ({width: 20, height: 20}),
    closest: () => null, getAttribute: () => null};
  const document = () => ({readyState: 'complete', querySelector: () => usable ? control : null});
  let loader = 'synthetic-old-loader';
  let page = {document: document(), location: {href: URL}, Date, setInterval, clearInterval,
    getComputedStyle: () => ({display: 'block', visibility: 'visible', opacity: '1'})};
  const calls = [];
  const cdp = new EventEmitter();
  cdp.send = async (method, parameters) => {
    calls.push(method);
    if (method === 'Page.navigate') {
      if (navigationError) throw navigationError;
      if (replace) {loader = 'synthetic-new-loader'; page = {...page, document: document(), location: {href: destination}};}
      return {frameId: 'synthetic-frame', loaderId: 'synthetic-new-loader'};
    }
    if (method === 'Page.getFrameTree') return {frameTree: {frame: {loaderId: loader}}};
    return {result: {value: await vm.runInNewContext(parameters.expression, page)}};
  };
  return {calls, cdp};
}

test('new fixture document and usable controls establish reset without a load event', async () => {
  const session = fixture();
  assert.equal((await navigateFixture(session, URL, {selectors: ['#name'], timeoutMs: 1000})).ready, true);
  assert.equal(session.calls.filter(method => method === 'Page.navigate').length, 1);
});

test('same URL and ready old controls cannot establish document replacement', async () => {
  const session = fixture({replace: false});
  await assert.rejects(navigateFixture(session, URL, {selectors: ['#name'], timeoutMs: 200}), /condition_not_established:new document committed/);
  assert.equal(session.calls.filter(method => method === 'Page.navigate').length, 1);
});

test('unacknowledged new-loader navigation cannot reuse the ready page', async () => {
  const session = fixture();
  const send = session.cdp.send;
  session.cdp.send = (method, parameters) => method === 'Page.navigate' ? {} : send(method, parameters);
  await assert.rejects(navigateFixture(session, URL, {selectors: ['#name'], timeoutMs: 1000}),
    /new_document_navigation_not_established/);
});

test('new document still requires actual controls and the exact fixture URL', async () => {
  for (const options of [{usable: false}, {destination: 'http://other.example.invalid/'}]) {
    await assert.rejects(navigateFixture(fixture(options), URL, {selectors: ['#name'], timeoutMs: 200}),
      /element_missing|application_not_ready/);
  }
});

test('unknown navigation effect preserves the original failure and never retries', async () => {
  const failure = new Error('synthetic acknowledgement lost');
  const session = fixture({navigationError: failure});
  await assert.rejects(navigateFixture(session, URL, {selectors: ['#name'], timeoutMs: 1000}), error => error === failure);
  assert.equal(session.calls.filter(method => method === 'Page.navigate').length, 1);
});
