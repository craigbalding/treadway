const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {ActorBrowser}=require('../src/treadway/browser/actors.js');
function fixture(principal='user-a') {
  const requests=[];
  const session={cdp:{send:async(method,params)=>{
    const context={location:{origin:'http://fixture.invalid'},AbortController,setTimeout,clearTimeout,TextDecoder,Uint8Array,
      fetch:async(path,options)=>{
        requests.push({path,options});
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
