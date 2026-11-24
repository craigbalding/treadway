'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Personas = require('../lib/personas.js');
const Manager = require('../lib/persona-manager.js');
const base = () => Manager.createPersona({ id: 'casey', role: 'applicant', facts: { given_name: 'Casey', family_name: 'Example',
  email: 'casey@example.test', date_of_birth: '1984-04-12' }, referenceDate: '2026-11-24',
  credentials: { password: 'PrivateExample!7' }, description: 'Casey currently teaches three days each week, wants at least two days working from home and seeks occasional examination work.',
  domains: { physical: { height_cm: 174, weight_kg: 72 } }, histories: { education: [{ id: 'degree-1', institution: 'Example Academy', startDate: '2002-09-01', endDate: '2006-06-30' }] },
}, { source: 'agent', now: '2026-11-24T00:00:00Z' });

test('legacy and rich personas roundtrip with distinct arbitrary histories', () => {
  const legacy = Personas.parsePersonas('{"personas":[{"id":"legacy","role":"user","facts":{"given_name":"Casey"}}]}')[0];
  assert.equal(legacy.revision, 1); assert.deepEqual(legacy.histories, {});
  const p = base(); p.domains.specialty = { uncommon_status: true, value: 0, qualifiers: ['part-time'] };
  p.histories.education.push({ id: 'degree-2', institution: 'Other Example College', awardDate: '2008-06-01' });
  const roundtrip = Personas.parsePersonas(JSON.stringify({ personas: [p] }))[0];
  assert.deepEqual(roundtrip, p); assert.equal(roundtrip.histories.education[1].institution, 'Other Example College');
  assert.equal(Personas.personaValues(roundtrip).institution, undefined, 'ambiguous multiple institutions are never flattened');
});

test('parser rejects duplicate record IDs, unsafe keys, malformed dates and external portrait fetches', () => {
  const p = base();
  const parse = value => Personas.parsePersonas(JSON.stringify({ personas: [value] }));
  assert.throws(() => parse({ ...p, histories: { education: [p.histories.education[0], p.histories.education[0]] } }), /unique stable ids/);
  assert.throws(() => parse({ ...p, portrait: { src: 'https://images.example.test/person.png' } }), /local image/);
  assert.throws(() => parse({ ...p, referenceDate: '2026-99-99' }), /referenceDate/);
  assert.throws(() => parse({ ...p, revisions: {} }), /revisions.*array/);
  assert.throws(() => Personas.parsePersonas('{"personas":[{"id":"p","role":"r","facts":{"__proto__":"bad"}}]}'), /unsafe key/);
  assert.throws(() => parse({ ...p, domains: JSON.parse('{"constructor": {"prototype": {"bad":true}}}') }), /unsafe key/);
});

test('manual edits are revisioned, preserve bindings, invalidate deductions and keep redacted prior snapshots', () => {
  let p = Manager.recordDeductions(base(), [{ key: 'retired-control', type: 'retired', value: 'No', confidence: 0.95, fit: 0.9 }], { expectedRevision: 1 });
  const changed = Manager.editPersona(p, { facts: { ...p.facts, retired: 'No' }, description: p.description + ' A correction from the operator.' }, { expectedRevision: 1, now: '2026-11-24T01:00:00Z' });
  assert.equal(changed.revision, 2); assert.deepEqual(changed.deductions, {});
  assert.equal(changed.facts.email, p.facts.email); assert.deepEqual(changed.credentials, p.credentials);
  assert(changed.overrides.includes('/facts/retired'));
  assert.equal(changed.revisions[0].revision, 1); assert.equal(changed.revisions[0].snapshot.description, p.description);
  assert.equal(changed.revisions[0].snapshot.credentials, undefined);
  assert.throws(() => Manager.editPersona(changed, { label: 'new' }, { expectedRevision: 1 }), /revision changed/);
  assert.throws(() => Manager.editPersona(changed, { id: 'other' }), /immutable/);
  assert.throws(() => Manager.editPersona(changed, { facts: { ...changed.facts, email: 'other@example.test' } }), /Identity contact/);
});

