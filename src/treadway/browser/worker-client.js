'use strict';
const {MAX_BROWSER_MESSAGE_BYTES} = require('./limits.js');
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');

function connectWorker(connection, {timeoutMs = 5000, reconciliation = false} = {}) {
  return new Promise((resolve, reject) => {
    let capability;
    try {
      if (connection.kind !== 'run-worker' || connection.version !== 1 || typeof connection.socketPath !== 'string' ||
          typeof connection.capabilityPath !== 'string' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw 0;
      const stat = fs.lstatSync(connection.capabilityPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 4096) throw 0;
      capability = JSON.parse(fs.readFileSync(connection.capabilityPath, 'utf8')).capability;
      if (typeof capability !== 'string') throw 0;
    } catch { reject(Object.assign(new Error('ipc_private_connection_required'), {code: 'ipc_private_connection_required'})); return; }
    const channel = new EventEmitter();
    channel.on('error', () => {});
    channel.treadwayIPC = true;
    const socket = net.connect(connection.socketPath);
    socket.setEncoding('utf8');
    let ready = false, settled = false, buffer = '';
    const fail = code => {
      if (!settled) { settled = true; clearTimeout(timer); reject(Object.assign(new Error(code), {code})); }
      socket.destroy();
    };
    const timer = setTimeout(() => fail('ipc_attachment_deadline'), timeoutMs);
    channel.send = (data, callback) => {
      if (!ready || socket.destroyed) { callback?.(new Error('ipc_connection_closed')); return; }
      socket.write(data + '\n', callback);
    };
    channel.terminate = channel.close = () => socket.destroy();
    socket.once('connect', () => socket.write(JSON.stringify({connection, capability, reconciliation,
      clientRef: crypto.randomUUID()}) + '\n'));
    socket.on('error', () => { if (!ready) fail('ipc_connection_failed'); else channel.emit('error', new Error('ipc_connection_failed')); });
    socket.on('close', () => {
      ready = false;
      if (!settled) fail('ipc_connection_closed');
      channel.emit('close');
    });
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BROWSER_MESSAGE_BYTES) { fail('ipc_message_limit'); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let value;
        try { value = JSON.parse(line); } catch { fail('ipc_message_invalid'); return; }
        if (!ready) {
          if (value.ready !== true) {
            const code = typeof value.error?.code === 'string' && /^(?:remote_|ipc_)[a-z_]+$/.test(value.error.code) ? value.error.code : 'ipc_attachment_incomplete';
            fail(code); return;
          }
          ready = settled = true; clearTimeout(timer);
          channel.target = value.target; channel.capabilities = value.capabilities;
          // Bridge callers install their CDP listeners immediately after this resolution.
          resolve(channel);
        } else channel.emit('message', line);
      }
    });
  });
}
module.exports = {connectWorker};
