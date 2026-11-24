'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Jev = require('../lib/jev.js');
const profile = { revision: 3, referenceDate: '2026-11-24', description: 'Casey is currently employed as an academic, is not retired, and seeks summer examination work. They require at least two remote work days each week.',
  facts: { given_name: 'Casey' }, preferences: { work: { minimum_remote_days_per_week: 2 } } };
const retired = { key: 'retired', mode: 'profile', field: { label: 'Are you retired?', inputType: 'radio' }, options: [{ label: 'Yes' }, { label: 'No' }] };
const result = (extra = {}) => ({ answers: { retired: { type: 'choice', choice: 'o1', confidence: 0.95 },
  retired__fits: { type: 'noul', noul: 0.9 }, retired__action: { type: 'choice', choice: 'select', confidence: 1 }, ...extra } });

test('profile decisions ask observed choices and support together without inventing an intent', async () => {
  const second = { ...retired, key: 'remote', field: { label: 'Minimum remote days', inputType: 'select' }, options: [{ label: 'None' }, { label: 'Two days' }] };
  const request = Jev.buildDecisionRequest([retired, second], profile);
  assert.equal(request.state.profile.revision, 3);
  assert.equal(request.state.widgets.retired.intendedValue, undefined);
  assert.equal(request.questions.retired.type, 'choice'); assert.equal(request.questions.retired__fits.type, 'noul');
  assert.equal(Object.keys(request.questions).length, 6);
  assert.equal(JSON.stringify(request).split(profile.description).length - 1, 1, 'shared context is not duplicated per question');
  let calls = 0;
  const answer = await Jev.decideWithJev({ apiKey: 'fixture', jobs: [retired], profile, fetch: async () => {
    calls++; return { ok: true, text: async () => JSON.stringify(result()) };
  } });
  assert.equal(calls, 1); assert.deepEqual(answer.retired, { action: 'select', index: 1, confidence: 0.95, fit: 0.9 });
});

test('confident profile guesses with insufficient evidence never select', () => {
  for (const answer of [result({ retired__fits: { type: 'noul', noul: 0.04 } }),
    result({ retired: { type: 'choice', choice: 'o1', confidence: 0.5 } }),
    result({ retired: { type: 'choice', choice: 'o7', confidence: 1 } })]) assert.deepEqual(Jev.readDecisionAnswers(answer, [retired]), {});
  assert.deepEqual(Jev.readDecisionAnswers(result(), [{ ...retired, loading: true }]), {});
});

test('profile checkbox choices preserve statement polarity without an implicit boolean fact', () => {
  const job = { key: 'none', mode: 'profile', field: { label: 'No professional registration number', inputType: 'checkbox' }, options: [{ label: 'Checked' }, { label: 'Unchecked' }] };
  const request = Jev.buildDecisionRequest([job], profile);
  assert(request.questions.none.criteria.o0.includes('is true')); assert(request.questions.none.criteria.o1.includes('is false'));
  assert.equal(request.questions.none.instructions.persona_fact, undefined);
  assert.equal(request.state.widgets.none.intendedValue, undefined);
});

test('invalid, missing or empty profiles/options make no model call', async () => {
  for (const input of [undefined, null, {}, { revision: 1 }, { description: 123 }, { facts: [] }, { description: 'x'.repeat(64001) }]) {
    const answer = await Jev.decideWithJev({ apiKey: 'fixture', jobs: [retired], profile: input, fetch: () => { throw Error('must not call'); } });
    assert.deepEqual(answer, {});
  }
  assert.deepEqual(await Jev.decideWithJev({ apiKey: 'fixture', jobs: [{ ...retired, options: [] }], profile, fetch: () => { throw Error('must not call'); } }), {});
});

test('mixed batch ignores provider answers for profile jobs omitted from the request', async () => {
  const known = { key: 'grade', type: 'grade', field: { label: 'Grade', inputType: 'select' }, intent: 'First', options: [{ label: 'First' }] };
  const answer = await Jev.decideWithJev({ apiKey: 'fixture', jobs: [known, retired], profile: {}, fetch: async () => ({ ok: true, text: async () => JSON.stringify(result()) }) });
  assert.equal(answer.retired, undefined);
});

test('sensitive fields and profile values are excluded before provider dispatch', () => {
  const privateProfile = { ...profile, facts: { email: 'private@example.test', password: 'PrivateExample!7', ppsn: '1234567FA' },
    description: profile.description + ' Contact private@example.test, password PrivateExample!7, PPS1234567FA.',
    domains: { banking: { iban: 'IE29AIBK93115212345678' } }, portrait: { src: 'assets/personas/private.svg' } };
  const request = Jev.buildDecisionRequest([retired], privateProfile), encoded = JSON.stringify(request);
  for (const secret of ['private@example.test', 'PrivateExample!7', '1234567FA', 'IE29AIBK', 'private.svg']) assert.equal(encoded.includes(secret), false, secret);
  const jobs = ['email', 'ppsn', 'ssn', 'iban', 'new_password'].map((type, i) => ({ ...retired, key: 'sensitive' + i, type }));
  assert.deepEqual(Jev.buildDecisionRequest(jobs, profile).questions, {});
});