test('enrichment adds missing data and reviews conflicts while preserving operator corrections', () => {
  const p = Manager.editPersona(base(), { facts: { ...base().facts, retired: 'No' } });
  const proposal = Manager.proposeEnrichment(p, { facts: { retired: 'Yes', preferred_subject: 'Computing' }, description: 'New agent narrative' }, { expectedRevision: 2 });
  assert(proposal.conflicts.includes('/facts/retired')); assert(proposal.additions.includes('/facts/preferred_subject'));
  assert.equal(proposal.changes.find(c => c.path === '/facts/retired').operatorOverride, true);
  const additions = Manager.applyProposal(p, proposal, undefined, { expectedRevision: 2 });
  assert.equal(additions.facts.retired, 'No'); assert.equal(additions.facts.preferred_subject, 'Computing');
  assert.equal(additions.description, p.description);
  assert.throws(() => Manager.applyProposal(additions, proposal), /stale/);
  const accepted = Manager.applyProposal(p, proposal, ['/facts/retired'], { expectedRevision: 2 });
  assert.equal(accepted.facts.retired, 'Yes'); assert(accepted.overrides.includes('/facts/retired'));
  assert.equal(accepted.provenance['/facts/retired'].source, 'agent_enrichment');
});

test('operator removal remains protected and creation does not lock unknown future facts', () => {
  const created = Manager.createPersona({ id: 'p', role: 'r', facts: { given_name: 'Casey' } });
  assert(created.overrides.includes('/facts/given_name')); assert(!created.overrides.includes('/facts'));
  const add = Manager.propose(created, { facts: { retired: 'No' } });
  assert(add.additions.includes('/facts/retired'));
  const p = Manager.edit(base(), { facts: { given_name: 'Casey', family_name: 'Example', email: 'casey@example.test' } });
  const readd = Manager.propose(p, { facts: { date_of_birth: '1984-04-12' } });
  assert(readd.conflicts.includes('/facts/date_of_birth'));
});

test('history enrichment merges by stable record ID and keeps qualifications separate', () => {
  const p = base();
  const proposal = Manager.propose(p, { histories: { education: [{ id: 'degree-1', grade: 'First' },
    { id: 'degree-2', institution: 'Other Academy', awardDate: '2008-06-01' }] } });
  const result = Manager.applyProposal(p, proposal);
  assert.equal(result.histories.education.length, 2); assert.equal(result.histories.education[0].institution, 'Example Academy');
  assert.equal(result.histories.education[0].grade, 'First'); assert.equal(result.histories.education[1].institution, 'Other Academy');
  assert.throws(() => Manager.propose(p, { facts: { email: 'new@example.test' } }), /Identity contact/);
});

test('semantic context removes identifiers recursively and scrubs known values from narrative', () => {
  const p = base(); Object.assign(p.facts, { has_registration_number: 'No', ppsn: '1234567FA', username: 'casey.login' });
  p.domains.identity = { passports: [{ issuer: 'IE', citizenship: 'IE', number: 'EX1234567' }], nationalIds: [{ scheme: 'SSN', country: 'US', value: '123-45-6789' }] };
  p.domains.bank = { iban: 'IE29AIBK93115212345678', country: 'IE' };
  p.description += ' Email casey@example.test, password PrivateExample!7, passport EX1234567, PPS 1234567FA, bank IE29 AIBK 9311 5212 3456 78.';
  p.portrait = { src: 'assets/personas/casey.svg' };
  const context = Manager.semanticContext(p), encoded = JSON.stringify(context);
  for (const value of ['casey@example.test', 'PrivateExample!7', 'EX1234567', '1234567FA', 'IE29', '123-45-6789', 'casey.login', 'casey.svg']) assert.equal(encoded.includes(value), false, value);
  assert.equal(context.domains.identity.passports[0].issuer, 'IE'); assert.equal(context.facts.has_registration_number, 'No');
  assert.equal(context.domains.bank.country, 'IE'); assert.equal(context.credentials, undefined);
});

