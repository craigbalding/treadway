'use strict';
// Private JSON-lines bridge for Python consumers of the same Node CDP client.
const readline=require('node:readline');
const {connectSession,observeSession}=require('./connection.js');
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const write=value=>process.stdout.write(JSON.stringify(value)+'\n');
let session,initializing=false;
lines.on('line',async line=>{
  try {
    const value=JSON.parse(line);
    if(!session) {
      if(initializing)throw new Error('bridge_not_ready');initializing=true;
      session=await (value.observationOnly===true?observeSession:connectSession)(value.connection||value,{commandTimeoutMs:value.commandTimeoutMs||5000});
      for(const event of value.events||[])session.cdp.on(event,params=>write({method:event,params}));
      write({ready:true});return;
    }
    try{write({id:value.id,result:await session.cdp.send(value.method,value.params||{},value.options||{})});}
    catch(error){write({id:value.id,error:{
      code:typeof error.code==='string'&&/^(?:remote_|ipc_)[a-z_]+$/.test(error.code)?error.code:'cdp_command_incomplete',
      outcome:error.outcome==='not_dispatched'?'not_dispatched':'unknown'}});}
  } catch {write({error:{code:-1,message:'CDP bridge incomplete; outcome unknown'}});session?.close();process.exitCode=1;lines.close();}
});
lines.on('close',()=>{session?.close();});
