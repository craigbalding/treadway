'use strict';
// Opt-in real service acceptance. Supply an isolated service owned by this test run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const browserRoot = process.env.FORM_BROWSER_MODULE_ROOT || path.join(__dirname,'../src/treadway/browser');
const {BrowserWorker} = require(path.join(browserRoot,'browser-worker'));
const {connectSession,observeSession} = require(path.join(browserRoot,'connection'));
const endpoint = process.env.BROWSERSERVE_TEST_ENDPOINT;
const token = process.env.BROWSERSERVE_TOKEN;
const pause = ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=5000) {
  const deadline=performance.now()+ms;
  while(!await check()) { assert.ok(performance.now()<deadline,'observation deadline'); await pause(10); }
}
test('native Browserserve: exact live state, concurrent projects, refusal, uncertain writes and immediate cleanup',
  {skip:!endpoint || !token,timeout:process.env.TREADWAY_SERVICE_PYTHON ? 180000 : 90000},async t=>{
  const root=fs.mkdtempSync(path.join(process.env.BROWSERSERVE_EVIDENCE_ROOT || os.tmpdir(),'tw-bs-adapter-'));
  const workers=[],sessions=[]; let completed=false; const writes=[];
  const app=http.createServer((req,res)=>{
    if(req.url==='/principal') {
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({principal:req.headers.cookie?.match(/principal=([^;]+)/)?.[1]||null}));return;
    }
    if(req.url==='/write' && req.method==='POST') {writes.push('committed');return;}
    const user=new URL(req.url,'http://fixture.invalid').searchParams.get('user');
    res.writeHead(200,{'Content-Type':'text/html',...(user?{'Set-Cookie':`principal=${user}; Path=/; HttpOnly; SameSite=Lax`}:{})});
    res.end('<!doctype html><title>Synthetic workboard</title><label>Draft<input id="draft"></label>');
  });
  t.after(async()=>{
    for(const s of sessions)s.close();
    for(const worker of workers)await worker.shutdown();
    app.closeAllConnections();await new Promise(r=>app.close(r));
    // Retain success and failure evidence for the service-controller artifact export.
    fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify({completed,writes}),{mode:0o600});
    t.diagnostic('Private service evidence: '+root);
  });
  app.listen(0,'127.0.0.1');await once(app,'listening');
  const origin=`http://127.0.0.1:${app.address().port}`;
  const principal=user=>({origin,probe:'/principal',expected:{principal:user}});
  const headers={Authorization:'Bearer '+token};
  async function pressure(){const url=new URL(endpoint);url.protocol=url.protocol==='wss:'?'https:':'http:';url.pathname='/pressure';url.search='';return (await fetch(url,{headers})).json();}
  const started=performance.now();
  await until(async()=>{try{return (await pressure()).isAvailable;}catch{return false;}},15000);
  assert.equal((await pressure()).sandbox,'on (required)');
  for(const project of ['project-a','project-b']) {
    const w=new BrowserWorker({root:path.join(root,project),projectId:project,runId:'run-one',sessionMs:60000});
    workers.push(w);await w.start();
  }
  const handles=[];
  for(const [worker,name,user] of [[workers[0],'member','author'],[workers[0],'reviewer','reviewer'],[workers[1],'member','other']]) {
    const {connection,capabilities}=await worker.acquire({actor:name,provider:'browserserve',endpoint,headers});
    assert.equal(capabilities.reconnect,true);handles.push({worker,connection,user});
    const s=await connectSession(connection);sessions.push(s);await s.navigate(origin+'/?user='+user);
    await s.eval(`globalThis.liveNonce=crypto.randomUUID();document.querySelector('#draft').value='unsaved-${user}';localStorage.owner='${user}';sessionStorage.owner='${user}'`);
    await s.eval(`new Promise((resolve,reject)=>{const r=indexedDB.open('drafts',1);r.onupgradeneeded=()=>r.result.createObjectStore('items');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const tx=r.result.transaction('items','readwrite');tx.objectStore('items').put('${user}','owner');tx.oncomplete=()=>{r.result.close();resolve(true);};};})`);
    s.close();await until(()=>!worker.actors.get(name).client);
  }
  async function state(item,shot){
    const s=await connectSession(item.connection);sessions.push(s);
    try{
      const value=await s.eval(`(async()=>({nonce:liveNonce,draft:document.querySelector('#draft').value,local:localStorage.owner,session:sessionStorage.owner,principal:await(await fetch('/principal')).json(),indexed:await new Promise(resolve=>{const r=indexedDB.open('drafts');r.onsuccess=()=>{const db=r.result;const q=db.transaction('items').objectStore('items').get('owner');q.onsuccess=()=>{db.close();resolve(q.result);};};})}))()`);
      if(shot)fs.writeFileSync(path.join(root,shot+'.png'),Buffer.from((await s.cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'),{mode:0o600});
      return value;
    } finally{s.close();await until(()=>!item.worker.actors.get(item.connection.actor).client);}
  }
  const [a,b,c]=handles; const before=await state(a,'before');
  assert.equal((await state(b)).principal.principal,'reviewer');assert.equal((await state(c)).principal.principal,'other');
  const pid=async item=>(await item.worker.actors.get(item.connection.actor).cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser').id;
  const beforePid=await pid(a);assert.notEqual(beforePid,await pid(b));assert.notEqual(beforePid,await pid(c));
  const chromeArgs=fs.readFileSync(`/proc/${beforePid}/cmdline`,'utf8');assert.ok(!chromeArgs.split('\0').includes('--no-sandbox'));
  await assert.rejects(workers[1].acquire({actor:'overflow',provider:'browserserve',endpoint,headers}),e=>e.status===503);
  const times=[];
  for(let i=0;i<2;i++){
    // Last client really disappears. No keeper socket is attached to this browser.
    a.worker.actors.get('member').ws.terminate();
    await until(()=>a.worker.inspect(a.connection).state==='transport_lost');
    await until(async()=>(await pressure()).parked===1);
    const start=performance.now();const restored=await a.worker.reconnect(a.connection,{principal:principal('author')});
    assert.equal(restored.generation,a.connection.generation);assert.equal(restored.reconciliationRequired,false);
    assert.deepEqual(await state(a,'resumed-'+i),before);assert.equal(await pid(a),beforePid);
    times.push(Math.round(performance.now()-start));assert.equal((await state(c)).principal.principal,'other');
  }
  // The synthetic app observes a write and deliberately withholds its reply.
  const s=await connectSession(a.connection);sessions.push(s);
  const lost=s.cdp.send('Runtime.evaluate',{expression:`fetch('${origin}/write',{method:'POST'}).then(r=>r.text())`,awaitPromise:true},{timeoutMs:5000}).catch(()=>null);
  await until(()=>writes.length===1);a.worker.actors.get('member').ws.terminate();await lost;s.close();
  await until(()=>!a.worker.actors.get('member').client && a.worker.inspect(a.connection).state==='transport_lost');
  await until(async()=>(await pressure()).parked===1);
  assert.equal((await a.worker.reconnect(a.connection,{principal:principal('author')})).reconciliationRequired,true);
  await assert.rejects(connectSession(a.connection),/reconciliation_required/);
  const observer=await observeSession(a.connection);await observer.cdp.send('Page.captureScreenshot',{format:'png'});observer.close();
  assert.deepEqual(writes,['committed']);assert.equal((await state(c)).principal.principal,'other');
  // Explicit release must finish provider sessions rather than park them for expiry.
  for(const item of handles){await until(()=>!item.worker.actors.get(item.connection.actor).client);const result=await item.worker.release(item.connection);assert.equal(result.providerSessionClosed,true);}
  await until(async()=>{const p=await pressure();return p.running===0 && p.parked===0;},2000);
  if(process.env.TREADWAY_SERVICE_PYTHON) {
    const result=await promisify(execFile)(process.env.TREADWAY_SERVICE_PYTHON,
      [path.join(__dirname,'browserserve-python-acceptance.py'),origin],{timeout:100000,maxBuffer:1024*1024});
    fs.writeFileSync(path.join(root,'installed-python.log'),result.stdout+result.stderr,{mode:0o600});
    await until(async()=>{const p=await pressure();return p.running===0 && p.parked===0;},2000);
  }
  completed=true;fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({passed:true,browser:'shipped service browser',reattachAndVerifyMs:times,durationMs:Math.round(performance.now()-started),finalPressure:await pressure()}),{mode:0o600});
});
