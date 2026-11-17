const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {remoteBrowserFixture} = require('./remote-browser-fixture');
const {browserRoot} = require('./browser-fixture');
const {createCdpProxy, makeCdpClient} = require(path.join(browserRoot, 'cdp'));

test('real borrowed context: Python observation and explicit drive preserve operator pages and isolated sentinels',
  {skip: !process.env.CHROME_BIN, timeout: 60000}, async t => {
  const fixture = await remoteBrowserFixture('react', {handleRequest(request, response, url) {
    if (url.pathname === '/principal') {
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({principal: request.headers.cookie?.includes('session=synthetic-member') ? 'member' : null}));
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Operator page</title><p id="status">Original</p>');
    }
    return true;
  }});
  const operator = makeCdpClient(await createCdpProxy({cdpHost: '127.0.0.1', cdpPort: fixture.cdpPort}).cdpConnect(fixture.browserSession.browser_path));
  let complete = false;
  t.after(async () => {
    if (!complete) {
      const state = {};
      try {
        state.page = (await operator.send('Runtime.evaluate', {expression: '({ready:document.readyState,visible:document.visibilityState,width:innerWidth,height:innerHeight})', returnByValue: true}, {sessionId, timeoutMs:1000})).result?.value;
        try { state.operatorScreenshotBytes = (await operator.send('Page.captureScreenshot', {format:'png'}, {sessionId, timeoutMs:1000})).data.length; }
        catch { state.operatorScreenshotIncomplete = true; }
      } catch { state.observationIncomplete = true; }
      fs.writeFileSync(path.join(fixture.root,'borrowed-failure.json'), JSON.stringify(state), {mode:0o600, flag:'wx'});
      t.diagnostic(JSON.stringify(state));
    }
    operator.close(); await fixture.close({preserveEvidence: !complete});
  });
  const contextId = (await operator.send('Target.createBrowserContext')).browserContextId;
  const sideTarget = (await operator.send('Target.createTarget', {url: 'about:blank', browserContextId: contextId})).targetId;
  // Capture success requires a drawable page. Creating this page last makes it
  // visible; Treadway must not activate an operator's hidden page implicitly.
  const targetId = (await operator.send('Target.createTarget', {url: 'about:blank', browserContextId: contextId})).targetId;
  const sessionId = (await operator.send('Target.attachToTarget', {targetId, flatten: true})).sessionId;
  await operator.send('Page.navigate', {url: fixture.origin}, {sessionId});
  const ready = performance.now() + 5000;
  while ((await operator.send('Runtime.evaluate', {expression: 'location.origin===' + JSON.stringify(fixture.origin) + '&&document.readyState==="complete"', returnByValue: true}, {sessionId})).result.value !== true) {
    assert.ok(performance.now() < ready); await new Promise(resolve => setTimeout(resolve, 10));
  }
  const seeded = await operator.send('Runtime.evaluate', {expression: 'localStorage.setItem("owned","original");document.cookie="session=synthetic-member; Path=/"'}, {sessionId});
  assert.equal(seeded.exceptionDetails, undefined);
  await fixture.session.navigate(fixture.origin);
  await fixture.session.eval('localStorage.setItem("sentinel","unrelated");document.cookie="sentinel=unrelated; Path=/"');
  assert.equal((await operator.send('Runtime.evaluate', {expression: 'document.visibilityState', returnByValue: true}, {sessionId})).result.value, 'visible');
  const script = `
import json,sys
from pathlib import Path
from treadway.browser_runtime import BrowserRuntime
from treadway.browser_state import BrowserIdentity, BrowserStateIncomplete
from treadway.cdp import CdpSocket, CommandSession
root,origin=Path(sys.argv[1]),sys.argv[2]
config={'provider':'browserless','mode':'borrowed','binding':'service','attachment_env':'TREADWAY_BORROWED_ATTACHMENT'}
identity=BrowserIdentity(root/'identities','member','workboard','member','service',(origin,))
def runtime(name): return BrowserRuntime(root/name,configuration=config,project_root=root/'project')
with runtime('observer') as observed:
 actor=observed.borrow('member',identity)
 with observed.drive(actor):
  socket=CdpSocket(connection=actor.connection(),observation_only=True)
  try:
   cdp=CommandSession(socket)
   image=cdp.command('Page.captureScreenshot',{'format':'png'},timeout_seconds=3)
   assert len(image['data'])>100
   assert any(cookie['name']=='session' for cookie in cdp.command('Storage.getCookies')['cookies'])
   try: cdp.command('Runtime.evaluate',{'expression':'localStorage.clear()'})
   except RuntimeError as error: assert str(error)=='remote_observation_only; outcome not_dispatched'
   else: raise AssertionError('observation promoted to mutation')
  finally: socket.close()
 assert observed.release(actor)['contextLease']['recoveryRequired'] is False
with runtime('driver') as driven:
 actor=driven.borrow('member',identity,permission='drive')
 with driven.drive(actor):
  socket=CdpSocket(connection=actor.connection())
  try:
   cdp=CommandSession(socket)
   probe=cdp.command('Runtime.evaluate',{'expression':'fetch("/principal").then(r=>r.json())','awaitPromise':True,'returnByValue':True})
   assert probe['result']['value']=={'principal':'member'}
   actual=cdp.command('Runtime.evaluate',{'expression':'({old:localStorage.getItem("owned"),sentinel:localStorage.getItem("sentinel")})','returnByValue':True})
   assert actual['result']['value']=={'old':'original','sentinel':None}
   cdp.command('Runtime.evaluate',{'expression':'document.querySelector("#status").textContent="Changed";localStorage.setItem("owned","updated")'})
  finally: socket.close()
 assert driven.release(actor)['attachmentDetached'] is True
print(json.dumps({'complete':True}))
`;
  const result = await new Promise((resolve, reject) => {
    execFile(process.env.TREADWAY_PYTHON || 'python3', ['-c', script, path.join(fixture.root, 'borrowed'), fixture.origin],
      {timeout: 45000, env: {...process.env, TREADWAY_BORROWED_ATTACHMENT: JSON.stringify({version: 1,
        endpoint: fixture.endpoint, contextId, targetId, scope: 'context', permission: 'drive'})}},
      (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
  });
  assert.equal(result.complete, true);
  assert.equal((await operator.send('Runtime.evaluate', {expression: 'localStorage.getItem("owned")', returnByValue: true}, {sessionId})).result.value, 'updated');
  assert.equal((await operator.send('Runtime.evaluate', {expression: 'document.querySelector("#status").textContent', returnByValue: true}, {sessionId})).result.value, 'Changed');
  assert.equal((await operator.send('Target.getTargetInfo', {targetId: sideTarget})).targetInfo.browserContextId, contextId);
  assert.equal(await fixture.session.eval('localStorage.getItem("sentinel")'), 'unrelated');
  assert.equal((await fixture.session.cdp.send('Storage.getCookies')).cookies[0].value, 'unrelated');
  complete = true;
});
