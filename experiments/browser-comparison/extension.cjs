'use strict';
// Comparison adapter using the supported Browser extension API. Not shipped.
// Retain handles so selector reacquisition cannot silently accept replacement.
const states=new WeakMap();
async function perform(operation,payload,page){
  let state=states.get(page);
  if(!state){state={};states.set(page,state);}
  if(operation==='navigate')return page.goto(payload.url).then(()=>true);
  if(operation==='evaluate')return page.evaluate(payload.expression);
  if(operation==='input')return page.locator(payload.selector).fill(payload.value).then(()=>true);
  if(operation==='click')return page.locator(payload.selector).click().then(()=>true);
  if(operation==='wait')return page.waitForFunction(payload.expression,{},{timeout:5000}).then(()=>true);
  if(operation==='choose'){
    const input=page.locator('#choice');
    const controller=await input.getAttribute('aria-controls')||await input.getAttribute('aria-owns');
    if(!controller||controller.trim().split(/\s+/).length!==1)throw Error('one_choice_controller_required');
    const list=page.locator('[id='+JSON.stringify(controller)+']');
    const options=list.getByRole('option',{name:payload.label,exact:true});
    if(await options.count()!==1)throw Error('one_exact_option_required');
    const handle=await options.elementHandle();
    if(await handle.getAttribute('data-id')!==payload.id)throw Error('choice_identity_not_established');
    await handle.click({timeout:2000});return true;
  }
  async function observeResponse(endpoint,dispatch){
    const requests=[];
    const collect=request=>{if(request.method()==='POST'&&new URL(request.url()).pathname===endpoint)requests.push(request);};
    page.on('request',collect);
    try{
      const observed=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===endpoint,{timeout:2000});
      const [response]=await Promise.all([observed,dispatch()]);
      const body=await response.json();
      if(requests.length!==1||response.request()!==requests[0])throw Error('one_correlated_response_required');
      return {status:response.status(),body,requests:requests.length};
    }finally{page.off('request',collect);}
  }
  if(operation==='save-choice')return observeResponse('/save/choice',()=>page.locator('#choice-save').click());
  if(operation==='prepare-edit'){
    await page.locator('#start').fill(payload.start);await page.locator('#due').fill(payload.due);
    state.edit={url:page.url(),start:await page.locator('#start').elementHandle(),due:await page.locator('#due').elementHandle(),
      action:await page.locator('#date-save').elementHandle(),form:await page.locator('#date-form').elementHandle(),values:payload};
    return true;
  }
  if(operation==='commit-edit'){
    const edit=state.edit;if(!edit||page.url()!==edit.url)throw Error('prepared_context_changed');
    const valid=await page.evaluate(({start,due,action,form,values})=>
      start===document.querySelector('#start')&&due===document.querySelector('#due')&&action===document.querySelector('#date-save')&&form===document.querySelector('#date-form')&&
      start.isConnected&&due.isConnected&&start.value===values.start&&due.value===values.due&&
      form.action===location.origin+'/save/dates'&&form.method==='post'&&form.querySelector('[name="_method"]').value==='patch'&&
      start.form===form&&due.form===form&&action.form===form&&!action.hasAttribute('formaction')&&!action.hasAttribute('formmethod'),edit);
    if(!valid)throw Error('prepared_edit_binding_differs');
    return observeResponse('/save/dates',()=>edit.action.click({timeout:2000}));
  }
  if(operation==='cdp-target'){
    const session=await page.context().newCDPSession(page);
    try{return (await session.send('Target.getTargetInfo')).targetInfo.targetId;}finally{await session.detach();}
  }
  if(operation==='page-count')return page.context().pages().length;
  throw Error('unknown_comparison_operation');
}
exports.__esModule=true;
exports.perform=perform;
