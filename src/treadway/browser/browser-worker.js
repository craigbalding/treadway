'use strict';
// One owner per run. Application operation processes never own the upstream socket.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const readline = require('node:readline');
const {performance} = require('node:perf_hooks');
const {connectEndpoint, RemoteTransportError} = require('./remote-transport');
const {makeCdpClient} = require('./cdp');
const browserlessReconnect = require('./browserless-reconnect');
const providerProfile = require('./provider-profile');

const MAX_LINE = 16 * 1024 * 1024;
const READ_ONLY = new Set(['Page.enable', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.captureScreenshot',
  'DOM.getDocument', 'DOM.describeNode', 'DOM.getOuterHTML', 'DOM.querySelector', 'DOM.querySelectorAll',
  'Accessibility.getFullAXTree', 'Network.getCookies', 'Storage.getCookies']);
const DENIED = new Set(['Page.setDownloadBehavior', 'Network.clearBrowserCookies', 'Network.clearBrowserCache']);
function failure(code, extra = {}) { return Object.assign(new Error(code), {code, ...extra}); }
function safeError(error, fallback = 'remote_command_incomplete') {
  if (error instanceof RemoteTransportError) return {code: error.code, phase: error.phase, allocation: error.allocation,
    ...(error.status ? {status: error.status} : {})};
  if (typeof error?.code === 'string' && /^(?:remote_|ipc_)[a-z_]+$/.test(error.code)) return {code: error.code,
    ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? {status: error.status} : {}),
    ...(typeof error.phase === 'string' && /^[a-z_]+$/.test(error.phase) ? {phase: error.phase} : {}),
    ...(['not_dispatched', 'unknown', 'rejected'].includes(error.allocation) ? {allocation: error.allocation} : {}),
    ...(error.cleanup && ['fresh', 'borrowed', 'provider-session'].includes(error.cleanup.ownership) &&
      ['complete', 'contextDisposed', 'attachmentDetached', 'uncertainDispatches'].every(key => typeof error.cleanup[key] === 'boolean') ?
      {cleanup: {...Object.fromEntries(['ownership', 'complete', 'contextDisposed', 'attachmentDetached', 'uncertainDispatches'].map(key => [key, error.cleanup[key]])),
        ...(typeof error.cleanup.profileReleased === 'boolean' ? {profileReleased: error.cleanup.profileReleased} : {})}} : {})};
  return {code: fallback};
}
function bounded(value, minimum, maximum) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function identifier(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value); }

