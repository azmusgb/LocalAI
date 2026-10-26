'use strict';
const fs=require('fs'),path=require('path'),{EventEmitter}=require('events');
const {runAgentLoop,createModelQueue}=require('./agent-runtime');
const createMissionEvidence=require('./mission-evidence'),{fitEvidence,evidenceTokenBudget,CHARS_PER_TOKEN,checkAbsenceClaims}=require('./mission-evidence');
const {missionNote}=require('./public/agent-world-words');
const {ANSWER_FORMAT,polishAnswer}=require('./mission-answer');
const {createResearchTools,evidenceRecord,tool,objectArgs,stringArg}=require('./agent-tools');
const {secretish,cloudSafePath}=require('./model-coordinator');
// Evidence known to be public: web results, and Local AI's own code (opening sources, files read, searches) minus files
// whose names say they hold a secret. Anything else (a document from the knowledge store, an unknown kind) is not.
const repoPath=p=>typeof p==='string'&&p.length>0&&!/^[a-z][a-z0-9+.-]*:/i.test(p)&&!p.startsWith('/')&&!p.split('/').includes('..')&&cloudSafePath(p);
function publicEvidence(r){
 if(r.kind==='web')return /^https?:\/\//i.test(String(r.source||''));
 if(r.kind==='source')return repoPath(String(r.source||''));
 if(r.kind==='file'){const m=/^project:(.+?)#L\d+-L\d+$/.exec(String(r.source||''));return !!m&&repoPath(m[1])}
 if(r.kind==='search')return String(r.excerpt||'').split('\n').every(l=>/^No line contains /.test(l)||(()=>{const m=/^([^:\s]+):\d+: /.exec(l);return !!m&&repoPath(m[1])})());
 return false;
}
module.exports=function createAgentOrchestrator(deps={}){
 const {dataDir,ollamaUrl,defaultModel,fetchWithTimeout,runLocalModel,knowledgeStore,knowledgeScore,searxSearch,recordActivity}=deps;
 const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'specialist-agents.json'),'utf8')).agents;
 // A specialist's "not seen" is not a finding that something is missing (checkAbsenceClaims, mission-evidence.js).
 const COORDINATOR_ABSENCE_RULE='A specialist writing that something was not seen in the parts it read means it was not checked, never that a feature is missing. Report something as missing only when a specialist\'s find_in_project search for it returned no matches, and cite that search\'s evidence ID; otherwise write that it wasn\'t checked.';
 const GROUNDED_TIMEOUT_MS=600000,COORDINATOR_TIMEOUT_MS=600000,FOLLOWUP_TIMEOUT_MS=180000,MAX_TOOL_EVENTS=200,MODEL_RETRY_DELAYS_MS=[1500,4000];
 const specialists=catalog.filter(a=>!a.infrastructure);
 const projectRoot=deps.projectRoot||__dirname;
 // Two follow-ups at this limit leave the coordinator time to synthesize within its own deadline.
 const followupTimeoutMs=deps.followupTimeoutMs||FOLLOWUP_TIMEOUT_MS;
 // Tests (and LOCALAI_MISSION_TIMEOUT_MS) shorten a worker's own deadline; the contract defaults above stay the defaults.
 const groundedTimeoutMs=deps.groundedTimeoutMs||GROUNDED_TIMEOUT_MS,coordinatorTimeoutMs=deps.coordinatorTimeoutMs||COORDINATOR_TIMEOUT_MS;
 // The first turn's evidence fits a token budget so the 6 GB GPU reads it in about a minute (~113 tokens/s with the
 // model partly on the CPU); the tools can read the rest. evidenceTokens comes from LOCALAI_MISSION_EVIDENCE_TOKENS.
 const evidenceChars=evidenceTokenBudget(deps.evidenceTokens,deps.numCtx)*CHARS_PER_TOKEN;
 // One model turn at a time across all workers (LOCALAI_MISSION_MODEL_CONCURRENCY): parallel workers would otherwise
 // queue inside Ollama with their deadlines running.
 const modelQueue=deps.modelQueue||createModelQueue({concurrency:deps.modelConcurrency||1});
 const policy=options=>({allowWeb:options?.allowWeb===true&&deps.webSearchEnabled!==false});
 const pushCapped=(list,item)=>{list.push(item);if(list.length>MAX_TOOL_EVENTS)list.splice(0,list.length-MAX_TOOL_EVENTS)};
 const storage=deps.storage||new (require('./storage').Storage)({dataDir});
 const runsFile='specialistRuns',missionsFile='missions',events=new EventEmitter();
 // One 'mission' listener per open SSE client and per in-flight async mission run (each removed when its mission ends): more than 10 is normal.
 events.setMaxListeners(0);
 const iso=()=>new Date().toISOString(),id=p=>p+'-'+Date.now().toString(36)+'-'+Math.random().toString(16).slice(2,8);
 async function models(){const r=await fetchWithTimeout(ollamaUrl+'/api/tags',{method:'GET'},15000);if(!r.ok)throw new Error('Ollama inventory unavailable: HTTP '+r.status);const j=await r.json();return (j.models||[]).filter(x=>!x.remote_model&&!/[:-]cloud(?:$|[-:])/i.test(x.name||'')).map(x=>({name:x.name,size:x.size,modified_at:x.modified_at}));}
 function modelScore(name,task){let s=0,n=name.toLowerCase(),t=task.toLowerCase();if(/coder|code|debug|implement|engineering/.test(t)&&/coder|qwen/.test(n))s+=40;if(/document|summar|write|research|ux|design/.test(t)&&/qwen|gemma/.test(n))s+=25;if(/32k|16k/.test(n))s+=8;if(name===defaultModel)s+=5;return s}
 // A mission may name its workers' model (developer tools, Agent World's start sheet); it must be installed exactly as named.
 async function checkWorkerModel(name,inventory){const inv=inventory||await models(),names=inv.map(x=>x.name);if(typeof name!=='string'||!names.includes(name))throw Object.assign(new Error('Unknown model '+JSON.stringify(String(name))+'. Installed: '+(names.join(', ')||'none')),{statusCode:400,code:'UNKNOWN_MODEL',installed:names});return name}
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
 async function dispatch(goal,manualAgentIds,opts={}){
  const inventory=await models(),workload=activeWorkload(),workerModel=opts.workerModel?await checkWorkerModel(opts.workerModel,inventory):'';
  let chosen=[],mode='auto',scores=specialists.map(a=>({agent:a,...agentScore(a,goal,workload)}));
  if(Array.isArray(manualAgentIds)&&manualAgentIds.length){mode='manual';const unknown=manualAgentIds.filter(x=>!specialists.some(a=>a.id===x));if(unknown.length)throw Object.assign(new Error('Unknown or non-dispatchable specialist: '+unknown.join(', ')),{statusCode:400});chosen=specialists.filter(a=>manualAgentIds.includes(a.id))}
  else{chosen=scores.filter(x=>x.score>0&&x.availability!=='busy').sort((a,b)=>b.score-a.score||a.workload-b.workload).map(x=>x.agent);if(!chosen.length){const best=scores.slice().sort((a,b)=>b.score-a.score||a.workload-b.workload)[0];chosen=[best?.agent].filter(Boolean)}}
  const ids=[...new Set(chosen.map(a=>a.id))],dependencies=dependencyPlan(ids),workers=[];
  for(const a of chosen){
   const rt=workerModel?{model:workerModel,score:modelScore(workerModel,goal+' '+a.capabilities.join(' '))}:await routeModel(goal+' '+a.capabilities.join(' '),inventory),sc=scores.find(x=>x.agent.id===a.id),fallbackAgentId=fallbackFor(a,scores,ids);
   const routingMeta={capabilityScore:sc?.capabilityScore||0,modelScore:clampScore(rt.score),workload:sc?.workload||0,availability:sc?.availability||'available',groundingRequired:true,dependencyCount:(dependencies[a.id]||[]).length,retryPolicy:{transportRetries:MODEL_RETRY_DELAYS_MS.length,fallbackAgentId:fallbackAgentId||null},matchTerms:sc?.hits||[]};
   const reason=(mode==='manual'?'Manual override':(sc?.hits?.length?'Matched '+sc.hits.join(', ')+'; capability '+routingMeta.capabilityScore+'%; model fit '+routingMeta.modelScore+'%':'Fallback specialist selected from available registry'))+(workerModel?'; model chosen for the mission':'');
   workers.push({agentId:a.id,name:a.name,model:rt.model,dependsOn:dependencies[a.id]||[],reason,routingMeta})
  }
  return {mode,goal,workers,selectedAgentIds:ids,reason:mode==='manual'?'Manual specialist override':'Capability, workload, dependency and model-aware routing',inventory:inventory.map(x=>x.name),...(workerModel?{workerModel}:{}),scheduler:{policy:'dependency-aware parallel execution',groundingRequired:true}};
 }
 // Rank the selected project's chunks against the goal; no project means no knowledge context.
 function context(projectId,goal){
  if(!projectId||typeof knowledgeStore!=='function')return [];
  const rows=knowledgeStore().filter(x=>x.projectId===projectId);
  return rows.flatMap(row=>(Array.isArray(row.chunks)?row.chunks:[row.text||row.content||'']).map((text,index)=>({source:'knowledge:'+row.id+'#chunk-'+index,text:String(text||''),score:typeof knowledgeScore==='function'?knowledgeScore(goal,String(text||'')):1}))).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,6);
 }
 // Missions about Local AI itself read the code and docs of the part of the app the goal names (mission-evidence.js).
 const missionEvidence=createMissionEvidence({appRoot:__dirname,...(deps.repoRoots?{repoRoots:deps.repoRoots}:{})});
 function projectGrounding(goal,agentId){return missionEvidence.select(goal,{agentId})}
 async function runModelReliable(prompt,system,timeoutMs,model){
  let last;
  for(let attempt=0;attempt<=MODEL_RETRY_DELAYS_MS.length;attempt++){const release=await modelQueue.acquire();try{return await runLocalModel(prompt,system,timeoutMs,model)}catch(e){last=e;const msg=String(e&&e.message||e),transient=/fetch failed|ECONNRESET|ECONNREFUSED|socket|network|UND_ERR|terminated/i.test(msg);if(!transient||attempt>=MODEL_RETRY_DELAYS_MS.length)throw e;release();await new Promise(r=>setTimeout(r,MODEL_RETRY_DELAYS_MS[attempt]))}finally{release()}}
  throw last;
 }
 // A result is usable when it finished, or stopped but left partial findings (notes or an uncited answer).
 const usable=r=>!!r&&(r.status==='complete'||r.partial===true);
 function dependencyContext(results,dependsOn){return (dependsOn||[]).map(dep=>results.find(r=>r.agentId===dep&&usable(r))).filter(Boolean).map(r=>'DEPENDENCY RESULT: '+r.agentName+' ['+r.agentId+']'+(r.partial?' (partial findings)':'')+'\nEvidence: '+(r.evidence||[]).join(', ')+'\n'+String(r.answer||r.notes||'').slice(0,12000)).join('\n\n')}
 function groundingRules(){return 'EVIDENCE RULES:\n- Analyze Local AI Appliance only.\n- Treat supplied sources as authoritative evidence.\n- Do not invent screens, metrics, users, product features, defects, dates, or runtime behavior.\n- Every observed finding must cite one or more supplied source labels such as [app/public/index.html].\n- Distinguish: OBSERVED PRESENCE (shown by evidence), OBSERVED ABSENCE IN SUPPLIED EXCERPTS (searched evidence does not show it), and NOT VERIFIED (evidence is insufficient).\n- Never convert absence from an excerpt into a product-wide claim that a feature does not exist.\n- ABSENCE: if you did not find something in what you read, write "not seen in the parts I read (lines X–Y of file)", never "does not exist" or "no evidence it exists". Say something is absent only after find_in_project for it returned no matches, and cite that search\'s evidence ID.\n- Check the report for internal contradictions before publishing.\n- Clearly label recommendations as recommendations, not observations.\n- If evidence is insufficient, state exactly what is missing.\n- Use the current runtime date only if supplied; never invent a report date.\n\n'}
 function evidencePacket(goal,agentId,projectId){
  const knowledge=context(projectId,goal).map(v=>({source:v.source,text:v.text.slice(0,5000)}));
  const sources=projectGrounding(goal,agentId);
  return {schemaVersion:1,product:{name:'Local AI Appliance',runtime:'LAN-hosted Node.js application with local Ollama models',sourceRoot:'/app'},sources:[...knowledge,...sources]};
 }
 // With deps.runAgentTurn the specialist investigates with read-only tools; without it, one grounded prompt (legacy path).
 async function specialist(agentId,goal,projectId='',assignedModel='',upstream='',options={}){
  const agent=specialists.find(x=>x.id===agentId);
  if(!agent)throw new Error('Unknown specialist: '+agentId);
  const tooled=typeof deps.runAgentTurn==='function';
  const run={id:id('spec'),agentId,agentName:agent.name,goal,projectId,status:'running',createdAt:iso(),updatedAt:iso(),policy:policy(options),toolEvents:[],evidenceRecords:[],plan:[{name:'Route model',state:'running'},{name:'Gather context',state:'pending'},{name:tooled?'Investigate with tools':'Execute specialist',state:'pending'},{name:'Publish result',state:'pending'}]};
  persistRecord(runsFile,run,300);
  const publish=event=>{
   const entry={...event,at:iso(),runId:run.id,workerId:options.workerId||agentId,agentId};
   pushCapped(run.toolEvents,entry);
   run.updatedAt=iso();persistRecord(runsFile,run,300);options.onEvent?.(entry);
  };
  try{
   const rt=assignedModel?{model:assignedModel}:await routeModel(goal+' '+agentId);
   run.model=rt.model;run.plan[0].state='complete';
   const packet=evidencePacket(goal,agentId,projectId);
   run.evidence=packet.sources.map(x=>x.source);
   run.evidenceRecords=packet.sources.map(x=>evidenceRecord(x.source,x.text,{kind:'source',title:x.source}));
   run.plan[1].state='complete';run.plan[2].state='running';
   const grounding='PRODUCT IDENTITY:\n'+JSON.stringify(packet.product)+'\n\n'+groundingRules();
   // Prerequisite output and opening evidence share the first turn's budget; prerequisites take at most half of it.
   const upstreamCut=String(upstream||'').slice(0,Math.floor(evidenceChars/2)),upstreamText=upstreamCut?'\n\nCompleted prerequisite specialist output:\n'+upstreamCut:'';
   const evidenceRoom=evidenceChars-upstreamCut.length;
   let usedTools=tooled;
   if(tooled)try{
    // Leave the rest of the context for investigation: the most relevant sources open the run; tools can read the rest.
    const opening=fitEvidence(packet.sources.map((x,i)=>'['+run.evidenceRecords[i].id+'] SOURCE: '+x.source+'\n'+x.text),evidenceRoom);
    run.openingEvidence={sources:opening.kept,of:packet.sources.length,chars:opening.chars,budgetChars:evidenceRoom};
    const evidence=opening.blocks.join('\n\n');
    const prompt=grounding+'Goal:\n'+goal+'\n\nAuthoritative project evidence:\n'+(evidence||'(none)')+upstreamText+'\n\nInvestigate missing facts using the offered tools. Read files by the paths in the source labels (for example app/public/ui.js, app/public/app.css, docs/README.md). Each source opens with a MAP of its functions or headings and their line numbers: read exactly those lines with read_project_file, and find any other name or word with find_in_project. Search knowledge only within the selected project. Cite evidence IDs such as [E-...] for every observation. Separate observations, recommendations, and remaining unknowns.';
    const result=await runAgentLoop({model:rt.model,system:agent.system,prompt,turn:deps.runAgentTurn,tools:createResearchTools({projectRoot,projectId,knowledgeStore,knowledgeScore,searxSearch,...run.policy}),evidence:run.evidenceRecords,onEvent:publish,signal:options.signal,modelQueue,...deps.agentLimits,timeoutMs:groundedTimeoutMs});
    Object.assign(run,result);run.evidence=result.evidenceRecords.map(x=>x.source);
    // An answer that cites nothing is kept, marked partial (agent-runtime.js), rather than thrown away.
    if(result.unsupported)run.partial=true;
   }catch(e){
    if(e.code!=='MODEL_NO_TOOLS')throw e;
    usedTools=false;run.toolFallback=e.message+'; ran one grounded prompt instead';run.plan[2].name='Execute specialist';
   }
   if(!usedTools){
    const evidence=fitEvidence(packet.sources.map((x,i)=>'['+(i+1)+'] SOURCE: '+x.source+'\n'+x.text),evidenceRoom).blocks.join('\n\n');
    run.answer=await runModelReliable(grounding+'Goal:\n'+goal+'\n\nAuthoritative project evidence:\n'+(evidence||'(none)')+upstreamText+'\n\nReturn a concrete, structured, evidence-grounded result. Before finalizing, verify that each observation is supported by its cited source and that the report contains no contradictory claims.',agent.system,groundedTimeoutMs,rt.model);
   }
   run.plan[2].state='complete';run.plan[3].state='complete';run.status='complete';
  }catch(e){
   run.status='error';const cause=e&&e.cause&&e.cause.code,msg=String(e.message||e)+(cause&&!String(e.message).includes(cause)?' ('+cause+')':''),timedOut=/abort|timed? ?out/i.test(msg);run.error=timedOut?'Grounded specialist inference exceeded '+Math.round(groundedTimeoutMs/60000)+' minute timeout: '+msg:msg;run.errorCode=/^(AGENT|MODEL)_/.test(e.code||'')?e.code:(timedOut?'MODEL_TIMEOUT':(/fetch failed|ECONNRESET|ECONNREFUSED|socket|network|UND_ERR|terminated/i.test(msg)?'MODEL_CONNECTION_ERROR':'SPECIALIST_ERROR'));const active=run.plan.find(x=>x.state==='running');if(active)active.state='error';
   // A worker that stopped after reading keeps what it gathered, marked partial, for the Coordinator.
   const p=e&&e.partial;if(p&&(p.notes||p.gathered)){run.partial=true;run.notes=String(p.notes||'');if(Array.isArray(p.evidenceRecords)&&p.evidenceRecords.length){run.evidenceRecords=p.evidenceRecords;run.evidence=p.evidenceRecords.map(x=>x.source)}}}
  run.updatedAt=iso();persistRecord(runsFile,run,300);
  if(recordActivity)recordActivity('agent','Specialist '+run.status,agent.name,{runId:run.id,agentId});
  return run;
 }
 // Tool-mode synthesis: the coordinator may ask a specialist for up to two focused follow-up investigations.
 async function coordinate(m,goal,projectId,model,joined,options){
  const evidence=[...new Map(m.results.flatMap(r=>r.evidenceRecords||[]).map(record=>[record.id,record])).values()];
  // The coordinator sees each record briefly; full excerpts are already in the specialist outputs. Outputs take two
  // thirds of the evidence budget and the index a quarter, leaving room in the mission context for a follow-up's answer.
  const evidenceIndex=evidence.slice(0,60).map(r=>({id:r.id,source:r.source,excerpt:String(r.excerpt||'').slice(0,300)}));
  while(evidenceIndex.length>1&&JSON.stringify(evidenceIndex).length>evidenceChars/4)evidenceIndex.pop();
  const followup=tool('request_investigation','Ask one specialist to investigate a specific missing fact before synthesis. At most two follow-up requests are allowed. Inherits this mission’s project and web policy.',{agent_id:{type:'string',enum:specialists.map(a=>a.id)},question:{type:'string'}},['agent_id','question'],async(args,{signal})=>{
   objectArgs(args,['agent_id','question']);
   const agentId=stringArg(args.agent_id,'agent_id',100),question=stringArg(args.question,'question',1500);
   const agent=specialists.find(a=>a.id===agentId);if(!agent)throw new Error('Unknown specialist');
   const workerId=agentId+'-followup-'+(m.followups.length+1);
   const worker={id:workerId,name:agent.name+' · follow-up',state:'running',dependsOn:[],reason:question};
   m.followups.push({workerId,agentId,question,status:'running'});
   m.workers.push(worker);missionSnapshot(m,'followup',question,workerId);
   // A timeout or cancellation settles the worker now; the late specialist result is then ignored.
   signal.addEventListener('abort',()=>{worker.state='error';worker.error='Follow-up stopped: '+String(signal.reason?.message||signal.reason||'aborted');m.followups.find(f=>f.workerId===workerId).status='error';missionSnapshot(m,'worker-result',worker.error,workerId)},{once:true});
   const result=await specialist(agentId,question,projectId,m.routing?.workerModel||'',joined.slice(0,10000),{...options,signal,workerId,onEvent:event=>recordMissionTool(m,event)});
   signal.throwIfAborted();
   worker.state=result.status;worker.model=result.model;worker.error=result.error||'';
   Object.assign(m.followups.find(f=>f.workerId===workerId),{status:result.status,runId:result.id,error:result.error||''});
   missionSnapshot(m,'worker-result','Follow-up investigation finished',workerId);
   if(result.status!=='complete')throw new Error('Follow-up failed: '+result.error);
   const keep=Math.floor(evidenceChars/4);return {data:{workerId,answer:result.answer.slice(0,keep),truncated:result.answer.length>keep},evidence:result.evidenceRecords.slice(-12)};
  });
  const result=await runAgentLoop({model,system:'You are the mission coordinator for the Local AI Appliance. Check specialist evidence before accepting conclusions. Request a focused investigation if a material fact is missing. Synthesize only claims grounded in the specialist evidence. Preserve source labels and evidence IDs. State uncertainty once, briefly. '+COORDINATOR_ABSENCE_RULE+' '+ANSWER_FORMAT,prompt:'Mission: '+goal+'\n\nSpecialist outputs:\n'+joined+'\n\nAvailable evidence:\n'+JSON.stringify(evidenceIndex),turn:deps.runAgentTurn,tools:[followup],evidence,maxTurns:4,maxToolCalls:2,...(deps.agentLimits?.maxContextChars?{maxContextChars:deps.agentLimits.maxContextChars}:{}),timeoutMs:coordinatorTimeoutMs,toolTimeoutMs:followupTimeoutMs,signal:options.signal,modelQueue,onEvent:event=>recordMissionTool(m,{...event,at:iso(),workerId:'synthesis',runId:m.id})});
  m.evidenceRecords=result.evidenceRecords;m.citations=result.citations;if(result.citationWarning)m.citationWarning=result.citationWarning;return result.answer;
 }
 // Tool steps update the mission record and live stream without adding timeline entries.
 function recordMissionTool(m,event){
  pushCapped(m.toolEvents,event);
  // A worker waiting for another's model turn says so ("Waiting for the model (1 ahead)", agent-world-words.js).
  const w=(m.workers||[]).find(x=>x.id===event.workerId);
  if(w&&event.type==='model_queue'){w.phase='model_queue';w.queuePosition=event.ahead}
  else if(w&&w.phase==='model_queue'){delete w.phase;delete w.queuePosition}
  m.updatedAt=iso();persistRecord(missionsFile,m,200);events.emit('mission',m);
 }
 // Upsert and keep only the newest `limit` records (oldest are finished history).
 function persistRecord(collection, record, limit){
  storage.transaction(()=>{storage.put(collection, record);if(limit)storage.prune(collection, limit)});
 }
 function settleWorkers(m,reason){for(const w of m.workers||[]){if(w.state==='running'){w.state='error';w.error=reason}else if(w.state==='pending'){w.state='blocked';w.error=reason}}}
 function reconcileInterrupted(){const reason='Local AI restarted for an update while this was running';for(const m of storage.list(missionsFile,{status:'running'})){m.status='error';m.error=reason;settleWorkers(m,reason);m.updatedAt=iso();storage.upsert(missionsFile,m)}for(const r of storage.list(runsFile,{status:'running'})){r.status='error';r.error=reason;r.errorCode='INTERRUPTED';for(const p of r.plan||[])if(p.state==='running')p.state='error';r.updatedAt=iso();storage.upsert(runsFile,r)}}
 function missionSnapshot(m,type='state',detail='',workerId=''){
  m.timeline=m.timeline||[];
  const workers=(m.workers||[]).map(w=>({id:w.id,name:w.name,state:w.state,model:w.model,dependsOn:w.dependsOn||[],reason:w.reason,routingMeta:w.routingMeta||null,error:w.error||'',...(w.partial?{partial:true}:{})}));
  const sig=workers.map(w=>w.id+':'+w.state).join('|')+'|'+m.status+'|'+type;
  if(m.timeline.at(-1)?.sig!==sig)m.timeline.push({at:iso(),type,detail,workerId,status:m.status,sig,workers});
  m.updatedAt=iso();
  persistRecord(missionsFile,m,200);
  events.emit('mission',m);return m
 }
 async function mission(goal,projectId='',manualAgentIds,opts={}){
  // opts.workerModel (an installed model's exact name) runs every specialist and follow-up on it; the coordinator routes as usual.
  const routing=await dispatch(goal,manualAgentIds,{workerModel:opts.workerModel});
  const m={id:id('mission'),goal,projectId,status:'running',routing,createdAt:iso(),updatedAt:iso(),timeline:[],toolEvents:[],followups:[],policy:policy(opts),workers:[{id:'router',name:'Mission Router',state:'complete',dependsOn:[],reason:routing.reason,routingMeta:{capabilityScore:100,modelScore:100,workload:0,availability:'available',groundingRequired:false,dependencyCount:0,retryPolicy:{transportRetries:0,fallbackAgentId:null},matchTerms:['mission-planning']}},...routing.workers.map(w=>({id:w.agentId,name:w.name,state:'pending',model:w.model,dependsOn:['router',...w.dependsOn],reason:w.reason,routingMeta:w.routingMeta})),{id:'synthesis',name:'Coordinator',state:'pending',dependsOn:routing.selectedAgentIds,reason:'Synthesize grounded specialist outputs',routingMeta:{capabilityScore:100,modelScore:0,workload:0,availability:'available',groundingRequired:true,dependencyCount:routing.selectedAgentIds.length,retryPolicy:{transportRetries:MODEL_RETRY_DELAYS_MS.length,fallbackAgentId:null},matchTerms:['synthesis']}}],results:[]};
  try{opts.onCreated?.(m)}catch{}
  missionSnapshot(m,'mission-start','Mission accepted and routing plan created','router');
  try{
   const pending=new Set(routing.selectedAgentIds),done=new Set(),results=[];
   while(pending.size){opts.signal?.throwIfAborted();const blocked=routing.workers.filter(w=>pending.has(w.agentId)&&(w.dependsOn||[]).some(d=>done.has(d)&&!results.some(r=>r.agentId===d&&usable(r))));blocked.forEach(w=>{pending.delete(w.agentId);done.add(w.agentId);const mw=m.workers.find(x=>x.id===w.agentId);mw.state='blocked';mw.error='Blocked because a prerequisite specialist failed';});if(blocked.length){m.results=results;m.updatedAt=iso();missionSnapshot(m,'blocked','A dependency failure blocked downstream work',blocked[0]?.agentId||'')}const ready=routing.workers.filter(w=>pending.has(w.agentId)&&(w.dependsOn||[]).every(d=>done.has(d)&&results.some(r=>r.agentId===d&&usable(r))));if(!ready.length){if(!pending.size)break;throw new Error('Mission dependency graph cannot make progress');}
    ready.forEach(w=>m.workers.find(x=>x.id===w.agentId).state='running');m.updatedAt=iso();missionSnapshot(m,'dispatch','Ready workers entered execution',ready.map(w=>w.agentId).join(','));
    const batch=await Promise.all(ready.map(async w=>{
     const workerOpts={...opts,workerId:w.agentId,onEvent:event=>recordMissionTool(m,event)};
     let r=await specialist(w.agentId,goal,projectId,w.model,dependencyContext(results,w.dependsOn),workerOpts);
     const fallbackId=w.routingMeta?.retryPolicy?.fallbackAgentId;
     if(r.status!=='complete'&&fallbackId){
      const fbAgent=specialists.find(a=>a.id===fallbackId);
      if(fbAgent){missionSnapshot(m,'fallback','Primary worker failed; attempting fallback '+fbAgent.name,w.agentId);try{const fbRoute=routing.workerModel?{model:routing.workerModel}:await routeModel(goal+' '+fbAgent.capabilities.join(' '));const fb=await specialist(fallbackId,goal,projectId,fbRoute.model,dependencyContext(results,w.dependsOn),workerOpts);if(fb.status==='complete')r={...fb,agentId:w.agentId,agentName:fb.agentName+' (fallback for '+w.name+')',executedBy:fallbackId,fallbackFor:w.agentId}}catch(fe){missionSnapshot(m,'fallback','Fallback '+fbAgent.name+' failed: '+String(fe.message||fe),w.agentId)}}
     }
     return r
    }));results.push(...batch);
    ready.forEach(w=>{pending.delete(w.agentId);done.add(w.agentId);const r=results.find(x=>x.agentId===w.agentId),mw=m.workers.find(x=>x.id===w.agentId);mw.state=usable(r)?'complete':r.status;if(r.partial){mw.partial=true;if(r.error){mw.error=r.error;mw.errorCode=r.errorCode}}if(r.fallbackFor){mw.fallbackUsed=r.executedBy;mw.reason=(mw.reason||'')+' · fallback executed by '+r.executedBy}});
    m.results=results;m.updatedAt=iso();missionSnapshot(m,'worker-result','Specialist results published',ready.map(w=>w.agentId).join(','));
   }
   opts.signal?.throwIfAborted();
   // Partial or missing parts don't stop the team: the Coordinator writes from what exists and says what is missing.
   // Only with nothing at all to work from does the mission need you.
   if(!results.some(usable)){const sw=m.workers.find(x=>x.id==='synthesis');sw.state='blocked';sw.error='Synthesis skipped because prerequisite specialists did not complete';m.status='needs_attention';m.error='Mission stopped after specialist failure';m.updatedAt=iso();missionSnapshot(m,'mission-attention','Mission stopped after specialist failure');return m}
   const sw=m.workers.find(x=>x.id==='synthesis');sw.state='running';missionSnapshot(m,'synthesis','Coordinator started synthesis','synthesis');
   try{
    // Specialist outputs share two thirds of the evidence budget evenly (12000 characters each at most).
    const perResult=Math.min(12000,Math.floor(evidenceChars*2/3/Math.max(1,results.length)));
    const missing=m.workers.filter(w=>w.state==='blocked'&&!results.some(r=>r.agentId===w.id)).map(w=>'## '+w.name+' (missing: did not run because a prerequisite stopped)');
    const gaps=results.some(r=>!usable(r)||r.partial)||missing.length?'NOTE: Some specialist work is partial or missing (marked below). Write the answer from what exists, and say plainly which parts are missing.\n\n':'';
    const coordinatorModel=(await routeModel(goal+' synthesis')).model,joined=gaps+[...results.map(r=>'## '+r.agentName+(!usable(r)?' (missing: stopped without findings)':r.partial?' (partial findings'+(r.status!=='complete'?': stopped before writing up':': cites no evidence')+')':'')+(r.citationWarning&&!r.partial?' (citation warning: '+r.citationWarning+')':'')+'\n'+String(r.answer||r.notes||r.error||'').slice(0,perResult)),...missing].join('\n\n');
    const synthPrompt='Mission: '+goal+'\n\nSpecialist outputs:\n'+joined+'\n\nSynthesize only claims grounded in the specialist evidence. Preserve source labels. Reject invented product behavior, metrics, dates, screens, users, or defects. Clearly distinguish observed evidence from recommendations and identify remaining evidence gaps once. '+COORDINATOR_ABSENCE_RULE+' '+ANSWER_FORMAT,synthSystem='You are the mission coordinator for the Local AI Appliance. Produce an actionable, source-grounded synthesis; never substitute a generic consumer AI product.';
    // The model coordinator (app/model-coordinator.js): the summary may come from a cloud model (kind `plan`) from the goal
    // and the specialist outputs only, as one prompt: no tools, no evidence index. Default local: only when every worker
    // read nothing but public evidence (publicEvidence: web results, Local AI's own code) and nothing in the goal or the
    // findings looks secret or personal. A project mission or a voice mission stays here too. Cloud off,
    // private, or a cloud failure: the Coordinator on this PC, as before. The mission says where it ran (m.route).
    const co=deps.coordinator,route=co?co.route({kind:'plan',text:goal+'\n'+joined,voice:opts.voice===true,stay:projectId||!results.every(r=>(r.evidenceRecords||[]).every(publicEvidence))?'Missions that read your documents or files stay on this PC':secretish(goal+'\n'+joined)?"Local AI's own keys, passwords and setup stay on this PC":'',localModel:coordinatorModel}):null;
    const cloud=route?await co.run(route,[{role:'system',content:synthSystem},{role:'user',content:synthPrompt}],{kind:'plan',maxTokens:4000}):null;
    opts.signal?.throwIfAborted();
    if(cloud){m.answer=cloud.content;m.coordinatorModel=cloud.used.model;m.route=cloud.used}
    else{
    m.answer=typeof deps.runAgentTurn==='function'?await coordinate(m,goal,projectId,coordinatorModel,joined,opts).catch(e=>{if(e.code!=='MODEL_NO_TOOLS')throw e;m.toolFallback=e.message;return null}):null;
    if(m.answer===null)m.answer=await runModelReliable(synthPrompt,synthSystem,coordinatorTimeoutMs,coordinatorModel);m.coordinatorModel=coordinatorModel;if(route)m.route=co.local(route,coordinatorModel);
    }
    // The answer tidied (mission-answer.js: no process talk, Markdown or emoji, "missing" things the evidence names
    // rewritten as present, repeated gaps once, a length cap), then absence the workers never searched for is marked
    // "not checked" with a caveat line (mission-evidence.js checkAbsenceClaims). The Coordinator's own words stay in
    // m.rawAnswer.
    if(String(m.answer||'').trim()){const records=[...m.results.flatMap(r=>r.evidenceRecords||[]),...(m.evidenceRecords||[])],searches=records.filter(r=>r.kind==='search'),polished=polishAnswer(m.answer,{evidenceRecords:records});if(polished.answer!==m.answer){m.rawAnswer=m.answer;m.answerCheck=polished.report}const checked=checkAbsenceClaims(polished.answer,searches);if(checked.flagged.length||checked.backed.length)m.absenceCheck={flagged:checked.flagged,backed:checked.backed};m.answer=checked.answer}
   }catch(e){
    // Cancelling the mission stays an error; a coordinator that fails on its own leaves no answer, so the mission needs you.
    if(opts.signal?.aborted)throw e;
    const msg=String(e.message||e);sw.state='error';sw.error=msg;sw.errorCode=e.code||'';
   }
   // Follow-ups are optional extras: with an answer the mission is done and says which didn't finish (their own rows
   // keep their stopped state). Only a missing answer needs you.
   const note=missionNote(m);if(note)m.note=note;
   if(sw.state!=='error'&&String(m.answer||'').trim()){sw.state='complete';m.status='complete'}
   else{if(sw.state!=='error'){sw.state='error';sw.error='The coordinator didn’t write an answer'}m.status='needs_attention';m.error='No answer: '+(sw.error||'the coordinator didn’t write one')+(note?' ('+note+')':'');m.errorCode=sw.errorCode||'MISSION_NO_ANSWER';settleWorkers(m,m.error);missionSnapshot(m,'mission-attention',m.error,'synthesis');return m}
  }catch(e){m.status='error';m.error=String(e.message||e);m.errorCode=e.code||'MISSION_ERROR';settleWorkers(m,m.error)}
  m.updatedAt=iso();missionSnapshot(m,m.status==='complete'?'mission-complete':'mission-error',m.status==='complete'?'Mission completed and artifacts are ready':(m.error||'Mission ended with an error'));return m
 }
 reconcileInterrupted();
 return {close:()=>{if(!deps.storage)storage.close()},catalog,models,checkWorkerModel,route:routeModel,dispatch,specialist,mission,runs:(limit)=>storage.list(runsFile,limit?{limit}:{}),missions:(limit)=>storage.list(missionsFile,limit?{limit}:{}),getMission:id=>storage.get(missionsFile,id),events};
};
