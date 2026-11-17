'use strict';
// Synthetic application bindings; input, navigation and request mechanics are shared.
const fs=require('node:fs'),path=require('node:path');
async function execute(config){
  const root=config.browserRoot;
  const {connectSession}=require(path.join(root,'connection.js'));
  const {BrowserInteractions}=require(path.join(root,'interactions.js'));
  const {ActorBrowser}=require(path.join(root,'actors.js'));
  const {RequestObserver}=require(path.join(root,'request-observer.js'));
  const diagnostics=require(path.join(root,'diagnostics.js'));
  return diagnostics.withDiagnostics(config.diagnostics,async()=>{
    const session=await connectSession(config.connection,{commandTimeoutMs:3000});
    const record=value=>{const fd=fs.openSync(config.journal,'a',0o600);try{fs.writeSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
    const ui=new BrowserInteractions(session,{origin:config.origin,scope:'#application',record,emit:diagnostics.machinery});
    const actor=new ActorBrowser(session,{name:config.actor,origin:config.origin,generation:config.generation,
      probe:'/principal',expected:{principal:config.actor}});
    try{
      // Stage 1: establish the actual session. Warm runs retain its owned profile.
      await ui.navigate(config.origin+'/login','#login');
      const probe=await actor.observePrincipal();
      if(probe.status!==200){
        await ui.input('#account',config.actor,'synthetic fixture identity');
        await actor.fillSecret('#password','synthetic-only');
        await ui.click('#login',{expectNavigation:true});
        await ui.wait('signed-in item list',()=>ui.visible('#items'),3000);
      }
      const principal=await actor.observePrincipal();
      if(!principal.complete||principal.status!==200||principal.body.principal!==config.actor)
        throw new Error('actual_principal_differs');
      if(config.operation==='session')return {principal:principal.body.principal};
      const before=await actor.request('/items/'+config.item);
      if(!before.complete||before.status!==200||before.body.id!==config.item||before.body.creator!==config.actor||before.body.revision!==config.revision)
        throw new Error('original_resource_binding_differs');
      const contract=await actor.request('/contract');
      if(!contract.complete||contract.status!==200||contract.body.version!==1)
        throw new Error('application_context_changed');
      // Stage 2: baseline navigates the item list; a known ID permits a direct route.
      if(config.direct){await ui.navigate(config.origin+'/editor?id='+encodeURIComponent(config.item),'#save');}
      else{
        await ui.navigate(config.origin+'/items','#items');
        await ui.wait('known item link',()=>ui.visible('#'+config.item),3000);
        await ui.click('#'+config.item,{expectNavigation:true});
      }
      await ui.wait('bound editor loaded',()=>ui.evaluate("document.querySelector('#editor')?.dataset.ready==='true'"),3000);
      const current=await actor.request('/items/'+config.item);
      if(!current.complete||current.status!==200||current.body.id!==config.item||current.body.creator!==config.actor||current.body.revision!==config.revision)
        throw new Error('original_resource_binding_differs');
      // Stage 3: exercise the native editor, including its intentional invalid input.
      await ui.input('#owner',config.owner,'operator supplied owner');
      diagnostics.checkpoint();
      // Stage 4: submit and observe. Invalid-owner validation must stay in the UI.
      if(config.objective==='validation'){
        const observer=new RequestObserver(session.cdp,{record,match:e=>e.request.method==='PATCH'&&e.request.url===config.origin+'/items/'+config.item});
        observer.start();
        try{
          await ui.click('#save');
          await ui.wait('owner validation',()=>ui.evaluate("document.querySelector('#validation').textContent==='Unknown owner'"),2000);
          const captured=observer.snapshot();
          if(captured.requests.length||captured.captureError||captured.overflow)throw new Error('invalid_owner_observation_incomplete');
          return {principal:principal.body.principal,validation:'Unknown owner',dispatched:false};
        }finally{observer.dispose();}
      }
      const observer=new RequestObserver(session.cdp,{record,match:e=>e.request.method==='PATCH'&&e.request.url===config.origin+'/items/'+config.item});
      const observed=await observer.run(()=>ui.click('#save'),{windowMs:3000,readBody:true});
      if(!observed.complete||observed.requests.length!==1||observed.requests[0].status!==200)
        throw new Error('owner_write_observation_incomplete');
      await ui.navigate(config.origin+'/editor?id='+encodeURIComponent(config.item),'#save');
      await ui.wait('fresh owner readback',()=>ui.evaluate('document.querySelector("#owner").value==='+JSON.stringify(config.owner)),3000);
      return {principal:principal.body.principal,dispatched:true,owner:config.owner};
    }finally{ui.dispose();session.close();}
  });
}
module.exports={execute};
if(require.main===module){
  let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
  process.stdin.on('end',async()=>{try{console.log(JSON.stringify({complete:true,result:await execute(JSON.parse(input))}));}
    catch(error){console.log(JSON.stringify({complete:false,code:error.code||'browser_observation_incomplete',error:error.message,applicationOutcome:'unknown'}));process.exitCode=1;}});
}
