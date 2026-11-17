// Opt-in acceptance against the immutable published OSS service, not a CDP relay.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {BrowserWorker} = require('../src/treadway/browser/browser-worker');
const {connectEndpoint} = require('../src/treadway/browser/remote-transport');
const {connectSession} = require('../src/treadway/browser/connection');
const {makeCdpClient} = require('../src/treadway/browser/cdp');

const packageRoot = process.env.TREADWAY_BROWSERLESS_SERVICE;
const node = process.env.TREADWAY_BROWSERLESS_NODE;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Browserless 2.63.1: owned contexts, other-project sentinel, capacity and unknown write',
  {skip: !packageRoot || !node, timeout: 120000}, async t => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'))).version, '2.63.1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-browserless-acceptance-'));
  fs.chmodSync(root, 0o700);
  let completed = false, service, sentinel;
  const workers = [], sessions = [];
  const requests = [];
  const app = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/save') requests.push('saved');
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Synthetic application</title><p>Ready</p>');
  });
  t.after(async () => {
    for (const session of sessions) session.close();
    for (const worker of workers) await worker.shutdown();
    sentinel?.close();
    if (service && service.exitCode === null) {
      service.kill('SIGTERM');
      const ended = once(service, 'exit');
      await Promise.race([ended, pause(8000)]);
      if (service.exitCode === null) { service.kill('SIGKILL'); await ended; }
    }
    await new Promise(resolve => app.close(resolve));
    if (completed) fs.rmSync(root, {recursive: true, force: true});
    else t.diagnostic('Private Browserless evidence retained: ' + root);
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const origin = `http://127.0.0.1:${app.address().port}`;
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const token = crypto.randomBytes(24).toString('hex');
  const routes = path.join(root, 'routes');
  fs.mkdirSync(routes, {mode: 0o700});
  for (const directory of ['data', 'downloads', 'scratch']) fs.mkdirSync(path.join(root, directory), {mode: 0o700});
  for (const group of ['chromium', 'management']) {
    fs.symlinkSync(path.join(packageRoot, 'build/routes', group), path.join(routes, group), 'dir');
  }
  const log = fs.openSync(path.join(root, 'service.log'), 'wx', 0o600);
  try {
    service = spawn(node, [path.join(packageRoot, 'build/index.js')], {
      cwd: packageRoot, stdio: ['ignore', log, log],
      env: {...process.env, HOST: '127.0.0.1', PORT: String(port), TOKEN: token,
        STRICT_TOKEN_USE: 'true', CONCURRENT: '3', QUEUED: '0', TIMEOUT: '110000', ROUTES: routes,
        MAX_CPU_PERCENT: '100', MAX_MEMORY_PERCENT: '100', DEBUG: 'browserless*',
        DATA_DIR: path.join(root, 'data'), DOWNLOAD_DIR: path.join(root, 'downloads'),
        SCRATCH_DIR: path.join(root, 'scratch'), METRICS_JSON_PATH: path.join(root, 'metrics.json')}});
  } finally { fs.closeSync(log); }
  const readyDeadline = performance.now() + 20000;
  while (true) {
    if (service.exitCode !== null) throw new Error('browserless_service_start_failed');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/pressure`, {
        headers: {Authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(1000)});
      if (response.status === 200) break;
    } catch { /* The owned service has not bound its port yet. */ }
    if (performance.now() >= readyDeadline) throw new Error('browserless_service_start_deadline');
    await pause(100);
  }
  const endpoint = `http://127.0.0.1:${port}/chromium?token=${token}`;
  // This client stands for an unrelated project outside Treadway ownership.
  sentinel = makeCdpClient(await connectEndpoint(endpoint));
  const sentinelContext = (await sentinel.send('Target.createBrowserContext')).browserContextId;
  const sentinelTarget = (await sentinel.send('Target.createTarget', {url: 'about:blank', browserContextId: sentinelContext})).targetId;
  const sentinelSession = (await sentinel.send('Target.attachToTarget', {targetId: sentinelTarget, flatten: true})).sessionId;
  await sentinel.send('Runtime.evaluate', {expression: 'globalThis.sentinel="unrelated"'}, {sessionId: sentinelSession});
  const handles = [];
  for (const project of ['project-a', 'project-b']) {
    const worker = new BrowserWorker({root: path.join(root, project), projectId: project, runId: 'run-one', acquireMs: 20000});
    workers.push(worker); await worker.start();
    const {connection} = await worker.acquire({actor: 'member', endpoint});
    handles.push(connection);
    const session = await connectSession(connection); sessions.push(session);
    await session.navigate(origin);
    assert.equal(await session.eval('localStorage.length'), 0);
    assert.equal((await session.cdp.send('Storage.getCookies')).cookies.length, 0);
    await session.eval(`localStorage.setItem('project', ${JSON.stringify(project)}); document.cookie='project=${project}; Path=/'`);
  }
  const extra = new BrowserWorker({root: path.join(root, 'capacity'), projectId: 'project-c', runId: 'run-one', acquireMs: 3000});
  workers.push(extra); await extra.start();
  await assert.rejects(extra.acquire({actor: 'member', endpoint}), error => error.status === 429);
  const first = sessions[0];
  await assert.rejects(first.cdp.send('Runtime.evaluate', {
    expression: `fetch('/save',{method:'POST'}).then(()=>new Promise(()=>{}))`, awaitPromise: true, returnByValue: true},
    {timeoutMs: 300}), /unknown|timed out|remote_command_incomplete/);
  const observedDeadline = performance.now() + 3000;
  while (!requests.length && performance.now() < observedDeadline) await pause(10);
  assert.deepEqual(requests, ['saved']);
  first.close(); await pause(100);
  await assert.rejects(connectSession(handles[0]), /remote_reconciliation_required/);
  assert.equal(await sessions[1].eval('localStorage.getItem("project")'), 'project-b');
  assert.equal((await sessions[1].cdp.send('Storage.getCookies')).cookies[0].value, 'project-b');
  const cleanup = await workers[0].release(handles[0]);
  assert.equal(cleanup.contextDisposed, true);
  assert.equal(await sessions[1].eval('localStorage.getItem("project")'), 'project-b');
  assert.equal((await sentinel.send('Runtime.evaluate', {expression: 'globalThis.sentinel', returnByValue: true},
    {sessionId: sentinelSession})).result.value, 'unrelated');
  assert.deepEqual(requests, ['saved']);
  completed = true;
});
