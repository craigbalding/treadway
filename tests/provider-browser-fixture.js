'use strict';
// Emulate Session API control URLs; use real, separately sandboxed Chromium
// processes and persistent profiles for browser state and shutdown behavior.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {WebSocketServer} = require('ws');
const {widgetFixture, browserRoot} = require('./browser-fixture');
const {launch} = require(path.join(browserRoot, 'launcher'));
const {createCdpProxy} = require(path.join(browserRoot, 'cdp'));

async function providerBrowserFixture() {
  const app = await widgetFixture('react', {handleRequest(request, response, url) {
    response.setHeader('Content-Type', url.pathname === '/principal' ? 'application/json' : 'text/html');
    response.end(url.pathname === '/principal' ? JSON.stringify({principal:
      request.headers.cookie?.includes('session=synthetic-member') ? 'member' : null}) :
      '<!doctype html><title>Profile example</title><p>Profile example</p>');
    return true;
  }});
  const profiles = new Map(), generations = [], requests = [], fronts = new Set();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    requests.push({method: request.method, url: request.url});
    if (request.method === 'POST' && url.pathname === '/session') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      const id = crypto.randomUUID(); profiles.set(id, {id, active: false});
      const base = `http://127.0.0.1:${server.address().port}`;
      response.writeHead(201, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({id, ttl: input.ttl, connect: base.replace('http:', 'ws:') + '/session/' + id + '?token=synthetic-connect&x=%2B+',
        stop: base + '/session/' + id + '?token=synthetic-stop&x=%2B+'})); return;
    }
    const id = url.pathname.slice('/session/'.length), profile = profiles.get(id);
    if (request.method === 'DELETE' && profile) {
      if (profile.active) { response.writeHead(409); response.end(); return; }
      await profile.cleanup;
      fs.rmSync(path.join(app.root, 'profiles', id), {recursive: true, force: true});
      profiles.delete(id); response.writeHead(204); response.end(); return;
    }
    response.writeHead(404); response.end();
  });
  const sockets = new WebSocketServer({noServer: true});
  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    const profile = profiles.get(url.pathname.slice('/session/'.length));
    if (!profile || profile.active) { socket.end(`HTTP/1.1 ${profile ? '429 Too Many Requests' : '404 Not Found'}\r\nContent-Length: 0\r\n\r\n`); return; }
    profile.active = true;
    try {
      await profile.cleanup;
      const browser = await launch({root: path.join(app.root, 'profiles', profile.id), name: 'profile', persistent: true});
      profile.browser = browser;
      generations.push({id: profile.id, generation: browser.session.generation, pid: browser.session.pid});
      if (socket.destroyed) { await browser.stop(); profile.active = false; return; }
      sockets.handleUpgrade(request, socket, head, async front => {
        fronts.add(front); let upstream, pending = [];
        front.on('error', () => {});
        front.on('message', data => { if (upstream) upstream.send(data.toString()); else pending.push(data); });
        front.on('close', () => {
          fronts.delete(front); upstream?.terminate(); profile.active = false;
          profile.cleanup = browser.stop();
          profile.cleanup.catch(() => {}); // close() observes this result below.
        });
        try {
          upstream = await createCdpProxy(browser.connection).cdpConnect(browser.session.browser_path);
          upstream.on('message', data => { if (front.readyState === front.OPEN) front.send(data.toString()); });
          upstream.on('error', () => front.terminate()); upstream.on('close', () => front.terminate());
          if (front.readyState !== front.OPEN) { upstream.terminate(); return; }
          for (const value of pending) upstream.send(value.toString()); pending = [];
        } catch { front.terminate(); }
      });
    } catch { profile.active = false; socket.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {...app, profiles, generations, requests,
    sessionApi: `http://127.0.0.1:${server.address().port}/session?token=synthetic-create&x=%2B+`,
    async close(options) {
      for (const front of fronts) front.terminate();
      sockets.close(); await new Promise(resolve => server.close(resolve));
      const results = await Promise.allSettled([...profiles.values()].map(async profile => {
        await profile.cleanup; if (profile.browser) await profile.browser.stop();
      }));
      await app.close(options);
      if (results.some(item => item.status === 'rejected')) throw new Error('provider_fixture_cleanup_incomplete');
    }};
}
module.exports = {providerBrowserFixture};
