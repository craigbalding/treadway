'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {ownerReady,locateOwner,sameBinding}=require('../browser.cjs');
const person={id:'person-17',name:'Casey Rowan'};
const option=(id=person.id,name=person.name)=>({dataset:{id},textContent:name});
function ui(query,options,{hidden=false,search=undefined}={}){
  const list={hidden,dataset:{query,search},querySelectorAll:()=>options};
  return {evaluate:async expression=>vm.runInNewContext(expression,{document:{querySelector:()=>list}})};
}
test('pending old results cannot prepare a matching displayed owner',async()=>{
  assert.equal(await ownerReady(ui('Casey',[option()]),person.name,person),false);
});
test('same label on the wrong actual ID is refused',async()=>{
  assert.equal(await ownerReady(ui(person.name,[option('person-99')]),person.name,person),false);
});
test('filtered unique current owner is ready; ambiguous or hidden results are not',async()=>{
  assert.equal(await ownerReady(ui(person.name,[option()]),person.name,person),true);
  assert.equal(await ownerReady(ui(person.name,[option(),option()]),person.name,person),false);
  assert.equal(await ownerReady(ui(person.name,[option()],{hidden:true}),person.name,person),false);
});
test('a resource revision and run are both required',()=>{
  const binding={id:'a',run:'b',revision:3,actor:'fixture-author'};
  assert.equal(sameBinding({...binding},binding),true);
  assert.equal(sameBinding({...binding,revision:4},binding),false);
  assert.equal(sameBinding({...binding,run:'another'},binding),false);
});

test('actual option resolves without treating an option as a page action',async()=>{
  const calls=[];
  const ui={form:{call:async(command,args)=>{calls.push({command,args});return {ref:'option-17'};}}};
  assert.equal(await locateOwner(ui,person),'option-17');
  assert.equal(calls[0].command,'locate');
  assert.equal(calls[0].args.selector,'[role=option][data-id="person-17"]');
  await assert.rejects(locateOwner({form:{call:async()=>({matchCount:2})}},person),/one_actual_owner_option_required/);
});

test('current query marker controls readiness even when an unrelated search marker conflicts',async()=>{
  assert.equal(await ownerReady(ui(person.name,[option()],{search:'Sam Morgan'}),person.name,person),true);
  assert.equal(await ownerReady(ui('Sam Morgan',[option()],{search:person.name}),person.name,person),false);
});
