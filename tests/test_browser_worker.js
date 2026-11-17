const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {execFile} = require('node:child_process');
const {BrowserWorker} = require('../src/treadway/browser/browser-worker');
const {connectSession, observeSession} = require('../src/treadway/browser/connection');
const {connectWorker} = require('../src/treadway/browser/worker-client');
const {protocolFixture} = require('./remote-protocol-fixture');

async function owner(t, projectId = 'project-a', runId = 'run-one', options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-worker-'));
  const worker = new BrowserWorker({root, projectId, runId, ...options});
  await worker.start();
  t.after(async () => { await worker.shutdown(); fs.rmSync(root, {recursive: true, force: true}); });
  return worker;
}
async function operationProcess(connection, expression) {
  const code = `const {connectSession}=require('./src/treadway/browser/connection');
    let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{
      const value=JSON.parse(input);let s;try{s=await connectSession(value.connection);console.log(JSON.stringify(await s.eval(value.expression)));}
      finally{s?.close();}});`;
  // The descriptor is private stdin, never a command argument.
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['-e', code], {cwd: path.resolve(__dirname, '..'), timeout: 10000},
      (error, stdout, stderr) => error ? reject(new Error(stderr || 'operation process failed')) : resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({connection, expression}));
  });
}

test('passive construction; two subprocess operations retain one upstream browser and page', async t => {
  const fixture = await protocolFixture(t);
  const worker = await owner(t);
  assert.equal(fixture.browsers.length, 0);
  const {connection} = await worker.acquire({actor: 'creator', endpoint: fixture.endpoint});
  assert.equal(await operationProcess(connection, 'save:first value'), true);
  assert.equal(await operationProcess(connection, 'read'), 'first value');
  assert.equal(fixture.browsers.length, 1);
  assert.equal(fixture.seen.filter(item => item.method === 'Target.createTarget').length, 1);
  assert.deepEqual(fixture.writes, ['first value']);
  assert.equal(fs.statSync(worker.capabilityPath).mode & 0o077, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(worker.root, 'events.jsonl'), 'utf8'), /synthetic|first value/);
});

test('two projects and simultaneous runs of the same project/actor share no state or cleanup', async t => {
  const fixture = await protocolFixture(t);
  const workers = await Promise.all([owner(t, 'project-a', 'one'), owner(t, 'project-a', 'two'), owner(t, 'project-b', 'one')]);
  const handles = await Promise.all(workers.map(w => w.acquire({actor: 'creator', endpoint: fixture.endpoint})));
  for (let i = 0; i < handles.length; i++) {
    assert.equal(await operationProcess(handles[i].connection, 'read'), '');
    await operationProcess(handles[i].connection, 'save:run-'+i);
  }
  assert.equal(fixture.browsers.length, 3);
  const cleanup = await workers[0].release(handles[0].connection);
  assert.equal(cleanup.contextDisposed, true);
  assert.equal(await operationProcess(handles[1].connection, 'read'), 'run-1');
  assert.equal(await operationProcess(handles[2].connection, 'read'), 'run-2');
  assert.equal(fixture.seen.some(item => item.method === 'Browser.close'), false);
  await assert.rejects(connectSession({...handles[1].connection, projectId: 'project-b'}), /remote_binding_differs/);
  await assert.rejects(connectSession({...handles[1].connection, generation: 'stale'}), /remote_generation_differs/);
});

test('cookie commands are bound to the owned context and foreign contexts/global methods are refused', async t => {
  const fixture = await protocolFixture(t), worker = await owner(t);
  const {connection} = await worker.acquire({actor: 'creator', endpoint: fixture.endpoint});
  const session = await connectSession(connection);
  t.after(() => session.close());
  assert.deepEqual(await session.cdp.send('Storage.getCookies'), {cookies: []});
  await session.cdp.send('Storage.setCookies', {cookies: [{name: 'fixture', value: 'own'}]});
  assert.deepEqual(await session.cdp.send('Storage.getCookies'), {cookies: [{name: 'fixture', value: 'own'}]});
  await assert.rejects(session.cdp.send('Storage.getCookies', {browserContextId: 'foreign'}), /remote_context_differs/);
  await assert.rejects(session.cdp.send('Browser.close'), /remote_method_unsupported/);
  await assert.rejects(session.cdp.send('Network.clearBrowserCookies'), /remote_method_unsupported/);
  assert.equal(fixture.seen.some(item => item.params.browserContextId === 'foreign'), false);
});

