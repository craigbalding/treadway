'use strict';
const {requireActionReceipt,requireRecord}=require('./interactions.js');
const {controlledBinding}=require('./choice-binding.js');
const controlledList=(snapshot,fieldRef)=>controlledBinding(snapshot,fieldRef).list;
class ControlledChoice{
  constructor(ui,{field,windowMs=15000}={}){
    if(!(typeof field==='string'&&field.trim())&&!(field&&typeof field==='object'&&typeof field.ref==='string'&&field.ref&&Object.keys(field).length===1))throw new Error('explicit_choice_field_required');
    this.ui=ui;this.field=structuredClone(field);this.windowMs=windowMs;
  }
  async prepare({snapshot,query,source,open=false,label,ready}={}){
    const ui=this.ui;requireRecord(ui.record);
    if(label!==undefined&&(typeof label!=='string'||!label))throw new Error('explicit_choice_label_required');
    if(query!==undefined&&(typeof query!=='string'||typeof source!=='string'||!source))throw new Error('explicit_sourced_choice_query_required');
    if(ready!==undefined&&typeof ready!=='function')throw new Error('choice_readiness_observer_must_be_function');
    const checked=await ui.form.checkContext(snapshot);
    const located=typeof this.field==='string'?await ui.form.locate(this.field,{kind:'field'}):{snapshot:checked,item:checked.fields.find(field=>field.ref===this.field.ref)};
    if(!located.item)throw new Error('choice_field_reference_missing');
    ui.form.requireContext(located.snapshot,snapshot);
    let current=located.snapshot;const field=located.item;
    if(field.role!=='combobox'||!field.visible||field.disabled||field.readonly)throw new Error('choice_field_not_usable');
    if(open&&field.expanded!=='true'){
      requireActionReceipt(await ui.form.attempt(current,field.ref,{intent:'open_choices',windowMs:300}));
      current=await ui.form.checkContext(current);
    }
    if(query!==undefined){
      const result=await ui.form.apply(current,[{ref:field.ref,value:query,source,interaction:'type_query'}]);
      if(!result.complete||result.recordStatus!=='recorded')throw new Error('choice_query_incomplete');
      current=result.after;
    }
    const preparedSnapshot=await ui.wait('controlled choice options',async()=>{
      const fresh=await ui.form.checkContext(current);
      // A query may open the list asynchronously. Missing lists are readiness,
      // while an invalid field/relationship or ambiguous lists are terminal.
      const lists=fresh.listboxes.filter(list=>list.controllers?.some(controller=>controller.fieldRef===field.ref));
      if(!lists.length)return false;
      const list=controlledList(fresh,field.ref);
      const options=list.options.filter(option=>option.visible&&!option.disabled&&(label===undefined||option.label===label));
      if(label!==undefined&&options.length>1)throw new Error('one_exact_controlled_option_required');
      if(!options.length)return false;
      return !ready||await ready({snapshot:fresh,fieldRef:field.ref,list})===true?fresh:false;
    },this.windowMs);
    return {version:'treadway.choice/1',fieldRef:field.ref,fieldSelector:this.field,snapshot:preparedSnapshot};
  }
  async select(prepared,{label,optionRef,validateOption,windowMs=500}={}){
    const ui=this.ui;requireRecord(ui.record);
    if(prepared?.version!=='treadway.choice/1'||JSON.stringify(prepared.fieldSelector)!==JSON.stringify(this.field)||typeof label!=='string'||!label)
      throw new Error('prepared_choice_and_exact_label_required');
    const snapshot=await ui.form.checkContext(prepared.snapshot);
    const previous=controlledList(prepared.snapshot,prepared.fieldRef),current=controlledList(snapshot,prepared.fieldRef);
    if(previous.ref!==current.ref||JSON.stringify(previous.controllers)!==JSON.stringify(current.controllers))throw new Error('choice_association_changed_inspect_again');
    const options=current.options.filter(option=>option.visible&&!option.disabled&&option.label===label&&(optionRef===undefined||option.ref===optionRef));
    if(options.length!==1)throw new Error('one_exact_controlled_option_required');
    const option=options[0];
    if(validateOption&&await validateOption({option,snapshot,fieldRef:prepared.fieldRef})!==true)throw new Error('choice_identity_not_established');
    ui.record({kind:'controlled_choice_intent',fieldRef:prepared.fieldRef,optionRef:option.ref,label});
    return requireActionReceipt(await ui.form.attempt(snapshot,option.ref,{intent:'choose_option',fieldRef:prepared.fieldRef,windowMs}));
  }
}
module.exports={ControlledChoice,controlledList};
