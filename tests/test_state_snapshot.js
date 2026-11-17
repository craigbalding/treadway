const test = require('node:test');
const assert = require('node:assert/strict');
const {captureState, restoreState, verifyState, validateSnapshot} = require('../src/treadway/browser/state-snapshot');

const origin = 'https://app.example.invalid';
const binding = {projectId: 'project-one', application: 'workboard', identityRef: 'member', providerBinding: 'browser-service',
  origins: [origin], components: ['cookies', 'localStorage', 'sessionStorage']};
const input = {binding, actor: 'member', generation: 'generation-one',
  principal: {origin, probe: '/principal', expected: {principal: 'member'}}, landingUrl: origin + '/editor'};
const cookie = {name: 'session', value: 'synthetic-private', domain: 'app.example.invalid', path: '/', secure: true,
  httpOnly: true, session: true, expires: -1};
function fixture({principal = 'member', href = origin, storageEntries = [['item', 'original']]} = {}) {
  const calls = [];
  const session = {target: {browserContextId: 'context'}, cdp: {send: async (method, params) => {
    calls.push({method, params});
    if (method === 'Runtime.evaluate') {
      if (params.expression === 'location.href') return {result: {value: href}};
      if (params.expression.includes('timeOrigin')) return {result: {value: {origin, timeOrigin: 1}}};
      if (params.expression.startsWith('globalThis[')) return {result: {value: true}};
      return {result: {value: {complete: true, dispatched: true, status: 200, body: {principal}}}};
    }
    if (method === 'Storage.getCookies') return {cookies: href === 'about:blank' ? [] : [cookie]};
    if (method === 'DOMStorage.getDOMStorageItems') return {entries: storageEntries};
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return {identifier: 'own-script'};
    return {};
  }}, navigate: async url => { calls.push({method: 'navigate', url}); href = url; }};
  return {session, calls};
}

test('capture includes required cookie and per-page Web Storage with actual principal checks', async () => {
  const {session, calls} = fixture();
  const result = await captureState(session, input);
  assert.equal(result.complete, true);
  assert.deepEqual(result.cookies, [cookie]);
  assert.deepEqual(result.storage[origin].sessionStorage, [['item', 'original']]);
  assert.deepEqual(result.storage[origin].localStorage, [['item', 'original']]);
  assert.equal(result.sourceGeneration, 'generation-one');
  assert.equal(result.principal.observed.principal, 'member');
  assert.equal(calls.filter(call => call.method === 'Storage.getCookies').length, 1);
});

test('provider verification checks the actual user without importing or exporting state', async () => {
  const {session, calls} = fixture();
  const result = await verifyState(session, input);
  assert.equal(result.verified, true);
  assert.equal(result.principal.observed.principal, 'member');
  assert.equal(calls.filter(call => call.method === 'navigate').length, 1);
  assert.equal(calls.some(call => /^(?:Storage|DOMStorage)\./.test(call.method) || call.method === 'Page.addScriptToEvaluateOnNewDocument'), false);
  const wrong = fixture({principal: 'another-member'});
  await assert.rejects(verifyState(wrong.session, input), error => error.message === 'browser_state_actual_principal_differs'
    && error.observation.body.principal === 'another-member');
});

test('unsupported state and wrong bindings are refused before restore dispatch', async () => {
  const snapshot = await captureState(fixture().session, input);
  const {session, calls} = fixture({href: 'about:blank'});
  for (const changed of [{...binding, projectId: 'other'}, {...binding, identityRef: 'reviewer'},
    {...binding, origins: ['https://other.example.invalid']}, {...binding, components: ['indexedDB']}]) {
    await assert.rejects(restoreState(session, snapshot, {...input, binding: changed}), /browser_state_/);
  }
  await assert.rejects(restoreState(session, {...snapshot, complete: false}, input), /snapshot_incomplete/);
  assert.deepEqual(calls, []);
});

test('restore stays in fresh owned context, removes its script and verifies actual user', async () => {
  const snapshot = await captureState(fixture().session, input);
  const {session, calls} = fixture({href: 'about:blank'});
  const result = await restoreState(session, snapshot, {...input, generation: 'generation-two'});
  assert.equal(result.restored, true);
  assert.equal(result.sourceGeneration, 'generation-one');
  assert.equal(result.generation, 'generation-two');
  const cookies = calls.find(call => call.method === 'Storage.setCookies').params;
  assert.equal(cookies.browserContextId, 'context');
  assert.equal(cookies.cookies[0].httpOnly, true);
  assert.equal(Object.hasOwn(cookies.cookies[0], 'expires'), false);
  assert.equal(calls.at(-1).method, 'Page.removeScriptToEvaluateOnNewDocument');
  const wrong = fixture({href: 'about:blank', principal: 'reviewer'});
  await assert.rejects(restoreState(wrong.session, snapshot, input), /actual_principal_differs/);
  assert.equal(wrong.calls.at(-1).method, 'Page.removeScriptToEvaluateOnNewDocument');
});

test('wrong user, incomplete storage, non-fresh context and foreign cookie scope cannot pass', async () => {
  await assert.rejects(captureState(fixture({principal: 'reviewer'}).session, input), /actual_principal_differs/);
  await assert.rejects(captureState(fixture({storageEntries: null}).session, input), /web_storage_incomplete/);
  const snapshot = await captureState(fixture().session, input);
  const {session, calls} = fixture();
  await assert.rejects(restoreState(session, snapshot, input), /fresh_target_required/);
  assert.equal(calls.some(call => call.method === 'Storage.setCookies'), false);
  assert.throws(() => validateSnapshot({...snapshot, cookies: [{...cookie, domain: 'other.example.invalid'}]}, binding), /cookie_scope_unsupported/);
  assert.throws(() => validateSnapshot({...snapshot, storage: {}}, binding), /web_storage_incomplete/);
  assert.throws(() => validateSnapshot({...snapshot, cookies: [{...cookie, partitionKeyOpaque: true}]}, binding), /cookie_scope_unsupported/);
});
