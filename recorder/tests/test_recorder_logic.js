'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Personas = require('../lib/personas.js');
const Fields = require('../lib/fields.js');
const Jev = require('../lib/jev.js');
const Context = require('../lib/test-context.js');
const Credentials = require('../lib/credentials.js');
const { webcrypto } = require('node:crypto');

const example = fs.readFileSync(path.join(__dirname, '..', 'examples', 'personas.json'), 'utf8');

test('assistance watcher actually runs through a symlinked CLI entry point', () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'recorder-assist-entry-'));
  try {
    const entry = path.join(directory, 'assist.mjs');
    fs.symlinkSync(path.join(__dirname, '../assist.mjs'), entry);
    const requestId = 'assist-11111111-2222-3333-4444-555555555555';
    fs.writeFileSync(path.join(directory, requestId + '.json'), JSON.stringify({
      schema: 'treadway.assistance/1', requestId, extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      run: 'synthetic-run', target: { tabId: 1, documentInstanceId: 'synthetic-document' }, form: [],
    }));
    const output = require('node:child_process').execFileSync(process.execPath,
      [entry, 'watch', directory, '1'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(JSON.parse(output).requestId, requestId);
    assert.equal(JSON.parse(output).timeout, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('packaged browser mechanics exactly match the existing library sources', () => {
  require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, '../build-runtime.mjs'), '--check']);
});

test('PPSN check character follows the published algorithm', () => {
  assert.equal(Personas.ppsnCheckCharacter('1234567', ''), 'T');
  assert.equal(Personas.ppsnCheckCharacter('1234567', 'A'), 'F');
  assert.equal(Personas.ppsnValid('1234567FA'), true);
  assert.equal(Personas.ppsnValid('1234567T'), true);
  assert.equal(Personas.ppsnValid('1234567TA'), false);
});

test('generated values are valid and deterministic per persona seed', () => {
  const [casey, sam] = Personas.parsePersonas(example);
  const now = new Date('2026-11-23T00:00:00Z');
  const first = Personas.personaValues(casey, now);
  assert.deepEqual(Personas.personaValues(casey, now), first);
  assert.equal(Personas.ppsnValid(first.ppsn.value), true);
  assert.equal(first.ppsn.source, 'generated');
  assert.equal(Personas.luhnValid(first.card_number.value), true);
  assert.ok(Personas.TEST_CARDS.includes(first.card_number.value));
  assert.equal(first.card_expiry.value, '12/29');
  assert.equal(first.card_name.value, 'Casey Example');
  assert.deepEqual(first.full_name, { value: 'Casey Example', source: 'persona' });
  assert.equal(first.display_name.value, 'Casey Example');
  assert.deepEqual(first.email, { value: 'casey.submitter@example.test', source: 'persona' });
  assert.notEqual(Personas.personaValues(sam, now).ppsn.value, first.ppsn.value);
  assert.equal(first.password, undefined, 'secrets are references, never fill values');
  for (const card of Personas.TEST_CARDS) assert.equal(Personas.luhnValid(card), true);
});

test('facts override generated values of the same type', () => {
  const [persona] = Personas.parsePersonas(JSON.stringify({ personas: [{ id: 'p', role: 'r', facts: { ppsn: '1234567FA' }, generate: ['ppsn'] }] }));
  assert.deepEqual(Personas.personaValues(persona).ppsn, { value: '1234567FA', source: 'persona' });
});

test('persona file errors name the problem', () => {
  assert.throws(() => Personas.parsePersonas('{'), /not valid JSON/);
  assert.throws(() => Personas.parsePersonas('{"personas":[]}'), /at least one persona/);
  assert.throws(() => Personas.parsePersonas('{"personas":[{"id":"a b","role":"r"}]}'), /personas\[0\]\.id/);
  assert.throws(() => Personas.parsePersonas('{"personas":[{"id":"a","role":"r"},{"id":"a","role":"r"}]}'), /duplicate persona id a/);
  assert.throws(() => Personas.parsePersonas('{"personas":[{"id":"a","role":"r","generate":["iban"]}]}'), /generate must list only/);
  assert.throws(() => Personas.parsePersonas('{"personas":[{"id":"a","role":"r","facts":{"email":1}}]}'), /facts\.email/);
});

test('rules use autocomplete, input type, then names and labels', () => {
  const field = (values) => Object.assign({ inputType: 'text', name: '', id: '', label: '', placeholder: '', autocomplete: '' }, values);
  assert.deepEqual(Fields.ruleType(field({ autocomplete: 'shipping postal-code', name: 'zz' })), { type: 'postcode', by: 'autocomplete' });
  assert.deepEqual(Fields.ruleType(field({ autocomplete: 'off', inputType: 'email' })), { type: 'email', by: 'input type' });
  assert.deepEqual(Fields.ruleType(field({ inputType: 'password', label: 'Confirm password' })), { type: 'new_password', by: 'input type' });
  assert.deepEqual(Fields.ruleType(field({ name: 'applicant[firstName]' })), { type: 'given_name', by: 'name' });
  assert.deepEqual(Fields.ruleType(field({ label: 'PPS Number' })), { type: 'ppsn', by: 'label' });
  assert.deepEqual(Fields.ruleType(field({ id: 'cardNumber' })), { type: 'card_number', by: 'id' });
  assert.deepEqual(Fields.ruleType(field({ placeholder: 'Eircode' })), { type: 'postcode', by: 'placeholder' });
  assert.equal(Fields.ruleType(field({ label: 'Reason for claim' })), null);
  assert.equal(Fields.ruleType(field({ label: 'Display name' })).type, 'display_name');
});

test('date of birth follows the field layout hint', () => {
  assert.equal(Fields.formatValue('date_of_birth', '1988-04-12', { inputType: 'date', placeholder: '', label: '' }), '1988-04-12');
  assert.equal(Fields.formatValue('date_of_birth', '1988-04-12', { inputType: 'text', placeholder: 'DD/MM/YYYY', label: '' }), '12/04/1988');
  assert.equal(Fields.formatValue('date_of_birth', '1988-04-12', { inputType: 'text', placeholder: '', label: 'Birth date (mm/dd/yyyy)' }), '04/12/1988');
  assert.equal(Fields.formatValue('email', 'a@example.test', {}), 'a@example.test');
});

test('Jev request asks one choice question per field and reads confident answers', async () => {
  const fields = [{ key: 'f0_0', label: 'Applicant PPS', name: 'x1', inputType: 'text' }, { key: 'f0_1', label: 'Notes' }];
  const request = Jev.buildJevRequest(fields, { ppsn: 'PPSN' });
  assert.equal(request.model, 'jev-latest');
  assert.deepEqual(request.state.fields.f0_0, { label: 'Applicant PPS', name: 'x1', inputType: 'text' });
  assert.equal(request.questions.f0_0.type, 'choice');
  assert.deepEqual(Object.keys(request.questions.f0_0.criteria), ['ppsn', 'other']);
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ answers: {
        f0_0: { type: 'choice', choice: 'ppsn', confidence: 0.92 },
        f0_1: { type: 'choice', choice: 'other', confidence: 0.99 },
      } }),
    };
  };
  const types = await Jev.classifyWithJev({ apiKey: 'k', fields, choices: { ppsn: 'PPSN' }, fetch: fakeFetch });
  assert.deepEqual(types, { f0_0: { type: 'ppsn', confidence: 0.92 } });
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer k');
  assert.deepEqual(Jev.readJevAnswers({ answers: { a: { type: 'choice', choice: 'email', confidence: 0.4 } } }, ['a']), {});
  await assert.rejects(Jev.classifyWithJev({ apiKey: 'k', fields, choices: {}, fetch: async () => ({ ok: false, status: 401, text: async () => 'no' }) }), /HTTP 401/);
});

