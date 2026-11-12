#!/usr/bin/env node
'use strict';
// Agent-assisted form mechanics with explicit inputs, actions and observations.
const fs = require('node:fs');
const path = require('node:path');
const { createCdpProxy, connect } = require('./cdp.js');
const {choiceContext}=require('./choice-binding.js');
const runtime = fs.readFileSync(path.join(__dirname, 'browser-form.function.js'), 'utf8');
const VERSION = 'treadway.form/4';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class FormAssessor {
  constructor(session, { scope = 'body', emit = () => {}, record = null, frameSelector = null } = {}) {
    this.session = session; this.scope = scope; this.emit = emit; this.record = record;
    if(frameSelector!==null&&(typeof frameSelector!=='string'||!frameSelector.trim()))throw new Error('explicit_frame_selector_required');
    this.frameSelector=frameSelector;
    this.events = []; this.dialog = null; this.listeners=[];
    for (const type of ['Network.requestWillBeSent','Network.responseReceived','Network.loadingFailed',
      'Page.javascriptDialogOpening','Page.javascriptDialogClosed','Page.frameNavigated','Page.navigatedWithinDocument']) {
      const listener = p => {
        if (type === 'Page.javascriptDialogOpening') this.dialog = { type: p.type, message: p.message, url: p.url };
        if (type === 'Page.javascriptDialogClosed') this.dialog = null;
        const item = { type, at: new Date().toISOString(), requestId: p.requestId || null };
        if (p.request) Object.assign(item, { method: p.request.method, url: safeURL(p.request.url) });
        if (p.response) Object.assign(item, { status: p.response.status, url: safeURL(p.response.url) });
        if (p.errorText) item.error = p.errorText;
        if (type === 'Page.javascriptDialogOpening') item.dialog = this.dialog;
        this.events.push(item);
        if (this.events.length > 1000) { this.events.shift(); this.truncated = true; }
      };
      session.cdp.on(type,listener);this.listeners.push([type,listener]);
    }
  }
  dispose(){
    for(const [type,listener] of this.listeners)this.session.cdp.off(type,listener);
    this.listeners=[];
  }
  async rawCall(command, args = {}, timeoutMs = 3000, contextId) {
    const r = await this.session.cdp.send('Runtime.evaluate', {
      expression: `(${runtime})(${JSON.stringify(command)},${JSON.stringify(args)})`, returnByValue: true,
      ...(contextId===undefined?{}:{contextId}),
    }, { timeoutMs });
    if (r.exceptionDetails || !r.result || !Object.hasOwn(r.result, 'value')) {
      const fixed=/^Error: ([a-z_]+)(?:: inspect again)?$/.exec((r.exceptionDetails?.exception?.description||'').split('\n')[0]);
      throw new Error('form_runtime_failed: ' + (fixed?.[1] || r.exceptionDetails?.text || 'missing result'));
    }
    return r.result.value;
  }
  async frameContext(timeoutMs) {
    const parent=await this.rawCall('locate',{selector:this.frameSelector},timeoutMs);
    if(!parent.ref)throw new Error('frame_selector_must_match_exactly_one_element: observed_'+parent.matchCount);
    await this.rawCall('frame_info',{ref:parent.ref},timeoutMs);
    const doc=await this.session.cdp.send('DOM.getDocument',{depth:0},{timeoutMs});
    const found=await this.session.cdp.send('DOM.querySelectorAll',{nodeId:doc.root.nodeId,selector:this.frameSelector},{timeoutMs});
    if(found.nodeIds.length!==1)throw new Error('frame_binding_changed');
    const described=await this.session.cdp.send('DOM.describeNode',{nodeId:found.nodeIds[0]},{timeoutMs});
    const frameId=described.node.frameId;
    if(!frameId)throw new Error('frame_identifier_not_observed');
    const world=await this.session.cdp.send('Page.createIsolatedWorld',{frameId,worldName:'treadway.form.v3',grantUniveralAccess:false},{timeoutMs});
    return {contextId:world.executionContextId,binding:{frameId,parentDocumentId:parent.documentId,parentLocationId:parent.locationId,frameRef:parent.ref,selector:this.frameSelector}};
  }
  async call(command,args={},timeoutMs=3000) {
    if(!this.frameSelector)return this.rawCall(command,args,timeoutMs);
    const frame=await this.frameContext(timeoutMs);
    const result=await this.rawCall(command,args,timeoutMs,frame.contextId);
    if(command==='inspect'||command==='locate')result.frameContext=frame.binding;
    if(command==='inspect'){
      const parent=await this.rawCall('inspect',{scope:'body'},timeoutMs);
      result.parentDialogs=parent.dialogs;
    }
    return result;
  }
  async inspect() {
    const snapshot = await this.call('inspect', { scope: this.scope });
    return { version: VERSION, ...snapshot, browserDialog: this.dialog, nativeDialogCoverage: 'events_since_attachment',
      guidance: guidance(snapshot) };
  }
  async locate(selector, { kind = 'action' } = {}) {
    if (!['action','field'].includes(kind)) throw new Error('unknown_reference_kind');
    const snapshot = await this.inspect();
    const found = await this.call('locate', {selector});
    if (!found.ref) throw new Error('selector_must_match_exactly_one_element: observed_'+found.matchCount);
    if (found.documentId !== snapshot.documentId || found.locationId !== snapshot.locationId || JSON.stringify(found.frameContext)!==JSON.stringify(snapshot.frameContext)) throw new Error('form_context_changed_inspect_again');
    const item = snapshot[kind === 'action' ? 'actions' : 'fields'].find(x=>x.ref===found.ref);
    if (!item) throw new Error('selector_does_not_identify_observed_' + kind);
    return { snapshot, item };
  }
  async checkContext(snapshot) {
    if (!snapshot?.observed || snapshot.scope !== this.scope) throw new Error('observed_snapshot_with_matching_scope_required');
    const current = await this.inspect();
    return this.requireContext(current,snapshot);
  }
  requireContext(current,snapshot) {
    if(current.observed!==true)throw new Error('form_context_observation_required');
    if (current.documentId !== snapshot.documentId || current.locationId !== snapshot.locationId ||
        JSON.stringify(current.step) !== JSON.stringify(snapshot.step) || JSON.stringify(current.frameContext)!==JSON.stringify(snapshot.frameContext)) throw new Error('form_context_changed_inspect_again');
    if (this.dialog || current.dialogs.some(d=>!snapshot.dialogs.some(b=>b.ref===d.ref))) throw new Error('unexpected_dialog_inspect_before_acting');
    if((current.parentDialogs||[]).some(d=>!(snapshot.parentDialogs||[]).some(b=>b.ref===d.ref)))throw new Error('unexpected_parent_dialog_inspect_before_acting');
    return current;
  }
  async formBinding(contract,{fieldRefs,actionRef}) {
    if(!contract||typeof contract.selector!=='string'||!contract.selector||!['get','post'].includes(contract.method)||
      !Array.isArray(fieldRefs)||!fieldRefs.length||!fieldRefs.every(ref=>typeof ref==='string')||typeof actionRef!=='string')
      throw new Error('explicit_native_form_contract_required');
    const action=new URL(contract.action);
    if(!['http:','https:'].includes(action.protocol)||action.username||action.password||action.hash||
      !(contract.methodOverride===null||typeof contract.methodOverride==='string'&&contract.methodOverride))
      throw new Error('canonical_native_form_target_required');
    const binding=await this.call('form_binding',{contract,fieldRefs,actionRef});
    if(!binding.targetMatches||!binding.methodMatches||!binding.overrideMatches||!binding.fieldsAssociated||
      !binding.submitAssociated||!binding.submitOverridesAbsent)throw new Error('native_form_binding_differs');
    return binding;
  }
  async preparePointer(ref,choice) {
    let p;
    if(this.frameSelector){
      const frame=await this.frameContext(3000);
      const local=await this.rawCall('prepare',{ref,choice},3000,frame.contextId);
      // Scrolling a child element can also scroll the outer document. Measure
      // the frame's final offset after that scroll, before dispatching input.
      const bounds=await this.rawCall('frame_bounds',{ref:frame.binding.frameRef});
      if(local.x<0||local.y<0||local.x>=bounds.width||local.y>=bounds.height)throw new Error('frame_control_outside_viewport');
      p={...local,x:bounds.left+local.x,y:bounds.top+local.y};
      await this.rawCall('frame_hit',{ref:frame.binding.frameRef,x:p.x,y:p.y});
    }else p = await this.call('prepare', { ref,choice });
    return p;
  }
  async pointer(ref,choice) {
    const p=await this.preparePointer(ref,choice);
    for (const type of ['mouseMoved','mousePressed','mouseReleased']) {
      await this.session.cdp.send('Input.dispatchMouseEvent', { type, x:p.x, y:p.y,
        ...(type === 'mouseMoved' ? {} : { button:'left',clickCount:1 }) }, { timeoutMs:3000 });
    }
    return p;
  }
  async key(key, code, modifiers = 0) {
    const windowsVirtualKeyCode = {Backspace:8,Tab:9,Enter:13,Escape:27,Delete:46}[key] ||
      (key.length===1 ? key.toUpperCase().charCodeAt(0) : 0);
    for (const type of ['keyDown','keyUp']) await this.session.cdp.send('Input.dispatchKeyEvent', { type,key,code,modifiers,windowsVirtualKeyCode, ...(key==='Enter'&&type==='keyDown'?{text:'\r',unmodifiedText:'\r'}:{}) }, { timeoutMs:3000 });
  }
  planCandidates(snapshot,candidates){
    if(!Array.isArray(candidates)||!candidates.length)throw new Error('candidate_patch_required');
    return candidates.map(c => {
      const f = snapshot.fields.find(f => f.ref === c.ref);
      if (!f || !c.source || typeof c.source !== 'string') throw new Error('known_field_and_candidate_source_required');
      if (f.redacted) throw new Error('sensitive_field_requires_authentication_helper');
      const toggle = ['checkbox','radio'].includes(f.type);
      const text = f.tag === 'textarea' || (f.tag === 'input' && ['text','email','tel','url','search','number',''].includes(f.type || ''));
      const select = f.tag === 'select';
      const editable=f.contenteditable===true;
      if(editable&&c.interaction!=='insert_plain_text')throw new Error('contenteditable_requires_explicit_plain_text_interaction');
      if (!(toggle || text || select || editable) || (f.role === 'combobox' && !text)) throw new Error('unsupported_control_use_explicit_choice_action');
      if (f.role === 'combobox' && c.interaction !== 'type_query') throw new Error('autocomplete_requires_explicit_type_query_then_choose');
      if (toggle ? typeof c.value !== 'boolean' || (f.type === 'radio' && !c.value) : typeof c.value !== 'string') throw new Error('candidate_type_mismatch');
      if (f.disabled || f.readonly) throw new Error('control_disabled_or_readonly');
      return { c, f, toggle, select, editable };
    });
  }
  async apply(snapshot, candidates) {
    if (!Array.isArray(candidates) || !candidates.length) throw new Error('candidate_patch_required');
    snapshot = await this.checkContext(snapshot);
    if(typeof this.record!=='function')throw new Error('mutation_record_callback_required');
    // Validate the entire patch before first interaction. A missing source is not
    // replaced by a placeholder. Each chosen radio/checkbox is an explicit field.
    const plans = this.planCandidates(snapshot,candidates);
    this.record({kind:'input_plan',version:VERSION,at:new Date().toISOString(),snapshot,candidates});
    const receipts = [];
    for (const { c, f, toggle, select, editable } of plans) {
      this.emit({ phase:'input_started', ref:c.ref, source:c.source });
      try {
        // An earlier field can navigate or open a modal. Rebind before the
        // next mutation, retaining prior entered values if preparation stops.
        await this.checkContext(snapshot);
        const before = await this.call('read',{ref:c.ref});
        if (toggle) { if (before.checked !== c.value) await this.pointer(c.ref); }
        else if (select) {
          await this.preparePointer(c.ref);
          await this.call('select',{ref:c.ref,value:c.value});
        } else {
          await this.pointer(c.ref);
          await this.key('a','KeyA',2);
          if(editable&&!await this.call('selection_bound',{ref:c.ref}))throw new Error('selection_not_bound_to_editable_field');
          await this.key('Backspace','Backspace');
          if (c.value) await this.session.cdp.send('Input.insertText',{text:c.value},{timeoutMs:3000});
          // Search text may be cleared when an autocomplete loses focus. An
          // explicit query stays focused for a separate observed option choice.
          if(f.role!=='combobox'||c.interaction!=='type_query')await this.key('Tab','Tab');
        }
        await sleep(120);
        const after = await this.call('read',{ref:c.ref});
        const matched = toggle ? after.checked === c.value : after.value === c.value;
        receipts.push({ ref:c.ref, id:f.id, label:f.label, intended:c.value, source:c.source, applied:matched, readback:after,
          persistence:'unverified', frameworkState:'unverified', reason:matched ? null : 'readback_mismatch' });
        this.emit({ phase:'input_finished', ref:c.ref, applied:matched });
        if (!matched) break;
      } catch (e) {
        receipts.push({ref:c.ref,source:c.source,applied:false,outcome:'unknown',reason:errorKind(e)});
        break; // never silently retry or fall back to another control
      }
    }
    // A later selection can clear an earlier conditional field or React can
    // revert it on another render. Recheck the whole patch before returning it.
    for (let i=0;i<receipts.length;i++) {
      const {c,toggle}=plans[i];
      if(!receipts[i].applied)continue;
      try {
        const final=await this.call('read',{ref:c.ref});
        receipts[i].finalReadback=final;
        if((toggle ? final.checked : final.value)!==c.value){receipts[i].applied=false;receipts[i].reason='later_readback_mismatch';}
      } catch(e) {receipts[i].applied=false;receipts[i].reason=errorKind(e);}
    }
    let after;
    try { after = await this.inspect(); } catch (e) { after = { observed:false, reason:errorKind(e) }; }
    let contextError=null;
    try{this.requireContext(after,snapshot);}catch(e){contextError=errorKind(e);}
    const result = { version:VERSION, receipts, complete:!contextError && receipts.length === plans.length && receipts.every(x=>x.applied), after, contextError };
    try{this.record({kind:'input_result',at:new Date().toISOString(),result});result.recordStatus='recorded';}
    catch(e){result.recordStatus='result_write_failed';result.recordError=errorKind(e);}
    return result;
  }
  async attempt(snapshot, actionRef, { windowMs = 1500, intent = 'action', fieldRef = null } = {}) {
    if (!Number.isInteger(windowMs) || windowMs < 100 || windowMs > 30000) throw new Error('windowMs must be 100..30000');
    const prior=snapshot;
    snapshot = await this.checkContext(snapshot);
    if(typeof this.record!=='function')throw new Error('mutation_record_callback_required');
    let action,choice;
    if (intent === 'action') action = snapshot.actions.find(a => a.ref === actionRef);
    else if (intent === 'open_choices') action = snapshot.fields.find(f=>f.ref===actionRef && f.role==='combobox');
    else if (intent === 'choose_option') {
      const previous=choiceContext(prior,fieldRef,actionRef);
      const current=choiceContext(snapshot,fieldRef,actionRef);
      if(JSON.stringify(previous.binding)!==JSON.stringify(current.binding))throw new Error('choice_association_changed_inspect_again');
      choice=current.binding;
      action={...current.option,fieldRef,choice};
    } else if (intent === 'press_enter') {
      action = snapshot.fields.find(f=>f.ref===actionRef && !f.redacted && !f.readonly &&
        f.tag==='input' && ['text','email','tel','url','search','number',''].includes(f.type||''));
    } else throw new Error('unknown_action_intent');
    if (!action) throw new Error('select_an_observed_action_reference');
    if (!action.visible || action.disabled) throw new Error('action_not_usable');
    const receipt = { version:VERSION, action, intent, startedAt:new Date().toISOString(),
      actionDispatch:'not_attempted', browserResponsive:null, observationWindowMs:windowMs,
      completion:'unconfirmed', persistence:'unverified', outcome:'not_evaluated',
      formStateBefore:{documentId:snapshot.documentId,locationId:snapshot.locationId,url:snapshot.url,step:snapshot.step,fields:snapshot.fields},
      payloadInspection:'not_performed_use_correlated_traffic_evidence' };
    this.events = []; this.truncated = false;
    this.emit({phase:'action_started',action});
    await this.call('arm');
    // Record the inputs and decision BEFORE any potentially committed action.
    // Storage failure stops dispatch; this is an attempt journal, not traffic capture.
    this.record({kind:'action_intent',at:receipt.startedAt,receipt});
    try {
      // Exactly one pointer gesture. A timeout may occur AFTER dispatch.
      receipt.actionDispatch = 'attempted'; await this.pointer(actionRef,choice);
      if (intent === 'press_enter') await this.key('Enter','Enter');
      receipt.actionDispatch = 'dispatched';
    } catch(e) { receipt.actionError = errorKind(e); }
    const until = Date.now()+windowMs;
    while (Date.now()<until && !this.dialog) await sleep(Math.min(50,until-Date.now()));
    receipt.browserDialog = this.dialog;
    if (!this.dialog) {
      try {
        receipt.after = await this.inspect(); receipt.browserResponsive = true;
        receipt.localEvents = await this.call('events');
        receipt.changes = changes(snapshot,receipt.after);
      } catch(e) { receipt.browserResponsive = null; receipt.observerError = errorKind(e); }
    } else receipt.observerError = 'browser_dialog_open';
    receipt.events = [...this.events]; receipt.captureTruncated = this.truncated;
    receipt.requestsObserved = receipt.events.filter(e=>e.type==='Network.requestWillBeSent');
    receipt.requestObservation = receipt.requestsObserved.length ? 'request_observed_correlation_required' : 'no_request_observed_in_this_session_window';
    receipt.diagnosis = diagnose(receipt,snapshot);
    receipt.finishedAt = new Date().toISOString();
    try{this.record({kind:'action_result',at:receipt.finishedAt,receipt});receipt.recordStatus='recorded';}
    catch(e){receipt.recordStatus='result_write_failed';receipt.recordError=errorKind(e);}
    this.emit({phase:'action_finished',diagnosis:receipt.diagnosis,completion:receipt.completion});
    return receipt;
  }
}
function safeURL(url) { try { const u=new URL(url); return u.origin+u.pathname; } catch { return null; } }
function redactFieldValues(snapshot) {
  const result=JSON.parse(JSON.stringify(snapshot));
  for(const field of result.fields||[]) {
    for(const key of ['value','display']) {
      if(typeof field[key]!=='string')continue;
      field[key+'Empty']=field[key]==='';
      if(field[key]!==''){field[key]=null;field[key+'Redacted']=true;}
    }
  }
  result.redaction='field_values_only_structure_and_empty_state_preserved';
  return result;
}
function errorKind(e) { return e.code === 'CDP_COMMAND_TIMEOUT' ? 'command_timeout_outcome_unknown' : String(e.message || e).split('\n')[0].slice(0,200); }
function guidance(s) {
  return { decisionActions:s.actions.filter(a=>a.visible).map(a=>({ref:a.ref,label:a.label,disabled:a.disabled,inScope:a.inScope,associatedWithScope:a.associatedWithScope,behaviour:a.behaviour})),
    declaredRequiredEmpty:s.fields.filter(f=>f.visible&&!f.disabled&&f.required&&!f.redacted&&
      (f.type==='radio' ? !s.fields.some(x=>x.type==='radio'&&x.name===f.name&&x.form===f.form&&x.checked) : f.type==='checkbox' ? !f.checked : f.value==='' ))
      .map(f=>({ref:f.ref,label:f.label,id:f.id,value:f.value,checked:f.checked,requiredSource:'declared_constraint',validationMessage:f.validationMessage,descriptions:f.descriptions,errors:f.errors})),
    validationFeedback:s.fields.filter(f=>f.ariaInvalid==='true'||f.validity?.valid===false||f.errors.length)
      .map(f=>({ref:f.ref,label:f.label,id:f.id,validationMessage:f.validationMessage,descriptions:f.descriptions,errors:f.errors})),
    possiblyRequiredEmpty:s.fields.filter(f=>f.visible&&!f.disabled&&!f.required&&f.requirementHints?.length&&f.value==='')
      .map(f=>({ref:f.ref,label:f.label,id:f.id,requirementHints:f.requirementHints})),
    next:'Choose an explicit action; required flags and labels are hints, not completion proof.' };
}
function changes(before,after) {
  const key = f => f.id ? `id:${f.id}` : JSON.stringify([f.name,f.label,f.type]);
  const groups = fs => { const m=new Map(); for(const f of fs){const k=key(f);m.set(k,[...(m.get(k)||[]),f]);}return m; };
  const old=groups(before.fields), now=groups(after.fields), fields=[];
  for(const [k,fs] of old){const ns=now.get(k)||[];
    if(fs.length!==1||ns.length>1){fields.push({key:k,comparison:'ambiguous'});continue;}
    if(!ns.length){fields.push({key:k,comparison:'not_present_after'});continue;}
    const a=fs[0],b=ns[0];
    if(a.redacted||b.redacted){fields.push({key:k,label:a.label,comparison:'redacted'});continue;}
    if(a.value!==b.value||a.checked!==b.checked||a.display!==b.display) fields.push({key:k,label:a.label,comparison:'changed',
      change:a.value && b.value==='' ? 'cleared' : 'value_or_selection_changed',
      before:{value:a.value,checked:a.checked,display:a.display},after:{value:b.value,checked:b.checked,display:b.display}});
    else fields.push({key:k,label:a.label,comparison:'retained'});
  }
  return { documentChanged:before.documentId!==after.documentId, urlChanged:before.locationId!==after.locationId,
    stepBefore:before.step,stepAfter:after.step,fields };
}
function diagnose(r,before) {
  if(r.browserDialog)return 'browser_dialog_open';
  if(r.after?.dialogs.some(d=>!before.dialogs.some(b=>b.ref===d.ref)))return 'in_page_dialog_appeared';
  if(r.observerError)return 'observation_incomplete';
  if(r.localEvents?.events.some(e=>e.type==='invalid'))return 'native_validation_observed';
  if(r.after?.errors.some(e=>e.source==='component_error_marker') || r.after?.fields.some(f=>f.ariaInvalid==='true'))return 'validation_feedback_present';
  if(r.after?.errors.length)return 'page_feedback_present_completion_unconfirmed';
  if(r.changes?.fields.some(f=>f.comparison==='changed' && f.before.value && f.after.value===''))return 'fields_cleared_completion_unconfirmed';
  return r.changes?.urlChanged ? 'navigation_observed_completion_unconfirmed' : 'form_observed_completion_unconfirmed';
}

