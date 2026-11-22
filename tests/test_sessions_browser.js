const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {widgetFixture,browserRoot}=require('./browser-fixture.js');
const {BrowserInteractions}=require(path.join(browserRoot,'interactions.js'));
const {OriginState}=require(path.join(browserRoot,'state.js'));
const {connectBrowser,TargetMonitor}=require(path.join(browserRoot,'targets.js'));
const {createCdpProxy}=require(path.join(browserRoot,'cdp.js'));
const {ActorBrowser}=require(path.join(browserRoot,'actors.js'));
test('default actor budgets retain a large page and stop after session expiry in Chromium',
  {skip:!process.env.CHROME_BIN,timeout:45000},async t=>{
    const body='<html>'+'x'.repeat(2*1024*1024)+'</html>',calls=[];
    let expired=false;
    const fixture=await widgetFixture('react',{handleRequest:(request,response,url)=>{
      if(!['/principal','/large-page'].includes(url.pathname))return false;
      calls.push(url.pathname);
      response.writeHead(url.pathname==='/principal'&&expired?401:200,
        {'Content-Type':url.pathname==='/principal'?'application/json':'text/html'});
      response.end(url.pathname==='/principal'?JSON.stringify({principal:expired?null:'member'}):body);
      return true;
    }});
    let complete=false;
    t.after(async()=>{await fixture.close({preserveEvidence:!complete});});
    await fixture.session.navigate(fixture.origin);
    const actor=new ActorBrowser(fixture.session,{name:'member',origin:fixture.origin,
      generation:fixture.browserSession.generation,probe:'/principal',expected:{principal:'member'}});
    const result=await actor.request('/large-page');
    assert.equal(result.complete,true);assert.equal(result.bodyTruncated,false);
    assert.equal(result.text,body);
    expired=true;
    await assert.rejects(actor.request('/large-page'),error=>error.observation.dispatched===false);
    assert.deepEqual(calls,['/principal','/large-page','/principal']);
    complete=true;
  });
test('real origin state and worker capture use an owned sandboxed browser',{skip:!process.env.CHROME_BIN,timeout:20000},async t=>{
  const fixture=await widgetFixture('react');
  const ui=new BrowserInteractions(fixture.session,{origin:fixture.origin,record:()=>{}});
  let complete=false;
  let root,monitor;
  t.after(async()=>{try{if(monitor)await monitor.close();}finally{root?.close();ui.dispose();await fixture.close({preserveEvidence:!complete});if(!complete)t.diagnostic('Retained synthetic failure evidence: '+fixture.root);}});
  await ui.navigate(fixture.origin);
  await ui.evaluate(`(async()=>{
    localStorage.setItem('fixture','synthetic');sessionStorage.setItem('fixture','synthetic');
    document.cookie='fixture=synthetic; Path=/';await caches.open('synthetic');
    await new Promise((resolve,reject)=>{const request=indexedDB.open('synthetic');request.onsuccess=()=>{request.result.close();resolve();};request.onerror=reject;});
    return true;
  })()`);
  const state=new OriginState(fixture.session,{origin:fixture.origin});
  assert.equal((await state.observe()).indexedDB,1);
  const cleared=await state.clear();assert.equal(cleared.clean,true,JSON.stringify(cleared));
  root=await connectBrowser(createCdpProxy({cdpHost:'127.0.0.1',cdpPort:fixture.cdpPort}),fixture.browserSession.browser_path);
  const records=[];
  monitor=new TargetMonitor(root,{actor:{name:'author',generation:fixture.browserSession.generation},origin:fixture.origin,record:event=>records.push(event)});
  await monitor.start();
  await ui.evaluate(`(()=>{window.syntheticWorker=new Worker(URL.createObjectURL(new Blob([
    'self.onmessage=()=>fetch('+JSON.stringify(location.origin+'/download')+').then(()=>postMessage("done"))'
  ],{type:'application/javascript'})));return true;})()`);
  await ui.wait('worker capture ready',()=>[...monitor.sessions.values()].some(entry=>entry.info.type==='worker'&&entry.ready),5000);
  await ui.evaluate('(()=>{window.syntheticWorker.postMessage("go");return true;})()');
  await ui.wait('worker request loading completed',()=>records.some(event=>event.targetType==='worker'&&event.kind==='loaded'),5000);
  assert.equal(records.some(event=>event.targetType==='worker'&&event.kind==='response'&&event.status===200),true);
  const result=await monitor.close();monitor=null;assert.equal(result.complete,true,JSON.stringify(result));
  complete=true;
});
