const h=React.createElement;
const candidates=[{id:'8',label:'Alpha'},{id:'9',label:'Beta'}];
const post=(kind,value)=>fetch('/save/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
function Choice({id,multiple=false,selected,onSelect}){
  const slow=new URLSearchParams(location.search).has('slow_query');
  const [revision,setRevision]=React.useState(0);
  const [query,setQuery]=React.useState(''),[open,setOpen]=React.useState(false),[options,setOptions]=React.useState(slow?candidates:[]);
  React.useEffect(()=>{
    let active=true;
    const finish=()=>{if(active){setOptions(candidates.filter(c=>c.label.toLowerCase().includes(query.toLowerCase())));if(slow)setRevision(n=>n+1);}};
    if(slow&&query){fetch('/query-results?field='+encodeURIComponent(id)).then(response=>response.text()).then(finish);return()=>{active=false;};}
    const timer=setTimeout(finish,slow?0:80);return()=>{active=false;clearTimeout(timer);};
  },[query]);
  return h(React.Fragment,null,
    h('label',{htmlFor:id},multiple?'Contributors':'Assignee'),
    h('input',{id,role:'combobox','aria-controls':id+(slow?'-options':'-portal'),'aria-expanded':String(open),value:query,
      onMouseDown:()=>setOpen(true),onChange:e=>{setQuery(e.target.value);setOpen(true);},onBlur:()=>setQuery('')}),
    ReactDOM.createPortal(open?h('div',{...(slow?{id:id+'-options',key:revision}:{}),role:'listbox'},options.map(option=>h('div',{role:'option',tabIndex:0,key:option.id,'data-id':option.id,'aria-selected':String(selected.includes(option.id)),
      onMouseDown:e=>e.preventDefault(),onClick:()=>{onSelect(option);setQuery('');setOpen(false);}},option.label))):null,document.getElementById(id+'-portal')));
}
function App(){
  const [choice,setChoice]=React.useState(null),[selected,setSelected]=React.useState([]),[start,setStart]=React.useState(''),[due,setDue]=React.useState(''),
    [body,setBody]=React.useState('Old brief'),[title,setTitle]=React.useState('Old title'),[editing,setEditing]=React.useState(false),[renders,setRenders]=React.useState(0),[busy,setBusy]=React.useState(false);
  const preview=(field,value)=>{setBusy(true);fetch('/preview/dates?'+new URLSearchParams({field,value})).then(r=>r.text()).then(()=>setBusy(false));};
  return h(React.Fragment,null,
    h('h1',null,'Synthetic React widget fixture'),
    h('button',{id:'rerender',type:'button',onClick:()=>setRenders(n=>n+1)},'Render again'),h('output',{id:'renders'},String(renders)),
    h('section',null,h(Choice,{id:'choice',selected:choice?[choice.id]:[],onSelect:setChoice}),h('output',{id:'chosen','data-id':choice?.id||''},choice?.label||''),
      h('button',{id:'choice-save',type:'button',onClick:()=>post('choice',{id:choice?.id||null,renders})},'Save choice')),
    h('section',null,h(Choice,{id:'multi',multiple:true,selected:selected.map(item=>item.id),onSelect:option=>setSelected(prior=>prior.some(item=>item.id===option.id)?prior:[...prior,option])}),
      h('div',{id:'chips'},selected.map(item=>h('span',{key:item.id,'data-id':item.id},item.label,h('button',{type:'button','data-remove':item.id,onClick:()=>setSelected(prior=>prior.filter(candidate=>candidate.id!==item.id))},'Remove '+item.label)))),
      h('button',{id:'multi-save',type:'button',onClick:()=>post('multi',{ids:selected.map(item=>item.id),renders})},'Save contributors')),
    h('section',{id:'date-panel','data-busy':String(busy)},
      h('form',{id:'date-form',action:'/save/dates',method:'post',onSubmit:event=>{event.preventDefault();post('dates',{start,due,renders});}},
        h('input',{type:'hidden',name:'_method',value:'patch',readOnly:true}),
        h('label',{htmlFor:'start'},'Start'),h('input',{id:'start',value:start,onChange:event=>{setStart(event.target.value);preview('start',event.target.value);}}),
        h('label',{htmlFor:'due'},'Finish'),h('input',{id:'due',value:due,onChange:event=>{setDue(event.target.value);preview('due',event.target.value);}})),
      h('button',{id:'date-save',type:'submit',form:'date-form'},'Save dates')),
    h('form',{id:'rich-form',action:'/save/brief',method:'post',onSubmit:event=>{event.preventDefault();post('brief',{body,renders});}},
      h('div',{id:'brief',contentEditable:true,role:'textbox','aria-label':'Brief',suppressContentEditableWarning:true,onInput:event=>setBody(event.currentTarget.innerText)},body),
      h('button',{id:'rich-save',type:'submit'},'Save brief')),
    h('section',null,h('button',{id:'inline-open',type:'button',onClick:()=>setEditing(true)},'Edit item'),
      editing&&h('form',{id:'inline-form',action:'/save/item/8',method:'post',onSubmit:event=>{event.preventDefault();post('item/8',{id:8,title,renders}).then(()=>setEditing(false));}},
        h('label',{htmlFor:'title'},'Title'),h('input',{id:'title',value:title,onChange:event=>setTitle(event.target.value)}),h('button',{id:'inline-save',type:'submit'},'Save item'))),
    h('label',{htmlFor:'upload'},'Upload fixture'),h('input',{id:'upload',type:'file',onChange:event=>fetch('/upload',{method:'POST',body:event.target.files[0]})}),
    h('a',{id:'download',href:'/download'},'Download fixture'),
    h('button',{id:'slow-response',type:'button',onClick:()=>fetch('/slow',{method:'POST'}).catch(()=>{})},'Request slow response'));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
