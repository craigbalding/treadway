'use strict';
// Application mappings supply the principal endpoint and expectations. This
// library never logs in, renews, changes actor or retries an application action.
const crypto = require('node:crypto');
const secretFieldSource = require('node:fs').readFileSync(require('node:path').join(__dirname,'browser-fill.function.js'),'utf8');

class ActorBrowser {
  constructor(session, {name, origin, probe, expected, generation, maxBodyBytes=65536}={}) {
    const url=new URL(origin);
    if(url.origin!==origin || !['http:','https:'].includes(url.protocol) || !name || !generation ||
      !expected || typeof expected!=='object' || Array.isArray(expected) || !Object.keys(expected).length ||
      !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes<=0) throw new Error('explicit_actor_session_required');
    for(const [path,value] of Object.entries(expected)) {
      if(!path || path.split('.').some(part=>!part) || (value!==null && !['string','boolean','number'].includes(typeof value)))
        throw new Error('concrete_principal_expectations_required');
    }
    this.session=session;
    this.binding=Object.freeze({name,origin,generation,sessionId:crypto.randomUUID()});
    this.expected=Object.freeze({...expected});
    this.probe=this.path(probe);
    this.maxBodyBytes=maxBodyBytes;
  }
  path(value) {
    if(typeof value!=='string' || !value.startsWith('/') || value.startsWith('//')) throw new Error('same_origin_path_required');
    const url=new URL(value,this.binding?.origin || 'http://fixture.invalid');
    if(this.binding && url.origin!==this.binding.origin || url.hash || url.username || url.password)
      throw new Error('same_origin_path_required');
    return url.pathname+url.search;
  }
  async request(path,{method='GET',body,verify=true,timeoutMs=5000}={}) {
    path=this.path(path);
    if(!['GET','POST','PUT','PATCH','DELETE'].includes(method) || !Number.isSafeInteger(timeoutMs) || timeoutMs<=0)
      throw new Error('bounded_explicit_request_required');
    // Verification and the requested operation execute in the same page/session.
    // The application response remains authoritative if authentication changes.
    const input={origin:this.binding.origin,probe:this.probe,expected:this.expected,path,method,body,verify,
      timeoutMs,maxBodyBytes:this.maxBodyBytes};
    const result=await this.session.cdp.send('Runtime.evaluate',{
      expression:`(${browserRequest.toString()})(${JSON.stringify(input)})`,awaitPromise:true,returnByValue:true,
    },{timeoutMs:timeoutMs+1000});
    if(result.exceptionDetails || !result.result || !Object.hasOwn(result.result,'value'))
      throw new Error('actor_request_incomplete; application effect unknown');
    const observation={actor:this.binding,...result.result.value};
    if(observation.prerequisiteError) {
      const error=new Error(observation.prerequisiteError);error.observation=observation;throw error;
    }
    return observation;
  }
  async observePrincipal() {
    return this.request(this.probe,{verify:false});
  }
  async fillSecret(selector,value,{timeoutMs=3000}={}) {
    if(typeof selector!=='string' || typeof value!=='string') throw new Error('explicit_secret_field_required');
    const response=await this.session.cdp.send('Runtime.evaluate',{
      expression:`${secretFieldSource}(${JSON.stringify({origin:this.binding.origin,selector,value})})`,
      returnByValue:true,
    },{timeoutMs});
    if(response.exceptionDetails || response.result?.value?.ok!==true) throw new Error('secret_field_not_established');
    return {ok:true,actor:this.binding};
  }
}

async function browserRequest({origin,probe,expected,path,method,body,verify,timeoutMs,maxBodyBytes}) {
  if(location.origin!==origin) return {complete:false,dispatched:false,prerequisiteError:'actor_origin_differs'};
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeoutMs);
  let dispatched=false,principal=null;
  async function read(response) {
    const reader=response.body?.getReader(),chunks=[];let bytes=0,truncated=false;
    if(reader) while(true) {
      const {value,done}=await reader.read();if(done)break;
      bytes+=value.byteLength;
      if(bytes>maxBodyBytes){truncated=true;await reader.cancel();break;}
      chunks.push(value);
    }
    const data=new Uint8Array(chunks.reduce((sum,chunk)=>sum+chunk.length,0));let offset=0;
    for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
    const text=new TextDecoder().decode(data);let value;
    try{value=JSON.parse(text);}catch{value=null;}
    return {status:response.status,body:value,text,complete:!truncated,bodyTruncated:truncated};
  }
  try {
    const options={credentials:'same-origin',redirect:'error',cache:'no-store',signal:abort.signal};
    if(verify) {
      const observed=await read(await fetch(probe,options));principal=observed.body;
      const matches=observed.complete && observed.status===200 && principal!==null &&
        Object.entries(expected).every(([key,value])=>{
          let actual=principal;
          for(const part of key.split('.')) {
            if(!actual || typeof actual!=='object' || !Object.hasOwn(actual,part))return false;
            actual=actual[part];
          }
          return typeof actual===typeof value && actual===value;
        });
      if(!matches)return {complete:false,dispatched:false,prerequisiteError:'actual_principal_differs_or_unknown'};
    }
    dispatched=true;
    const response=await fetch(path,{...options,method,
      ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    return {...await read(response),dispatched,principal};
  } catch {
    return {complete:false,dispatched,principal,error:'request_observation_incomplete',applicationOutcome:'unknown'};
  } finally {clearTimeout(timer);}
}

module.exports={ActorBrowser};
