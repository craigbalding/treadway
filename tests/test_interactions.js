'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {BrowserInteractions,waitForObservation}=require('../src/treadway/browser/interactions.js');
const {FormAssessor}=require('../src/treadway/browser/form-assessor.js');

test('read-only wait retains a command timeout then can establish readiness',async()=>{
  const records=[];let attempts=0;
  const result=await waitForObservation('synthetic readiness',async()=>{
    if(++attempts===1){const error=new Error('deadline');error.code='CDP_COMMAND_TIMEOUT';throw error;}
    return {ready:true};
  },{windowMs:1000,intervalMs:1,record:r=>records.push(r)});
  assert.equal(result.ready,true);assert.equal(attempts,2);
  assert.equal(records[0].reason,'command_timeout_outcome_unknown');
});
test('semantic errors are terminal and cannot become an observation retry',async()=>{
  let calls=0;
  await assert.rejects(waitForObservation('principal',async()=>{calls++;throw new Error('wrong_principal');},{windowMs:100}),/wrong_principal/);
  assert.equal(calls,1);
});
test('a disposed form releases only its own listeners',()=>{
  const cdp=new EventEmitter();let foreignEvents=0;
  cdp.on('Network.responseReceived',()=>foreignEvents++);
  const form=new FormAssessor({cdp});
  assert.equal(cdp.listenerCount('Network.responseReceived'),2);
  form.dispose();form.dispose();
  cdp.emit('Network.responseReceived',{});
  assert.equal(cdp.listenerCount('Network.responseReceived'),1);assert.equal(foreignEvents,1);
});
test('constructing the shared browser interface never sends a command',()=>{
  const cdp=new EventEmitter();cdp.send=()=>{throw new Error('constructor contacted browser');};
  const ui=new BrowserInteractions({cdp},{origin:'http://synthetic.invalid'});
  ui.dispose();
});
test('hover sends movement only, after a durable intent',async()=>{
  const calls=[];
  const cdp=new EventEmitter();cdp.send=async(method,args)=>calls.push({method,args});
  const ui=new BrowserInteractions({cdp},{origin:'http://synthetic.invalid',record:()=>calls.push('intent')});
  ui.form.locate=async()=>({item:{ref:'known'}});ui.form.preparePointer=async()=>({x:3,y:4});
  await ui.hover('#known',{source:'explicit synthetic hover'});
  assert.equal(calls[0],'intent');assert.deepEqual(calls[1],{method:'Input.dispatchMouseEvent',args:{type:'mouseMoved',x:3,y:4}});
  assert.equal(calls.length,2);ui.dispose();
});
test('recording failure blocks hover before input',async()=>{
  let dispatches=0;
  const cdp=new EventEmitter();cdp.send=async()=>dispatches++;
  const ui=new BrowserInteractions({cdp},{origin:'http://synthetic.invalid',record:()=>{throw new Error('storage unavailable');}});
  ui.form.locate=async()=>({item:{ref:'known'}});
  await assert.rejects(ui.hover('#known',{source:'synthetic'}),/storage unavailable/);
  assert.equal(dispatches,0);ui.dispose();
});
test('shared navigation refuses a different origin before dispatch or journal',async()=>{
  const cdp=new EventEmitter();cdp.send=async()=>{throw new Error('dispatched');};
  const ui=new BrowserInteractions({cdp},{origin:'http://synthetic.invalid',record:()=>{throw new Error('recorded');}});
  await assert.rejects(ui.navigate('http://other.invalid/'),/navigation_origin_differs/);ui.dispose();
});
