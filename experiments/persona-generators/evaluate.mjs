// Offline observations of pinned packages, not a production persona generator.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Faker, en_IE, en_GB, en_US, de, en, base } from '@faker-js/faker';
import { SeedFaker } from '@opendsr/seedfaker';
import { generate } from 'json-schema-faker';
import { isValidIBAN } from 'ibantools';
import { Style, Avatar } from '@dicebear/core';
import lorelei from '@dicebear/styles/lorelei.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const Personas = require('../../recorder/lib/personas.js');
const AS_OF = '2026-11-24';
const COUNT = 500;
const locales = [
  { country: 'IE', faker: en_IE, native: 'ie' },
  { country: 'GB', faker: en_GB, native: 'en-gb' },
  { country: 'DE', faker: de, native: 'de' },
  { country: 'US', faker: en_US, native: 'en' },
];
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
function ageOn(dob) {
  const [y, m, d] = dob.split('-').map(Number);
  const [ry, rm, rd] = AS_OF.split('-').map(Number);
  return ry - y - Number(rm < m || (rm === m && rd < d));
}
function ibanChecksum(value) {
  const compact = value.replace(/\s/g, '');
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let mod = 0;
  for (const char of rearranged) for (const digit of /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char) {
    mod = (mod * 10 + Number(digit)) % 97;
  }
  return mod === 1;
}
function ibanStructure(value, country) {
  const compact = value.replace(/\s/g, '');
  const patterns = { IE: /^IE\d{2}[A-Z]{4}\d{14}$/, GB: /^GB\d{2}[A-Z]{4}\d{14}$/, DE: /^DE\d{20}$/ };
  return Boolean(patterns[country]?.test(compact)) && ibanChecksum(compact);
}
function fakerFor(locale, seed) {
  const f = new Faker({ locale: [locale, en, base] });
  f.seed(seed); f.setDefaultRefDate(AS_OF + 'T00:00:00.000Z');
  return f;
}
function ingredientRecord(spec, seed) {
  const f = fakerFor(spec.faker, seed);
  const first = f.person.firstName(), last = f.person.lastName();
  const dob = f.date.birthdate({ min: 25, max: 65, mode: 'age' }).toISOString().slice(0, 10);
  return { first, last, fullName: f.person.fullName({ firstName: first, lastName: last }), dateOfBirth: dob, age: ageOn(dob),
    country: spec.country, city: f.location.city(), postcode: f.location.zipCode(),
    // A syntax fixture only. The real contact is separately operator-confirmed.
    email: `persona-${seed}@example.test`,
    ...(spec.country === 'US' ? {} : { iban: f.finance.iban({ countryCode: spec.country }) }) };
}
const started = performance.now();
const report = { referenceDate: AS_OF, samplesPerLocale: COUNT,
  scope: 'Offline synthetic data only. No issuer, address deliverability, geography or application acceptance checks.',
  versions: { faker: '10.6.0', jsonSchemaFaker: '0.6.4', seedFaker: '0.4.0-alpha.1', dicebearCore: '10.7.0', dicebearStyles: '10.6.0', ibanTools: '4.5.4' },
  faker: {}, seedFaker: {}, jsonSchemaFaker: {}, dicebear: {}, existingTreadway: {} };

for (const spec of locales) {
  const result = { samples: COUNT, repeatable: 0, composedAgeMatchesDob: 0,
    unconstrainedCountryMatchesLocale: 0, explicitIbanStructureAndChecksum: 0, independentIbanValid: 0,
    nameCollisions: 0, localCityDataAvailable: Boolean(spec.faker.location?.city_name || spec.faker.location?.city_pattern) };
  const names = new Set();
  for (let i = 0; i < COUNT; i++) {
    const record = ingredientRecord(spec, i);
    result.repeatable += Number(canonical(record) === canonical(ingredientRecord(spec, i)));
    result.composedAgeMatchesDob += Number(ageOn(record.dateOfBirth) === record.age);
    const f = fakerFor(spec.faker, i);
    result.unconstrainedCountryMatchesLocale += Number(f.location.countryCode() === spec.country);
    if (record.iban) result.explicitIbanStructureAndChecksum += Number(ibanStructure(record.iban, spec.country));
    if (record.iban) result.independentIbanValid += Number(isValidIBAN(record.iban));
    result.nameCollisions += Number(names.has(record.fullName)); names.add(record.fullName);
  }
  assert.equal(result.repeatable, COUNT);
  assert.equal(result.composedAgeMatchesDob, COUNT);
  if (spec.country !== 'US') assert.equal(result.explicitIbanStructureAndChecksum, COUNT);
  report.faker[spec.country] = result;
}
const raw = fakerFor(en_IE, 42), shifted = fakerFor(en_IE, 42);
shifted.number.int();
report.faker.seedAloneSurvivesInsertedCall = raw.person.fullName() === shifted.person.fullName();
report.faker.note = 'Age and explicit country/IBAN constraints above are composer logic; address components are not proven mutually consistent.';
report.sameComposerPolicy = {};

