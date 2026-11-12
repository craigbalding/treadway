'use strict';
const {makeCdpClient}=require('./cdp.js');

async function connectBrowser(proxy,browserPath,{commandTimeoutMs=5000}={}) {
  if(typeof browserPath!=='string' || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(browserPath))
    throw new Error('explicit_browser_generation_required');
  const version=await proxy.getVersion();
  const endpoint=new URL(version.webSocketDebuggerUrl);
  if(!['ws:','wss:'].includes(endpoint.protocol) || endpoint.pathname!==browserPath || endpoint.search || endpoint.hash)
    throw new Error('browser_generation_differs');
  const ws=await proxy.cdpConnect(browserPath);
  try{return makeCdpClient(ws,{commandTimeoutMs});}
  catch(error){ws.terminate?.();throw error;}
}

function publicURL(value) {
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.origin+url.pathname:url.protocol+'[opaque]';}catch{return null;}
}

class TargetMonitor {
  constructor(cdp,{actor,origin,record,maxEvents=1000,maxTargets=64}={}) {
    if(!actor?.generation || !actor?.name || typeof record!=='function' || !Number.isSafeInteger(maxEvents) || maxEvents<=0 || !Number.isSafeInteger(maxTargets) || maxTargets<=0)
      throw new Error('explicit_monitor_scope_required');
    const url=new URL(origin);
    if(url.origin!==origin)throw new Error('explicit_origin_required');
    this.cdp=cdp;this.actor=Object.freeze({...actor});this.origin=origin;this.record=record;
    this.maxEvents=maxEvents;this.maxTargets=maxTargets;this.events=0;this.sessions=new Map();this.listeners=[];this.tasks=new Set();
    this.complete=true;this.active=false;this.errors=[];
  }
  emit(kind,data) {
    if(this.events>=this.maxEvents){this.complete=false;return;}
    this.events++;
    try{this.record({kind,declaredActor:this.actor,...data});}
    catch{this.complete=false;this.errors.push('monitor_record_failed');}
  }
  listen(client,event,handler) {
    client.on(event,handler);this.listeners.push(()=>client.off(event,handler));
  }
  track(task) {
    this.tasks.add(task);task.catch(()=>{this.complete=false;this.errors.push('target_capture_setup_incomplete');})
      .finally(()=>this.tasks.delete(task));
  }
  children(client) {
    this.listen(client,'Target.attachedToTarget',({sessionId,targetInfo})=>{
      if(!this.active)return;
      this.track(this.attach(sessionId,targetInfo));
    });
    this.listen(client,'Target.detachedFromTarget',({sessionId})=>{
      const entry=this.sessions.get(sessionId);
      if(entry) {
        for(const remove of entry.remove)remove();
        this.sessions.delete(sessionId);
        this.cdp.removeSession?.(sessionId);
        this.emit('target_detached',{cdpSessionId:sessionId,targetId:entry.info.targetId});
      }
    });
  }
  async attach(id,info) {
    if(this.sessions.has(id))return;
    if(this.sessions.size>=this.maxTargets){this.complete=false;this.errors.push('target_limit');return;}
    const session=this.cdp.session(id),remove=[];
    this.sessions.set(id,{session,info,remove});
    const listen=(event,handler)=>{session.on(event,handler);remove.push(()=>session.off(event,handler));};
    const common={cdpSessionId:id,targetId:info.targetId,targetType:info.type};
    this.emit('target_attached',{...common,url:publicURL(info.url)});
    // Request IDs are unique only within their CDP session. No temporal causal
    // association, response-body capture or credential headers are implied.
    const requests=new Set();
    listen('Network.requestWillBeSent',event=>{
      let url;try{url=new URL(event.request.url);}catch{return;}
      if(url.origin!==this.origin)return;
      if(requests.size>=this.maxEvents){this.complete=false;return;}
      requests.add(event.requestId);
      this.emit('request',{...common,requestId:event.requestId,url:publicURL(url.href),method:event.request.method});
    });
    for(const [event,kind] of [['Network.responseReceived','response'],['Network.loadingFinished','loaded'],['Network.loadingFailed','failed']])
      listen(event,value=>{
        if(!requests.has(value.requestId))return;
        this.emit(kind,{...common,requestId:value.requestId,...(kind==='response'?{status:value.response.status}:{})});
        if(kind!=='response')requests.delete(value.requestId);
      });
    const start=this.listeners.length;
    this.children(session);
    // Remove child lifecycle listeners on detachment too.
    remove.push(...this.listeners.splice(start));
    await session.send('Network.enable');
    if(this.active)await session.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
    const entry=this.sessions.get(id);if(entry)entry.ready=true;
  }
  async start() {
    if(this.active)throw new Error('monitor_already_started');
    this.active=true;
    this.children(this.cdp);
    try {
      await this.cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
      await Promise.all([...this.tasks]);
      return this;
    }catch(error){await this.close();throw error;}
  }
  async close() {
    this.active=false;
    // Disable only this monitor's attachment subscriptions. Never pause targets,
    // accept dialogs, inject request headers or alter application state.
    const pending=await Promise.allSettled([...this.tasks]);
    const results=[];
    // Parents can detach their children when auto-attach is disabled. Release
    // descendants before parents rather than racing those commands in parallel.
    for(const entry of [...this.sessions.values()].reverse()) {
      results.push(...await Promise.allSettled([entry.session.send('Target.setAutoAttach',{
        autoAttach:false,waitForDebuggerOnStart:false,flatten:true,
      })]));
    }
    const rootResult=await Promise.allSettled([this.cdp.send('Target.setAutoAttach',{autoAttach:false,waitForDebuggerOnStart:false,flatten:true})]);
    if([...pending,...results,...rootResult].some(result=>result.status==='rejected')){
      this.complete=false;
      for(const result of [...pending,...results,...rootResult])if(result.status==='rejected')this.errors.push(String(result.reason?.message||'capture_shutdown_incomplete').slice(0,200));
    }
    for(const remove of this.listeners)remove();this.listeners=[];
    for(const entry of this.sessions.values())for(const remove of entry.remove)remove();
    this.sessions.clear();
    return {complete:this.complete,events:this.events,errors:[...this.errors],
      limits:['Observation starts after attachment; earlier traffic may be absent','Actor labels are declarations, not principal verification','Metadata only; bodies require an explicit scoped observer']};
  }
}
module.exports={connectBrowser,TargetMonitor};
