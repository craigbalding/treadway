'use strict';
const $=selector=>document.querySelector(selector);
let item=null,serial=0;
const run=new URLSearchParams(location.search).get('run');
async function api(path,body){
  const response=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error);
  return result;
}
function renderEditor(value){
  item=value;$('#create').hidden=true;$('#editor').hidden=false;
  $('#editor').innerHTML=`<h2 id="resource" data-id="${item.id}" data-revision="${item.revision}"></h2>
<form id="edit" method="post" action="/api/items/${item.id}">
<label>Owner <input id="owner" role="combobox" aria-controls="owner-results" aria-expanded="false" autocomplete="off"></label>
<div id="owner-results" hidden></div><input id="owner-id" type="hidden">
<label>Start <input id="start" type="text"></label><label>Due <input id="due" type="text"></label>
<label id="note-label">Handoff note</label><div id="note" contenteditable="true" role="textbox" aria-labelledby="note-label"></div>
<button id="save" type="submit">Save plan</button></form>`;
  $('#resource').textContent=item.title;
  $('#owner-id').value=item.ownerId;
  $('#owner').value=({'person-17':'Casey Rowan','person-29':'Sam Morgan'})[item.ownerId]||'';
  $('#start').value=item.start;$('#due').value=item.due;$('#note').textContent=item.note;
  $('#owner').addEventListener('input',async event=>{
    const query=event.target.value,current=++serial;
    $('#owner-id').value='';$('#owner').setAttribute('aria-expanded','true');$('#owner-results').hidden=false;
    // Old results remain visible while a new query is pending. Readiness must
    // establish the requested query and actual ID, not a matching stale label.
    const result=await api('/api/people?q='+encodeURIComponent(query));
    await new Promise(resolve=>setTimeout(resolve,120));
    if(current!==serial)return;
    const container=document.createElement('div');container.id='owner-results';
    container.dataset.query=result.query;container.setAttribute('role','listbox');
    for(const person of result.people){
      const option=document.createElement('div');option.setAttribute('role','option');
      option.dataset.id=person.id;option.textContent=person.name;
      option.addEventListener('click',()=>{$('#owner').value=person.name;$('#owner-id').value=person.id;container.hidden=true;$('#owner').setAttribute('aria-expanded','false');});
      container.append(option);
    }
    $('#owner-results').replaceWith(container);
  });
  $('#edit').addEventListener('submit',async event=>{
    event.preventDefault();$('#status').textContent='Saving';
    try{
      const saved=await api($('#edit').getAttribute('action'),{run:item.run,revision:item.revision,ownerId:$('#owner-id').value,start:$('#start').value,due:$('#due').value,note:$('#note').textContent});
      renderEditor(saved);$('#status').textContent='Saved revision '+saved.revision;
    }catch(error){$('#status').textContent=error.message;}
  });
}
$('#create').addEventListener('submit',async event=>{
  event.preventDefault();
  try{const created=await api('/api/items',{title:$('#title').value,run});history.replaceState(null,'','/?run='+run+'&id='+created.id);renderEditor(created);}
  catch(error){$('#status').textContent=error.message;}
});
(async()=>{
  $('#actor').textContent=(await api('/api/actor')).actor;
  const id=new URLSearchParams(location.search).get('id');if(id)renderEditor(await api('/api/items/'+id));
})().catch(error=>{$('#status').textContent=error.message;});
