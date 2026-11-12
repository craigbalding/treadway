'use strict';
const {FormAssessor}=require('./form-assessor.js');
const {requireRecord,requireActionReceipt}=require('./interactions.js');
function explicitAction(action){
  if(!action||Number(typeof action.selector==='string')+Number(typeof action.label==='string')!==1)throw new Error('one_explicit_commit_action_required');
  return {...action};
}
async function locateAction(ui,action){
  if(action.selector)return ui.form.locate(action.selector,{kind:'action'});
  const form=action.scope?new FormAssessor(ui.session,{scope:action.scope,frameSelector:ui.form.frameSelector,record:ui.record}):ui.form;
  try{
    const snapshot=await form.inspect();
    const matches=snapshot.actions.filter(item=>item.visible&&item.associatedWithScope&&item.label===action.label);
    if(matches.length!==1)throw new Error('one_exact_commit_action_required');
    return {snapshot,item:matches[0]};
  }finally{if(form!==ui.form)form.dispose();}
}
function fieldValue(field){return ['checkbox','radio'].includes(field.type)?field.checked:field.value;}
class PreparedEdit{
  constructor(ui,{fields,action,nativeForm=null,name='edit'}={}){
    if(!fields||typeof fields!=='object'||Array.isArray(fields)||!Object.keys(fields).length||Object.values(fields).some(field=>Number(typeof field.selector==='string'&&!!field.selector)+Number(typeof field.ref==='string'&&!!field.ref)!==1))throw new Error('explicit_edit_field_mapping_required');
    this.ui=ui;this.fields=structuredClone(fields);this.action=explicitAction(action);this.nativeForm=nativeForm?structuredClone(nativeForm):null;this.name=name;
    this.profile=JSON.stringify({name,fields:this.fields,action:this.action,nativeForm:this.nativeForm});
  }
  async locateField(name){
    const field=this.fields[name];
    if(field.selector)return this.ui.form.locate(field.selector,{kind:'field'});
    const snapshot=await this.ui.form.inspect(),item=snapshot.fields.find(item=>item.ref===field.ref);
    if(!item)throw new Error('prepared_edit_field_reference_missing');
    return {snapshot,item};
  }
  async observeFields(names){
    const fields=[];
    for(const name of names){
      const located=await this.locateField(name);
      const item=located.item;
      if(!item.visible||item.disabled||item.readonly||item.redacted)throw new Error('prepared_edit_field_not_usable');
      fields.push({name,ref:item.ref,value:fieldValue(item)});
    }
    return fields;
  }
  async nativeBinding(fields,action){
    return this.nativeForm?this.ui.form.formBinding(this.nativeForm,{fieldRefs:fields.map(field=>field.ref),actionRef:action.ref}):null;
  }
  async prepare({snapshot,values,source,aroundInput}={}){
    const ui=this.ui;requireRecord(ui.record);
    if(!values||typeof values!=='object'||Array.isArray(values)||!Object.keys(values).length||Object.keys(values).some(name=>!Object.hasOwn(this.fields,name))||
      typeof source!=='string'||!source||Object.values(values).some(value=>!['string','boolean'].includes(typeof value)))throw new Error('explicit_sourced_edit_values_required');
    if(aroundInput!==undefined&&typeof aroundInput!=='function')throw new Error('input_observer_must_be_function');
    await ui.form.checkContext(snapshot);
    const names=Object.keys(values);
    const initial=await this.observeFields(names);
    ui.form.planCandidates(await ui.form.inspect(),initial.map(field=>({ref:field.ref,value:values[field.name],source,
      ...(this.fields[field.name].interaction?{interaction:this.fields[field.name].interaction}:{})})));
    for(const name of names){
      await ui.form.checkContext(snapshot);
      const fields=await this.observeFields(names),action=await locateAction(ui,this.action);
      ui.form.requireContext(await ui.form.inspect(),snapshot);
      await this.nativeBinding(fields,action.item);
      const field=this.fields[name];let dispatched=0;
      const dispatch=async()=>{
        if(dispatched++)throw new Error('edit_input_may_only_dispatch_once');
        const current=await ui.form.checkContext(snapshot),located=await this.locateField(name);
        ui.form.requireContext(located.snapshot,current);
        const result=await ui.form.apply(current,[{ref:located.item.ref,value:values[name],source,...(field.interaction?{interaction:field.interaction}:{})}]);
        if(!result.complete||result.recordStatus!=='recorded')throw new Error('input_readback_incomplete');
        return result;
      };
      if(aroundInput)await aroundInput({name,value:values[name],selector:field.selector,dispatch});
      else await dispatch();
      if(dispatched!==1)throw new Error('edit_input_not_dispatched');
    }
    return this.bind({snapshot,values});
  }
  async bind({snapshot,values}={}){
    const ui=this.ui;requireRecord(ui.record);
    if(!values||typeof values!=='object'||Array.isArray(values)||!Object.keys(values).length||Object.keys(values).some(name=>!Object.hasOwn(this.fields,name)))throw new Error('explicit_prepared_value_bindings_required');
    await ui.form.checkContext(snapshot);
    const fields=await this.observeFields(Object.keys(values));
    for(const field of fields)if(field.value!==values[field.name])throw new Error('prepared_edit_readback_differs');
    const action=await locateAction(ui,this.action);
    const context=await ui.form.checkContext(snapshot);
    const native=await this.nativeBinding(fields,action.item);
    const prepared={version:'treadway.edit/1',profile:this.profile,snapshot:context,fields,actionRef:action.item.ref,native};
    ui.record({kind:'edit_prepared',name:this.name,prepared});
    return prepared;
  }
  async check(prepared){
    if(prepared?.version!=='treadway.edit/1'||prepared.profile!==this.profile||!Array.isArray(prepared.fields)||!prepared.fields.length)throw new Error('matching_prepared_edit_required');
    const snapshot=await this.ui.form.checkContext(prepared.snapshot);
    for(const prior of prepared.fields){
      if(!Object.hasOwn(this.fields,prior.name))throw new Error('prepared_edit_field_mapping_differs');
      const field=snapshot.fields.find(item=>item.ref===prior.ref);
      if(!field||!field.visible||field.disabled||field.readonly||fieldValue(field)!==prior.value)throw new Error('prepared_edit_value_or_reference_changed');
      const located=await this.locateField(prior.name);
      if(located.item.ref!==prior.ref)throw new Error('prepared_edit_selector_binding_changed');
    }
    const action=await locateAction(this.ui,this.action);
    if(action.item.ref!==prepared.actionRef)throw new Error('prepared_edit_action_changed');
    const native=await this.nativeBinding(prepared.fields,action.item);
    if(native&&native.formRef!==prepared.native?.formRef)throw new Error('prepared_native_form_replaced');
    return snapshot;
  }
  async commit(prepared,{validate,windowMs=600,allowTransition=false}={}){
    const ui=this.ui;requireRecord(ui.record);
    if(validate!==undefined&&typeof validate!=='function')throw new Error('fresh_edit_guard_must_be_function');
    await this.check(prepared);
    if(validate&&await validate(prepared)!==true)throw new Error('fresh_edit_guard_not_established');
    // An asynchronous adapter guard can itself outlive the DOM observations.
    const snapshot=await this.check(prepared);
    ui.record({kind:'edit_commit_intent',name:this.name,actionRef:prepared.actionRef,applicationOutcome:'not_evaluated'});
    const receipt=requireActionReceipt(await ui.form.attempt(snapshot,prepared.actionRef,{windowMs}),{allowTransition});
    return {receipt,persistence:'unverified',applicationOutcome:'not_evaluated'};
  }
}
module.exports={PreparedEdit,locateAction,fieldValue};
