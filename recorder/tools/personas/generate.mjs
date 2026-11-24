#!/usr/bin/env node
// Initial private ingredients; the preparing agent adds the application story.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { Faker, en_IE, en_GB, en_US, de, en, base } from '@faker-js/faker';
import { Style, Avatar } from '@dicebear/core';
import lorelei from '@dicebear/styles/lorelei.json' with { type: 'json' };
const require = createRequire(import.meta.url);
const Personas = require('../../lib/personas.js'), Manager = require('../../lib/persona-manager.js');
const Credentials = require('../../lib/credentials.js');
const LOCALES = { IE: en_IE, GB: en_GB, US: en_US, DE: de };
const ADDRESSES = {
  IE: { city: 'Dublin', region: 'Dublin', country: 'Ireland', postcode: 'D02 X285' },
  GB: { city: 'Cambridge', region: 'Cambridgeshire', country: 'United Kingdom', postcode: 'CB2 1TN' },
  US: { city: 'Madison', region: 'Wisconsin', country: 'United States', postcode: '53703' },
  DE: { city: 'Leipzig', region: 'Saxony', country: 'Germany', postcode: '04109' },
};
const ageAt = (dob, ref) => +ref.slice(0, 4) - +dob.slice(0, 4) - Number(ref.slice(5) < dob.slice(5));
export function generateCandidate(options, crypto = webcrypto) {
  const { id, role, country = 'IE', referenceDate, seed = id, givenName, familyName, email, citizenship = country, bankCountry = country } = options;
  if (!Personas.SAFE_TOKEN.test(id || '') || !Personas.SAFE_TOKEN.test(role || '')) throw new Error('Provide stable id and role tokens');
  if (!LOCALES[country] || !LOCALES[citizenship] || !LOCALES[bankCountry]) throw new Error('This tool supports explicit IE, GB, US and DE country templates');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate || '') || !Number.isFinite(Date.parse(referenceDate + 'T00:00:00Z')) || new Date(referenceDate + 'T00:00:00Z').toISOString().slice(0, 10) !== referenceDate) throw new Error('Provide a valid fixed referenceDate');
  const f = new Faker({ locale: [LOCALES[country], en, base] });
  f.seed(Personas.seededRandom(seed + ':core')() * 0xffffffff >>> 0); f.setDefaultRefDate(referenceDate + 'T00:00:00Z');
  const first = givenName || f.person.firstName(), last = familyName || f.person.lastName();
  const dob = f.date.birthdate({ min: 25, max: 65, mode: 'age' }).toISOString().slice(0, 10), year = +referenceDate.slice(0, 4);
  const facts = { given_name: first, family_name: last, full_name: `${first} ${last}`, display_name: `${first} ${last}`,
    date_of_birth: dob, age: String(ageAt(dob, referenceDate)), gender: f.helpers.arrayElement(['Woman', 'Man', 'Non-binary']),
    eye_colour: f.helpers.arrayElement(['Brown', 'Blue', 'Green', 'Grey', 'Hazel']), height_cm: String(f.number.int({ min: 155, max: 195 })),
    weight_kg: String(f.number.int({ min: 55, max: 100 })), address_line1: `${f.number.int({ min: 1, max: 120 })} Example Street`, ...ADDRESSES[country] };
  if (email) { facts.email = email; facts.username = email; }
  const nationalIds = [];
  if (country === 'IE') {
    facts.ppsn = Personas.personaValues({ id, seed, facts: {}, generate: ['ppsn'] }, new Date(referenceDate)).ppsn.value;
    nationalIds.push({ id: 'national-ie', scheme: 'PPSN', country: 'IE', number: facts.ppsn, acceptance: 'Local format/checksum only; not externally verified' });
  } else if (country === 'GB') nationalIds.push({ id: 'national-gb', scheme: 'NINO', country: 'GB', number: 'AB' + f.string.numeric(6) + f.helpers.arrayElement(['A', 'B', 'C', 'D']), acceptance: 'Synthetic format fixture; not externally verified' });
  else if (country === 'US') nationalIds.push({ id: 'national-us', scheme: 'SSN', country: 'US', number: `${f.number.int({ min: 100, max: 665 })}-${f.number.int({ min: 10, max: 99 })}-${f.number.int({ min: 1000, max: 9999 })}`, acceptance: 'Synthetic format fixture; not externally verified' });
  const bank = { id: 'personal-account', kind: 'personal_current', country: bankCountry, accountHolder: facts.full_name,
    acceptance: 'Synthetic fixture; ownership and bank acceptance not verified', ...(bankCountry === 'US' ? { accountNumber: f.finance.accountNumber({ length: 10 }), routingNumber: f.finance.routingNumber() } : { iban: f.finance.iban({ countryCode: bankCountry }) }) };
  const passport = { id: 'passport-primary', kind: 'passport', citizenshipId: 'citizenship-' + citizenship, issuingCountry: citizenship,
    number: citizenship === 'IE' ? 'PA' + f.string.numeric(7) : citizenship === 'GB' ? f.string.numeric(9) : citizenship === 'US' ? 'A' + f.string.numeric(8) : 'C' + f.string.alphanumeric({ length: 8, casing: 'upper' }),
    issueDate: `${year - 3}-01-01`, expiryDate: `${year + 7}-01-01`, acceptance: 'Synthetic format fixture; issuer acceptance not verified' };
  const svg = new Avatar(new Style(lorelei), { seed: id + ':' + seed, size: 128 }).toString().replace(/<!--[\s\S]*?-->/g, '').replace(/<metadata[\s\S]*?<\/metadata>/g, '').replace(/\bstyle="mask-type:(alpha|luminance)"/g, 'mask-type="$1"'), password = Credentials.password(crypto);
  return Manager.createPersona({ id, role, seed, label: facts.full_name, referenceDate, facts, description: '', preferences: {}, circumstances: {}, histories: {},
    domains: { identity: { citizenships: [{ id: 'citizenship-' + citizenship, country: citizenship }], passports: [passport], nationalIds,
      immigration: { residenceCountry: country, citizenshipCountry: citizenship, status: citizenship === country ? 'citizen_resident' : 'requires_agent_preparation' } }, banking: { accounts: [bank] } },
    portrait: { src: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), alt: 'Illustrated portrait for ' + facts.full_name,
      generator: 'DiceBear Lorelei', version: 'core10.7.0/styles10.6.0', seed: id + ':' + seed, licence: 'CC0-1.0' },
    credentials: { password, new_password: password }, secrets: { password: id + ':password', new_password: id + ':password' },
    generation: { tool: 'treadway-persona-ingredients/0.1.0', fakerVersion: '10.6.0', seed, referenceDate, phase: 'ingredients', brief: options.brief || '',
      remaining: ['Agent-authored coherent contextual description', 'Application domains, concrete histories and preferences', 'Operator-confirmed deliverable verification contact', 'External identity/account prerequisites where required'] },
  }, { source: 'generated', now: referenceDate + 'T00:00:00Z' });
}
function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || args[i + 1] === undefined) throw new Error('Every option requires a value');
    result[args[i].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = args[i + 1];
  }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options.output) throw new Error('Usage: node generate.mjs --id TOKEN --role TOKEN --country IE --reference-date YYYY-MM-DD --output PRIVATE_JSON [--email CONFIRMED_ADDRESS] [--brief DESCRIPTION]');
    const candidate = generateCandidate(options);
    fs.writeFileSync(options.output, JSON.stringify({ personas: [candidate] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ id: candidate.id, revision: candidate.revision, output: options.output, preflight: Manager.preflight(candidate), remaining: candidate.generation.remaining }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
