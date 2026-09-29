'use strict';
const fs=require('fs'),path=require('path'),{EventEmitter}=require('events');
module.exports=function createAgentOrchestrator(deps={}){
 const {dataDir,ollamaUrl,defaultModel,fetchWithTimeout,runLocalModel,knowledgeStore,knowledgeScore,searxSearch,recordActivity}=deps;
 const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'specialist-agents.json'),'utf8')).agents;
 const specialists=catalog.filter(a=>!a.infrastructure);
 const runsFile=path.join(dataDir,'specialist-agent-runs.json'),missionsFile=path.join(dataDir,'agent-missions.json'),events=new EventEmitter();
 const read=(f,d=[])=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}},save=(f,v)=>fs.writeFileSync(f,JSON.stringify(v,null,2)),iso=()=>new Date().toISOString(),id=p=>p+'-'+Date.now().toString(36)+'-'+Math.random().toString(16).slice(2,8);
 async function models(){const r=await fetchWithTimeout(ollamaUrl+'/api/tags',{method:'GET'},15000);if(!r.ok)throw new Error('Ollama inventory unavailable: HTTP '+r.status);const j=await r.json();return (j.models||[]).map(x=>({name:x.name,size:x.size,modified_at:x.modified_at}));}
 function modelScore(name,task){let s=0,n=name.toLowerCase(),t=task.toLowerCase();if(/coder|code|debug|implement|engineering/.test(t)&&/coder|qwen/.test(n))s+=40;if(/document|summar|write|research|ux|design/.test(t)&&/qwen|gemma/.test(n))s+=25;if(/32k|16k/.test(n))s+=8;if(name===defaultModel)s+=5;return s}
 async function routeModel(task,inventory){const inv=inventory||await models();if(!inv.length)throw new Error('No installed Ollama models reported');const ranked=inv.map(m=>({...m,score:modelScore(m.name,task)})).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));return {model:ranked[0].name,reason:'Highest deterministic fit among installed Ollama models',inventory:ranked};}
 function termHit(text,term){const t=String(term||'').toLowerCase();return t&&text.includes(t)}
 function agentScore(agent,goal){const text=goal.toLowerCase(),r=agent.routing||{},hits=(r.include||[]).filter(t=>termHit(text,t)),blocked=(r.exclude||[]).filter(t=>termHit(text,t));return {score:hits.length*10-blocked.length*25,hits,blocked}}
 async function dispatch(goal,manualAgentIds){
  const inventory=await models();
  let chosen=[],mode='auto',scores=specialists.map(a=>({agent:a,...agentScore(a,goal)}));
  if(Array.isArray(manualAgentIds)&&manualAgentIds.length){mode='manual';chosen=specialists.filter(a=>manualAgentIds.includes(a.id))}
  else{chosen=scores.filter(x=>x.score>0).sort((a,b)=>b.score-a.score).map(x=>x.agent);if(!chosen.length)chosen=[specialists[0]].filter(Boolean)}
  const ids=[...new Set(chosen.map(a=>a.id))],dependencies={};
  ids.forEach(x=>dependencies[x]=[]);
  if(ids.includes('documentation')&&ids.length>1)dependencies.documentation=ids.filter(x=>x!=='documentation');
  const workers=[];
  for(const a of chosen){const rt=await routeModel(goal+' '+a.capabilities.join(' '),inventory);const sc=scores.find(x=>x.agent.id===a.id);workers.push({agentId:a.id,name:a.name,model:rt.model,dependsOn:dependencies[a.id]||[],reason:mode==='manual'?'Manual override':(sc&&sc.hits.length?'Matched: '+sc.hits.join(', '):'Fallback specialist')})}
  return {mode,goal,workers,selectedAgentIds:ids,reason:mode==='manual'?'Manual specialist override':'Capability-driven routing from specialist registry',inventory:inventory.map(x=>x.name)};
 }
 function context(projectId,goal){if(!projectId||typeof knowledgeStore!=='function')return [];const rows=knowledgeStore().filter(x=>x.projectId===projectId);if(typeof knowledgeScore!=='function')return rows.slice(0,6);return rows.map(x=>({x,s:knowledgeScore(x,goal)})).sort((a,b)=>b.s-a.s).slice(0,6).map(y=>y.x)}
 async function specialist(agentId,goal,projectId='',assignedModel=''){const agent=specialists.find(x=>x.id===agentId);if(!agent)throw new Error('Unknown specialist: '+agentId);const runs=read(runsFile),run={id:id('spec'),agentId,agentName:agent.name,goal,projectId,status:'running',createdAt:iso(),updatedAt:iso(),plan:[{name:'Route model',state:'running'},{name:'Gather context',state:'pending'},{name:'Execute specialist',state:'pending'},{name:'Publish result',state:'pending'}]};runs.unshift(run);save(runsFile,runs.slice(0,300));try{const rt=assignedModel?{model:assignedModel}:await routeModel(goal+' '+agentId);run.model=rt.model;run.plan[0].state='complete';const ctx=context(projectId,goal);run.plan[1].state='complete';run.plan[2].state='running';const evidence=ctx.map((x,i)=>'['+(i+1)+'] '+(x.name||x.title||'Context')+'\n'+String(x.text||x.content||'').slice(0,5000)).join('\n\n');run.answer=await runLocalModel('Goal:\n'+goal+'\n\nProject context:\n'+(evidence||'(none)')+'\n\nReturn a concrete, structured result.',agent.system,rt.model);run.plan[2].state='complete';run.plan[3].state='complete';run.status='complete'}catch(e){run.status='error';run.error=String(e.message||e);const active=run.plan.find(x=>x.state==='running');if(active)active.state='error'}run.updatedAt=iso();save(runsFile,runs.slice(0,300));if(recordActivity)recordActivity('agent','Specialist '+run.status,agent.name,{runId:run.id,agentId});return run}
 function missionSnapshot(m){events.emit('mission',m);return m}
 async function mission(goal,projectId='',manualAgentIds){
  const routing=await dispatch(goal,manualAgentIds),ms=read(missionsFile);
  const m={id:id('mission'),goal,projectId,status:'running',routing,createdAt:iso(),updatedAt:iso(),workers:[{id:'router',name:'Mission Router',state:'complete',dependsOn:[],reason:routing.reason},...routing.workers.map(w=>({id:w.agentId,name:w.name,state:'pending',model:w.model,dependsOn:['router',...w.dependsOn],reason:w.reason})),{id:'synthesis',name:'Coordinator',state:'pending',dependsOn:routing.selectedAgentIds}],results:[]};
  ms.unshift(m);save(missionsFile,ms.slice(0,200));missionSnapshot(m);
  try{
   const pending=new Set(routing.selectedAgentIds),done=new Set(),results=[];
   while(pending.size){const ready=routing.workers.filter(w=>pending.has(w.agentId)&&(w.dependsOn||[]).every(d=>done.has(d)));if(!ready.length)throw new Error('Mission dependency graph cannot make progress');
    ready.forEach(w=>m.workers.find(x=>x.id===w.agentId).state='running');m.updatedAt=iso();save(missionsFile,ms);missionSnapshot(m);
    const batch=await Promise.all(ready.map(w=>specialist(w.agentId,goal,projectId,w.model)));results.push(...batch);
    ready.forEach(w=>{pending.delete(w.agentId);done.add(w.agentId);const r=results.find(x=>x.agentId===w.agentId),mw=m.workers.find(x=>x.id===w.agentId);mw.state=r.status});
    m.results=results;m.updatedAt=iso();save(missionsFile,ms);missionSnapshot(m);
   }
   m.workers.find(x=>x.id==='synthesis').state='running';missionSnapshot(m);
   const coordinatorModel=(await routeModel(goal+' synthesis')).model,joined=results.map(r=>'## '+r.agentName+'\n'+(r.answer||r.error||'')).join('\n\n');
   m.answer=await runLocalModel('Mission: '+goal+'\n\nSpecialist outputs:\n'+joined+'\n\nSynthesize without hiding disagreements or unsupported claims.','You are the mission coordinator. Produce an actionable synthesis.',coordinatorModel);m.coordinatorModel=coordinatorModel;m.workers.find(x=>x.id==='synthesis').state='complete';m.status=results.some(x=>x.status==='error')?'needs_attention':'complete';
  }catch(e){m.status='error';m.error=String(e.message||e)}
  m.updatedAt=iso();save(missionsFile,ms);missionSnapshot(m);return m
 }
 return {catalog,models,route:routeModel,dispatch,specialist,mission,runs:()=>read(runsFile),missions:()=>read(missionsFile),events};
};