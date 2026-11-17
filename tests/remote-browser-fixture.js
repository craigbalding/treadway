'use strict';
// Shared real-Chromium relay. All clients reach one browser, so scope mistakes
// affect observable sentinel contexts instead of being hidden by new processes.
const http = require('node:http');
const path = require('node:path');
const {once} = require('node:events');
const {WebSocketServer} = require('ws');
const {widgetFixture, browserRoot} = require('./browser-fixture');
const {createCdpProxy} = require(path.join(browserRoot, 'cdp'));

async function remoteBrowserFixture(framework = 'react', options = {}) {
  const fixture = await widgetFixture(framework, options);
  const clients = new Set(), connections = [];
  const relay = http.createServer();
  const sockets = new WebSocketServer({server: relay});
  sockets.on('connection', async (front, request) => {
    connections.push(request.url);
    clients.add(front); let upstream, pending = [];
    front.on('error', () => {});
    front.on('message', data => {
      if (options.reconnectSupport) {
        const value = JSON.parse(data.toString());
        if (value.method === 'Browserless.reconnect' && typeof value.sessionId === 'string') {
          front.send(JSON.stringify({id: value.id, sessionId: value.sessionId,
            result: {error: null, browserWSEndpoint: `ws://127.0.0.1:${relay.address().port}/reconnect/exact?existing=synthetic`}}));
          return;
        }
      }
      if (upstream) upstream.send(data.toString()); else pending.push(data);
    });
    front.on('close', () => { upstream?.terminate(); clients.delete(front); });
    try {
      upstream = await createCdpProxy({cdpHost: '127.0.0.1', cdpPort: fixture.cdpPort}).cdpConnect(fixture.browserSession.browser_path);
      upstream.on('error', () => front.terminate()); upstream.on('close', () => front.terminate());
      upstream.on('message', data => { if (front.readyState === front.OPEN) front.send(data.toString()); });
      if (front.readyState !== front.OPEN) { upstream.terminate(); return; }
      for (const data of pending) upstream.send(data.toString()); pending = [];
    } catch { front.terminate(); }
  });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  return {...fixture, connections, endpoint: `http://127.0.0.1:${relay.address().port}/chromium?token=synthetic`,
    async close(options) {
      for (const client of clients) client.terminate();
      sockets.close(); await new Promise(resolve => relay.close(resolve));
      await fixture.close(options);
    }};
}
module.exports = {remoteBrowserFixture};
