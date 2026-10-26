'use strict';

// Agents and missions: local model calls, plans, the specialist orchestrator, missions with their live events, and what is running now (apiBusy reads the orchestrator).
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createAgents(ctx) {
  const { APPROVALS_STORE, APP_DIR, DATA_DIR, ENGINEERING_MODEL_TIMEOUT_MS, LARGE_ANSWER_RESERVE, MISSION_ANSWER_RESERVE, MISSION_EVIDENCE_TOKENS, MISSION_MODEL_CONCURRENCY, MISSION_NUM_CTX, MISSION_TIMEOUT_MS, MODEL, OLLAMA_URL, RUNS_STORE, TEXT_KEEP_ALIVE, TEXT_NUM_CTX, TEXT_NUM_CTX_LARGE, URL, activeRunControllers, coordinator, addNotification, agentRunStore, approvalStore, busy, fetchWithTimeout, fitMessages, inFlight, json, knowledgeScore, knowledgeStore, makeId, modelFetchWithTimeout, nowIso, plainText, readBody, recordActivity, requireFeature, runLedger, saveStore, searxSearch, storage, storageError, titleFromText } = ctx;
  // What a restart would interrupt now. The host's auto-deploy holds an update while this says busy (docs/DEPLOY.md).
  // The orchestrator is only asked once something has created it: before that nothing of its can be running, and
  // creating it here would settle records from before the restart as a side effect.
  function busyNow(){return busy.activeWork({runs:['queued','running','streaming'].flatMap(status=>runLedger.list({status,all:true})),missions:specialistOrchestrator?specialistOrchestrator.missions(200):[],specialists:specialistOrchestrator?specialistOrchestrator.runs(200):[],inFlight:inFlight.list()})}
  function apiBusy(req,res){
    try{json(res,200,busyNow())}
    catch(e){json(res,500,{error:String(e.message||e)})}
  }
  async function runLocalModel(prompt, system='You are a concise local AI assistant.', timeoutMs=180000, model=MODEL){
    const selectedModel=String(model||MODEL).trim()||MODEL;
    const r=await modelFetchWithTimeout(`${OLLAMA_URL}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:selectedModel,messages:fitMessages([{role:'system',content:system},{role:'user',content:String(prompt).slice(0,50000)}]),stream:false,keep_alive:TEXT_KEEP_ALIVE,options:{num_ctx:TEXT_NUM_CTX}})},timeoutMs);
    const raw=await r.text(); if(!r.ok)throw new Error(`Intelligence service HTTP ${r.status}: ${raw.slice(0,400)}`); const j=JSON.parse(raw); return j?.message?.content||'';
  }
  async function runEngineeringPlannerModel(prompt, system, timeoutMs=ENGINEERING_MODEL_TIMEOUT_MS){
    const started=Date.now();
    let watchdogAborted=false;
    const payload=Buffer.from(JSON.stringify({
      model:MODEL,
      // The planner is rare and code-heavy, so it gets the large context; the reload cost when switching is accepted.
      messages:fitMessages([
        {role:'system',content:system},
        {role:'user',content:String(prompt).slice(0,50000)}
      ],{numCtx:TEXT_NUM_CTX_LARGE,reserve:LARGE_ANSWER_RESERVE}),
      stream:true,
      keep_alive:TEXT_KEEP_ALIVE,
      options:{num_ctx:TEXT_NUM_CTX_LARGE}
    }),'utf8');
    const endpoint=new URL(`${OLLAMA_URL}/api/chat`);
    const transport=endpoint.protocol==='https:'
      ? require('node:https')
      : require('node:http');
    return await new Promise((resolve,reject)=>{
      let settled=false;
      let timer=null;
      let req=null;
      const finish=(fn,value)=>{
        if(settled)return;
        settled=true;
        if(timer)clearTimeout(timer);
        fn(value);
      };
      const fail=(e)=>{
        const elapsedMs=Date.now()-started;
        const code=e?.cause?.code||e?.code||'';
        const aborted=watchdogAborted||e?.name==='AbortError';
        console.warn(`Engineering planner transport: ${e?.name||'Error'}: ${e?.message||e}${code?`; code=${code}`:''}; elapsedMs=${elapsedMs}; watchdogAborted=${aborted}`);
        finish(reject,new Error(plainText.plannerError({aborted,timeoutMs,code,message:e?.message||e})));
      };
      try{
        req=transport.request({
          protocol:endpoint.protocol,
          hostname:endpoint.hostname,
          port:endpoint.port||undefined,
          path:`${endpoint.pathname}${endpoint.search}`,
          method:'POST',
          headers:{
            'Content-Type':'application/json',
            'Content-Length':payload.length
          }
        },res=>{
          if(res.statusCode<200||res.statusCode>=300){
            let errorBody='';
            res.setEncoding('utf8');
            res.on('data',chunk=>{
              errorBody+=chunk;
              if(errorBody.length>4000)errorBody=errorBody.slice(0,4000);
            });
            res.on('end',()=>{
              fail(new Error(
                `Intelligence service HTTP ${res.statusCode}: ${errorBody.slice(0,400)}`
              ));
            });
            res.on('error',fail);
            return;
          }
          res.setEncoding('utf8');
          let buffer='';
          let content='';
          let done=false;
          const acceptLine=(line)=>{
            if(!line.trim())return;
            let item;
            try{
              item=JSON.parse(line);
            }catch(e){
              throw new Error(`Malformed Ollama planner NDJSON: ${e.message}`);
            }
            if(item.error){
              throw new Error(`Ollama planner error: ${item.error}`);
            }
            if(item?.message?.content){
              content+=item.message.content;
            }
            if(item.done===true){
              done=true;
            }
          };
          res.on('data',chunk=>{
            if(settled)return;
            try{
              buffer+=chunk;
              let nl;
              while((nl=buffer.indexOf('\n'))>=0){
                const line=buffer.slice(0,nl);
                buffer=buffer.slice(nl+1);
                acceptLine(line);
              }
            }catch(e){
              try{req.destroy()}catch{}
              fail(e);
            }
          });
          res.on('end',()=>{
            if(settled)return;
            try{
              if(buffer.trim()){
                acceptLine(buffer);
              }
              if(!done){
                throw new Error('Ollama planner stream ended before done:true');
              }
              finish(resolve,content);
            }catch(e){
              fail(e);
            }
          });
          res.on('aborted',()=>{
            fail(new Error('Ollama planner response aborted'));
          });
          res.on('error',fail);
        });
        req.on('error',fail);
        timer=setTimeout(()=>{
          if(settled)return;
          watchdogAborted=true;
          req.destroy(
            new Error(`Engineering planner watchdog exceeded ${timeoutMs} ms`)
          );
        },timeoutMs);
        req.write(payload);
        req.end();
      }catch(e){
        fail(e);
      }
    });
  }
  function buildAgentPlan(goal){
    const t=String(goal||'').toLowerCase(); const steps=[{name:'Understand goal',kind:'plan'}];
    if(/latest|research|web|compare|news|look up/.test(t))steps.push({name:'Research sources',kind:'research'});
    if(/file|code|repo|project|fix|implement|debug/.test(t))steps.push({name:'Inspect workspace context',kind:'workspace'});
    steps.push({name:'Reason and synthesize',kind:'model'}); steps.push({name:'Produce result',kind:'compose'}); return steps;
  }
  async function executeAgentGoal(goal,projectId=''){
    const plan=buildAgentPlan(goal); const sources=[]; let context='';
    for(const s of plan){s.state='pending'}; plan[0].state='complete';
    const researchStep=plan.find(x=>x.kind==='research'); if(researchStep){researchStep.state='running';try{const rs=await searxSearch(goal);sources.push(...rs);context+='\n\nWEB SOURCES:\n'+rs.map((x,i)=>`[${i+1}] ${x.title}\n${x.content}\n${x.url}`).join('\n\n');researchStep.state='complete'}catch(e){researchStep.state='error';researchStep.error=String(e.message||e)}}
    if(projectId){const hits=[];for(const d of knowledgeStore().filter(x=>x.projectId===projectId)){for(const c of d.chunks||[]){const score=knowledgeScore(goal,c);if(score>0)hits.push({score,name:d.name,text:c})}}hits.sort((a,b)=>b.score-a.score);if(hits.length)context+='\n\nPROJECT KNOWLEDGE:\n'+hits.slice(0,5).map((x,i)=>`[K${i+1}] ${x.name}\n${x.text}`).join('\n\n')}
    const modelStep=plan.find(x=>x.kind==='model'); if(modelStep)modelStep.state='running'; const answer=await runLocalModel(`${goal}${context}`,'You are an execution agent inside a private local appliance. Use available context, state uncertainties, and return a concrete result.'); if(modelStep)modelStep.state='complete'; const compose=plan.find(x=>x.kind==='compose'); if(compose)compose.state='complete'; return {plan,answer,sources};
  }
  let specialistOrchestrator=null;
  // The missions' model queue, made here rather than in the orchestrator so GET /api/world can say how many turns are
  // running and waiting without creating the orchestrator.
  const missionModelQueue=require('../agent-runtime').createModelQueue({concurrency:Number.isSafeInteger(MISSION_MODEL_CONCURRENCY)&&MISSION_MODEL_CONCURRENCY>0?MISSION_MODEL_CONCURRENCY:1});
  function getSpecialistOrchestrator(){
   if(specialistOrchestrator)return specialistOrchestrator;
   specialistOrchestrator=require('../agent-orchestrator')({
    dataDir:DATA_DIR,storage,ollamaUrl:OLLAMA_URL,defaultModel:MODEL,fetchWithTimeout,runLocalModel,coordinator,
    knowledgeStore,knowledgeScore,searxSearch,recordActivity,
    projectRoot:APP_DIR,
    // Mission turns use a context sized to fit the GPU (text-context.js MISSION_NUM_CTX), one model turn at a time, and
    // an opening-evidence budget that keeps the first prompt to about a minute of reading.
    runAgentTurn:require('../agent-runtime').createOllamaTurn({ollamaUrl:OLLAMA_URL,numCtx:MISSION_NUM_CTX,keepAlive:TEXT_KEEP_ALIVE}),
    agentLimits:{maxContextChars:Math.floor((MISSION_NUM_CTX-MISSION_ANSWER_RESERVE)*3.5)},
    numCtx:MISSION_NUM_CTX,evidenceTokens:MISSION_EVIDENCE_TOKENS,modelConcurrency:MISSION_MODEL_CONCURRENCY,modelQueue:missionModelQueue,
    groundedTimeoutMs:MISSION_TIMEOUT_MS,coordinatorTimeoutMs:MISSION_TIMEOUT_MS
   });
   return specialistOrchestrator;
  }
  async function apiAgentCatalog(req,res){if(!requireFeature(res,4))return;json(res,200,{items:getSpecialistOrchestrator().catalog})}
  async function apiAgentModels(req,res){if(!requireFeature(res,4))return;try{json(res,200,{items:await getSpecialistOrchestrator().models()})}catch(e){json(res,503,{error:String(e.message||e)})}}
  async function apiSpecialistRun(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req),goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});json(res,200,{run:await getSpecialistOrchestrator().specialist(String(b.agentId||''),goal,String(b.projectId||''))})}catch(e){storageError(res,e,400)}}
  async function apiAgentDispatch(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req),goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});json(res,200,{routing:await getSpecialistOrchestrator().dispatch(goal,Array.isArray(b.agentIds)?b.agentIds:undefined,{workerModel:b.workerModel||''})})}catch(e){workerModelError(res,e)}}
  async function apiAgentMissions(req,res){if(!requireFeature(res,4))return;json(res,200,{items:getSpecialistOrchestrator().missions(200)})}
  async function apiAgentMission(req,res,urlObj){if(!requireFeature(res,4))return;const id=String(urlObj.searchParams.get('id')||''),m=getSpecialistOrchestrator().getMission(id);if(!m)return json(res,404,{error:'Mission not found'});json(res,200,{mission:m})}
  // Every mission is a ledger run from the first moment, however it was started, so Work › Missions lists it.
  // async:true answers 202 at once; without it (Agent World) the reply waits for the mission. The run follows the mission's own events.
  // Mission statuses: running | complete | needs_attention | error (the last two end the run failed).
  function startMissionRun(goal,projectId,ids,allowWeb=false,workerModel='',{voice=false}={}){
    const orch=getSpecialistOrchestrator();
    const run=runLedger.create({type:'agent',title:titleFromText(goal,'Mission'),input:{goal:goal.slice(0,4000),projectId,agentIds:ids||[],webSearch:allowWeb,...(workerModel?{workerModel}:{})},projectId,meta:{},cancellable:true});
    runLedger.start(run.id,'Mission started');
    const controller=new AbortController();activeRunControllers.set(run.id,controller);
    let missionId='',off=()=>{},ended=false,last='';
    const apply=m=>{
      if(ended||m.id!==missionId)return;
      const ws=m.workers||[],done=ws.filter(w=>w.state==='complete').length,pct=ws.length?Math.max(5,Math.min(95,Math.round(done/ws.length*100))):5;
      if(m.status==='running'){const sig=pct+':'+done;if(sig===last)return;last=sig;runLedger.update(run.id,{status:'running',progress:pct},'Mission progress: '+done+' of '+ws.length+' steps');return}
      ended=true;off();activeRunControllers.delete(run.id);
      if(m.status==='complete')runLedger.complete(run.id,{summary:String(m.answer||'Mission complete').replace(/\s+/g,' ').trim().slice(0,600),output:{missionId:m.id,outcome:m.status,...(m.note?{note:String(m.note).slice(0,200)}:{})},meta:{missionId:m.id,...(m.route?{route:m.route}:{})}});
      else runLedger.update(run.id,{status:'failed',error:String(m.error||'The mission needs attention.').slice(0,8000),output:{missionId:m.id,outcome:m.status},meta:{missionId:m.id}},'Mission '+m.status);
    };
    // `done` settles with the mission (or its error) for callers that wait for it; the run records the outcome either way.
    const done=orch.mission(goal,projectId,ids,{signal:controller.signal,allowWeb,workerModel,voice,onCreated:m=>{missionId=m.id;orch.events.on('mission',apply);off=()=>orch.events.off('mission',apply);runLedger.update(run.id,{meta:{missionId:m.id}},'Mission created')}})
      .then(m=>{apply(m);return m},e=>{activeRunControllers.delete(run.id);if(!ended){ended=true;off();runLedger.fail(run.id,e)}throw e});
    done.catch(()=>{});
    return {run,done};
  }
  // workerModel (optional, developer tools): an installed model's exact name that every specialist in the mission uses.
  // It is checked before the run exists, so an unknown name answers 400 with the installed names, async or not.
  function workerModelError(res,e){if(e&&e.code==='UNKNOWN_MODEL')return json(res,400,{error:e.message,code:e.code,installed:e.installed||[]});storageError(res,e,400)}
  async function apiAgentMissionStart(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req),goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});const ids=Array.isArray(b.agentIds)&&b.agentIds.length?b.agentIds:undefined;const allowWeb=b.webSearch===true;let workerModel='';if(b.workerModel!==undefined&&b.workerModel!==null&&b.workerModel!==''){try{workerModel=await getSpecialistOrchestrator().checkWorkerModel(b.workerModel)}catch(e){if(e.code==='UNKNOWN_MODEL')return workerModelError(res,e);return json(res,503,{error:String(e.message||e)})}}const {run,done}=startMissionRun(goal,String(b.projectId||''),ids,allowWeb,workerModel);if(b.async===true)return json(res,202,{runId:run.id,threadId:run.threadId});json(res,200,{mission:await done,runId:run.id})}catch(e){storageError(res,e,400)}}
  const SSE_KEEPALIVE_MS=Math.max(1000,Number(process.env.SSE_KEEPALIVE_MS)||25000);
  async function apiAgentMissionEvents(req,res,urlObj){if(!requireFeature(res,4))return;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});const wanted=String(urlObj.searchParams.get('missionId')||'');const send=m=>{if(!wanted||m.id===wanted)res.write('data: '+JSON.stringify(m)+'\n\n')};const orch=getSpecialistOrchestrator();orch.events.on('mission',send);res.write(': connected\n\n');
    // A comment every 25 s keeps phones and proxies from dropping a quiet stream.
    const keepAlive=setInterval(()=>res.write(': keepalive\n\n'),SSE_KEEPALIVE_MS);req.on('close',()=>{clearInterval(keepAlive);orch.events.off('mission',send)})}
  async function apiAgents(req,res){if(!requireFeature(res,4))return;json(res,200,{items:agentRunStore().slice(0,200)})}
  async function apiAgentRun(req,res){
    if(!requireFeature(res,4))return; try{const b=await readBody(req);const goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});const runs=agentRunStore();const run={id:makeId('agent'),goal,projectId:String(b.projectId||''),status:'running',createdAt:nowIso(),updatedAt:nowIso(),plan:buildAgentPlan(goal)};runs.unshift(run);saveStore(RUNS_STORE,runs,300);recordActivity('agent','Agent started',goal.slice(0,180),{runId:run.id});try{const result=await executeAgentGoal(goal,run.projectId);run.status='complete';run.plan=result.plan;run.answer=result.answer;run.sources=result.sources;run.updatedAt=nowIso()}catch(e){run.status='error';run.error=String(e.message||e);run.updatedAt=nowIso()}saveStore(RUNS_STORE,runs,300);recordActivity('agent',run.status==='complete'?'Agent completed':'Agent failed',goal.slice(0,180),{runId:run.id,status:run.status});json(res,200,{run})}catch(e){storageError(res,e,400)}
  }
  async function apiAgentPlan(req,res){
    if(!requireFeature(res,9))return;
    try{const b=await readBody(req);const goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});const plan=buildAgentPlan(goal);
      const risky=/\b(write|modify|delete|remove|restart|execute|run command|deploy)\b/i.test(goal);
      let approval=null;if(risky){const items=approvalStore();approval={id:makeId('approval'),title:'Agent action approval',detail:goal.slice(0,3000),risk:'medium',status:'pending',createdAt:nowIso(),updatedAt:nowIso(),meta:{goal}};items.unshift(approval);saveStore(APPROVALS_STORE,items,500);addNotification('approval',approval.title,approval.detail,{approvalId:approval.id})}
      json(res,200,{goal,plan,approval});
    }catch(e){storageError(res,e,400)}
  }
  return { busyNow, missionModelQueue, apiAgentCatalog, apiAgentDispatch, apiAgentMission, apiAgentMissionEvents, apiAgentMissionStart, apiAgentMissions, apiAgentModels, apiAgentPlan, apiAgentRun, apiAgents, apiBusy, apiSpecialistRun, runEngineeringPlannerModel, runLocalModel, startMissionRun };
}

module.exports = { createAgents };
