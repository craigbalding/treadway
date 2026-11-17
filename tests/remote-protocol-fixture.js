'use strict';
// A Browserless-shaped protocol server. It deliberately has dirty default state.
const http = require('node:http');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {WebSocketServer} = require('ws');

async function protocolFixture(t, {capacity = Infinity, contextSupport = true} = {}) {
  const browsers = [], seen = [], writes = [];
  const server = http.createServer((_req, res) => { res.writeHead(500); res.end('global discovery forbidden'); });
  const wss = new WebSocketServer({noServer: true});
  server.on('upgrade', (req, socket, head) => {
    if (browsers.filter(b => b.open).length >= capacity) { socket.end('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    const browser = {open: true, contexts: new Map(), targets: new Map(), sessions: new Map(), ws}; browsers.push(browser);
    ws.on('error', () => {}); ws.on('close', () => { browser.open = false; });
    ws.on('message', raw => {
      const input = JSON.parse(raw); seen.push(input);
      const {id, method, params = {}, sessionId} = input;
      const target = browser.targets.get(browser.sessions.get(sessionId));
      const context = browser.contexts.get(target?.browserContextId);
      let result = {}, error;
      if (method === 'Target.createBrowserContext') {
        if (!contextSupport) error = {code: -32601, message: 'not implemented'};
        else { const browserContextId = 'ctx-'+crypto.randomUUID(); browser.contexts.set(browserContextId, {value: '', cookies: []}); result = {browserContextId}; }
      } else if (method === 'Target.createTarget') {
        if (!browser.contexts.has(params.browserContextId)) error = {code: -1, message: 'wrong context'};
        else { const targetId = 'page-'+crypto.randomUUID(); browser.targets.set(targetId, {targetId, type: 'page', browserContextId: params.browserContextId}); result = {targetId}; }
      } else if (method === 'Target.getTargetInfo') result = {targetInfo: browser.targets.get(params.targetId)};
      else if (method === 'Target.attachToTarget') {
        if (!browser.targets.has(params.targetId)) error = {code: -1, message: 'target gone'};
        else { const sessionId = 'attached-'+crypto.randomUUID(); browser.sessions.set(sessionId, params.targetId); result = {sessionId}; }
      } else if (method === 'Target.detachFromTarget') browser.sessions.delete(params.sessionId);
      else if (method === 'Target.disposeBrowserContext') {
        browser.contexts.delete(params.browserContextId);
        for (const [key, value] of browser.targets) if (value.browserContextId === params.browserContextId) browser.targets.delete(key);
      } else if (method === 'Storage.getCookies') {
        result = {cookies: browser.contexts.get(params.browserContextId)?.cookies ?? [{name: 'unrelated-default', value: 'must-not-export'}]};
      } else if (method === 'Storage.setCookies') {
        const current = browser.contexts.get(params.browserContextId);
        if (!current) error = {code: -1, message: 'context required'};
        else current.cookies = params.cookies;
      } else if (method === 'Runtime.evaluate') {
        if (!context) error = {code: -1, message: 'page attachment required'};
        else if (params.expression.startsWith('save:')) {
          context.value = params.expression.slice(5); writes.push(context.value); result = {result: {value: true}};
        } else if (params.expression === 'lose-reply') { context.value = 'committed'; writes.push('committed'); return; }
        else result = {result: {value: params.expression === 'read' ? context.value : true}};
      } else if (method === 'Browser.close' || method.startsWith('Target.')) error = {code: -1, message: 'unexpected global operation'};
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({id, ...(sessionId ? {sessionId} : {}), ...(error ? {error} : {result})}));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const browser of browsers) browser.ws.terminate(); wss.close(); await new Promise(r => server.close(r)); });
  return {endpoint: `http://127.0.0.1:${server.address().port}/tenant/chromium?token=synthetic`, browsers, seen, writes};
}
module.exports = {protocolFixture};
