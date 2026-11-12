const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { makeCdpClient, connect } = require('../src/treadway/browser/cdp.js');

class Socket extends EventEmitter {
  constructor() { super(); this.sent = []; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.emit('close'); }
  reply(id, result) { this.emit('message', JSON.stringify({ id, result })); }
}

test('a silent browser command times out once without retry or leaking inputs', async () => {
  const ws = new Socket();
  const cdp = makeCdpClient(ws, { commandTimeoutMs: 15 });
  await assert.rejects(cdp.send('Runtime.evaluate', { expression: 'private-input' }), error => {
    assert.equal(error.code, 'CDP_COMMAND_TIMEOUT');
    assert.equal(error.outcome, 'unknown');
    assert.equal(error.method, 'Runtime.evaluate');
    assert.equal(error.message.includes('private-input'), false);
    return true;
  });
  assert.equal(ws.sent.length, 1);
  cdp.close();
});

test('a late mutation reply cannot satisfy a subsequent observation', async () => {
  const ws = new Socket();
  const cdp = makeCdpClient(ws, { commandTimeoutMs: 1000 });
  await assert.rejects(cdp.send('Runtime.evaluate', {}, { timeoutMs: 10 }), /outcome unknown/);
  const observed = cdp.send('Page.getFrameTree');
  ws.reply(ws.sent[0].id, { stale: true });
  ws.reply(ws.sent[1].id, { frameTree: 'current-observation' });
  assert.deepEqual(await observed, { frameTree: 'current-observation' });
  assert.equal(ws.sent.length, 2);
  cdp.close();
});

test('socket closure promptly rejects pending commands and prevents a new send', async () => {
  const ws = new Socket();
  const cdp = makeCdpClient(ws);
  const result = cdp.send('Page.enable');
  const rejection = assert.rejects(result, /socket closed.*outcome unknown/);
  ws.close();
  await rejection;
  await assert.rejects(cdp.send('Runtime.enable'), /command not sent/);
  assert.equal(ws.sent.length, 1);
});

test('socket errors and explicit client close reject commands rather than hanging', async () => {
  for (const event of ['error', 'client-close']) {
    const ws = new Socket();
    const cdp = makeCdpClient(ws);
    const rejection = assert.rejects(cdp.send('Network.enable'), /outcome unknown/);
    if (event === 'error') ws.emit('error', new Error('offline'));
    else cdp.close();
    await rejection;
  }
});

test('normal replies and protocol errors retain their original semantics', async () => {
  const ws = new Socket();
  const cdp = makeCdpClient(ws);
  const success = cdp.send('Page.enable');
  ws.reply(ws.sent[0].id, { enabled: true });
  assert.deepEqual(await success, { enabled: true });
  const rejected = assert.rejects(cdp.send('Missing.command'), /CDP -32601: Method not found/);
  ws.emit('message', JSON.stringify({ id: ws.sent[1].id, error: { code: -32601, message: 'Method not found' } }));
  await rejected;
  cdp.close();
});

test('invalid or unbounded deadlines are rejected before transport', async () => {
  for (const commandTimeoutMs of [0, -1, Infinity, '30']) {
    assert.throws(() => makeCdpClient(new Socket(), { commandTimeoutMs }), /positive integer/);
  }
  const ws = new Socket();
  const cdp = makeCdpClient(ws);
  await assert.rejects(cdp.send('Page.enable', {}, { timeoutMs: 0 }), /positive integer/);
  assert.equal(ws.sent.length, 0);
  cdp.close();
});

