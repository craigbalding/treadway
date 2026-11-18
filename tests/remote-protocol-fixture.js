'use strict';
// A Browserless-shaped protocol server. It deliberately has dirty default state.
const http = require('node:http');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {WebSocketServer} = require('ws');

async function protocolFixture(t, {capacity = Infinity, contextSupport = true, sharedBrowser = false, reconnectSupport = false, profileSupport = false, browserserve = false} = {}) {
  const browsers = [], seen = [], writes = [], upgrades = [];
  const controls = {principal: 'member'};
  const profiles = new Map();
  const sharedContexts = new Map(), sharedTargets = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    if (profileSupport && req.method === 'POST' && url.pathname === '/session') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const options = JSON.parse(Buffer.concat(chunks));
      const id = crypto.randomUUID(); profiles.set(id, {id, active: false, state: {value: '', cookies: []}});
      res.writeHead(201, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({id, ttl: options.ttl, connect: `ws://127.0.0.1:${server.address().port}/session/${id}?token=synthetic-connect`,
        stop: `http://127.0.0.1:${server.address().port}/session/${id}?token=synthetic-stop`})); return;
    }
    if (profileSupport && req.method === 'DELETE' && url.pathname.startsWith('/session/')) {
      const id = url.pathname.slice('/session/'.length), profile = profiles.get(id);
      if (!profile || profile.active) { res.writeHead(profile ? 409 : 404); res.end(); return; }
      profiles.delete(id); res.writeHead(204); res.end(); return;
    }
    res.writeHead(500); res.end('global discovery forbidden');
  });
  const wss = new WebSocketServer({noServer: true});
  wss.on('headers', (headers, request) => {
    if (browserserve && !controls.missingResumeHeader) {
      request.resumeToken = request.resumeBrowser?.resumeToken || crypto.randomBytes(32).toString('hex');
      headers.push('Browserserve-Resume-Token: ' + (controls.resumeHeader || request.resumeToken));
    }
  });
  server.on('upgrade', (req, socket, head) => {
    upgrades.push({url: req.url, authorization: req.headers.authorization});
    if (browserserve && new URL(req.url, 'http://fixture.invalid').searchParams.has('resume')) {
      const token = new URL(req.url, 'http://fixture.invalid').searchParams.get('resume');
      req.resumeBrowser = browsers.find(browser => browser.resumeToken === token && browser.parked);
      if (!req.resumeBrowser || controls.refuseResume) {
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); return;
      }
    }
    if (profileSupport && req.url.startsWith('/session/')) {
      const profile = profiles.get(new URL(req.url, 'http://fixture.invalid').pathname.slice('/session/'.length));
      if (!profile || profile.active) { socket.end(`HTTP/1.1 ${profile ? '429 Too Many Requests' : '404 Not Found'}\r\nContent-Length: 0\r\n\r\n`); return; }
      req.profile = profile;
    }
    if (browsers.filter(b => b.open).length >= capacity) { socket.end('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, request) => {
    if (browserserve && controls.emptyCloseAcknowledgement) {
      const close = ws.close.bind(ws);
      ws.close = () => close();
    }
    const browser = request.resumeBrowser || {contexts: sharedBrowser ? sharedContexts : new Map(),
      targets: sharedBrowser ? sharedTargets : new Map(), sessions: new Map()};
    if (!request.resumeBrowser) browsers.push(browser);
    Object.assign(browser, {open: true, parked: false, ws, resumeToken: request.resumeToken});
    if (request.profile) {
      browser.profile = request.profile; browser.profile.active = true;
      browser.contexts = new Map(); browser.targets = new Map();
      browser.defaultContextId = 'default-' + crypto.randomUUID();
      browser.contexts.set(browser.defaultContextId, browser.profile.state);
    }
    ws.on('error', () => {}); ws.on('close', code => {
      browser.open = false; browser.closeCode = code;
      browser.parked = browserserve && code !== 1000 && !browser.ended && !!browser.resumeToken && !controls.parkDelayMs;
      if (browserserve && code !== 1000 && !browser.ended && controls.parkDelayMs)
        setTimeout(() => { if (!browser.open) browser.parked = true; }, controls.parkDelayMs);
      if (browser.profile) browser.profile.active = false;
    });
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
        const contextId = params.browserContextId ?? browser.defaultContextId;
        if (!browser.contexts.has(contextId)) error = {code: -1, message: 'wrong context'};
        else { const targetId = 'page-'+crypto.randomUUID(); browser.targets.set(targetId, {targetId, type: 'page', browserContextId: contextId}); result = {targetId}; }
      } else if (method === 'Browser.getVersion') result = controls.engineVersion || {
        protocolVersion: '1.3', product: 'Chrome/123.0.0.0', revision: 'synthetic-revision', userAgent: 'synthetic-browser', jsVersion: '12.3'};
      else if (method === 'Target.getTargetInfo') result = {targetInfo: browser.targets.get(params.targetId)};
      else if (method === 'Target.attachToTarget') {
        if (!browser.targets.has(params.targetId)) error = {code: -1, message: 'target gone'};
        else { const sessionId = 'attached-'+crypto.randomUUID(); browser.sessions.set(sessionId, params.targetId); result = {sessionId}; }
      } else if (method === 'Target.detachFromTarget') browser.sessions.delete(params.sessionId);
      else if (method === 'Target.disposeBrowserContext') {
        browser.contexts.delete(params.browserContextId);
        for (const [key, value] of browser.targets) if (value.browserContextId === params.browserContextId) browser.targets.delete(key);
      } else if (method === 'Browserless.reconnect') {
        if (!reconnectSupport || controls.unsupportedExtension) error = {code: -32601, message: 'not implemented'};
        else if (controls.dropReconnectReply) return;
        else result = {error: controls.reconnectError || null, browserWSEndpoint: controls.reconnectEndpoint ||
          `ws://127.0.0.1:${server.address().port}/reconnect/exact?existing=%2B+&x=1&x=2`};
      } else if (method === 'Page.getFrameTree') result = {frameTree: {frame: {id: 'frame-' + target?.targetId, url: 'about:blank'}}};
      else if (method === 'Storage.getCookies') {
        result = {cookies: browser.contexts.get(params.browserContextId)?.cookies ?? [{name: 'unrelated-default', value: 'must-not-export'}]};
      } else if (method === 'Storage.setCookies') {
        const current = browser.contexts.get(params.browserContextId);
        if (!current) error = {code: -1, message: 'context required'};
        else current.cookies = params.cookies;
      } else if (method === 'Runtime.evaluate') {
        if (params.expression.startsWith('fixture:principal:')) controls.principal = params.expression.slice('fixture:principal:'.length);
        if (!context) error = {code: -1, message: 'page attachment required'};
        else if (params.expression === '({origin:location.origin,timeOrigin:performance.timeOrigin})') result = {
          result: {value: {origin: 'https://app.example.invalid', timeOrigin: 1}}};
        else if (params.expression.includes('async function browserRequest')) result = {
          result: {value: {complete: true, status: 200, body: {principal: controls.principal}}}};
        else if (params.expression.startsWith('save:')) {
          context.value = params.expression.slice(5); writes.push(context.value); result = {result: {value: true}};
        } else if (params.expression === 'lose-reply') { context.value = 'committed'; writes.push('committed'); return; }
        else result = {result: {value: params.expression === 'read' ? context.value : true}};
      } else if (method === 'Browser.close' && (browser.profile || browserserve)) {
        if (controls.loseProfileCloseReply) { ws.close(); return; }
      } else if (method === 'Browser.close' || method.startsWith('Target.')) error = {code: -1, message: 'unexpected global operation'};
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({id, ...(sessionId ? {sessionId} : {}), ...(error ? {error} : {result})}),
        () => {
          if (method === 'Browser.close' && (browser.profile || browserserve) && !error) { browser.ended = true; ws.close(1000); }
          if (method === 'Page.navigate') ws.send(JSON.stringify({method: 'Page.loadEventFired', sessionId, params: {timestamp: 1}}));
        });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const browser of browsers) browser.ws.terminate(); wss.close(); await new Promise(r => server.close(r)); });
  return {endpoint: `http://127.0.0.1:${server.address().port}/tenant/chromium?token=synthetic`,
    sessionApi: `http://127.0.0.1:${server.address().port}/session?token=synthetic-create`, browsers, seen, writes, controls, upgrades, profiles};
}
module.exports = {protocolFixture};
