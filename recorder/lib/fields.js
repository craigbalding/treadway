// Field types and rule-based matching. A field description is a plain object:
// {tag, inputType, name, id, label, placeholder, autocomplete, nearby}.
(function (root) {
  'use strict';

  // Each field type the recorder knows, with the description Jev reads.
  const FIELD_TYPES = {
    given_name: 'First or given name of a person',
    family_name: 'Last name, surname or family name of a person',
    previous_family_name: 'Previous or former surname, only when the persona supplies one',
    previous_ppsn: 'Previous PPSN, distinct from the current PPSN',
    full_name: 'Full name of a person in one field',
    display_name: 'Public or display name shown on the profile; use the persona display name',
    email: 'Email address',
    phone: 'Telephone or mobile number',
    mobile_phone: 'Mobile or cellular phone number',
    home_phone: 'Home or landline phone number',
    work_phone: 'Work or school phone number',
    institution: 'College, university or educational institution name',
    qualification_level: 'Qualification level, such as bachelor or master',
    degree_title: 'Degree or diploma title',
    classification: 'Degree classification or grade',
    year_obtained: 'Year a qualification was obtained',
    date_of_birth: 'Date of birth',
    address_line1: 'First line of a postal address or street',
    address_line2: 'Second line of a postal address',
    city: 'City or town',
    region: 'County, state, province or region',
    postcode: 'Postcode, ZIP code or Eircode',
    country: 'Country',
    username: 'Username or login name',
    ppsn: 'Irish Personal Public Service Number (PPSN or PPS number)',
    card_number: 'Payment card number',
    card_name: 'Name printed on a payment card',
    card_expiry: 'Payment card expiry date (month and year together)',
    card_expiry_month: 'Payment card expiry month only',
    card_expiry_year: 'Payment card expiry year only',
    card_cvc: 'Payment card security code (CVC or CVV)',
    password: 'Password for an existing account',
    new_password: 'New password being chosen or confirmed',
    one_time_code: 'One-time code, verification code or MFA code',
  };

  // Secret handling and recording follow the supplied credential and run policy.
  const SECRET_TYPES = new Set(['password', 'new_password', 'one_time_code']);

  const AUTOCOMPLETE_TYPES = {
    'given-name': 'given_name',
    'family-name': 'family_name',
    name: 'full_name',
    email: 'email',
    tel: 'phone',
    'tel-national': 'phone',
    bday: 'date_of_birth',
    'address-line1': 'address_line1',
    'street-address': 'address_line1',
    'address-line2': 'address_line2',
    'address-level2': 'city',
    'address-level1': 'region',
    'postal-code': 'postcode',
    country: 'country',
    'country-name': 'country',
    username: 'username',
    'cc-number': 'card_number',
    'cc-name': 'card_name',
    'cc-exp': 'card_expiry',
    'cc-exp-month': 'card_expiry_month',
    'cc-exp-year': 'card_expiry_year',
    'cc-csc': 'card_cvc',
    'current-password': 'password',
    'new-password': 'new_password',
    'one-time-code': 'one_time_code',
  };

  // Ordered: the first match wins, so specific patterns precede general ones.
  const NAME_RULES = [
    [/(previous|former|old).{0,16}(pps|personal public service)/, 'previous_ppsn'],
    [/(previous|former|maiden).{0,16}(surname|last ?name|family ?name)/, 'previous_family_name'],
    [/\bpps\b|ppsn|pps ?(no|number)|personal public service/, 'ppsn'],
    [/one ?time|\botp\b|verification code|\bmfa\b|2fa/, 'one_time_code'],
    [/(new|confirm|repeat).{0,12}password/, 'new_password'],
    [/password|passwd/, 'password'],
    [/card ?holder|name on (the )?card|card ?name/, 'card_name'],
    [/card ?(number|no)|\bcc ?(num|number)\b|\bpan\b/, 'card_number'],
    [/\bcvc\b|\bcvv\b|\bcsc\b|security code/, 'card_cvc'],
    [/exp(iry|iration)? ?(month|mm)\b/, 'card_expiry_month'],
    [/exp(iry|iration)? ?(year|yy|yyyy)\b/, 'card_expiry_year'],
    [/expir|exp ?date/, 'card_expiry'],
    [/e ?mail/, 'email'],
    [/date of birth|birth ?date|\bdob\b|\bbday\b/, 'date_of_birth'],
    [/first ?name|given ?name|forename/, 'given_name'],
    [/last ?name|surname|family ?name/, 'family_name'],
    [/display ?name|public ?name|preferred ?name|profile ?name/, 'display_name'],
    [/full ?name|^name$|your name/, 'full_name'],
    [/user ?name|login/, 'username'],
    [/institution|college|university/, 'institution'],
    [/year.{0,12}obtained/, 'year_obtained'],
    [/classification|\bgrade\b/, 'classification'],
    [/(degree|diploma).{0,12}title/, 'degree_title'],
    [/qualification.{0,12}level|degree.{0,12}level/, 'qualification_level'],
    [/mobile|cell(ular)? ?phone/, 'mobile_phone'],
    [/(home|landline).{0,12}(phone|tel)|landline/, 'home_phone'],
    [/(work|school|office).{0,16}(phone|tel)/, 'work_phone'],
    [/phone|\btel\b|telephone/, 'phone'],
    [/address ?(line)? ?2|address2|apartment|suite/, 'address_line2'],
    [/address ?(line)? ?1|address1|street|^address$/, 'address_line1'],
    [/post ?code|zip|eircode/, 'postcode'],
    [/\bcity\b|\btown\b/, 'city'],
    [/county|\bstate\b|province|region/, 'region'],
    [/country/, 'country'],
  ];

  function normalise(text) {
    return String(text || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[_\-[\].:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchText(text) {
    const value = normalise(text);
    if (!value) return null;
    for (const [pattern, type] of NAME_RULES) if (pattern.test(value)) return type;
    return null;
  }

  // Returns {type, by} or null. Explicit page hints win over guesses from text.
  function ruleType(field) {
    // The last autocomplete token names the field ("shipping postal-code").
    const autocomplete = String(field.autocomplete || '').toLowerCase().split(/\s+/).filter(Boolean).pop();
    if (autocomplete && Object.prototype.hasOwnProperty.call(AUTOCOMPLETE_TYPES, autocomplete)) {
      return { type: AUTOCOMPLETE_TYPES[autocomplete], by: 'autocomplete' };
    }
    if (field.inputType === 'email') return { type: 'email', by: 'input type' };
    if (field.inputType === 'password') {
      return { type: matchText(field.label + ' ' + field.name) === 'new_password' ? 'new_password' : 'password', by: 'input type' };
    }
    for (const [by, text] of [['name', field.name], ['id', field.id], ['label', field.label], ['placeholder', field.placeholder]]) {
      const type = matchText(text);
      if (type) return { type, by };
    }
    if (field.inputType === 'tel') return { type: 'phone', by: 'input type' };
    return null;
  }

  // Facts store dates as YYYY-MM-DD. Text inputs that show a day-first or
  // month-first placeholder receive that layout instead.
  function formatValue(type, value, field) {
    if (type !== 'date_of_birth') return value;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match || field.inputType === 'date') return value;
    const hint = normalise(field.placeholder + ' ' + field.label);
    const [, year, month, day] = match;
    if (/dd ?\/? ?mm ?\/? ?yyyy/.test(hint)) return day + '/' + month + '/' + year;
    if (/mm ?\/? ?dd ?\/? ?yyyy/.test(hint)) return month + '/' + day + '/' + year;
    return value;
  }

  const api = { FIELD_TYPES, SECRET_TYPES, AUTOCOMPLETE_TYPES, ruleType, formatValue, normalise };
  root.TreadwayFields = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
