'use strict';
// Application mappings live here; mechanics come from the installed wheel.
const fs=require('node:fs');
const path=require('node:path');

// Read-only readiness used by the actual shared Autocomplete API and offline tests.
async function ownerReady(ui,query,person){
  return ui.evaluate(`(()=>{const list=document.querySelector('#owner-results');
    const options=list?[...list.querySelectorAll('[role=option]')]:[];
    return !!list&&!list.hidden&&list.dataset.query===${JSON.stringify(query)}&&options.length===1&&
      options[0].dataset.id===${JSON.stringify(person.id)}&&options[0].textContent===${JSON.stringify(person.name)};})()`);
}
async function locateOwner(ui,person){
  const located=await ui.form.call('locate',{selector:`[role=option][data-id="${person.id}"]`});
  if(located.matchCount!==undefined&&located.matchCount!==1||!located.ref)throw new Error('one_actual_owner_option_required');
  return located.ref;
}
function sameBinding(actual,binding){
  return actual&&actual.id===binding.id&&actual.run===binding.run&&actual.actor==='fixture-author'&&actual.revision===binding.revision;
}
async function execute(config,operation,args){
  const {createCdpProxy,connect}=require(path.join(config.browserRoot,'cdp.js'));
  const {BrowserInteractions}=require(path.join(config.browserRoot,'interactions.js'));
  const {Autocomplete,DateRange,RichTextEditor,PreparedEdit}=require(path.join(config.browserRoot,'widgets.js'));
  const {RequestObserver}=require(path.join(config.browserRoot,'request-observer.js'));
  const session=await connect(createCdpProxy({cdpHost:'127.0.0.1',cdpPort:config.cdpPort}),config.targetId,{commandTimeoutMs:4000});
  const record=value=>{const fd=fs.openSync(path.join(config.artifacts,'attempts.jsonl'),'a',0o600);try{fs.writeSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  const ui=new BrowserInteractions(session,{origin:config.origin,scope:'#application',record,emit:(phase,data)=>process.stderr.write(JSON.stringify({phase,...data})+'\n')});
  async function actual(id){
    const response=await fetch(config.origin+'/api/items/'+id,{signal:AbortSignal.timeout(3000)});
    if(response.status!==200)throw new Error('resource_observation_incomplete');
    return response.json();
  }
  async function guard(binding){
    if(!sameBinding(await actual(binding.id),binding))throw new Error('resource_revision_changed_inspect_again');
    const current=await ui.evaluate(`(()=>{const e=document.querySelector('#resource');return {id:e?.dataset.id,revision:Number(e?.dataset.revision),actor:document.querySelector('#actor')?.textContent};})()`);
    if(current.id!==binding.id||current.revision!==binding.revision||current.actor!=='fixture-author')throw new Error('live_resource_or_actor_differs');
    return true;
  }
  function editor(binding){return new PreparedEdit(ui,{name:'work-item-plan',fields:{owner:{selector:'#owner'},start:{selector:'#start'},due:{selector:'#due'},note:{selector:'#note',interaction:'insert_plain_text'}},action:{selector:'#save'},nativeForm:{selector:'#edit',action:config.origin+'/api/items/'+binding.id,method:'post',methodOverride:null}});}
  async function correlated(route,action,status){
    const observer=new RequestObserver(session.cdp,{record,match:e=>e.request.method==='POST'&&e.request.url===config.origin+route});
    const observed=await observer.run(action,{windowMs:4000,readBody:true});
    record({kind:'application_response',observed});
    if(!observed.complete||!observed.action.returned||observed.requests.length!==1||observed.requests[0].status!==status)throw new Error('expected_application_response_not_established');
    return JSON.parse(observed.requests[0].body);
  }
  try{
    if(operation==='create'){
      await ui.navigate(config.origin+'/?run='+config.run,'#create-button');
      await ui.wait('synthetic actor',async()=>await ui.evaluate("document.querySelector('#actor').textContent==='fixture-author'"),2000);
      await ui.input('#title',args.title,'requested synthetic work item');
      const created=await correlated('/api/items',()=>ui.click('#create-button'),201);
      // Preserve the actual ID immediately, even if a later observation fails.
      record({kind:'resource_created',binding:created});
      await ui.wait('created editor',()=>ui.visible('#save'),2000);
      return created;
    }
    await guard(args.binding);
    if(operation==='prepare'){
      const people=await (await fetch(config.origin+'/api/people?q='+encodeURIComponent(args.owner),{signal:AbortSignal.timeout(3000)})).json();
      const matches=people.people.filter(person=>person.name===args.owner);
      if(matches.length!==1)throw new Error('exact_actual_owner_required');
      const person=matches[0],choice=new Autocomplete(ui,{field:'#owner',windowMs:2000});
      const prepared=await choice.prepare({snapshot:await ui.form.inspect(),query:person.name,source:'requested owner',label:person.name,ready:()=>ownerReady(ui,person.name,person)});
      const optionRef=await locateOwner(ui,person);
      await choice.select(prepared,{label:person.name,optionRef,validateOption:async()=>await ownerReady(ui,person.name,person)});
      const action={selector:'#save'};
      await new DateRange(ui,{start:'#start',due:'#due',action}).prepare({snapshot:await ui.form.inspect(),start:args.start,due:args.due,source:'requested explicit schedule'});
      await new RichTextEditor(ui,{editor:'#note',action}).prepare({snapshot:await ui.form.inspect(),value:args.note,source:'requested literal handoff note'});
      const values={owner:person.name,start:args.start,due:args.due,note:args.note};
      return {binding:args.binding,expected:{ownerId:person.id,start:args.start,due:args.due,note:args.note},prepared:await editor(args.binding).bind({snapshot:await ui.form.inspect(),values})};
    }
    if(operation==='commit'){
      const plan=args.plan;
      await guard(plan.binding);
      const result=await correlated('/api/items/'+plan.binding.id,()=>editor(plan.binding).commit(plan.prepared,{validate:async()=>{
        await guard(plan.binding);
        const id=await ui.evaluate("document.querySelector('#owner-id').value");
        if(id!==plan.expected.ownerId)throw new Error('selected_actual_owner_differs');
        return true;
      }}),200);
      if(result.id!==plan.binding.id||result.revision!==plan.binding.revision+1)throw new Error('saved_binding_differs');
      return result;
    }
    if(operation==='reload'){
      await ui.navigate(config.origin+'/?run='+config.run+'&id='+args.binding.id,'#save');
      await guard(args.binding);
      return await ui.evaluate("({ownerId:document.querySelector('#owner-id').value,start:document.querySelector('#start').value,due:document.querySelector('#due').value,note:document.querySelector('#note').textContent})");
    }
    throw new Error('unknown_explicit_operation');
  }finally{ui.dispose();session.close();}
}
module.exports={ownerReady,locateOwner,sameBinding,execute};
if(require.main===module){
  let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
  process.stdin.on('end',async()=>{try{const {config,operation,args}=JSON.parse(input);const result=await execute(config,operation,args);console.log(JSON.stringify({complete:true,result}));}catch(error){console.log(JSON.stringify({complete:false,error:error.message,applicationOutcome:'unknown'}));process.exitCode=1;}});
}