test('test context uses SafeYOLO-safe values and the trusted agent', () => {
  const context = Context.buildContext({
    agent: 'browser-agent',
    persona: { id: 'sam-approver', role: 'approver' },
    journey: 'Approve expense claim!',
    startedAt: new Date('2026-11-23T10:11:12.345Z'),
  });
  assert.match(context.header, /^run=approve-expense-claim-20261123T101112Z-[a-f0-9]{8};agent=browser-agent;role=approver;test=approve-expense-claim;persona=sam-approver$/);
  const again = Context.buildContext({ agent: 'browser-agent', persona: { id: 'sam-approver', role: 'approver' }, journey: 'Approve expense claim!', startedAt: new Date('2026-11-23T10:11:12.345Z') });
  assert.notEqual(context.fields.run, again.fields.run, 'recordings started together cannot share event/file IDs');
  assert.throws(() => Context.slug('!!!'), /at least one letter/);
  assert.throws(() => Context.buildContext({ agent: 'bad agent', persona: { id: 'p', role: 'r' }, journey: 'x', startedAt: new Date() }), /agent/);
});

test('SafeYOLO calls send the bearer key and report API errors', async () => {
  const calls = [];
  const reply = (status, body) => async (url, options) => {
    calls.push({ url, options });
    return { status, text: async () => JSON.stringify(body) };
  };
  assert.deepEqual(await Context.readContext(reply(200, { agent: 'a', context: null }), 'key'), { agent: 'a', context: null });
  assert.equal(calls[0].url, 'http://_safeyolo.proxy.internal/api/test-context/current');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer key');
  await Context.declareContext(reply(200, { expires_in: 600 }), 'key', 'run=r;agent=a', 1200);
  assert.deepEqual(JSON.parse(calls[1].options.body), { context: 'run=r;agent=a', ttl: 1200 });
  assert.equal(calls[1].options.method, 'POST');
  await assert.rejects(Context.declareContext(reply(400, { error: 'Invalid test context', detail: 'bad' }), 'key', 'x', 1), /HTTP 400 \(Invalid test context: bad\)/);
  await assert.rejects(Context.clearContext(async () => { throw new Error('offline'); }, 'key'), /Cannot reach the SafeYOLO Agent API/);
});