test('a wedged domain-enable handshake closes its socket without retrying', async () => {
  const ws = new Socket();
  const proxy = {
    listTargets: async () => [{ id: 'bound-page', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/bound-page' }],
    cdpConnect: async () => ws,
  };
  await assert.rejects(connect(proxy, 'bound-page', { commandTimeoutMs: 10 }), /Page.enable.*outcome unknown/);
  assert.equal(ws.closed, true);
  assert.deepEqual(ws.sent.map(item => item.method), ['Page.enable']);
});

test('malformed protocol closes transport, rejects pending work and refuses reuse', async () => {
  for (const message of ['{broken', 'null', '[]', '{"id":1}']) {
    const ws = new Socket(), cdp = makeCdpClient(ws);
    const rejected = assert.rejects(cdp.send('Page.enable'), /Malformed CDP/);
    ws.emit('message', message);
    await rejected;
    assert.equal(ws.closed, true);
    await assert.rejects(cdp.send('Page.enable'), /closed/);
  }
});

test('observer initialization exception closes the socket', async () => {
  const ws = new Socket();
  ws.send = raw => { const msg = JSON.parse(raw); queueMicrotask(() => ws.reply(msg.id,
    msg.method === 'Runtime.evaluate' ? {exceptionDetails:{text:'fixture failed'}} : {})); };
  const proxy = {
    listTargets: async () => [{id:'bound-page',type:'page',webSocketDebuggerUrl:'ws://ignored/devtools/page/bound-page'}],
    cdpConnect: async () => ws,
  };
  await assert.rejects(connect(proxy, 'bound-page'), /initialization failed/);
  assert.equal(ws.closed, true);
});

test('missing, duplicate and mismatched page targets never connect', async () => {
  const page = {id:'bound-page',type:'page',webSocketDebuggerUrl:'ws://ignored/devtools/page/bound-page'};
  for (const targets of [[], [page,page], [{...page, webSocketDebuggerUrl:'ws://ignored/devtools/page/other'}]]) {
    await assert.rejects(connect({ listTargets: async()=>targets, cdpConnect:()=>{throw new Error('unexpected connect');} }, 'bound-page'),
      error => !error.message.includes('unexpected connect'));
  }
});

test('event waits have deadlines and reject promptly on disconnect', async () => {
  const ws = new Socket(), cdp = makeCdpClient(ws, {commandTimeoutMs:15});
  await assert.rejects(cdp.once('Page.loadEventFired'), /deadline/);
  const rejected = assert.rejects(cdp.once('Page.loadEventFired'), /closed/);
  cdp.close(); await rejected;
});

test('failed focus never sends keys to a previously focused field', async()=>{
  const {typeText}=require('../src/treadway/browser/cdp');
  const methods=[];
  await assert.rejects(typeText({send:async method=>{methods.push(method);return {exceptionDetails:{text:'missing field'}};}}, '#missing', 'fixture text'),/Focus failed/);
  assert.deepEqual(methods,['Runtime.evaluate']);
});

test('route observation rejects lost transport and succeeds on actual URL', async()=>{
  const {waitForRoute}=require('../src/treadway/browser/cdp');
  await assert.rejects(waitForRoute({send:async()=>{throw new Error('fixture disconnect');}},[],'/done',40),/disconnect/);
  const found=await waitForRoute({send:async()=>({result:{value:'http://fixture/done'}})},[],'/done',40);
  assert.equal(found.matched,true);
});

test('network idle waits for bodies and removes all listeners', async()=>{
  const {waitForNetworkIdle}=require('../src/treadway/browser/cdp');
  const cdp=new EventEmitter();
  const waiting=waitForNetworkIdle(cdp,150,20);
  cdp.emit('Network.requestWillBeSent',{requestId:'fixture'});
  cdp.emit('Network.requestWillBeSent',{requestId:'fixture'}); // redirect uses same ID
  cdp.emit('Network.responseReceived',{requestId:'fixture'});
  setTimeout(()=>cdp.emit('Network.loadingFinished',{requestId:'fixture'}),40);
  const started=Date.now(), result=await waiting;
  assert.ok(Date.now()-started>=40);
  assert.equal(result.idle,true);
  assert.deepEqual(cdp.eventNames(),[]);
});
