#!/usr/bin/env node
'use strict';
// A thin JSON transport for native Robot keywords. Profiles describe component
// controls only; there is no application workflow or completion evaluator here.
const fs=require('node:fs');
const {createCdpProxy,connect}=require('./cdp.js');
const {BrowserInteractions}=require('./interactions.js');
const {Autocomplete,MultiSelect,DateRange,RichTextEditor,InlineEditor,PreparedEdit}=require('./widgets.js');
function createWidget(ui,kind,profile){
  if(!profile||typeof profile!=='object'||Array.isArray(profile))throw new Error('explicit_widget_profile_required');
  if(kind==='autocomplete')return new Autocomplete(ui,profile);
  if(kind==='date_range')return new DateRange(ui,profile);
  if(kind==='rich_text')return new RichTextEditor(ui,profile);
  if(kind==='inline_editor')return new InlineEditor(ui,profile);
  if(kind==='prepared_edit')return new PreparedEdit(ui,profile);
  if(kind==='multi_select'){
    const {selection,removal,...options}=profile;
    if(typeof selection?.selector!=='string'||!/^data-[a-z0-9_-]+$/.test(selection.attribute)||removal&&
      (typeof removal.scope!=='string'||!/^data-[a-z0-9_-]+$/.test(removal.attribute)))throw new Error('explicit_widget_selection_mapping_required');
    return new MultiSelect(ui,{...options,readSelection:()=>ui.evaluate(`([...document.querySelectorAll(${JSON.stringify(selection.selector)})].map(e=>e.getAttribute(${JSON.stringify(selection.attribute)})))`),
      ...(removal?{removeSelector:id=>removal.scope+' ['+removal.attribute+'='+JSON.stringify(String(id))+']'}:{})});
  }
  throw new Error('unsupported_widget_profile_kind');
}
async function execute(ui,input){
  const widget=createWidget(ui,input.kind,input.profile),args=input.arguments||{};
  if(input.operation==='inspect')return ui.form.inspect();
  if(input.operation==='open'&&input.kind==='inline_editor')return widget.open(args);
  if(input.operation==='prepare_choice'&&['autocomplete','multi_select'].includes(input.kind))return widget.prepare(args);
  if(input.operation==='select_choice'&&['autocomplete','multi_select'].includes(input.kind)){
    const {prepared,optionSelector,...options}=args;
    const validateOption=optionSelector?async({option})=>(await ui.form.call('locate',{selector:optionSelector})).ref===option.ref:undefined;
    const result=await widget.select(prepared,{...options,validateOption});
    return input.kind==='multi_select'?result:{receipt:result};
  }
  if(input.operation==='remove_choice'&&input.kind==='multi_select')return widget.remove(args);
  if(input.operation==='prepare_edit'&&['date_range','rich_text','inline_editor','prepared_edit'].includes(input.kind)){
    const {snapshot,values,source}=args;
    if(input.kind==='date_range'){
      if(!values||Object.keys(values).sort().join(',')!=='due,start')throw new Error('exact_date_range_fields_required');
      return widget.prepare({snapshot,start:values.start,due:values.due,source});
    }
    if(input.kind==='rich_text'){
      if(!values||Object.keys(values).join(',')!=='content')throw new Error('exact_plain_text_field_required');
      return widget.prepare({snapshot,value:values.content,source});
    }
    return widget.prepare({snapshot,values,source});
  }
  if(input.operation==='commit_edit'&&['date_range','rich_text','inline_editor','prepared_edit'].includes(input.kind))return widget.commit(args.prepared,{windowMs:args.windowMs,allowTransition:args.allowTransition});
  throw new Error('unsupported_widget_operation');
}
async function main(){
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  if(!input.cdpHost||!input.cdpPort||!input.targetId||!input.origin||!input.recordPath)throw new Error('explicit_browser_origin_target_and_journal_required');
  createWidget(null,input.kind,input.profile); // Offline validation before connect.
  const record=entry=>{
    const fd=fs.openSync(input.recordPath,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);
    try{fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,JSON.stringify(entry)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  };
  const deadline=setTimeout(()=>{process.stdout.write(JSON.stringify({version:'treadway.widget/1',mechanicsComplete:false,reason:'process_deadline',mutationOutcome:'unknown'})+'\n');process.exit(2);},60000);
  let session,ui;
  try{
    session=await connect(createCdpProxy({cdpHost:input.cdpHost,cdpPort:input.cdpPort}),input.targetId,{commandTimeoutMs:3000});
    ui=new BrowserInteractions(session,{origin:input.origin,scope:input.scope,frameSelector:input.frameSelector,record,emit:(phase,event)=>process.stderr.write(JSON.stringify({phase,...event})+'\n')});
    if(await ui.evaluate('location.origin')!==input.origin)throw new Error('widget_browser_origin_differs');
    const result=await execute(ui,input);
    process.stdout.write(JSON.stringify({version:'treadway.widget/1',mechanicsComplete:true,result,applicationOutcome:'not_evaluated'})+'\n');
  }finally{if(ui)ui.dispose();if(session)session.close();clearTimeout(deadline);}
}
if(require.main===module)main().catch(error=>{process.stdout.write(JSON.stringify({version:'treadway.widget/1',mechanicsComplete:false,reason:error.code==='CDP_COMMAND_TIMEOUT'?'command_timeout_outcome_unknown':String(error.message).split('\n')[0].slice(0,200),mutationOutcome:'unknown'})+'\n');process.exitCode=1;});
module.exports={createWidget,execute};
