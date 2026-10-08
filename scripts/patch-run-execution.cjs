'use strict';

const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'app', 'server.js');
const mobilePath = path.join(__dirname, '..', 'app', 'public', 'mobile-overhaul.js');
let source = fs.readFileSync(serverPath, 'utf8');
let mobile = fs.readFileSync(mobilePath, 'utf8');

function safeIdentifier(value) { return /^[A-Za-z_$][\w$]*$/.test(String(value || '')) ? String(value) : ''; }
function findFunctionRange(text, name) {
  const safe = safeIdentifier(name);
  if (!safe) throw new Error(`Invalid function name: ${name}`);
  const rx = new RegExp(`(?:async\\s+)?function\\s+${safe.replace(/[$]/g, '\\$&')}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const match = rx.exec(text);
  if (!match) throw new Error(`function ${safe} was not found`);
  const rest = text.slice(match.index + match[0].length);
  if (rx.test(rest)) throw new Error(`function ${safe} is not unique`);
  const open = text.indexOf('{', match.index);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (escaped) { escaped = false; continue; } if (c === '\\') { escaped = true; continue; } if (c === quote) quote = ''; continue; }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { start: match.index, end: i + 1 };
  }
  throw new Error(`function ${safe} has an unmatched body`);
}
function replacementSource(fn, targetName) { return fn.toString().replace(/^((?:async\s+)?function\s+)[A-Za-z_$][\w$]*/, `$1${targetName}`); }
function replaceFunction(name, fn) {
  const range = findFunctionRange(source, name);
  source = source.slice(0, range.start) + replacementSource(fn, name) + source.slice(range.end);
}
function insertAfterFunction(name, content) {
  const range = findFunctionRange(source, name);
  source = source.slice(0, range.end) + '\n' + content + source.slice(range.end);
}
function insertUnique(text, anchor, content, label) {
  const first = text.indexOf(anchor);
  const second = text.indexOf(anchor, first + anchor.length);
  if (first < 0 || second >= 0) throw new Error(`${label} anchor is missing or ambiguous`);
  return text.slice(0, first + anchor.length) + content + text.slice(first + anchor.length);
}

async function replacementApiChat(req, res) {
  let execution = null;
  try {
    const body = await readBody(req);
    execution = createChatExecution(body, false);
    runLedger.start(execution.id, body.webSearch === true ? 'Research run started' : 'Chat run started');
    const prep = await prepareChat(body);
    const started = Date.now();

    const r = await fetchWithTimeout(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: prep.model,
        messages: [systemPrompt(prep.researchContext, prep.capabilityContext), ...prep.messages],
        stream: false,
        options: { num_ctx: 32768 }
      })
    }, CHAT_MODEL_TIMEOUT_MS);

    const raw = await r.text();
    if (!r.ok) throw new Error(`Intelligence service HTTP ${r.status}: ${raw.slice(0, 500)}`);
    const j = JSON.parse(raw);
    const content = j?.message?.content || '';
    const elapsedMs = Date.now() - started;
    const lastUser = [...prep.messages].reverse().find(m => m.role === 'user');

    recordActivity(
      body.webSearch === true ? 'research' : 'chat',
      body.webSearch === true ? 'Researched with AI' : 'Asked AI',
      (lastUser?.content || '').slice(0, 180),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id }
    );
    const artifact = recordArtifact(
      body.webSearch === true ? 'research' : 'conversation',
      lastUser?.content || (body.webSearch === true ? 'Research' : 'Conversation'),
      content.slice(0, 420),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id },
      { prompt: lastUser?.content || '', response: content.slice(0, 40000), sources: prep.sources }
    );
    runLedger.complete(execution.id, {
      summary: content.slice(0, 420),
      output: { text: content.slice(0, 40000), model: prep.model, elapsedMs, sources: prep.sources },
      artifactIds: artifact?.id ? [artifact.id] : [],
      meta: { model: prep.model, elapsedMs, sources: prep.sources.length }
    });

    json(res, 200, {
      message: { role: 'assistant', content },
      model: prep.model,
      elapsedMs,
      sources: prep.sources,
      runId: execution.id
    });
  } catch (e) {
    if (execution) runLedger.fail(execution.id, e);
    storageError(res,e,500);
  }
}

async function replacementApiChatStream(req, res) {
  let execution = null;
  let controller = null;
  try {
    const body = await readBody(req);
    execution = createChatExecution(body, true);
    runLedger.start(execution.id, body.webSearch === true ? 'Research run started' : 'Chat run started');
    const prep = await prepareChat(body);
    const started = Date.now();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('meta', { model: prep.model, sources: prep.sources, runId: execution.id });

    controller = new AbortController();
    activeRunControllers.set(execution.id, controller);
    res.on('close', () => {
      if (!res.writableEnded) {
        runLedger.cancel(execution.id, 'Client disconnected');
        controller.abort();
      }
    });

    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: prep.model,
        messages: [systemPrompt(prep.researchContext, prep.capabilityContext), ...prep.messages],
        stream: true,
        options: { num_ctx: 32768 }
      })
    });

    if (!upstream.ok || !upstream.body) {
      const raw = await upstream.text();
      throw new Error(`Intelligence service HTTP ${upstream.status}: ${raw.slice(0, 500)}`);
    }

    runLedger.stream(execution.id, 'Streaming model output');
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let item;
        try { item = JSON.parse(line); } catch { continue; }
        const chunk = item?.message?.content || '';
        if (chunk) {
          full += chunk;
          send('token', { text: chunk });
        }
      }
    }

    const elapsedMs = Date.now() - started;
    const lastUser = [...prep.messages].reverse().find(m => m.role === 'user');
    recordActivity(
      body.webSearch === true ? 'research' : 'chat',
      body.webSearch === true ? 'Researched with AI' : 'Asked AI',
      (lastUser?.content || '').slice(0, 180),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id }
    );
    const artifact = recordArtifact(
      body.webSearch === true ? 'research' : 'conversation',
      lastUser?.content || (body.webSearch === true ? 'Research' : 'Conversation'),
      full.slice(0, 420),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id },
      { prompt: lastUser?.content || '', response: full.slice(0, 40000), sources: prep.sources }
    );
    runLedger.complete(execution.id, {
      summary: full.slice(0, 420),
      output: { text: full.slice(0, 40000), model: prep.model, elapsedMs, sources: prep.sources },
      artifactIds: artifact?.id ? [artifact.id] : [],
      meta: { model: prep.model, elapsedMs, sources: prep.sources.length }
    });

    send('done', { elapsedMs, model: prep.model, sources: prep.sources, runId: execution.id });
    res.end();
  } catch (e) {
    const current = execution ? runLedger.get(execution.id) : null;
    if (execution && current?.status !== 'cancelled') runLedger.fail(execution.id, e);
    if (!res.headersSent) {
      storageError(res,e,500);
    } else {
      try {
        const cancelled = execution && runLedger.get(execution.id)?.status === 'cancelled';
        res.write(`event: ${cancelled ? 'cancelled' : 'error'}\ndata: ${JSON.stringify(cancelled ? { runId: execution.id } : { error: String(e.message || e), runId: execution?.id || null })}\n\n`);
        res.end();
      } catch {}
    }
  } finally {
    if (execution) activeRunControllers.delete(execution.id);
  }
}

async function replacementApiGenerateImage(req, res) {
  let execution = null;
  try {
    const body = await readBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json(res, 400, { error: 'prompt is required' });

    const catalog = buildImageModelCatalog(await getCheckpointNames());
    if (!catalog.models.length) throw new Error('No image checkpoints were found');

    let selected = catalog.models.find(x => x.checkpoint === body.checkpoint);
    if (!selected && body.family) selected = catalog.models.find(x => x.family === String(body.family) && x.supported);
    if (!selected) selected = catalog.models.find(x => x.supported) || catalog.models[0];
    if (!selected) throw new Error('No image checkpoints were found');
    if (!selected.supported) throw new Error(selected.reason || `The selected ${selected.familyLabel} model requires a different workflow graph.`);

    const checkpoint = selected.checkpoint;
    const negativePrompt = String(body.negativePrompt || 'blurry, low quality, distorted, text, watermark');
    const width = multipleOf64(body.width, 512);
    const height = multipleOf64(body.height, 512);
    const steps = clampInt(body.steps, 1, 60, 24);
    const cfg = Math.max(1, Math.min(20, Number(body.cfg) || 7));
    const seed = Number.isFinite(Number(body.seed)) ? Math.floor(Number(body.seed)) : Math.floor(Math.random() * 2147483647);

    execution = runLedger.create({
      type: 'image',
      title: titleFromText(prompt, 'Image generation'),
      input: { prompt: prompt.slice(0, 2000), checkpoint, family: selected.family, width, height, steps, cfg },
      retryRequest: { path: '/api/images/generate', body: { prompt, negativePrompt, width, height, steps, cfg, seed, checkpoint, family: selected.family } }
    });
    runLedger.start(execution.id, 'Image generation started');

    const workflow = comfyWorkflow({ prompt, negativePrompt, width, height, steps, cfg, seed, checkpoint });
    const started = Date.now();
    const queued = await fetchWithTimeout(`${COMFY_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'local-ai-appliance' })
    }, 10000);

    const qraw = await queued.text();
    if (!queued.ok) throw new Error(`Image queue HTTP ${queued.status}: ${qraw.slice(0, 500)}`);
    const q = JSON.parse(qraw);
    if (!q.prompt_id) throw new Error('Image service did not return a prompt ID');

    runLedger.update(execution.id, { progress: 35, meta: { promptId: q.prompt_id, checkpoint } }, 'Image queued in ComfyUI');
    const history = await pollComfyHistory(q.prompt_id);
    const outputs = history.outputs || {};
    const image = outputs?.["7"]?.images?.[0] || Object.values(outputs).flatMap(x => Array.isArray(x?.images) ? x.images : [])[0];
    if (!image) throw new Error('Image generation completed without an output image');

    const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' });
    const imageUrl = `/api/images/view?${params.toString()}`;
    const elapsedMs = Date.now() - started;

    recordActivity('image', 'Created an image', prompt.slice(0, 180), { imageUrl, checkpoint, family: selected.family, seed, width, height, elapsedMs, runId: execution.id });
    const artifact = recordArtifact(
      'image', prompt, `${width} × ${height} generated image`,
      { imageUrl, checkpoint, family: selected.family, seed, width, height, elapsedMs, runId: execution.id },
      { prompt, negativePrompt, imageUrl }
    );
    runLedger.complete(execution.id, {
      summary: `${width} × ${height} image created with ${checkpoint}`,
      output: { imageUrl, checkpoint, family: selected.family, seed, width, height, elapsedMs },
      artifactIds: artifact?.id ? [artifact.id] : [],
      meta: { promptId: q.prompt_id, checkpoint, elapsedMs }
    });

    json(res, 200, { promptId: q.prompt_id, checkpoint, family: selected.family, familyLabel: selected.familyLabel, seed, width, height, elapsedMs, imageUrl, runId: execution.id });
  } catch (e) {
    if (execution) runLedger.fail(execution.id, e);
    storageError(res,e,500);
  }
}