// JSON input on stdin avoids candidate values in command-line arguments. stdout
// is one result; stderr carries immediate phases. Caller records restricted
// artifacts and reconciles relevant request references.
async function main() {
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  if(!input.targetId || !input.cdpHost || !input.cdpPort) throw new Error('explicit_browser_host_port_and_target_required');
  if(!['inspect','locate','apply','attempt'].includes(input.operation))throw new Error('unknown_operation');
  if(['apply','attempt'].includes(input.operation) && !input.recordPath)throw new Error('mutation_recordPath_required');
  const deadline=setTimeout(()=>{process.stdout.write(JSON.stringify({version:VERSION,observed:false,reason:'process_deadline',completion:'unconfirmed',mutationOutcome:'unknown'})+'\n');process.exit(2);},60000);
  const proxy=createCdpProxy({cdpHost:input.cdpHost,cdpPort:input.cdpPort});
  const session=await connect(proxy,input.targetId,{commandTimeoutMs:3000});
  try {
    const record=input.recordPath ? entry=>{
      const fd=fs.openSync(input.recordPath,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);
      try{fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,JSON.stringify(entry)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    } : ()=>{};
    const form=new FormAssessor(session,{scope:input.scope,frameSelector:input.frameSelector,record,emit:e=>process.stderr.write(JSON.stringify(e)+'\n')});
    let result;
    if(input.operation==='inspect'){
      result=await form.inspect();
      if(input.redactValues===true)result=redactFieldValues(result);
    }
    else if(input.operation==='locate')result=await form.locate(input.selector,{kind:input.kind});
    else {
      if(!input.snapshot)throw new Error('prior_snapshot_required');
      result=input.operation==='apply' ? await form.apply(input.snapshot,input.candidates)
        : await form.attempt(input.snapshot,input.actionRef,{windowMs:input.windowMs,intent:input.intent,fieldRef:input.fieldRef});
    }
    process.stdout.write(JSON.stringify(result)+'\n');
  } finally {session.close();clearTimeout(deadline);}
}
if(require.main===module)main().catch(e=>{process.stdout.write(JSON.stringify({version:VERSION,observed:false,reason:errorKind(e),completion:'unconfirmed'})+'\n');process.exit(1);});
module.exports={FormAssessor,VERSION,changes,guidance,redactFieldValues};
