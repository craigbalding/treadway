const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {WebSocketServer} = require('ws');
const {connectEndpoint, parseEndpoint, handshakeHeaders} = require('../src/treadway/browser/remote-transport');

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server;
}
function certificate(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-transport-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const key = path.join(root, 'key.pem'), cert = path.join(root, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', '/CN=browser.invalid',
    '-addext', 'subjectAltName=DNS:browser.invalid,DNS:localhost,IP:127.0.0.1'], {stdio: 'ignore'});
  return {key: fs.readFileSync(key), cert: fs.readFileSync(cert)};
}
async function proxy(t, destination) {
  const seen = [];
  const server = await listen(t, http.createServer());
  server.on('connect', (request, socket, head) => {
    seen.push({authority: request.url, auth: request.headers['proxy-authorization']});
    const upstream = net.connect(destination.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  return {seen, url: `http://fixture-user:fixture-pass@127.0.0.1:${server.address().port}`};
}

test('scheme conversion preserves opaque prefix and repeated encoded query; configuration is passive', () => {
  const endpoint = 'https://browser.invalid/tenant%2Fone/chrome?token=synthetic&x=%2B+&x=2&sig=a%2fb';
  assert.equal(parseEndpoint(endpoint).endpoint, endpoint.replace('https:', 'wss:'));
  for (const value of ['ftp://browser.invalid', 'wss://user:secret@browser.invalid', 'ws://browser.invalid/#secret',
    'ws://browser.invalid/\nsecret', 'ws://browser.invalid/?userDataDir=shared',
    'ws://browser.invalid/?launch=%7B%22userDataDir%22%3A%22shared%22%7D',
    'ws://browser.invalid/?launch=opaque-secret']) {
    assert.throws(() => parseEndpoint(value), error => error.code === 'remote_endpoint_invalid' && !String(error).includes('secret'));
  }
  assert.throws(() => handshakeHeaders({Authorization: 'one', authorization: 'two'}), /remote_headers_invalid/);
  assert.throws(() => handshakeHeaders({Host: 'other.invalid'}), /remote_headers_invalid/);
  assert.throws(() => connectEndpoint('wss://browser.invalid/?token=synthetic', {proxyUrl: ''}), /remote_http_proxy_required/);
});

test('loopback launch preserves URL and secret headers without an HTTP discovery request', async t => {
  const requests = [];
  const server = await listen(t, http.createServer(() => assert.fail('no discovery')));
  const wss = new WebSocketServer({server}); t.after(() => wss.close());
  wss.on('connection', (ws, req) => { requests.push({url: req.url, auth: req.headers.authorization}); ws.send('ready'); });
  const ws = await connectEndpoint(`http://127.0.0.1:${server.address().port}/prefix/chrome?token=synthetic&x=1&x=2`,
    {headers: {Authorization: 'Bearer reverse-proxy-fixture'}});
  ws.terminate();
  assert.deepEqual(requests, [{url: '/prefix/chrome?token=synthetic&x=1&x=2', auth: 'Bearer reverse-proxy-fixture'}]);
});

test('WSS uses CONNECT, verified TLS/SNI, proxy auth and exact URL without remote DNS', async t => {
  const keys = certificate(t), seen = [];
  const server = await listen(t, https.createServer(keys));
  const wss = new WebSocketServer({server}); t.after(() => wss.close());
  wss.on('connection', (ws, req) => { seen.push({url: req.url, sni: req.socket.servername, auth: req.headers.authorization}); });
  const tunnel = await proxy(t, server);
  const url = 'wss://browser.invalid/tenant%2Fone/chrome?token=synthetic&x=%2B+&x=2&sig=a%2fb';
  const ws = await connectEndpoint(url, {proxyUrl: tunnel.url, ca: keys.cert, headers: {Authorization: 'Bearer fixture'}});
  ws.terminate();
  assert.deepEqual(tunnel.seen, [{authority: 'browser.invalid:443', auth: 'Basic '+Buffer.from('fixture-user:fixture-pass').toString('base64')}]);
  assert.deepEqual(seen, [{url: '/tenant%2Fone/chrome?token=synthetic&x=%2B+&x=2&sig=a%2fb', sni: 'browser.invalid', auth: 'Bearer fixture'}]);
});

test('untrusted TLS fails closed and omits endpoint/header secrets', async t => {
  const server = await listen(t, https.createServer(certificate(t)));
  server.on('tlsClientError', () => {});
  const tunnel = await proxy(t, server);
  await assert.rejects(connectEndpoint('wss://browser.invalid/private-fixture?token=synthetic', {proxyUrl: tunnel.url}), error => {
    assert.equal(error.code, 'remote_tls_failed');
    assert.equal(error.phase, 'tls');
    assert.equal(error.allocation, 'not_dispatched');
    assert.doesNotMatch(JSON.stringify(error), /synthetic|private-fixture|fixture-pass/);
    return true;
  });
});

test('provider rejection and redirect never expose bodies or follow to another endpoint', async t => {
  let requests = 0;
  const server = await listen(t, http.createServer());
  server.on('upgrade', (req, socket) => {
    requests++;
    socket.end('HTTP/1.1 302 Found\r\nLocation: ws://unrelated.invalid/?token=synthetic\r\nContent-Length: 0\r\n\r\n');
  });
  await assert.rejects(connectEndpoint(`ws://127.0.0.1:${server.address().port}/?token=synthetic`), error => {
    assert.equal(error.code, 'remote_handshake_rejected'); assert.equal(error.status, 302);
    assert.doesNotMatch(String(error), /synthetic|unrelated/); return true;
  });
  assert.equal(requests, 1);
});

test('one deadline covers a stalled CONNECT and a stalled TLS handshake', async t => {
  const server = await listen(t, http.createServer());
  server.on('connect', () => {});
  await assert.rejects(connectEndpoint('wss://browser.invalid', {proxyUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 200}),
    error => error.code === 'remote_connect_deadline' && error.phase === 'proxy');
  const silent = await listen(t, net.createServer());
  const tunnel = await proxy(t, silent);
  await assert.rejects(connectEndpoint('wss://browser.invalid', {proxyUrl: tunnel.url, timeoutMs: 200}),
    error => error.code === 'remote_connect_deadline' && error.phase === 'tls');
});

test('owner cancellation ends a pending handshake without retrying allocation', async t => {
  let requests = 0;
  const server = await listen(t, http.createServer());
  server.on('upgrade', () => { requests++; });
  const controller = new AbortController();
  const pending = connectEndpoint(`ws://127.0.0.1:${server.address().port}`, {signal: controller.signal, timeoutMs: 5000});
  await new Promise(resolve => setTimeout(resolve, 30));
  controller.abort();
  await assert.rejects(pending, error => error.code === 'remote_connect_cancelled');
  assert.equal(requests, 1);
});
