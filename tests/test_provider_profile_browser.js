const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {providerBrowserFixture} = require('./provider-browser-fixture');

test('provider profile retains cookies and localStorage across real Chromium process generations without closing an unrelated browser',
  {skip: !process.env.CHROME_BIN, timeout: 100000}, async t => {
  const fixture = await providerBrowserFixture();
  let complete = false;
  t.after(() => fixture.close({preserveEvidence: !complete}));
  await fixture.session.navigate(fixture.origin);
  await fixture.session.eval('localStorage.setItem("sentinel","unrelated");document.cookie="sentinel=unrelated; Path=/"');
  const script = `
import json,sys,time
from pathlib import Path
from treadway.browser_runtime import BrowserRuntime
from treadway.browser_state import BrowserIdentity
from treadway.cdp import CdpSocket,CommandSession
root,origin=Path(sys.argv[1]),sys.argv[2]
config={'provider':'browserless','mode':'provider-session','binding':'session-service','session_api_env':'TREADWAY_PROFILE_FIXTURE',
 'acquire_seconds':25,'session_seconds':90}
identity=BrowserIdentity(root/'identities','synthetic-member','workboard','member','session-service',(origin,))
principal={'origin':origin,'probe':'/principal','expected':{'principal':'member'}}
def runtime(): return BrowserRuntime(root/'run',configuration=config,project_root=root/'project')
with runtime() as browsers:
 browsers.create_provider_identity(identity,ttl_seconds=180)
 member=browsers.acquire_provider_identity('member',identity,principal=principal,initial_setup=True)
 first=member.generation
 with browsers.drive(member):
  socket=CdpSocket(connection=member.connection())
  try:
   cdp=CommandSession(socket)
   cdp.command('Page.navigate',{'url':origin})
   deadline=time.monotonic()+5
   while cdp.command('Runtime.evaluate',{'expression':'location.origin==='+json.dumps(origin)+'&&document.readyState==="complete"','returnByValue':True})['result']['value'] is not True:
    assert time.monotonic()<deadline
    time.sleep(.01)
   result=cdp.command('Runtime.evaluate',{'expression':'localStorage.setItem("owned","retained");document.cookie="session=synthetic-member; Max-Age=3600; Path=/"'})
   assert 'exceptionDetails' not in result
  finally: socket.close()
 assert browsers.verify_provider_identity(member)['verified'] is True
 cleanup=browsers.release(member)
 assert cleanup['profileReleased'] is True and cleanup['profileRetained'] is True
 assert cleanup['identity']['recoveryRequired'] is False
with runtime() as browsers:
 member=browsers.acquire_provider_identity('member',identity,principal=principal,landing_url=origin+'/')
 assert member.generation!=first
 with browsers.drive(member):
  socket=CdpSocket(connection=member.connection())
  try:
   cdp=CommandSession(socket)
   observed=cdp.command('Runtime.evaluate',{'expression':'({value:localStorage.getItem("owned"),sentinel:localStorage.getItem("sentinel")})','returnByValue':True})
   assert observed['result']['value']=={'value':'retained','sentinel':None}
  finally: socket.close()
 assert browsers.release(member)['profileReleased'] is True
 assert browsers.forget_provider_identity(identity)['profileDeleted'] is True
print(json.dumps({'complete':True}))
`;
  const value = await new Promise((resolve, reject) => {
    execFile(process.env.TREADWAY_PYTHON || 'python3', ['-c', script, path.join(fixture.root, 'provider-flow'), fixture.origin],
      {timeout: 80000, env: {...process.env, TREADWAY_PROFILE_FIXTURE: fixture.sessionApi}},
      (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
  });
  assert.equal(value.complete, true);
  assert.equal(fixture.generations.length, 2);
  assert.notEqual(fixture.generations[0].pid, fixture.generations[1].pid);
  assert.notEqual(fixture.generations[0].generation, fixture.generations[1].generation);
  assert.equal(fixture.profiles.size, 0);
  assert.deepEqual(fixture.requests.map(value => value.method), ['POST', 'DELETE']);
  assert.ok(fixture.requests.at(-1).url.endsWith('?token=synthetic-stop&x=%2B+'));
  assert.equal(await fixture.session.eval('localStorage.getItem("sentinel")'), 'unrelated');
  assert.equal((await fixture.session.cdp.send('Storage.getCookies')).cookies[0].value, 'unrelated');
  complete = true;
});