test('context ownership matches the actual API object and preserves every field', () => {
  const header = 'run=trial;agent=fixture;role=applicant;persona=person-one';
  const object = { persona: 'person-one', role: 'applicant', agent: 'fixture', run: 'trial' };
  assert.equal(Context.sameContext(header, object), true);
  assert.equal(Context.sameContext(header, ' persona=person-one;role=applicant;agent=fixture;run=trial; '), true);
  assert.equal(Context.sameContext(header, { ...object, step: 'other' }), false);
  assert.equal(Context.sameContext(header, { ...object, persona: 'person-two' }), false);
  assert.equal(Context.sameContext(header, header + ';agent=fixture'), false);
  assert.equal(Context.sameContext(header, null), false);
  assert.equal(Context.sameContext(header, []), false);
});

test('Jev confidence floor is 0.51 and rejects invented candidate names', () => {
  const answer = (choice, confidence) => ({ answers: { field: { type: 'choice', choice, confidence } } });
  assert.equal(Jev.MIN_CONFIDENCE, 0.51);
  assert.deepEqual(Jev.readJevAnswers(answer('display_name', 0.5), ['field']), {});
  assert.equal(Jev.readJevAnswers(answer('display_name', 0.51), ['field']).field.type, 'display_name');
  assert.deepEqual(Jev.readJevAnswers(answer('invented', 0.99), ['field'], undefined, { display_name: 'Display name' }), {});
});

test('password generation persists once per persona before use and preserves supplied credentials', async () => {
  let stored = {}; let writes = 0;
  const options = { persona: Personas.parsePersonas(example)[0], needsNewPassword: true, crypto: webcrypto,
    read: async () => structuredClone(stored), write: async all => { writes += 1; stored = structuredClone(all); } };
  const [first, second] = await Promise.all([Credentials.prepare(options), Credentials.prepare(options)]);
  const password = first.persona.credentials.new_password;
  assert.equal(first.generated, true); assert.equal(second.generated, false);
  assert.equal(password, second.persona.credentials.new_password);
  assert.equal(password.length, 20);
  for (const pattern of [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/]) assert.match(password, pattern);
  assert.equal(writes, 2);
  assert.equal(Personas.personaValues(first.persona).new_password.credential, true);
  const supplied = { ...options, persona: { ...options.persona, credentials: { new_password: 'SuppliedTestPassword!7' } } };
  assert.equal((await Credentials.prepare(supplied)).persona.credentials.new_password, 'SuppliedTestPassword!7');
  const rotation = await Credentials.prepare({ ...options, persona: { ...options.persona,
    credentials: { password: 'OldTestPassword!1', new_password: 'NewTestPassword!2' } } });
  assert.notEqual(rotation.persona.secrets.password, rotation.persona.secrets.new_password);
  await assert.rejects(Credentials.prepare({ ...options, write: async () => { throw new Error('disk full'); } }), /disk full/);
});

test('an unknown existing-account password is not invented without a registration field', async () => {
  const prepared = await Credentials.prepare({ persona: Personas.parsePersonas(example)[0], needsNewPassword: false,
    read: async () => ({}), write: async () => { throw new Error('must stay passive'); }, crypto: webcrypto });
  assert.equal(prepared.generated, false);
  assert.equal(prepared.persona.credentials.password, undefined);
});


test('profile aliases preserve distinct phones and previous identifiers', () => {
  const [persona] = Personas.parsePersonas(JSON.stringify({ personas: [{ id: 'p', role: 'r', facts: {
    mobile_phone: '5550101', home_phone: '5550202', county: 'Example County', eircode: 'X00 X000',
    family_name: 'Example', ppsn: '1234567FA',
  } }] }));
  const values = Personas.personaValues(persona);
  assert.equal(values.phone.value, '5550101');
  assert.equal(values.home_phone.value, '5550202');
  assert.equal(values.region.value, 'Example County');
  assert.equal(values.postcode.value, 'X00 X000');
  assert.equal(Fields.ruleType({ name: 'previousSurname' }).type, 'previous_family_name');
  assert.equal(Fields.ruleType({ name: 'previousPpsn' }).type, 'previous_ppsn');
  assert.equal(Fields.ruleType({ name: 'homePhoneNumber' }).type, 'home_phone');
  assert.equal(values.previous_ppsn, undefined);
});

test('assistance merges persona facts without permitting identity or secret changes', () => {
  const Assistance = require('../lib/assistance.js');
  const persona = Personas.parsePersonas(example)[0];
  const updated = Assistance.mergeFacts(persona, { institution: 'Example College' });
  assert.equal(updated.facts.institution, 'Example College');
  assert.equal(updated.facts.email, persona.facts.email);
  assert.deepEqual(updated.credentials, persona.credentials);
  for (const facts of [{ email: 'different@example.test' }, { password: 'Synthetic!7' }, { institution: '' }]) {
    assert.throws(() => Assistance.mergeFacts(persona, facts));
  }
});
