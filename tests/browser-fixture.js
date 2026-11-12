'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {once}=require('node:events');
const browserRoot=process.env.FORM_BROWSER_MODULE_ROOT||path.join(__dirname,'../src/treadway/browser');
const {createCdpProxy,connect}=require(path.join(browserRoot,'cdp.js'));
const {launch}=require(path.join(browserRoot,'launcher.js'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function widgetFixture(framework,{launchBrowser=true,extraAssets={},extraScripts=[],extraStyles=[],handleRequest}={}){
  const posts=[],uploads=[],searches=[],pendingQueries=new Map(),releasedQueries=new Set(),timers=new Set();
  const releaseQuery=field=>{releasedQueries.add(field);for(const response of pendingQueries.get(field)||[])response.end('{}');pendingQueries.delete(field);};
  const fixtureRoot=process.env.FRAMEWORK_FIXTURE_ROOT||process.env.FORM_REACT_FIXTURE_ROOT||path.join(__dirname,'..');
  const download=Buffer.from('Synthetic downloaded café.\n');
  const assets={'/react.js':['react','umd/react.development.js'],'/react-dom.js':['react-dom','umd/react-dom.development.js'],'/vue.js':['vue','dist/vue.global.js']};
  const later=(callback,delay)=>{const timer=setTimeout(()=>{timers.delete(timer);callback();},delay);timers.add(timer);};
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://synthetic.invalid');
    if(handleRequest?.(req,res,url))return;
    if(extraAssets[url.pathname]){const asset=extraAssets[url.pathname];res.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(asset));return;}
    if(assets[url.pathname]){res.setHeader('Content-Type','application/javascript');res.end(fs.readFileSync(path.join(fixtureRoot,'node_modules',...assets[url.pathname])));return;}
    if(url.pathname==='/app.js'){res.setHeader('Content-Type','application/javascript');res.end(fs.readFileSync(path.join(__dirname,'fixtures/widgets',framework+'.js')));return;}
    if(url.pathname==='/download'){res.setHeader('Content-Type','text/plain');res.setHeader('Content-Disposition','attachment; filename="saved.txt"');res.end(download);return;}
    if(url.pathname==='/slow'){res.writeHead(201,{'Content-Type':'application/json'});res.write('{"id":');later(()=>res.end('8}'),2000);return;}
    if(url.pathname==='/query-results'){
      const field=url.searchParams.get('field');searches.push(field);res.setHeader('Content-Type','application/json');
      if(releasedQueries.has(field))res.end('{}');
      else {if(!pendingQueries.has(field))pendingQueries.set(field,[]);pendingQueries.get(field).push(res);}
      return;
    }
    if(url.pathname==='/preview/dates'){later(()=>{res.setHeader('Content-Type','application/json');res.end('{}');},100);return;}
    if(req.method==='POST'){
      const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
        const data=Buffer.concat(chunks);
        if(url.pathname==='/upload')uploads.push(data);
        else posts.push({path:url.pathname,value:JSON.parse(data.toString('utf8'))});
        res.writeHead(201,{'Content-Type':'application/json'});res.end('{"id":8}');
      });return;
    }
    res.setHeader('Content-Type','text/html');
    res.end(`<!doctype html><html><head>${extraStyles.map(url=>`<link rel="stylesheet" href="${url}">`).join('')}<style>body{font:16px sans-serif;margin:20px}section,form{margin:12px 0}input,button,a{margin:5px}#brief{border:1px solid;min-height:38px;width:400px}[role=option]{padding:8px;border:1px solid}#choice-portal,#multi-portal{position:fixed;top:5px;right:5px;z-index:10;background:white}</style></head><body><div id="root"></div><div id="choice-portal"></div><div id="multi-portal"></div>${framework==='react'?'<script src="/react.js"></script><script src="/react-dom.js"></script>':'<script src="/vue.js"></script>'}${extraScripts.map(url=>`<script src="${url}"></script>`).join('')}<script src="/app.js"></script></body></html>`);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'treadway-widgets-'));
  fs.chmodSync(root,0o700);
  let session,browser;
  async function close({preserveEvidence=false}={}){
    try{
    if(preserveEvidence&&session){
      const observed={complete:false};
      try{
        const state=await session.cdp.send('Runtime.evaluate',{expression:'({url:location.href,title:document.title,ready:document.readyState})',returnByValue:true},{timeoutMs:1000});
        if(!state.exceptionDetails&&state.result?.value){observed.screen=state.result.value;observed.complete=true;}
        const image=await session.cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},{timeoutMs:1000});
        if(typeof image.data==='string')fs.writeFileSync(path.join(root,'failure.png'),Buffer.from(image.data,'base64'),{flag:'wx',mode:0o600});
      }catch(error){observed.error={name:error.name,code:error.code||'observation_incomplete'};}
      fs.writeFileSync(path.join(root,'failure.json'),JSON.stringify(observed),{flag:'wx',mode:0o600});
    }
    }finally{
    if(session)session.close();
    let cleanupComplete=false;
    try{if(browser)await browser.stop();cleanupComplete=true;}
    catch(error){error.evidenceDirectory=root;throw error;}
    finally{
      for(const timer of timers)clearTimeout(timer);
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      if(!preserveEvidence&&cleanupComplete)fs.rmSync(root,{recursive:true,force:true});
    }
    }
  }
  try{
    if(launchBrowser){
      browser=await launch({root:path.join(root,'browsers')});
      session=await connect(createCdpProxy(browser.connection),browser.connection.targetId,{commandTimeoutMs:5000});
    }
    return {session,browserSession:browser?.session,root,posts,uploads,download,searches,releaseQuery,origin:'http://127.0.0.1:'+server.address().port,cdpPort:browser?.connection.cdpPort,targetId:browser?.connection.targetId,close};
  }catch(error){
    try{await close({preserveEvidence:true});}catch{error.cleanup='incomplete';}
    error.evidenceDirectory=root;
    throw error;
  }
}
module.exports={widgetFixture,browserRoot};