test('a lost mutation reply is recorded once and quarantines subsequent operation clients', async t => {
  const fixture = await protocolFixture(t), worker = await owner(t);
  const {connection} = await worker.acquire({actor: 'creator', endpoint: fixture.endpoint});
  const session = await connectSession(connection, {commandTimeoutMs: 500});
  await assert.rejects(session.cdp.send('Runtime.evaluate', {expression: 'lose-reply'}, {timeoutMs: 50}), /unknown|timed out/);
  session.close();
  await new Promise(r => setTimeout(r, 80));
  await assert.rejects(connectSession(connection), /remote_reconciliation_required/);
  assert.deepEqual(fixture.writes, ['committed']);
  assert.match(fs.readFileSync(path.join(worker.root, 'events.jsonl'), 'utf8'), /command_unknown/);
  const unknown = worker.inspect(connection).commands.filter(command => command.outcome === 'unknown');
  assert.equal(unknown.length, 1);
  const observation = await observeSession(connection);
  assert.deepEqual(await observation.cdp.send('Storage.getCookies'), {cookies: []});
  await assert.rejects(observation.cdp.send('Runtime.evaluate', {expression: 'save:second'}),
    error => error.code === 'remote_reconciliation_required');
  observation.close();
  assert.throws(() => worker.reconcile(connection, {requestRef: unknown[0].requestRef, outcome: 'applied'}),
    /remote_reconciliation_evidence_required/);
  const reconciled = worker.reconcile(connection, {requestRef: unknown[0].requestRef, outcome: 'applied',
    evidence: {reference: 'synthetic-application-observation', sha256: '0'.repeat(64)}});
  assert.equal(reconciled.recorded, true);
  assert.equal(reconciled.reconciliationRequired, true);
  assert.equal(worker.inspect(connection).commands.find(command => command.requestRef === unknown[0].requestRef)
    .reconciliation.outcome, 'applied');
  await assert.rejects(connectSession(connection), /remote_reconciliation_required/);
  assert.deepEqual(fixture.writes, ['committed']);
});

test('duplicate IPC request IDs return retained replies without repeating a mutation', async t => {
  const fixture = await protocolFixture(t), worker = await owner(t);
  const {connection} = await worker.acquire({actor: 'creator', endpoint: fixture.endpoint});
  const channel = await connectWorker(connection); t.after(() => channel.close());
  const command = {id: 1, method: 'Runtime.evaluate', params: {expression: 'save:one'}};
  async function send(value) { const reply = once(channel, 'message'); channel.send(JSON.stringify(value)); return JSON.parse((await reply)[0]); }
  const first = await send(command), second = await send(command);
  assert.deepEqual(second, first);
  assert.deepEqual(fixture.writes, ['one']);
  assert.equal((await send({...command, params: {expression: 'save:two'}})).error.code, 'ipc_request_conflict');
  assert.deepEqual(fixture.writes, ['one']);
});

test('capacity refusal and unavailable context isolation fail without selecting default state', async t => {
  const fixture = await protocolFixture(t, {capacity: 1}), a = await owner(t), b = await owner(t, 'project-b');
  const {connection} = await a.acquire({actor: 'creator', endpoint: fixture.endpoint});
  await assert.rejects(b.acquire({actor: 'creator', endpoint: fixture.endpoint}), error => error.status === 429);
  assert.equal(await operationProcess(connection, 'read'), '');
  const unsupported = await protocolFixture(t, {contextSupport: false}), c = await owner(t, 'project-c');
  await assert.rejects(c.acquire({actor: 'creator', endpoint: unsupported.endpoint}), /remote_acquisition_incomplete/);
  assert.equal(unsupported.seen.some(item => item.method === 'Target.createTarget'), false);
});
