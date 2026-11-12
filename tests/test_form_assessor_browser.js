// Optional real-browser calibration checks. These use an isolated local fixture,
// never an existing browser or external application. See docs/forms.md for invocation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const browserRoot = process.env.FORM_BROWSER_MODULE_ROOT || path.join(__dirname, '../src/treadway/browser');
const { createCdpProxy, connect } = require(path.join(browserRoot, 'cdp.js'));
const { FormAssessor, redactFieldValues } = require(path.join(browserRoot, 'form-assessor.js'));
const {launch}=require(path.join(browserRoot,'launcher.js'));
const {navigateFixture}=require('./fixture-navigation.js');
const sleep = ms => new Promise(r=>setTimeout(r,ms));

const enabled = process.env.CHROME_BIN && process.env.FORM_REACT_FIXTURE_ROOT;
test('real Chromium and React form interactions', { skip: !enabled, timeout:60000 }, async t => {
  const fixtureRoot=process.env.FORM_REACT_FIXTURE_ROOT;
  let posts=0;
  const html=`<!doctype html><html><body><div id="root"></div>
    <script src="/react.js"></script><script src="/react-dom.js"></script><script>
    const h=React.createElement;
    function App(){
      const [name,setName]=React.useState('old value'),[step,setStep]=React.useState(1),[error,setError]=React.useState(''),
      [dialog,setDialog]=React.useState(false),[choice,setChoice]=React.useState(''),[open,setOpen]=React.useState(false),[checked,setChecked]=React.useState(false);
      return h(React.Fragment,null,h('a',{href:'#help'},'Help'),
        h('form',{id:'application',onSubmit:e=>{e.preventDefault();fetch('/submit',{method:'POST'});setName('');setError('Registration number required');}},
          h('h1',null,'Application'),h('span',{'aria-current':'step',id:'step'},'Step '+step),
          h('label',{htmlFor:'name'},'Customer name'),h('input',{id:'name',name:'name',value:name,required:true,onChange:e=>setName(e.target.value),'aria-invalid':!!error,'aria-describedby':'name-error'}),
          error&&h('p',{id:'name-error',role:'alert'},error),
          h('label',null,h('input',{id:'declaration',type:'checkbox',checked,onChange:e=>setChecked(e.target.checked)}),'I agree'),
          h('label',null,h('input',{id:'reset-prior',type:'checkbox',onChange:()=>setName('')}),'Reset prior field'),
          h('label',{htmlFor:'town'},'Nearest town *'),h('input',{id:'town',name:'town'}),
          h('label',{id:'kind-label'},'Kind'),h('div',{id:'kind',tabIndex:0,role:'combobox','aria-labelledby':'kind-label','aria-controls':open?'kind-list':undefined,'aria-expanded':open,onMouseDown:()=>setOpen(true)},choice||'Select kind'),
          open&&h('ul',{id:'kind-list',role:'listbox'},['Teacher','Examiner'].map(x=>h('li',{role:'option',key:x,'aria-selected':choice===x,onClick:()=>{setChoice(x);setOpen(false);}},x))),
          h('button',{type:'button',onClick:()=>fetch('/save',{method:'POST',body:JSON.stringify({name,choice,step})})},'Save draft'),
          h('button',{type:'button',onClick:()=>setStep(step+1)},'Next'),
          h('button',{type:'submit'},'Submit'),
          h('button',{type:'button',onClick:()=>setDialog(true)},'Preview'),
          h('button',{type:'button',onClick:()=>alert('Confirm final submission?')},'Browser prompt'),
          h('button',{type:'button',disabled:true},'Disabled action'),
          h('button',{type:'button',onClick:()=>{}},'Ambiguous'),h('button',{type:'button',onClick:()=>{}},'Ambiguous')),
        h('button',{type:'button',form:'application'},'Save and exit'),
        h('table',null,h('tbody',null,h('tr',{id:'folder-row',tabIndex:0,'aria-selected':'false',onClick:e=>{window.rowPicks=(window.rowPicks||0)+1;e.currentTarget.setAttribute('aria-selected','true');}},h('td',null,'Archive folder')))),
        dialog&&h('div',{role:'dialog','aria-modal':'true','aria-label':'Preview application'},h('p',null,'Review this draft'),h('button',{onClick:()=>setDialog(false)},'Close preview')));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(App));</script></body></html>`;
  const server=http.createServer((req,res)=>{
    if(req.url==='/react.js'||req.url==='/react-dom.js'){
      const pkg=req.url==='/react.js'?'react':'react-dom';
      res.setHeader('Content-Type','application/javascript');
      res.end(fs.readFileSync(path.join(fixtureRoot,'node_modules',pkg,'umd',pkg+'.development.js')));return;
    }
    if(req.method==='POST'){posts++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'Draft',submittedAt:null,error:'fixture business validation'}));return;}
    res.setHeader('Content-Type','text/html');res.end(html);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const root=fs.mkdtempSync(path.join(process.env.FORM_FIXTURE_SCRATCH || os.homedir(),'treadway-form-fixture-'));
  let session,browser;
  try{
    browser=await launch({root:path.join(root,'browsers')});
    const port=browser.connection.cdpPort;
    const proxy=createCdpProxy(browser.connection);
    const target={id:browser.connection.targetId},targets=[target];
    session=await connect(proxy,target.id,{commandTimeoutMs:1500});
    const url='http://127.0.0.1:'+server.address().port+'/';
    const records=[];
    async function reset(){await navigateFixture(session,url,{selectors:['#name'],timeoutMs:3000,record:e=>records.push(e)});await sleep(100);return new FormAssessor(session,{scope:'#application',record:e=>records.push(JSON.parse(JSON.stringify(e)))});}
    function one(items,label){const matches=items.filter(i=>i.label===label);assert.equal(matches.length,1,label);return matches[0];}

    await t.test('passive inspection puts all actions first, including external secondary save, without submitting',async()=>{
      const f=await reset(), before=posts, s=await f.inspect();
      assert.equal(Object.keys(s)[1],'actions'); // version, then prominent action inventory
      assert.equal(one(s.actions,'Save draft').type,'button');
      assert.equal(one(s.actions,'Save and exit').inScope,false);
      assert.ok(s.actions.indexOf(one(s.actions,'Save draft')) < s.actions.indexOf(one(s.actions,'Help')));
      assert.equal(one(s.actions,'Disabled action').disabled,true);
      assert.equal(s.actions.filter(a=>a.label==='Ambiguous').length,2);
      assert.equal(s.fields.find(x=>x.id==='name').required,true);
      assert.equal(s.fields.find(x=>x.id==='town').required,false);
      assert.equal(s.guidance.possiblyRequiredEmpty[0].label,'Nearest town *');
      const safe=redactFieldValues(s),name=safe.fields.find(x=>x.id==='name');
      assert.equal(name.value,null);assert.equal(name.valueEmpty,false);assert.equal(name.valueRedacted,true);
      assert.equal(safe.fields.find(x=>x.id==='town').valueEmpty,true);
      assert.equal(safe.fields.find(x=>x.id==='declaration').checked,false);
      assert.deepEqual(safe.actions,s.actions);assert.equal(s.fields.find(x=>x.id==='name').value,'old value');
      const broad=new FormAssessor(session);const all=await broad.inspect();
      assert.ok(all.actions.indexOf(one(all.actions,'Save draft'))<all.actions.indexOf(one(all.actions,'Help')));
      assert.equal(posts,before);
    });
    await t.test('selectors bind one observed control and refuse ambiguity or unrelated containers',async()=>{
      const f=await reset();
      const found=await f.locate('#name',{kind:'field'});
      assert.equal(found.item.id,'name');assert.equal(found.item.ref,found.snapshot.fields.find(x=>x.id==='name').ref);
      assert.equal((await f.locate('button[type=submit]')).item.label,'Submit');
      await assert.rejects(f.locate('button'),/exactly_one/);
      await assert.rejects(f.locate('#missing'),/exactly_one/);
      await assert.rejects(f.locate('#application'),/observed_action/);
      await assert.rejects(f.locate('#name'),/observed_action/);
    });
    await t.test('focusable table rows bind as unverified actions and use one journaled pointer gesture',async()=>{
      const f=await reset(),found=await f.locate('#folder-row');
      assert.equal(found.item.tag,'tr');assert.equal(found.item.tabindex,'0');assert.equal(found.item.behaviour,'unverified');
      const r=await f.attempt(found.snapshot,found.item.ref,{windowMs:150});
      assert.equal(r.actionDispatch,'dispatched');assert.equal(r.after.actions.find(x=>x.ref===found.item.ref).selected,'true');
      const count=await session.cdp.send('Runtime.evaluate',{expression:'window.rowPicks',returnByValue:true});
      assert.equal(count.result.value,1);assert.equal(r.completion,'unconfirmed');
    });
    await t.test('explicit Enter journals a field action and never implies application completion',async()=>{
      const f=await reset(),before=posts;
      const found=await f.locate('#name',{kind:'field'});
      const r=await f.attempt(found.snapshot,found.item.ref,{intent:'press_enter',windowMs:200});
      assert.equal(r.intent,'press_enter');assert.equal(r.actionDispatch,'dispatched');
      assert.equal(posts,before+1);assert.equal(r.completion,'unconfirmed');
      assert.equal(records.filter(x=>x.kind==='action_intent').at(-1).receipt.intent,'press_enter');
      const s=await f.inspect(),a=s.actions.find(x=>x.label==='Next');
      await assert.rejects(f.attempt(s,a.ref,{intent:'press_enter',windowMs:150}),/observed_action_reference/);
    });
    await t.test('trusted input updates actual React controlled state and replaces prior text',async()=>{
      const f=await reset(), s=await f.inspect(), field=s.fields.find(x=>x.id==='name');
      const r=await f.apply(s,[{ref:field.ref,value:'New customer',source:'synthetic fixture'}]);
      assert.equal(r.complete,true,JSON.stringify(r));assert.equal(r.receipts[0].readback.value,'New customer');
      // Force another React render: state, not just a transient DOM assignment,
      // must retain the replacement through the step transition.
      const a=await f.attempt(r.after,one(r.after.actions,'Next').ref,{windowMs:150});
      assert.equal(a.after.fields.find(x=>x.id==='name').value,'New customer');
      assert.equal(a.after.step[0].label,'Step 2');assert.equal(a.requestsObserved.length,0);
    });
    await t.test('source-less patch is refused before typing, and checkbox is explicitly chosen',async()=>{
      const f=await reset(),s=await f.inspect(),field=s.fields.find(x=>x.id==='name');
      await assert.rejects(f.apply(s,[{ref:field.ref,value:'unknown'}]),/source_required/);
      assert.equal((await f.inspect()).fields.find(x=>x.id==='name').value,'old value');
      const checkbox=s.fields.find(x=>x.id==='declaration');
      const r=await f.apply(s,[{ref:checkbox.ref,value:true,source:'explicit fixture declaration'}]);
      assert.equal(r.complete,true);assert.equal(r.receipts[0].readback.checked,true);
    });
    await t.test('Next performs one action and never silently saves from the next step',async()=>{
      const f=await reset(),s=await f.inspect(),before=posts;
      const r=await f.attempt(s,one(s.actions,'Next').ref,{windowMs:150});
      assert.equal(r.after.step[0].label,'Step 2');assert.equal(posts,before);
      await assert.rejects(f.attempt(s,one(s.actions,'Save draft').ref,{windowMs:150}),/context_changed/);
    });
    await t.test('200 business rejection, retained form, and cleared input remain explicit and never imply completion',async()=>{
      const f=await reset(),s=await f.inspect();
      const r=await f.attempt(s,one(s.actions,'Submit').ref,{windowMs:200});
      assert.equal(r.browserResponsive,true);assert.equal(r.completion,'unconfirmed');
      assert.equal(r.after.fields.find(x=>x.id==='name').value,'');
      assert.equal(r.diagnosis,'validation_feedback_present');
      assert.ok(r.changes.fields.some(x=>x.before?.value==='old value'&&x.after?.value===''));
      assert.ok(r.changes.fields.some(x=>x.label==='Customer name'&&x.change==='cleared'));
      assert.ok(r.changes.fields.some(x=>x.label==='I agree'&&x.comparison==='retained'));
      assert.ok(r.events.some(x=>x.type==='Network.responseReceived'&&x.status===200));
      assert.equal(r.after.errors[0].text,'Registration number required');
    });
    await t.test('an alert success notice is unclassified feedback, not a validation failure',async()=>{
      const f=await reset();
      await session.cdp.send('Runtime.evaluate',{expression:`const p=document.createElement('p');p.setAttribute('role','alert');p.textContent='Draft created successfully.';document.querySelector('#application').append(p)`});
      const s=await f.inspect(),r=await f.attempt(s,one(s.actions,'Save draft').ref,{windowMs:150});
      assert.equal(r.diagnosis,'page_feedback_present_completion_unconfirmed');
      assert.equal(r.completion,'unconfirmed');
      assert.equal(r.after.errors[0].text,'Draft created successfully.');
      assert.equal(r.after.errors[0].source,'unclassified_live_feedback');
    });
    await t.test('native invalid events explain blocked action without claiming browser failure',async()=>{
      const f=await reset(),s=await f.inspect();
      const filled=await f.apply(s,[{ref:s.fields.find(x=>x.id==='name').ref,value:'',source:'deliberate empty fixture'}]);
      const before=posts,r=await f.attempt(filled.after,one(filled.after.actions,'Submit').ref,{windowMs:150});
      assert.equal(r.diagnosis,'native_validation_observed');assert.equal(r.browserResponsive,true);assert.equal(posts,before);
    });
    await t.test('in-page modal is reported with its own actions, without implicit dismissal',async()=>{
      const f=await reset(),s=await f.inspect();
      const r=await f.attempt(s,one(s.actions,'Preview').ref,{windowMs:150});
      assert.equal(r.diagnosis,'in_page_dialog_appeared');assert.equal(r.after.dialogs[0].label,'Preview application');
      assert.ok(one(r.after.actions,'Close preview'));
    });
    await t.test('browser alert is captured as a dialog, never retried or silently accepted',async()=>{
      const f=await reset(),s=await f.inspect();
      const r=await f.attempt(s,one(s.actions,'Browser prompt').ref,{windowMs:200});
      assert.equal(r.diagnosis,'browser_dialog_open');assert.equal(r.browserDialog.type,'alert');
      assert.equal(r.browserResponsive,null);assert.equal(r.completion,'unconfirmed');
      // Fixture teardown alone dismisses it; the utility never did.
      await session.cdp.send('Page.handleJavaScriptDialog',{accept:false});
    });
    await t.test('React custom choices are observed and selected by explicit option, without first-option fallback',async()=>{
      const f=await reset(),s=await f.inspect(),field=s.fields.find(x=>x.id==='kind');
      const opened=await f.attempt(s,field.ref,{intent:'open_choices',windowMs:150});
      const list=opened.after.listboxes.find(x=>x.id==='kind-list');assert.ok(list);
      const option=one(list.options,'Examiner');
      const picked=await f.attempt(opened.after,option.ref,{intent:'choose_option',fieldRef:field.ref,windowMs:150});
      assert.equal(picked.after.fields.find(x=>x.id==='kind').display,'Examiner');
      assert.equal(picked.completion,'unconfirmed');
    });
    await t.test('document replacement invalidates old action references',async()=>{
      const f=await reset(),s=await f.inspect();await reset();
      await assert.rejects(f.attempt(s,one(s.actions,'Save draft').ref,{windowMs:150}),/context_changed/);
    });
    await t.test('fresh inspection renews a reference when the same node changes its label',async()=>{
      const f=await reset(),s=await f.inspect(),old=one(s.actions,'Next');
      await session.eval(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Next').textContent='Continue'`);
      const fresh=await f.inspect(),next=one(fresh.actions,'Continue');
      assert.notEqual(next.ref,old.ref);
      const result=await f.attempt(fresh,next.ref,{windowMs:150});assert.equal(result.after.step[0].label,'Step 2');
    });
    await t.test('input and action records retain checkbox choices and actual pre-action values',async()=>{
      const f=await reset(),s=await f.inspect();
      const r=await f.apply(s,[{ref:s.fields.find(x=>x.id==='declaration').ref,value:true,source:'explicit fixture declaration'}]);
      await f.attempt(r.after,one(r.after.actions,'Save draft').ref,{windowMs:150});
      const intent=records.filter(x=>x.kind==='action_intent').at(-1);
      assert.equal(intent.receipt.formStateBefore.fields.find(x=>x.id==='declaration').checked,true);
      assert.equal(intent.receipt.formStateBefore.fields.find(x=>x.id==='name').value,'old value');
      assert.equal(records.filter(x=>x.kind==='input_result').at(-1).result.receipts[0].intended,true);
    });
    await t.test('missing or failed intent recording prevents a save dispatch',async()=>{
      const f=await reset(),s=await f.inspect(),before=posts;f.record=null;
      await assert.rejects(f.attempt(s,one(s.actions,'Save draft').ref,{windowMs:150}),/record_callback_required/);
      f.record=()=>{throw new Error('fixture disk unavailable');};
      await assert.rejects(f.attempt(s,one(s.actions,'Save draft').ref,{windowMs:150}),/disk unavailable/);
      assert.equal(posts,before);
    });
    await t.test('actual Robot adapter streams and recalls one draft-save attempt', { skip:!process.env.FORM_ROBOT_PYTHON },async()=>{
      await reset();
      const suite=path.join(root,'adapter.robot'),journal=path.join(root,'attempts.jsonl');
      fs.writeFileSync(suite,`*** Settings ***\nLibrary    treadway.robot.FormLibrary    127.0.0.1    ${port}    ${target.id}    ${journal}    scope=#application\n\n*** Test Cases ***\nObserve Draft Save\n    \${form}=    Inspect Form    redact_values=True\n    \${save}=    Get Form Action    \${form}    Save draft\n    \${result}=    Attempt Form Action    \${form}    \${save}[ref]    window_ms=200\n    Should Be Equal    \${result}[actionDispatch]    dispatched\n    Should Be Equal    \${result}[completion]    unconfirmed\n    \${history}=    Read Form Attempt History\n    Should Not Be Empty    \${history}[entries]\n`);
      const {stdout}=await promisify(execFile)(process.env.FORM_ROBOT_PYTHON,['-m','robot','--outputdir',path.join(root,'robot-output'),suite],{timeout:20000,cwd:root});
      assert.match(stdout,/action_started/);assert.match(stdout,/action_finished/);
      const records=fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      assert.equal(records[0].kind,'action_intent');assert.equal(records.at(-1).kind,'action_result');
      assert.equal(fs.statSync(journal).mode&0o777,0o600);
    });
    await t.test('actual Robot stops after failed input preparation without an author assertion', {skip:!process.env.FORM_ROBOT_PYTHON}, async()=>{
      await reset();
      const suite=path.join(root,'incomplete.robot'),journal=path.join(root,'incomplete.jsonl'),marker=path.join(root,'advanced');
      fs.writeFileSync(suite,`*** Settings ***\nLibrary    treadway.robot.FormLibrary    127.0.0.1    ${port}    ${target.id}    ${journal}    scope=#application\nLibrary    OperatingSystem\n\n*** Test Cases ***\nFailed Preparation Stops\n    \${located}=    Locate Form Control    input[id="name"]    kind=field\n    \${form}=    Inspect Form\n    \${patch}=    Evaluate    [{'ref':next(f['ref'] for f in $form['fields'] if f['id']=='name'),'value':'Fixture customer','source':'synthetic'}, {'ref':next(f['ref'] for f in $form['fields'] if f['id']=='reset-prior'),'value':True,'source':'synthetic'}]\n    Apply Form Candidates    \${form}    \${patch}\n    Create File    ${marker}    wrongly advanced\n`);
      await assert.rejects(promisify(execFile)(process.env.FORM_ROBOT_PYTHON,['-m','robot','--outputdir',path.join(root,'incomplete-output'),suite],{timeout:20000,cwd:root}),error=>{
        assert.equal(error.code,1);assert.match(error.stdout,/Form apply incomplete/);return true;
      });
      assert.equal(fs.existsSync(marker),false);
      const records=fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      assert.equal(records.at(-1).result.complete,false);
      assert.equal(records.at(-1).result.receipts[0].reason,'later_readback_mismatch');
    });
    await t.test('later conditional changes cannot leave an earlier field falsely marked prepared',async()=>{
      const f=await reset(),s=await f.inspect();
      const r=await f.apply(s,[
        {ref:s.fields.find(x=>x.id==='name').ref,value:'Customer',source:'synthetic fixture'},
        {ref:s.fields.find(x=>x.id==='reset-prior').ref,value:true,source:'explicit conditional choice'},
      ]);
      assert.equal(r.complete,false);assert.equal(r.receipts[0].reason,'later_readback_mismatch');
      assert.equal(r.receipts[0].readback.value,'Customer');assert.equal(r.receipts[0].finalReadback.value,'');
    });
    await t.test('post-action record failure retains actual observations and reports storage failure',async()=>{
      const f=await reset(),s=await f.inspect();
      f.record=e=>{if(e.kind==='action_result')throw new Error('fixture result write failure');};
      const r=await f.attempt(s,one(s.actions,'Submit').ref,{windowMs:150});
      assert.equal(r.recordStatus,'result_write_failed');assert.equal(r.diagnosis,'validation_feedback_present');
      assert.equal(r.after.fields.find(x=>x.id==='name').value,'');
    });
  }finally{
    session?.close();if(browser)await browser.stop();server.closeAllConnections();await new Promise(r=>server.close(r));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
