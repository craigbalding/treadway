'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Jev = require('../lib/jev.js');

const grade = { key: 'grade', field: { label: 'Classification / Grade', inputType: 'select' },
  type: 'classification', intent: 'Second Class Honours, Grade 1',
  options: [{ label: '1' }, { label: '2.1' }, { label: '2.2' }] };
const answer = (changes = {}) => ({ answers: {
  grade: { type: 'choice', choice: 'o1', confidence: 0.96 },
  grade__fits: { type: 'noul', noul: 0.81 },
  grade__action: { type: 'choice', choice: 'select', confidence: 0.99 }, ...changes,
} });

test('semantic option choice, independent fit, and action share one batch', async () => {
  const jobs = [grade, { ...grade, key: 'second' }];
  const request = Jev.buildDecisionRequest(jobs);
  assert.equal(Object.keys(request.questions).length, 6);
  assert.deepEqual(request.questions.grade.criteria, { o0: '1', o1: '2.1', o2: '2.2' });
  assert.equal(request.questions.grade__fits.type, 'noul');
  assert.equal(request.state.widgets.grade.intendedValue, grade.intent);
  let calls = 0;
  const result = await Jev.decideWithJev({ apiKey: 'synthetic-key', jobs, fetch: async () => {
    calls++; return { ok: true, text: async () => JSON.stringify(answer()) };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.grade, { action: 'select', index: 1, confidence: 0.96, fit: 0.81 });
});

test('confidence, semantic fit, and observed-option membership are enforced independently', () => {
  for (const changes of [
    { grade: { type: 'choice', choice: 'o1', confidence: 0.5 } },
    { grade: { type: 'choice', choice: 'o1', confidence: 1.1 } },
    { grade: { type: 'choice', choice: 'o99', confidence: 0.99 } },
    { grade: { type: 'choice', choice: '2.1', confidence: 0.99 } },
    { grade__fits: { type: 'noul', noul: 0.79 } },
    { grade__fits: { type: 'noul', noul: 1.01 } },
    { grade__fits: undefined },
    { grade__action: { type: 'choice', choice: 'submit', confidence: 1 } },
  ]) assert.deepEqual(Jev.readDecisionAnswers(answer(changes), [grade]), {});
  assert.equal(Jev.readDecisionAnswers(answer({ grade: { type: 'choice', choice: 'o1', confidence: 0.51 } }), [grade]).grade.index, 1);
  assert.deepEqual(Jev.readDecisionAnswers(answer(), [{ ...grade, loading: true }]), {});
  assert.deepEqual(Jev.readDecisionAnswers(answer(), [{ ...grade, error: 'lookup failed' }]), {});
});

test('a wait decision cannot select stale options or run on a ready widget', () => {
  const waiting = answer({ grade__action: { type: 'choice', choice: 'wait', confidence: 0.95 } });
  assert.deepEqual(Jev.readDecisionAnswers(waiting, [{ ...grade, loading: true }]), { grade: { action: 'wait', confidence: 0.95 } });
  assert.deepEqual(Jev.readDecisionAnswers(waiting, [grade]), {});
  const request = Jev.buildDecisionRequest([{ ...grade, options: [], loading: true }]);
  assert.deepEqual(Object.keys(request.questions), ['grade__action']);
});

test('checkbox statement truth is separate from the persona fact polarity', () => {
  const job = { key: 'flag', type: 'has_registration_number', field: { label: 'No registration number', inputType: 'checkbox' },
    intent: 'No', options: [{ label: 'Checked' }, { label: 'Unchecked' }] };
  const request = Jev.buildDecisionRequest([job]);
  assert.equal(request.questions.flag.type, 'choice');
  assert.equal(request.questions.flag.instructions.persona_fact.has_registration_number, false);
  const response = (choice, confidence = 0.9) => ({ answers: { flag: { type: 'choice', choice, confidence },
    flag__fits: { type: 'noul', noul: 0.95 }, flag__action: { type: 'choice', choice: 'select', confidence: 1 } } });
  assert.equal(Jev.readDecisionAnswers(response('o0'), [job]).flag.index, 0);
  assert.equal(Jev.readDecisionAnswers(response('o1'), [job]).flag.index, 1);
  assert.deepEqual(Jev.readDecisionAnswers(response('o0', 0.5), [job]), {});
});

test('credential and contact values never enter semantic requests', async () => {
  for (const job of [
    { ...grade, type: 'new_password', intent: 'NeverSendSynthetic!7' },
    { ...grade, type: 'one_time_code', intent: '123456' },
    { ...grade, type: 'card_number', intent: '4242424242424242' },
    { ...grade, type: 'custom', field: { label: 'API key' }, intent: 'NeverSendSynthetic!7' },
    { ...grade, type: 'email', intent: 'private@example.test' },
    { ...grade, credential: true, intent: 'NeverSendSynthetic!7' },
  ]) {
    assert.equal(JSON.stringify(Jev.buildDecisionRequest([job])).includes(job.intent), false);
    assert.deepEqual(await Jev.decideWithJev({ apiKey: 'synthetic', jobs: [job], fetch: () => { throw Error('must not call provider'); } }), {});
  }
});

test('field classification rejects related facts when the companion fit fails', () => {
  const body = { answers: { home: { type: 'choice', choice: 'mobile_phone', confidence: 0.99 },
    home__fits: { type: 'noul', noul: 0.1 } } };
  assert.deepEqual(Jev.readJevAnswers(body, ['home'], undefined, { mobile_phone: 'Mobile number' }, true), {});
});
