'use strict';
const {ControlledChoice}=require('./choices.js');
const {PreparedEdit,locateAction}=require('./prepared-edit.js');
const {requireRecord,requireActionReceipt}=require('./interactions.js');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function selection(value){
  if(!Array.isArray(value)||value.some(item=>!['string','number'].includes(typeof item)||typeof item==='number'&&!Number.isFinite(item))||new Set(value).size!==value.length)throw new Error('explicit_unique_selection_values_required');
  return value;
}
class Autocomplete extends ControlledChoice{}
class MultiSelect extends ControlledChoice{
  constructor(ui,{readSelection,removeSelector,...options}={}){
    super(ui,options);
    if(typeof readSelection!=='function'||removeSelector!==undefined&&typeof removeSelector!=='function')throw new Error('explicit_multiselect_observers_required');
    this.readSelection=readSelection;this.removeSelector=removeSelector;
  }
  async requireSelection(expected){
    selection(expected);
    return this.ui.wait('exact selected widget values',async()=>{
      const actual=selection(await this.readSelection());return equal(actual,expected)?{values:actual}:false;
    },this.windowMs);
  }
  async select(prepared,{before,after,...options}={}){
    selection(before);selection(after);
    if(!equal(selection(await this.readSelection()),before))throw new Error('multiselect_prior_values_changed');
    const receipt=await super.select(prepared,options);
    const selected=await this.requireSelection(after);
    this.ui.record({kind:'multiselect_values_observed',...selected,persistence:'unverified'});
    return {receipt,selected:selected.values,persistence:'unverified'};
  }
  async remove({id,before,after,source}={}){
    requireRecord(this.ui.record);selection(before);selection(after);
    if(typeof source!=='string'||!source||!this.removeSelector||!before.includes(id)||!equal(before.filter(value=>value!==id),after))throw new Error('explicit_multiselect_removal_required');
    if(!equal(selection(await this.readSelection()),before))throw new Error('multiselect_prior_values_changed');
    this.ui.record({kind:'multiselect_remove_intent',id,source,before,after});
    const receipt=await this.ui.click(this.removeSelector(id));
    const selected=await this.requireSelection(after);
    return {receipt,selected:selected.values,persistence:'unverified'};
  }
}
function isoDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('explicit_iso_calendar_date_required');
  const parsed=new Date(value+'T00:00:00Z');
  if(!Number.isFinite(parsed.valueOf())||parsed.toISOString().slice(0,10)!==value)throw new Error('valid_iso_calendar_date_required');
  return value;
}
class DateRange extends PreparedEdit{
  constructor(ui,{start,due,...options}={}){super(ui,{...options,name:options.name||'date-range',fields:{start:{selector:start},due:{selector:due}}});}
  async prepare({snapshot,start,due,source,aroundInput}={}){
    isoDate(start);isoDate(due);if(due<start)throw new Error('ordered_explicit_date_range_required');
    return super.prepare({snapshot,values:{start,due},source,aroundInput});
  }
}
class RichTextEditor extends PreparedEdit{
  constructor(ui,{editor,...options}={}){super(ui,{...options,name:options.name||'plain-text-editor',fields:{content:{...(typeof editor==='string'?{selector:editor}:editor),interaction:'insert_plain_text'}}});}
  async prepare({snapshot,value,source}={}){
    if(typeof value!=='string')throw new Error('explicit_plain_text_required');
    await this.ui.form.checkContext(snapshot);
    const field=await this.locateField('content');
    if(!field.item.contenteditable)throw new Error('observed_contenteditable_host_required');
    return super.prepare({snapshot,values:{content:value},source});
  }
}
class InlineEditor extends PreparedEdit{
  constructor(ui,{open,...options}={}){super(ui,{...options,name:options.name||'inline-editor'});this.openAction=open;}
  async open({snapshot,source}={}){
    requireRecord(this.ui.record);
    if(typeof source!=='string'||!source||!this.openAction)throw new Error('explicit_inline_editor_open_required');
    await this.ui.form.checkContext(snapshot);
    const action=await locateAction(this.ui,this.openAction);
    this.ui.record({kind:'inline_editor_open_intent',actionRef:action.item.ref,source});
    requireActionReceipt(await this.ui.form.attempt(snapshot,action.item.ref,{windowMs:300}));
    return this.ui.wait('configured inline editor fields',async()=>{
      const current=await this.ui.form.checkContext(snapshot);
      const fields=[];
      for(const field of Object.values(this.fields)){
        const matches=await this.ui.form.call('locate',{selector:field.selector});
        if(matches.matchCount>1)throw new Error('inline_editor_field_ambiguous');
        if(!matches.ref)return false;
        fields.push(current.fields.find(item=>item.ref===matches.ref));
      }
      return fields.every(field=>field?.visible&&!field.disabled&&!field.readonly)?current:false;
    });
  }
}
module.exports={Autocomplete,ControlledChoice,MultiSelect,PreparedEdit,DateRange,RichTextEditor,InlineEditor};
