'use strict';
const fs=require('fs'),path=require('path'),{EventEmitter}=require('events');
module.exports=function createAgentOrchestrator(deps={}){
 const {dataDir,ollamaUrl,defaultModel,fetchWithTimeout,runLocalModel,knowledgeStore,knowledgeScore,searxSearch,recordActivity}=deps;
 const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'specialist-agents.json'),'utf8')).agents;
 const GROUNDED_TIMEOUT_MS=600000,COORDINATOR_TIMEOUT_MS=600000,MODEL_RETRY_DELAYS_MS=[1500,4000];
 const specialists=catalog.filter(a=>!a.infrastructure);
 const storage=deps.storage||new (require('./storage').Storage)({dataDir});
 const runsFile='specialistRuns',missionsFile='missions',events=new EventEmitter();
 const read=f=>storage.list(f),iso=()=>new Date().toISOString(),id=p=>p+'-'+Date.now().toString(36)+'-'+Math.random().toString(16).slice(2,8);
 async function models(){const r=await fetchWithTimeout(ollamaUrl+'/api/tags',{method:'GET'},15000);if(!r.ok)throw new Error('Ollama inventory unavailable: HTTP '+r.status);const j=await r.json();return (j.models||[]).map(x=>({name:x.name,size:x.size,modified_at:x.modified_at}));}
 function modelScore(name,task){let s=0,n=name.toLowerCase(),t=task.toLowerCase();if(/coder|code|debug|implement|engineering/.test(t)&&/coder|qwen/.test(n))s+=40;if(/document|summar|write|research|ux|design/.test(t)&&/qwen|gemma/.test(n))s+=25;if(/32k|16k/.test(n))s+=8;if(name===defaultModel)s+=5;return s}
 async function routeModel(task,inventory){const inv=inventory||await models();if(!inv.length)throw new Error('No installed Ollama models reported');const ranked=inv.map(m=>({...m,score:modelScore(m.name,task)})).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));return {model:ranked[0].name,score:ranked[0].score,reason:'Highest deterministic fit among installed Ollama models',inventory:ranked};}
 function termHit(text,term){const t=String(term||'').toLowerCase();if(!t)return false;let i=text.indexOf(t);while(i>=0){if(i===0||!/[a-z0-9]/.test(text[i-1]))return true;i=text.indexOf(t,i+1)}return false}
 function activeWorkload(){
  const counts={};for(const m of storage.list(missionsFile,{status:'running'}))for(const w of m.workers||[])if(w.state==='running'||w.state==='pending')counts[w.id]=(counts[w.id]||0)+1;return counts
 }
 function agentScore(agent,goal,workload={}){
  const text=goal.toLowerCase(),r=agent.routing||{},hits=(r.include||[]).filter(t=>termHit(text,t)),blocked=(r.exclude||[]).filter(t=>termHit(text,t)),load=workload[agent.id]||0;
  const raw=hits.length*12-blocked.length*30-Math.min(18,load*6),capabilityScore=clampScore(raw<=0?(hits.length?30:0):45+raw);
  return {score:raw,hits,blocked,workload:load,availability:load>=2?'busy':'available',capabilityScore}
 }
 function clampScore(n){return Math.max(0,Math.min(100,Math.round(n)))}
 function fallbackFor(agent,scores,chosenIds){
  const declared=(agent.routing&&agent.routing.fallback)||[];
  for(const id of declared){const s=scores.find(x=>x.agent.id===id);if(s&&s.availability!=='busy')return id}
  const own=new Set(agent.capabilities||[]),alt=scores.filter(x=>x.agent.id!==agent.id&&!chosenIds.includes(x.agent.id)&&x.availability!=='busy').map(x=>({id:x.agent.id,overlap:(x.agent.capabilities||[]).filter(c=>own.has(c)).length,score:x.score})).sort((a,b)=>b.overlap-a.overlap||b.score-a.score);
  return alt[0]?.overlap?alt[0].id:''
 }
 function dependencyPlan(ids){
  const d={};ids.forEach(x=>d[x]=[]);
  const add=(id,...deps)=>{if(ids.includes(id))d[id]=[...new Set(deps.filter(x=>ids.includes(x)&&x!==id))]};
  add('documentation','research_agent','ux_analyst');
  add('test_engineer','code_analyst');
  add('security_reviewer','code_analyst');
  add('performance_analyst','code_analyst');
  return d
 }
 async function dispatch(goal,manualAgentIds){
  const inventory=await models(),workload=activeWorkload();
  let chosen=[],mode='auto',scores=specialists.map(a=>({agent:a,...agentScore(a,goal,workload)}));
  if(Array.isArray(manualAgentIds)&&manualAgentIds.length){mode='manual';const unknown=manualAgentIds.filter(x=>!specialists.some(a=>a.id===x));if(unknown.length)throw Object.assign(new Error('Unknown or non-dispatchable specialist: '+unknown.join(', ')),{statusCode:400});chosen=specialists.filter(a=>manualAgentIds.includes(a.id))}
  else{chosen=scores.filter(x=>x.score>0&&x.availability!=='busy').sort((a,b)=>b.score-a.score||a.workload-b.workload).map(x=>x.agent);if(!chosen.length){const best=scores.slice().sort((a,b)=>b.score-a.score||a.workload-b.workload)[0];chosen=[best?.agent].filter(Boolean)}}
  const ids=[...new Set(chosen.map(a=>a.id))],dependencies=dependencyPlan(ids),workers=[];
  for(const a of chosen){
   const rt=await routeModel(goal+' '+a.capabilities.join(' '),inventory),sc=scores.find(x=>x.agent.id===a.id),fallbackAgentId=fallbackFor(a,scores,ids);
   const routingMeta={capabilityScore:sc?.capabilityScore||0,modelScore:clampScore(rt.score),workload:sc?.workload||0,availability:sc?.availability||'available',groundingRequired:true,dependencyCount:(dependencies[a.id]||[]).length,retryPolicy:{transportRetries:MODEL_RETRY_DELAYS_MS.length,fallbackAgentId:fallbackAgentId||null},matchTerms:sc?.hits||[]};
   const reason=mode==='manual'?'Manual override':(sc?.hits?.length?'Matched '+sc.hits.join(', ')+'; capability '+routingMeta.capabilityScore+'%; model fit '+routingMeta.modelScore+'%':'Fallback specialist selected from available registry');
   workers.push({agentId:a.id,name:a.name,model:rt.model,dependsOn:dependencies[a.id]||[],reason,routingMeta})
  }
  return {mode,goal,workers,selectedAgentIds:ids,reason:mode==='manual'?'Manual specialist override':'Capability, workload, dependency and model-aware routing',inventory:inventory.map(x=>x.name),scheduler:{policy:'dependency-aware parallel execution',groundingRequired:true}};
 }
 function context(projectId,goal){if(!projectId||typeof knowledgeStore!=='function')return [];const rows=knowledgeStore().filter(x=>x.projectId===projectId);if(typeof knowledgeScore!=='function')return rows.slice(0,6);return rows.map(x=>({x,s:knowledgeScore(x,goal)})).sort((a,b)=>b.s-a.s).slice(0,6).map(y=>y.x)}
 const sourceFiles=[
  ['app/agent-orchestrator.js',path.join(__dirname,'agent-orchestrator.js')],
  ['app/specialist-agents.json',path.join(__dirname,'specialist-agents.json')],
  ['app/server.js',path.join(__dirname,'server.js')],
  ['app/public/index.html',path.join(__dirname,'public','index.html')],
  ['app/public/app.js',path.join(__dirname,'public','app.js')],
  ['app/public/agent-specialists.js',path.join(__dirname,'public','agent-specialists.js')],
  ['app/public/agent-specialists.css',path.join(__dirname,'public','agent-specialists.css')],
  ['app/public/agent-matrix.js',path.join(__dirname,'public','agent-matrix.js')],
  ['app/public/agent-matrix.css',path.join(__dirname,'public','agent-matrix.css')],
  ['app/public/agent-world-city.js',path.join(__dirname,'public','agent-world-city.js')],
  ['app/public/agent-world-city.css',path.join(__dirname,'public','agent-world-city.css')],
  ['app/public/ux-architecture-v2.js',path.join(__dirname,'public','ux-architecture-v2.js')],
  ['app/public/ux-architecture-v2.css',path.join(__dirname,'public','ux-architecture-v2.css')]
 ];
 function goalTerms(goal){return [...new Set(String(goal||'').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g)||[])].filter(t=>!['the','and','for','with','this','that','from','into','local','implementation','recommendations'].includes(t)).slice(0,18)}
 function sourceExcerpt(label,file,goal,maxChars=7000){
  try{const raw=fs.readFileSync(file,'utf8'),lines=raw.split(/\r?\n/),terms=goalTerms(goal),picked=new Set();
   if(lines.length<=140)return {source:label,text:raw.slice(0,maxChars),truncated:raw.length>maxChars};
   lines.forEach((line,i)=>{const low=line.toLowerCase();if(terms.some(t=>low.includes(t)))for(let n=Math.max(0,i-5);n<=Math.min(lines.length-1,i+8);n++)picked.add(n)});
   if(!picked.size)return null;
   const ordered=[...picked].sort((a,b)=>a-b),out=[];let last=-2;
   for(const n of ordered){if(n>last+1)out.push('...');out.push(String(n+1).padStart(5,' ')+' | '+lines[n]);last=n;if(out.join('\n').length>=maxChars)break}
   return {source:label,text:out.join('\n').slice(0,maxChars),truncated:out.join('\n').length>maxChars};
  }catch{return null}
 }
 function projectGrounding(goal,agentId){
  const preferred=agentId==='ux_analyst'?sourceFiles.filter(([n])=>/public\/(index|app|agent-)/.test(n)||/specialist-agents/.test(n)):sourceFiles;
  const evidence=preferred.map(([label,file])=>sourceExcerpt(label,file,goal)).filter(Boolean);
  return evidence.slice(0,7);
 }
 async function runModelReliable(prompt,system,timeoutMs,model){
  let last;
  for(let attempt=0;attempt<=MODEL_RETRY_DELAYS_MS.length;attempt++){try{return await runLocalModel(prompt,system,timeoutMs,model)}catch(e){last=e;const msg=String(e&&e.message||e),transient=/fetch failed|ECONNRESET|ECONNREFUSED|socket|network|UND_ERR|terminated/i.test(msg);if(!transient||attempt>=MODEL_RETRY_DELAYS_MS.length)throw e;await new Promise(r=>setTimeout(r,MODEL_RETRY_DELAYS_MS[attempt]))}}
  throw last;
 }
 function dependencyContext(results,dependsOn){return (dependsOn||[]).map(dep=>results.find(r=>r.agentId===dep&&r.status==='complete')).filter(Boolean).map(r=>'DEPENDENCY RESULT: '+r.agentName+' ['+r.agentId+']\nEvidence: '+(r.evidence||[]).join(', ')+'\n'+String(r.answer||'').slice(0,12000)).join('\n\n')}
 function groundingRules(){return 'EVIDENCE RULES:\n- Analyze Local AI Appliance only.\n- Treat supplied sources as authoritative evidence.\n- Do not invent screens, metrics, users, product features, defects, dates, or runtime behavior.\n- Every observed finding must cite one or more supplied source labels such as [app/public/index.html].\n- Distinguish: OBSERVED PRESENCE (shown by evidence), OBSERVED ABSENCE IN SUPPLIED EXCERPTS (searched evidence does not show it), and NOT VERIFIED (evidence is insufficient).\n- Never convert absence from an excerpt into a product-wide claim that a feature does not exist.\n- Check the report for internal contradictions before publishing.\n- Clearly label recommendations as recommendations, not observations.\n- If evidence is insufficient, state exactly what is missing.\n- Use the current runtime date only if supplied; never invent a report date.\n\n'}
 function evidencePacket(goal,agentId,projectId){
  const knowledge=context(projectId,goal).map((v,i)=>({source:'project-context-'+(i+1),text:String(v.text||v.content||'').slice(0,5000)}));
  const sources=projectGrounding(goal,agentId);
  return {schemaVersion:1,product:{name:'Local AI Appliance',runtime:'LAN-hosted Node.js application with local Ollama models',sourceRoot:'/app'},sources:[...knowledge,...sources]};
 }
 async function specialist(agentId,goal,projectId='',assignedModel='',upstream=''){const agent=specialists.find(x=>x.id===agentId);if(!agent)throw new Error('Unknown specialist: '+agentId);const run={id:id('spec'),agentId,agentName:agent.name,goal,projectId,status:'running',createdAt:iso(),updatedAt:iso(),plan:[{name:'Route model',state:'running'},{name:'Gather context',state:'pending'},{name:'Execute specialist',state:'pending'},{name:'Publish result',state:'pending'}]};persistRecord(runsFile,run,300);try{const rt=assignedModel?{model:assignedModel}:await routeModel(goal+' '+agentId);run.model=rt.model;run.plan[0].state='complete';const packet=evidencePacket(goal,agentId,projectId);run.evidence=packet.sources.map(x=>x.source);run.plan[1].state='complete';run.plan[2].state='running';const evidence=packet.sources.map((x,i)=>'['+(i+1)+'] SOURCE: '+x.source+'\n'+x.text).join('\n\n');const grounding='PRODUCT IDENTITY:\n'+JSON.stringify(packet.product)+'\n\n'+groundingRules();run.answer=await runModelReliable(grounding+'Goal:\n'+goal+'\n\nAuthoritative project evidence:\n'+(evidence||'(none)')+(upstream?'\n\nCompleted prerequisite specialist output:\n'+upstream:'')+'\n\nReturn a concrete, structured, evidence-grounded result. Before finalizing, verify that each observation is supported by its cited source and that the report contains no contradictory claims.',agent.system,GROUNDED_TIMEOUT_MS,rt.model);run.plan[2].state='complete';run.plan[3].state='complete';run.status='complete'}catch(e){run.status='error';const msg=String(e.message||e),timedOut=/abort|timed? ?out/i.test(msg);run.error=timedOut?'Grounded specialist inference exceeded '+Math.round(GROUNDED_TIMEOUT_MS/60000)+' minute timeout: '+msg:msg;run.errorCode=timedOut?'MODEL_TIMEOUT':(/fetch failed|ECONNRESET|ECONNREFUSED|socket|network|UND_ERR|terminated/i.test(msg)?'MODEL_CONNECTION_ERROR':'SPECIALIST_ERROR');const active=run.plan.find(x=>x.state==='running');if(active)active.state='error'}run.updatedAt=iso();persistRecord(runsFile,run,300);if(recordActivity)recordActivity('agent','Specialist '+run.status,agent.name,{runId:run.id,agentId});return run}
 // Upsert and keep only the newest `limit` records (oldest are finished history).
 function persistRecord(collection, record, limit){
  storage.transaction(()=>{storage.put(collection, record);if(limit)storage.prune(collection, limit)});
 }
 function settleWorkers(m,reason){for(const w of m.workers||[]){if(w.state==='running'){w.state='error';w.error=reason}else if(w.state==='pending'){w.state='blocked';w.error=reason}}}
 function reconcileInterrupted(){const reason='Interrupted: the appliance restarted while this was running';for(const m of storage.list(missionsFile,{status:'running'})){m.status='error';m.error=reason;settleWorkers(m,reason);m.updatedAt=iso();storage.upsert(missionsFile,m)}for(const r of storage.list(runsFile,{status:'running'})){r.status='error';r.error=reason;r.errorCode='INTERRUPTED';for(const p of r.plan||[])if(p.state==='running')p.state='error';r.updatedAt=iso();storage.upsert(runsFile,r)}}
 function missionSnapshot(m,type='state',detail='',workerId=''){
  m.timeline=m.timeline||[];
  const workers=(m.workers||[]).map(w=>({id:w.id,name:w.name,state:w.state,model:w.model,dependsOn:w.dependsOn||[],reason:w.reason,routingMeta:w.routingMeta||null,error:w.error||''}));
  const sig=workers.map(w=>w.id+':'+w.state).join('|')+'|'+m.status+'|'+type;
  if(m.timeline.at(-1)?.sig!==sig)m.timeline.push({at:iso(),type,detail,workerId,status:m.status,sig,workers});
  m.updatedAt=iso();
  persistRecord(missionsFile,m,200);
  events.emit('mission',m);return m
 }
 async function mission(goal,projectId='',manualAgentIds){
  const routing=await dispatch(goal,manualAgentIds);
  const m={id:id('mission'),goal,projectId,status:'running',routing,createdAt:iso(),updatedAt:iso(),timeline:[],workers:[{id:'router',name:'Mission Router',state:'complete',dependsOn:[],reason:routing.reason,routingMeta:{capabilityScore:100,modelScore:100,workload:0,availability:'available',groundingRequired:false,dependencyCount:0,retryPolicy:{transportRetries:0,fallbackAgentId:null},matchTerms:['mission-planning']}},...routing.workers.map(w=>({id:w.agentId,name:w.name,state:'pending',model:w.model,dependsOn:['router',...w.dependsOn],reason:w.reason,routingMeta:w.routingMeta})),{id:'synthesis',name:'Coordinator',state:'pending',dependsOn:routing.selectedAgentIds,reason:'Synthesize grounded specialist outputs',routingMeta:{capabilityScore:100,modelScore:0,workload:0,availability:'available',groundingRequired:true,dependencyCount:routing.selectedAgentIds.length,retryPolicy:{transportRetries:MODEL_RETRY_DELAYS_MS.length,fallbackAgentId:null},matchTerms:['synthesis']}}],results:[]};
  missionSnapshot(m,'mission-start','Mission accepted and routing plan created','router');
  try{
   const pending=new Set(routing.selectedAgentIds),done=new Set(),results=[];
   while(pending.size){const blocked=routing.workers.filter(w=>pending.has(w.agentId)&&(w.dependsOn||[]).some(d=>done.has(d)&&!results.some(r=>r.agentId===d&&r.status==='complete')));blocked.forEach(w=>{pending.delete(w.agentId);done.add(w.agentId);const mw=m.workers.find(x=>x.id===w.agentId);mw.state='blocked';mw.error='Blocked because a prerequisite specialist failed';});if(blocked.length){m.results=results;m.updatedAt=iso();missionSnapshot(m,'blocked','A dependency failure blocked downstream work',blocked[0]?.agentId||'')}const ready=routing.workers.filter(w=>pending.has(w.agentId)&&(w.dependsOn||[]).every(d=>done.has(d)&&results.some(r=>r.agentId===d&&r.status==='complete')));if(!ready.length){if(!pending.size)break;throw new Error('Mission dependency graph cannot make progress');}
    ready.forEach(w=>m.workers.find(x=>x.id===w.agentId).state='running');m.updatedAt=iso();missionSnapshot(m,'dispatch','Ready workers entered execution',ready.map(w=>w.agentId).join(','));
    const batch=await Promise.all(ready.map(async w=>{
     let r=await specialist(w.agentId,goal,projectId,w.model,dependencyContext(results,w.dependsOn));
     const fallbackId=w.routingMeta?.retryPolicy?.fallbackAgentId;
     if(r.status!=='complete'&&fallbackId){
      const fbAgent=specialists.find(a=>a.id===fallbackId);
      if(fbAgent){missionSnapshot(m,'fallback','Primary worker failed; attempting fallback '+fbAgent.name,w.agentId);try{const fbRoute=await routeModel(goal+' '+fbAgent.capabilities.join(' '));const fb=await specialist(fallbackId,goal,projectId,fbRoute.model,dependencyContext(results,w.dependsOn));if(fb.status==='complete')r={...fb,agentId:w.agentId,agentName:fb.agentName+' (fallback for '+w.name+')',executedBy:fallbackId,fallbackFor:w.agentId}}catch(fe){missionSnapshot(m,'fallback','Fallback '+fbAgent.name+' failed: '+String(fe.message||fe),w.agentId)}}
     }
     return r
    }));results.push(...batch);
    ready.forEach(w=>{pending.delete(w.agentId);done.add(w.agentId);const r=results.find(x=>x.agentId===w.agentId),mw=m.workers.find(x=>x.id===w.agentId);mw.state=r.status;if(r.fallbackFor){mw.fallbackUsed=r.executedBy;mw.reason=(mw.reason||'')+' · fallback executed by '+r.executedBy}});
    m.results=results;m.updatedAt=iso();missionSnapshot(m,'worker-result','Specialist results published',ready.map(w=>w.agentId).join(','));
   }
   const failed=results.filter(r=>r.status!=='complete'),blockedWorkers=m.workers.filter(w=>w.state==='blocked');if(failed.length||blockedWorkers.length){const sw=m.workers.find(x=>x.id==='synthesis');sw.state='blocked';sw.error='Synthesis skipped because prerequisite specialists did not complete';m.status='needs_attention';m.error='Mission stopped after specialist failure';m.updatedAt=iso();missionSnapshot(m,'mission-attention','Mission stopped after specialist failure');return m}
   m.workers.find(x=>x.id==='synthesis').state='running';missionSnapshot(m,'synthesis','Coordinator started synthesis','synthesis');
   const coordinatorModel=(await routeModel(goal+' synthesis')).model,joined=results.map(r=>'## '+r.agentName+'\n'+(r.answer||r.error||'')).join('\n\n');
   m.answer=await runModelReliable('Mission: '+goal+'\n\nSpecialist outputs:\n'+joined+'\n\nSynthesize only claims grounded in the specialist evidence. Preserve source labels. Reject invented product behavior, metrics, dates, screens, users, or defects. Clearly distinguish observed evidence from recommendations and identify remaining evidence gaps.','You are the mission coordinator for the Local AI Appliance. Produce an actionable, source-grounded synthesis; never substitute a generic consumer AI product.',COORDINATOR_TIMEOUT_MS,coordinatorModel);m.coordinatorModel=coordinatorModel;m.workers.find(x=>x.id==='synthesis').state='complete';m.status=results.some(x=>x.status==='error')?'needs_attention':'complete';
  }catch(e){m.status='error';m.error=String(e.message||e);settleWorkers(m,m.error)}
  m.updatedAt=iso();missionSnapshot(m,m.status==='complete'?'mission-complete':'mission-error',m.status==='complete'?'Mission completed and artifacts are ready':(m.error||'Mission ended with an error'));return m
 }
 reconcileInterrupted();
 return {close:()=>{if(!deps.storage)storage.close()},catalog,models,route:routeModel,dispatch,specialist,mission,runs:(limit)=>storage.list(runsFile,limit?{limit}:{}),missions:(limit)=>storage.list(missionsFile,limit?{limit}:{}),getMission:id=>storage.get(missionsFile,id),events};
};
