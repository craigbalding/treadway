'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../lib/schema-validator.js');
const Inference = require('../lib/inference.js');

const key = 'synthetic-transport-credential';
const schema = { type: 'object', properties: {
  fields: { type: 'array', items: { type: 'object', properties: {
    key: { type: 'string' }, value: { type: ['string', 'null'] },
  }, required: ['key', 'value'], additionalProperties: false } },
}, required: ['fields'], additionalProperties: false };
const data = { fields: [{ key: 'retired', value: 'No' }, { key: 'unconfirmed', value: null }] };
const messages = [{ role: 'system', content: 'Return coherent synthetic applicant details.' },
  { role: 'user', content: 'Avery Example is a 42-year-old academic seeking additional work.' }];
const settings = { llmProvider: 'openai', llmKey: key };
const opts = extra => ({ settings, schema, messages, ...extra });
function completion(value = data, extra = {}) {
  return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) }, ...extra }] };
}
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('all provider adapters dispatch exactly one native strict-schema request and validate its result', async () => {
  for (const provider of Inference.providers()) {
    for (const model of Inference.availableModels(provider.id)) {
      let calls = 0;
      const result = await Inference.infer(opts({ settings: { ...settings, llmProvider: provider.id, llmModel: model.id },
        fetchImpl: async (url, init) => {
          calls++;
          assert.equal(init.method, 'POST');
          assert.equal(init.redirect, 'error');
          assert.equal(init.credentials, 'omit');
          const body = JSON.parse(init.body);
          assert.equal(body.model, model.id);
          assert.equal(body.stream, false);
          assert.equal(init.body.includes(key), false);
          if (provider.id === 'anthropic') {
            assert.equal(url, provider.baseURL + '/messages');
            assert.equal(init.headers['x-api-key'], key);
            assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
            assert.deepEqual(body.output_config.format, { type: 'json_schema', schema });
            assert.equal(body.system, messages[0].content);
            assert.deepEqual(body.messages, messages.slice(1));
            return response({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(data) }] });
          }
          assert.equal(url, provider.baseURL + '/chat/completions');
          assert.equal(init.headers.Authorization, 'Bearer ' + key);
          assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'treadway_result', strict: true, schema } });
          if (provider.id === 'openrouter') {
            assert.equal(body.provider.require_parameters, true);
            assert.equal(body.provider.allow_fallbacks, false);
            assert.deepEqual(body.provider.only, [model.id === 'openai/gpt-6-luna' ? 'OpenAI' : 'Groq']);
          }
          return response(completion());
        } }));
      assert.deepEqual(result, data);
      assert.equal(calls, 1);
    }
  }
});

test('unsupported providers/models, malformed endpoint and transport-key leakage stop before any request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw Error('must not dispatch'); };
  for (const changed of [
    { llmProvider: 'unknown' }, { llmProvider: '__proto__' }, { llmModel: 'text-only-model' },
    { llmKey: '' }, { llmTimeoutMs: 0 }, { llmTimeoutMs: 120001 },
    { llmBaseURL: 'http://inference.example.test/v1' }, { llmBaseURL: 'https://user:password@example.test/v1' },
    { llmBaseURL: 'https://inference.example.test/v1?api_key=secret' },
  ]) await assert.rejects(Inference.infer(opts({ settings: { ...settings, ...changed }, fetchImpl })), { code: 'configuration' });
  await assert.rejects(Inference.infer(opts({ messages: [{ role: 'user', content: key }], fetchImpl })), { code: 'request' });
  assert.equal(calls, 0);
  assert.equal(Inference.configurationStatus({}).ready, false);
  assert.equal(Inference.configurationStatus(settings).ready, true);
});

test('custom endpoint preserves the selected adapter and does not discover or retry other URLs', async () => {
  let calls = 0;
  await Inference.infer(opts({ settings: { ...settings, llmBaseURL: 'https://inference.example.test/proxy/v1/' },
    fetchImpl: async url => { calls++; assert.equal(url, 'https://inference.example.test/proxy/v1/chat/completions'); return response(completion()); } }));
  assert.equal(calls, 1);
});

test('schemas must be explicit, closed, finite and portable before dispatch', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; };
  const wrong = [true, {}, { type: 'string' },
    { type: 'object', properties: { value: { type: 'string' } }, required: [], additionalProperties: false },
    { type: 'object', properties: {}, required: [], additionalProperties: true },
    { type: 'object', properties: { x: { $ref: 'https://example.test/schema' } }, required: ['x'], additionalProperties: false },
  ];
  const recursive = { type: 'object', properties: {}, required: ['loop'], additionalProperties: false };
  recursive.properties.loop = recursive;
  wrong.push(recursive);
  for (const candidate of wrong) await assert.rejects(Inference.infer(opts({ schema: candidate, fetchImpl })), { code: 'schema' });
  assert.equal(calls, 0);
});

