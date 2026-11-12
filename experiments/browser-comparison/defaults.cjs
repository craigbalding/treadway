#!/usr/bin/env node
'use strict';
// Measure one incompatible upstream default; do not normalize it away.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {fixture}=require('./fixture.cjs');
const {NativeDriver,BrowserWorker,BrowserDriver}=require('./drivers.cjs');
const artifact=path.resolve(__dirname,'../../artifacts','browser-defaults-'+Date.now());
fs.mkdirSync(artifact,{recursive:true,mode:0o700});
const report={complete:false,cases:[]};
async function main(){
  for(const backend of ['native','browser']){
    const app=await fixture('react');let driver,worker;
    try{
      if(backend==='native'){driver=new NativeDriver();await driver.start(path.join(app.root,'dialog'));}
      else{worker=new BrowserWorker(process.env.COMPARISON_PYTHON,path.join(artifact,'browser.log'));await worker.call('start');driver=new BrowserDriver(worker);}
      await driver.context(app.origin);await driver.wait(`!!document.getElementById('choice')`);
      await driver.evaluate(`(()=>{const button=document.createElement('button');button.id='comparison-dialog';button.textContent='Ask for confirmation';button.onclick=()=>{window.comparisonDecision=confirm('Synthetic explicit choice required');window.comparisonAdvanced=true;};document.body.append(button);return true;})()`);
      let refused=false;
      try{await driver.click('#comparison-dialog');}catch(error){
        if(backend!=='native')throw error;
        assert.ok(driver.ui.form.dialog,'refusal must retain an actual observed dialog');refused=true;
      }
      if(backend==='native')assert.equal(refused,true);
      else assert.deepEqual(await driver.evaluate(`({decision:window.comparisonDecision,advanced:window.comparisonAdvanced})`),{decision:false,advanced:true});
      report.cases.push({backend,refused,dialogStillPending:backend==='native',automaticallyDismissed:backend==='browser'});
    }finally{try{if(worker)await worker.close();else if(driver)await driver.close();}finally{await app.close();}}
  }
  report.complete=true;fs.writeFileSync(path.join(artifact,'summary.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({artifact,...report}));
}
main().catch(error=>{report.error=error.stack;fs.writeFileSync(path.join(artifact,'summary.json'),JSON.stringify(report,null,2)+'\n');console.error(error);process.exitCode=1;});
