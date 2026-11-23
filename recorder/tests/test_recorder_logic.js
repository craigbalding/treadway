'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Personas = require('../lib/personas.js');
const Fields = require('../lib/fields.js');
const Jev = require('../lib/jev.js');
const Context = require('../lib/test-context.js');

const example = fs.readFileSync(path.join(__dirname, '..', 'examples', 'personas.json'), 'utf8');

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
