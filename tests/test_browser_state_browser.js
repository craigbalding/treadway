// Real CDP contexts and the Python owner exercise the complete saved-state path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {execFile} = require('node:child_process');
const {WebSocketServer} = require('ws');
const {widgetFixture, browserRoot} = require('./browser-fixture');
const {createCdpProxy} = require(path.join(browserRoot, 'cdp'));

for (const provider of ['browserless', 'local']) test(`${provider}: saved identity restores HttpOnly/path cookies and page storage into a new owned context`,
  {skip: !process.env.CHROME_BIN, timeout: 90000}, async t => {
  const fixture = await widgetFixture('react', {handleRequest(request, response, url) {
    if (url.pathname === '/api/principal') {
      const valid = request.headers.cookie?.includes('session=synthetic-member') &&
        request.headers.cookie?.includes('account=synthetic-account');
      response.writeHead(valid ? 200 : 401, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({principal: valid ? 'member' : null}));
      return true;
    }
    if (url.pathname === '/login' || url.pathname === '/editor') {
      if (url.pathname === '/login') response.setHeader('Set-Cookie', [
        'session=synthetic-member; HttpOnly; SameSite=Lax; Path=/',
        'account=synthetic-account; HttpOnly; SameSite=Strict; Path=/api',
      ]);
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>State fixture</title><p>Ready</p>');
      return true;
    }
    return false;
  }});
  const clients = new Set();
  const relay = http.createServer();
  const sockets = new WebSocketServer({server: relay});
  sockets.on('connection', async front => {
    clients.add(front); let upstream, pending = [];
    front.on('error', () => {});
    front.on('message', data => upstream ? upstream.send(data.toString()) : pending.push(data));
    front.on('close', () => { upstream?.terminate(); clients.delete(front); });
    try {
      upstream = await createCdpProxy({cdpHost: '127.0.0.1', cdpPort: fixture.cdpPort}).cdpConnect(fixture.browserSession.browser_path);
      upstream.on('error', () => front.terminate()); upstream.on('close', () => front.terminate());
      upstream.on('message', data => { if (front.readyState === front.OPEN) front.send(data.toString()); });
      if (front.readyState !== front.OPEN) { upstream.terminate(); return; }
      for (const data of pending) upstream.send(data.toString()); pending = [];
    } catch { front.terminate(); }
  });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  let complete = false;
  t.after(async () => {
    for (const client of clients) client.terminate();
    sockets.close(); await new Promise(resolve => relay.close(resolve));
    await fixture.close({preserveEvidence: !complete});
  });
  await fixture.session.navigate(fixture.origin + '/editor');
  await fixture.session.eval('localStorage.setItem("sentinel","unrelated");document.cookie="sentinel=unrelated; Path=/"');
  const script = `
import json, os, subprocess, sys
from pathlib import Path
import treadway
from treadway.browser_runtime import BrowserRuntime, BrowserRuntimeIncomplete
from treadway.browser_state import BrowserIdentity, BrowserStateIncomplete
root, origin = Path(sys.argv[1]), sys.argv[2]
config = {'provider':'browserless','binding':'test-service','endpoint_env':'TREADWAY_STATE_ENDPOINT'}
if sys.argv[3] == 'local': config = {'provider':'local','binding':'test-service'}
launch_options = {'executable': os.environ['CHROME_BIN']} if sys.argv[3] == 'local' else {}
identity = BrowserIdentity(root/'identities','member-resource','workboard','member','test-service',
 (origin,),('cookies','localStorage','sessionStorage'))
principal = {'origin':origin,'probe':'/api/principal','expected':{'principal':'member'}}
def call(runtime, actor, expression=None, navigate=None):
 with runtime.drive(actor):
  source = '''const fs=require('node:fs');const i=JSON.parse(fs.readFileSync(0));
  (async()=>{const {connectSession}=require(i.library);const s=await connectSession(i.connection);
  try{const v=i.navigate?await s.navigate(i.navigate):await s.eval(i.expression);process.stdout.write(JSON.stringify({value:v}));}
  finally{s.close();}})().catch(e=>{process.stderr.write(e.message);process.exitCode=1;});'''
  result = subprocess.run(['node','-e',source],input=json.dumps({'connection':actor.connection(),
   'library':str(Path(treadway.__file__).with_name('browser')/'connection.js'),
   'expression':expression,'navigate':navigate}),capture_output=True,text=True,timeout=10)
  assert result.returncode == 0, result.stderr
  return json.loads(result.stdout).get('value')
def runtime(name): return BrowserRuntime(root/name,configuration=config,project_root=root/'project')
with runtime('initial') as first:
 actor = first.acquire_identity('member',identity,principal=principal,restore=False,**launch_options)
 call(first,actor,navigate=origin+'/login')
 call(first,actor,expression='localStorage.setItem("app-key","original");sessionStorage.setItem("page-key","page-original");true')
 saved = first.save_identity(actor)
 assert saved['saved'] and set(saved['components']) == {'cookies','localStorage','sessionStorage'}
 with runtime('competing') as competitor:
  try: competitor.acquire_identity('alias',identity,principal=principal)
  except BrowserStateIncomplete as error: assert str(error) == 'browser_identity_in_use'
  else: raise AssertionError('parallel identity writer accepted')
  assert competitor.process is None
 assert first.release(actor)['identity']['recoveryRequired'] is False
 generation = actor.generation
with runtime('restored') as second:
 actor = second.acquire_identity('member',identity,principal=principal,landing_url=origin+'/editor',**launch_options)
 assert actor.generation != generation
 actual = call(second,actor,expression='({local:localStorage.getItem("app-key"),session:sessionStorage.getItem("page-key"),sentinel:localStorage.getItem("sentinel"),visible:document.cookie})')
 assert actual == {'local':'original','session':'page-original','sentinel':None,'visible':''}, actual
 anonymous = second.acquire('anonymous',**launch_options)
 call(second,anonymous,navigate=origin+'/editor')
 assert call(second,anonymous,expression='({local:localStorage.length,session:sessionStorage.length,cookies:document.cookie})') == {'local':0,'session':0,'cookies':''}
 assert second.save_identity(actor)['saved'] is True
with runtime('wrong-principal') as wrong:
 try: wrong.acquire_identity('member',identity,principal={**principal,'expected':{'principal':'reviewer'}},landing_url=origin+'/editor',**launch_options)
 except BrowserRuntimeIncomplete as error: assert str(error).startswith('browser_state_actual_principal_differs')
 else: raise AssertionError('wrong actual principal accepted')
with runtime('blocked') as blocked:
 try: blocked.acquire_identity('member',identity,principal=principal)
 except BrowserStateIncomplete as error: assert str(error) == 'browser_identity_recovery_required'
 else: raise AssertionError('failed restore silently reused')
 assert blocked.process is None
if sys.argv[3] == 'browserless':
 failed_actor, = wrong.sessions.values()
 assert identity.recover(wrong.project_id,run_id=wrong.run_id,actor=failed_actor.name,
  generation=failed_actor.generation)['recovered'] is True
 with runtime('recovered') as recovered:
  actor = recovered.acquire_identity('member',identity,principal=principal,landing_url=origin+'/editor')
  assert call(recovered,actor,expression='localStorage.getItem("app-key")') == 'original'
print(json.dumps({'complete':True,'generationChanged':True,'actual':actual}))
`;
  const observed = await new Promise((resolve, reject) => {
    execFile(process.env.TREADWAY_PYTHON || 'python3', ['-c', script, path.join(fixture.root, 'state-roundtrip'), fixture.origin, provider],
      {timeout: 80000, env: {...process.env, TREADWAY_STATE_ENDPOINT: `http://127.0.0.1:${relay.address().port}/chromium`}},
      (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
  });
  assert.equal(observed.complete, true);
  assert.equal(await fixture.session.eval('localStorage.getItem("sentinel")'), 'unrelated');
  assert.equal((await fixture.session.cdp.send('Storage.getCookies')).cookies[0].value, 'unrelated');
  complete = true;
});