test('accepted deductions cache by binding and input revision; explicit facts take precedence', () => {
  const p = base();
  const entries = [{ key: 'retired-control', type: 'retired', value: 'No', selectedLabel: 'No', confidence: 0.95, fit: 0.9 },
    { key: 'given-control', type: 'given_name', value: 'Wrong', confidence: 1, fit: 1 },
    { key: 'low', value: 'No', confidence: 0.5, fit: 1 }];
  const stored = Manager.recordDeductions(p, entries, { expectedRevision: 1 });
  assert.equal(stored.revision, 1); assert.equal(stored.deductions['retired-control'].personaRevision, 1);
  assert.equal(stored.deductions['given-control'], undefined); assert.equal(stored.deductions.low, undefined);
  assert.equal(Object.keys(Manager.usableDeductions(stored)).length, 1);
  const changed = { ...stored, description: 'Changed externally without revision bump' };
  assert.deepEqual(Manager.usableDeductions(changed), {});
  assert.throws(() => Manager.recordDeductions(stored, entries, { expectedRevision: 2 }), /revision changed/);
});

test('preflight names independent chronology, measurement and bank checks', () => {
  const p = base(); assert.equal(Manager.preflight(p).ready, true);
  const bad = { ...p, domains: { physical: { weight_kg: 0 }, bank: { country: 'GB', iban: 'IE29AIBK93115212345678' } },
    histories: { education: [{ id: 'bad-degree', startDate: '1980-01-01', endDate: '1979-01-01' }] } };
  const result = Manager.preflight(bad); assert.equal(result.ready, false);
  assert(result.checks.some(c => c.id.startsWith('physical.') && c.status === 'fail'));
  assert(result.checks.some(c => c.id.startsWith('bank.country') && c.status === 'fail'));
  assert(result.checks.some(c => c.id.startsWith('history.order') && c.status === 'fail'));
  assert(result.checks.some(c => c.id.startsWith('history.birth') && c.status === 'fail'));
});


test('app account links and legacy credential facts survive enrichment without mutation', () => {
  const p = base(); p.accountLinks = { example: { accountId: 'sample-account-1', username: p.facts.email } }; p.facts.password = 'PreservedPrivate!7';
  const normalised = Personas.parsePersonas(JSON.stringify({ personas: [p] }))[0];
  const next = Manager.edit(normalised, { label: 'Edited display label' });
  assert.deepEqual(next.accountLinks, p.accountLinks);
  assert.throws(() => Manager.edit(next, { facts: { ...next.facts, password: 'ChangedPrivate!7' } }), /credential facts/);
  assert.throws(() => Manager.propose(next, { facts: { password: 'ChangedPrivate!7' } }), /credential facts/);
  assert.equal(JSON.stringify(Manager.semanticContext(p)).includes('sample-account-1'), false);
});

test('embedded portraits are self-contained images rather than executable SVG documents', () => {
  const encode = svg => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  assert(Personas.safePortraitSource(encode('<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="a" d="M0 0"/></defs><use href="#a"/></svg>')));
  for (const svg of ['<svg><script>alert(1)</script></svg>', '<svg><use href="https://example.test/a.svg"/></svg>', '<svg xml:base="https://example.test/"><use href="#a"/></svg>', '<svg onload="alert(1)"></svg>', '<svg><foreignObject/></svg>']) assert.equal(Personas.safePortraitSource(encode(svg)), false);
});


test('preflight keeps residence distinct from bank jurisdiction and accepts arbitrary history text keys', () => {
  const p = base(); p.facts.country = 'GB'; p.facts.iban = 'DE89370400440532013000';
  p.histories.education[0].candidate = 'Casey'; p.histories.education[0].update = 'Reviewed recently';
  assert.equal(Manager.preflight(p).ready, true);
  p.domains.identity = { passports: [{ id: 'p', issueDate: '2026-99-99' }] };
  assert(Manager.preflight(p).checks.some(c => c.path.endsWith('/issueDate') && c.status === 'fail'));
});


test('revision snapshots strip legacy and nested credentials while retaining contacts and secret references', () => {
  const p = base(); p.facts.password = 'LegacyPrivate!7'; p.domains.integration = { apiKey: 'sk_exampleSecret123456', issuer: 'Example' };
  p.description += ' LegacyPrivate!7 and PrivateExample!7 and sk_exampleSecret123456.';
  p.secrets = { password: 'TEST_PASSWORD_REFERENCE' };
  const result = Manager.edit(p, { label: 'Updated label' });
  const snapshot = result.revisions[0].snapshot, encoded = JSON.stringify(snapshot);
  for (const secret of ['LegacyPrivate!7', 'PrivateExample!7', 'sk_exampleSecret123456']) assert.equal(encoded.includes(secret), false, secret);
  assert.equal(snapshot.facts.email, p.facts.email); assert.equal(snapshot.domains.integration.issuer, 'Example');
  assert.equal(snapshot.secrets.password, 'TEST_PASSWORD_REFERENCE');
  const second = Manager.edit(result, { label: 'Another label' });
  assert.equal(second.revisions[1].snapshot.secrets.password, 'TEST_PASSWORD_REFERENCE');
});


