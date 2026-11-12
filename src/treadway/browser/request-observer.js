'use strict';
const {waitForObservation,requireRecord}=require('./interactions.js');
const reason=error=>error?.code==='CDP_COMMAND_TIMEOUT'?'command_timeout_outcome_unknown':String(error?.message||error).split('\n')[0].slice(0,200);
const publicURL=value=>{try{const url=new URL(value);return url.origin+url.pathname;}catch{return null;}};
class RequestObserver{
  constructor(cdp,{match,record,maxRequests=100,maxBodyBytes=4*1024*1024}={}){
    if(typeof match!=='function'||!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>1000||!Number.isInteger(maxBodyBytes)||maxBodyBytes<1||maxBodyBytes>16*1024*1024)throw new Error('bounded_request_observer_configuration_required');
    this.cdp=cdp;this.match=match;this.record=record;this.maxRequests=maxRequests;this.maxBodyBytes=maxBodyBytes;
    this.requests=new Map();this.urls=new Map();this.listeners=[];this.started=false;this.active=false;this.captureError=null;this.overflow=false;
  }
  start(){
    if(this.started)throw new Error('request_observer_already_started');
    requireRecord(this.record);
    this.record({kind:'request_observation_started',maxRequests:this.maxRequests,maxBodyBytes:this.maxBodyBytes,at:new Date().toISOString()});
    this.started=true;this.active=true;
    const listen=(type,handler)=>{
      const listener=event=>{try{handler(event);}catch(error){this.captureError=reason(error);}};
      this.listeners.push([type,listener]);this.cdp.on(type,listener);
    };
    try{
    listen('Network.requestWillBeSent',event=>{
      if(this.requests.has(event.requestId)){
        this.requests.get(event.requestId).redirected=true;return;
      }
      if(!this.match(event))return;
      if(this.requests.size>=this.maxRequests){this.overflow=true;return;}
      const item={requestId:event.requestId,method:event.request.method,url:publicURL(event.request.url),status:null,responseObserved:false,loadingFinished:false};
      this.urls.set(event.requestId,event.request.url);this.requests.set(event.requestId,item);
      this.record({kind:'correlated_request',request:{...item}});
    });
    listen('Network.responseReceived',event=>{
      const item=this.requests.get(event.requestId);if(!item)return;
      if(item.responseObserved){item.duplicateResponse=true;return;}
      Object.assign(item,{status:event.response.status,responseObserved:true,responseURLMatches:event.response.url===undefined||event.response.url===this.urls.get(event.requestId)});
      this.record({kind:'correlated_response',response:{...item}});
    });
    listen('Network.loadingFinished',event=>{
      const item=this.requests.get(event.requestId);if(item){item.loadingFinished=true;item.encodedDataLength=event.encodedDataLength??null;}
    });
    listen('Network.loadingFailed',event=>{
      const item=this.requests.get(event.requestId);if(item)item.loadingFailure=String(event.errorText||'loading_failed').slice(0,200);
    });
    return this;
    }catch(error){this.dispose();throw error;}
  }
  snapshot(){return {requests:structuredClone([...this.requests.values()]),captureError:this.captureError,overflow:this.overflow};}
  async wait({count=1,windowMs=15000,readBody=false}={}){
    if(!this.active||!Number.isInteger(count)||count<1||count>this.maxRequests||!Number.isInteger(windowMs)||windowMs<1||windowMs>120000)throw new Error('active_bounded_request_observation_required');
    const end=Date.now()+windowMs;let observationError=null;
    const fatal=()=>this.captureError||this.overflow||this.requests.size>count||[...this.requests.values()].some(item=>item.redirected||item.duplicateResponse||item.loadingFailure||item.responseURLMatches===false);
    try{
      await waitForObservation('correlated response and loading completion',async()=>fatal()||this.requests.size===count&&[...this.requests.values()].every(item=>item.responseObserved&&item.loadingFinished),
        {windowMs,intervalMs:50,record:this.record});
    }catch(error){observationError=reason(error);}
    let complete=!observationError&&!fatal()&&this.requests.size===count&&[...this.requests.values()].every(item=>item.responseObserved&&item.loadingFinished);
    if(complete&&readBody){
      for(const item of this.requests.values()){
        try{
          const remaining=end-Date.now();if(remaining<=0)throw new Error('response_body_deadline');
          const observed=await this.cdp.send('Network.getResponseBody',{requestId:item.requestId},{timeoutMs:remaining});
          const body=observed.base64Encoded?Buffer.from(observed.body,'base64'):Buffer.from(observed.body,'utf8');
          item.bodyBytes=body.length;item.bodyTruncated=body.length>this.maxBodyBytes;
          item.body=body.subarray(0,this.maxBodyBytes).toString('utf8');
          if(item.bodyTruncated||Date.now()>end)complete=false;
          this.record({kind:'correlated_response_body',response:{...item}});
        }catch(error){item.bodyError=reason(error);complete=false;}
      }
    }
    const result={complete,...this.snapshot(),observationError,applicationOutcome:'not_evaluated'};
    // A later request or recording error can invalidate an earlier completed one.
    if(fatal())result.complete=false;
    try{this.record({kind:'request_observation_result',result});result.recordStatus='recorded';}
    catch(error){result.complete=false;result.recordStatus='result_write_failed';result.recordError=reason(error);}
    return result;
  }
  async run(dispatch,options){
    if(typeof dispatch!=='function')throw new Error('one_explicit_dispatch_required');
    let action={attempted:true,returned:false};
    try{
      this.start();
      this.record({kind:'correlated_action_intent',at:new Date().toISOString()});
      try{await dispatch();action.returned=true;}catch(error){action.reason=reason(error);}
      return {...await this.wait(options),action,completion:'unconfirmed'};
    }finally{this.dispose();}
  }
  dispose(){
    for(const [type,listener] of this.listeners)this.cdp.off(type,listener);
    this.listeners=[];this.active=false;
  }
}
module.exports={RequestObserver};
