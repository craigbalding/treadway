const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {execFile} = require('node:child_process');
const {WebSocketServer} = require('ws');
const {widgetFixture, browserRoot} = require('./browser-fixture');
const {BrowserWorker} = require(path.join(browserRoot, 'browser-worker'));
const {connectSession} = require(path.join(browserRoot, 'connection'));
const {createCdpProxy} = require(path.join(browserRoot, 'cdp'));
const {BrowserInteractions} = require(path.join(browserRoot, 'interactions'));
const {DateRange} = require(path.join(browserRoot, 'widgets'));
const {uploadFile, downloadFile} = require(path.join(browserRoot, 'transfers'));
const {OriginState} = require(path.join(browserRoot, 'state'));

test('real remote CDP preserves React edits, scoped state and an unrelated browser session',
  {skip: !process.env.CHROME_BIN, timeout: 120000}, async t => {
  const fixture = await widgetFixture('react');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-remote-real-'));
  const workers = [], connections = [], clients = new Set();
  let complete = false;
  const server = http.createServer((_request, response) => { response.writeHead(500); response.end(); });
  const wss = new WebSocketServer({server});
  wss.on('connection', async front => {
    clients.add(front); let upstream, pending = [];
    front.on('error', () => {});
    front.on('message', data => { if (upstream) upstream.send(data.toString()); else pending.push(data); });
    front.on('close', () => { upstream?.terminate(); clients.delete(front); });
    try {
      upstream = await createCdpProxy({cdpHost: '127.0.0.1', cdpPort: fixture.cdpPort}).cdpConnect(fixture.browserSession.browser_path);
      upstream.on('error', () => front.terminate());
      upstream.on('close', () => front.terminate());
      upstream.on('message', data => { if (front.readyState === front.OPEN) front.send(data.toString()); });
      if (front.readyState !== front.OPEN) { upstream.terminate(); return; }
      for (const item of pending) upstream.send(item.toString()); pending = [];
    } catch { front.terminate(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const session of connections) session.close();
    for (const worker of workers) await worker.shutdown();
    for (const client of clients) client.terminate();
    wss.close(); await new Promise(resolve => server.close(resolve));
    await fixture.close({preserveEvidence: !complete});
    if (complete) fs.rmSync(root, {recursive: true, force: true});
    else t.diagnostic('Retained remote protocol evidence: ' + root);
  });
  // The service deliberately exposes the same browser to several root clients.
  // Owning one context must never authorize closing that browser or another context.
  await fixture.session.navigate(fixture.origin);
  await fixture.session.eval('localStorage.setItem("sentinel", "unrelated");document.cookie="sentinel=unrelated; Path=/"');
  const handles = [];
  for (const name of ['project-a', 'project-b']) {
    const worker = new BrowserWorker({root: path.join(root, name), projectId: name, runId: 'run-one'});
    workers.push(worker); await worker.start();
    const acquired = await worker.acquire({actor: 'creator', endpoint: `http://127.0.0.1:${server.address().port}/chromium?token=synthetic`});
    handles.push(acquired.connection);
    const session = await connectSession(acquired.connection); connections.push(session);
    await session.navigate(fixture.origin);
    assert.equal(await session.eval('localStorage.getItem("sentinel")'), null);
    assert.equal((await session.cdp.send('Storage.getCookies')).cookies.some(cookie => cookie.name === 'sentinel'), false);
  }
  const session = connections[0];
  const ui = new BrowserInteractions(session, {origin: fixture.origin, record: () => {}});
  await ui.wait('framework ready', () => ui.visible('#start'));
  const dates = new DateRange(ui, {start: '#start', due: '#due', action: {selector: '#date-save'}});
  const edit = await dates.prepare({snapshot: await ui.form.inspect(), start: '2026-12-07', due: '2026-12-11', source: 'synthetic remote edit'});
  await dates.commit(edit, {windowMs: 300});
  await ui.wait('actual request persisted', () => fixture.posts.some(post => post.path === '/save/dates'));
  assert.equal(fixture.posts.at(-1).value.start, '2026-12-07');
  assert.equal(fixture.posts.at(-1).value.due, '2026-12-11');
  const screenshot = await session.cdp.send('Page.captureScreenshot', {format: 'png'});
  assert.ok(Buffer.from(screenshot.data, 'base64').length > 100);
  await assert.rejects(uploadFile(ui, {}), /remote_file_transfer_unsupported/);
  let dispatched = false;
  await assert.rejects(downloadFile(ui, {dispatch: () => { dispatched = true; }}), /remote_file_transfer_unsupported/);
  assert.equal(dispatched, false);
  await assert.rejects(new OriginState(session, {origin: fixture.origin}).clear(), /remote_origin_clear_unsupported/);
  ui.dispose(); session.close();
  // A different language/process reads the same live target through the installed bridge.
  const python = process.env.TREADWAY_PYTHON || 'python3';
  const code = `import json,sys
from treadway.cdp import CdpSocket, CommandSession
from treadway.robot import FormLibrary
c=json.load(sys.stdin)
s=CdpSocket(connection=c)
try:
 print(json.dumps(CommandSession(s).command('Runtime.evaluate', {'expression':'document.getElementById("start").value','returnByValue':True})))
finally:
 s.close()
f=FormLibrary(connection=c, record_path=${JSON.stringify(path.join(root, 'attempts.jsonl'))})
assert f.inspect_form()['observed'] is True
`;
  const result = await new Promise((resolve, reject) => {
    const child = execFile(python, ['-c', code], {timeout: 10000}, (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify(handles[0]));
  });
  assert.equal(result.result.value, '2026-12-07');
  // Exported consumers select the provider explicitly. No CHROME_BIN is
  // available to the child; every Robot operation reuses its actor's worker.
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const appPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const consumer = `import json,os,sys,time
from pathlib import Path
from treadway.authoring import main
project=Path(sys.argv[1]);main(['new',str(project)])
sys.path.insert(0,str(project))
import run
os.environ.pop('CHROME_BIN',None)
output=project/'artifacts'/'remote-acceptance';output.mkdir(parents=True,mode=0o700)
config=project/'browser.json'
config.write_text(json.dumps({'browser':{'provider':'browserless','endpoint_env':'TREADWAY_FIXTURE_ENDPOINT'}}))
# Keep this boundary check focused: one persisted edit and one actor handoff.
flow=(project/'flow.robot').read_text().split('Stale Revision Blocks')[0]
(project/'flow.robot').write_text(flow)
collaboration=(project/'collaboration.robot').read_text()
(project/'collaboration.robot').write_text(collaboration.split('Known Private ID')[0]+'*** Keywords ***'+collaboration.split('*** Keywords ***')[1])
checks=[]
result=run.browser_test(output,time.monotonic()+70,[project/'flow.robot',project/'collaboration.robot'],checks,
 browser_config=config,app_url='http://127.0.0.1:'+sys.argv[2],fixture_port=int(sys.argv[2]))
from optimise_flow import Context
context=Context(project/'artifacts'/'remote-optimisation',1,browser_config=config,
 browser_app_url='http://127.0.0.1:{port}').start()
try:
 observed=context.browser_call('member-a',None,context.root,operation='session')
 assert observed['principal']=='member-a'
 refused=context.browser_call('member-a',None,context.root,operation='binding',
  item='item-1',owner='unknown-owner',revision=1,objective='validation',direct=True)
 assert refused['validation']=='Unknown owner' and refused['dispatched'] is False
 assert context.fixture.state['writes']==0
 engine=context.engine_identity()
 assert engine['boundary']=='browser' and len(engine['engines'])==1 and len(engine['engines'][0])==64
 from optimise_flow import implementation_digest
 assert implementation_digest(config,engine)!=implementation_digest(config,{'boundary':'http','browser':'not_used'})
finally:
 context.close()
print(json.dumps(result))
`;
  const consumerResult = await new Promise((resolve, reject) => {
    execFile(python, ['-c', consumer, path.join(root, 'consumer'), String(appPort)],
      {timeout: 80000, env: {...process.env,
        TREADWAY_FIXTURE_ENDPOINT: `http://127.0.0.1:${server.address().port}/chromium?token=synthetic`}},
      (error, stdout, stderr) => error ? reject(new Error(stdout + stderr)) : resolve(JSON.parse(stdout.trim().split('\n').at(-1))));
  });
  assert.equal(consumerResult.testsPassed, 2);
  assert.equal(consumerResult.remainingItems, 0);
  await workers[0].release(handles[0]);
  assert.equal(await connections[1].eval('localStorage.getItem("sentinel")'), null);
  assert.equal(await fixture.session.eval('localStorage.getItem("sentinel")'), 'unrelated');
  assert.equal(fixture.posts.filter(post => post.path === '/save/dates').length, 1);
  complete = true;
});
