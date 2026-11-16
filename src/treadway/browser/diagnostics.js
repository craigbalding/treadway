'use strict';
// Safe subprocess diagnostics. Final result JSON remains exclusively on stdout.
const {AsyncLocalStorage}=require('node:async_hooks');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const context=new AsyncLocalStorage();
let stderrBroken=false,stderrHandlerInstalled=false;
const stages=new Set(['app_host','email','picker','password','password_persist','totp','kmsi','locked',
  'password_change','password_error','code_error','unknown','registration_secret','registration_other_app',
  'registration_manual','registration_complete','registration_redirect','registration_install',
  'registration_add_account','registration_qr','registration_intro']);
const events=new Set(['cdp_started','cdp_finished','browser_started','browser_finished','browser_screen',
  'browser_action_started','browser_action_finished','browser_wait_started','browser_wait_finished',
  'cookie_export_started','cookie_export_finished','implementation_changed','contract_mismatch',
  'bridge_started','bridge_finished','principal_probe_started','principal_probe_finished']);
const outcomes=new Set(['completed','failed','unknown','verified','expected','wrong','not_dispatched']);
const changedContracts=new Set(['form_context_changed_inspect_again','native_form_binding_differs',
  'prepared_edit_value_or_reference_changed','prepared_edit_selector_binding_changed','prepared_edit_action_changed',
  'prepared_native_form_replaced','choice_association_changed_inspect_again','frame_binding_changed',
  'screen_changed','untrusted_idp_origin','credential_account_differs','application_context_changed']);
function contractMismatch(code){
  if(changedContracts.has(code))emit('contract_mismatch',{contract_ref:reference(code),material:true,
    reason:'contract_mismatch',dispatch:'not_started'},'ERROR');
}
function reference(value){const state=context.getStore();
  return crypto.createHmac('sha256',state?.key||'disabled').update(String(value)).digest('hex').slice(0,24);}
function emit(event,fields={},level='DEBUG'){
  const state=context.getStore();if(!state)return;
  if(stderrBroken){state.dropped++;return;}
  // Only fields constructed here/from calibrated operations are admitted.
  const safe={};
  for(const [key,value] of Object.entries(fields)){
    if(['duration_ms','bytes'].includes(key)&&typeof value==='number'&&Number.isFinite(value))safe[key]=value;
    else if(['complete','material'].includes(key)&&typeof value==='boolean')safe[key]=value;
    else if(key==='stage'&&stages.has(value))safe[key]=value;
    else if(key==='principal'&&['expected','wrong','unknown'].includes(value))safe[key]=value;
    else if(key==='http_status'&&Number.isInteger(value)&&value>=100&&value<=599)safe[key]=value;
    else if(key==='outcome'&&outcomes.has(value))safe[key]=value;
    else if(key==='dispatch'&&['not_started','possibly_started'].includes(value))safe[key]=value;
    else if(key.endsWith('_ref')&&typeof value==='string'&&/^[0-9a-f]{24}$/.test(value))safe[key]=value;
    else if(key==='reason'&&['implementation_changed','source_unavailable','contract_mismatch'].includes(value))safe[key]=value;
  }
  if(!events.has(event)||!['DEBUG','INFO','WARNING','ERROR'].includes(level))return;
  const value={treadway_event:{run_id:state.configuration.run_id,producer_id:state.configuration.producer_id,
    sequence:++state.sequence,event,level,fields:safe}};
  // Process stderr backpressure cannot grow memory without limit.
  if(process.stderr.writableLength>65536){state.dropped++;return;}
  try{process.stderr.write(JSON.stringify(value)+'\n');}catch{state.dropped++;}
}
function fingerprint(file){try{return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}catch{return null;}}
function checkpoint(){
  const state=context.getStore();if(!state?.configuration.guard_enabled&&!state?.configuration.guard_runtime)return;
  for(const [file,expected] of state.files){
    const observed=fingerprint(file);
    if(observed!==expected){
      const report={source_ref:reference(file),expected_ref:reference(expected),observed_ref:reference(observed),
        reason:observed===null?'source_unavailable':'implementation_changed',material:true,dispatch:'not_started'};
      emit('implementation_changed',report,'ERROR');
      if(state.configuration.evidence_directory){
        try{
          const record=path.join(state.configuration.evidence_directory,'change-'+crypto.randomUUID()+'.json');
          fs.writeFileSync(record,JSON.stringify({report,path:file,expected_fingerprint:expected,observed_fingerprint:observed}),{flag:'wx',mode:0o600});
        }catch{state.dropped++;}
      }
      const error=new Error('flow_implementation_changed');error.code='FLOW_CHANGED';error.report=report;throw error;
    }
  }
}
function machinery(phase,event={}){
  if(phase==='input_started'||phase==='action_started')emit('browser_action_started',{},'INFO');
  else if(phase==='input_finished'||phase==='action_finished')emit('browser_action_finished',{
    outcome:phase==='input_finished'?event.applied===true?'completed':'unknown':
      event.actionDispatch==='dispatched'&&event.recordStatus==='recorded'?'completed':'unknown'},'INFO');
}
async function wait(work){
  const started=performance.now();let outcome='unknown';
  emit('browser_wait_started');
  try{const result=await work();outcome='completed';return result;}
  finally{emit('browser_wait_finished',{outcome,duration_ms:performance.now()-started},outcome==='unknown'?'WARNING':'DEBUG');}
}
function command(method){
  const state=context.getStore();if(!state)return ()=>{};
  const started=performance.now(),target_ref=reference(method);
  emit('cdp_started',{target_ref});
  return error=>context.run(state,()=>emit('cdp_finished',{
    target_ref,duration_ms:performance.now()-started,outcome:error?'unknown':'completed'},error?'WARNING':'DEBUG'));
}
async function withDiagnostics(configuration,work){
  if(!configuration)return work();
  if(!stderrHandlerInstalled){
    process.stderr.on('error',()=>{stderrBroken=true;});
    stderrHandlerInstalled=true;
  }
  if(!/^[0-9a-f]{32}$/.test(configuration.run_id||'')||!/^[0-9a-f]{32}$/.test(configuration.producer_id||''))
    throw new Error('explicit_diagnostic_context_required');
  const files=configuration.guard_sources?.map(value=>[value.path,value.sha256])||
    Object.keys(require.cache).filter(file=>file.startsWith(__dirname+path.sep)).map(file=>[file,fingerprint(file)]);
  const key=/^[0-9a-f]{64}$/.test(configuration.reference_key||'')?Buffer.from(configuration.reference_key,'hex'):crypto.randomBytes(32);
  return context.run({configuration,sequence:0,key,files,dropped:0},async()=>{
    emit('bridge_started',{},'DEBUG');
    let completed=false;
    try{const result=await work();completed=result!==1;return result;}
    catch(error){contractMismatch(error.message);throw error;}
    finally{emit('bridge_finished',{outcome:completed?'completed':'unknown',complete:context.getStore().dropped===0},'DEBUG');}
  });
}
module.exports={withDiagnostics,emit,reference,checkpoint,machinery,command,contractMismatch,wait};
