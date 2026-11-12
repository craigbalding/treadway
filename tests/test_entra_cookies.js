const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = process.env.FORM_BROWSER_MODULE_ROOT || path.join(__dirname, '../src/treadway/browser');
const {captureCookies} = require(path.join(root, 'cookies.js'));
const {EntraLogin} = require(path.join(root, 'entra.js'));
const APP = 'https://workboard.example.invalid';
const binding = {origin: APP, actor: 'member', generation: 'synthetic-generation'};
const cookie = (value, extra = {}) => ({name: 'session', value, domain: 'workboard.example.invalid', path: '/',
  secure: true, httpOnly: true, session: true, expires: -1, sameSite: 'Lax', priority: 'Medium', ...extra});

test('application snapshot preserves all paths, duplicate names and metadata, excluding the IdP', async () => {
  const cookies = [cookie('root-private'), cookie('path-private', {path: '/api'}),
    cookie('domain-private', {domain: '.example.invalid'}), cookie('idp-private', {domain: 'idp.example.invalid'})];
  const session = {cdp: {send: async method => method === 'Storage.getCookies' ? {cookies} :
    {result: {value: {origin: APP, timeOrigin: 1}}}}};
  const result = await captureCookies(session, binding);
  assert.deepEqual(result.cookies, cookies.slice(0, 3));
  cookies[0].value = 'changed'; assert.equal(result.cookies[0].value, 'root-private');
});

test('cookie transport, malformed results and context changes are never empty success', async () => {
  for (const mode of ['throw', 'malformed', 'redirect']) {
    let observations = 0;
    const session = {cdp: {send: async method => {
      if (method === 'Storage.getCookies') {
        if (mode === 'throw') throw new Error('synthetic private transport detail');
        return mode === 'malformed' ? {} : {cookies: []};
      }
      return {result: {value: {origin: APP, timeOrigin: mode === 'redirect' ? ++observations : 1}}};
    }}};
    await assert.rejects(captureCookies(session, binding));
  }
});

test('verified reuse exports required cookies without credentials or another login; failures preserve verified authentication', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-cookie-export-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  let exports = 0, fail = false;
  const page = {origin: APP, path: '/home', ready: 'complete', inputs: [], links: [], body: 'Home'};
  const session = {cdp: {send: async (method, params) => {
    if (method === 'Storage.getCookies') {
      exports++;
      if (fail) throw new Error('synthetic-secret-cookie-transport');
      return {cookies: [cookie('synthetic-cookie-private')]};
    }
    return {result: {value: params.expression.includes('performance.timeOrigin') ? {origin: APP, timeOrigin: 1} : page}};
  }}};
  const options = {appOrigin: APP, principal: {actor: binding.actor, generation: binding.generation},
    verifyPrincipal: async () => ({state: 'valid', principal: {id: 'member'}}), exportCookies: true, evidenceRoot: dir,
    credentials: async () => {throw new Error('must not resolve credentials');},
    beforeSubmit: async () => {throw new Error('must not submit');}};
  const first = await new EntraLogin(session, options).run();
  assert.equal(first.status, 'verified'); assert.equal(first.reused, true);
  assert.equal(first.authentication.state, 'verified'); assert.equal(first.authenticationState.complete, true);
  const snapshot = JSON.parse(fs.readFileSync(first.authenticationState.artifact));
  assert.equal(snapshot.cookies[0].value, 'synthetic-cookie-private');
  assert.equal(fs.statSync(first.authenticationState.artifact).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(first).includes('synthetic-cookie-private'), false);
  fail = true;
  const failed = await new EntraLogin(session, options).run();
  assert.equal(failed.status, 'authentication_state_incomplete');
  assert.equal(failed.authentication.state, 'verified'); assert.equal(failed.authenticationState.complete, false);
  assert.equal(Object.hasOwn(failed.authenticationState, 'artifact'), false);
  assert.equal(JSON.stringify(failed).includes('synthetic-secret-cookie-transport'), false);
  assert.equal(exports, 2);
});
