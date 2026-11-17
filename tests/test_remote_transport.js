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
const browserRoot = process.env.FORM_BROWSER_MODULE_ROOT || path.join(__dirname, '../src/treadway/browser');
const {connectEndpoint, parseEndpoint, selectProxy, handshakeHeaders} = require(path.join(browserRoot, 'remote-transport'));

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server;
}
function certificate(t, san = 'DNS:browser.invalid,DNS:localhost,IP:127.0.0.1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treadway-transport-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const key = path.join(root, 'key.pem'), cert = path.join(root, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', '/CN=browser.invalid',
    '-addext', 'subjectAltName='+san], {stdio: 'ignore'});
  return {key: fs.readFileSync(key), cert: fs.readFileSync(cert)};
}
async function proxy(t, destination, tlsKeys) {
  const seen = [];
  const server = await listen(t, tlsKeys ? https.createServer(tlsKeys) : http.createServer());
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
  return {seen, url: `${tlsKeys ? 'https' : 'http'}://fixture-user:fixture-pass@127.0.0.1:${server.address().port}`};
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
  assert.throws(() => connectEndpoint('wss://browser.invalid/?token=synthetic', {proxyUrl: ''}), /remote_proxy_invalid/);
});

test('environment routing delegates HTTP(S) semantics and can select direct without changing the process environment', () => {
  const requested = [];
  const resolveProxy = url => { requested.push(url); return ''; };
  assert.equal(selectProxy(new URL('wss://browser.invalid/opaque?token=synthetic'), {resolveProxy}), null);
  assert.equal(selectProxy(new URL('ws://browser.invalid/opaque'), {resolveProxy}), null);
  assert.deepEqual(requested, ['https://browser.invalid/opaque?token=synthetic', 'http://browser.invalid/opaque']);
  const selected = selectProxy(new URL('ws://127.0.0.1:1'), {proxyUrl: 'https://proxy.invalid:8443'});
  assert.equal(selected.protocol, 'https:');
  assert.equal(selectProxy(new URL('wss://browser.invalid'), {resolveProxy: () => 'http://proxy.invalid'}).hostname, 'proxy.invalid');
  for (const value of ['socks5://proxy.invalid', 'https://proxy.invalid/path', 'http://proxy.invalid/?secret=fixture']) {
    assert.throws(() => selectProxy(new URL('wss://browser.invalid'), {proxyUrl: value}), /remote_proxy_invalid/);
  }
});

test('proxied IP TLS verification checks the supplied IPv4 or IPv6 identity instead of localhost', async t => {
  for (const [host, san] of [['192.0.2.123', 'IP:192.0.2.123'], ['[2001:db8::123]', 'IP:2001:db8::123']]) {
    for (const valid of [false, true]) {
      const keys = certificate(t, valid ? san : 'DNS:localhost');
      const endpoint = await listen(t, https.createServer(keys));
      const wss = new WebSocketServer({server: endpoint});
      t.after(() => wss.close());
      const tunnel = await proxy(t, endpoint);
      const attempt = connectEndpoint(`wss://${host}/owned?token=synthetic`, {proxyUrl: tunnel.url, ca: keys.cert});
      if (valid) {
        const socket = await attempt.catch(error => assert.fail(`matching certificate rejected for ${host}: ${error.code}`));
        socket.terminate();
      } else {
        await assert.rejects(attempt, error => error.code === 'remote_tls_failed' && error.allocation === 'not_dispatched');
      }
      assert.equal(tunnel.seen[0].authority, host+':443');
    }
  }
});

test('HTTPS proxy and explicit loopback routing preserve independent target authentication', async t => {
  const keys = certificate(t);
  const endpoint = await listen(t, https.createServer(keys));
  const wss = new WebSocketServer({server: endpoint});
  t.after(() => wss.close());
  const received = [];
  wss.on('connection', (_ws, request) => received.push(request.headers.authorization));
  const tunnel = await proxy(t, endpoint, keys);
  const socket = await connectEndpoint(`wss://127.0.0.1:${endpoint.address().port}/owned`, {
    proxyUrl: tunnel.url, ca: keys.cert, headers: {Authorization: 'Bearer synthetic-target'}});
  assert.deepEqual(received, ['Bearer synthetic-target']);
  assert.equal(tunnel.seen[0].auth, 'Basic '+Buffer.from('fixture-user:fixture-pass').toString('base64'));
  socket.terminate();
});

test('HTTPS proxy identity is checked independently of the requested target', async t => {
  const keys = certificate(t, 'DNS:browser.invalid');
  const endpoint = await listen(t, https.createServer(keys));
  const wss = new WebSocketServer({server: endpoint});
  t.after(() => wss.close());
  const tunnel = await proxy(t, endpoint, keys);
  await assert.rejects(connectEndpoint('wss://browser.invalid/owned?token=synthetic', {proxyUrl: tunnel.url, ca: keys.cert}),
    error => error.code === 'remote_proxy_failed' && error.phase === 'proxy' && error.allocation === 'not_dispatched');
  assert.equal(tunnel.seen.length, 0);
});

test('oversized CONNECT headers and aborted pending CONNECT close their sockets within the attempt', {timeout: 5000}, async t => {
  let connects = 0;
  const oversized = await listen(t, http.createServer());
  oversized.on('connect', (_request, socket) => {
    connects++; socket.on('end', () => socket.end());
    socket.write('HTTP/1.1 200 Connection Established\r\nX-Overflow: '+'x'.repeat(20000)+'\r\n\r\n');
  });
  await assert.rejects(connectEndpoint('wss://browser.invalid/private?token=synthetic', {
    proxyUrl: `http://127.0.0.1:${oversized.address().port}`}),
  error => error.code === 'remote_proxy_failed' && error.phase === 'proxy' && error.allocation === 'not_dispatched');
  assert.equal(connects, 1);
  const pending = await listen(t, http.createServer());
  let closed;
  const arrived = new Promise(resolve => pending.once('connect', (_request, socket) => {
    socket.on('end', () => socket.end());
    closed = once(socket, 'close'); resolve();
  }));
  const controller = new AbortController();
  const attempt = connectEndpoint('wss://browser.invalid/private?token=synthetic', {
    proxyUrl: `http://127.0.0.1:${pending.address().port}`, signal: controller.signal});
  await arrived;
  controller.abort();
  await assert.rejects(attempt, error => error.code === 'remote_connect_cancelled');
  await closed;
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
