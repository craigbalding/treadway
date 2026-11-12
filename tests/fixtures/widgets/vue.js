const candidates=[{id:'8',label:'Alpha'},{id:'9',label:'Beta'}];
const post=(kind,value)=>fetch('/save/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
const Choice={
  props:['field','selected'],emits:['choose'],
  data:()=>({query:'',open:false,options:candidates,timer:null,revision:0,generation:0,slow:new URLSearchParams(location.search).has('slow_query')}),
  watch:{query(value){
    clearTimeout(this.timer);const generation=++this.generation;
    const finish=()=>{if(this.generation===generation){this.options=candidates.filter(option=>option.label.toLowerCase().includes(value.toLowerCase()));this.revision++;}};
    if(this.slow&&value)fetch('/query-results?field='+encodeURIComponent(this.field)).then(response=>response.text()).then(finish);
    else this.timer=setTimeout(finish,this.slow?0:80);
  }},
  beforeUnmount(){clearTimeout(this.timer);},
  methods:{choose(option){this.$emit('choose',option);this.query='';this.open=false;}},
  template:`<label :for="field">{{field==='multi'?'Contributors':'Assignee'}}</label>
    <input :id="field" role="combobox" :aria-owns="field+(slow?'-options':'-portal')" :aria-expanded="String(open)" v-model="query" @mousedown="open=true" @input="open=true" @blur="query=''">
    <Teleport :to="'#'+field+'-portal'"><div v-if="open" role="listbox" :id="slow?field+'-options':null" :key="slow?revision:0"><div v-for="option in options" :key="option.id" role="option" tabindex="0" :data-id="option.id" :aria-selected="String(selected.includes(option.id))" @mousedown.prevent @click="choose(option)">{{option.label}}</div></div></Teleport>`
};
Vue.createApp({
  components:{Choice},
  data:()=>({choice:null,selected:[],start:'',due:'',body:'Old brief',title:'Old title',editing:false,renders:0,busy:false}),
  methods:{
    post,
    add(option){if(!this.selected.some(item=>item.id===option.id))this.selected.push(option);},
    preview(field,value){this.busy=true;fetch('/preview/dates?'+new URLSearchParams({field,value})).then(r=>r.text()).then(()=>{this.busy=false;});},
    saveItem(){post('item/8',{id:8,title:this.title,renders:this.renders}).then(()=>{this.editing=false;});},
    upload(event){fetch('/upload',{method:'POST',body:event.target.files[0]});},
    slow(){fetch('/slow',{method:'POST'}).catch(()=>{});}
  },
  template:`<h1>Synthetic Vue widget fixture</h1><button id="rerender" type="button" @click="renders++">Render again</button><output id="renders">{{renders}}</output>
    <section><Choice field="choice" :selected="choice?[choice.id]:[]" @choose="choice=$event"/><output id="chosen" :data-id="choice?.id||''">{{choice?.label||''}}</output><button id="choice-save" type="button" @click="post('choice',{id:choice?.id||null,renders})">Save choice</button></section>
    <section><Choice field="multi" :selected="selected.map(item=>item.id)" @choose="add"/><div id="chips"><span v-for="item in selected" :key="item.id" :data-id="item.id">{{item.label}}<button type="button" :data-remove="item.id" @click="selected=selected.filter(candidate=>candidate.id!==item.id)">Remove {{item.label}}</button></span></div><button id="multi-save" type="button" @click="post('multi',{ids:selected.map(item=>item.id),renders})">Save contributors</button></section>
    <section id="date-panel" :data-busy="String(busy)"><form id="date-form" action="/save/dates" method="post" @submit.prevent="post('dates',{start,due,renders})"><input type="hidden" name="_method" value="patch"><label for="start">Start</label><input id="start" v-model="start" @input="preview('start',$event.target.value)"><label for="due">Finish</label><input id="due" v-model="due" @input="preview('due',$event.target.value)"></form><button id="date-save" type="submit" form="date-form">Save dates</button></section>
    <form id="rich-form" action="/save/brief" method="post" @submit.prevent="post('brief',{body,renders})"><div id="brief" contenteditable="true" role="textbox" aria-label="Brief" @input="body=$event.target.innerText">{{body}}</div><button id="rich-save" type="submit">Save brief</button></form>
    <section><button id="inline-open" type="button" @click="editing=true">Edit item</button><form v-if="editing" id="inline-form" action="/save/item/8" method="post" @submit.prevent="saveItem"><label for="title">Title</label><input id="title" v-model="title"><button id="inline-save" type="submit">Save item</button></form></section>
    <label for="upload">Upload fixture</label><input id="upload" type="file" @change="upload"><a id="download" href="/download">Download fixture</a><button id="slow-response" type="button" @click="slow">Request slow response</button>`
}).mount('#root');
