'use strict';
const path=require('node:path');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {widgetFixture}=require('../../tests/browser-fixture.js');
async function fixture(framework){
  const sessions=new Map(),attempts=[];
  const item={id:'8',revision:1,owner:'alice',author:'alice',title:'Original',writes:0,approvals:0};
  function handleRequest(req,res,url){
    if(!url.pathname.startsWith('/comparison/'))return false;
    const token=/\bsession=([^;]+)/.exec(req.headers.cookie||'')?.[1];
    const actor=sessions.get(token)||null;
    const finish=(status,body)=>{attempts.push({path:url.pathname,method:req.method,actor,status});res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      let input;try{input=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{finish(400,{error:'bad_json'});return;}
      if(url.pathname.startsWith('/comparison/login/')){
        const name=url.pathname.split('/').at(-1);
        if(!['alice','bob','anonymous'].includes(name)){finish(400,{error:'unknown_fixture_identity'});return;}
        const value=crypto.randomUUID();sessions.set(value,name==='anonymous'?null:name);
        res.setHeader('Set-Cookie','session='+value+'; HttpOnly; SameSite=Strict; Path=/');finish(200,{actor:sessions.get(value)});return;
      }
      if(url.pathname==='/comparison/principal'){finish(200,{actor});return;}
      if(url.pathname==='/comparison/release-query'){base.releaseQuery('choice');finish(200,{released:true});return;}
      if(url.pathname==='/comparison/private/8'){
        finish(actor==='alice'?200:403,actor==='alice'?{id:'8',private:true}:{error:'forbidden'});return;
      }
      if(url.pathname==='/comparison/item/8'&&req.method==='GET'){finish(200,{...item});return;}
      if(!actor){finish(401,{error:'anonymous'});return;}
      if(url.pathname==='/comparison/approve/8'){
        if(actor===item.author){finish(403,{error:'self_approval'});return;}
        item.approvals++;finish(200,{...item});return;
      }
      if(['/comparison/write/8','/comparison/handoff/8'].includes(url.pathname)){
        if(actor!==item.owner){finish(403,{error:'wrong_owner'});return;}
        if(input.id!==item.id||input.revision!==item.revision){finish(409,{error:'stale_resource'});return;}
        if(url.pathname.includes('/handoff/')){
          if(!['alice','bob'].includes(input.to)){finish(400,{error:'unknown_owner'});return;}
          item.owner=input.to;
        }else{item.title=input.title;item.writes++;}
        item.revision++;finish(200,{...item});return;
      }
      finish(404,{error:'missing'});
    });return true;
  }
  const kit=framework==='element-plus';
  const base=await widgetFixture(framework,{launchBrowser:false,handleRequest,
    extraAssets:kit?{'/element-plus.js':path.join(__dirname,'node_modules/element-plus/dist/index.full.js'),'/element-plus.css':path.join(__dirname,'node_modules/element-plus/dist/index.css')}:{},
    extraScripts:kit?['/element-plus.js']:[],extraStyles:kit?['/element-plus.css']:[]});
  // These are HTTP observations of server state, not the submitted UI model.
  return {...base,item,attempts,source:fs.readFileSync(path.join(__dirname,'../../tests/fixtures/widgets',framework+'.js'),'utf8')};
}
module.exports={fixture};