const RUN_HELPERS = String.raw`
function lastUserRunMessage(body){
  const messages=sanitizeMessages(body?.messages);return [...messages].reverse().find(m=>m.role==='user')?.content||'';
}
function createChatExecution(body,streaming){
  const messages=sanitizeMessages(body?.messages);const prompt=[...messages].reverse().find(m=>m.role==='user')?.content||'Chat';
  const model=typeof body?.model==='string'&&body.model.trim()?body.model.trim():MODEL;
  const retryBody={messages,model,webSearch:body?.webSearch===true};
  return runLedger.create({type:body?.webSearch===true?'research':'chat',title:titleFromText(prompt,body?.webSearch===true?'Research':'Chat'),input:{prompt:prompt.slice(0,4000),model,webSearch:body?.webSearch===true,messageCount:messages.length},cancellable:streaming===true,retryRequest:{path:'/api/chat',body:retryBody},meta:{streaming:streaming===true}});
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
function legacyUnifiedRuns(){
  const items=[];
  for(const run of agentRunStore().slice(0,200)){const status=normalizedExecutionStatus(run.status);items.push({id:'legacy-agent:'+run.id,type:'agent',title:titleFromText(run.goal,'Agent run'),status,progress:executionProgress(status,run.plan),createdAt:run.createdAt||null,startedAt:run.createdAt||null,updatedAt:run.updatedAt||run.createdAt||null,finishedAt:['completed','failed','cancelled'].includes(status)?(run.updatedAt||null):null,summary:String(run.answer||run.error||'').slice(0,1200),input:{goal:String(run.goal||'').slice(0,4000),projectId:run.projectId||''},output:run.answer||null,error:run.error||null,artifactIds:[],source:{kind:'agent',id:run.id},meta:{sources:Array.isArray(run.sources)?run.sources.length:0},cancellable:false,retryable:['completed','failed'].includes(status),attempt:1,retryOf:null,events:legacyEvents(run)})}
  for(const run of automationRunStore().slice(0,200)){const status=normalizedExecutionStatus(run.status);items.push({id:'legacy-automation:'+run.id,type:'automation',title:titleFromText(run.name,'Automation run'),status,progress:executionProgress(status),createdAt:run.startedAt||null,startedAt:run.startedAt||null,updatedAt:run.finishedAt||run.startedAt||null,finishedAt:['completed','failed','cancelled'].includes(status)?(run.finishedAt||null):null,summary:String(run.output||run.error||'').slice(0,1200),input:{automationId:run.automationId||''},output:run.output||null,error:run.error||null,artifactIds:[],source:{kind:'automation',id:run.id},meta:{automationId:run.automationId||''},cancellable:false,retryable:['completed','failed'].includes(status),attempt:1,retryOf:null,events:legacyEvents(run)})}
  for(const run of effectiveEngineeringRuns().slice(0,200)){const status=normalizedExecutionStatus(run.status);items.push({id:'legacy-engineering:'+run.id,type:'engineering',title:titleFromText(run.request,'Engineering run'),status,progress:executionProgress(status,run.steps),createdAt:run.createdAt||null,startedAt:run.createdAt||null,updatedAt:run.updatedAt||run.createdAt||null,finishedAt:['completed','failed','cancelled'].includes(status)?(run.updatedAt||null):null,summary:String(run.error||run.changeStatus||'').slice(0,1200),input:{request:String(run.request||'').slice(0,4000),target:run.target||'',root:run.root||''},output:run.finalChangeId?{changeId:run.finalChangeId,changeStatus:run.changeStatus||null}:null,error:run.error||null,artifactIds:[],source:{kind:'engineering',id:run.id},meta:{attempt:run.attempt||0,maxAttempts:run.maxAttempts||0,changeId:run.finalChangeId||null},cancellable:false,retryable:false,attempt:run.attempt||1,retryOf:null,events:legacyEvents(run)})}
  return items;
}
function unifiedRunItems(limit=120){
  const native=runLedger.list({limit:500});const legacy=legacyUnifiedRuns();
  return [...native,...legacy].sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||''))).slice(0,Math.max(1,Math.min(500,Number(limit)||120)));
}
function retryRequestForRunId(id){
  const native=runLedger.retryRequest(id);if(native)return native;
  if(String(id).startsWith('legacy-agent:')){const sourceId=String(id).slice('legacy-agent:'.length),run=agentRunStore().find(x=>x.id===sourceId);if(run&&['complete','error','completed','failed'].includes(String(run.status)))return {path:'/api/agents/run',body:{goal:run.goal,projectId:run.projectId||''}}}
  if(String(id).startsWith('legacy-automation:')){const sourceId=String(id).slice('legacy-automation:'.length),run=automationRunStore().find(x=>x.id===sourceId);if(run&&['complete','error','completed','failed'].includes(String(run.status)))return {path:'/api/automations/run',body:{id:run.automationId}}}
  return null;
}
async function apiRuns(req,res,urlObj){
  try{const id=String(urlObj.searchParams.get('id')||'');let items=unifiedRunItems(urlObj.searchParams.get('limit')||120);if(id){const item=items.find(x=>x.id===id)||runLedger.get(id);if(!item)return json(res,404,{error:'Run not found'});return json(res,200,{item})}const status=String(urlObj.searchParams.get('status')||''),type=String(urlObj.searchParams.get('type')||'');if(status)items=items.filter(x=>x.status===status);if(type)items=items.filter(x=>x.type===type);json(res,200,{items,summary:{total:items.length,active:items.filter(x=>['queued','running','streaming','awaiting_approval'].includes(x.status)).length,failed:items.filter(x=>x.status==='failed').length,awaitingApproval:items.filter(x=>x.status==='awaiting_approval').length}})}catch(e){storageError(res,e,500)}
}
async function apiRunCancel(req,res){
  try{const b=await readBody(req),id=String(b.id||''),run=runLedger.get(id);if(!run)return json(res,404,{error:'Run not found or is managed by a legacy executor'});if(!run.cancellable)return json(res,409,{error:'This run is not cancellable'});if(!['queued','running','streaming','awaiting_approval'].includes(run.status))return json(res,409,{error:`Run cannot be cancelled from status ${run.status}`});runLedger.cancel(id,'Cancelled by user');const controller=activeRunControllers.get(id);if(controller&&!controller.signal.aborted)controller.abort();recordActivity('run','Run cancelled',run.title,{runId:id,type:run.type});json(res,200,{item:runLedger.get(id)})}catch(e){storageError(res,e,400)}
}
async function apiRunRetry(req,res){
  try{const b=await readBody(req),id=String(b.id||''),replay=retryRequestForRunId(id);if(!replay)return json(res,409,{error:'This run does not support retry'});const allowed=new Set(['/api/chat','/api/images/generate','/api/agents/run','/api/automations/run']);if(!allowed.has(replay.path))return json(res,409,{error:'Retry target is not allowed'});const response=await fetchWithTimeout(`http://127.0.0.1:${PORT}${replay.path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(replay.body||{})},900000);const raw=await response.text();let result;try{result=raw?JSON.parse(raw):{}}catch{result={text:raw.slice(0,8000)}}if(!response.ok)throw new Error(result.error||`Retry HTTP ${response.status}`);recordActivity('run','Run retried',id,{runId:id,path:replay.path});json(res,200,{ok:true,replayedFrom:id,result})}catch(e){storageError(res,e,500)}
}
`;

const storageRequire = "const { Storage } = require('./storage');";
const ledgerRequire = "const { RunLedger } = require('./run-ledger');";
if (!source.includes(ledgerRequire)) source = insertUnique(source, storageRequire, `\n${ledgerRequire}`, 'storage require');
const storageInit = "const storage = new Storage({ dataDir: DATA_DIR });";
const ledgerInit = "\nconst runLedger = new RunLedger({ storage });\nconst activeRunControllers = new Map();";
if (!source.includes('const runLedger = new RunLedger')) source = insertUnique(source, storageInit, ledgerInit, 'storage initialization');

if (!source.includes('function createChatExecution(')) insertAfterFunction('makeId', RUN_HELPERS.trim());
replaceFunction('apiChat', replacementApiChat);
replaceFunction('apiChatStream', replacementApiChatStream);
replaceFunction('apiGenerateImage', replacementApiGenerateImage);

const routeAnchor = "    if (req.method === 'GET' && p === '/api/brief') return await apiMorningBrief(req,res);";
const runRoutes = "\n    if (req.method === 'GET' && p === '/api/runs') return await apiRuns(req,res,urlObj);\n    if (req.method === 'POST' && p === '/api/runs/cancel') return await apiRunCancel(req,res);\n    if (req.method === 'POST' && p === '/api/runs/retry') return await apiRunRetry(req,res);";
if (!source.includes("p === '/api/runs'")) source = insertUnique(source, routeAnchor, runRoutes, 'run route');

if (!source.includes("require('./run-ledger')") || !source.includes("'/api/runs/cancel'")) throw new Error('Unified run server integration is incomplete');

if (!mobile.includes("src = '/execution-runtime.js'")) {
  const insertion = String.raw`

  function loadExecutionRuntime() {
    if (document.querySelector('script[data-localai-execution-runtime]')) return;
    const script = document.createElement('script');
    script.src = '/execution-runtime.js';
    script.defer = true;
    script.dataset.localaiExecutionRuntime = 'true';
    document.head.appendChild(script);
  }`;
  const integrationRange = (() => {
    const text = mobile;
    const name = 'loadIntegrationEnhancement';
    const safe = safeIdentifier(name);
    const rx = new RegExp(`function\\s+${safe}\\s*\\([^)]*\\)\\s*\\{`, 'm');
    const match = rx.exec(text); if (!match) throw new Error('mobile integration loader not found');
    const open = text.indexOf('{', match.index); let depth = 0, quote = '', esc = false;
    for (let i = open; i < text.length; i++) { const c = text[i]; if (quote) { if (esc) { esc = false; continue; } if (c === '\\') { esc = true; continue; } if (c === quote) quote = ''; continue; } if (c === '"' || c === "'" || c === '`') { quote = c; continue; } if (c === '{') depth++; else if (c === '}' && --depth === 0) return { end: i + 1 }; }
    throw new Error('mobile integration loader unmatched');
  })();
  mobile = mobile.slice(0, integrationRange.end) + insertion + mobile.slice(integrationRange.end);
}
const initAnchor = '    loadIntegrationEnhancement();';
if (!mobile.includes('    loadExecutionRuntime();')) mobile = insertUnique(mobile, initAnchor, '\n    loadExecutionRuntime();', 'mobile init');

fs.writeFileSync(serverPath, source, 'utf8');
fs.writeFileSync(mobilePath, mobile, 'utf8');
console.log('Applied guarded unified run integration');
