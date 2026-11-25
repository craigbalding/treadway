// One schema-constrained inference request. No agent framework, retries or repairs.
(function (root) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 30000;
  const DEFAULT_OUTPUT_TOKENS = 8192;
  // Explicitly reviewed native structured-output combinations. A catalog entry
  // is not proof of live availability: every response is still validated below.
  const CATALOG = {
    openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', models: [
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', reasoning: 'none' },
    ] },
    anthropic: { label: 'Anthropic', baseURL: 'https://api.anthropic.com/v1', models: [
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    ] },
    groq: { label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', models: [
      { id: 'openai/gpt-oss-20b', label: 'GPT OSS 20B', reasoning: 'low' },
      { id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B', reasoning: 'low' },
    ] },
    xai: { label: 'xAI', baseURL: 'https://api.x.ai/v1', models: [
      { id: 'grok-4.7', label: 'Grok 4.7', reasoning: 'low' },
    ] },
    openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', models: [
      { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', route: 'OpenAI', reasoning: 'none' },
      { id: 'openai/gpt-oss-20b', label: 'GPT OSS 20B', route: 'Groq', reasoning: 'low' },
      { id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B', route: 'Groq', reasoning: 'low' },
    ] },
  };

  class InferenceError extends Error {
    constructor(code, message) { super(message); this.name = 'InferenceError'; this.code = code; }
  }
  function fail(code, message) { throw new InferenceError(code, message); }
  function providers() {
    return Object.entries(CATALOG).map(([id, entry]) => ({ id, label: entry.label, baseURL: entry.baseURL }));
  }
  function availableModels(provider = 'openai') {
    return (CATALOG[provider]?.models || []).map(({ id, label }) => ({ id, label }));
  }
  function checkConfiguration(settings = {}) {
    const provider = settings.llmProvider || 'openai';
    if (!Object.hasOwn(CATALOG, provider)) fail('configuration', 'Choose a supported inference provider.');
    const model = settings.llmModel || CATALOG[provider].models[0].id;
    if (!CATALOG[provider].models.some(entry => entry.id === model)) {
      fail('configuration', 'Choose a reviewed model with native structured-output support.');
    }
    if (typeof settings.llmKey !== 'string' || !settings.llmKey.trim() || /[\r\n]/.test(settings.llmKey)) {
      fail('configuration', 'Add the inference provider API key in Settings.');
    }
    let url;
    try { url = new URL(settings.llmBaseURL || CATALOG[provider].baseURL); }
    catch (_) { fail('configuration', 'The inference endpoint must be a valid base URL.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        url.username || url.password || url.search || url.hash) {
      fail('configuration', 'Use an HTTPS inference base URL without credentials, query or fragment.');
    }
    const timeoutMs = settings.llmTimeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(settings.llmTimeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
      fail('configuration', 'Inference timeout must be between 1 and 120 seconds.');
    }
    return { provider, model, baseURL: url.href.replace(/\/+$/, ''), timeoutMs, ready: true };
  }
  function configurationStatus(settings = {}) {
    const provider = settings.llmProvider || 'openai';
    const model = settings.llmModel || availableModels(provider)[0]?.id || '';
    try { return { ...checkConfiguration(settings), models: availableModels(provider) }; }
    catch (error) { return { provider, model, ready: false, models: availableModels(provider), error: error.message }; }
  }

  // Reject non-portable/loosely constrained schemas before sending anything.
  // The maintained interpreter performs result validation; this only enforces
  // the stricter common provider contract (closed objects, no optional keys).
  function checkSchema(schema) {
    const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum', 'description', 'title']);
    const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
    const seen = new Set();
    function walk(node, depth = 0) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || seen.has(node) || depth > 30) {
        fail('schema', 'Use a finite, explicit structured-output schema.');
      }
      seen.add(node);
      if (Object.keys(node).some(key => !keywords.has(key))) fail('schema', 'The schema uses an unsupported structured-output keyword.');
      const declared = Array.isArray(node.type) ? node.type : [node.type];
      if (node.anyOf !== undefined) {
        if (node.type !== undefined || !Array.isArray(node.anyOf) || !node.anyOf.length) fail('schema', 'Invalid schema union.');
        for (const branch of node.anyOf) walk(branch, depth + 1);
      } else if (!declared.length || declared.some(type => !types.has(type))) fail('schema', 'Every schema field needs an explicit type.');
      if (declared.includes('object')) {
        const props = node.properties;
        if (!props || typeof props !== 'object' || Array.isArray(props) || node.additionalProperties !== false ||
            !Array.isArray(node.required) || node.required.length !== Object.keys(props).length ||
            new Set(node.required).size !== node.required.length || node.required.some(key => !Object.hasOwn(props, key))) {
          fail('schema', 'Structured-output objects must forbid extra properties and require every declared key.');
        }
        for (const child of Object.values(props)) walk(child, depth + 1);
      } else if (node.properties !== undefined || node.required !== undefined || node.additionalProperties !== undefined) {
        fail('schema', 'Object constraints require an object type.');
      }
      if (declared.includes('array')) walk(node.items, depth + 1);
      else if (node.items !== undefined) fail('schema', 'Array items require an array type.');
      if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length ||
          node.enum.some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)))) {
        fail('schema', 'Schema enums must contain scalar JSON values.');
      }
      for (const keyword of ['description', 'title']) {
        if (node[keyword] !== undefined && typeof node[keyword] !== 'string') fail('schema', 'Invalid schema annotation.');
      }
      seen.delete(node);
    }
    if (schema?.type !== 'object') fail('schema', 'The inference result schema must describe an object.');
    walk(schema);
    return schema;
  }
  function checkedMessages(messages) {
    if (!Array.isArray(messages) || !messages.length || messages.some(message =>
      !message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) {
      fail('request', 'Inference requires text messages with explicit roles.');
    }
    return messages.map(({ role, content }) => ({ role, content }));
  }
  function buildRequest(settings, schema, messages, outputTokens = DEFAULT_OUTPUT_TOKENS) {
    const config = checkConfiguration(settings);
    checkSchema(schema);
    // Hold the exact schema that was dispatched, independently of caller edits.
    schema = JSON.parse(JSON.stringify(schema));
    const chat = checkedMessages(messages);
    const key = settings.llmKey.trim();
    // Configured API credentials are transport-only, never model inputs.
    const input = JSON.stringify({ schema, messages: chat });
    const transportKeys = [key, settings.safeyoloKey, settings.jevKey].filter(value => typeof value === 'string' && value);
    if (transportKeys.some(value => input.includes(value))) fail('request', 'Inference input contains a configured API credential.');
    if (!Number.isInteger(outputTokens) || outputTokens < 1 || outputTokens > 32768) fail('request', 'Invalid inference output budget.');
    const headers = { 'Content-Type': 'application/json' };
    let body, endpoint;
    if (config.provider === 'anthropic') {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      const system = chat.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
      const turns = chat.filter(message => message.role !== 'system');
      if (!turns.length || turns[0].role !== 'user') fail('request', 'Anthropic inference needs an initial user message.');
      body = { model: config.model, max_tokens: outputTokens, stream: false, messages: turns,
        ...(system ? { system } : {}), output_config: { format: { type: 'json_schema', schema } } };
      endpoint = '/messages';
    } else {
      headers.Authorization = 'Bearer ' + key;
      body = { model: config.model, messages: chat, stream: false,
        response_format: { type: 'json_schema', json_schema: { name: 'treadway_result', strict: true, schema } } };
      body[config.provider === 'openai' || config.provider === 'groq' ? 'max_completion_tokens' : 'max_tokens'] = outputTokens;
      const modelInfo = CATALOG[config.provider].models.find(entry => entry.id === config.model);
      const reasoning = modelInfo.reasoning;
      if (reasoning) body.reasoning_effort = reasoning;
      if (config.provider === 'openrouter') body.provider = {
        require_parameters: true, allow_fallbacks: false, only: [modelInfo.route],
      };
      endpoint = '/chat/completions';
    }
    return { config, url: config.baseURL + endpoint, headers, body, schema };
  }
  function extractResult(provider, body) {
    if (!body || typeof body !== 'object' || body.error) fail('provider', 'The inference provider returned an error.');
    if (provider === 'anthropic') {
      if (body.stop_reason === 'refusal') fail('refused', 'The model declined this inference request.');
      if (body.stop_reason !== 'end_turn') fail('incomplete', 'The model response was incomplete; no data was applied.');
      if (!Array.isArray(body.content) || body.content.length !== 1 || body.content[0]?.type !== 'text' ||
          typeof body.content[0].text !== 'string') fail('response', 'The model did not return a structured text result.');
      return body.content[0].text;
    }
    if (!Array.isArray(body.choices) || body.choices.length !== 1) fail('response', 'The model did not return one structured result.');
    const choice = body.choices[0];
    if (choice.message?.refusal) fail('refused', 'The model declined this inference request.');
    if (choice.finish_reason !== 'stop') fail('incomplete', 'The model response was incomplete; no data was applied.');
    if (choice.message?.tool_calls?.length || typeof choice.message?.content !== 'string') {
      fail('response', 'The model did not return a structured text result.');
    }
    return choice.message.content;
  }
  async function infer({ settings, schema, messages, signal, fetchImpl = root.fetch, maxOutputTokens = DEFAULT_OUTPUT_TOKENS } = {}) {
    const request = buildRequest(settings || {}, schema, messages, maxOutputTokens);
    const Validator = root.TreadwaySchemaValidator;
    if (!Validator?.create) fail('validator', 'The structured-output validator is unavailable. Reload the extension.');
    let validate;
    try { validate = Validator.create(request.schema); }
    catch (_) { fail('schema', 'The structured-output schema could not be validated.'); }
    if (signal?.aborted) fail('aborted', 'Inference was cancelled; no data was applied.');
    const controller = new AbortController();
    let timer, abortListener;
    const cancellation = new Promise((_, reject) => {
      abortListener = () => { controller.abort(); reject(new InferenceError('aborted', 'Inference was cancelled; no data was applied.')); };
      signal?.addEventListener('abort', abortListener, { once: true });
      timer = setTimeout(() => {
        controller.abort(); reject(new InferenceError('timeout', 'Inference timed out; no data was applied.'));
      }, request.config.timeoutMs);
    });
    try {
      return await Promise.race([cancellation, (async () => {
        let response;
        try {
          response = await fetchImpl(request.url, { method: 'POST', headers: request.headers,
            body: JSON.stringify(request.body), signal: controller.signal, credentials: 'omit', redirect: 'error' });
        } catch (_) { fail('network', 'The inference endpoint could not be reached. Check the connection and provider settings.'); }
        if (!response.ok) {
          // Do not surface upstream response bodies: they can echo credentials,
          // persona content or page data. No retries, including 429 and 5xx.
          fail('http', 'Inference failed with HTTP ' + Number(response.status) + '. Check provider access and settings.');
        }
        let envelope;
        try { envelope = await response.json(); }
        catch (_) { fail('response', 'The inference endpoint returned an invalid response.'); }
        let data;
        try { data = JSON.parse(extractResult(request.config.provider, envelope)); }
        catch (error) {
          if (error instanceof InferenceError) throw error;
          fail('json', 'The model did not return valid JSON; no data was applied.');
        }
        let valid = false;
        try { valid = validate(data); } catch (_) { /* Fixed error below; never leak data. */ }
        if (!valid) fail('validation', 'The model result did not match the required schema; no data was applied.');
        if ([settings.llmKey, settings.safeyoloKey, settings.jevKey].filter(value => typeof value === 'string' && value)
          .some(value => JSON.stringify(data).includes(value))) fail('validation', 'The model result contained a configured API credential; no data was applied.');
        if (controller.signal.aborted) fail('aborted', 'Inference was cancelled; no data was applied.');
        return data;
      })()]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortListener);
    }
  }
  const api = { DEFAULT_TIMEOUT_MS, DEFAULT_OUTPUT_TOKENS, InferenceError,
    providers, availableModels, checkConfiguration, configurationStatus, checkSchema, buildRequest, infer };
  root.TreadwayInference = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
