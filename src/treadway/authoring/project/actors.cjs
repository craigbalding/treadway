'use strict';
const fs=require('node:fs');
const path=require('node:path');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const {config,actor,operation,args}=input;
const {createCdpProxy,connect}=require(path.join(config.browserRoot,'cdp.js'));
const {ActorBrowser}=require(path.join(config.browserRoot,'actors.js'));
const {BrowserInteractions}=require(path.join(config.browserRoot,'interactions.js'));
(async()=>{
  let session,ui;
  try {
    session=await connect(createCdpProxy(actor.connection),actor.connection.targetId,{commandTimeoutMs:6000});
    const record=entry=>fs.appendFileSync(path.join(config.artifacts,'actors.jsonl'),JSON.stringify(entry)+'\n',{mode:0o600});
    ui=new BrowserInteractions(session,{origin:config.origin,record});
    if((await ui.evaluate('location.origin'))!==config.origin)await ui.navigate(config.origin+'/collaboration');
    const browser=new ActorBrowser(session,{name:actor.name,origin:config.origin,probe:'/api/collaboration/session',
      expected:actor.expected,generation:actor.generation});
    let result;
    if(operation==='login') {
      await browser.fillSecret('#account',args.account);
      await browser.fillSecret('#password',args.password);
      const receipt=await browser.request('/api/collaboration/login',{method:'POST',body:{account:args.account,password:args.password},verify:false});
      // Login endpoints may echo input. Retain the expected receipt, not an
      // arbitrary response body in the journal or Robot output.
      result={complete:receipt.complete,dispatched:receipt.dispatched,status:receipt.status,
        body:{loggedIn:receipt.body?.loggedIn===true}};
    } else result=await browser.request(args.path,args.options);
    record({kind:'actor_response',actor:browser.binding,path:args.path||'/api/collaboration/login',result});
    process.stdout.write(JSON.stringify({complete:result.complete,result}));
  } catch(error) {
    process.stdout.write(JSON.stringify({complete:false,error:'actor_operation_incomplete'}));
    process.exitCode=1;
  } finally {ui?.dispose();session?.close();}
})();
