// Explicit loopback browser or configured HTTP proxy. Never retry/fall back.
const http = require('node:http');
const WebSocket = require('ws');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function createCdpProxy({ cdpHost, cdpPort, timeoutMs = 10000,
  proxyUrl = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy } = {}) {
  if (typeof cdpHost !== 'string' || !cdpHost || /[\s/@?#]/.test(cdpHost)) throw new Error('Explicit CDP hostname required');
  cdpPort = Number(cdpPort);
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) throw new Error('Invalid CDP port');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
  const isLocal = LOCAL_HOSTS.has(cdpHost);
  const authority = `${cdpHost.includes(':') ? `[${cdpHost}]` : cdpHost}:${cdpPort}`;
  const endpoint = new URL(`http://${authority}`);
  if (endpoint.hostname.replace(/^\[|\]$/g, '') !== cdpHost) throw new Error('CDP hostname must be canonical');
  const proxy = !isLocal ? new URL(proxyUrl || (() => { throw new Error('Remote browser connections require an explicit HTTP proxy'); })()) : null;
  if (proxy && proxy.protocol !== 'http:') throw new Error('Only HTTP CONNECT proxies are supported');
  const proxyHeaders = proxy?.username || proxy?.password ? {
    'Proxy-Authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64'),
  } : {};
  const proxyOptions = proxy ? { hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port || 80) } : {};
  const checkPath = value => {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\r\n#]/.test(value)) throw new Error('Absolute CDP path required');
  };

  function cdpHttpGet(path) {
    checkPath(path);
    return new Promise((resolve, reject) => {
      const options = isLocal ? { hostname: cdpHost, port: cdpPort, path } : {
        ...proxyOptions, path: `http://${authority}${path}`, headers: { Host: authority, ...proxyHeaders },
      };
      const req = http.get(options);
      const timer = setTimeout(() => req.destroy(new Error('CDP HTTP deadline')), timeoutMs);
      const fail = error => { clearTimeout(timer); reject(error); };
      req.on('error', fail);
      req.on('response', res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('CDP HTTP response interrupted')));
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode !== 200) return reject(new Error(`CDP HTTP status ${res.statusCode}`));
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('CDP HTTP invalid JSON response')); }
        });
      });
    });
  }

  function openTunnel() {
    return new Promise((resolve, reject) => {
      const req = http.request({ ...proxyOptions, method: 'CONNECT', path: authority, headers: { Host: authority, ...proxyHeaders } });
      const timer = setTimeout(() => req.destroy(new Error('CDP CONNECT deadline')), timeoutMs);
      req.on('error', error => { clearTimeout(timer); reject(error); });
      req.on('connect', (res, socket, head) => {
        clearTimeout(timer);
        if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`CDP CONNECT status ${res.statusCode}`)); return; }
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      req.end();
    });
  }

  async function cdpConnect(wsPath) {
    checkPath(wsPath);
    const tunnel = isLocal ? null : await openTunnel();
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(`ws://${authority}${wsPath}`, {
          handshakeTimeout: timeoutMs,
          ...(tunnel ? { createConnection: () => tunnel } : {}),
        });
      } catch (error) { tunnel?.destroy(); reject(error); return; }
      ws.once('open', () => resolve(ws));
      ws.on('error', error => { tunnel?.destroy(); reject(error); });
    });
  }

  async function listTargets() {
    const targets = await cdpHttpGet('/json/list');
    if (!Array.isArray(targets)) throw new Error('CDP target list must be an array');
    return targets;
  }
  const getVersion = () => cdpHttpGet('/json/version');
  return { cdpHttpGet, cdpConnect, listTargets, getVersion, cdpHost, cdpPort, isLocal };
}
module.exports = { createCdpProxy };
