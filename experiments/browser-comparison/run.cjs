#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {execFileSync}=require('node:child_process');
const {fixture}=require('./fixture.cjs');
const {NativeDriver,BrowserWorker,BrowserDriver}=require('./drivers.cjs');
const root=path.resolve(__dirname,'../..');
const rounds=Number(process.env.COMPARISON_ROUNDS||3);
if(!Number.isInteger(rounds)||rounds<1||rounds>10)throw Error('rounds must be 1..10');
if(!process.env.CHROME_BIN||!process.env.COMPARISON_PYTHON)throw Error('CHROME_BIN and COMPARISON_PYTHON are required');
const artifact=path.join(root,'artifacts','browser-comparison-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex'));
fs.mkdirSync(artifact,{recursive:true,mode:0o700});
const report={schema:1,startedAt:new Date().toISOString(),rounds,chrome:process.env.CHROME_BIN,
  scope:'Synthetic local comparison; experimental adapter, not a production backend',cases:[],failures:[]};
const sourcePaths=[...fs.readdirSync(__dirname).filter(name=>/\.(cjs|py|robot|json|lock|txt)$/.test(name)).map(name=>path.join(__dirname,name)),
  ...fs.readdirSync(path.join(root,'tests/fixtures/widgets')).map(name=>path.join(root,'tests/fixtures/widgets',name)),
  ...fs.readdirSync(path.join(root,'src/treadway/browser')).filter(name=>name.endsWith('.js')).map(name=>path.join(root,'src/treadway/browser',name)),
  ...['tests/browser-fixture.js','src/treadway/browsers.py','package.json','package-lock.json'].map(name=>path.join(root,name))];
