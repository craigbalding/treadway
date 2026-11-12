'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ControlledChoice}=require('../src/treadway/browser/choices.js');
const {PreparedEdit}=require('../src/treadway/browser/prepared-edit.js');
const {FormAssessor}=require('../src/treadway/browser/form-assessor.js');
function fixture(){
  const events=[];
  const field={ref:'field',id:'query',tag:'input',type:'text',visible:true,disabled:false,readonly:false,role:'combobox',choiceUsable:true,controlledElements:[{controlId:'list',matchCount:1,containerRef:'container',disabled:false}],value:'saved'};
  const action={ref:'save',label:'Save',visible:true,associatedWithScope:true};
  const snapshot={observed:true,fields:[field],actions:[action],listboxes:[{ref:'list',controllers:[{fieldRef:'field',controlId:'list',containerRef:'container'}],options:[{ref:'option',label:'Known',visible:true,disabled:false}]}]};
  const ui={record:r=>events.push(r.kind),form:{inspect:async()=>snapshot,checkContext:async()=>snapshot,requireContext:()=>snapshot,
    locate:async(selector,{kind})=>({snapshot,item:kind==='action'?action:field}),
    attempt:async()=>{events.push('dispatch');return {actionDispatch:'dispatched',recordStatus:'recorded',after:{observed:true}};}}};
  return {ui,field,action,snapshot,events};
}
test('an ambiguous controlled option cannot dispatch a selection',async()=>{
  const f=fixture(),choice=new ControlledChoice(f.ui,{field:'#query'});
  f.snapshot.listboxes[0].options.push({...f.snapshot.listboxes[0].options[0],ref:'other'});
  await assert.rejects(choice.select({version:'treadway.choice/1',fieldSelector:'#query',fieldRef:'field',snapshot:f.snapshot},{label:'Known'}),/one_exact_controlled_option_required/);
  assert.deepEqual(f.events,[]);
});
test('identity validation failure stops a matching label before dispatch',async()=>{
  const f=fixture(),choice=new ControlledChoice(f.ui,{field:'#query'});
  await assert.rejects(choice.select({version:'treadway.choice/1',fieldSelector:'#query',fieldRef:'field',snapshot:f.snapshot},{label:'Known',validateOption:async()=>false}),/choice_identity_not_established/);
  assert.deepEqual(f.events,[]);
});
test('changed relationship after preparation blocks even a surviving option',async()=>{
  const f=fixture(),choice=new ControlledChoice(f.ui,{field:'#query'}),prior=structuredClone(f.snapshot);
  f.snapshot.listboxes[0].controllers[0].containerRef='new-container';
  await assert.rejects(choice.select({version:'treadway.choice/1',fieldSelector:'#query',fieldRef:'field',snapshot:prior},{label:'Known'}),/choice_association_changed/);
  assert.deepEqual(f.events,[]);
});
function editFixture(){
  const f=fixture();f.field.role=null;
  const edit=new PreparedEdit(f.ui,{fields:{title:{selector:'#title'}},action:{selector:'#save'}});
  const prepared={version:'treadway.edit/1',profile:edit.profile,snapshot:f.snapshot,fields:[{name:'title',ref:'field',value:'saved'}],actionRef:'save',native:null};
  return {...f,edit,prepared};
}
test('a changed prepared value blocks commit before its application guard',async()=>{
  const f=editFixture();f.field.value='changed';
  await assert.rejects(f.edit.commit(f.prepared,{validate:async()=>{f.events.push('guard');return true;}}),/prepared_edit_value_or_reference_changed/);
  assert.deepEqual(f.events,[]);
});
test('a failed fresh resource guard blocks the commit',async()=>{
  const f=editFixture();
  await assert.rejects(f.edit.commit(f.prepared,{validate:async()=>false}),/fresh_edit_guard_not_established/);
  assert.deepEqual(f.events,[]);
});
test('an async guard cannot hide a subsequent prepared-value change',async()=>{
  const f=editFixture();
  await assert.rejects(f.edit.commit(f.prepared,{validate:async()=>{f.field.value='changed during guard';return true;}}),/prepared_edit_value_or_reference_changed/);
  assert.deepEqual(f.events,[]);
});
test('the full candidate patch is validated before the first input',async()=>{
  const f=editFixture(),second={...f.field,ref:'second',id:'second'};
  f.snapshot.fields.push(second);
  f.ui.form.locate=async(selector,{kind})=>({snapshot:f.snapshot,item:kind==='action'?f.action:selector==='#title'?f.field:second});
  f.ui.form.planCandidates=FormAssessor.prototype.planCandidates;
  f.ui.applyFields=async()=>f.events.push('input');
  const edit=new PreparedEdit(f.ui,{fields:{title:{selector:'#title'},second:{selector:'#second'}},action:{selector:'#save'}});
  await assert.rejects(edit.prepare({snapshot:f.snapshot,values:{title:'valid',second:true},source:'synthetic'}),/candidate_type_mismatch/);
  assert.deepEqual(f.events,[]);
});
test('reference choice preparation waits for the adapter observation before retaining a binding',async()=>{
  const f=fixture();let observations=0;
  f.ui.wait=async(_description,observe)=>{assert.equal(await observe(),false);return observe();};
  const choice=new ControlledChoice(f.ui,{field:{ref:'field'}});
  const prepared=await choice.prepare({snapshot:f.snapshot,ready:async({fieldRef,list})=>{assert.equal(fieldRef,'field');assert.equal(list.ref,'list');return ++observations===2;}});
  await choice.select(JSON.parse(JSON.stringify(prepared)),{label:'Known'});
  assert.equal(observations,2);assert.deepEqual(f.events,['controlled_choice_intent','dispatch']);
});
test('binding already prepared reference-based input never repeats the input',async()=>{
  const f=fixture();
  const edit=new PreparedEdit(f.ui,{fields:{title:{ref:'field'}},action:{selector:'#save'}});
  const prepared=await edit.bind({snapshot:f.snapshot,values:{title:'saved'}});
  f.field.value='concurrent change';
  await assert.rejects(edit.commit(prepared),/prepared_edit_value_or_reference_changed/);
  assert.deepEqual(f.events,['edit_prepared']);
});