test('enrichment fills blank defaults as additions but preserves deliberate operator clearing', () => {
  const draft = Manager.createPersona({ id: 'new', role: 'user', portrait: null }, { source: 'agent' });
  const proposed = Manager.propose(draft, { description: 'A substantive agent-authored context for this test person, including current circumstances and work preferences.',
    portrait: { src: 'assets/personas/casey-submitter.svg' }, domains: { custom: { unknown: null } } });
  assert(proposed.additions.includes('/description')); assert(proposed.additions.includes('/portrait/src'));
  const enriched = Manager.applyProposal(draft, proposed);
  assert(enriched.description); assert(enriched.portrait.src);
  const cleared = Manager.edit(enriched, { description: '', portrait: null });
  const restored = Manager.propose(cleared, { description: 'New automatic description', portrait: { src: 'assets/personas/casey-submitter.svg' } });
  assert(restored.conflicts.includes('/description')); assert(restored.conflicts.includes('/portrait/src'));
  assert.equal(Manager.applyProposal(cleared, restored).description, '');
});


test('draft completion can add missing contact bindings but cannot replace existing ones', () => {
  const draft = Manager.createPersona({ id: 'draft', role: 'user', facts: { given_name: 'Casey' } }, { source: 'agent' });
  const proposal = Manager.propose(draft, { facts: { email: 'confirmed@example.test', username: 'confirmed@example.test' } });
  const result = Manager.applyProposal(draft, proposal);
  assert.equal(result.facts.email, 'confirmed@example.test');
  assert.throws(() => Manager.propose(result, { facts: { email: 'replacement@example.test' } }), /Identity contact/);
  assert.throws(() => Manager.edit(result, { facts: { given_name: 'Casey' } }), /Identity contact/);
});


test('explicit passport/citizenship and core reference links resolve without equating country domains', () => {
  const p = base(); p.facts.country = 'GB';
  p.domains.identity = { citizenships: [{ id: 'citizen-ie', country: 'IE' }],
    passports: [{ id: 'passport-ie', citizenshipId: 'citizen-ie', issuingCountry: 'IE' }],
    visas: [{ id: 'visa-gb', country: 'GB', passportId: 'passport-ie' }],
    immigration: { residenceCountry: 'GB', visaId: 'visa-gb', passportId: 'passport-ie', residenceId: 'home-gb' } };
  p.domains.banking = { accounts: [{ id: 'account-de', country: 'DE', iban: 'DE89370400440532013000' }] };
  p.histories.residence = [{ id: 'home-gb', country: 'GB', startDate: '2020-01-01' }];
  const result = Manager.preflight(p);
  assert.equal(result.ready, true); assert(result.checks.some(c => c.id.startsWith('core.link:') && c.status === 'pass'));
  assert(result.checks.some(c => c.id.startsWith('identity.passport_issuer:') && c.status === 'pass'));
  p.domains.identity.passports[0].citizenshipId = 'missing-citizenship';
  p.domains.identity.immigration.visaId = 'missing-visa';
  const dangling = Manager.preflight(p);
  assert.equal(dangling.ready, false);
  assert(dangling.checks.some(c => c.path.endsWith('/citizenshipId') && c.status === 'fail'));
  assert(dangling.checks.some(c => c.path.endsWith('/visaId') && c.status === 'fail'));
});

test('passport issuer difference prompts contextual review rather than a legal eligibility claim', () => {
  const p = base(); p.domains.identity = { citizenships: [{ id: 'citizen-ie', country: 'IE' }],
    passports: [{ id: 'other-document', citizenshipId: 'citizen-ie', issuingCountry: 'GB' }] };
  const result = Manager.preflight(p), issue = result.checks.find(c => c.id.startsWith('identity.passport_issuer:'));
  assert.equal(result.ready, true); assert.equal(issue.status, 'uncertain'); assert.match(issue.message, /not a legal/);
});