report.sources=Object.fromEntries(sourcePaths.map(file=>[path.relative(root,file),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
report.runtime={node:process.version,chromeVersion:execFileSync(process.env.CHROME_BIN,['--version'],{encoding:'utf8'}).trim(),
  chromeSha256:crypto.createHash('sha256').update(fs.readFileSync(process.env.CHROME_BIN)).digest('hex')};
function retain(){fs.writeFileSync(path.join(artifact,'summary.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
async function measure(entry,name,operation){
  const start=performance.now();
  try{const result=await operation();entry.checks.push({name,status:'passed',ms:performance.now()-start});return result;}
  catch(error){entry.checks.push({name,status:'failed',ms:performance.now()-start,error:error.stack});throw error;}
  finally{retain();}
}
async function waitServer(predicate){
  const end=Date.now()+5000;
  while(!predicate()){if(Date.now()>end)throw Error('server observation deadline');await new Promise(resolve=>setTimeout(resolve,10));}
}
async function request(driver,route,{method='GET',body}={}){
  return driver.evaluate(`(async()=>{const response=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(method)},credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000),${body===undefined?'':`headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))},`}});return {status:response.status,body:await response.json()};})()`);
}
async function guardedWrite(driver,binding,title){
  const principal=await request(driver,'/comparison/principal');
  if(principal.status!==200||principal.body.actor!==binding.actor)throw Error('actual_principal_differs');
  const observed=await request(driver,'/comparison/item/8');
  if(observed.body.id!==binding.id||observed.body.revision!==binding.revision)throw Error('resource_revision_differs');
  return request(driver,'/comparison/write/8',{method:'POST',body:{id:binding.id,revision:binding.revision,title}});
}
async function widgets(entry,driver,app){
  const test=(name,operation)=>measure(entry,name,operation);
  await test('mount',async()=>{await driver.wait(`!!document.getElementById('choice')`);});
  await test('delayed-query-exact-id-rerender-persistence',async()=>{
    await driver.query();await waitServer(()=>app.searches.length===1);
    assert.equal(await driver.evaluate(`document.getElementById('chosen').dataset.id`),'');
    assert.equal(app.posts.length,0);
    app.releaseQuery('choice');
    await driver.wait(`[...document.querySelectorAll('[role="option"]')].filter(e=>e.getBoundingClientRect().height>0).length===1`);
    await driver.choose();await driver.click('#rerender');
    assert.deepEqual(await driver.saveChoice(),{status:201,body:{id:8},requests:1});
    await waitServer(()=>app.posts.some(post=>post.path==='/save/choice'));
    assert.deepEqual(app.posts.at(-1),{path:'/save/choice',value:{id:'8',renders:1}});
    assert.deepEqual(app.searches,['choice']);
  });
  await test('wrong-option-id-refused-before-selection',async()=>{
    await driver.navigate(app.origin+'/?slow_query=1');await driver.wait(`!!document.getElementById('choice')`);
    await driver.query();await driver.wait(`[...document.querySelectorAll('[role="option"]')].filter(e=>e.getBoundingClientRect().height>0).length===1`);
    // Wait for Treadway's asynchronous preparation before changing its bound ID.
    if(driver.pending)await driver.pending;
    await driver.evaluate(`(()=>{document.querySelector('[role="option"][data-id="8"]').dataset.id='99';return true;})()`);
    await assert.rejects(driver.choose(),/choice_identity_not_established/);
    assert.equal(await driver.evaluate(`document.getElementById('chosen').dataset.id`),'');
  });
  await test('controlled-date-input-rerender-response-and-server-state',async()=>{
    await driver.navigate(app.origin);await driver.wait(`!!document.getElementById('start')`);
    await driver.prepareEdit({start:'2026-12-07',due:'2026-12-11'});
    await driver.click('#rerender');
    assert.deepEqual(await driver.commitEdit(),{status:201,body:{id:8},requests:1});
    await waitServer(()=>app.posts.some(post=>post.path==='/save/dates'));
    assert.deepEqual(app.posts.at(-1),{path:'/save/dates',value:{start:'2026-12-07',due:'2026-12-11',renders:1}});
  });
  for(const [name,script]of[
    ['changed-form-target',`document.getElementById('date-form').action='/save/item/99'`],
    ['replaced-field',`const old=document.getElementById('start');old.replaceWith(old.cloneNode(true))`],
    ['replaced-action',`const old=document.getElementById('date-save');old.replaceWith(old.cloneNode(true))`],
  ])await test(name+'-refused-and-following-step-stopped',async()=>{
    await driver.navigate(app.origin);await driver.wait(`!!document.getElementById('start')`);
    await driver.prepareEdit({start:'2026-12-07',due:'2026-12-11'});
    const before=app.posts.length;let advanced=false;
    await driver.evaluate(`(()=>{${script};return true;})()`);
    await assert.rejects(async()=>{await driver.commitEdit(false);advanced=true;},/native_form_binding_differs|prepared_edit_.*changed|prepared_edit_binding_differs/);
    assert.equal(advanced,false);assert.equal(app.posts.length,before);
  });
}
async function actors(entry,drivers,app){
  const test=(name,operation)=>measure(entry,name,operation);
  async function use(name){const driver=drivers[name];if(driver.switch)await driver.switch();return driver;}
  await test('actual-principals-and-cookie-local-session-storage-isolation',async()=>{
    for(const name of ['alice','bob','anonymous']){
      const driver=await use(name);const result=await request(driver,'/comparison/login/'+name,{method:'POST'});
      assert.equal(result.body.actor,name==='anonymous'?null:name);
      await driver.evaluate(`(()=>{localStorage.setItem('actor',${JSON.stringify(name)});sessionStorage.setItem('actor',${JSON.stringify(name)});return true;})()`);
    }
    for(const name of ['alice','bob','anonymous']){
      const driver=await use(name);
      assert.equal((await request(driver,'/comparison/principal')).body.actor,name==='anonymous'?null:name);
      assert.deepEqual(await driver.evaluate(`({local:localStorage.getItem('actor'),session:sessionStorage.getItem('actor')})`),{local:name,session:name});
    }
  });
  await test('A-writes-B-writes-A-writes-same-resource',async()=>{
    for(const [name,to,title]of[['alice','bob','A first'],['bob','alice','B second'],['alice',null,'A third']]){
      const driver=await use(name);const binding={id:'8',revision:app.item.revision,actor:name};
      assert.equal((await guardedWrite(driver,binding,title)).status,200);
      if(to)assert.equal((await request(driver,'/comparison/handoff/8',{method:'POST',body:{id:'8',revision:app.item.revision,to}})).status,200);
    }
    assert.equal(app.item.writes,3);assert.equal(app.item.title,'A third');assert.equal(app.item.owner,'alice');assert.equal(app.item.revision,6);
  });
  await test('stale-revision-and-wrong-principal-refused-with-zero-write-requests',async()=>{
    const before=app.attempts.filter(attempt=>attempt.path==='/comparison/write/8').length;
    let advanced=false;
    await test('stale-revision-refusal-latency',()=>assert.rejects(async()=>{await guardedWrite(await use('alice'),{id:'8',revision:1,actor:'alice'},'stale');advanced=true;},/resource_revision_differs/));
    await test('wrong-principal-refusal-latency',async()=>assert.rejects(guardedWrite(await use('bob'),{id:'8',revision:6,actor:'alice'},'wrong actor'),/actual_principal_differs/));
    assert.equal(advanced,false);assert.equal(app.item.writes,3);
    assert.equal(app.attempts.filter(attempt=>attempt.path==='/comparison/write/8').length,before);
  });
  await test('intentional-auth-negative-attempts-reach-application',async()=>{
    assert.equal((await request(await use('alice'),'/comparison/approve/8',{method:'POST'})).status,403);
    assert.equal((await request(await use('bob'),'/comparison/private/8')).status,403);
    assert.equal((await request(await use('anonymous'),'/comparison/private/8')).status,403);
    assert.equal((await request(await use('anonymous'),'/comparison/write/8',{method:'POST',body:{id:'8',revision:6,title:'anonymous'}})).status,401);
    assert.equal((await request(await use('bob'),'/comparison/approve/8',{method:'POST'})).status,200);
    assert.equal(app.item.approvals,1);assert.equal(app.item.writes,3);
    assert.ok(app.attempts.some(a=>a.path==='/comparison/approve/8'&&a.actor==='alice'&&a.status===403));
  });
}
async function runCase(backend,framework,round){
  const entry={backend,framework,round,checks:[],status:'running'};report.cases.push(entry);retain();
  const start=performance.now(),owned=[];let app,worker;
  try{
    app=await fixture(framework);
    const drivers={};
    await measure(entry,'session-start-and-first-mounted-page',async()=>{
      if(backend==='browser'){
        worker=new BrowserWorker(process.env.COMPARISON_PYTHON,path.join(artifact,backend+'-'+framework+'-'+round+'.log'));
        await worker.call('start');drivers.alice=new BrowserDriver(worker);
      }else{drivers.alice=new NativeDriver();owned.push(drivers.alice);await drivers.alice.start(path.join(app.root,'alice'));}
      await drivers.alice.context(app.origin+'/?slow_query=1');
      await drivers.alice.wait(`!!document.getElementById('choice')`);
    });
    await measure(entry,'sandbox-option-and-private-profile-observed',async()=>{
      const observation=backend==='browser'?await worker.call('launch-observation'):{launches:[drivers.alice.launchObservation()]};
      assert.equal(observation.launches.length,1);
      for(const launched of observation.launches){assert.equal(launched.args.includes('--no-sandbox'),false);assert.equal(launched.profileMode,'0o700');}
      entry.launchObservation=observation;
    });
    await widgets(entry,drivers.alice,app);
    assert.equal(app.posts.length,2,'one choice save and one date save; no duplicate or guarded save');
    await measure(entry,'two-additional-actor-sessions-and-pages',async()=>{
      for(const name of ['bob','anonymous']){
        if(backend==='browser')drivers[name]=new BrowserDriver(worker);
        else{drivers[name]=new NativeDriver();owned.push(drivers[name]);await drivers[name].start(path.join(app.root,name));}
        await drivers[name].context(app.origin);
        await drivers[name].wait(`!!document.getElementById('choice')`);
      }
    });
    await actors(entry,drivers,app);
    entry.launchObservation=backend==='browser'?await worker.call('launch-observation'):{launches:owned.map(driver=>driver.launchObservation())};
    entry.browserProcessCount=entry.launchObservation.launches.length;
    assert.equal(entry.browserProcessCount,backend==='browser'?1:3);
    assert.equal(new Set(entry.launchObservation.launches.map(launch=>launch.pid)).size,entry.browserProcessCount);
    assert.equal(new Set(entry.launchObservation.launches.map(launch=>launch.profile)).size,entry.browserProcessCount);
    for(const launched of entry.launchObservation.launches){assert.ok(fs.existsSync('/proc/'+launched.pid));assert.equal(launched.args.includes('--no-sandbox'),false);assert.equal(launched.profileMode,'0o700');}
    entry.status='passed';
  }catch(error){entry.status='failed';entry.error=error.stack;report.failures.push({backend,framework,round,error:error.message});}
  finally{
    if(app)entry.serverEvidence={posts:app.posts,searches:app.searches,attempts:app.attempts,item:{...app.item}};
    await measure(entry,'cleanup',async()=>{
      const errors=[];
      if(worker)try{await worker.close();}catch(error){errors.push(error);}
      for(const driver of owned.reverse())try{await driver.close();}catch(error){errors.push(error);}
      if(app)try{await app.close();}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,'comparison cleanup incomplete');
      for(const launched of entry.launchObservation?.launches||[]){assert.equal(fs.existsSync('/proc/'+launched.pid),false);assert.equal(fs.existsSync(launched.profile),false);}
      if(app)assert.equal(fs.existsSync(app.root),false);
    }).catch(error=>{entry.status='failed';report.failures.push({backend,framework,round,cleanup:error.message});});
    entry.totalMs=performance.now()-start;retain();
    console.log(JSON.stringify({backend,framework,round,status:entry.status,ms:Math.round(entry.totalMs),artifact}));
  }
}
async function main(){
  const frameworks=(process.env.COMPARISON_FRAMEWORKS||'react,vue,element-plus').split(',');
  const selected=(process.env.COMPARISON_BACKENDS||'native,browser').split(',');
  if(!frameworks.length||new Set(frameworks).size!==frameworks.length||frameworks.some(name=>!['react','vue','element-plus'].includes(name)))throw Error('select known, distinct frameworks');
  if(!selected.length||new Set(selected).size!==selected.length||selected.some(name=>!['native','browser'].includes(name)))throw Error('select known, distinct backends');
  for(let round=1;round<=rounds;round++)for(const framework of frameworks){
    // Alternate order so cold cache/thermal effects do not always favor one side.
    for(const backend of(round%2?['native','browser']:['browser','native']).filter(name=>selected.includes(name)))await runCase(backend,framework,round);
  }
  report.finishedAt=new Date().toISOString();report.expectedCases=rounds*frameworks.length*selected.length;
  report.complete=report.failures.length===0&&report.cases.length===report.expectedCases&&report.cases.every(entry=>entry.status==='passed');retain();
  console.log('Report: '+path.join(artifact,'summary.json'));
  if(!report.complete)process.exitCode=1;
}
main().catch(error=>{report.failures.push({fatal:error.stack});retain();console.error(error);process.exitCode=1;});