test('upfront consistency review retains each named result and missing uncertainty', async () => {
  let calls = 0;
  const review = await Jev.reviewPersona({ apiKey: 'fixture', profile, fetch: async (_url, options) => {
    calls++; const request = JSON.parse(options.body); assert.equal(Object.keys(request.questions).length, Jev.REVIEW_CHECKS.length);
    return { ok: true, text: async () => JSON.stringify({ answers: { narrative_consistent: { type: 'noul', noul: 0.95 },
      history_consistent: { type: 'noul', noul: 0.1 }, preferences_consistent: { type: 'noul', noul: 0.5 },
      current_status_consistent: { type: 'noul', noul: 0.2 } } }) };
  } });
  assert.equal(calls, 1); assert.equal(review.checks.length, 5);
  assert.deepEqual(review.checks.map(check => check.status), ['pass', 'fail', 'uncertain', 'fail', 'uncertain']);
  assert.equal(review.checks.at(-1).probability, null);
  const absent = await Jev.reviewPersona({ apiKey: 'fixture', profile: {}, fetch: () => { throw Error('must not call'); } });
  assert(absent.checks.every(check => check.status === 'uncertain'));
});


test('categorical bank-account presence uses redacted profile context while identifier entries stay blocked', async () => {
  const accountProfile = { ...profile, domains: { banking: { accounts: [{ id: 'personal', country: 'IE',
    accountNumber: '123456789012', iban: 'IE29AIBK93115212345678' }] } } };
  const bank = { key: 'bank', mode: 'profile', type: 'has_bank_account',
    field: { name: 'has_bank_account', label: 'Do you have a bank account?', inputType: 'radio' },
    options: [{ label: 'Yes' }, { label: 'No' }] };
  const request = Jev.buildDecisionRequest([bank], accountProfile), encoded = JSON.stringify(request);
  assert(request.questions.bank); assert.equal(encoded.includes('123456789012'), false); assert.equal(encoded.includes('IE29AIBK'), false);
  assert.equal(request.state.profile.domains.banking.accounts[0].country, 'IE');
  const answer = await Jev.decideWithJev({ apiKey: 'fixture', jobs: [bank], profile: accountProfile,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ answers: { bank: { type: 'choice', choice: 'o0', confidence: 0.99 },
      bank__fits: { type: 'noul', noul: 0.95 }, bank__action: { type: 'choice', choice: 'select', confidence: 1 } } }) }) });
  assert.equal(answer.bank.index, 0);
  const number = { ...bank, type: 'bank_account_number', field: { label: 'Bank account number', inputType: 'text' } };
  assert.deepEqual(Jev.buildDecisionRequest([number], accountProfile).questions, {});
  const numericOptions = { ...bank, type: 'bank_account_number', field: { label: 'Bank account number', inputType: 'select' },
    options: [{ label: '123456789012' }, { label: '345678901234' }] };
  assert.deepEqual(Jev.buildDecisionRequest([numericOptions], accountProfile).questions, {});
  for (const type of ['ssn', 'ppsn', 'passport_number', 'has_api_key']) {
    const entry = { ...numericOptions, type, field: { label: type, inputType: 'select' } };
    assert.deepEqual(Jev.buildDecisionRequest([entry], accountProfile).questions, {}, type);
  }
});

test('document existence and status categories do not change evidence thresholds or establish entitlement', () => {
  const document = { key: 'document', mode: 'profile', type: 'has_passport_number',
    field: { label: 'Do you have a passport number?', inputType: 'checkbox' }, options: [{ label: 'Checked' }, { label: 'Unchecked' }] };
  const request = Jev.buildDecisionRequest([document], profile);
  assert(request.questions.document);
  assert.match(request.questions.document__fits.instructions.question, /enough evidence/);
  const status = { key: 'status', mode: 'profile', type: 'bank_account_status', field: { label: 'Account status', inputType: 'select' },
    options: [{ label: 'Active' }, { label: 'Inactive' }] };
  assert(Jev.buildDecisionRequest([status], profile).questions.status);
  assert.equal(Jev.MIN_CONFIDENCE, 0.51); assert.equal(Jev.MIN_FIT, 0.8);
  const unsupported = { answers: { document: { type: 'choice', choice: 'o0', confidence: 1 },
    document__fits: { type: 'noul', noul: 0.1 }, document__action: { type: 'choice', choice: 'select', confidence: 1 } } };
  assert.deepEqual(Jev.readDecisionAnswers(unsupported, [document]), {});
});


test('oversized raw profiles are rejected before invoking the shared sanitizer', () => {
  const Manager = require('../lib/persona-manager.js'), original = Manager.semanticContext;
  let calls = 0;
  try {
    Manager.semanticContext = value => { calls++; return original(value); };
    assert.deepEqual(Jev.buildDecisionRequest([retired], { description: 'x'.repeat(64001) }).questions, {});
    assert.equal(calls, 0);
    const circular = { description: 'Context' }; circular.self = circular;
    assert.deepEqual(Jev.buildDecisionRequest([retired], circular).questions, {});
    assert.equal(calls, 0);
  } finally { Manager.semanticContext = original; }
});
