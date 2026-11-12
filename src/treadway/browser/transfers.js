'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {requireRecord}=require('./interactions.js');
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
function scopedPath(rootDirectory,target,{directory=false}={}){
  const root=path.resolve(rootDirectory),absolute=path.resolve(target),relative=path.relative(root,absolute);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||fs.lstatSync(root).isSymbolicLink()||!fs.statSync(root).isDirectory())throw new Error('explicit_run_scoped_path_required');
  let current=root;
  for(const segment of relative.split(path.sep)){
    current=path.join(current,segment);
    if(fs.lstatSync(current).isSymbolicLink())throw new Error('run_scoped_path_must_not_follow_symlinks');
  }
  const stat=fs.statSync(absolute);
  if(directory?!stat.isDirectory():!stat.isFile())throw new Error('scoped_regular_file_or_directory_required');
  return absolute;
}
function readFile(file,maxBytes){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>maxBytes)throw new Error('bounded_regular_transfer_file_required');
    const data=fs.readFileSync(fd);
    if(data.length>maxBytes)throw new Error('transfer_file_grew_beyond_limit');
    return data;
  }finally{fs.closeSync(fd);}
}
function bounds(maxBytes){if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1024*1024*1024)throw new Error('bounded_transfer_size_required');}
function sourceRequired(source){if(typeof source!=='string'||!source)throw new Error('explicit_transfer_source_required');}
async function uploadFile(ui,{rootDirectory,filePath,sha256,selector,source,maxBytes=16*1024*1024,validateTarget}={}){
  bounds(maxBytes);sourceRequired(source);
  const file=scopedPath(rootDirectory,filePath),data=readFile(file,maxBytes);
  if(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)||digest(data)!==sha256)throw new Error('upload_fixture_hash_differs');
  if(typeof selector!=='string'||!selector.trim())throw new Error('explicit_file_input_selector_required');
  requireRecord(ui.record);
  const document=await ui.session.cdp.send('DOM.getDocument');
  const found=await ui.session.cdp.send('DOM.querySelectorAll',{nodeId:document.root.nodeId,selector});
  if(found.nodeIds.length!==1)throw new Error('unique_upload_input_required');
  const described=await ui.session.cdp.send('DOM.describeNode',{nodeId:found.nodeIds[0]});
  const backendNodeId=described.node.backendNodeId;
  const resolved=await ui.session.cdp.send('DOM.resolveNode',{backendNodeId});
  const objectId=resolved.object.objectId;
  if(!objectId)throw new Error('upload_input_reference_unavailable');
  try{
    if(validateTarget!==undefined&&(typeof validateTarget!=='function'||await validateTarget()!==true))throw new Error('upload_target_guard_not_established');
    const checked=await ui.session.cdp.send('Runtime.callFunctionOn',{objectId,functionDeclaration:`function(selector){return this.isConnected&&this.tagName==='INPUT'&&this.type==='file'&&!this.disabled&&!this.matches(':disabled')&&document.querySelectorAll(selector).length===1&&document.querySelector(selector)===this;}`,arguments:[{value:selector}],returnByValue:true});
    if(checked.exceptionDetails||checked.result?.value!==true)throw new Error('bound_upload_input_changed_or_unusable');
    ui.record({kind:'upload_intent',name:path.basename(file),bytes:data.length,sha256,source,dispatch:'single DOM.setFileInputFiles'});
    await ui.session.cdp.send('DOM.setFileInputFiles',{backendNodeId,files:[file]});
    ui.record({kind:'upload_dispatched',name:path.basename(file),sha256});
    return {uploadDispatched:true,sha256,bytes:data.length,persistence:'unverified'};
  }finally{
    // Releasing a remote handle is observation cleanup, never an upload retry.
    try{await ui.session.cdp.send('Runtime.releaseObject',{objectId});}catch{/* Session loss already makes later observations necessary. */}
  }
}
async function downloadFile(ui,{rootDirectory,directory,name,source,dispatch,windowMs=20000,maxBytes=16*1024*1024}={}){
  bounds(maxBytes);sourceRequired(source);
  if(typeof name!=='string'||!name||['.','..'].includes(name)||path.basename(name)!==name||name.includes('\0')||typeof dispatch!=='function')throw new Error('explicit_download_name_and_action_required');
  const destination=scopedPath(rootDirectory,directory,{directory:true});
  if(fs.readdirSync(destination).length)throw new Error('fresh_run_download_directory_required');
  requireRecord(ui.record);
  ui.record({kind:'download_intent',name,directory:destination,source,dispatch:'single explicit action'});
  await ui.session.cdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:destination});
  const receipt=await dispatch();
  const file=path.join(destination,name);
  await ui.wait('completed browser download',async()=>fs.existsSync(file)&&!fs.existsSync(file+'.crdownload'),windowMs);
  const actual=scopedPath(rootDirectory,file),data=readFile(actual,maxBytes);
  fs.chmodSync(actual,0o600);
  const download={file:actual,bytes:data.length,sha256:digest(data)};
  ui.record({kind:'download_observed',download});
  return {receipt,download,persistence:'unverified',applicationOutcome:'not_evaluated'};
}
module.exports={uploadFile,downloadFile,scopedPath};
