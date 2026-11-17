'use strict';
// The one runner entry point; local discovery validation stays unchanged.
const {createCdpProxy, connect, makeCdpClient, initializeSession} = require('./cdp');
const {connectWorker} = require('./worker-client');

async function connectSession(configuration, options = {}) {
  if (options.reconciliation) throw new Error('remote_observation_entry_required');
  if (configuration?.kind !== 'run-worker') {
    if (configuration?.kind) throw new Error('unsupported_browser_connection_kind');
    return connect(createCdpProxy(configuration), configuration.targetId, options);
  }
  const channel = await connectWorker(configuration, {timeoutMs: options.commandTimeoutMs || 5000,
    reconciliation: options.reconciliation === true});
  let client;
  try {
    client = makeCdpClient(channel, options);
    client.capabilities = channel.capabilities;
    return await initializeSession(client, channel.target, channel.capabilities);
  } catch (error) { client?.close(); channel.close(); throw error; }
}

// A quarantined actor must not run normal session initialization (which
// injects JavaScript). Only the worker's explicit observation allowlist applies.
async function observeSession(configuration, options = {}) {
  if (configuration?.kind !== 'run-worker') throw new Error('remote_observation_entry_required');
  const channel = await connectWorker(configuration, {timeoutMs: options.commandTimeoutMs || 5000, reconciliation: true});
  const cdp = makeCdpClient(channel, options);
  return {cdp, target: channel.target, capabilities: {...channel.capabilities, observationOnly: true}, close: () => cdp.close()};
}
module.exports = {connectSession, observeSession};
