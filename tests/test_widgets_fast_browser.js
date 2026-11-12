'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {widgetFixture,browserRoot}=require('./browser-fixture.js');
const {BrowserInteractions}=require(path.join(browserRoot,'interactions.js'));
const {Autocomplete,DateRange}=require(path.join(browserRoot,'widgets.js'));
for(const framework of ['react','vue'])test('fast '+framework+' delayed controller replacement and guarded commit',{skip:!process.env.CHROME_BIN,timeout:20000},async t=>{
  const fixture=await widgetFixture(framework),records=[];
  const ui=new BrowserInteractions(fixture.session,{origin:fixture.origin,record:record=>records.push(record)});
  t.after(async()=>{ui.dispose();await fixture.close();});
  await ui.navigate(fixture.origin+'/?slow_query=1');
  await ui.wait('framework mounted',()=>ui.visible('#choice'));
  const widget=new Autocomplete(ui,{field:'#choice'});
  const opened=await widget.prepare({snapshot:await ui.form.inspect(),open:true});
  assert.equal(opened.snapshot.listboxes[0].options.length,2);
  const initial=opened.snapshot.listboxes[0].controllers[0].containerRef;let sawPending=false;
  const prepared=await widget.prepare({snapshot:opened.snapshot,query:'Alpha',source:'synthetic delayed exact query',ready:({list})=>{
    if(list.options.length===2){sawPending=true;fixture.releaseQuery('choice');}
    return list.options.length===1&&list.options[0].label==='Alpha';
  }});
  assert.equal(sawPending,true,'exercise the old list while filtering is pending');
  assert.notEqual(prepared.snapshot.listboxes[0].controllers[0].containerRef,initial);
  await widget.select(prepared,{label:'Alpha',validateOption:async({option})=>(await ui.form.call('locate',{selector:'[role="option"][data-id="8"]'})).ref===option.ref,windowMs:100});
  await ui.click('#rerender',{windowMs:100});await ui.click('#choice-save',{windowMs:100});
  await ui.wait('actual framework state saved',()=>fixture.posts.some(post=>post.path==='/save/choice'));
  assert.equal(fixture.posts.at(-1).value.id,'8');
  assert.deepEqual(fixture.searches,['choice'],'one query request; observation never repeats input');
  const dates=new DateRange(ui,{start:'#start',due:'#due',action:{selector:'#date-save'},nativeForm:{selector:'#date-form',action:fixture.origin+'/save/dates',method:'post',methodOverride:'patch'}});
  const edit=await dates.prepare({snapshot:await ui.form.inspect(),start:'2026-12-07',due:'2026-12-11',source:'synthetic fast guard probe'});
  await ui.evaluate(`(()=>{document.getElementById('date-form').action='/save/item/99';return true;})()`);
  await assert.rejects(dates.commit(edit),/native_form_binding_differs/);
  assert.equal(fixture.posts.some(post=>post.path==='/save/item/99'),false);
});
