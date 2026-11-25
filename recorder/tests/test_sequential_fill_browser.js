'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let playwright;
try { playwright = require(process.env.RECORDER_PLAYWRIGHT || 'playwright'); } catch (_) {}
if (!playwright && process.env.RECORDER_REQUIRE_BROWSER === '1') throw new Error('Playwright is required for sequential fill checks');
const repository = path.join(__dirname, '../..');
const assets = { '/react.js': 'node_modules/react/umd/react.development.js',
  '/react-dom.js': 'node_modules/react-dom/umd/react-dom.development.js',
  '/mui.js': 'node_modules/@mui/material/umd/material-ui.development.js' };
const dependencies = Object.values(assets).every(file => fs.existsSync(path.join(repository, file)));
const richForm = `<!doctype html><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/mui.js"></script><script>
const h=React.createElement,{TextField}=MaterialUI;
window.edits=[];window.submissions=0;
function App(){
 const [country,setCountry]=React.useState(''),[region,setRegion]=React.useState(''),[loading,setLoading]=React.useState(false),
 [member,setMember]=React.useState(''),[number,setNumber]=React.useState(''),[surname,setSurname]=React.useState('');
 const change=(name, setter)=>event=>{window.edits.push(name);setter(event.target.value)};
 return h('form',{style:{margin:30,width:400},'aria-busy':loading,onSubmit:e=>{e.preventDefault();window.submissions++}},
 h('label',{style:{display:'block'}},'Country',h('select',{name:'country',required:true,value:country,onChange:e=>{
 window.edits.push('country');setCountry(e.target.value);setLoading(true);setRegion('');
 setTimeout(()=>{window.regionsReady=true;setLoading(false)},450)
 }},h('option',{value:''},'Select'),h('option',{value:'Exampleland'},'Exampleland'))),
 h('label',{style:{display:'block'}},'Region',h('select',{name:'region',required:true,disabled:loading,value:region,onChange:change('region',setRegion)},
 h('option',{value:''},'Select'),!loading&&country?h('option',{value:'North'},'North'):h('option',{value:'Old'},'Old'))),
 h('label',{style:{display:'block'}},'Membership status',h('select',{name:'membership_status',required:true,value:member,onChange:change('membership',setMember)},
 h('option',{value:''},'Select'),h('option',{value:'Yes'},'Yes'),h('option',{value:'No'},'No'))),
 member==='Yes'?h(TextField,{name:'membership_number',label:'Membership number',required:true,value:number,onChange:change('number',setNumber),fullWidth:true}):null,
 h(TextField,{name:'family_name',label:'Surname',required:true,value:surname,onChange:change('surname',setSurname),fullWidth:true}),
 h('button',null,'Save'));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));</script>`;

