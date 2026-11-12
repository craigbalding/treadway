'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {uploadFile,downloadFile}=require('../src/treadway/browser/transfers.js');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'treadway-transfer-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'synthetic.txt');fs.writeFileSync(file,'Synthetic transfer.');
  const sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),events=[];
  const ui={record:r=>events.push(r.kind),session:{cdp:{send:async(method,args)=>{
    events.push(method);
    if(method==='DOM.getDocument')return {root:{nodeId:1}};
    if(method==='DOM.querySelectorAll')return {nodeIds:[2]};
    if(method==='DOM.describeNode')return {node:{backendNodeId:3}};
    if(method==='DOM.resolveNode')return {object:{objectId:'actual-input'}};
    if(method==='Runtime.callFunctionOn')return {result:{value:true}};
    return {};
  }}}};
  return {root,file,sha256,events,ui};
}
test('one verified upload input receives one explicit file, and its handle is released',async t=>{
  const f=fixture(t);
  const result=await uploadFile(f.ui,{rootDirectory:f.root,filePath:f.file,sha256:f.sha256,selector:'#upload',source:'synthetic fixture'});
  assert.equal(result.uploadDispatched,true);assert.equal(f.events.filter(e=>e==='DOM.setFileInputFiles').length,1);
  assert.equal(f.events.at(-1),'Runtime.releaseObject');
  assert.ok(f.events.indexOf('upload_intent')<f.events.indexOf('DOM.setFileInputFiles'));
});
test('changed upload bytes stop before browser inspection',async t=>{
  const f=fixture(t);fs.appendFileSync(f.file,' changed');
  await assert.rejects(uploadFile(f.ui,{rootDirectory:f.root,filePath:f.file,sha256:f.sha256,selector:'#upload',source:'synthetic'}),/upload_fixture_hash_differs/);
  assert.deepEqual(f.events,[]);
});
test('a symlink ancestor cannot escape the scoped upload root',async t=>{
  const f=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'treadway-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,'synthetic.txt'),'Synthetic transfer.');fs.symlinkSync(outside,path.join(f.root,'link'));
  await assert.rejects(uploadFile(f.ui,{rootDirectory:f.root,filePath:path.join(f.root,'link','synthetic.txt'),sha256:f.sha256,selector:'#upload',source:'synthetic'}),/must_not_follow_symlinks/);
  assert.deepEqual(f.events,[]);
});
test('failed fresh upload target guard cannot dispatch and still releases the handle',async t=>{
  const f=fixture(t);
  await assert.rejects(uploadFile(f.ui,{rootDirectory:f.root,filePath:f.file,sha256:f.sha256,selector:'#upload',source:'synthetic',validateTarget:async()=>false}),/upload_target_guard_not_established/);
  assert.equal(f.events.includes('DOM.setFileInputFiles'),false);assert.equal(f.events.at(-1),'Runtime.releaseObject');
});
test('download observes the named bytes in a fresh scoped directory',async t=>{
  const f=fixture(t),directory=path.join(f.root,'download');fs.mkdirSync(directory);
  f.ui.wait=async(_,observe)=>{assert.equal(await observe(),true);};
  let calls=0;
  const result=await downloadFile(f.ui,{rootDirectory:f.root,directory,name:'saved.txt',source:'synthetic',dispatch:async()=>{calls++;fs.copyFileSync(f.file,path.join(directory,'saved.txt'));return {actionDispatch:'dispatched'};}});
  assert.equal(calls,1);assert.equal(result.download.sha256,f.sha256);assert.equal(result.persistence,'unverified');
});
test('an incomplete download blocks observation and never repeats its action',async t=>{
  const f=fixture(t),directory=path.join(f.root,'download');fs.mkdirSync(directory);let calls=0;
  f.ui.wait=async(_,observe)=>{assert.equal(await observe(),false);throw new Error('download_incomplete');};
  await assert.rejects(downloadFile(f.ui,{rootDirectory:f.root,directory,name:'saved.txt',source:'synthetic',dispatch:async()=>{calls++;fs.writeFileSync(path.join(directory,'saved.txt.crdownload'),'partial');}}),/download_incomplete/);
  assert.equal(calls,1);assert.equal(fs.existsSync(path.join(directory,'saved.txt.crdownload')),true);
});
