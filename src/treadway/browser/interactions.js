'use strict';
// Shared browser mechanics. Sites establish principal/resource identity and
// independently evaluate persistence; these methods do neither.
const {evalJS}=require('./cdp.js');
const {FormAssessor}=require('./form-assessor.js');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitForObservation(description,observe,{windowMs=15000,intervalMs=150,emit=()=>{},record=()=>{}}={}){
  if(typeof description!=='string'||!description||typeof observe!=='function')throw new Error('explicit_observation_required');
  if(!Number.isInteger(windowMs)||windowMs<1||windowMs>120000||!Number.isInteger(intervalMs)||intervalMs<1)throw new Error('bounded_observation_window_required');
  emit('waiting',{condition:description,windowMs});
  const end=Date.now()+windowMs;let last=null;
  do{
    try{last=await observe();}
    catch(error){
      if(error.code!=='CDP_COMMAND_TIMEOUT')throw error;
      last=null;record({kind:'condition_observation_incomplete',description,reason:'command_timeout_outcome_unknown',at:new Date().toISOString()});
    }
    if(last&&Date.now()<=end)return last;
    if(Date.now()>=end)break;
    await sleep(Math.min(intervalMs,end-Date.now()));
  }while(Date.now()<end);
  record({kind:'condition_incomplete',description,last,at:new Date().toISOString()});
  throw new Error('condition_not_established:'+description);
}
function requireActionReceipt(result,{allowTransition=false}={}){
  if(result?.actionDispatch!=='dispatched'||result.recordStatus!=='recorded'||result.browserDialog||(!allowTransition&&!result.after?.observed))
    throw new Error('action_mechanics_incomplete');
  return result;
}
function requireRecord(record){if(typeof record!=='function')throw new Error('mutation_record_callback_required');}
class BrowserInteractions{
  constructor(session,{origin,scope='body',frameSelector=null,record=null,emit=()=>{}}={}){
    const url=new URL(origin);
    if(url.origin!==origin||!['http:','https:'].includes(url.protocol))throw new Error('explicit_http_origin_required');
    this.session=session;this.origin=origin;this.record=record;this.emit=emit;
    this.Form=FormAssessor;
    this.form=new FormAssessor(session,{scope,frameSelector,record,emit:event=>emit(event.phase,event)});
  }
  evaluate(expression){return evalJS(this.session.cdp,expression);}
  wait(description,observe,windowMs=15000){return waitForObservation(description,observe,{windowMs,emit:this.emit,record:this.record||(()=>{})});}
  visible(selector){return this.evaluate(`(()=>{const es=[...document.querySelectorAll(${JSON.stringify(selector)})];return es.length===1&&es[0].getBoundingClientRect().width>0&&es[0].getBoundingClientRect().height>0&&getComputedStyle(es[0]).visibility!=='hidden';})()`);}
  async navigate(url,selector){
    if(new URL(url).origin!==this.origin)throw new Error('navigation_origin_differs');
    requireRecord(this.record);
    this.record({kind:'navigation_intent',url,at:new Date().toISOString()});
    const navigation=await this.session.cdp.send('Page.navigate',{url});
    if(navigation.errorText||!navigation.loaderId)throw new Error('new_document_navigation_not_established');
    await this.wait('new document committed',async()=>{
      const tree=await this.session.cdp.send('Page.getFrameTree');
      return tree.frameTree.frame.loaderId===navigation.loaderId&&await this.evaluate(`document.readyState==='interactive'||document.readyState==='complete'`);
    },30000);
    if(selector)await this.wait('visible '+selector,()=>this.visible(selector));
  }
  async click(selector,{windowMs=300,intent='action',expectNavigation=false}={}){
    const {snapshot,item}=await this.form.locate(selector,{kind:intent==='press_enter'?'field':'action'});
    if(intent==='action'&&!item.associatedWithScope)throw new Error('action_outside_explicit_scope');
    return requireActionReceipt(await this.form.attempt(snapshot,item.ref,{windowMs,intent}),{allowTransition:expectNavigation});
  }
  async clickLabel(label,{scope=this.form.scope,expectTransition=false,windowMs=300}={}){
    const scoped=scope===this.form.scope?this.form:new this.Form(this.session,{scope,frameSelector:this.form.frameSelector,record:this.record,emit:event=>this.emit(event.phase,event)});
    try{
      const snapshot=await scoped.inspect();
      const matches=snapshot.actions.filter(action=>action.visible&&action.associatedWithScope&&action.label===label);
      if(matches.length!==1)throw new Error('exact_action_label_requires_one_match');
      return requireActionReceipt(await scoped.attempt(snapshot,matches[0].ref,{windowMs}),{allowTransition:expectTransition});
    }finally{if(scoped!==this.form)scoped.dispose();}
  }
  input(selector,value,source){return this.applyFields([{selector,value,source}]);}
  async applyFields(candidates){
    if(!Array.isArray(candidates)||!candidates.length)throw new Error('candidate_patch_required');
    let snapshot;const patch=[];
    for(const candidate of candidates){
      const located=await this.form.locate(candidate.selector,{kind:'field'});
      snapshot=located.snapshot;patch.push({...candidate,ref:located.item.ref});
    }
    const result=await this.form.apply(snapshot,patch);
    if(!result.complete||result.recordStatus!=='recorded')throw new Error('input_readback_incomplete');
    return result;
  }
  frameForm(selector){
    if(typeof selector!=='string'||!selector.trim())throw new Error('explicit_frame_selector_required');
    return new this.Form(this.session,{frameSelector:selector,record:this.record,emit:event=>this.emit(event.phase,event)});
  }
  async hover(selector,{kind='action',source}={}){
    requireRecord(this.record);if(typeof source!=='string'||!source)throw new Error('explicit_interaction_source_required');
    const {item}=await this.form.locate(selector,{kind});
    this.record({kind:'hover_intent',ref:item.ref,source,at:new Date().toISOString()});
    const point=await this.form.preparePointer(item.ref);
    await this.session.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
    return {ref:item.ref,dispatch:'mouseMoved',point};
  }
  async scroll(selector,{source}={}){
    requireRecord(this.record);if(typeof source!=='string'||!source)throw new Error('explicit_interaction_source_required');
    this.record({kind:'viewport_scroll_intent',selector,source,at:new Date().toISOString()});
    const result=await this.form.call('scroll',{selector});
    return {selector,scrolled:result.scrolled};
  }
  dispose(){this.form.dispose();}
}
module.exports={BrowserInteractions,waitForObservation,requireActionReceipt,requireRecord};
