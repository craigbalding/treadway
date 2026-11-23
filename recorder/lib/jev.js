// Field classification with Jev (TypeSafe AI, POST /v1/systemone).
// Only field descriptions (label, name, placeholder, nearby text) are sent;
// persona values never leave the browser through this call.
(function (root) {
  'use strict';

  const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
  const JEV_MODEL = 'jev-latest';
  const MIN_CONFIDENCE = 0.6;
  const OTHER = 'other';

  function describe(field) {
    const description = {};
    for (const key of ['label', 'name', 'id', 'placeholder', 'inputType', 'autocomplete', 'nearby']) {
      if (field[key]) description[key] = String(field[key]).slice(0, 200);
    }
    if (field.options && field.options.length) description.options = field.options.slice(0, 20);
    return description;
  }

  // fields: [{key, ...description}]; choices: {fieldType: description}.
  // One request: Jev answers every question against the same state in parallel.
  function buildJevRequest(fields, choices) {
    const criteria = Object.assign({}, choices, { [OTHER]: 'None of the other kinds; leave for the person to fill' });
    const state = { fields: {} };
    const questions = {};
    for (const field of fields) {
      state.fields[field.key] = describe(field);
      questions[field.key] = {
        type: 'choice',
        instructions: 'Which kind of value does the web form field "' + field.key + '" in fields expect?',
        criteria,
      };
    }
    return { model: JEV_MODEL, state, questions };
  }

  // Returns {key: {type, confidence}} for confident answers only.
  function readJevAnswers(body, keys, minimum) {
    const threshold = minimum === undefined ? MIN_CONFIDENCE : minimum;
    const answers = (body && body.answers) || {};
    const result = {};
    for (const key of keys) {
      const answer = answers[key];
      if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') continue;
      if (answer.choice === OTHER || !(answer.confidence >= threshold)) continue;
      result[key] = { type: answer.choice, confidence: answer.confidence };
    }
    return result;
  }

  async function classifyWithJev({ apiKey, fields, choices, fetch: fetchFunction }) {
    if (!fields.length) return {};
    const response = await fetchFunction(JEV_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildJevRequest(fields, choices)),
    });
    const text = await response.text();
    if (!response.ok) throw new Error('Jev returned HTTP ' + response.status + ': ' + text.slice(0, 300));
    return readJevAnswers(JSON.parse(text), fields.map((field) => field.key));
  }

  const api = { JEV_URL, JEV_MODEL, MIN_CONFIDENCE, buildJevRequest, readJevAnswers, classifyWithJev };
  root.TreadwayJev = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