test('Fill all follows live human order and preserves prerequisites', { skip: !playwright, timeout: 90000 }, async t => {
  const browser = await playwright.chromium.launch({ headless: true, chromiumSandbox: true,
    ...(process.env.RECORDER_CHROMIUM_BIN ? { executablePath: process.env.RECORDER_CHROMIUM_BIN } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  async function load(html) {
    await page.goto('about:blank'); await page.setContent('<!doctype html><style>label{display:block;margin:8px}</style>' + html);
    for (const file of ['fields.js','form-runtime.js','choice-binding.js','page-fill.js']) await page.addScriptTag({ path:path.join(repository,'recorder/lib',file) });
  }
  const facts = values => Object.fromEntries(Object.entries(values).map(([type,value])=>[type,{value,source:'persona'}]));
  await t.test('real React/MUI waits for the dependent lookup and fills a newly revealed required input before the surname', { skip: !dependencies }, async () => {
    await page.route('http://app.example.test/**', route => {
      const asset = assets[new URL(route.request().url()).pathname];
      return route.fulfill({ contentType:asset?'application/javascript':'text/html',body:asset?fs.readFileSync(path.join(repository,asset)):richForm });
    });
    await page.goto('http://app.example.test/sequential');
    await page.locator('input[name=family_name]').waitFor();
    for (const file of ['fields.js','form-runtime.js','choice-binding.js','page-fill.js']) await page.addScriptTag({path:path.join(repository,'recorder/lib',file)});
    const report=await page.evaluate(values=>TreadwayPageFill.fillAll(document,{values}),facts({country:'Exampleland',region:'North',membership_status:'Yes',membership_number:'EXAMPLE-17',family_name:'Example'}));
    assert.equal(report.manual.length,0,JSON.stringify(report.manual));
    assert.equal(report.filled.length,5);
    assert.deepEqual(await page.evaluate(()=>edits),['country','region','membership','number','surname']);
    assert.equal(await page.evaluate(()=>regionsReady),true);
    assert.equal(await page.evaluate(()=>submissions),0);
    assert.equal(report.execution.policy,'human-order');
    await page.unroute('http://app.example.test/**');
  });
  await t.test('an unresolved required input blocks later interaction, and one bound-value recovery resumes local filling',async()=>{
    await load('<label>Required background<textarea name="background" required></textarea></label><label>Surname<input name="family_name"></label>');
    const report=await page.evaluate(values=>TreadwayPageFill.fillAll(document,{values}),facts({family_name:'Example'}));
    assert.equal(report.filled.length,0);assert.equal(report.manual.length,1);
    assert.equal(report.manual[0].required,true);assert.equal(report.blocked.reason,'earlier required field unresolved');
    assert.equal(await page.locator('input').inputValue(),'');
    const resumed=await page.evaluate(values=>TreadwayPageFill.fillAll(document,{values,boundValues:[{binding:TreadwayPageFill.bindingFor(document.querySelector('textarea')),type:'background',value:'Synthetic teaching history',source:'llm'}]}),facts({family_name:'Example'}));
    assert.equal(resumed.filled.length,2);assert.equal(resumed.manual.length,0);
    assert.equal(await page.locator('textarea').inputValue(),'Synthetic teaching history');
    assert.equal(await page.locator('input').inputValue(),'Example');
  });
  await t.test('optional unknown fields do not block later known fields',async()=>{
    await load('<label>Optional note<textarea name="note"></textarea></label><label>Surname<input name="family_name"></label>');
    const report=await page.evaluate(values=>TreadwayPageFill.fillAll(document,{values}),facts({family_name:'Example'}));
    assert.equal(report.filled.length,1);assert.equal(report.manual.length,1);assert.equal(report.manual[0].required,false);
    assert.equal(report.blocked,undefined);
  });
  await t.test('an invalid populated required field is preserved and blocks downstream filling',async()=>{
    await load('<label>Email<input name="email" type="email" value="invalid" required></label><label>Surname<input name="family_name"></label>');
    const report=await page.evaluate(values=>TreadwayPageFill.fillAll(document,{values}),facts({email:'replacement@example.test',family_name:'Example'}));
    assert.equal(await page.locator('[name=email]').inputValue(),'invalid');
    assert.equal(await page.locator('[name=family_name]').inputValue(),'');
    assert.equal(report.manual[0].reason,'existing required field invalid');
    assert.equal(report.blocked.reason,'earlier required field unresolved');
  });
  await t.test('visual order and related fieldsets take precedence over DOM order',async()=>{
    await load('<form style="display:flex;gap:50px;align-items:start"><fieldset style="order:2"><legend>Right group</legend><label>Right<input name="right_value"></label></fieldset><fieldset style="order:1"><legend>Left group</legend><label>Top<input name="left_top"></label><div style="height:60px"></div><label>Lower<input name="left_lower"></label></fieldset></form>');
    const report=await page.evaluate(values=>TreadwayPageFill.fillAll(document,{values}),facts({right_value:'R',left_top:'A',left_lower:'B'}));
    assert.deepEqual(report.filled.map(item=>item.type),['left_top','left_lower','right_value']);
    assert.equal(report.filled[1].groupLabel,'Left group');
  });
  await t.test('request-aware readiness can prevent filling against stale options without a busy DOM marker',async()=>{
    await load('<label>Country<input name="country"></label><label>Region<select name="region"><option value="">Select</option><option value="Old">Old</option></select></label>');
    const report=await page.evaluate(async values=>{
      let completion;
      document.querySelector('input').addEventListener('input',()=>{completion=new Promise(resolve=>setTimeout(()=>{document.querySelector('select').innerHTML='<option value="">Select</option><option value="North">North</option>';resolve()},450))});
      return TreadwayPageFill.fillAll(document,{values,awaitDependencies:()=>completion});
    },facts({country:'Exampleland',region:'North'}));
    assert.equal(report.filled.length,2,JSON.stringify(report.manual));assert.equal(await page.locator('select').inputValue(),'North');
  });
  await t.test('a prerequisite that disables or removes later controls invalidates their old plans',async()=>{
    await load('<label>Country<input name="country" oninput="document.querySelector(\'fieldset\').disabled=true;document.querySelector(\'textarea\').remove()"></label><fieldset><legend>Dependent region</legend><label>Region<input name="region"></label></fieldset><textarea name="note"></textarea><label>Surname<input name="family_name"></label>');
    const report=await page.evaluate(values=>TreadwayPageFill.fillAll(document,{values}),facts({country:'Exampleland',region:'North',note:'Do not type',family_name:'Example'}));
    assert.deepEqual(report.filled.map(entry=>entry.type),['country','family_name']);
    assert.equal(await page.locator('[name=region]').inputValue(),'');
    assert.equal(await page.locator('textarea').count(),0);
  });
  await t.test('an uncertain dependency stops downstream even when the initiating input is optional',async()=>{
    await load('<label>Country<input name="country"></label><label>Surname<input name="family_name"></label>');
    const report=await page.evaluate(values=>TreadwayPageFill.fillAll(document,{values,awaitDependencies:()=>{throw new Error('request completion unconfirmed')}}),facts({country:'Exampleland',family_name:'Example'}));
    assert.equal(report.filled.length,0);assert.equal(report.manual.length,1);assert.equal(report.manual[0].retained,true);
    assert.equal(report.blocked.reason,'earlier form update unresolved');assert.equal(await page.locator('[name=family_name]').inputValue(),'');
  });
  await t.test('observable descriptor classification remains batched while actions proceed one at a time',async()=>{
    await load('<label>Preferred activity<input name="opaque_a"></label><label>Preferred language<input name="opaque_b"></label>');
    const result=await page.evaluate(async values=>{
      const calls=[];const report=await TreadwayPageFill.fillAll(document,{values,classify:async fields=>{
        calls.push(fields.length);return Object.fromEntries(fields.map(field=>[field.key,{type:field.name==='opaque_a'?'activity':'language',confidence:.99,fit:.99}]))
      }});return {report,calls};
    },facts({activity:'Walking',language:'English'}));
    assert.deepEqual(result.calls,[2]);assert.equal(result.report.filled.length,2);
  });
  await t.test('explicit history bindings use record identity rather than order or shared generic facts',async()=>{
    await load('<fieldset><legend>First qualification</legend><label>Institution<input id="first"></label></fieldset><fieldset><legend>Second qualification</legend><label>Institution<input id="second"></label></fieldset>');
    const report=await page.evaluate(()=>TreadwayPageFill.fillAll(document,{
      values:{institution:{value:'Generic Academy',source:'persona'}},profile:{context:{histories:{education:[{id:'older',institution:'Older Academy'},{id:'newer',institution:'Newer Academy'}]}}},
      historyBindings:[{binding:TreadwayPageFill.bindingFor(document.getElementById('first')),historyKind:'education',recordId:'newer',factType:'institution'},
        {binding:TreadwayPageFill.bindingFor(document.getElementById('second')),historyKind:'education',recordId:'older',factType:'institution'}]
    }));
    assert.equal(report.filled.length,2);assert.equal(report.manual.length,0);
    assert.deepEqual(await page.locator('input').evaluateAll(inputs=>inputs.map(input=>input.value)),['Newer Academy','Older Academy']);
    assert.equal(report.filled[0].historyBinding.recordId,'newer');
  });
  await t.test('bound generated values cannot override existing persona facts, operator input or secrets',async()=>{
    await load('<label>Surname<input name="family_name"></label><label>Given name<input name="given_name" value="Human"></label><label>Password<input type="password" name="new_password"></label>');
    const report=await page.evaluate(values=>TreadwayPageFill.fillAll(document,{values,boundValues:[...document.querySelectorAll('input')].map(input=>({binding:TreadwayPageFill.bindingFor(input),type:input.name,value:'Unwanted',source:'llm'}))}),facts({family_name:'Authoritative'}));
    assert.equal(await page.locator('[name=family_name]').inputValue(),'Authoritative');
    assert.equal(await page.locator('[name=given_name]').inputValue(),'Human');
    assert.equal(await page.locator('[name=new_password]').inputValue(),'');
    assert.equal(report.manual[0].reason,'secret');
  });
  await t.test('Stop during dependency observation prevents the next input',async()=>{
    await load('<label>Country<input name="country"></label><label>Surname<input name="family_name"></label>');
    const operation=page.evaluate(values=>{
      window.controller=new AbortController();return TreadwayPageFill.fillAll(document,{values,signal:controller.signal,awaitDependencies:()=>{window.waiting=true;return new Promise(()=>{})}});
    },facts({country:'Exampleland',family_name:'Example'}));
    await page.waitForFunction(()=>window.waiting);await page.evaluate(()=>controller.abort());
    const report=await operation;assert.equal(report.interrupted,true);assert.equal(await page.locator('[name=family_name]').inputValue(),'');
  });
  await t.test('a second pass routes the same persisted generated fact and carries prior successes without another mutation',async()=>{
    await load('<label>Surname<input name="family_name"></label><label>Background<textarea name="opaque" required></textarea></label><label>City<input name="city"></label>');
    const result=await page.evaluate(async values=>{
      let edits=0;document.querySelector('[name=family_name]').addEventListener('input',()=>edits++);
      const initial=await TreadwayPageFill.fillAll(document,{values});
      values.background={value:'Synthetic teaching history',source:'persona'};
      const report=await TreadwayPageFill.fillAll(document,{values,previousReport:initial,
        boundValues:[{binding:Object.fromEntries(Object.entries(TreadwayPageFill.bindingFor(document.querySelector('textarea'))).reverse()),type:'background',value:'Synthetic teaching history',source:'llm'}]});
      return {initial,report,edits};
    },facts({family_name:'Example',city:'Harbor'}));
    assert.equal(result.initial.filled.length,1);assert.equal(result.report.filled.length,3);
    assert.equal(result.report.filled[0].carriedForward,true);assert.equal(result.edits,1);
    assert.equal(result.report.manual.length,0);
  });
  await t.test('ARIA-required radio groups stop later input until their decision is resolved',async()=>{
    await load('<div role="radiogroup" aria-required="true" aria-label="Employment status"><label>Yes<input type="radio" name="employment" value="yes"></label><label>No<input type="radio" name="employment" value="no"></label></div><label>Surname<input name="family_name"></label>');
    const result=await page.evaluate(async values=>({required:[...document.querySelectorAll('[type=radio]')].map(element=>TreadwayPageFill.describeField(element).required),
      report:await TreadwayPageFill.fillAll(document,{values})}),facts({family_name:'Example'}));
    assert.deepEqual(result.required,[true,true]);
    assert.equal(result.report.manual[0].required,true);
    assert.equal(await page.locator('[name=family_name]').inputValue(),'');
  });
  await t.test('a second data pass never retries a prior failed mutation or runs past its required control',async()=>{
    await load('<label>Code<input name="custom_code" required oninput="this.value=\'\'"></label><label>Surname<input name="family_name"></label>');
    const result=await page.evaluate(async values=>{
      let edits=0;document.querySelector('[name=custom_code]').addEventListener('input',()=>edits++);
      const initial=await TreadwayPageFill.fillAll(document,{values});
      const report=await TreadwayPageFill.fillAll(document,{values,previousReport:initial});return {initial,report,edits};
    },facts({custom_code:'Example-17',family_name:'Example'}));
    assert.equal(result.initial.manual[0].reason,'did not stick');assert.equal(result.edits,1);
    assert.equal(result.report.blocked.reason,'earlier required field unresolved');
    assert.equal(await page.locator('[name=family_name]').inputValue(),'');
  });
});
