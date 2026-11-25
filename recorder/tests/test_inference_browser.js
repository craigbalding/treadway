'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
let playwright;
try { playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright'); } catch (_) {}
if (!playwright && process.env.RECORDER_REQUIRE_BROWSER === '1') throw Error('playwright is required for inference browser checks');

test('strict-CSP browser worker dispatches a schema request and rejects unstructured replies',
  { skip: !playwright, timeout: 45000 }, async t => {
    const seen = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; worker-src 'self'");
      if (url.pathname === '/index.html') {
        res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Structured inference fixture</title>');
      }
      if (url.pathname === '/worker.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return res.end(`importScripts('/schema-validator.js','/inference.js');
          self.onmessage=async event=>{try{postMessage({data:await TreadwayInference.infer(event.data)})}
          catch(error){postMessage({error:{code:error.code,message:error.message}})}};`);
      }
      if (['/schema-validator.js', '/inference.js'].includes(url.pathname)) {
        res.setHeader('Content-Type', 'text/javascript');
        return res.end(fs.readFileSync(path.join(__dirname, '../lib', url.pathname.slice(1))));
      }
      if (url.pathname === '/v1/chat/completions') {
        let bytes = '';
        req.on('data', chunk => { bytes += chunk; });
        req.on('end', () => {
          const body = JSON.parse(bytes); seen.push(body);
          const invalid = body.messages[0].content.includes('invalid');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
            content: invalid ? 'Unstructured prose' : '{"retired":false}',
          } }] }));
        }); return;
      }
      res.statusCode = 404; res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    browser = await playwright.chromium.launch({ headless: true, chromiumSandbox: true,
      ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}) });
    const page = await browser.newPage();
    const origin = 'http://127.0.0.1:' + server.address().port;
    await page.goto(origin + '/index.html');
    async function run(content) {
      return page.evaluate(async ({ origin, content }) => {
        const worker = new Worker('/worker.js');
        try {
          return await new Promise((resolve, reject) => {
            worker.onmessage = event => resolve(event.data);
            worker.onerror = event => reject(Error(event.message));
            worker.postMessage({ settings: { llmProvider: 'openai', llmKey: 'synthetic-worker-key', llmBaseURL: origin + '/v1' },
              schema: { type: 'object', properties: { retired: { type: 'boolean' } }, required: ['retired'], additionalProperties: false },
              messages: [{ role: 'user', content }] });
          });
        } finally { worker.terminate(); }
      }, { origin, content });
    }
    assert.deepEqual(await run('Synthetic academic applicant'), { data: { retired: false } });
    const failed = await run('invalid synthetic response');
    assert.equal(failed.error.code, 'json');
    assert.equal(seen.length, 2);
    assert(seen.every(body => body.response_format.json_schema.strict === true));
  });
