'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
let playwright;
try { playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright'); } catch (_) {}
if (!playwright && process.env.RECORDER_REQUIRE_BROWSER === '1') throw new Error('playwright is required for query diagnostics checks');
const root = path.join(__dirname, '..');
const fixtureRoot = process.env.FRAMEWORK_FIXTURE_ROOT || path.join(root, '..');
const fixture = `<!doctype html><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/mui.js"></script><script>
const h=React.createElement,{Autocomplete,TextField}=MaterialUI,mode=new URLSearchParams(location.search).get('mode');
window.searches=0;
function App(){const[value,setValue]=React.useState(null),[query,setQuery]=React.useState(''),[open,setOpen]=React.useState(false),[options,setOptions]=React.useState([]),[generation,setGeneration]=React.useState(0);
 React.useEffect(()=>{if(!query.trim())return;const timer=setTimeout(()=>{window.searches++;setOptions([{id:'synthetic-option',label:query}])},mode==='bounded'||mode==='stop'?10000:300);return()=>clearTimeout(timer)},[query]);
 React.useEffect(()=>{if(mode==='no-focus')document.querySelector('input').focus=()=>{}},[]);
 return h('form',{style:{width:500,margin:30}},h(Autocomplete,{key:generation,id:'synthetic-control-private-id',options,value,open:open&&!!query.trim(),filterOptions:x=>x,getOptionLabel:o=>o.label||'',isOptionEqualToValue:(a,b)=>a.id===b.id,
 onOpen:()=>setOpen(true),onClose:()=>setOpen(false),onChange:(_e,next)=>setValue(next),
 onInputChange:(_e,text,reason)=>{setQuery(reason==='input'?text:'');if(text&&reason==='input'){if(mode==='remount')setGeneration(x=>x+1);if(mode==='blur'||mode==='bounded')setTimeout(()=>document.getElementById('private-focus-destination').focus(),mode==='bounded'?3500:25)}},
 renderInput:params=>h(TextField,{...params,label:'Institution',inputProps:{...params.inputProps,name:'private-control-name'}})}),h('button',{id:'private-focus-destination',type:'button'},'Other control'));
}ReactDOM.createRoot(document.getElementById('root')).render(h(App));</script>`;

test('query failure diagnostics distinguish focus loss and remount without retaining query text', { skip: !playwright, timeout: 90000 }, async t => {
  const assets = { '/react.js': 'node_modules/react/umd/react.development.js', '/react-dom.js': 'node_modules/react-dom/umd/react-dom.development.js', '/mui.js': 'node_modules/@mui/material/umd/material-ui.development.js' };
  for (const asset of Object.values(assets)) assert(fs.existsSync(path.join(fixtureRoot, asset)), 'Set FRAMEWORK_FIXTURE_ROOT to installed React/MUI fixtures');
  const server = http.createServer((req,res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    if (assets[url.pathname]) { res.setHeader('Content-Type','text/javascript'); return res.end(fs.readFileSync(path.join(fixtureRoot,assets[url.pathname]))); }
    res.setHeader('Content-Type','text/html'); res.end(fixture);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  browser = await playwright.chromium.launch({ headless: true, chromiumSandbox: true,
    ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}),
    proxy: { server: 'http://127.0.0.1:'+server.address().port, bypass: '<-loopback>' } });
  const query='SyntheticHiddenQuery!42';
  async function run(mode) {
    const page=await browser.newPage(); await page.goto('http://fixture.example.test/?mode='+mode);
    await page.waitForSelector('input');
    for(const file of ['fields.js','form-runtime.js','choice-binding.js','page-fill.js']) await page.addScriptTag({path:path.join(root,'lib',file)});
    const result=await page.evaluate(async({query,mode})=>{
      const added=new Set(),add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document);
      const types=new Set(['focus','focusin','blur','focusout']);
      document.addEventListener=(type,fn,options)=>{if(types.has(type))added.add(fn);return add(type,fn,options)};
      document.removeEventListener=(type,fn,options)=>{if(types.has(type))added.delete(fn);return remove(type,fn,options)};
      const controller=new AbortController();if(mode==='stop')setTimeout(()=>controller.abort(),25);
      const report=await TreadwayPageFill.fillAll(document,{values:{institution:{value:query,source:'persona'}},signal:controller.signal});
      return{report,listenersRemaining:added.size,searches:window.searches,value:document.querySelector('input')?.value};
    },{query,mode}); await page.close(); assert.equal(result.listenersRemaining,0,'temporary focus observers are always removed'); return result;
  }
  function diagnostics(result) {
    const entry=result.report.manual.find(item=>item.queryDiagnostics);assert(entry,'failed lookup carries its own diagnostics');
    const diagnostic=entry.queryDiagnostics;assert(diagnostic.trace.length<=24);assert.equal(diagnostic.trace.at(-1).phase,'failed');
    const encoded=JSON.stringify(diagnostic);
    for(const privateText of [query,'synthetic-control-private-id','private-control-name','private-focus-destination','Institution']) assert(!encoded.includes(privateText),privateText);
    assert(diagnostic.trace.every(item=>typeof item.documentFocused==='boolean'&&typeof item.bindingAvailable==='boolean'&&typeof item.observedOptionCount==='number'));
    return diagnostic;
  }
  await t.test('normal matching remains successful and exports no diagnostic trace',async()=>{const result=await run('normal');assert.equal(result.report.filled.length,1);assert.equal(result.report.manual.length,0);assert.equal(result.value,query);assert.equal(result.searches,2);assert(!JSON.stringify(result.report).includes('queryDiagnostics'));});
  await t.test('delayed blur exposes retained query followed by focus loss and empty query without a search',async()=>{const result=await run('blur'),diag=diagnostics(result);assert.equal(result.report.manual[0].reason,'query was not retained');assert.equal(result.searches,0);assert(diag.trace.some(x=>x.phase==='focusin'));assert(diag.trace.some(x=>x.phase==='after-dispatch'&&x.queryMatches));assert(diag.trace.some(x=>x.phase==='blur'));assert.equal(diag.trace.at(-1).queryMatches,false);assert.equal(diag.trace.at(-1).controlActive,false);});
  await t.test('missing focus events are distinguishable from delayed blur',async()=>{const result=await run('no-focus'),diag=diagnostics(result);assert.equal(result.searches,0);assert(!diag.trace.some(x=>x.phase==='focus'||x.phase==='focusin'));assert.equal(diag.trace.find(x=>x.phase==='after-focus').controlActive,false);assert.equal(diag.trace.at(-1).queryMatches,false);});
  await t.test('a replacement control is distinguished from retained-node value loss',async()=>{const diag=diagnostics(await run('remount'));assert.equal(diag.trace.at(-1).initialConnected,false);assert.equal(diag.trace.at(-1).sameNode,false);assert.equal(diag.trace.at(-1).bindingAvailable,true);});
  await t.test('long observations retain a fixed maximum and the final failed state',async()=>{const diag=diagnostics(await run('bounded'));assert.equal(diag.trace.length,24);assert(diag.dropped>0);assert.equal(diag.trace[0].phase,'before-focus');assert(diag.trace.some(x=>x.phase==='after-dispatch'&&x.queryMatches));assert(diag.trace.some(x=>x.phase==='blur'&&x.elapsedMs>3000),'late focus loss survives bounded stable polling');assert.equal(diag.trace.at(-1).queryMatches,false);});
  await t.test('Stop removes temporary observers and does not apply a choice',async()=>{const result=await run('stop');assert.equal(result.report.filled.length,0);assert.equal(result.report.interrupted,true);assert.equal(result.searches,0);});
});
