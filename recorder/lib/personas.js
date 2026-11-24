// Test personas: validation and seeded, deterministic generated values.
// Loaded by the side panel and by Node tests.
(function (root) {
  'use strict';

  const SAFE_TOKEN = /^[A-Za-z0-9_.:-]+$/;
  const GENERATORS = ['ppsn', 'test_card'];

  // Published payment-provider test numbers (Stripe test mode). They are
  // Luhn-valid and are never issued as real cards.
  const TEST_CARDS = ['4242424242424242', '5555555555554444', '4000056655665556'];

  function hashSeed(text) {
    let hash = 0x811c9dc5;
    for (const character of String(text)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  }

  // mulberry32: small, fast and identical in every JavaScript engine.
  function seededRandom(seed) {
    let state = hashSeed(seed);
    return function next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Irish PPSN check character: weights 8..2 over the seven digits, plus 9 x the
  // second letter (A=1 ... W=0), modulo 23, where 0 is W and 1..22 are A..V.
  function ppsnCheckCharacter(digits, secondLetter) {
    let sum = 0;
    for (let index = 0; index < 7; index += 1) sum += Number(digits[index]) * (8 - index);
    if (secondLetter) sum += (secondLetter === 'W' ? 0 : secondLetter.charCodeAt(0) - 64) * 9;
    const remainder = sum % 23;
    return remainder === 0 ? 'W' : String.fromCharCode(64 + remainder);
  }

  function ppsnValid(value) {
    const match = /^(\d{7})([A-W])([A-IW]?)$/.exec(String(value).toUpperCase());
    return Boolean(match) && ppsnCheckCharacter(match[1], match[3]) === match[2];
  }

  function generatePpsn(random) {
    let digits = '';
    for (let index = 0; index < 7; index += 1) digits += Math.floor(random() * 10);
    return digits + ppsnCheckCharacter(digits, 'A') + 'A';
  }

  function luhnValid(number) {
    const digits = String(number).replace(/\D/g, '');
    let sum = 0;
    for (let index = 0; index < digits.length; index += 1) {
      let digit = Number(digits[digits.length - 1 - index]);
      if (index % 2 === 1) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    }
    return digits.length > 0 && sum % 10 === 0;
  }

  function fail(message) {
    throw new Error('personas.json: ' + message);
  }

  function readStringMap(value, where) {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(where + ' must be an object');
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== 'string' || entry === '') fail(where + '.' + key + ' must be a non-empty string');
      result[key] = entry;
    }
    return result;
  }

  // Accepts the text of personas.json and returns validated personas.
  function parsePersonas(text) {
    let document;
    try {
      document = JSON.parse(text);
    } catch (error) {
      fail('not valid JSON (' + error.message + ')');
    }
    if (!document || !Array.isArray(document.personas) || document.personas.length === 0) {
      fail('expected {"personas": [ ... ]} with at least one persona');
    }
    const seen = new Set();
    return document.personas.map((entry, index) => {
      const where = 'personas[' + index + ']';
      if (!entry || typeof entry !== 'object') fail(where + ' must be an object');
      for (const key of ['id', 'role']) {
        if (typeof entry[key] !== 'string' || !SAFE_TOKEN.test(entry[key])) {
          fail(where + '.' + key + ' must use only letters, digits and _ . : - (it becomes part of the SafeYOLO test context)');
        }
      }
      if (seen.has(entry.id)) fail('duplicate persona id ' + entry.id);
      seen.add(entry.id);
      const generate = entry.generate === undefined ? [] : entry.generate;
      if (!Array.isArray(generate) || generate.some((name) => !GENERATORS.includes(name))) {
        fail(where + '.generate must list only: ' + GENERATORS.join(', '));
      }
      return {
        id: entry.id,
        role: entry.role,
        label: typeof entry.label === 'string' ? entry.label : entry.id,
        seed: typeof entry.seed === 'string' && entry.seed ? entry.seed : entry.id,
        facts: readStringMap(entry.facts, where + '.facts'),
        credentials: readStringMap(entry.credentials, where + '.credentials'),
        generate: generate.slice(),
        secrets: readStringMap(entry.secrets, where + '.secrets'),
      };
    });
  }

  // Values a persona can fill, keyed by field type: {value, source}.
  // Facts written in the file win over generated values of the same type.
  function personaValues(persona, now) {
    const today = now || new Date();
    const values = {};
    const facts = persona.facts;
    if (!facts.full_name && facts.given_name && facts.family_name) {
      values.full_name = { value: facts.given_name + ' ' + facts.family_name, source: 'persona' };
    }
    for (const generator of persona.generate) {
      const random = seededRandom(persona.seed + ':' + generator);
      if (generator === 'ppsn') {
        values.ppsn = { value: generatePpsn(random), source: 'generated' };
      } else if (generator === 'test_card') {
        const year = today.getFullYear() + 3;
        const generated = {
          card_number: TEST_CARDS[Math.floor(random() * TEST_CARDS.length)],
          card_expiry: '12/' + String(year).slice(-2),
          card_expiry_month: '12',
          card_expiry_year: String(year),
          card_cvc: '123',
        };
        for (const [type, value] of Object.entries(generated)) values[type] = { value, source: 'generated' };
      }
    }
    for (const [type, value] of Object.entries(facts)) values[type] = { value, source: 'persona' };
    // Naming aliases only; preserve explicit and distinct contact values.
    for (const [type, alternatives] of Object.entries({
      phone: ['mobile_phone', 'phone_number'], mobile_phone: ['phone'],
      region: ['county', 'state', 'province'], postcode: ['eircode', 'postal_code', 'zip_code'],
    })) {
      if (values[type]) continue;
      const supplied = alternatives.find(key => values[key]);
      if (supplied) values[type] = { ...values[supplied], source: 'derived' };
    }
    if (!values.display_name && values.full_name) values.display_name = { ...values.full_name, source: 'derived' };
    if (!values.username && values.email) values.username = { ...values.email, source: 'derived' };
    for (const type of ['password', 'new_password', 'one_time_code']) {
      const value = persona.credentials?.[type] || facts[type];
      if (value) values[type] = { value, source: 'credential', credential: true,
        secretReference: persona.secrets[type] || persona.secrets.password || persona.id + ':' + type };
    }
    if (!values.card_name && values.card_number && values.full_name) {
      values.card_name = { value: values.full_name.value, source: values.full_name.source };
    }
    return values;
  }

  const api = {
    GENERATORS, SAFE_TOKEN, TEST_CARDS,
    parsePersonas, personaValues, seededRandom, ppsnValid, ppsnCheckCharacter, luhnValid,
  };
  root.TreadwayPersonas = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
