const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {remoteBrowserFixture} = require('./remote-browser-fixture');

test('real Chromium reconnect preserves the exact page and verifies the current application principal through Python',
  {skip: !process.env.CHROME_BIN, timeout: 70000}, async t => {
  // The relay emulates only the provider's reconnect extension. Context survival,
  // page identity, cookies, storage and the principal fetch use actual Chromium.
  const fixture = await remoteBrowserFixture('react', {reconnectSupport: true,
    handleRequest(request, response, url) {
      if (url.pathname === '/principal') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({principal: request.headers.cookie?.includes('session=synthetic-member') ? 'member' : null}));
      } else {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><title>Reconnect example</title><p>Owned page</p>');
      }
      return true;
    }});
  let complete = false;
  t.after(() => fixture.close({preserveEvidence: !complete}));
  const script = `
import json,sys,time
from pathlib import Path
from treadway.browser_runtime import BrowserRuntime
from treadway.cdp import CdpSocket,CommandSession
root,origin=Path(sys.argv[1]),sys.argv[2]
config={'provider':'browserless','endpoint_env':'TREADWAY_RECONNECT_FIXTURE','reconnect':{},'session_seconds':60}
principal={'origin':origin,'probe':'/principal','expected':{'principal':'member'}}
with BrowserRuntime(root/'run',configuration=config,project_root=root/'project') as runtime:
 actor=runtime.acquire('member')
 generation=actor.generation
 with runtime.drive(actor):
  socket=CdpSocket(connection=actor.connection())
  try:
   cdp=CommandSession(socket)
   cdp.command('Page.navigate',{'url':origin})
   deadline=time.monotonic()+5
   while cdp.command('Runtime.evaluate',{'expression':'location.origin==='+json.dumps(origin)+'&&document.readyState==="complete"','returnByValue':True})['result']['value'] is not True:
    assert time.monotonic()<deadline
    time.sleep(.01)
   result=cdp.command('Runtime.evaluate',{'expression':'localStorage.setItem("owned","retained");document.cookie="session=synthetic-member; Path=/"'})
   assert 'exceptionDetails' not in result
  finally: socket.close()
 prepared=runtime.prepare_reconnect(actor,timeout_seconds=30)
 assert prepared['prepared'] is True
 reconnected=runtime.reconnect(actor,principal=principal)
 assert reconnected=={'reconnected':True,'generation':generation,'principalVerified':True,'reconciliationRequired':False}
 with runtime.drive(actor):
  socket=CdpSocket(connection=actor.connection())
  try:
   cdp=CommandSession(socket)
   observed=cdp.command('Runtime.evaluate',{'expression':'({origin:location.origin,value:localStorage.getItem("owned"),title:document.title})','returnByValue':True})
   assert observed['result']['value']=={'origin':origin,'value':'retained','title':'Reconnect example'}
  finally: socket.close()
 assert runtime.release(actor)['contextDisposed'] is True
 print(json.dumps({'complete':True,'generation':generation}))
`;
  const value = await new Promise((resolve, reject) => {
    execFile(process.env.TREADWAY_PYTHON || 'python3', ['-c', script, path.join(fixture.root, 'reconnect'), fixture.origin],
      {timeout: 55000, env: {...process.env, TREADWAY_RECONNECT_FIXTURE: fixture.endpoint}},
      (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
  });
  assert.equal(value.complete, true);
  assert.deepEqual(fixture.connections, ['/chromium?token=synthetic', '/reconnect/exact?existing=synthetic']);
  const directory = path.join(fixture.root, 'reconnect', 'run');
  const [run] = fs.readdirSync(directory);
  const journal = fs.readFileSync(path.join(directory, run, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(journal.filter(event => event.kind === 'context_acquired').length, 1);
  assert.equal(journal.filter(event => event.kind === 'reconnect_ready').length, 1);
  assert.equal(journal.find(event => event.kind === 'reconnect_ready').generation, value.generation);
  complete = true;
});
