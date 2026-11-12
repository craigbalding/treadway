'use strict';
const path=require('node:path');
const fs=require('node:fs');
const readline=require('node:readline');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../../src/treadway/browser');
const {launch}=require(path.join(root,'launcher.js'));
const {connect,createCdpProxy}=require(path.join(root,'cdp.js'));
const {BrowserInteractions}=require(path.join(root,'interactions.js'));
const {Autocomplete,DateRange}=require(path.join(root,'widgets.js'));
const {RequestObserver}=require(path.join(root,'request-observer.js'));
function deadline(promise,ms,reason){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(reason)),ms);})]).finally(()=>clearTimeout(timer));
}
function processRecord(pid){
  try{
    const raw=fs.readFileSync('/proc/'+pid+'/stat','utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');
    return {pid:Number(pid),parent:Number(fields[1]),identity:fields[19]};
  }catch{return null;}
}
async function stopOwnedTree(rootPid,rootIdentity){
  // Snapshot only descendants of our exact worker, retaining start identities
  // before signalling so a reused PID cannot identify a different process.
  if(!rootIdentity||processRecord(rootPid)?.identity!==rootIdentity)return;
  const records=fs.readdirSync('/proc').filter(name=>/^\d+$/.test(name)).map(processRecord).filter(Boolean);
  const owned=new Set([rootPid]);let changed=true;
  while(changed){changed=false;for(const record of records)if(owned.has(record.parent)&&!owned.has(record.pid)){owned.add(record.pid);changed=true;}}
  const targets=records.filter(record=>owned.has(record.pid));
  const signal=value=>{for(const record of targets.reverse())if(processRecord(record.pid)?.identity===record.identity)try{process.kill(record.pid,value);}catch(error){if(error.code!=='ESRCH')throw error;}};
  signal('SIGTERM');await new Promise(resolve=>setTimeout(resolve,100));signal('SIGKILL');
  const end=Date.now()+1000;
  while(targets.some(record=>processRecord(record.pid)?.identity===record.identity)){
    if(Date.now()>=end)throw Error('owned worker processes not observed gone after forced shutdown');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
class NativeDriver{
  async start(directory){
    this.browser=await launch({root:directory});
    this.session=await connect(createCdpProxy(this.browser.connection),this.browser.connection.targetId,{commandTimeoutMs:5000});
    await this.session.cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
  }
  launchObservation(){
    const session=this.browser.session;
    return {pid:session.pid,args:fs.readFileSync('/proc/'+session.pid+'/cmdline','utf8').split('\0').filter(Boolean),profile:session.profile,
      profileMode:'0o'+(fs.statSync(session.profile).mode&0o777).toString(8)};
  }
  async context(url){
    this.ui=new BrowserInteractions(this.session,{origin:new URL(url).origin,record:()=>{}});
    await this.ui.navigate(url);return 'owned-profile';
  }
  evaluate(expression){return this.ui.evaluate(expression);}
  navigate(url){return this.ui.navigate(url);}
  input(selector,value){return this.ui.input(selector,value,'synthetic comparison input');}
  click(selector){return this.ui.click(selector,{windowMs:100});}
  wait(expression){return this.ui.wait('comparison predicate',()=>this.evaluate(expression),5000);}
  async query(){
    this.choice=new Autocomplete(this.ui,{field:'#choice'});
    const opened=await this.choice.prepare({snapshot:await this.ui.form.inspect(),open:true});
    this.opened=opened;
    // readiness is observed independently before the prepared controller is retained.
    this.pending=this.choice.prepare({snapshot:opened.snapshot,query:'Alpha',source:'synthetic comparison query',ready:({list})=>list.options.length===1&&list.options[0].label==='Alpha'});
    // Avoid an unhandled rejection while the harness observes the pending request.
    this.pending.catch(()=>{});
  }
  async choose(id='8'){
    const prepared=await this.pending;
    return this.choice.select(prepared,{label:'Alpha',validateOption:async({option})=>
      (await this.ui.form.call('locate',{selector:'[role="option"][data-id='+JSON.stringify(id)+']'})).ref===option.ref,windowMs:100});
  }
  async prepareEdit(values){
    this.dates=new DateRange(this.ui,{start:'#start',due:'#due',action:{selector:'#date-save'},nativeForm:{selector:'#date-form',action:this.ui.origin+'/save/dates',method:'post',methodOverride:'patch'}});
    this.edit=await this.dates.prepare({snapshot:await this.ui.form.inspect(),...values,source:'synthetic comparison dates'});
  }
  async response(endpoint,dispatch){
    const observer=new RequestObserver(this.session.cdp,{match:event=>event.request.method==='POST'&&new URL(event.request.url).pathname===endpoint,record:()=>{}});
    const observed=await observer.run(dispatch,{windowMs:2000,readBody:true});
    if(!observed.action.returned)throw Error(observed.action.reason);
    if(!observed.complete||observed.requests.length!==1)throw Error('one_complete_response_required');
    return {status:observed.requests[0].status,body:JSON.parse(observed.requests[0].body),requests:observed.requests.length};
  }
  saveChoice(){return this.response('/save/choice',()=>this.click('#choice-save'));}
  commitEdit(observe=true){return observe?this.response('/save/dates',()=>this.dates.commit(this.edit,{windowMs:100})):this.dates.commit(this.edit,{windowMs:100});}
  async close(){this.ui?.dispose();this.session?.close();if(this.browser)await this.browser.stop();}
}
class BrowserWorker{
  constructor(python,log){
    this.serial=0;this.pending=new Map();
    this.process=spawn(python,['-u',path.join(__dirname,'worker.py')],{stdio:['pipe','pipe','pipe'],env:process.env,cwd:path.dirname(log)});
    this.identity=processRecord(this.process.pid)?.identity;
    this.log=fs.createWriteStream(log,{flags:'wx',mode:0o600});this.process.stderr.pipe(this.log);
    readline.createInterface({input:this.process.stdout}).on('line',line=>{
      if(!line.startsWith('@comparison@')){this.log.write(line+'\n');return;}
      const result=JSON.parse(line.slice(12)),pending=this.pending.get(result.id);if(!pending)return;
      clearTimeout(pending.timer);this.pending.delete(result.id);
      if(result.ok)pending.resolve(result.value);else pending.reject(Error(result.error));
    });
    this.exited=new Promise(resolve=>{
      const finish=(code,signal,error)=>{
        if(this.exitResult)return;
        this.exitResult={code,signal,error:error?.message};
        for(const {reject,timer}of this.pending.values()){clearTimeout(timer);reject(error||Error('Browser worker exited '+code+' '+signal));}
        this.pending.clear();resolve(this.exitResult);
      };
      this.process.once('exit',(code,signal)=>finish(code,signal));
      this.process.once('error',error=>finish(null,null,error));
    });
    this.process.stdin.on('error',error=>{
      for(const {reject,timer}of this.pending.values()){clearTimeout(timer);reject(error);}this.pending.clear();
    });
  }
  call(op,data={},timeoutMs=30000){
    if(this.exitResult)return Promise.reject(Error('Browser worker already exited'));
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Browser worker deadline: '+op+'; effects unknown'));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});this.process.stdin.write(JSON.stringify({id,op,data})+'\n');
    });
  }
  async close(){
    let failure;
    try{
      if(!this.exitResult)await deadline(this.call('close',{},5000).then(()=>this.exited),5000,'Browser worker shutdown deadline');
    }catch(error){
      failure=error;
      await stopOwnedTree(this.process.pid,this.identity).catch(error=>{failure=Error(failure.message+'; '+error.message);});
      await deadline(this.exited,1000,'forced Browser worker exit not observed').catch(()=>{});
    }finally{
      for(const {reject,timer}of this.pending.values()){clearTimeout(timer);reject(Error('worker closed; effects unknown'));}this.pending.clear();
      this.process.stdin.destroy();this.process.stdout.destroy();this.process.stderr.unpipe(this.log);this.process.stderr.destroy();this.log.end();
    }
    if(failure)throw Error('Browser worker forced shutdown; cleanup/effects unconfirmed: '+failure.message);
  }
}
class BrowserDriver{
  constructor(worker){this.worker=worker;}
  async context(url){this.contextId=await this.worker.call('context',{url});return this.contextId;}
  switch(){return this.worker.call('switch',{context:this.contextId});}
  evaluate(expression){return this.worker.call('evaluate',{expression});}
  navigate(url){return this.worker.call('navigate',{url});}
  input(selector,value){return this.worker.call('input',{selector,value});}
  click(selector){return this.worker.call('click',{selector});}
  wait(expression){return this.worker.call('wait',{expression});}
  async query(){await this.click('#choice');await this.input('#choice','Alpha');}
  choose(id='8'){return this.worker.call('choose',{id,label:'Alpha'});}
  saveChoice(){return this.worker.call('save-choice');}
  prepareEdit(values){return this.worker.call('prepare-edit',values);}
  commitEdit(){return this.worker.call('commit-edit');}
}
module.exports={NativeDriver,BrowserWorker,BrowserDriver};
