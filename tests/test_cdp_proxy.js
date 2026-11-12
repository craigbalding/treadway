const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const {once} = require('node:events');
const {WebSocketServer} = require('ws');
const {createCdpProxy} = require('../src/treadway/browser/cdp-proxy');

async function fixture(t, handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));});
  return server;
}

test('local discovery succeeds; malformed JSON and stalled responses reject', async t=>{
  let mode = 'valid';
  const server = await fixture(t, (req,res)=>{if(mode==='stall')return;res.end(mode==='valid'?'[{"id":"fixture"}]':'broken');});
  const proxy = createCdpProxy({cdpHost:'127.0.0.1',cdpPort:server.address().port,timeoutMs:300});
  assert.deepEqual(await proxy.listTargets(),[{id:'fixture'}]);
  mode='bad'; await assert.rejects(proxy.listTargets(),/invalid JSON/);
  mode='stall'; await assert.rejects(proxy.listTargets(),/deadline/);
});

test('local WebSocket handshake is bounded', async t=>{
  const server = await fixture(t, ()=>{});
  server.on('upgrade',()=>{});
  const proxy = createCdpProxy({cdpHost:'127.0.0.1',cdpPort:server.address().port,timeoutMs:300});
  await assert.rejects(proxy.cdpConnect('/devtools/page/fixture'),/timed out/);
});

test('configured proxy carries discovery, credentials and CONNECT without remote DNS', async t=>{
  const browser = await fixture(t,()=>{});
  const wss = new WebSocketServer({server:browser});
  t.after(()=>wss.close());
  const seen=[];
  const proxyServer = await fixture(t,(req,res)=>{seen.push({url:req.url,host:req.headers.host,auth:req.headers['proxy-authorization']});res.end('[]');});
  proxyServer.on('connect',(req,socket,head)=>{
    seen.push({url:req.url,host:req.headers.host,auth:req.headers['proxy-authorization']});
    const upstream=net.connect(browser.address().port,'127.0.0.1',()=>{
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
    });
    socket.on('close',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
  });
  const proxy = createCdpProxy({cdpHost:'offline-fixture.invalid',cdpPort:9222,timeoutMs:1000,
    proxyUrl:`http://fixture-user:fixture-pass@127.0.0.1:${proxyServer.address().port}`});
  assert.deepEqual(await proxy.listTargets(),[]);
  const ws=await proxy.cdpConnect('/devtools/page/fixture');ws.terminate();
  assert.equal(seen.length,2);
  assert.equal(seen[0].url,'http://offline-fixture.invalid:9222/json/list');
  assert.equal(seen[1].url,'offline-fixture.invalid:9222');
  for(const request of seen){assert.equal(request.host,'offline-fixture.invalid:9222');assert.equal(request.auth,'Basic '+Buffer.from('fixture-user:fixture-pass').toString('base64'));}
});

test('CONNECT stalls and refusals reject without a direct fallback', async t=>{
  let mode='stall';
  const server = await fixture(t,()=>{});
  server.on('connect',(req,socket)=>{if(mode==='refuse')socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');});
  const proxy=createCdpProxy({cdpHost:'offline-fixture.invalid',cdpPort:9222,timeoutMs:300,proxyUrl:`http://127.0.0.1:${server.address().port}`});
  await assert.rejects(proxy.cdpConnect('/devtools/page/fixture'),/deadline/);
  mode='refuse';await assert.rejects(proxy.cdpConnect('/devtools/page/fixture'),/407/);
  assert.throws(()=>createCdpProxy({cdpHost:'offline-fixture.invalid',cdpPort:9222,proxyUrl:''}),/explicit HTTP proxy/);
});