test('plain prose, code fences and schema-invalid JSON are rejected without repairs', async () => {
  for (const content of ['I think the answer is no', '```json\n' + JSON.stringify(data) + '\n```',
    '{"fields":"No"}', '{"fields":[{"key":"retired","value":false}]}',
    '{"fields":[],"unrequested":"secret"}', '{"fields":[{"key":"retired"}]}']) {
    let calls = 0;
    await assert.rejects(Inference.infer(opts({ fetchImpl: async () => {
      calls++; return response(completion(null, { message: { content } }));
    } })), error => ['json', 'validation'].includes(error.code));
    assert.equal(calls, 1);
  }
});

test('refusals, truncations, filters and tool replies never apply even syntactically valid data', async () => {
  for (const extra of [
    { message: { refusal: 'cannot comply', content: JSON.stringify(data) } },
    { finish_reason: 'length' }, { finish_reason: 'content_filter' },
    { message: { content: JSON.stringify(data), tool_calls: [{ name: 'something' }] } },
  ]) await assert.rejects(Inference.infer(opts({ fetchImpl: async () => response(completion(data, extra)) })),
    error => ['refused', 'incomplete', 'response'].includes(error.code));
  for (const stop_reason of ['max_tokens', 'refusal', 'tool_use', null]) {
    await assert.rejects(Inference.infer(opts({ settings: { ...settings, llmProvider: 'anthropic' },
      fetchImpl: async () => response({ stop_reason, content: [{ type: 'text', text: JSON.stringify(data) }] }) })),
    error => ['refused', 'incomplete'].includes(error.code));
  }
});

test('API/network failures never echo upstream secrets and do not retry', async () => {
  for (const status of [400, 401, 403, 428, 429, 500, 503]) {
    let calls = 0, read = false;
    await assert.rejects(Inference.infer(opts({ fetchImpl: async () => {
      calls++; return { ok: false, status, json: async () => { read = true; return { error: key }; } };
    } })), error => error.code === 'http' && !error.message.includes(key));
    assert.equal(calls, 1);
    assert.equal(read, false);
  }
  await assert.rejects(Inference.infer(opts({ fetchImpl: async () => { throw Error(key); } })),
    error => error.code === 'network' && !error.message.includes(key));
});

test('cancellation covers transport, response body and pre-dispatch; no late result wins', async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(Inference.infer(opts({ signal: before.signal, fetchImpl: () => { throw Error('must not run'); } })), { code: 'aborted' });
  for (const phase of ['transport', 'body']) {
    const controller = new AbortController();
    let transportSignal, finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const request = Inference.infer(opts({ signal: controller.signal, fetchImpl: async (_, init) => {
      transportSignal = init.signal;
      return phase === 'transport' ? pending : { ok: true, json: () => pending };
    } }));
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(request, { code: 'aborted' });
    assert.equal(transportSignal.aborted, true);
    finish(phase === 'transport' ? response(completion()) : completion());
  }
});

test('timeout bounds even a transport which ignores AbortSignal', async () => {
  let signal;
  const started = Date.now();
  await assert.rejects(Inference.infer(opts({ settings: { ...settings, llmTimeoutMs: 1000 },
    fetchImpl: (_, init) => { signal = init.signal; return new Promise(() => {}); } })), { code: 'timeout' });
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 2000);
});

test('response validation uses the exact dispatched schema despite caller mutation', async () => {
  const mutable = JSON.parse(JSON.stringify(schema));
  await assert.rejects(Inference.infer(opts({ schema: mutable, fetchImpl: async () => {
    mutable.properties.fields = { type: 'string' };
    return response(completion({ fields: 'incorrect' }));
  } })), { code: 'validation' });
});

test('browser bundle validates nested schemas with runtime string code generation disabled', async () => {
  const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout },
    { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(fs.readFileSync(require.resolve('../lib/schema-validator.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../lib/inference.js'), 'utf8'), context);
  context.options = opts({ fetchImpl: async () => response(completion()) });
  const result = await vm.runInContext('TreadwayInference.infer(options)', context);
  assert.equal(JSON.stringify(result), JSON.stringify(data));
  context.options = opts({ fetchImpl: async () => response(completion({ fields: false })) });
  await assert.rejects(vm.runInContext('TreadwayInference.infer(options)', context), { code: 'validation' });
});
