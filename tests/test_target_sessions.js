const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {makeCdpClient}=require('../src/treadway/browser/cdp.js');
const {OriginState}=require('../src/treadway/browser/state.js');
const {TargetMonitor}=require('../src/treadway/browser/targets.js');
const http=require('node:http');
const path=require('node:path');
const {once}=require('node:events');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
class Socket extends EventEmitter {
  constructor(){super();this.sent=[];}
  send(raw){this.sent.push(JSON.parse(raw));}
  close(){}
}
test('runner operation kinds remain separate from explicit browser connection kinds',async t=>{
  const requests=[];
  const server=http.createServer((request,response)=>{
    requests.push(request.url);response.writeHead(503);response.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const local={cdpHost:'127.0.0.1',cdpPort:server.address().port,targetId:'synthetic-page'};
  const run=async(file,input)=>{
    const child=promisify(execFile)(process.execPath,[path.join(__dirname,'../src/treadway/browser',file)],{timeout:5000});
    child.child.stdin.end(JSON.stringify(input));
    try {await child;assert.fail('Fixture discovery refusal must stop the operation');}
    catch(error){assert.equal(error.code,1);return JSON.parse(error.stdout);}
  };
  for(const [file,operation] of [
    ['form-assessor.js',{operation:'locate',kind:'field',selector:'#title'}],
    ['widget-runner.js',{operation:'inspect',kind:'date_range',origin:'http://fixture.invalid',
      recordPath:'unused-fixture.jsonl',profile:{start:'#start',due:'#due',action:{selector:'#save'}}}],
  ])await t.test(file,async()=>{
    const before=requests.length;
    const refused=await run(file,{...local,...operation});
    assert.equal(refused.reason,'CDP HTTP status 503');
    assert.deepEqual(requests.slice(before),['/json/list']);
    const explicit=await run(file,{...local,...operation,connection:{...local,kind:'unsupported'}});
    assert.equal(explicit.reason,'unsupported_browser_connection_kind');
    assert.equal(requests.length,before+1,'An explicit unsupported connection must not fall back to local fields');
    for (const connection of [null,false,0,'',[]]) {
      const malformed=await run(file,{...local,...operation,connection});
      assert.equal(malformed.reason,'explicit_browser_connection_required');
      assert.equal(requests.length,before+1,'A malformed explicit connection must not fall back to local fields');
    }
  });
});
test('CDP sessions isolate colliding events and reject a reply from another session',async()=>{
  const socket=new Socket(),cdp=makeCdpClient(socket),a=cdp.session('a'),b=cdp.session('b'),events=[];
  a.on('Network.loadingFinished',value=>events.push(['a',value.requestId]));
  b.on('Network.loadingFinished',value=>events.push(['b',value.requestId]));
  for(const sessionId of ['a','b'])socket.emit('message',JSON.stringify({sessionId,method:'Network.loadingFinished',params:{requestId:'same'}}));
  assert.deepEqual(events,[['a','same'],['b','same']]);
  const promise=a.send('Page.enable');
  socket.emit('message',JSON.stringify({id:socket.sent[0].id,sessionId:'b',result:{}}));
  await assert.rejects(promise,/session differs/);cdp.close();
});
test('state clearing cannot turn an unavailable observation into clean state',async()=>{
  const calls=[],state=new OriginState({cdp:{send:async(method)=>{
    calls.push(method);return {result:{value:{complete:false,error:'unsupported'}}};
  }}},{origin:'http://fixture.invalid'});
  await assert.rejects(state.clear(),/prerequisite_incomplete/);
  assert.deepEqual(calls,['Runtime.evaluate']);
});
test('detaching one target disposes its work without disconnecting the browser',async()=>{
  const socket=new Socket(),cdp=makeCdpClient(socket),child=cdp.session('child');
  const pending=child.send('Runtime.evaluate');
  const event=child.once('Network.loadingFinished');
  const pendingRejected=assert.rejects(pending,/detached.*unknown/);
  const eventRejected=assert.rejects(event,/detached.*unknown/);
  cdp.onAll('Target.detachedFromTarget',({sessionId})=>cdp.removeSession(sessionId));
  socket.emit('message',JSON.stringify({method:'Target.detachedFromTarget',params:{sessionId:'child'}}));
  await pendingRejected;await eventRejected;
  await assert.rejects(child.send('Page.enable'),/not sent/);
  const root=cdp.send('Browser.getVersion');
  socket.emit('message',JSON.stringify({id:socket.sent.at(-1).id,result:{product:'synthetic'}}));
  assert.equal((await root).product,'synthetic');cdp.close();
});
test('target monitor scopes request IDs, redacts query data and releases listeners',async()=>{
  const records=[],sessions=new Map(),root=new EventEmitter();
  root.send=async()=>({});
  root.off=root.removeListener.bind(root);
  root.session=id=>{
    if(!sessions.has(id)) {
      const session=new EventEmitter();session.send=async()=>({});session.off=session.removeListener.bind(session);sessions.set(id,session);
    }return sessions.get(id);
  };
  const monitor=new TargetMonitor(root,{actor:{name:'a',generation:'g'},origin:'http://fixture.invalid',record:event=>records.push(event)});
  await monitor.start();
  for(const id of ['a','b'])root.emit('Target.attachedToTarget',{sessionId:id,targetInfo:{targetId:id,type:'worker',url:'http://fixture.invalid/worker'}});
  await Promise.all([...monitor.tasks]);
  for(const session of sessions.values()) {
    session.emit('Network.requestWillBeSent',{requestId:'same',request:{url:'http://fixture.invalid/data?secret=private',method:'GET'}});
    session.emit('Network.loadingFinished',{requestId:'same'});
  }
  assert.equal(records.filter(record=>record.kind==='loaded').length,2);
  assert.equal(JSON.stringify(records).includes('private'),false);
  const summary=await monitor.close();assert.equal(summary.complete,true);
  assert.equal(root.listenerCount('Target.attachedToTarget'),0);
  for(const session of sessions.values())assert.equal(session.listenerCount('Network.requestWillBeSent'),0);
});
