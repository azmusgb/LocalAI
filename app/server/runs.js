'use strict';

// Runs: the unified list (with older agent, automation and engineering runs), cancel, filing and retry.
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createRuns(ctx) {
  const { AUTOMATION_RUNS_STORE, MODEL, RUNS_STORE, WORK_CHIPS, activeRunControllers, agentRunStore, approvalStore, automationRunStore, changeStore, cleanRunId, effectiveEngineeringRuns, fetchWithTimeout, gridcraftRuns, json, keptMarker, listenPort, needsYou, nowIso, projectStore, readBody, recordActivity, runCard, runLedger, sanitizeMessages, saveStore, seenRuns, storageError, titleFromText, withSeen, workKind } = ctx;
  function createChatExecution(body,streaming){
    const messages=sanitizeMessages(body?.messages);const prompt=[...messages].reverse().find(m=>m.role==='user')?.content||'Chat';
    const model=typeof body?.model==='string'&&body.model.trim()?body.model.trim():MODEL;
    const label=typeof body?.title==='string'?body.title.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,80):''; // the caller's name for it in Recent ("House question")
    const retryBody={messages,model,webSearch:body?.webSearch===true,threadId:cleanRunId(body?.threadId)||undefined,brief:body?.brief===true||undefined,title:label||undefined};
    return runLedger.create({type:body?.webSearch===true?'research':'chat',title:titleFromText(prompt,body?.webSearch===true?'Research':'Chat'),input:{prompt:prompt.slice(0,4000),model,webSearch:body?.webSearch===true,messageCount:messages.length},cancellable:streaming===true,threadId:body?.threadId,retryRequest:{path:'/api/chat',body:retryBody},meta:{streaming:streaming===true,...(label?{label}:{}),...(body?.voice===true||body?.voiceRun===true?{voice:true}:{})}});
  }
  function normalizedExecutionStatus(value){
    const s=String(value||'').toLowerCase();
    if(['complete','completed','applied','success','succeeded'].includes(s))return 'completed';
    if(['error','failed','needs_attention','validation_failed','patch_failed','deploy_failed','rejected'].includes(s))return 'failed';
    if(['cancelled','canceled'].includes(s))return 'cancelled';
    if(s==='awaiting_approval')return 'awaiting_approval';
    if(['running','approved','apply_requested','staged'].includes(s))return 'running';
    return 'queued';
  }
  function executionProgress(status,steps=[]){
    if(status==='completed')return 100;if(status==='failed'||status==='cancelled')return 0;if(status==='awaiting_approval')return 65;
    const list=Array.isArray(steps)?steps:[];if(list.length){const done=list.filter(x=>['complete','completed','success'].includes(String(x?.state||x?.status||'').toLowerCase())).length;return Math.max(5,Math.min(95,Math.round(done/list.length*100)))}return status==='running'?30:0;
  }
  function legacyEvents(item){
    const steps=Array.isArray(item?.steps)?item.steps:Array.isArray(item?.plan)?item.plan:[];
    if(steps.length)return steps.map(step=>({at:step.at||item.updatedAt||item.createdAt||item.startedAt||nowIso(),status:normalizedExecutionStatus(step.state||step.status),detail:String(step.detail||step.name||step.kind||step.state||'Step').slice(0,1200)}));
    const events=[];const start=item.startedAt||item.createdAt;if(start)events.push({at:start,status:'running',detail:'Run started'});const terminal=normalizedExecutionStatus(item.status);if(['completed','failed','cancelled'].includes(terminal))events.push({at:item.finishedAt||item.updatedAt||start,status:terminal,detail:terminal==='completed'?'Run completed':terminal==='failed'?'Run failed':'Run cancelled'});return events;
  }
  function legacyUnifiedRuns() {
    const items = [];
    for (const run of agentRunStore().slice(0, 200)) {
      const status = normalizedExecutionStatus(run.status);
      items.push({
        id: 'legacy-agent:' + run.id,
        type: 'agent',
        title: titleFromText(run.goal, 'Agent run'),
        status,
        progress: executionProgress(status, run.plan),
        createdAt: run.createdAt || null,
        startedAt: run.createdAt || null,
        updatedAt: run.updatedAt || run.createdAt || null,
        finishedAt: ['completed','failed','cancelled'].includes(status) ? (run.updatedAt || null) : null,
        summary: String(run.answer || run.error || '').slice(0, 1200),
        input: { goal: String(run.goal || '').slice(0, 4000), projectId: run.projectId || '' },
        output: run.answer || null,
        error: run.error || null,
        artifactIds: [],
        source: { kind: 'agent', id: run.id },
        meta: { sources: Array.isArray(run.sources) ? run.sources.length : 0 },
        cancellable: false,
        retryable: ['completed','failed'].includes(status),
        attempt: Number.isSafeInteger(Number(run.attempt)) && Number(run.attempt) > 0 ? Number(run.attempt) : 1,
        retryOf: run.retryOf || null,
        events: legacyEvents(run)
      });
    }
    for (const run of automationRunStore().slice(0, 200)) {
      const status = normalizedExecutionStatus(run.status);
      items.push({
        id: 'legacy-automation:' + run.id,
        type: 'automation',
        title: titleFromText(run.name, 'Automation run'),
        status,
        progress: executionProgress(status),
        createdAt: run.startedAt || null,
        startedAt: run.startedAt || null,
        updatedAt: run.finishedAt || run.startedAt || null,
        finishedAt: ['completed','failed','cancelled'].includes(status) ? (run.finishedAt || null) : null,
        summary: String(run.output || run.error || '').slice(0, 1200),
        input: { automationId: run.automationId || '' },
        output: run.output || null,
        error: run.error || null,
        artifactIds: [],
        source: { kind: 'automation', id: run.id },
        meta: { automationId: run.automationId || '' },
        cancellable: false,
        retryable: ['completed','failed'].includes(status),
        attempt: Number.isSafeInteger(Number(run.attempt)) && Number(run.attempt) > 0 ? Number(run.attempt) : 1,
        retryOf: run.retryOf || null,
        events: legacyEvents(run)
      });
    }
    // Spreadsheet requests (GridCraft's own records, app/server/gridcraft.js): one waiting for Keep or Discard is waiting
    // on the owner, so Work and Needs you show it; opening it goes to Spreadsheets, where Keep and Discard are.
    const GRIDCRAFT_STATUS = { running: 'running', review: 'awaiting_approval', failed: 'failed', discarded: 'cancelled' };
    for (const run of gridcraftRuns(50)) {
      const status = GRIDCRAFT_STATUS[run.status] || 'completed';
      items.push({
        id: 'legacy-gridcraft:' + run.id,
        type: 'spreadsheet',
        title: titleFromText(run.prompt, 'Spreadsheet request'),
        status,
        progress: executionProgress(status),
        createdAt: run.createdAt || null,
        startedAt: run.createdAt || null,
        updatedAt: run.updatedAt || run.createdAt || null,
        finishedAt: status === 'awaiting_approval' || status === 'running' ? null : (run.updatedAt || run.createdAt || null),
        summary: String(run.answer || run.error || '').slice(0, 1200),
        input: { prompt: String(run.prompt || '').slice(0, 4000), mode: run.mode || '' },
        output: run.answer ? { text: String(run.answer).slice(0, 4000) } : null,
        error: run.error || null,
        artifactIds: [],
        source: { kind: 'gridcraft', id: run.id },
        meta: { mode: run.mode || '', gridcraftStatus: run.status || '', edits: Array.isArray(run.edits) ? run.edits.length : 0 },
        cancellable: false,
        retryable: false,
        attempt: 1,
        retryOf: null,
        events: legacyEvents(run)
      });
    }
    for (const run of effectiveEngineeringRuns().slice(0, 200)) {
      const status = normalizedExecutionStatus(run.status);
      items.push({
        id: 'legacy-engineering:' + run.id,
        type: 'engineering',
        title: titleFromText(run.request, 'Engineering run'),
        status,
        progress: executionProgress(status, run.steps),
        createdAt: run.createdAt || null,
        startedAt: run.createdAt || null,
        updatedAt: run.updatedAt || run.createdAt || null,
        finishedAt: ['completed','failed','cancelled'].includes(status) ? (run.updatedAt || null) : null,
        summary: String(run.error || run.changeStatus || '').slice(0, 1200),
        input: { request: String(run.request || '').slice(0, 4000), target: run.target || '', root: run.root || '' },
        output: run.finalChangeId ? { changeId: run.finalChangeId, changeStatus: run.changeStatus || null } : null,
        error: run.error || null,
        artifactIds: [],
        source: { kind: 'engineering', id: run.id },
        meta: { attempt: run.attempt || 0, maxAttempts: run.maxAttempts || 0, changeId: run.finalChangeId || null },
        cancellable: false,
        retryable: false,
        attempt: run.attempt || 1,
        retryOf: run.retryOf || null,
        events: legacyEvents(run)
      });
    }
    return items;
  }
  // Older missions wrote a `mission` run and a `specialist` run per worker (meta.missionId). A worker belongs to its mission's
  // row, so lists show the mission once; the worker run is kept and still opens by id. A specialist run with no listed mission stays.
  function collapseMissionWorkers(items){
    const missions=new Set();
    for(const x of items){if(x.type==='mission'&&x.meta?.sourceId)missions.add(x.meta.sourceId);else if(x.type!=='specialist'&&x.meta?.missionId)missions.add(x.meta.missionId)}
    return missions.size?items.filter(x=>!(x.type==='specialist'&&x.meta?.missionId&&missions.has(x.meta.missionId))):items;
  }
  function unifiedRunItems(limit=120,filter=null){
    const paged=!!filter?.threads; // a threads timeline pages through everything, so it reads the whole ledger, not its newest 500
    const native=runLedger.list({limit:500,all:paged,projectId:filter?.projectId,threadId:filter?.threadId});const legacy=legacyUnifiedRuns();
    let all=collapseMissionWorkers([...native,...legacy]);
    if(filter?.projectId)all=all.filter(x=>x.projectId===filter.projectId);
    if(filter?.threadId)all=all.filter(x=>(x.threadId||x.id)===filter.threadId);
    const byUpdate=(a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||''))||String(b.id).localeCompare(String(a.id));
    const byCreate=(a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))||String(b.id).localeCompare(String(a.id));
    // A conversation keeps its first message as its name (owner decision D10): every turn carries the thread's first title.
    const first=new Map();
    for(const x of all){const k=x.threadId||x.id,f=first.get(k);if(!f||byCreate(x,f)>0)first.set(k,x)}
    all=all.map(x=>{const f=first.get(x.threadId||x.id);return f&&f.id!==x.id&&f.title?{...x,threadTitle:f.title}:x});
    if(filter?.threads){
      // One row per thread: its latest run by (createdAt, id), with `turns` = runs in the thread, named by its first run. Dedupe first, then page by that same key.
      const by=new Map();
      for(const x of all){const k=x.threadId||x.id,e=by.get(k);if(!e)by.set(k,{run:x,turns:1});else{e.turns++;if(byCreate(x,e.run)<0)e.run=x}}
      all=[...by.values()].map(e=>({...e.run,title:e.run.threadTitle||e.run.title,turns:e.turns}));
      if(filter.kind)all=all.filter(x=>workKind(x)===filter.kind); // Work's chip: the thread's row (its latest run) decides, as on screen
      if(filter.before)all=all.filter(x=>byCreate(x,filter.before)>0);
      return all.sort(byCreate).slice(0,Math.max(1,Math.min(500,Number(limit)||120)));
    }
    return all.sort(byUpdate).slice(0,Math.max(1,Math.min(500,Number(limit)||120)));
  }
  function retryRequestForRunId(id){
    const native=runLedger.retryRequest(id);if(native)return native;
    if(String(id).startsWith('legacy-agent:')){const sourceId=String(id).slice('legacy-agent:'.length),run=agentRunStore().find(x=>x.id===sourceId);if(run&&['complete','error','completed','failed'].includes(String(run.status)))return {path:'/api/agents/run',body:{goal:run.goal,projectId:run.projectId||''}}}
    if(String(id).startsWith('legacy-automation:')){const sourceId=String(id).slice('legacy-automation:'.length),run=automationRunStore().find(x=>x.id===sourceId);if(run&&['complete','error','completed','failed'].includes(String(run.status)))return {path:'/api/automations/run',body:{id:run.automationId}}}
    return null;
  }
  // Work's Needs you filter: the same runs Home asks about (app/public/needs-you.js), one row per thread, newest first.
  function needsThreads(before){
    const seen=withSeen(seenRuns()),all=unifiedRunItems(500).map(seen),turns=new Map();
    for(const x of all){const k=x.threadId||x.id;turns.set(k,(turns.get(k)||0)+1)}
    const byCreate=(a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))||String(b.id).localeCompare(String(a.id));
    return needsYou.pick(all).map(x=>({...x,title:x.threadTitle||x.title,turns:turns.get(x.threadId||x.id)||1})).filter(x=>!before||byCreate(x,before)>0).sort(byCreate);
  }
  async function apiRuns(req,res,urlObj){
    try{const id=String(urlObj.searchParams.get('id')||'');const pid=String(urlObj.searchParams.get('projectId')||''),tid=String(urlObj.searchParams.get('threadId')||''),threads=urlObj.searchParams.get('threads')==='1';const kind=String(urlObj.searchParams.get('kind')||'');if(kind&&kind!=='all'&&kind!=='needs'&&!WORK_CHIPS.includes(kind))return json(res,400,{error:'Unknown kind'});const beforeId=String(urlObj.searchParams.get('before')||'');let before=null;if(beforeId){if(!cleanRunId(beforeId))return json(res,400,{error:'Invalid run id'});const ref=runLedger.get(beforeId)||legacyUnifiedRuns().find(x=>x.id===beforeId);if(!ref)return json(res,404,{error:'Run not found'});before={createdAt:ref.createdAt,id:ref.id}}const seen=withSeen(seenRuns());let items=kind==='needs'?needsThreads(before):unifiedRunItems(urlObj.searchParams.get('limit')||120,{projectId:pid,threadId:tid,threads,before,kind:threads&&kind!=='all'?kind:''}).map(seen);const pending=approvalStore().filter(a=>a.status==='pending'),changes=changeStore();const cardOpts={approvalFor:r=>r.meta?.changeId&&pending.find(a=>a.meta?.changeId===r.meta.changeId)||null,changeFor:cid=>changes.find(c=>c.id===cid)||null},mark=keptMarker();if(id){const item=items.find(x=>x.id===id)||runLedger.get(id)||(id.startsWith('legacy-')?legacyUnifiedRuns().find(x=>x.id===id):null);if(!item)return json(res,404,{error:'Run not found'});return json(res,200,{item:{...mark(seen(item)),card:runCard(item,cardOpts)}})}const status=String(urlObj.searchParams.get('status')||''),type=String(urlObj.searchParams.get('type')||'');if(status)items=items.filter(x=>x.status===status);if(type)items=items.filter(x=>x.type===type);items=items.map(x=>({...mark(x),card:runCard(x,cardOpts)}));json(res,200,{items,summary:{total:items.length,active:items.filter(x=>['queued','running','streaming','awaiting_approval'].includes(x.status)).length,failed:items.filter(x=>x.status==='failed').length,awaitingApproval:items.filter(x=>x.status==='awaiting_approval').length}})}catch(e){storageError(res,e,500)}
  }
  async function apiRunCancel(req,res){
    try{const b=await readBody(req),id=String(b.id||''),run=runLedger.get(id);if(!run)return json(res,404,{error:'Run not found or is managed by a legacy executor'});if(!run.cancellable)return json(res,409,{error:'This run is not cancellable'});if(!['queued','running','streaming','awaiting_approval'].includes(run.status))return json(res,409,{error:`Run cannot be cancelled from status ${run.status}`});runLedger.cancel(id,'Cancelled by user');const controller=activeRunControllers.get(id);if(controller&&!controller.signal.aborted)controller.abort();recordActivity('run','Run cancelled',run.title,{runId:id,type:run.type});json(res,200,{item:runLedger.get(id)})}catch(e){storageError(res,e,400)}
  }
  async function apiRunUpdate(req, res) {
    try {
      const b = await readBody(req), id = String(b.id || '');
      if (!cleanRunId(id) && !id.startsWith('legacy-')) return json(res, 400, { error: 'Invalid run id' });
      if (id.startsWith('legacy-')) return json(res, 409, { error: 'This run is managed by its own page and cannot be filed yet' });
      const patch = {};
      if (b.pinned !== undefined) { if (typeof b.pinned !== 'boolean') return json(res, 400, { error: 'pinned must be true or false' }); patch.pinned = b.pinned; }
      if (b.projectId !== undefined) {
        if (b.projectId !== null) {
          if (!cleanRunId(b.projectId)) return json(res, 400, { error: 'Invalid project id' });
          if (!projectStore().some(p => p.id === b.projectId)) return json(res, 404, { error: 'Project not found' });
        }
        patch.projectId = b.projectId;
      }
      const item = runLedger.get(id) && runLedger.file(id, patch);
      if (!item) return json(res, 404, { error: 'Run not found' });
      json(res, 200, { item });
    } catch (e) { storageError(res, e, 400); }
  }
  async function apiRunRetry(req, res) {
    try {
      const b = await readBody(req);
      const id = String(b.id || '');
      const replay = retryRequestForRunId(id);
      if (!replay) return json(res, 409, { error: 'This run does not support retry' });
      const allowed = new Set(['/api/chat','/api/images/generate','/api/agents/run','/api/automations/run']);
      if (!allowed.has(replay.path)) return json(res, 409, { error: 'Retry target is not allowed' });

      const parent = unifiedRunItems(500).find(x => x.id === id) || runLedger.get(id);
      const nextAttempt = Math.max(1, Number(parent?.attempt) || 1) + 1;
      const response = await fetchWithTimeout(`http://127.0.0.1:${listenPort()}${replay.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(replay.body || {})
      }, 900000);
      const raw = await response.text();
      let result;
      try { result = raw ? JSON.parse(raw) : {}; } catch { result = { text: raw.slice(0, 8000) }; }
      if (!response.ok) throw new Error(result.error || `Retry HTTP ${response.status}`);

      let newRunId = null;
      if (result?.runId) {
        const updated = runLedger.update(result.runId, { attempt: nextAttempt, retryOf: id }, `Retried from ${id}`);
        newRunId = updated?.id || result.runId;
      } else if (replay.path === '/api/agents/run' && result?.run?.id) {
        const runs = agentRunStore();
        const retry = runs.find(x => x.id === result.run.id);
        if (retry) {
          retry.attempt = nextAttempt;
          retry.retryOf = id;
          retry.updatedAt = retry.updatedAt || nowIso();
          saveStore(RUNS_STORE, runs, 300);
          newRunId = 'legacy-agent:' + retry.id;
        }
      } else if (replay.path === '/api/automations/run' && result?.run?.id) {
        const runs = automationRunStore();
        const retry = runs.find(x => x.id === result.run.id);
        if (retry) {
          retry.attempt = nextAttempt;
          retry.retryOf = id;
          saveStore(AUTOMATION_RUNS_STORE, runs, 500);
          newRunId = 'legacy-automation:' + retry.id;
        }
      }

      recordActivity('run', 'Run retried', id, { runId: id, newRunId, path: replay.path, attempt: nextAttempt });
      json(res, 200, { ok: true, replayedFrom: id, runId: newRunId, attempt: nextAttempt, result });
    } catch (e) {
      storageError(res, e, 500);
    }
  }
  return { apiRunCancel, apiRunRetry, apiRunUpdate, apiRuns, createChatExecution, needsThreads };
}

module.exports = { createRuns };