const nativeFields = ['name', 'first-name', 'last-name', 'birthdate', 'age', 'country-code', 'city', 'postal-code', 'iban', 'passport'];
for (const spec of locales) {
  const result = { samples: COUNT, repeatable: 0, fullNameMatchesParts: 0, ageMatchesExactReferenceDate: 0,
    ageMatchesDocumentedYearRule: 0, countryMatchesLocale: 0, ibanChecksum: 0,
    independentIbanValid: 0, ibanPrefixMatchesLocale: 0, uniquePassports: 0 };
  const passports = new Set();
  for (let i = 0; i < COUNT; i++) {
    const make = () => new SeedFaker({ seed: `persona-${i}`, locale: spec.native, until: 2026 }).record(nativeFields, { ctx: 'strict' });
    const a = make(), b = make();
    result.repeatable += Number(canonical(a) === canonical(b));
    result.fullNameMatchesParts += Number(a.name === `${a['first-name']} ${a['last-name']}`);
    result.ageMatchesExactReferenceDate += Number(Number(a.age) === ageOn(a.birthdate));
    result.ageMatchesDocumentedYearRule += Number(Number(a.age) === 2026 - Number(a.birthdate.slice(0, 4)) - 1);
    result.countryMatchesLocale += Number(a['country-code'] === spec.country);
    result.ibanChecksum += Number(ibanChecksum(a.iban));
    result.independentIbanValid += Number(isValidIBAN(a.iban.replace(/\s/g, '')));
    result.ibanPrefixMatchesLocale += Number(a.iban.startsWith(spec.country));
    passports.add(a.passport);
  }
  result.uniquePassports = passports.size;
  assert.equal(result.repeatable, COUNT);
  report.seedFaker[spec.country] = result;
  const generated = Array.from({ length: COUNT }, (_, i) => {
    const r = new SeedFaker({ seed: `persona-${i}`, locale: spec.native, until: 2026 }).record(nativeFields, { ctx: 'strict' });
    return { ...r, country: spec.country, age: ageOn(r.birthdate) };
  });
  report.sameComposerPolicy[spec.country] = { samples: COUNT,
    fakerDerivedAgeAndExplicitCountry: report.faker[spec.country].composedAgeMatchesDob,
    seedFakerDerivedAgeAndExplicitCountry: generated.filter(r => r.country === spec.country && r.age === ageOn(r.birthdate)).length };
}
report.sameComposerPolicy.note = 'The same age-from-DOB and explicit-country policy works with both. These composed values are not attributed to either raw generator. IBANs use the same local and independent validators for both providers.';
const pps = new SeedFaker({ seed: 'national-id-check', locale: 'ie' });
report.seedFaker.ppsAcceptedByExistingValidator = Array.from({ length: COUNT }, () => pps.field('pps')).filter(Personas.ppsnValid).length;
const newPps = Array.from({ length: COUNT }, (_, i) => Personas.personaValues({ id: `p-${i}`, seed: `p-${i}`, facts: {}, generate: ['ppsn'] }, new Date(AS_OF)).ppsn.value);
report.existingTreadway.ppsnAcceptedByExistingValidator = newPps.filter(Personas.ppsnValid).length;
report.existingTreadway.note = 'Existing format/checksum validator only; no issued-identity acceptance claim.';
const native = new SeedFaker({ seed: 'clock-probe', locale: 'ie' });
const nativeClock = new SeedFaker({ seed: 'clock-probe', locale: 'ie', until: 2027 });
report.seedFaker.untilYearChangesAgeOrDob = canonical(native.record(['birthdate', 'age'], { ctx: 'strict' })) !==
  canonical(nativeClock.record(['birthdate', 'age'], { ctx: 'strict' }));
