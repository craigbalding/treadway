# Recorder structured inference

The recorder makes one native `fetch` request. There is no inference SDK or
agent framework. `lib/inference.js` supports reviewed provider/model combinations
with native schema-constrained output, validates every completed response and
never repairs, retries or falls back to plain text/JSON mode.

Provider/model catalogs restrict selection; they do not prove live availability
or semantic correctness. An unavailable model, refused/truncated result,
unsupported schema or invalid response fails without applying data. Custom base
URLs retain the selected provider's protocol and model restrictions. OpenRouter
is constrained to the reviewed OpenAI/Groq routes, requires supported parameters
and disables provider fallback.

`TreadwayInference.infer({settings,schema,messages,signal})` returns validated data.
Settings are `llmProvider`, `llmModel`, `llmKey`, optional `llmBaseURL` and
`llmTimeoutMs` (default 30 seconds). `maxOutputTokens` is an optional call argument
(default 8192). The timeout covers headers and body; cancellation prevents late
results from being applied. There are no automatic retries. API keys are carried
only in transport headers; upstream error bodies are not exposed.

The portable schema subset is finite object/array/scalar types, nullable type
unions, `anyOf`, scalar enums and descriptions/titles. Every object must specify
`additionalProperties:false` and require every property; model absent values as
null. Unsupported keywords fail before dispatch. Domain consistency and binding
checks still belong to the caller after structural validation.

## Validator build

Dynamic schemas use the maintained **@cfworker/json-schema 4.1.6** interpreter.
Its bundled browser runtime requires no `eval`, `Function`, runtime imports or
Node packages and can execute under the Manifest V3 service-worker CSP.
The generated file includes the upstream MIT license.

```sh
npm ci --ignore-scripts --prefix recorder/tools/inference
npm run build --prefix recorder/tools/inference
node recorder/tools/inference/build.mjs --check
node --test recorder/tests/test_inference.js
```

Load `lib/schema-validator.js` before `lib/inference.js`. These scripts have no
network effects when imported. Browser validation uses a local synthetic HTTP
endpoint and a worker with `script-src 'self'`; it never contacts model APIs:

```sh
RECORDER_REQUIRE_BROWSER=1 node --test recorder/tests/test_inference_browser.js
```

## Provider references reviewed 2026-11-25

- [OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Anthropic model IDs](https://platform.claude.com/docs/en/models/overview) and
  [native structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Groq strict-mode model support](https://console.groq.com/docs/structured-outputs)
- [xAI native schemas](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
- [OpenRouter schemas and per-endpoint routing](https://openrouter.ai/docs/guides/features/structured-outputs)
- [Validator design and conformance](https://github.com/cfworker/cfworker/tree/main/packages/json-schema)

Contract tests cover all listed request formats, not paid live inference or
provider-specific generation quality. Model catalogs require periodic review.
