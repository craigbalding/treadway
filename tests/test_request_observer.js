'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {RequestObserver}=require('../src/treadway/browser/request-observer.js');
function fixture(options={}){
  const cdp=new EventEmitter(),records=[];
  cdp.send=async()=>({body:'{"id":8}',base64Encoded:false});
  const observer=new RequestObserver(cdp,{match:event=>event.request.method==='POST'&&new URL(event.request.url).pathname==='/items',record:r=>records.push(r),...options});
  const request=()=>cdp.emit('Network.requestWillBeSent',{requestId:'one',request:{method:'POST',url:'http://synthetic.invalid/items?private=never-recorded'}});
  const response=()=>cdp.emit('Network.responseReceived',{requestId:'one',response:{status:201,url:'http://synthetic.invalid/items?private=never-recorded'}});
  const finish=()=>cdp.emit('Network.loadingFinished',{requestId:'one'});
  return {cdp,records,observer,request,response,finish};
}
test('listeners precede exactly one dispatch and retain completed response body',async()=>{
  const f=fixture();let calls=0;
  const result=await f.observer.run(async()=>{calls++;assert.equal(f.cdp.listenerCount('Network.responseReceived'),1);f.request();f.response();f.finish();},{windowMs:1000,readBody:true});
  assert.equal(calls,1);assert.equal(result.complete,true);assert.equal(result.requests[0].body,'{"id":8}');
  assert.equal(result.applicationOutcome,'not_evaluated');assert.equal(result.completion,'unconfirmed');
  assert.equal(f.cdp.listenerCount('Network.responseReceived'),0);
  assert.equal(JSON.stringify(f.records.filter(r=>r.kind==='correlated_request')).includes('never-recorded'),false);
});
test('headers without loading completion remain incomplete and clean listeners',async()=>{
  const f=fixture();
  const result=await f.observer.run(async()=>{f.request();f.response();},{windowMs:20});
  assert.equal(result.complete,false);assert.equal(result.requests[0].status,201);assert.equal(f.cdp.listenerCount('Network.loadingFinished'),0);
});
test('dispatch failure can coexist with observed response without becoming action success',async()=>{
  const f=fixture();
  const result=await f.observer.run(async()=>{f.request();f.response();f.finish();throw new Error('runner failed after dispatch');},{windowMs:100});
  assert.equal(result.complete,true);assert.equal(result.action.returned,false);assert.match(result.action.reason,/runner failed/);
});
test('loading failure remains incomplete even after response headers',async()=>{
  const f=fixture();
  const result=await f.observer.run(async()=>{f.request();f.response();f.cdp.emit('Network.loadingFailed',{requestId:'one',errorText:'net::ERR_ABORTED'});},{windowMs:100});
  assert.equal(result.complete,false);assert.equal(result.requests[0].status,201);
});
test('redirect with the same request ID cannot silently replace the target',async()=>{
  const f=fixture();
  const result=await f.observer.run(async()=>{f.request();f.cdp.emit('Network.requestWillBeSent',{requestId:'one',request:{method:'GET',url:'http://elsewhere.invalid/'}});f.response();f.finish();},{windowMs:100});
  assert.equal(result.complete,false);assert.equal(result.requests[0].redirected,true);
});
test('truncated body preserves status and cannot establish complete observation',async()=>{
  const f=fixture({maxBodyBytes:3});
  const result=await f.observer.run(async()=>{f.request();f.response();f.finish();},{windowMs:100,readBody:true});
  assert.equal(result.complete,false);assert.equal(result.requests[0].status,201);assert.equal(result.requests[0].bodyTruncated,true);
});
test('matching failure is retained and never escapes an event callback or leaks listeners',async()=>{
  const f=fixture({match:()=>{throw new Error('invalid matcher input');}});
  const result=await f.observer.run(async()=>f.request(),{windowMs:100});
  assert.equal(result.complete,false);assert.equal(result.captureError,'invalid matcher input');assert.equal(f.cdp.eventNames().length,0);
});
test('partial listener setup failure cleans every listener before dispatch',async()=>{
  const f=fixture(),on=f.cdp.on.bind(f.cdp);let dispatched=false;
  f.cdp.on=(type,listener)=>{on(type,listener);if(type==='Network.responseReceived')throw new Error('listener setup failed');return f.cdp;};
  await assert.rejects(f.observer.run(async()=>{dispatched=true;},{windowMs:100}),/listener setup failed/);
  assert.equal(dispatched,false);assert.deepEqual(f.cdp.eventNames(),[]);
});
test('response-result recording failure preserves evidence and blocks a complete result',async()=>{
  const f=fixture({record:record=>{if(record.kind==='request_observation_result')throw new Error('journal full');}});
  const result=await f.observer.run(async()=>{f.request();f.response();f.finish();},{windowMs:100});
  assert.equal(result.complete,false);assert.equal(result.recordStatus,'result_write_failed');assert.equal(result.requests[0].status,201);assert.deepEqual(f.cdp.eventNames(),[]);
});
