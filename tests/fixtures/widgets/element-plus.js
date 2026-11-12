// A real pinned Element Plus remote select, not a hand-written imitation.
const candidates=[{id:'8',label:'Alpha'},{id:'9',label:'Beta'}];
const post=(kind,value)=>fetch('/save/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
Vue.createApp({
  data:()=>({choice:null,options:candidates,renders:0,start:'',due:'',queryGeneration:0}),
  methods:{
    post,
    async search(query){
      const generation=++this.queryGeneration;
      if(query)await fetch('/query-results?field=choice');
      if(generation===this.queryGeneration)this.options=candidates.filter(option=>option.label.toLowerCase().includes(query.toLowerCase()));
    }
  },
  template:`<h1>Synthetic Element Plus fixture</h1>
    <button id="rerender" type="button" @click="renders++">Render again</button><output id="renders">{{renders}}</output>
    <label for="choice">Assignee</label>
    <el-select id="choice" v-model="choice" filterable remote :remote-method="search" :teleported="true" style="width:260px" aria-label="Assignee">
      <el-option v-for="option in options" :key="option.id" :label="option.label" :value="option.id" :data-id="option.id"/>
    </el-select>
    <output id="chosen" :data-id="choice||''">{{choice}}</output>
    <button id="choice-save" type="button" @click="post('choice',{id:choice,renders})">Save choice</button>
    <form id="date-form" action="/save/dates" method="post" @submit.prevent="post('dates',{start,due,renders})">
      <input type="hidden" name="_method" value="patch">
      <label for="start">Start</label><input id="start" v-model="start">
      <label for="due">Finish</label><input id="due" v-model="due">
    </form><button id="date-save" type="submit" form="date-form">Save dates</button>`
}).use(ElementPlus).mount('#root');