report.seedFaker.fingerprint = SeedFaker.fingerprint();
report.seedFaker.note = 'Exact-day age and PPS checksum are suitability requirements, not promised guarantees. Age intentionally uses untilYear - birthYear - 1. Country/IBAN linkage is observed, not assumed. IBAN valid check digits are documented but not met by this published version.';
assert(ibanChecksum('GB82WEST12345698765432'));
assert(isValidIBAN('GB82WEST12345698765432'));

const schema = { type: 'object', additionalProperties: false,
  properties: { personaId: { type: 'string', const: 'sample-persona' }, name: { type: 'string', faker: 'person.fullName' },
    retired: { type: 'boolean' }, education: { type: 'array', minItems: 2, maxItems: 2,
      items: { type: 'object', properties: { institution: { const: 'Example Academy' },
        level: { enum: ['Honours bachelor', 'Masters'] }, awardYear: { type: 'integer', minimum: 2005, maximum: 2025 } },
      required: ['institution', 'level', 'awardYear'], additionalProperties: false } } },
  required: ['personaId', 'name', 'retired', 'education'] };
const jsf = f => generate(schema, { seed: 42, extensions: { faker: f } });
const sameInstance = fakerFor(en_IE, 42);
report.jsonSchemaFaker.schemaSeedAloneRepeatsFakerValues = JSON.stringify(await jsf(sameInstance)) === JSON.stringify(await jsf(sameInstance));
const a = await jsf(fakerFor(en_IE, 42)), b = await jsf(fakerFor(en_IE, 42));
report.jsonSchemaFaker.bothSeedsRepeat = JSON.stringify(a) === JSON.stringify(b);
assert.equal(report.jsonSchemaFaker.bothSeedsRepeat, true);
report.jsonSchemaFaker.checkedRecords = 100;
for (let i = 0; i < 100; i++) {
  const record = await generate(schema, { seed: i, extensions: { faker: fakerFor(en_IE, i) } });
  assert.equal(record.personaId, 'sample-persona');
  assert.equal(typeof record.name, 'string'); assert.equal(typeof record.retired, 'boolean');
  assert.equal(record.education.length, 2);
  assert(record.education.every(e => e.institution === 'Example Academy' && e.awardYear >= 2005 && e.awardYear <= 2025));
}
const invalidHistory = await generate({ type: 'object', properties: {
  dateOfBirth: { const: '2000-01-01' }, qualificationAwarded: { const: '1990-01-01' } },
  required: ['dateOfBirth', 'qualificationAwarded'] }, { seed: 42 });
report.jsonSchemaFaker.unconstrainedImpossibleHistoryProduced = invalidHistory.qualificationAwarded < invalidHistory.dateOfBirth;
report.jsonSchemaFaker.note = 'Schema shape works; explicit relationship validation and narrative/history authorship remain necessary.';

const style = new Style(lorelei);
const avatar = seed => new Avatar(style, { seed, size: 128 }).toString();
const avatarHashes = new Set();
for (let i = 0; i < COUNT; i++) {
  const seed = `sample-persona-${i}`; const svg = avatar(seed);
  assert.equal(svg, avatar(seed)); avatarHashes.add(hash(svg));
}
report.dicebear = { samples: COUNT, repeatable: COUNT, uniqueSvgHashes: avatarHashes.size,
  style: 'lorelei', styleLicense: lorelei.meta?.license,
  note: 'Byte uniqueness in this sample; no guarantee of perceptual distinctness or physical-attribute fidelity.' };
report.elapsedMs = Math.round(performance.now() - started);
await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('./artifacts/report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
await writeFile(new URL('./artifacts/avatar-sample.svg', import.meta.url), avatar('sample-persona-42'));
console.log(JSON.stringify(report, null, 2));
