'use strict';
// Explicit origin state operations. Unknown/unsupported observations never mean
// empty state. Discarding a fresh profile is preferable for actor isolation.
class OriginState {
  constructor(session,{origin}={}) {
    const url=new URL(origin);
    if(url.origin!==origin || !['http:','https:'].includes(url.protocol))throw new Error('explicit_origin_required');
    this.session=session;this.origin=origin;
  }
  async observe({timeoutMs=5000}={}) {
    const result=await this.session.cdp.send('Runtime.evaluate',{
      expression:`(${observe.toString()})(${JSON.stringify(this.origin)})`,awaitPromise:true,returnByValue:true,
    },{timeoutMs});
    if(result.exceptionDetails || !result.result?.value)throw new Error('origin_state_observation_incomplete');
    return result.result.value;
  }
  async clear({timeoutMs=5000}={}) {
    const before=await this.observe({timeoutMs});
    if(!before.complete)throw new Error('origin_state_prerequisite_incomplete');
    // Storage clears the declared origin, including HttpOnly cookies. Never use
    // Network.clearBrowserCookies, which affects other origins in the browser.
    await this.session.cdp.send('Storage.clearDataForOrigin',{
      origin:this.origin,storageTypes:'cookies,local_storage,indexeddb,cache_storage,service_workers',
    },{timeoutMs});
    const cleared=await this.session.cdp.send('Runtime.evaluate',{
      expression:`(()=>{if(location.origin!==${JSON.stringify(this.origin)})return false;sessionStorage.clear();return true;})()`,
      returnByValue:true,
    },{timeoutMs});
    if(cleared.exceptionDetails || cleared.result?.value!==true)throw new Error('session_storage_clear_incomplete');
    const after=await this.observe({timeoutMs});
    const clean=after.complete && ['localStorage','sessionStorage','indexedDB','cacheStorage','serviceWorkers'].every(key=>after[key]===0);
    // Cookie observation is made through CDP, not document.cookie (HttpOnly).
    const cookies=await this.session.cdp.send('Storage.getCookies',{}, {timeoutMs});
    if(!Array.isArray(cookies.cookies))throw new Error('cookie_observation_incomplete');
    const hostname=new URL(this.origin).hostname;
    const remaining=cookies.cookies.filter(cookie=>hostname===cookie.domain.replace(/^\./,'') || hostname.endsWith('.'+cookie.domain.replace(/^\./,''))).length;
    return {origin:this.origin,before,after,cookiesRemaining:remaining,complete:after.complete,clean:clean&&remaining===0,
      limits:['HTTP cache is outside this operation','Cookies are domain/path scoped and may affect other ports','Other open documents can repopulate storage']};
  }
}
async function observe(origin) {
  if(location.origin!==origin)return {complete:false,error:'origin_differs'};
  try {
    if(!indexedDB.databases || !('caches' in self) || !('serviceWorker' in navigator))
      return {complete:false,error:'storage_observation_unsupported'};
    return {complete:true,localStorage:localStorage.length,sessionStorage:sessionStorage.length,
      indexedDB:(await indexedDB.databases()).length,cacheStorage:(await caches.keys()).length,
      serviceWorkers:(await navigator.serviceWorker.getRegistrations()).length};
  } catch {return {complete:false,error:'storage_observation_failed'};}
}
async function main(argv=process.argv.slice(2)) {
  const value=name=>{const index=argv.indexOf('--'+name);return index<0?undefined:argv[index+1];};
  const {createCdpProxy,connect}=require('./cdp.js');
  const session=await connect(createCdpProxy({cdpHost:value('cdp-host'),cdpPort:value('cdp-port')}),value('target'));
  try {
    const result=await new OriginState(session,{origin:value('origin')}).clear();
    console.log(JSON.stringify(result));if(!result.clean)process.exitCode=1;
  }finally{session.close();}
}
module.exports={OriginState,main};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
