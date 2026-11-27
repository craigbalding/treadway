'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/background-harness.js');
const persona = { id: 'example-person', role: 'participant', label: 'Casey Example', revision: 3,
  description: 'Casey is currently employed as an academic and seeks occasional work. Casey prefers two days each week working from home.',
  facts: { given_name: 'Casey', email: 'casey@example.test' }, credentials: { password: 'PrivateFixture!7' },
  preferences: { remote_days: 2 }, histories: { education: [{ id: 'degree-a', institution: 'Example Academy', awardDate: '2005-06-30' }] } };
const workMessage = (operation = 'enrich') => ({ kind: 'persona-work-request', operation, personas: [persona], personaIds: [persona.id], brief: 'A fictional service accepts applications.', actor: 'participant' });

test('legacy persona-work transport is retired without changing retained pending artifacts', async () => {
  const pending = { requestId: 'old-fixture', status: 'queued' };
  const h = createHarness({ local: { pendingPersonaWork: pending } });
  for (const kind of ['persona-work-request', 'persona-work-check', 'persona-work-cancel', 'persona-work-finished']) {
    assert.match((await h.command({ kind, persona })).error, /retired/);
  }
  assert.deepEqual(h.local.pendingPersonaWork, pending);
});

test('persona saves and Fill all exclude each other and infer only within the current fill token', async () => {
  let release; let h; let saw;
  const deferred = new Promise(resolve => { release = resolve; });
  h = createHarness({ settings: { jevKey: 'model-key' }, frameMessage: async message => {
    if (message.kind === 'inspect-fill') return { needsNewPassword: false };
    if (message.kind !== 'fill') return { flushed: true };
    saw = message;
    await h.command({ kind: 'decide', fillToken: message.fillToken, jobs: [{ key: 'retired', mode: 'profile', type: 'retired', field: { label: 'Retired', inputType: 'select' }, options: [{ label: 'No' }, { label: 'Yes' }] }] });
    await deferred;
    return { report: { filled: [], manual: [], deductions: [{ key: 'field-retired', type: 'retired', value: 'No', confidence: 0.95, fit: 0.95 }] } };
  } });
  await h.start();
  const p = { ...persona, id: h.persona.id, role: h.persona.role };
  const lease = await h.command({ kind: 'persona-edit-begin' });
  assert((await h.command({ kind: 'fill', persona: p })).error.includes('persona edit'));
  await h.command({ kind: 'persona-edit-end', token: lease.token });
  const filling = h.command({ kind: 'fill', persona: p });
  for (let i = 0; i < 30 && !saw; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(saw?.fillToken); assert.equal((await h.command({ kind: 'status' })).fillBusy, true);
  assert((await h.command({ kind: 'persona-edit-begin' })).error.includes('Fill all'));
  const calls = h.calls.length;
  assert.deepEqual((await h.command({ kind: 'decide', fillToken: 'stale', jobs: [] })).decisions, {});
  assert.equal(h.calls.length, calls);
  release(); const answer = await filling;
  assert.equal(answer.preparedPersona.deductions['field-retired'].personaRevision, 3);
  assert.equal(answer.preparedPersona.revision, 3);
  assert.equal((await h.command({ kind: 'status' })).fillBusy, false);
  assert(h.session.journey.personaRevisions.some(item => item.revision === 3));
  assert(!JSON.stringify(h.session.journey.personaRevisions).includes('PrivateFixture!7'));
});


test('Start and later Fill reject configured keys in complete persona and direct values before evidence or page dispatch', async () => {
  for (const where of ['facts', 'credentials']) {
    const h = createHarness();
    const bad = { ...persona, id: h.persona.id, role: h.persona.role, [where]: { ...(persona[where] || {}), password: 'fixture-key' } };
    assert((await h.command({ kind: 'start', persona: bad, journeyName: 'Local synthetic probe' })).error.includes('API credential'));
    assert.equal(h.session.journey, undefined);
    assert.equal(h.calls.length, 0, 'no context request or evidence before rejected Start');
    await h.start();
    const before = JSON.stringify(h.session.journey);
    assert((await h.command({ kind: 'fill', persona: bad })).error.includes('API credential'));
    assert.equal(JSON.stringify(h.session.journey), before, 'edited persona cannot alter capture before rejection');
    assert((await h.command({ kind: 'fill', values: { email: { value: 'fixture-key' } } })).error.includes('API credential'));
    assert.equal(JSON.stringify(h.session.journey), before);
  }
});
