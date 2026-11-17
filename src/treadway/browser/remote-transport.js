'use strict';
// Secret-bearing endpoints stay inside the owner process. Errors contain codes only.
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const {performance} = require('node:perf_hooks');
const WebSocket = require('ws');
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

class RemoteTransportError extends Error {
  constructor(code, phase, {status, allocation = 'not_dispatched'} = {}) {
    super(code);
    this.code = code;
    this.phase = phase;
    this.allocation = allocation;
    if (Number.isInteger(status)) this.status = status;
  }
}

function parseEndpoint(value, {fresh = true} = {}) {
  try {
    if (typeof value !== 'string' || !value || /[^\x21-\x7e]/.test(value) || value.includes('#')) throw 0;
    const endpoint = value.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    const parsed = new URL(endpoint);
    if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) throw 0;
    // A fresh context must not silently adopt an explicitly requested profile.
    if (fresh) {
      for (const [key, item] of parsed.searchParams) {
        if (/^(?:userDataDir|user-data-dir|profile-directory)$/i.test(key)) throw 0;
        if (key === 'launch') {
          let options;
          try { options = JSON.parse(item); }
          catch { throw 0; } // Do not guess the contents of an opaque encoded launch bundle.
          if (!options || typeof options !== 'object' || Array.isArray(options)) throw 0;
          if (options.userDataDir || options.args?.some(arg => typeof arg !== 'string' || /--(?:user-data-dir|profile-directory)(?:=|$)/.test(arg))) throw 0;
        }
      }
    }
    return {endpoint, parsed};
  } catch { throw new RemoteTransportError('remote_endpoint_invalid', 'configuration'); }
}

function handshakeHeaders(values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new RemoteTransportError('remote_headers_invalid', 'configuration');
  const headers = {}, seen = new Set();
  let bytes = 0;
  for (const [key, value] of Object.entries(values)) {
    const lower = key.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) || seen.has(lower) ||
        ['host', 'connection', 'upgrade', 'proxy-authorization'].includes(lower) || lower.startsWith('sec-websocket-') ||
        typeof value !== 'string' || /[\r\n\0]/.test(value) || (bytes += key.length + value.length) > 32768) {
      throw new RemoteTransportError('remote_headers_invalid', 'configuration');
    }
    seen.add(lower); headers[key] = value;
  }
  return headers;
}

function connectEndpoint(value, {timeoutMs = 15000, proxyUrl = process.env.HTTP_PROXY || process.env.http_proxy ||
  process.env.HTTPS_PROXY || process.env.https_proxy, headers = {}, ca, fresh = true, signal, maxPayload = 16 * 1024 * 1024} = {}) {
  const {endpoint, parsed} = parseEndpoint(value, {fresh});
  headers = handshakeHeaders(headers);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3600000 ||
      !Number.isSafeInteger(maxPayload) || maxPayload < 1024 || maxPayload > 64 * 1024 * 1024) {
    throw new RemoteTransportError('remote_limits_invalid', 'configuration');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let proxy;
  if (!LOCAL.has(host)) {
    try {
      proxy = new URL(proxyUrl);
      if (proxy.protocol !== 'http:' || proxy.pathname !== '/' || proxy.search || proxy.hash) throw 0;
    } catch { throw new RemoteTransportError('remote_http_proxy_required', 'configuration'); }
  }
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let request, socket, ws, agent, settled = false, phase = proxy ? 'proxy' : 'handshake';
    let allocation = 'not_dispatched';
    const timer = setTimeout(() => fail('remote_connect_deadline'), timeoutMs);
    function fail(code, status) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      request?.destroy(); ws?.terminate(); socket?.destroy(); agent?.destroy();
      reject(new RemoteTransportError(code, phase, {status, allocation}));
    }
    function upgrade() {
      if (settled) return;
      phase = 'handshake'; allocation = 'unknown';
      try {
        const options = {headers, handshakeTimeout: Math.max(1, Math.ceil(deadline - performance.now())),
          followRedirects: false, maxPayload, ...(ca ? {ca} : {})};
        if (socket) {
          agent = parsed.protocol === 'wss:' ? new https.Agent() : new http.Agent();
          agent.createConnection = (_options, callback) => { callback(null, socket); };
          options.agent = agent;
        }
        ws = new WebSocket(endpoint, options);
        ws.on('error', () => fail('remote_handshake_failed'));
        ws.once('unexpected-response', (_request, response) => {
          const status = response.statusCode;
          if ([400, 401, 403, 404, 407, 429].includes(status)) allocation = 'rejected';
          response.destroy(); fail('remote_handshake_rejected', status);
        });
        ws.once('open', () => {
          if (settled) { ws.terminate(); return; }
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          // Do not return the endpoint or the agent to consumers of the connection.
          ws.once('close', () => agent?.destroy());
          resolve(ws);
        });
      } catch { fail('remote_handshake_failed'); }
    }
    function secure() {
      if (parsed.protocol !== 'wss:') { upgrade(); return; }
      phase = 'tls';
      try {
        socket = tls.connect({socket, servername: net.isIP(host) ? undefined : host,
          rejectUnauthorized: true, ...(ca ? {ca} : {})});
        socket.once('error', () => fail('remote_tls_failed'));
        socket.once('secureConnect', upgrade);
      } catch { fail('remote_tls_failed'); }
    }
    const abort = () => fail('remote_connect_cancelled');
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, {once: true});
    if (!proxy) { upgrade(); return; }
    try {
      const authority = `${parsed.hostname}:${parsed.port || (parsed.protocol === 'wss:' ? 443 : 80)}`;
      const proxyHeaders = {};
      if (proxy.username || proxy.password) proxyHeaders['Proxy-Authorization'] = 'Basic ' +
        Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
      request = http.request({hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || 80,
        method: 'CONNECT', path: authority, headers: {Host: authority, ...proxyHeaders}});
      request.once('error', () => fail('remote_proxy_failed'));
      request.once('connect', (response, upstream, head) => {
        if (settled) { upstream.destroy(); return; }
        if (response.statusCode !== 200) { upstream.destroy(); fail('remote_proxy_rejected', response.statusCode); return; }
        socket = upstream; socket.once('error', () => fail('remote_proxy_failed'));
        if (head.length) socket.unshift(head);
        secure();
      });
      request.end();
    } catch { fail('remote_proxy_failed'); }
  });
}

module.exports = {connectEndpoint, parseEndpoint, handshakeHeaders, RemoteTransportError};
