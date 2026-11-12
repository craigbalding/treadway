// Explicit DOM relationships only; all data and browser processes are synthetic.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {once}=require('node:events');
const browserRoot=process.env.FORM_BROWSER_MODULE_ROOT||path.join(__dirname,'../src/treadway/browser');
const {createCdpProxy,connect}=require(path.join(browserRoot,'cdp.js'));
const {FormAssessor}=require(path.join(browserRoot,'form-assessor.js'));
const {launch}=require(path.join(browserRoot,'launcher.js'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('controlled wrapper listbox relationships',{skip:!process.env.CHROME_BIN,timeout:60000},async t=>{
  const html=`<!doctype html><html><body><main id="fixture">
    <label for="query">Synthetic choice</label><input id="query" role="combobox" aria-controls="panel" aria-expanded="true">
    <div id="panel" aria-label="Choice panel"><div role="listbox" aria-label="Options List">
      <div role="option" data-value="first">First candidate</div>
      <div role="option" data-value="chosen">Chosen candidate</div>
    </div></div></main><script>
    window.picks=[];document.addEventListener('click',event=>{const option=event.target.closest('[role=option]');
      if(option){window.picks.push({value:option.dataset.value,trusted:event.isTrusted});document.querySelector('#query').value=option.textContent;}});
    </script></body></html>`;
  const server=http.createServer((req,res)=>res.end(html));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'treadway-choice-'));
  let session,browser;
  try{
    browser=await launch({root:path.join(root,'browsers')});
    const cdpPort=browser.connection.cdpPort;
    const proxy=createCdpProxy(browser.connection);
    const target={id:browser.connection.targetId},targets=[target];
    session=await connect(proxy,target.id,{commandTimeoutMs:3000});
    const url='http://127.0.0.1:'+server.address().port;
    const evaluate=async expression=>(await session.cdp.send('Runtime.evaluate',{expression,returnByValue:true})).result.value;
    const records=[];
    async function reset(){await session.navigate(url);await session.waitForReady({selectors:['#query'],timeoutMs:3000});
      return new FormAssessor(session,{scope:'#fixture',record:r=>records.push(r)});}
    function selection(s){const field=s.fields.find(f=>f.id==='query'),list=s.listboxes.find(l=>l.options.some(o=>o.label==='Chosen candidate'));
      return {field,list,option:list.options.find(o=>o.label==='Chosen candidate')};}
    async function choose(form,s){const {field,option}=selection(s);return form.attempt(s,option.ref,{intent:'choose_option',fieldRef:field.ref,windowMs:100});}

    await t.test('passively observes unique controlled wrapper and selects the explicit usable option',async()=>{
      const form=await reset(),s=await form.inspect(),{field,list,option}=selection(s);
      assert.equal(s.version,'treadway.form/4');assert.equal(list.id,null);
      assert.deepEqual(list.controllers,[{fieldRef:field.ref,controlId:'panel',containerRef:field.controlledElements[0].containerRef}]);
      assert.deepEqual(field.controlledElements[0].listboxRefs,[list.ref]);assert.equal(option.visible,true);
      assert.deepEqual(await evaluate('window.picks'),[]);
      const result=await choose(form,s);
      assert.equal(result.actionDispatch,'dispatched');assert.equal(result.completion,'unconfirmed');
      assert.equal(result.after.fields.find(f=>f.id==='query').value,'Chosen candidate');
      assert.deepEqual(await evaluate('window.picks'),[{value:'chosen',trusted:true}]);
    });
    await t.test('textarea combobox owns a unique popup and selects one explicit suggestion',async()=>{
      const form=await reset();
      await evaluate(`document.querySelector('#query').outerHTML='<textarea id="query" role="combobox" aria-owns="panel" aria-expanded="true"></textarea>'`);
      const s=await form.inspect(),{field,list}=selection(s);
      assert.equal(field.controls,null);assert.equal(field.owns,'panel');assert.equal(field.tag,'textarea');
      assert.equal(list.controllers.length,1);assert.equal(list.controllers[0].fieldRef,field.ref);
      const prepared=await form.apply(s,[{ref:field.ref,value:'Synthetic query',source:'explicit synthetic textarea query',interaction:'type_query'}]);
      assert.equal(prepared.complete,true,JSON.stringify(prepared));
      assert.deepEqual(await evaluate('window.picks'),[]);
      assert.equal((await choose(form,prepared.after)).actionDispatch,'dispatched');
      assert.deepEqual(await evaluate('window.picks'),[{value:'chosen',trusted:true}]);
    });
    await t.test('the same ID in controls and owns is one relationship, not a fallback',async()=>{
      const form=await reset();await evaluate(`document.querySelector('#query').setAttribute('aria-owns','panel')`);
      const s=await form.inspect(),{field}=selection(s);
      assert.equal(field.controlledElements.length,1);
      assert.equal((await choose(form,s)).actionDispatch,'dispatched');
    });
    await t.test('explicit query retains focus and its open choices when blur clears the search input',async()=>{
      const form=await reset();
      await evaluate(`window.queryBlurs=0;const query=document.querySelector('#query'),panel=document.querySelector('#panel');
        query.addEventListener('blur',()=>{window.queryBlurs++;query.value='';panel.style.display='none';query.setAttribute('aria-expanded','false');});
        panel.addEventListener('mousedown',e=>e.preventDefault());
        document.querySelector('#fixture').insertAdjacentHTML('beforeend','<input id="ordinary" aria-label="Ordinary field">');
        window.ordinaryBlurs=0;document.querySelector('#ordinary').addEventListener('blur',()=>window.ordinaryBlurs++);`);
      const s=await form.inspect(),field=selection(s).field;
      const prepared=await form.apply(s,[{ref:field.ref,value:'Synthetic search',source:'synthetic query',interaction:'type_query'}]);
      assert.equal(prepared.complete,true,JSON.stringify(prepared));
      assert.equal(prepared.after.fields.find(f=>f.id==='query').value,'Synthetic search');
      assert.equal(await evaluate('document.activeElement.id'),'query');assert.equal(await evaluate('window.queryBlurs'),0);
      assert.equal((await choose(form,prepared.after)).actionDispatch,'dispatched');
      assert.deepEqual(await evaluate('window.picks'),[{value:'chosen',trusted:true}]);
      const ordinary=await form.locate('#ordinary',{kind:'field'});
      assert.equal((await form.apply(ordinary.snapshot,[{ref:ordinary.item.ref,value:'Ordinary value',source:'synthetic'}])).complete,true);
      assert.equal(await evaluate('window.ordinaryBlurs'),1);
      assert.notEqual(await evaluate('document.activeElement.id'),'ordinary');
    });
    await t.test('current relation change refuses an option even when the same list and option nodes survive',async()=>{
      const form=await reset(),s=await form.inspect();
      await evaluate(`const wrapper=document.createElement('div');wrapper.id='replacement';wrapper.setAttribute('aria-label','Replacement panel');document.querySelector('#fixture').append(wrapper);wrapper.append(document.querySelector('[role=listbox]'));document.querySelector('#query').setAttribute('aria-controls','replacement')`);
      assert.equal(selection(await form.inspect()).option.ref,selection(s).option.ref);
      await assert.rejects(choose(form,s),/association_changed/);assert.deepEqual(await evaluate('window.picks'),[]);
      assert.equal((await choose(form,await form.inspect())).actionDispatch,'dispatched');
    });
    for(const [name,mutation,reason] of [
      ['duplicate controlled ID',`document.querySelector('#fixture').insertAdjacentHTML('beforeend','<div id="panel"></div>')`,/target_missing_or_ambiguous/],
      ['missing controlled ID',`document.querySelector('#query').setAttribute('aria-controls','missing')`,/target_missing_or_ambiguous/],
      ['missing owned ID alongside a valid controls ID',`document.querySelector('#query').setAttribute('aria-owns','missing')`,/target_missing_or_ambiguous/],
      ['conflicting controls and owns paths',`document.querySelector('[role=listbox]').id='direct-list';document.querySelector('#query').setAttribute('aria-owns','direct-list')`,/controller_ambiguous/],
      ['two visible contained listboxes',`document.querySelector('#panel').insertAdjacentHTML('beforeend','<div role="listbox" aria-label="Second list"><div role="option">Other</div></div>')`,/listbox_missing_or_ambiguous/],
      ['two controller paths to one listbox',`document.querySelector('[role=listbox]').id='direct-list';document.querySelector('#query').setAttribute('aria-controls','panel direct-list')`,/controller_ambiguous/],
      ['hidden option',`document.querySelector('[data-value=chosen]').style.display='none'`,/not_usable/],
      ['ARIA-hidden option',`document.querySelector('[data-value=chosen]').setAttribute('aria-hidden','true')`,/not_usable/],
      ['disabled option',`document.querySelector('[data-value=chosen]').setAttribute('aria-disabled','true')`,/not_usable/],
      ['disabled listbox',`document.querySelector('[role=listbox]').setAttribute('aria-disabled','true')`,/not_usable/],
      ['disabled controlled wrapper',`document.querySelector('#panel').setAttribute('aria-disabled','true')`,/not_usable/],
      ['hidden field',`document.querySelector('#query').style.display='none'`,/field_not_usable/],
      ['disabled field',`document.querySelector('#query').disabled=true`,/field_not_usable/],
      ['readonly field',`document.querySelector('#query').readOnly=true`,/field_not_usable/],
    ]) await t.test(name+' is refused before pointer dispatch',async()=>{
      const form=await reset(),before=await form.inspect();await evaluate(mutation);
      await assert.rejects(choose(form,before),reason);assert.deepEqual(await evaluate('window.picks'),[]);
    });
    await t.test('a hidden second listbox does not become an associated choice or fallback',async()=>{
      const form=await reset();
      await evaluate(`document.querySelector('#panel').insertAdjacentHTML('beforeend','<div role="listbox" style="display:none"><div role="option">Hidden other</div></div>')`);
      const s=await form.inspect();assert.equal(s.listboxes.length,1);
      assert.equal((await choose(form,s)).actionDispatch,'dispatched');
      assert.deepEqual(await evaluate('window.picks'),[{value:'chosen',trusted:true}]);
    });
    await t.test('unrelated visible listboxes cannot supply an option for the chosen field',async()=>{
      const form=await reset();
      await evaluate(`document.querySelector('#fixture').insertAdjacentHTML('beforeend','<div role="listbox" aria-label="Unrelated"><div role="option">Other candidate</div></div>')`);
      const s=await form.inspect(),field=selection(s).field;
      const unrelated=s.listboxes.find(l=>l.options.some(o=>o.label==='Other candidate'));
      assert.deepEqual(unrelated.controllers,[]);
      await assert.rejects(form.attempt(s,unrelated.options[0].ref,{intent:'choose_option',fieldRef:field.ref,windowMs:100}),/observed_option_reference/);
      assert.deepEqual(await evaluate('window.picks'),[]);
      assert.equal((await choose(form,s)).actionDispatch,'dispatched');
    });
    await t.test('final pointer preparation rechecks the relation after the attempt is journaled',async()=>{
      const form=await reset(),s=await form.inspect(),pointer=form.pointer.bind(form);
      form.pointer=async(ref,choice)=>{await evaluate(`document.querySelector('#query').setAttribute('aria-controls','missing')`);return pointer(ref,choice);};
      const result=await choose(form,s);
      assert.equal(result.actionDispatch,'attempted');assert.match(result.actionError,/association_changed/);
      assert.equal(result.recordStatus,'recorded');assert.deepEqual(await evaluate('window.picks'),[]);
    });
    await t.test('actual Robot selects a wrapper option and stops dependent work for duplicate control IDs',{skip:!process.env.FORM_ROBOT_PYTHON},async()=>{
      const suite=path.join(root,'choices.robot'),journal=path.join(root,'choices.jsonl'),marker=path.join(root,'advanced');
      fs.writeFileSync(suite,`*** Settings ***\nLibrary    treadway.robot.FormLibrary    127.0.0.1    ${cdpPort}    ${targets[0].id}    ${journal}    scope=#fixture\nLibrary    OperatingSystem\n*** Test Cases ***\nExplicit Choice\n    \${form}=    Inspect Form\n    \${field}=    Evaluate    next(f for f in $form['fields'] if f['id']=='query')\n    \${option}=    Evaluate    next(o for box in $form['listboxes'] for o in box['options'] if o['label']=='Chosen candidate')\n    Attempt Form Action    \${form}    \${option}[ref]    intent=choose_option    field_ref=\${field}[ref]    window_ms=100\n    Create File    ${marker}    advanced after established mechanics\n`);
      await reset();
      const success=await promisify(execFile)(process.env.FORM_ROBOT_PYTHON,['-m','robot','--outputdir',path.join(root,'robot-success'),suite],{timeout:20000,cwd:root});
      assert.match(success.stdout,/1 test, 1 passed/);assert.equal(fs.existsSync(marker),true);fs.unlinkSync(marker);
      assert.deepEqual(await evaluate('window.picks'),[{value:'chosen',trusted:true}]);
      await reset();await evaluate(`document.querySelector('#fixture').insertAdjacentHTML('beforeend','<div id="panel"></div>')`);
      let failure;
      try{await promisify(execFile)(process.env.FORM_ROBOT_PYTHON,['-m','robot','--outputdir',path.join(root,'robot-failure'),suite],{timeout:20000,cwd:root});}catch(e){failure=e;}
      assert.equal(failure?.code,1,failure?.stdout);assert.equal(fs.existsSync(marker),false);
      assert.deepEqual(await evaluate('window.picks'),[]);
    });
  }finally{
    session?.close();if(browser)await browser.stop();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});
  }
});