class BrowserWorker {
  constructor({root, socketRoot = root, projectId, runId, acquireMs = 15000, sessionMs = 300000, cleanupMs = 3000} = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !identifier(projectId) || !identifier(runId) ||
        !bounded(acquireMs, 1, 3600000) || !bounded(sessionMs, 1, 86400000) || !bounded(cleanupMs, 1, 60000)) {
      throw failure('remote_worker_configuration_invalid');
    }
    if (typeof socketRoot !== 'string' || !path.isAbsolute(socketRoot)) throw failure('remote_worker_configuration_invalid');
    Object.assign(this, {root, socketRoot, projectId, runId, acquireMs, sessionMs, cleanupMs});
    this.actors = new Map(); this.sockets = new Set(); this.started = false; this.closed = false;
    this.socketPath = path.join(socketRoot, 'cdp.sock');
    this.capabilityPath = path.join(socketRoot, 'client.json');
    this.capability = crypto.randomBytes(32).toString('hex');
  }
  record(entry) {
    const fd = fs.openSync(path.join(this.root, 'events.jsonl'), fs.constants.O_CREAT | fs.constants.O_APPEND |
      fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, JSON.stringify({time: new Date().toISOString(), ...entry}) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  async start() {
    if (this.started || this.closed) throw failure('remote_worker_not_new');
    for (const directory of [this.root, this.socketRoot]) {
      for (let current = directory; ; current = path.dirname(current)) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw failure('remote_private_root_required');
        if (path.dirname(current) === current) break;
      }
      fs.mkdirSync(directory, {recursive: true, mode: 0o700});
      if (!fs.statSync(directory).isDirectory() || (fs.statSync(directory).mode & 0o077)) throw failure('remote_private_root_required');
    }
    const fd = fs.openSync(this.capabilityPath, 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify({capability: this.capability})); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.server = net.createServer(socket => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject); this.server.listen(this.socketPath, resolve);
    });
    fs.chmodSync(this.socketPath, 0o600);
    this.started = true;
    this.record({kind: 'worker_started', version: 1, projectId: this.projectId, runId: this.runId});
    return {projectId: this.projectId, runId: this.runId};
  }
  handle(actor) {
    return {kind: 'run-worker', version: 1, projectId: this.projectId, runId: this.runId,
      actor: actor.name, generation: actor.generation, targetId: actor.targetRef,
      browserContextId: actor.contextRef, socketPath: this.socketPath, capabilityPath: this.capabilityPath};
  }
  lookup(handle) {
    if (!handle || handle.projectId !== this.projectId || handle.runId !== this.runId || handle.kind !== 'run-worker' || handle.version !== 1) {
      throw failure('remote_binding_differs');
    }
    const actor = this.actors.get(handle.actor);
    if (!actor || handle.generation !== actor.generation || handle.targetId !== actor.targetRef ||
        handle.browserContextId !== actor.contextRef) throw failure('remote_generation_differs');
    return actor;
  }
  async acquire({actor: name, endpoint, headers, proxyUrl, ca, budgetMs = this.acquireMs,
    mode = 'fresh', borrowed, reconnect, profile} = {}) {
    if (!this.started || this.closed || !identifier(name)) throw failure('remote_acquisition_invalid');
    if (!bounded(budgetMs, 1, this.acquireMs)) throw failure('remote_acquisition_deadline_invalid');
    if (this.actors.has(name)) throw failure('remote_actor_already_acquired');
    if (!['fresh', 'borrowed', 'provider-session'].includes(mode) || mode !== 'borrowed' && borrowed !== undefined ||
      mode !== 'provider-session' && profile !== undefined ||
      mode === 'borrowed' && (!borrowed || borrowed.scope !== 'context' || !['observe', 'drive'].includes(borrowed.permission) ||
        !['contextId', 'targetId'].every(key => typeof borrowed[key] === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(borrowed[key]))))
      throw failure('remote_borrowed_binding_required');
    const reconnectPolicy = browserlessReconnect.validatePolicy(reconnect);
    if (mode !== 'fresh' && reconnectPolicy) throw failure('remote_reconnect_mode_unsupported');
    const profileScope = mode === 'provider-session' ? providerProfile.authorize(profile, endpoint, this.projectId) : null;
    const actor = {name, generation: crypto.randomUUID(), targetRef: crypto.randomUUID(), contextRef: crypto.randomUUID(),
      mode, permission: borrowed?.permission || 'drive', attachments: new Map(), attaching: 0,
      profileScope,
      reconnectPolicy, initialEndpoint: endpoint, transportOptions: {headers, proxyUrl, ca},
      state: 'acquiring', receipts: new Map(), receiptBytes: 0, pending: new Set(), uncertain: false, abort: new AbortController()};
    this.actors.set(name, actor);
    const deadline = performance.now() + budgetMs;
    const remaining = () => { const value = Math.ceil(deadline - performance.now()); if (value <= 0) throw failure('remote_acquisition_deadline'); return value; };
    this.record({kind: 'acquisition_intent', actor: name, generation: actor.generation, mode});
    try {
      actor.ws = await connectEndpoint(endpoint, {headers, proxyUrl, ca, fresh: mode === 'fresh', signal: actor.abort.signal, timeoutMs: remaining()});
      actor.cdp = makeCdpClient(actor.ws, {commandTimeoutMs: this.acquireMs});
      const command = (method, params = {}) => {
        if (this.closed || actor.state !== 'acquiring') throw failure('remote_acquisition_cancelled');
        return actor.cdp.send(method, params, {timeoutMs: remaining()});
      };
      if (mode === 'fresh') {
        actor.contextCreationSent = true;
        actor.contextId = (await command('Target.createBrowserContext', {disposeOnDetach: !reconnectPolicy})).browserContextId;
        if (typeof actor.contextId !== 'string' || !actor.contextId) throw failure('remote_context_unavailable');
        actor.scopeConfirmed = true;
        this.record({kind: 'context_acquired', actor: name, generation: actor.generation, contextId: actor.contextId});
        actor.targetId = (await command('Target.createTarget', {url: 'about:blank', browserContextId: actor.contextId})).targetId;
        if (typeof actor.targetId !== 'string' || !actor.targetId) throw failure('remote_target_unavailable');
      } else if (mode === 'provider-session') {
        actor.targetId = (await command('Target.createTarget', {url: 'about:blank'})).targetId;
        if (typeof actor.targetId !== 'string' || !actor.targetId) throw failure('remote_target_unavailable');
        this.record({kind: 'profile_acquired', actor: name, generation: actor.generation, resourceRef: profileScope.resourceRef});
      } else {
        actor.contextId = borrowed.contextId; actor.targetId = borrowed.targetId;
      }
      const {targetInfo} = await command('Target.getTargetInfo', {targetId: actor.targetId});
      if (mode === 'provider-session') actor.contextId = targetInfo?.browserContextId ?? null;
      if (targetInfo?.targetId !== actor.targetId || targetInfo.type !== 'page' || (targetInfo.browserContextId ?? null) !== actor.contextId) {
        throw failure('remote_target_context_differs');
      }
      actor.scopeConfirmed = true;
      actor.state = 'ready'; actor.deadline = performance.now() + this.sessionMs;
      actor.timer = setTimeout(() => this.release(this.handle(actor)).catch(() => {}), this.sessionMs);
      this.watchTransport(actor, actor.ws);
      this.record({kind: 'acquisition_ready', actor: name, generation: actor.generation, targetId: actor.targetId});
      return {connection: this.handle(actor), capabilities: {freshContext: mode === 'fresh', ownership: mode,
        observationOnly: actor.permission === 'observe', reconnect: !!reconnectPolicy, screenshots: true,
        cookieScope: 'context', originClear: false, targetMonitoring: false, fileTransfers: false}};
    } catch (error) {
      const reason = safeError(error, 'remote_acquisition_incomplete');
      this.record({kind: 'acquisition_incomplete', actor: name, generation: actor.generation, ...reason});
      reason.cleanup = await this.release(this.handle(actor));
      actor.cdp?.close(); actor.ws?.terminate();
      throw Object.assign(failure(reason.code), reason);
    }
  }
  watchTransport(actor, socket) {
    socket.on('close', () => {
      if (socket !== actor.ws || socket === actor.intentionalClose ||
          !['ready', 'preparing_reconnect', 'reconnecting'].includes(actor.state)) return;
      actor.state = 'transport_lost'; actor.uncertain = actor.uncertain || actor.pending.size > 0;
      this.record({kind: 'transport_lost', actor: actor.name, generation: actor.generation});
      actor.client?.destroy();
    });
  }
  prepareReconnect(handle, options) { return browserlessReconnect.prepare(this, this.lookup(handle), options); }
  reconnect(handle, options) { return browserlessReconnect.reconnect(this, this.lookup(handle), options); }
  async engineIdentity(handle) {
    const actor = this.lookup(handle);
    if (actor.state !== 'ready' || actor.client || actor.driveLease || actor.uncertain) throw failure('remote_actor_busy');
    const response = await actor.cdp.send('Browser.getVersion', {}, {
      timeoutMs: Math.max(1, Math.min(this.acquireMs, Math.ceil(actor.deadline - performance.now())))});
    if (actor.state !== 'ready' || performance.now() >= actor.deadline) throw failure('remote_engine_identity_incomplete');
    const details = {};
    for (const key of ['protocolVersion', 'product', 'revision', 'userAgent', 'jsVersion']) {
      if (typeof response[key] !== 'string' || !/^[ -~]{1,2000}$/.test(response[key])) throw failure('remote_engine_identity_incomplete');
      details[key] = response[key];
    }
    const identity = crypto.createHash('sha256').update(JSON.stringify(details)).digest('hex');
    this.record({kind: 'engine_observed', actor: actor.name, generation: actor.generation, identity, details});
    return {version: 'treadway.browser-engine-observation/1', identity, scope: 'connected-browser',
      evidence: {reference: 'events.jsonl', actor: actor.name, generation: actor.generation}};
  }
  detachPage(actor, sessionId) {
    const existing = actor.attachments.get(sessionId);
    if (existing?.then) return existing;
    if (!actor.attachments.has(sessionId)) return Promise.resolve(true);
    const result = actor.cdp.send('Target.detachFromTarget', {sessionId}, {timeoutMs: this.cleanupMs})
      .then(() => { actor.attachments.delete(sessionId); return true; }, () => false);
    actor.attachments.set(sessionId, result);
    return result;
  }
  async release(handle) {
    const actor = this.lookup(handle);
    if (actor.releasePromise) return actor.releasePromise;
    actor.releasePromise = (async () => {
      const priorState = actor.state; actor.state = 'releasing'; clearTimeout(actor.timer);
      actor.uncertain = actor.uncertain || actor.pending.size > 0;
      actor.abort.abort();
      this.record({kind: 'cleanup_intent', actor: actor.name, generation: actor.generation});
      actor.client?.destroy();
      let contextDisposed = actor.mode === 'fresh' && !actor.contextCreationSent, remoteTermination = 'unconfirmed';
      let attachmentDetached = false, profileReleased = false;
      if (actor.mode === 'borrowed') {
        const attaching = actor.attaching > 0;
        const replies = await Promise.all([...actor.attachments.keys()].map(id => this.detachPage(actor, id)));
        attachmentDetached = !attaching && actor.attaching === 0 && priorState !== 'transport_lost' && replies.every(value => value === true);
      } else if (actor.mode === 'provider-session') {
        if (actor.cdp && actor.profileScope && priorState !== 'transport_lost') {
          profileReleased = await providerProfile.close(actor, this.cleanupMs);
          if (profileReleased) remoteTermination = 'confirmed';
        }
      } else if (actor.cdp && actor.contextId && actor.scopeConfirmed && priorState !== 'transport_lost') {
        try {
          await actor.cdp.send('Target.disposeBrowserContext', {browserContextId: actor.contextId}, {timeoutMs: this.cleanupMs});
          contextDisposed = true;
        } catch { /* Keep the cleanup uncertainty separate from application outcome. */ }
      }
      actor.cdp?.close(); actor.ws?.terminate(); actor.state = 'released';
      const result = {contextDisposed, attachmentDetached, ownership: actor.mode, connectionClosed: true, remoteTermination,
        ...(actor.mode === 'provider-session' ? {profileReleased, profileRetained: profileReleased} : {}),
        complete: actor.mode === 'provider-session' ? profileReleased : actor.mode === 'borrowed' ? attachmentDetached : contextDisposed,
        uncertainDispatches: actor.uncertain};
      this.record({kind: 'cleanup_result', actor: actor.name, generation: actor.generation, ...result});
      return result;
    })();
    return actor.releasePromise;
  }
  reserve(handle) {
    const actor = this.lookup(handle);
    if (actor.state !== 'ready' || actor.client || actor.driveLease) throw failure('remote_actor_busy');
    if (actor.uncertain) throw failure('remote_reconciliation_required');
    actor.driveLease = crypto.randomUUID();
    return {driveLease: actor.driveLease};
  }
  unreserve(handle) {
    const actor = this.lookup(handle);
    if (!actor.driveLease || actor.driveLease !== handle.driveLease) throw failure('remote_drive_lease_differs');
    if (actor.pending.size) actor.uncertain = true;
    actor.client?.destroy(); actor.driveLease = null;
    return {released: true, reconciliationRequired: actor.uncertain};
  }
  inspect(handle) {
    const actor = this.lookup(handle);
    return {state: actor.state, generation: actor.generation, reconciliationRequired: actor.uncertain,
      commands: [...actor.receipts].map(([requestRef, receipt]) => ({requestRef, pending: receipt.pending,
        outcome: receipt.pending ? 'pending' : receipt.unknown ? 'unknown' : 'replied', reconciliation: receipt.reconciliation || null}))};
  }
  reconcile(handle, {requestRef, outcome, evidence} = {}) {
    const actor = this.lookup(handle), receipt = actor.receipts.get(requestRef);
    if (!receipt?.unknown || receipt.pending || !['applied', 'not_applied', 'unknown'].includes(outcome) ||
        !evidence || typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
        !identifier(evidence.reference)) throw failure('remote_reconciliation_evidence_required');
    // Application evidence resolves an effect, not whether timed-out remote
    // JavaScript has stopped. Keep the generation quarantined until fencing is
    // independently established; never interpret this record as retry permission.
    const reconciliation = {outcome, evidence: {reference: evidence.reference, sha256: evidence.sha256}, remoteExecution: 'unconfirmed'};
    this.record({kind: 'application_reconciled', actor: actor.name, generation: actor.generation, requestRef, ...reconciliation});
    receipt.reconciliation = reconciliation;
    return {recorded: true, reconciliationRequired: actor.uncertain, remoteExecution: 'unconfirmed'};
  }
  route(actor, method, params) {
    if (method === 'Storage.getCookies' || method === 'Storage.setCookies') {
      if (params.browserContextId && params.browserContextId !== actor.contextRef) throw failure('remote_context_differs');
      const scoped = {...params}; delete scoped.browserContextId;
      return {params: {...scoped, ...(actor.contextId ? {browserContextId: actor.contextId} : {})}, sessionId: null};
    }
    if (!(method === 'DOMStorage.getDOMStorageItems' || /^(?:Page|Runtime|DOM|Input|Network|Accessibility|Emulation)\.[A-Za-z]+$/.test(method)) || DENIED.has(method)) {
      throw failure('remote_method_unsupported');
    }
    return {params};
  }
  accept(socket) {
    this.sockets.add(socket); socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '', actor, clientRef, pageSession, authenticated = false;
    socket.setTimeout(this.acquireMs, () => socket.destroy());
    const write = value => {
      if (socket.writableLength > MAX_LINE) { socket.destroy(); return; }
      if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n');
    };
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (actor?.client === socket) {
        if (actor.pending.size) { actor.uncertain = true; this.record({kind: 'client_lost', actor: actor.name, generation: actor.generation}); }
        actor.client = null;
        if (pageSession && actor.state === 'ready') this.detachPage(actor, pageSession).catch(() => {});
      }
    });
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > (authenticated ? MAX_LINE : 16384)) { socket.destroy(); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let value;
        try { value = JSON.parse(line); } catch { socket.destroy(); return; }
        // The first handshake must finish before accepting commands.
        if (!authenticated) {
          if (socket.handshaking) { socket.destroy(); return; }
          socket.handshaking = true;
          (async () => {
            if (typeof value.capability !== 'string' || value.capability.length !== this.capability.length ||
                !crypto.timingSafeEqual(Buffer.from(value.capability), Buffer.from(this.capability)) || !identifier(value.clientRef)) {
              throw failure('ipc_authorization_failed');
            }
            actor = this.lookup(value.connection); clientRef = value.clientRef;
            if (actor.state !== 'ready' || performance.now() >= actor.deadline) throw failure('remote_session_unavailable');
            if (actor.client) throw failure('remote_actor_busy');
            if (actor.driveLease && value.connection.driveLease !== actor.driveLease) throw failure('remote_actor_busy');
            if (actor.uncertain && value.reconciliation !== true) throw failure('remote_reconciliation_required');
            actor.client = socket;
            actor.attaching++;
            let attached;
            try {
              // Recheck the exact target: an operator may have closed/replaced it since acquisition.
              const {targetInfo} = await actor.cdp.send('Target.getTargetInfo', {targetId: actor.targetId},
                {timeoutMs: Math.min(this.acquireMs, Math.max(1, Math.ceil(actor.deadline - performance.now())))});
              if (targetInfo?.targetId !== actor.targetId || (targetInfo.browserContextId ?? null) !== actor.contextId || targetInfo.type !== 'page')
                throw failure('remote_target_context_differs');
              attached = await actor.cdp.send('Target.attachToTarget', {targetId: actor.targetId, flatten: true},
                {timeoutMs: Math.min(this.acquireMs, Math.max(1, Math.ceil(actor.deadline - performance.now())))});
            } finally { actor.attaching--; }
            pageSession = attached.sessionId;
            if (typeof pageSession !== 'string' || !pageSession) throw failure('remote_page_attachment_incomplete');
            actor.attachments.set(pageSession, null);
            if (socket.destroyed || actor.state !== 'ready') {
              await this.detachPage(actor, pageSession);
              return;
            }
            const removers = [];
            let eventCount = 0;
            for (const event of ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished',
              'Network.loadingFailed', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Page.frameNavigated',
              'Page.navigatedWithinDocument', 'Page.javascriptDialogOpening', 'Page.javascriptDialogClosed',
              'Page.loadEventFired', 'Page.lifecycleEvent', 'DOM.documentUpdated']) {
              removers.push(actor.cdp.onAll(event, (params, sessionId) => {
                if (sessionId !== pageSession) return;
                if (++eventCount > 10000) { socket.destroy(); return; }
                write({method: event, params});
              }));
            }
            socket.once('close', () => { for (const remove of removers) remove(); });
            authenticated = true; socket.reconciliation = value.reconciliation === true;
            // The handshake timer must not shorten an authenticated actor's
            // explicit lifetime. Commands and actor teardown have their own bounds.
            socket.setTimeout(0);
            write({ready: true, target: {id: actor.targetRef, type: 'page', browserContextId: actor.contextRef},
              capabilities: {remote: true, ownership: actor.mode, observationOnly: actor.permission === 'observe',
                originClear: false, targetMonitoring: false, fileTransfers: false}});
          })().catch(error => { write({error: safeError(error)}); socket.end(); });
          continue;
        }
        this.command({actor, socket, clientRef, pageSession, value, write}).catch(() => socket.destroy());
      }
    });
  }
  async command({actor, socket, clientRef, pageSession, value, write}) {
    const id = value.id;
    if (!Number.isSafeInteger(id) || id < 1 || typeof value.method !== 'string' ||
        !value.params || typeof value.params !== 'object' || Array.isArray(value.params)) { socket.destroy(); return; }
    const key = `${clientRef}:${id}`;
    const signature = crypto.createHash('sha256').update(JSON.stringify([value.method, value.params])).digest('hex');
    const existing = actor.receipts.get(key);
    if (existing) {
      if (existing.signature !== signature) { write({id, error: {code: 'ipc_request_conflict'}}); return; }
      if (existing.reply) write(existing.reply);
      else write({id, error: {code: existing.pending ? 'ipc_request_pending' : 'ipc_result_not_retained'}});
      return;
    }
    if (actor.receipts.size >= 100000 || actor.pending.size >= 32) { write({id, error: {code: 'ipc_command_limit'}}); return; }
    let route, timeoutMs;
    try {
      if (actor.state !== 'ready' || actor.client !== socket) throw failure('remote_session_unavailable');
      if (actor.uncertain && (!socket.reconciliation || !READ_ONLY.has(value.method))) throw failure('remote_reconciliation_required');
      if ((actor.permission === 'observe' || socket.reconciliation) && !READ_ONLY.has(value.method)) throw failure('remote_observation_only');
      timeoutMs = value.options?.timeoutMs ?? 5000;
      if (!bounded(timeoutMs, 1, 60000)) throw failure('remote_command_deadline_invalid');
      timeoutMs = Math.min(timeoutMs, Math.ceil(actor.deadline - performance.now()));
      if (timeoutMs <= 0) throw failure('remote_session_unavailable');
      route = this.route(actor, value.method, value.params);
    } catch (error) { write({id, error: {...safeError(error), outcome: 'not_dispatched'}}); return; }
    const receipt = {signature, pending: true}; actor.receipts.set(key, receipt); actor.pending.add(key);
    this.record({kind: 'command_dispatch', actor: actor.name, generation: actor.generation, requestRef: key, method: value.method});
    let reply;
    try {
      const result = await actor.cdp.send(value.method, route.params,
        {timeoutMs, sessionId: route.sessionId === null ? null : pageSession});
      reply = {id, result};
      this.record({kind: 'command_replied', actor: actor.name, generation: actor.generation, requestRef: key});
    } catch {
      actor.uncertain = true;
      receipt.unknown = true;
      reply = {id, error: {code: 'remote_command_incomplete', outcome: 'unknown'}};
      this.record({kind: 'command_unknown', actor: actor.name, generation: actor.generation, requestRef: key});
    } finally { actor.pending.delete(key); receipt.pending = false; }
    const bytes = Buffer.byteLength(JSON.stringify(reply));
    if (actor.receiptBytes + bytes <= 32 * 1024 * 1024) { receipt.reply = reply; actor.receiptBytes += bytes; }
    write(reply);
  }
  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = (async () => {
      const results = await Promise.allSettled([...this.actors.values()].map(actor => this.release(this.handle(actor))));
      for (const socket of this.sockets) socket.destroy();
      if (this.server) await new Promise(resolve => this.server.close(resolve));
      fs.rmSync(this.capabilityPath, {force: true});
      this.record({kind: 'worker_stopped'});
      return {complete: results.every(item => item.status === 'fulfilled' && item.value.complete)};
    })();
    return this.shutdownPromise;
  }
}

