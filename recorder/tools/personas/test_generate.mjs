import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { generateCandidate } from './generate.mjs';
const require = createRequire(import.meta.url), Manager = require('../../lib/persona-manager.js'), Personas = require('../../lib/personas.js');

test('country-scoped raw candidates are reproducible apart from cryptographic credentials', () => {
  for (const country of ['IE', 'GB', 'US', 'DE']) for (let i = 0; i < 20; i++) {
    const options = { id: `sample-${country}-${i}`, role: 'applicant', country, seed: 'candidate-' + i, referenceDate: '2026-11-24' };
    const first = generateCandidate(options), second = generateCandidate(options);
    assert.notEqual(first.credentials.password, second.credentials.password);
    const publicPart = ({ credentials, ...p }) => p;
    assert.deepEqual(publicPart(first), publicPart(second));
    assert.equal(first.facts.country, { IE: 'Ireland', GB: 'United Kingdom', US: 'United States', DE: 'Germany' }[country]);
    assert.equal(first.facts.email, undefined, 'the generator does not invent a deliverable mailbox');
    assert.equal(first.domains.identity.citizenships[0].country, country);
    assert.equal(first.generation.phase, 'ingredients');
    assert.equal(Manager.preflight(first).ready, true); assert.equal(Manager.preflight(first).complete, false);
    if (country === 'IE') assert(Personas.ppsnValid(first.facts.ppsn));
    if (country !== 'US') assert(Manager.ibanValid(first.domains.banking.accounts[0].iban));
    assert(Personas.safePortraitSource(first.portrait.src));
  }
});

test('residence, citizenship, bank country and confirmed-contact input stay distinct', () => {
  const p = generateCandidate({ id: 'mobile-persona', role: 'applicant', country: 'GB', citizenship: 'IE', bankCountry: 'DE',
    referenceDate: '2026-11-24', email: 'confirmed@example.test' });
  assert.equal(p.facts.country, 'United Kingdom'); assert.equal(p.facts.email, 'confirmed@example.test');
  assert.equal(p.domains.identity.passports[0].issuingCountry, 'IE');
  assert.equal(p.domains.banking.accounts[0].country, 'DE');
  assert(p.domains.banking.accounts[0].iban.startsWith('DE'));
  assert.equal(p.domains.identity.immigration.status, 'requires_agent_preparation');
});

test('CLI writes a private new candidate without printing credentials or overwriting identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-candidate-'));
  try {
    const output = path.join(directory, 'personas.json'), script = fileURLToPath(new URL('./generate.mjs', import.meta.url));
    const args = [script, '--id', 'sample', '--role', 'user', '--reference-date', '2026-11-24', '--output', output];
    const message = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
    const p = JSON.parse(fs.readFileSync(output)).personas[0];
    assert.equal(message.id, 'sample'); assert.equal(JSON.stringify(message).includes(p.credentials.password), false);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
