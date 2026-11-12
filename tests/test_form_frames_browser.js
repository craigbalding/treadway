// Explicit same-origin iframe and plain-text editing calibration. No live app.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {execFile}=require('node:child_process');
const {once}=require('node:events');
const {promisify}=require('node:util');
const browserRoot=process.env.FORM_BROWSER_MODULE_ROOT||path.join(__dirname,'../src/treadway/browser');
const {createCdpProxy,connect}=require(path.join(browserRoot,'cdp.js'));
const {FormAssessor}=require(path.join(browserRoot,'form-assessor.js'));
const {launch}=require(path.join(browserRoot,'launcher.js'));
const {navigateFixture}=require('./fixture-navigation.js');
const enabled=process.env.CHROME_BIN&&process.env.FORM_REACT_FIXTURE_ROOT;
test('explicit frame and contenteditable mechanics',{skip:!enabled,timeout:60000},async t=>{
  const posts=[];
  const frame=`<!doctype html><html><body style="margin:8px"><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/app.js"></script></body></html>`;
  const app=`const h=React.createElement;function App(){const [body,setBody]=React.useState('old body'),[count,setCount]=React.useState(0);return h('form',{onSubmit:e=>{e.preventDefault();fetch('/save',{method:'POST',body:JSON.stringify({body,count})});}},h('h2',null,'Framed editor'),h('div',{id:'body',contentEditable:true,role:'textbox','aria-label':'Body',suppressContentEditableWarning:true,onInput:e=>setBody(e.currentTarget.innerText),style:{border:'1px solid',minHeight:'40px'}},body),h('button',{type:'button',onClick:()=>setCount(count+1)},'Render again'),h('button',{type:'submit'},'Save'));}ReactDOM.createRoot(document.getElementById('root')).render(h(App));`;
  let port;
  const server=http.createServer((req,res)=>{
    if(req.url==='/react.js'||req.url==='/react-dom.js'){
      const pkg=req.url==='/react.js'?'react':'react-dom';res.setHeader('Content-Type','application/javascript');
      res.end(fs.readFileSync(path.join(process.env.FORM_REACT_FIXTURE_ROOT,'node_modules',pkg,'umd',pkg+'.development.js')));return;
    }
    if(req.url==='/app.js'){res.setHeader('Content-Type','application/javascript');res.end(app);return;}
    if(req.url==='/frame'){res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'");res.end(frame);return;}
    if(req.method==='POST'){let body='';req.on('data',b=>body+=b);req.on('end',()=>{posts.push(JSON.parse(body));res.end('{}');});return;}
    res.end(`<!doctype html><html><body style="margin:0;height:1800px"><h1>Parent page</h1><p id="parent">Parent text must remain</p><iframe name="canvas" id="canvas" title="Editor canvas" src="/frame" style="display:block;margin:220px 0 0 70px;border:12px solid;width:510px;height:300px"></iframe><iframe id="other" name="other" src="http://localhost:${port}/frame" style="width:300px;height:100px"></iframe></body></html>`);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');port=server.address().port;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'treadway-frame-'));
  let session,browser;
  try{
    browser=await launch({root:path.join(root,'browsers')});
    const cdpPort=browser.connection.cdpPort;
    const proxy=createCdpProxy(browser.connection);
    const target={id:browser.connection.targetId},targets=[target];
    session=await connect(proxy,target.id,{commandTimeoutMs:3000});
    const url='http://127.0.0.1:'+port+'/';
    const records=[];
    const make=selector=>new FormAssessor(session,{frameSelector:selector,record:e=>records.push(JSON.parse(JSON.stringify(e)))});
    async function reset(){await navigateFixture(session,url,{selectors:['iframe[name="canvas"]'],predicate:`(()=>{const child=document.querySelector('iframe[name="canvas"]').contentDocument;return !!child&&child.readyState!=='loading'&&!!child.querySelector('#body');})()`,timeoutMs:5000,record:e=>records.push(e)});return make('iframe[name="canvas"]');}
    const field=s=>s.fields.find(f=>f.id==='body');
    await t.test('parent inspection exposes frames; child binding carries parent and child identity',async()=>{
      const f=await reset(),parent=await new FormAssessor(session).inspect(),s=await f.inspect();
      assert.equal(parent.frames.length,2);assert.equal(parent.fields.some(x=>x.id==='body'),false);
      assert.equal(s.fields.find(x=>x.id==='body').contenteditable,true);
      assert.equal(s.frameContext.selector,'iframe[name="canvas"]');
      assert.equal(s.frameContext.parentDocumentId,parent.documentId);
      assert.notEqual(s.documentId,parent.documentId);
    });
    await t.test('explicit plain text reaches actual React state through a bordered offset frame under CSP',async()=>{
      const f=await reset(),s=await f.inspect();
      const r=await f.apply(s,[{ref:field(s).ref,value:'New framed body',source:'synthetic input',interaction:'insert_plain_text'}]);
      if(!r.complete){const fc=await f.frameContext(3000);r.diagnostic=(await session.cdp.send('Runtime.evaluate',{contextId:fc.contextId,expression:'({active:document.activeElement?.outerHTML,focus:document.hasFocus(),anchor:getSelection()?.anchorNode?.nodeName,anchorParent:getSelection()?.anchorNode?.parentElement?.outerHTML,focusNode:getSelection()?.focusNode?.nodeName,text:getSelection()?.toString()})',returnByValue:true})).result.value;r.parentActive=(await session.cdp.send('Runtime.evaluate',{expression:'document.activeElement?.outerHTML',returnByValue:true})).result.value;}
      assert.equal(r.complete,true,JSON.stringify(r));
      const render=r.after.actions.find(a=>a.label==='Render again');
      const next=await f.attempt(r.after,render.ref,{windowMs:150});
      assert.equal(field(next.after).value,'New framed body');
      const save=next.after.actions.find(a=>a.label==='Save');
      await f.attempt(next.after,save.ref,{windowMs:200});
      assert.deepEqual(posts.at(-1),{body:'New framed body',count:1});
      assert.equal((await session.cdp.send('Runtime.evaluate',{expression:'document.querySelector("#parent").innerText',returnByValue:true})).result.value,'Parent text must remain');
    });
    await t.test('unlabelled editing host does not make its own changed text a stale label',async()=>{
      const f=await reset();
      await f.call('read',{ref:field(await f.inspect()).ref});
      const frame=await f.frameContext(3000);
      await session.cdp.send('Runtime.evaluate',{contextId:frame.contextId,expression:'document.querySelector("#body").removeAttribute("aria-label")'});
      const s=await f.inspect();
      const r=await f.apply(s,[{ref:field(s).ref,value:'Literal <b> text',source:'synthetic',interaction:'insert_plain_text'}]);
      assert.equal(r.complete,true,JSON.stringify(r));assert.equal(field(r.after).value,'Literal <b> text');
    });
    await t.test('framed native selects require an unobscured parent hit target',async()=>{
      const f=await reset(),context=await f.frameContext(3000);
      await session.cdp.send('Runtime.evaluate',{contextId:context.contextId,expression:`document.body.insertAdjacentHTML('beforeend','<select id="choice" aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>')`});
      let found=await f.locate('#choice',{kind:'field'});
      const valid=await f.apply(found.snapshot,[{ref:found.item.ref,value:'b',source:'synthetic'}]);
      assert.equal(valid.complete,true);
      await session.cdp.send('Runtime.evaluate',{expression:`document.body.insertAdjacentHTML('beforeend','<div style="position:fixed;inset:0;background:white;z-index:9999"></div>')`});
      found=await f.locate('#choice',{kind:'field'});
      const blocked=await f.apply(found.snapshot,[{ref:found.item.ref,value:'a',source:'synthetic'}]);
      assert.equal(blocked.complete,false,JSON.stringify(blocked));
      assert.equal((await f.call('read',{ref:found.item.ref})).value,'b');
    });
    await t.test('input that changes the parent route cannot produce reusable preparation',async()=>{
      const f=await reset(),context=await f.frameContext(3000);
      await session.cdp.send('Runtime.evaluate',{contextId:context.contextId,expression:`document.querySelector('#body').addEventListener('input',()=>parent.history.replaceState(null,'','#changed'),{once:true})`});
      const s=await f.inspect();
      const result=await f.apply(s,[{ref:field(s).ref,value:'Changed route text',source:'synthetic',interaction:'insert_plain_text'}]);
      assert.equal(result.complete,false,JSON.stringify(result));
      assert.match(result.contextError,/context_changed/);
      assert.equal(result.after.observed,true);
      assert.notEqual(result.after.frameContext.parentLocationId,s.frameContext.parentLocationId);
    });
    await t.test('implicit rich-text editing and ambiguous/missing/cross-origin frames are refused',async()=>{
      const f=await reset(),s=await f.inspect();
      await assert.rejects(f.apply(s,[{ref:field(s).ref,value:'unknown interaction',source:'synthetic'}]),/explicit_plain_text/);
      await assert.rejects(make('iframe').inspect(),/exactly_one/);
      await assert.rejects(make('#missing').inspect(),/exactly_one/);
      await assert.rejects(make('#other').inspect(),/same_origin_iframe_required/);
      assert.equal(field(await f.inspect()).value,'old body');
    });
    await t.test('parent modal and frame replacement cannot redirect input to a different context',async()=>{
      const f=await reset(),s=await f.inspect();
      await session.cdp.send('Runtime.evaluate',{expression:'const d=document.createElement("div");d.id="overlay";d.setAttribute("role","dialog");d.setAttribute("aria-label","Unexpected modal");d.style="position:fixed;inset:0;background:white;z-index:9999";document.body.append(d)'});
      await assert.rejects(f.apply(s,[{ref:field(s).ref,value:'must not type',source:'synthetic',interaction:'insert_plain_text'}]),/parent_dialog/);
      const withModal=await f.inspect();
      const blocked=await f.apply(withModal,[{ref:field(withModal).ref,value:'must not type',source:'synthetic',interaction:'insert_plain_text'}]);
      assert.equal(blocked.complete,false);assert.equal(field(await f.inspect()).value,'old body');
      await session.cdp.send('Runtime.evaluate',{expression:'document.querySelector("#overlay").remove();const f=document.querySelector("#canvas");f.replaceWith(f.cloneNode(true))'});
      await assert.rejects(f.apply(s,[{ref:field(s).ref,value:'stale',source:'synthetic',interaction:'insert_plain_text'}]),/context_changed/);
    });
    await t.test('actual Robot composes frame bindings across independent CLI invocations',{skip:!process.env.FORM_ROBOT_PYTHON},async()=>{
      await reset();
      const suite=path.join(root,'frame.robot'),journal=path.join(root,'frame.jsonl');
      fs.writeFileSync(suite,`*** Settings ***\nLibrary    treadway.robot.FormLibrary    127.0.0.1    ${cdpPort}    ${target.id}    ${journal}    frame_selector=iframe[name="canvas"]\n*** Test Cases ***\nFramed Editor\n    \${form}=    Inspect Form\n    \${patch}=    Evaluate    [{'ref':next(f['ref'] for f in $form['fields'] if f['id']=='body'),'value':'Robot framed text','source':'synthetic','interaction':'insert_plain_text'}]\n    \${prepared}=    Apply Form Candidates    \${form}    \${patch}\n    \${save}=    Get Form Action    \${prepared}[after]    Save\n    Attempt Form Action    \${prepared}[after]    \${save}[ref]    window_ms=200\n`);
      const result=await promisify(execFile)(process.env.FORM_ROBOT_PYTHON,['-m','robot','--outputdir',path.join(root,'robot-output'),suite],{timeout:20000,cwd:root}).catch(e=>{throw new Error(e.stdout+'\n'+e.stderr);});
      assert.match(result.stdout,/1 test, 1 passed/);assert.equal(posts.at(-1).body,'Robot framed text');
      assert.ok(fs.readFileSync(journal,'utf8').includes('frameContext'));
    });
    await t.test('actual Robot stops after input changes the parent route',{skip:!process.env.FORM_ROBOT_PYTHON},async()=>{
      const f=await reset(),context=await f.frameContext(3000);
      await session.cdp.send('Runtime.evaluate',{contextId:context.contextId,expression:`document.querySelector('#body').addEventListener('input',()=>parent.history.replaceState(null,'','#changed'),{once:true})`});
      const suite=path.join(root,'changed.robot'),journal=path.join(root,'changed.jsonl'),marker=path.join(root,'advanced');
      fs.writeFileSync(suite,`*** Settings ***\nLibrary    treadway.robot.FormLibrary    127.0.0.1    ${cdpPort}    ${target.id}    ${journal}    frame_selector=iframe[name="canvas"]\nLibrary    OperatingSystem\n*** Test Cases ***\nCannot Advance\n    \${form}=    Inspect Form\n    \${patch}=    Evaluate    [{'ref':next(f['ref'] for f in $form['fields'] if f['id']=='body'),'value':'Changed route','source':'synthetic','interaction':'insert_plain_text'}]\n    Apply Form Candidates    \${form}    \${patch}\n    Create File    ${marker}    incorrectly advanced\n`);
      let failure;
      try{await promisify(execFile)(process.env.FORM_ROBOT_PYTHON,['-m','robot','--outputdir',path.join(root,'changed-output'),suite],{timeout:20000,cwd:root});}catch(e){failure=e;}
      assert.equal(failure?.code,1,failure?.stdout);
      assert.equal(fs.existsSync(marker),false);
      assert.match(fs.readFileSync(journal,'utf8'),/form_context_changed/);
    });
  }finally{
    session?.close();if(browser)await browser.stop();
    server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});
  }
});