async function main() {
  const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
    let worker, queue = Promise.resolve(), closing = false;
  const write = value => process.stdout.write(JSON.stringify(value) + '\n');
  lines.on('line', line => {
    if (Buffer.byteLength(line) > MAX_LINE) { lines.close(); return; }
    queue = queue.then(async () => {
      const input = JSON.parse(line);
      try {
        if (closing) throw failure('remote_owner_closed');
        if (!worker) { worker = new BrowserWorker(input.configuration); await worker.start();
          if (closing) { await worker.shutdown(); return; }
          write({id: input.id, result: {ready: true}}); }
        else if (input.operation === 'acquire') write({id: input.id, result: await worker.acquire(input.arguments)});
        else if (input.operation === 'release') write({id: input.id, result: await worker.release(input.connection)});
        else if (input.operation === 'reserve') write({id: input.id, result: worker.reserve(input.connection)});
        else if (input.operation === 'unreserve') write({id: input.id, result: worker.unreserve(input.connection)});
        else if (input.operation === 'inspect') write({id: input.id, result: worker.inspect(input.connection)});
        else if (input.operation === 'engine_identity') write({id: input.id, result: await worker.engineIdentity(input.connection)});
        else if (input.operation === 'reconcile') write({id: input.id, result: worker.reconcile(input.connection, input.arguments)});
        else if (input.operation === 'prepare_reconnect') write({id: input.id, result: await worker.prepareReconnect(input.connection, input.arguments)});
        else if (input.operation === 'reconnect') write({id: input.id, result: await worker.reconnect(input.connection, input.arguments)});
        else if (input.operation === 'shutdown') { write({id: input.id, result: await worker.shutdown()}); lines.close(); }
        else throw failure('remote_control_operation_invalid');
      } catch (error) { write({id: input.id, error: safeError(error)}); }
    }).catch(() => { write({error: {code: 'remote_control_incomplete'}}); lines.close(); });
  });
  lines.on('close', () => { closing = true; worker?.shutdown().catch(() => {}); });
  process.stdout.on('error', () => lines.close());
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { lines.close(); });
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = {BrowserWorker, safeError};
