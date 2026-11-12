'use strict';
// Node consumers use the same installed Python lifecycle implementation.
const {execFile}=require('node:child_process');
function command(args,{python=process.env.TREADWAY_PYTHON||'python3'}={}) {
  return new Promise((resolve,reject)=>execFile(python,['-m','treadway.browsers',...args],
    {encoding:'utf8',maxBuffer:1024*1024},(error,stdout,stderr)=>{
      if(error){reject(new Error(stderr.trim()||'browser_lifecycle_incomplete'));return;}
      try{resolve(JSON.parse(stdout));}catch{reject(new Error('browser_lifecycle_result_incomplete'));}
    }));
}
async function launch({root,name='browser',executable=process.env.CHROME_BIN,persistent=false,headless=true,
  sandbox=process.env.TREADWAY_CHROME_SANDBOX!=='off',disabledFeatures=[],python}={}) {
  if(!root || !executable)throw new Error('explicit_browser_root_and_executable_required');
  const args=['--root',root,'start',name,'--executable',executable];
  if(persistent)args.push('--persistent');if(!headless)args.push('--headful');if(!sandbox)args.push('--no-sandbox');
  for(const feature of disabledFeatures)args.push('--disable-feature',feature);
  const session=await command(args,{python});
  return {session,connection:{cdpHost:'127.0.0.1',cdpPort:session.port,targetId:session.target_id},
    stop:()=>command(['--root',root,'stop',name,'--generation',session.generation],{python})};
}
module.exports={launch};
