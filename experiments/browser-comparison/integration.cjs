#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {fixture}=require('./fixture.cjs');
const {NativeDriver,BrowserWorker}=require('./drivers.cjs');
const artifact=path.resolve(__dirname,'../../artifacts','browser-integration-'+Date.now());
fs.mkdirSync(artifact,{recursive:true,mode:0o700});
const report={checks:[],complete:false,filter:process.env.COMPARISON_INTEGRATION_FILTER||null};
const run=promisify(execFile);
async function test(name,operation){
  if(report.filter&&!name.includes(report.filter))return;
  const start=performance.now();
  try{const evidence=await operation();report.checks.push({name,status:'passed',ms:performance.now()-start,evidence});}
  catch(error){report.checks.push({name,status:'failed',ms:performance.now()-start,error:error.stack});process.exitCode=1;}
  finally{fs.writeFileSync(path.join(artifact,'summary.json'),JSON.stringify(report,null,2)+'\n');}
}
async function main(){
  for(const framework of ['react','vue','element-plus'])await test('native Robot composition: '+framework,async()=>{
    const app=await fixture(framework),directory=path.join(artifact,framework),marker=path.join(directory,'incorrectly-advanced');
    fs.mkdirSync(directory);
    try{
      const result=await run(process.env.COMPARISON_PYTHON,['-m','robot','--outputdir',directory,
        '--variable','ORIGIN:'+app.origin,'--variable','CHROME_BIN:'+process.env.CHROME_BIN,
        '--variable','MARKER:'+marker,path.join(__dirname,'comparison.robot')],{timeout:60000}).then(value=>({code:0,...value}),error=>({code:error.code,stdout:error.stdout,stderr:error.stderr}));
      fs.writeFileSync(path.join(directory,'runner.log'),result.stdout+'\n'+result.stderr);
      assert.equal(result.code,1,'exactly one expected negative test must fail');
      const parsed=await run(process.env.COMPARISON_PYTHON,['-c',
        'import json,sys,xml.etree.ElementTree as E; r=E.parse(sys.argv[1]); print(json.dumps([{"name":t.get("name"),"status":t.find("status").get("status"),"message":t.find("status").text} for t in r.findall(".//test")]))',path.join(directory,'output.xml')]);
      const tests=JSON.parse(parsed.stdout);
      assert.equal(tests.length,2);assert.equal(tests[0].status,'PASS');assert.equal(tests[1].status,'FAIL');assert.match(tests[1].message,/prepared_edit_binding_differs/);
      assert.equal(fs.existsSync(marker),false);
      assert.deepEqual(app.posts,[{path:'/save/choice',value:{id:'8',renders:1}}]);
      return {tests,posts:app.posts};
    }finally{await app.close();}
  });
  await test('Browser CDP attachment retains the exact owned target among two tabs',async()=>{
    const app=await fixture('react'),native=new NativeDriver();let worker;
    try{
      await native.start(path.join(app.root,'owned'));await native.context(app.origin);
      const extra=await native.session.cdp.send('Target.createTarget',{url:app.origin+'/?other-tab=1'});
      worker=new BrowserWorker(process.env.COMPARISON_PYTHON,path.join(artifact,'cdp.log'));
      const bound=await worker.call('attach',{endpoint:'http://127.0.0.1:'+native.browser.session.port,targetId:native.browser.connection.targetId});
      assert.equal(bound.pages,2);assert.equal(bound.targetMatches,1);
      assert.equal(await worker.call('cdp-target'),native.browser.connection.targetId);
      await worker.call('click',{selector:'#rerender'});
      assert.equal(await native.evaluate(`document.getElementById('renders').textContent`),'1');
      await worker.close();worker=null;
      assert.equal(await native.evaluate(`document.getElementById('renders').textContent`),'1','detaching must preserve the owned browser');
      return {bound,otherTarget:extra.targetId,ownedBrowserStillUsableAfterDetach:true};
    }finally{try{if(worker)await worker.close();}finally{try{await native.close();}finally{await app.close();}}}
  });
  await test('worker spawn failure and blocked shutdown stay bounded',async()=>{
    const missing=new BrowserWorker(path.join(artifact,'missing-python'),path.join(artifact,'missing-python.log'));
    await assert.rejects(missing.call('start'),/ENOENT/);await missing.close();
    const worker=new BrowserWorker(process.env.COMPARISON_PYTHON,path.join(artifact,'blocked-worker.log'));
    let launches=[];
    try{
      await worker.call('start');await worker.call('context',{url:'about:blank'});
      launches=(await worker.call('launch-observation')).launches;assert.equal(launches.length,1);
      await assert.rejects(worker.call('evaluate',{expression:'new Promise(()=>{})'},100),/deadline/);
      const start=performance.now();
      await assert.rejects(worker.close(),/forced shutdown; cleanup\/effects unconfirmed/);
      const shutdownMs=performance.now()-start;assert.ok(shutdownMs<7500);
      for(const launch of launches)assert.equal(fs.existsSync('/proc/'+launch.pid),false,'owned browser must terminate');
      return {spawnFailureTerminated:true,blockedShutdownMs:shutdownMs,forcedCleanupReportedAsUnconfirmed:true};
    }finally{
      try{await worker.close();}finally{
        for(const launch of launches)if(!fs.existsSync('/proc/'+launch.pid))fs.rmSync(launch.profile,{recursive:true,force:true});
      }
    }
  });
  report.complete=report.checks.length>0&&report.checks.every(check=>check.status==='passed');
  if(!report.complete)process.exitCode=1;
  fs.writeFileSync(path.join(artifact,'summary.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({artifact,complete:report.complete,checks:report.checks.map(({name,status})=>({name,status}))}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
