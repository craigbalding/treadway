'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/background-harness');
const field = (name, type = name) => ({ binding: { tag: 'input', inputType: 'text', name, id: name, label: name },
  field: { tag: 'input', inputType: 'text', name, id: name, label: name }, required: true, hasValue: false, disabled: false, type });
function setup(infer) {
  const fields = [field('activity'), field('language')];
  const snapshot = { url: 'https://app.example.test/form', documentInstanceId: 'doc-fixture', fields };
  const h = createHarness({ settings: { safeyoloMode: 'off', llmKey: 'inference-fixture-key' }, infer,
    frameMessage: async message => message.kind === 'inspect-assistance' ? structuredClone(snapshot) : { flushed: true, failures: [] } });
  const persona = { ...h.persona, facts: { given_name: 'Taylor', family_name: 'Example', email: 'taylor@example.test' },
    description: 'Taylor is a currently employed synthetic teacher seeking additional work.' };
  const report = { filled: [], manual: [{ binding: fields[0].binding, field: fields[0].field, type: 'activity', reason: 'no persona value', required: true }],
    blocked: { binding: fields[0].binding, reason: 'earlier required field unresolved' } };
  return { h, fields, snapshot, persona, report };
}
test('one inference bundles observed required text gaps and returns a revisioned additions-only candidate', async () => {
  let calls = 0;
  const { h, persona, report } = setup(async ({ messages }) => {
    calls++;
    const request = JSON.parse(messages.at(-1).content);
    assert.equal(request.fields.length, 2);
    assert.ok(!JSON.stringify(request).includes('taylor@example.test'));
    return { answers: request.fields.map(item => ({ key: item.key, value: item.field.name === 'activity' ? 'Walking' : 'English' })) };
  });
  await h.command({ kind: 'start', persona, journeyName: 'Complete synthetic fields' });
  const result = await h.command({ kind: 'fill-complete', requestId: 'complete-one', persona, report });
  assert.equal(result.error, undefined);
  assert.equal(calls, 1);
  assert.equal(result.boundValues.length, 2);
  assert.equal(result.persona.facts.activity, 'Walking');
  assert.equal(result.persona.facts.language, 'English');
  assert.equal(result.persona.facts.email, persona.facts.email);
  assert.equal(result.persona.revision, 2);
  assert.equal(h.local.personaText, undefined, 'panel must CAS-persist candidate before using its values');
});
test('mechanical required failure never invokes inference or prepares downstream facts', async () => {
  let calls = 0;
  const { h, persona, report } = setup(async () => { calls++; });
  report.manual[0].reason = 'did not stick';
  await h.command({ kind: 'start', persona, journeyName: 'Mechanical failure' });
  const result = await h.command({ kind: 'fill-complete', requestId: 'mechanical', persona, report });
  assert.equal(result.skipped, true);
  assert.equal(calls, 0);
});
test('completion locks another Fill and Stop cancels a late inference result', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const { h, persona, report } = setup(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
  await h.command({ kind: 'start', persona, journeyName: 'Cancel completion' });
  const pending = h.command({ kind: 'fill-complete', requestId: 'cancel-one', persona, report });
  await ready;
  assert.equal((await h.command({ kind: 'status' })).fillBusy, true);
  assert.match((await h.command({ kind: 'fill', persona })).error, /already running/);
  await h.command({ kind: 'stop' });
  release({ answers: [{ key: 'g0', value: 'Never applied' }] });
  const result = await pending;
  assert.match(result.error, /cancelled/);
  assert.equal(h.local.personaText, undefined);
  assert.equal(h.session.journey, null);
});
test('an operator edit while inference waits prevents returning applicable generated values', async () => {
  const state = setup(async () => { state.snapshot.fields[0].hasValue = true; return { answers: [{ key: 'g0', value: 'Do not replace human' }] }; });
  await state.h.command({ kind: 'start', persona: state.persona, journeyName: 'Preserve edit' });
  const result = await state.h.command({ kind: 'fill-complete', requestId: 'edited', persona: state.persona, report: state.report });
  assert.match(result.error, /field changed/);
  assert.equal(state.h.local.personaText, undefined);
});
