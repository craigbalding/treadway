'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {BrowserWorker} = require('../src/treadway/browser/browser-worker');
const {connectSession, observeSession} = require('../src/treadway/browser/connection');
const {protocolFixture} = require('./remote-protocol-fixture');
const principal = {origin:'https://app.example.invalid', probe:'/principal', expected:{principal:'member'}};
async function fixture(t, options = {}) {
  const service = await protocolFixture(t, {browserserve:true});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-bs-contract-'));
  const worker = new BrowserWorker({root, projectId:'project-one', runId:'run-one', ...options});
  await worker.start();
  t.after(async () => { await worker.shutdown(); fs.rmSync(root,{recursive:true,force:true}); });
  const acquire = (actor = 'member', extra = {}) => worker.acquire({actor, provider:'browserserve', endpoint:service.endpoint, ...extra});
  return {worker, service, root, acquire};
}
async function idle(worker, name='member') {
  const end=performance.now()+1000;
  while(worker.actors.get(name).client) {
    assert.ok(performance.now()<end); await new Promise(r=>setTimeout(r,1));
  }
}
test('Browserserve captures native resume at acquisition and reconnects repeatedly without preparation or replacement', async t => {
  const {worker,service,root,acquire}=await fixture(t);
  const {connection,capabilities}=await acquire();
  assert.equal(capabilities.provider,'browserserve'); assert.equal(capabilities.reconnect,true);
  assert.equal(service.seen[0].params.disposeOnDetach,false);
  const token=service.browsers[0].resumeToken;
  assert.ok(!JSON.stringify(connection).includes(token));
  for(let i=0;i<2;i++) {
    const s=await connectSession(connection); await s.eval(i ? 'read' : 'save:retained'); s.close(); await idle(worker);
    const result=await worker.reconnect(connection,{principal});
    assert.equal(result.generation,connection.generation); assert.equal(result.principalVerified,true);
    const after=await connectSession(connection); assert.equal(await after.eval('read'),'retained'); after.close(); await idle(worker);
  }
  assert.equal(service.browsers.length,1); assert.deepEqual(service.writes,['retained']);
  assert.equal(service.seen.some(x=>x.method==='Browserless.reconnect'),false);
  assert.equal(service.seen.filter(x=>x.method==='Target.createTarget').length,1);
  assert.equal(fs.readFileSync(path.join(root,'events.jsonl'),'utf8').includes(token),false);
  const files=fs.readdirSync(root).filter(x=>x.startsWith('reconnect-') && x.endsWith('.json'));
  assert.ok(files.length); for(const file of files) assert.equal(fs.statSync(path.join(root,file)).mode & 0o077,0);
  const cleanup=await worker.release(connection);
  assert.equal(cleanup.contextDisposed,true); assert.equal(cleanup.providerSessionClosed,true);
  assert.equal(service.browsers[0].ended,true); assert.equal(service.browsers[0].parked,false);
});
test('Browserserve requires a valid native capability and cleans up a refused acquisition', async t => {
  for(const header of ['missing','malformed']) {
    const {worker,service,acquire}=await fixture(t);
    if(header==='missing') service.controls.missingResumeHeader=true;
    else service.controls.resumeHeader='not-a-valid-token';
    await assert.rejects(acquire(),error=>{
      assert.match(error.message,/remote_browserserve_resume_unavailable/);
      assert.equal(error.cleanup.providerSessionClosed,false);
      assert.equal(error.cleanup.closeHandshakeObserved,true);
      return true;
    });
    assert.equal(service.seen.some(x=>x.method==='Target.createTarget'),false);
    assert.equal(service.seen.some(x=>x.method==='Browser.close'),false);
    assert.equal(service.browsers[0].closeCode,1000);
  }
});
test('native resume refuses foreign attachment/profile parameters and unsupported modes before connecting', async t => {
  const {service,acquire}=await fixture(t);
  for(const suffix of ['&resume='+'a'.repeat(64),'&profileToken=synthetic'])
    await assert.rejects(acquire('invalid',{endpoint:service.endpoint+suffix}),/remote_browserserve_endpoint_invalid/);
  await assert.rejects(acquire('borrowed',{mode:'borrowed',borrowed:{scope:'context',permission:'observe',contextId:'ctx',targetId:'page'}}),/remote_browserserve_mode_unsupported/);
  assert.equal(service.upgrades.length,0);
});
test('lost write stays unknown after native resume and neither driving nor replay is allowed', async t => {
  const {worker,service,acquire}=await fixture(t);
  const {connection}=await acquire(); const browser=await connectSession(connection);
  await assert.rejects(browser.cdp.send('Runtime.evaluate',{expression:'lose-reply'},{timeoutMs:30}));
  browser.close(); await idle(worker);
  const result=await worker.reconnect(connection,{principal}); assert.equal(result.reconciliationRequired,true);
  await assert.rejects(connectSession(connection),/reconciliation_required/);
  const observer=await observeSession(connection); await observer.cdp.send('Storage.getCookies'); observer.close();
  assert.deepEqual(service.writes,['committed']);
});
test('native refusal never launches a replacement, extends a deadline or changes another actor', async t => {
  const {worker,service,acquire}=await fixture(t);
  const {connection}=await acquire(); const {connection:other}=await acquire('other');
  const deadline=worker.actors.get('member').deadline;
  service.controls.refuseResume=true;
  await assert.rejects(worker.reconnect(connection,{principal}),e=>e.code==='remote_handshake_rejected' && e.status===404);
  assert.equal(service.browsers.length,2); assert.equal(worker.actors.get('member').deadline,deadline);
  const s=await connectSession(other); await s.eval('save:other'); s.close(); await idle(worker,'other');
  assert.deepEqual(service.writes,['other']);
});
test('changed native page or actual principal fails closed without selecting another page', async t => {
  for(const change of ['page','principal']) {
    const {worker,service,acquire}=await fixture(t); const {connection}=await acquire();
    if(change==='page') service.browsers[0].targets.delete(worker.actors.get('member').targetId);
    else service.controls.principal='someone-else';
    await assert.rejects(worker.reconnect(connection,{principal}),change==='page'?/target_context_differs/:/actual_principal_differs/);
    await assert.rejects(connectSession(connection),/session_unavailable/);
    assert.equal(service.browsers.length,1);
    assert.equal(service.seen.some(x=>x.method==='Target.getTargets'),false);
  }
});
test('a status-free Close acknowledgement ends the session; an abrupt EOF remains unconfirmed', async t=>{
  for(const abrupt of [false,true]) {
    const {worker,service,acquire}=await fixture(t); service.controls.emptyCloseAcknowledgement=true;
    const {connection}=await acquire();
    if(abrupt) {
      worker.actors.get('member').ws.terminate();
      const deadline=performance.now()+1000;
      while(worker.inspect(connection).state!=='transport_lost') {
        assert.ok(performance.now()<deadline);await new Promise(r=>setTimeout(r,1));
      }
    }
    const result=await worker.release(connection);
    assert.equal(result.providerSessionClosed,!abrupt);assert.equal(result.complete,!abrupt);
  }
});
test('definite native rejection and predispatch failure preserve the same capability for explicit retry', async t=>{
  for(const kind of ['not-yet-parked','predispatch']) {
    const {worker,service,acquire}=await fixture(t);const {connection}=await acquire();
    const actor=worker.actors.get('member');
    if(kind==='not-yet-parked')service.controls.parkDelayMs=100;
    else actor.transportOptions.proxyUrl='invalid-proxy-configuration';
    await assert.rejects(worker.reconnect(connection,{principal}),kind==='not-yet-parked'?/handshake_rejected/:/proxy_invalid/);
    assert.equal(service.upgrades.length,kind==='not-yet-parked'?2:1);
    assert.equal(actor.reconnectCapability.usable,true);
    delete actor.transportOptions.proxyUrl;
    const deadline=performance.now()+1000;
    while(!service.browsers[0].parked){assert.ok(performance.now()<deadline);await new Promise(r=>setTimeout(r,1));}
    const result=await worker.reconnect(connection,{principal});assert.equal(result.generation,connection.generation);
    assert.equal(service.browsers.length,1);
  }
});
test('missing owned-browser shutdown reply remains unconfirmed despite observed context disposal', async t=>{
  const {worker,service,acquire}=await fixture(t);const {connection}=await acquire();
  service.controls.loseProfileCloseReply=true;
  const result=await worker.release(connection);
  assert.equal(result.contextDisposed,true);assert.equal(result.providerSessionClosed,false);assert.equal(result.complete,false);
});
test('late pre-resume browser-level replies cannot become current evidence after reconnect', async t=>{
  const {worker,service,acquire}=await fixture(t);const {connection}=await acquire();
  const actor=worker.actors.get('member'), browser=service.browsers[0];
  browser.contexts.get(actor.contextId).cookies=[{name:'state',value:'OLD'}];
  let held;
  const send=browser.ws.send.bind(browser.ws);
  browser.ws.send=(data,...args)=>{
    const response=JSON.parse(data),request=service.seen.at(-1);
    if(request.method==='Storage.getCookies' && response.id===request.id){held=data;return;}
    return send(data,...args);
  };
  const first=await connectSession(connection);
  await assert.rejects(first.cdp.send('Storage.getCookies',{}, {timeoutMs:30}));first.close();await idle(worker);
  const oldId=JSON.parse(held).id;
  browser.contexts.get(actor.contextId).cookies=[{name:'state',value:'CURRENT'}];
  await worker.reconnect(connection,{principal});
  const freshSend=browser.ws.send.bind(browser.ws);let injected=false;
  browser.ws.send=(data,...args)=>{
    const response=JSON.parse(data),request=service.seen.at(-1);
    if(request.method==='Storage.getCookies' && response.id===request.id){
      assert.ok(response.id>oldId);injected=true;freshSend(held);
    }
    return freshSend(data,...args);
  };
  const observer=await observeSession(connection);
  assert.equal((await observer.cdp.send('Storage.getCookies')).cookies[0].value,'CURRENT');observer.close();
  assert.equal(injected,true);assert.equal(worker.inspect(connection).reconciliationRequired,true);
});
test('CDP sequence exhaustion refuses before the provider-reserved request range',()=>{
  const {createCommandIdSequence}=require('../src/treadway/browser/cdp');
  const next=createCommandIdSequence({maximum:2});
  assert.equal(next(),1);assert.equal(next(),2);assert.throws(()=>next(),/exhausted; command not sent/);
});
test('context disposal and owned-browser shutdown share one total cleanup budget', async t=>{
  const {worker,service,acquire}=await fixture(t,{cleanupMs:150});const {connection}=await acquire();
  const ws=service.browsers[0].ws,send=ws.send.bind(ws);
  ws.send=(data,...args)=>{
    const method=service.seen.at(-1).method;
    if(['Target.disposeBrowserContext','Browser.close'].includes(method))
      return setTimeout(()=>{if(ws.readyState===ws.OPEN)send(data,...args);},100);
    return send(data,...args);
  };
  const start=performance.now(),result=await worker.release(connection);
  assert.equal(result.complete,false);assert.equal(result.contextDisposed,true);assert.equal(result.providerSessionClosed,false);
  assert.ok(performance.now()-start<240,'release restarted the full budget for a later phase');
});
