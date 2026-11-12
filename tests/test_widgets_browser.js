'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {widgetFixture,browserRoot}=require('./browser-fixture.js');
const {BrowserInteractions}=require(path.join(browserRoot,'interactions.js'));
const {Autocomplete,MultiSelect,DateRange,RichTextEditor,InlineEditor}=require(path.join(browserRoot,'widgets.js'));
const {RequestObserver}=require(path.join(browserRoot,'request-observer.js'));
const {uploadFile,downloadFile}=require(path.join(browserRoot,'transfers.js'));
for(const framework of ['react','vue'])test('shared widget profiles against real '+framework,{skip:!process.env.CHROME_BIN,timeout:180000},async t=>{
  const fixture=await widgetFixture(framework);let ui;
  t.after(async()=>{if(ui)ui.dispose();await fixture.close();});
  const records=[];
  async function reset(){
    if(ui)ui.dispose();
    ui=new BrowserInteractions(fixture.session,{origin:fixture.origin,record:record=>records.push(record)});
    await ui.navigate(fixture.origin+'/');
    await ui.wait('real framework mounted',()=>ui.visible('#choice'));
    return ui.form.inspect();
  }
  const native=(selector,action,methodOverride=null)=>({selector,action:fixture.origin+action,method:'post',methodOverride});
  const dates=()=>new DateRange(ui,{start:'#start',due:'#due',action:{selector:'#date-save'},nativeForm:native('#date-form','/save/dates','patch')});
  function observer(endpoint){return new RequestObserver(fixture.session.cdp,{match:event=>event.request.method==='POST'&&new URL(event.request.url).pathname===endpoint,record:record=>records.push(record)});}
  async function save(profile,prepared,endpoint){
    const result=await observer(endpoint).run(()=>profile.commit(prepared,{windowMs:100}),{windowMs:2000,readBody:true});
    assert.equal(result.action.returned,true,JSON.stringify(result));assert.equal(result.complete,true,JSON.stringify(result));
    assert.equal(result.requests[0].status,201);assert.equal(JSON.parse(result.requests[0].body).id,8);
    return fixture.posts.at(-1);
  }
  const validIdentity=async({option})=>(await ui.form.call('locate',{selector:'[role="option"][data-id="8"]'})).ref===option.ref;
  await t.test('autocomplete uses a controlled portal and persists actual framework state across a render',async()=>{
    const snapshot=await reset(),widget=new Autocomplete(ui,{field:'#choice'});
    const prepared=await widget.prepare({snapshot,query:'Alpha',label:'Alpha',source:'synthetic assignee query'});
    await widget.select(prepared,{label:'Alpha',validateOption:validIdentity,windowMs:100});
    await ui.click('#rerender',{windowMs:100});
    await observer('/save/choice').run(()=>ui.click('#choice-save',{windowMs:100}),{windowMs:1000});
    assert.deepEqual(fixture.posts.at(-1),{path:'/save/choice',value:{id:'8',renders:1}});
  });
  await t.test('multiselect adds two actual IDs and removes one with exact readback',async()=>{
    let snapshot=await reset();
    const widget=new MultiSelect(ui,{field:'#multi',readSelection:()=>ui.evaluate(`([...document.querySelectorAll('#chips>span')].map(e=>e.dataset.id))`),removeSelector:id=>'[data-remove='+JSON.stringify(id)+']'});
    for(const [label,before,after] of [['Alpha',[],['8']],['Beta',['8'],['8','9']]]){
      const prepared=await widget.prepare({snapshot,query:label,label,source:'synthetic contributor query'});
      await widget.select(prepared,{label,before,after,windowMs:100});snapshot=await ui.form.inspect();
    }
    await widget.remove({id:'8',before:['8','9'],after:['9'],source:'explicit synthetic removal'});
    await observer('/save/multi').run(()=>ui.click('#multi-save',{windowMs:100}),{windowMs:1000});
    assert.deepEqual(fixture.posts.at(-1).value.ids,['9']);
  });
  await t.test('date range correlates each native preview and binds an external submit',async()=>{
    const snapshot=await reset(),widget=dates();
    const prepared=await widget.prepare({snapshot,start:'2026-12-07',due:'2026-12-11',source:'explicit synthetic dates',aroundInput:async({name,value,dispatch})=>{
      const preview=new RequestObserver(fixture.session.cdp,{record:record=>records.push(record),match:event=>{
        const url=new URL(event.request.url);return event.request.method==='GET'&&url.pathname==='/preview/dates'&&url.searchParams.get('field')===name&&url.searchParams.get('value')===value;
      }});
      const result=await preview.run(dispatch,{windowMs:1000});
      assert.equal(result.complete,true,JSON.stringify(result));assert.equal(result.action.returned,true);
      await ui.wait('native date preview rendered',()=>ui.evaluate(`document.getElementById('date-panel').dataset.busy==='false'`));
    }});
    await ui.click('#rerender',{windowMs:100});
    assert.deepEqual(await save(widget,prepared,'/save/dates'),{path:'/save/dates',value:{start:'2026-12-07',due:'2026-12-11',renders:1}});
  });
  await t.test('rich-text profile preserves literal Unicode text through framework state and rerender',async()=>{
    const snapshot=await reset(),widget=new RichTextEditor(ui,{editor:{ref:snapshot.fields.find(field=>field.id==='brief').ref},action:{selector:'#rich-save'},nativeForm:native('#rich-form','/save/brief')});
    const value='Synthetic café <b>literal</b>.';
    const prepared=await widget.prepare({snapshot,value,source:'synthetic plain paragraph'});
    await ui.click('#rerender',{windowMs:100});
    assert.deepEqual((await save(widget,prepared,'/save/brief')).value,{body:value,renders:1});
  });
  await t.test('inline editor separates opening, preparation and guarded commit',async()=>{
    const snapshot=await reset(),widget=new InlineEditor(ui,{open:{selector:'#inline-open'},fields:{title:{selector:'#title'}},action:{selector:'#inline-save'},nativeForm:native('#inline-form','/save/item/8')});
    const opened=await widget.open({snapshot,source:'explicit synthetic row edit'});
    const prepared=await widget.prepare({snapshot:opened,values:{title:'Revised synthetic item'},source:'synthetic title'});
    await ui.click('#rerender',{windowMs:100});
    assert.deepEqual((await save(widget,prepared,'/save/item/8')).value,{id:8,title:'Revised synthetic item',renders:1});
  });
  for(const [name,mutation] of [
    ['form resource',`document.querySelector('#date-form').action='/save/item/99'`],
    ['HTTP method',`document.querySelector('#date-form').method='get'`],
    ['method override',`document.querySelector('[name="_method"]').value='delete'`],
    ['submit association',`const other=document.createElement('form');other.id='other';document.body.append(other);document.querySelector('#date-save').setAttribute('form','other')`],
    ['submit override',`document.querySelector('#date-save').setAttribute('formaction','/save/item/99')`],
    ['field reference',`const old=document.querySelector('#start');old.replaceWith(old.cloneNode(true))`],
  ])await t.test('changed '+name+' blocks date commit before any request',async()=>{
    const snapshot=await reset(),widget=dates(),before=fixture.posts.length;
    const prepared=await widget.prepare({snapshot,start:'2026-12-07',due:'2026-12-11',source:'synthetic date input'});
    await ui.evaluate(`(()=>{${mutation};return true;})()`);
    await assert.rejects(widget.commit(prepared,{windowMs:100}),/native_form_binding_differs|prepared_edit_value_or_reference_changed/);
    assert.equal(fixture.posts.length,before);
  });
  await t.test('invalid date cannot start the first field mutation',async()=>{
    const snapshot=await reset(),widget=dates();
    await assert.rejects(widget.prepare({snapshot,start:'2026-02-30',due:'2026-12-11',source:'synthetic invalid date'}),/valid_iso_calendar_date_required/);
    assert.equal(await ui.evaluate(`document.querySelector('#start').value`),'');
  });
  await t.test('a fresh resource guard failure blocks commit with prepared values retained',async()=>{
    const snapshot=await reset(),widget=dates(),before=fixture.posts.length;
    const prepared=await widget.prepare({snapshot,start:'2026-12-07',due:'2026-12-11',source:'synthetic dates'});
    await assert.rejects(widget.commit(prepared,{validate:async()=>false}),/fresh_edit_guard_not_established/);
    assert.equal(fixture.posts.length,before);assert.equal(await ui.evaluate(`document.querySelector('#start').value`),'2026-12-07');
  });
  await t.test('an ambiguous portal ID blocks choice selection',async()=>{
    const snapshot=await reset(),widget=new Autocomplete(ui,{field:'#choice'});
    const prepared=await widget.prepare({snapshot,query:'Alpha',label:'Alpha',source:'synthetic query'});
    await ui.evaluate(`(()=>{const duplicate=document.createElement('div');duplicate.id='choice-portal';document.body.append(duplicate);return true;})()`);
    await assert.rejects(widget.select(prepared,{label:'Alpha'}),/choice_control_target_missing_or_ambiguous/);
    assert.equal(await ui.evaluate(`document.querySelector('#chosen').dataset.id`),'');
  });
  await t.test('a matching option label cannot override a failed actual-ID check',async()=>{
    const snapshot=await reset(),widget=new Autocomplete(ui,{field:'#choice'});
    const prepared=await widget.prepare({snapshot,query:'Alpha',label:'Alpha',source:'synthetic query'});
    await ui.evaluate(`(()=>{document.querySelector('[role="option"][data-id="8"]').dataset.id='99';return true;})()`);
    await assert.rejects(widget.select(prepared,{label:'Alpha',validateOption:validIdentity}),/choice_identity_not_established/);
    assert.equal(await ui.evaluate(`document.querySelector('#chosen').dataset.id`),'');
  });
  await t.test('request headers without finished body preserve status and remain incomplete',async()=>{
    await reset();
    const result=await observer('/slow').run(()=>ui.click('#slow-response',{windowMs:100}),{windowMs:50,readBody:true});
    assert.equal(result.complete,false,JSON.stringify(result));assert.equal(result.requests[0].status,201);
  });
  await t.test('native Robot composes shared profiles across separate CLI calls',{skip:!process.env.FORM_ROBOT_PYTHON},async()=>{
    await reset();
    const dateProfile={start:'#start',due:'#due',action:{selector:'#date-save'},nativeForm:native('#date-form','/save/dates','patch')};
    const choiceProfile={field:'#choice'};
    const richProfile={editor:'#brief',action:{selector:'#rich-save'},nativeForm:native('#rich-form','/save/brief')};
    const journal=path.join(fixture.root,'robot-attempts.jsonl'),suite=path.join(fixture.root,'widgets.robot');
    const library=(kind,profile,alias)=>`Library    treadway.widgets.WidgetLibrary    127.0.0.1    ${fixture.cdpPort}    ${fixture.targetId}    ${fixture.origin}    ${journal}    ${kind}    ${JSON.stringify(profile)}    WITH NAME    ${alias}`;
    fs.writeFileSync(suite,`*** Settings ***
${library('date_range',dateProfile,'Dates')}
${library('autocomplete',choiceProfile,'People')}
${library('rich_text',richProfile,'Brief')}
*** Test Cases ***
Shared Widget Composition
    \${snapshot}=    Dates.Inspect Widget
    \${values}=    Evaluate    {'start':'2026-12-07','due':'2026-12-11'}
    \${prepared}=    Dates.Prepare Widget Inputs    \${snapshot}    \${values}    synthetic Robot dates
    Dates.Commit Widget Edit    \${prepared}    window_ms=100
    \${snapshot}=    People.Inspect Widget
    \${choice}=    People.Prepare Widget Choice    \${snapshot}    synthetic Robot query    query=Alpha    exact_label=Alpha
    People.Select Widget Option    \${choice}    Alpha    option_selector=[role="option"][data-id="8"]    window_ms=100
    \${snapshot}=    Brief.Inspect Widget
    \${values}=    Evaluate    {'content':'Synthetic Robot brief.'}
    \${prepared}=    Brief.Prepare Widget Inputs    \${snapshot}    \${values}    synthetic Robot paragraph
    Brief.Commit Widget Edit    \${prepared}    window_ms=100
`);
    await promisify(execFile)(process.env.FORM_ROBOT_PYTHON,['-m','robot','--outputdir',path.join(fixture.root,'robot-positive'),suite],{cwd:fixture.root,timeout:60000});
    assert.deepEqual(fixture.posts.findLast(post=>post.path==='/save/dates').value,{start:'2026-12-07',due:'2026-12-11',renders:0});
    assert.equal(fixture.posts.at(-1).value.body,'Synthetic Robot brief.');
    assert.equal(await ui.evaluate(`document.getElementById('chosen').dataset.id`),'8');
    const history=fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(history.some(record=>record.kind==='edit_commit_intent'));assert.ok(history.some(record=>record.kind==='controlled_choice_intent'));
  });
  await t.test('Robot stops the following keyword after a changed native form target',{skip:!process.env.FORM_ROBOT_PYTHON},async()=>{
    const snapshot=await reset(),widget=dates(),before=fixture.posts.length;
    const prepared=await widget.prepare({snapshot,start:'2026-12-07',due:'2026-12-11',source:'synthetic guarded Robot input'});
    await ui.evaluate(`(()=>{document.getElementById('date-form').action='/save/item/99';return true;})()`);
    const binding=path.join(fixture.root,'prepared.json');fs.writeFileSync(binding,JSON.stringify(prepared),{mode:0o600});
    const profile={start:'#start',due:'#due',action:{selector:'#date-save'},nativeForm:native('#date-form','/save/dates','patch')};
    const suite=path.join(fixture.root,'blocked.robot'),marker=path.join(fixture.root,'incorrectly-advanced'),failure=path.join(fixture.root,'blocked-result.json');
    fs.writeFileSync(suite,`*** Settings ***
Library    treadway.widgets.WidgetLibrary    127.0.0.1    ${fixture.cdpPort}    ${fixture.targetId}    ${fixture.origin}    ${path.join(fixture.root,'blocked-attempts.jsonl')}    date_range    ${JSON.stringify(profile)}
Library    OperatingSystem
Test Teardown    Retain Widget Failure
*** Keywords ***
Retain Widget Failure
    \${last}=    Get Last Widget Result
    \${json}=    Evaluate    json.dumps($last)    modules=json
    Create File    ${failure}    \${json}
*** Test Cases ***
Changed Target Blocks Following Keyword
    \${prepared}=    Evaluate    json.loads(open(${JSON.stringify(binding)}).read())    modules=json
    Commit Widget Edit    \${prepared}    window_ms=100
    Create File    ${marker}    incorrectly advanced
`);
    await assert.rejects(promisify(execFile)(process.env.FORM_ROBOT_PYTHON,['-m','robot','--outputdir',path.join(fixture.root,'robot-negative'),suite],{cwd:fixture.root,timeout:30000}));
    assert.equal(fs.existsSync(marker),false);assert.equal(fixture.posts.length,before);
    const retained=JSON.parse(fs.readFileSync(failure,'utf8'));
    assert.equal(retained.result.mechanicsComplete,false);assert.equal(retained.result.reason,'native_form_binding_differs');
  });
  await t.test('actual browser upload and download retain the explicit fixture bytes',async()=>{
    await reset();
    const file=path.join(fixture.root,'upload.txt'),data=Buffer.from('Synthetic uploaded café.');fs.writeFileSync(file,data);
    const sha256=crypto.createHash('sha256').update(data).digest('hex');
    const result=await uploadFile(ui,{rootDirectory:fixture.root,filePath:file,sha256,selector:'#upload',source:'synthetic upload'});
    assert.equal(result.uploadDispatched,true);
    await ui.wait('server received actual uploaded bytes',()=>fixture.uploads.some(actual=>actual.equals(data)));
    const directory=path.join(fixture.root,'download-'+framework);fs.mkdirSync(directory);
    const observed=await downloadFile(ui,{rootDirectory:fixture.root,directory,name:'saved.txt',source:'explicit synthetic download',dispatch:()=>ui.click('#download',{windowMs:100})});
    assert.equal(observed.download.sha256,crypto.createHash('sha256').update(fixture.download).digest('hex'));
  });
});
