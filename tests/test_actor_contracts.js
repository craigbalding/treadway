const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const path=require('node:path');
const {ActorBrowser}=require(path.join(process.env.FORM_BROWSER_MODULE_ROOT || path.join(__dirname,'../src/treadway/browser'),'actors.js'));
function fixture(principal='user-a',responder=null) {
  const requests=[];
  const session={cdp:{send:async(method,params)=>{
    const context={location:{origin:'http://fixture.invalid'},AbortController,setTimeout,clearTimeout,TextDecoder,Uint8Array,
      fetch:async(path,options)=>{
        requests.push({path,options});
        if(responder)return responder(path,options);
        return new Response(JSON.stringify(path==='/session'?{principal}:{error:'self_approval'}),{status:path==='/session'?200:403});
      }};
    return {result:{value:await vm.runInNewContext(params.expression,context)}};
  }}};
  return {requests,browser:new ActorBrowser(session,{name:'a',generation:'generation',origin:'http://fixture.invalid',probe:'/session',expected:{principal:'user-a'}})};
}
test('a correct actor can deliberately submit an unauthorized action once',async()=>{
  const {browser,requests}=fixture();
  const result=await browser.request('/approve',{method:'POST',body:{id:'known',revision:1}});
  assert.equal(result.status,403);assert.equal(result.complete,true);assert.equal(result.dispatched,true);
  assert.deepEqual(requests.map(r=>r.path),['/session','/approve']);
});
test('wrong or absent actual principal stops dispatch without renewal',async()=>{
  for(const principal of ['user-b',null]) {
    const {browser,requests}=fixture(principal);
    await assert.rejects(browser.request('/approve',{method:'POST'}),error=>error.observation.dispatched===false);
    assert.equal(requests.length,1);
  }
});
test('credential-bearing requests cannot leave the declared origin',async()=>{
  const {browser,requests}=fixture();
  for(const path of ['https://other.invalid/a','//other.invalid/a','/\\other.invalid/a'])
    await assert.rejects(browser.request(path),/same_origin/);
  assert.equal(requests.length,0);
});
test('truncated responses remain incomplete rather than proving denial',async()=>{
  const {browser}=fixture();browser.maxBodyBytes=1;
  const result=await browser.request('/approve',{verify:false});
  assert.equal(result.complete,false);assert.equal(result.bodyTruncated,true);
});

test('failed principal probe retains phase, response and identity distinction',async()=>{
  for(const [principal,state] of [['user-b','wrong'],[null,'unknown']]) {
    const {browser}=fixture(principal);
    await assert.rejects(browser.request('/approve',{method:'POST'}),error=>{
      assert.equal(error.observation.phase,'probe');
      assert.equal(error.observation.principalState,state);
      assert.equal(error.observation.probeObservation.status,200);
      assert.equal(error.observation.probeObservation.body.principal,principal);
      return error.observation.dispatched===false;
    });
  }
});

test('401 headers and partial body survive a principal-probe body deadline',async()=>{
  const {browser,requests}=fixture('user-a',(path,options)=>new Response(new ReadableStream({start(controller){
    controller.enqueue(new TextEncoder().encode('{"error":"expired"'));
    options.signal.addEventListener('abort',()=>controller.error(new DOMException('stalled','AbortError')));
  }}),{status:401}));
  await assert.rejects(browser.request('/approve',{method:'POST',timeoutMs:20}),error=>{
    const observation=error.observation;
    assert.equal(observation.dispatched,false);
    assert.equal(observation.probeObservation.status,401);
    assert.equal(observation.probeObservation.complete,false);
    assert.equal(observation.probeObservation.text,'{"error":"expired"');
    return true;
  });
  assert.equal(requests.length,1);
});

test('wrong identity dominates absent fields regardless of expectation order',async()=>{
  for(const expected of [{'tenant.id':'tenant','user.id':'expected'},{'user.id':'expected','tenant.id':'tenant'}]) {
    const {browser,requests}=fixture(null,()=>new Response(JSON.stringify({user:{id:'other'}})));
    browser.expected=expected;
    await assert.rejects(browser.request('/approve',{method:'POST'}),error=>{
      assert.equal(error.observation.principalState,'wrong');return true;
    });
    assert.equal(requests.length,1);
  }
});
