'use strict';

// Changing Local AI itself: change requests (plan, stage in a copy, validate, approve, ship as a PR), engineering runs, Improve (Backlog to Shipped) and the Claude board. One module because these call each other.
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
const { cloudSafePath, secretish } = require('../model-coordinator');
// Claude session records. A session with no event for the live window has stopped reporting: the live row drops it
// then (claudeLive), and the board reports it idle rather than the "active" it last sent. Sessions are pruned to the
// newest 200 by updatedAt: about two weeks of the owner's sessions, and more than the 3000-event log can still show
// activity for. A session an open finding names (Improve shows its state) is never pruned.
const CLAUDE_LIVE_WINDOW_MS=30*60*1000,CLAUDE_MAX_SESSIONS=200;
const CLAUDE_CLOSED_FINDING=new Set(['fixed','rejected']);
// Improve matches a finding to a session by id or by `cc-` plus its first 8 characters; hold both.
function claudeOpenSessionIds(findings){
  const ids=new Set();
  for(const f of findings||[]){if(!f?.sessionId||CLAUDE_CLOSED_FINDING.has(f.status))continue;const id=String(f.sessionId);ids.add(id);ids.add('cc-'+id.slice(0,8))}
  return ids;
}
// Pure. Newest first by updatedAt; keeps `cap` plus any open-finding session, drops the rest.
function claudeKeptSessions(sessions,findings,cap=CLAUDE_MAX_SESSIONS){
  const open=claudeOpenSessionIds(findings),keep=[],drop=[];
  const sorted=[...(sessions||[])].sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
  sorted.forEach((s,i)=>(i<cap||open.has(s.id)?keep:drop).push(s));
  return {keep,drop};
}
// Pure. A session stored "active" whose last event (updatedAt for records from before lastEventAt) is older than the
// live window, or unreadable, is reported idle and marked stale; other statuses are left as the session sent them.
function claudeSessionView(s,now){
  if(s?.status!=='active')return s;
  const t=Date.parse(s.lastEventAt||s.updatedAt||'');
  return Number.isFinite(t)&&now-t<CLAUDE_LIVE_WINDOW_MS?s:{...s,status:'idle',stale:true};
}
function createChanges(ctx) {
  const { APPROVALS_STORE, APP_VERSION, DATA_DIR, ENGINEERING_MODEL_TIMEOUT_MS, SELF_APP_ROOT, addNotification, approvalStore, childEnv, coordinator, MODEL, fetchWithTimeout, fs, improve, issueStore, json, makeId, notifier, nowIso, objectStore, path, plainText, readBody, recordActivity, release, requireFeature, runEngineeringPlannerModel, safeWorkspacePath, sameOriginJson, saveIssues, saveStore, simpleDiff, spawn, storage, storageError, workspaceRel } = ctx;
  // ===== END PRODUCT EVOLUTION PLATFORM ======================================




  // ===== CHANGE INTELLIGENCE / SELF-DEVELOPMENT (v1.13+) ======================
  const CHANGES_STORE = 'changes';
  const CHANGE_STAGE_ROOT = path.join(DATA_DIR, 'change-staging');
  function changeStore(){ return objectStore(CHANGES_STORE); }
  function saveChanges(items){ saveStore(CHANGES_STORE, items, 300); if (typeof runImproveReconcile === 'function') runImproveReconcile(); }
  function publicChange(item){
    if(!item) return null;
    const copy={...item};
    delete copy.stageRoot;
    return copy;
  }
  function cleanRelPath(value){
    const rel=String(value||'').replace(/\\/g,'/').replace(/^\/+/, '');
    const normalized=path.posix.normalize(rel);
    if(!rel || normalized==='.' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('Invalid relative path');
    return normalized;
  }
  function ensureInside(base,rel){
    const root=path.resolve(base); const full=path.resolve(root,cleanRelPath(rel));
    if(full===root || !full.startsWith(root+path.sep)) throw new Error('Path escapes change target');
    return full;
  }
  function copyTree(src,dst){
    fs.statSync(src); fs.mkdirSync(dst,{recursive:true}); // statSync: a missing src throws before dst is created
    for(const e of fs.readdirSync(src,{withFileTypes:true})){
      if(['node_modules','.git','.venv','bin','obj'].includes(e.name)) continue;
      const a=path.join(src,e.name), b=path.join(dst,e.name);
      if(e.isDirectory()) copyTree(a,b); else if(e.isFile()){fs.mkdirSync(path.dirname(b),{recursive:true});fs.copyFileSync(a,b)}
    }
  }
  function candidateTextFiles(rootDir,request){
    const words=[...new Set(String(request||'').toLowerCase().match(/[a-z0-9_.-]{3,}/g)||[])].slice(0,24);
    const exts=new Set(['.js','.mjs','.cjs','.html','.css','.json','.md','.txt','.ps1','.cs','.csproj','.py','.ts','.tsx','.jsx','.yml','.yaml']);
    // Score at most 600 files / 40 MB without keeping their text; only the top 10 are read again for context.
    const found=[];let scannedBytes=0;
    const full=()=>found.length>=600||scannedBytes>=40*1024*1024;
    function walk(dir,depth){
      if(depth>5 || full()) return;
      let entries=[]; try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{return}
      for(const e of entries){
        if(full()) return;
        if(['node_modules','.git','.venv','bin','obj','dist','build','.next'].includes(e.name)) continue;
        const file=path.join(dir,e.name);
        if(e.isDirectory()){walk(file,depth+1);continue}
        if(!e.isFile() || !exts.has(path.extname(e.name).toLowerCase())) continue;
        let st; try{st=fs.statSync(file)}catch{continue}; if(st.size>900000) continue;
        let txt=''; try{txt=fs.readFileSync(file,'utf8')}catch{continue}
        scannedBytes+=st.size;
        const low=txt.toLowerCase(), name=e.name.toLowerCase(); let score=0;
        for(const w of words){if(name.includes(w))score+=8;const idx=low.indexOf(w);if(idx>=0)score+=2}
        if(/server\.js|app\.js|index\.html|readme|package\.json/i.test(e.name)) score+=2;
        found.push({full:file,rel:path.relative(rootDir,file).replace(/\\/g,'/'),score,size:st.size});
      }
    }
    walk(rootDir,0); found.sort((a,b)=>b.score-a.score||a.size-b.size);
    return found.slice(0,10).flatMap(f=>{try{return [{...f,txt:fs.readFileSync(f.full,'utf8')}]}catch{return []}});
  }
  function excerptForRequest(txt,request,max=9000){
    const words=[...new Set(String(request||'').toLowerCase().match(/[a-z0-9_.-]{3,}/g)||[])]; const low=txt.toLowerCase();
    let idx=-1; for(const w of words){idx=low.indexOf(w);if(idx>=0)break}
    if(idx<0) return txt.slice(0,max);
    const start=Math.max(0,idx-Math.floor(max/3)); return txt.slice(start,start+max);
  }
  function changeContextFiles(rootDir,request){
    return candidateTextFiles(rootDir,request).map(f=>({rel:f.rel,text:`FILE: ${f.rel}\n---\n${excerptForRequest(f.txt,request)}\n---`}));
  }
  const joinContext=files=>files.map(f=>f.text).join('\n\n').slice(0,70000);
  function extractJsonObject(raw){
    const text=String(raw||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'');
    try{return JSON.parse(text)}catch{}
    const a=text.indexOf('{'), z=text.lastIndexOf('}'); if(a>=0&&z>a){try{return JSON.parse(text.slice(a,z+1))}catch{}}
    throw new Error('The model did not return valid patch JSON');
  }
  function safeIdentifier(value){return /^[A-Za-z_$][\w$]*$/.test(String(value||''))?String(value):''}
  function normalizePatchPlan(plan){
    const files=Array.isArray(plan?.files)?plan.files.slice(0,10):[]; const out=[];
    for(const f of files){
      let rel; try{rel=cleanRelPath(f.path)}catch{continue}
      const ops=[]; for(const op of (Array.isArray(f.operations)?f.operations.slice(0,30):[])){
        const type=String(op.type||'replace');
        if(type==='replace' && typeof op.find==='string' && typeof op.replace==='string' && op.find.length>0 && op.find.length<=12000 && op.replace.length<=120000) ops.push({type,find:op.find,replace:op.replace});
        else if(type==='replace_function' && safeIdentifier(op.name) && typeof op.content==='string' && op.content.length<=160000) ops.push({type,name:op.name,content:op.content});
        else if(type==='insert_after_function' && safeIdentifier(op.name) && typeof op.content==='string' && op.content.length<=120000) ops.push({type,name:op.name,content:op.content});
        else if(type==='insert_after_text' && typeof op.anchor==='string' && op.anchor.length>0 && op.anchor.length<=8000 && typeof op.content==='string' && op.content.length<=120000) ops.push({type,anchor:op.anchor,content:op.content});
        else if(type==='replace_between_markers' && typeof op.startMarker==='string' && typeof op.endMarker==='string' && op.startMarker.length && op.endMarker.length && typeof op.content==='string') ops.push({type,startMarker:op.startMarker,endMarker:op.endMarker,content:op.content.slice(0,160000)});
        else if(type==='replace_regex' && typeof op.pattern==='string' && op.pattern.length>0 && op.pattern.length<=5000 && typeof op.replacement==='string' && op.replacement.length<=120000) ops.push({type,pattern:op.pattern,flags:String(op.flags||'m').replace(/[^ims]/g,''),replacement:op.replacement});
        else if(type==='append' && typeof op.content==='string' && op.content.length<=100000) ops.push({type,content:op.content});
        else if(type==='create' && typeof op.content==='string' && op.content.length<=240000) ops.push({type,content:op.content});
      }
      if(ops.length) out.push({path:rel,operations:ops});
    }
    return {summary:String(plan?.summary||'Proposed change').slice(0,1200),notes:String(plan?.notes||'').slice(0,5000),files:out};
  }
  // The model coordinator (app/model-coordinator.js): Change requests plan as kind `plan`, engineering runs (code) as
  // `code`. Only Local AI's own code may go to a cloud model, without files whose names say they hold a secret, redacted,
  // and only when nothing in it looks personal and the request isn't about Local AI's keys, passwords or setup. Only a
  // request the owner typed may go out: callers whose request carries anything else (a health check's issue detail,
  // an Improve item Local AI or Claude wrote, a retry carrying error output) pass `stay`, a reason it stays here. Cloud
  // off, private, or a cloud failure or unreadable plan: this PC's planner, as before. The plan says where it ran (route).
  async function generatePatchPlan(request,targetRoot,{kind='plan',stay=''}={}){
    const files=changeContextFiles(targetRoot,request),context=joinContext(files);
    const system=`You are the Patch Intelligence planner inside Local AI. Return JSON only. You may modify only files shown in context. Produce minimal, source-aware patches. For JavaScript named functions, strongly prefer replace_function or insert_after_function instead of replacing large exact strings. Use exact replace only for small unique snippets copied verbatim from context. Never append executable statements outside a valid function merely to satisfy a request. Never invent shell commands. Never add fake validation code, hard-coded PASS values, or validators that simply return true; the existing staging validator is the source of truth. Keep browser-only APIs (document, window, localStorage, client state) out of server.js. Keep Node-only APIs (fs, process.env, require) out of public/app.js. Do not bypass approval, staging, backups, rollback, or the self-update host. Schema: {"summary":"...","notes":"...","files":[{"path":"relative/path","operations":[{"type":"replace_function","name":"functionName","content":"complete function declaration"},{"type":"insert_after_function","name":"functionName","content":"new declaration(s)"},{"type":"insert_after_text","anchor":"EXACT small anchor","content":"text"},{"type":"replace_between_markers","startMarker":"...","endMarker":"...","content":"replacement between markers"},{"type":"replace_regex","pattern":"...","flags":"m","replacement":"literal replacement"},{"type":"replace","find":"EXACT existing text","replace":"replacement text"},{"type":"create","content":"full new file"}]}]}. If context is insufficient, return files:[] and explain why.`;
    const self=path.resolve(String(targetRoot||''))===path.resolve(SELF_APP_ROOT),cloudFiles=files.filter(f=>cloudSafePath(f.rel)&&!/^repo-context\/host\//.test(f.rel)),cloudContext=joinContext(cloudFiles);
    const route=coordinator.route({kind,text:`${request}\n${cloudContext}`,stay:!self?'Your workspace files stay on this PC':stay?String(stay):secretish(request)?"Local AI's own keys, passwords and setup stay on this PC":''});
    const cloud=await coordinator.run(route,[{role:'system',content:system},{role:'user',content:`CHANGE REQUEST:\n${request}\n\nAVAILABLE SOURCE CONTEXT:\n${cloudContext}`}],{kind,maxTokens:8000});
    // A cloud plan may only touch files it was shown (the host's notes under repo-context/host/ are never shown).
    if(cloud){const shown=new Set(cloudFiles.map(f=>f.rel));let plan=null;try{plan=normalizePatchPlan(extractJsonObject(cloud.content))}catch{}
      if(plan&&plan.files.every(f=>shown.has(f.path)))return {...plan,route:cloud.used};
      recordActivity('model',plan?'Cloud plan touched files it was not shown':'Cloud plan unreadable','Planning on this PC instead.',{provider:cloud.used.provider,model:cloud.used.model,kind})}
    const raw=await runEngineeringPlannerModel(`CHANGE REQUEST:\n${request}\n\nAVAILABLE SOURCE CONTEXT:\n${context}`,system,ENGINEERING_MODEL_TIMEOUT_MS);
    return {...normalizePatchPlan(extractJsonObject(raw)),route:coordinator.local(route,MODEL)};
  }
  function findFunctionRange(textValue,name){
    const safe=safeIdentifier(name); if(!safe) throw new Error(`Invalid function name: ${name}`);
    const rx=new RegExp(`(?:async\\s+)?function\\s+${safe.replace(/[$]/g,'\\$&')}\\s*\\([^)]*\\)\\s*\\{`,'m');
    const m=rx.exec(textValue); if(!m) throw new Error(`function ${safe} was not found`);
    const open=textValue.indexOf('{',m.index); let depth=0,quote='',esc=false,lineComment=false,blockComment=false;
    for(let i=open;i<textValue.length;i++){
      const c=textValue[i],n=textValue[i+1];
      if(lineComment){if(c==='\n')lineComment=false;continue}
      if(blockComment){if(c==='*'&&n==='/'){blockComment=false;i++}continue}
      if(quote){if(esc){esc=false;continue}if(c==='\\'){esc=true;continue}if(c===quote){quote='';continue}continue}
      if(c==='/'&&n==='/'){lineComment=true;i++;continue}
      if(c==='/'&&n==='*'){blockComment=true;i++;continue}
      if(c==='"'||c==="'"||c==='`'){quote=c;continue}
      if(c==='{')depth++; else if(c==='}'){depth--;if(depth===0)return {start:m.index,end:i+1}}
    }
    throw new Error(`function ${safe} has an unmatched body`);
  }
  function uniqueIndex(textValue,needle,label){
    const first=textValue.indexOf(needle); if(first<0) throw new Error(`${label} was not found`);
    const second=textValue.indexOf(needle,first+needle.length); if(second>=0) throw new Error(`${label} is not unique`);
    return first;
  }
  function applyOpsToText(before,ops,rel){
    let textValue=before;
    for(const op of ops){
      if(op.type==='replace'){
        const first=uniqueIndex(textValue,op.find,`${rel}: replacement source text`);
        textValue=textValue.slice(0,first)+op.replace+textValue.slice(first+op.find.length);
      } else if(op.type==='replace_function'){
        const r=findFunctionRange(textValue,op.name); textValue=textValue.slice(0,r.start)+op.content+textValue.slice(r.end);
      } else if(op.type==='insert_after_function'){
        const r=findFunctionRange(textValue,op.name); textValue=textValue.slice(0,r.end)+'\n'+op.content+textValue.slice(r.end);
      } else if(op.type==='insert_after_text'){
        const i=uniqueIndex(textValue,op.anchor,`${rel}: insertion anchor`);const pos=i+op.anchor.length;textValue=textValue.slice(0,pos)+op.content+textValue.slice(pos);
      } else if(op.type==='replace_between_markers'){
        const a=uniqueIndex(textValue,op.startMarker,`${rel}: start marker`);const from=a+op.startMarker.length;const b=textValue.indexOf(op.endMarker,from);if(b<0)throw new Error(`${rel}: end marker was not found`);if(textValue.indexOf(op.endMarker,b+op.endMarker.length)>=0 && textValue.indexOf(op.startMarker,a+op.startMarker.length)>=0)throw new Error(`${rel}: marker pair is ambiguous`);textValue=textValue.slice(0,from)+op.content+textValue.slice(b);
      } else if(op.type==='replace_regex'){
        let rx;try{rx=new RegExp(op.pattern,op.flags||'m')}catch(e){throw new Error(`${rel}: invalid replacement regex: ${e.message}`)}
        const g=new RegExp(op.pattern,[...new Set(`${op.flags||'m'}g`.split(''))].join(''));const matches=[...textValue.matchAll(g)];if(matches.length!==1)throw new Error(`${rel}: replacement regex matched ${matches.length} locations; expected 1`);textValue=textValue.replace(rx,()=>op.replacement);
      } else if(op.type==='append') textValue += op.content;
      else if(op.type==='create') textValue=op.content;
    }
    return textValue;
  }
  function duplicateTopLevelFunctions(textValue){
    const rx=/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm, seen=new Set(), dup=new Set(); let m;
    while((m=rx.exec(String(textValue||'')))){if(seen.has(m[1]))dup.add(m[1]);seen.add(m[1])} return [...dup];
  }
  function duplicateHtmlIds(textValue){
    const rx=/\bid=["']([^"']+)["']/g, seen=new Set(), dup=new Set(); let m;
    while((m=rx.exec(String(textValue||'')))){if(seen.has(m[1]))dup.add(m[1]);seen.add(m[1])} return [...dup];
  }
  function domReferenceFailures(stageRoot){
    const htmlPath=path.join(stageRoot,'public','index.html'),jsPath=path.join(stageRoot,'public','app.js');if(!fs.existsSync(htmlPath)||!fs.existsSync(jsPath))return [];
    const html=fs.readFileSync(htmlPath,'utf8'),js=fs.readFileSync(jsPath,'utf8');const ids=new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(x=>x[1]));const refs=new Set([...js.matchAll(/\$\(["']([^"']+)["']\)/g)].map(x=>x[1]));return [...refs].filter(x=>!ids.has(x));
  }
  function runtimeBoundaryFailures(rel,ops){
    const out=[];const textValue=(ops||[]).map(op=>String(op.content||op.replace||op.replacement||'')).join('\n');
    if(/(^|\/)server(\.js|\/[^/]+\.js)$/i.test(rel)){ // server.js and the modules split out of it
      if(/\bdocument\.|\bwindow\.|\blocalStorage\b|\bstate\.imageModels\b/.test(textValue))out.push('server.js patch contains browser-only runtime references');
      if(/validationChecks\.every[\s\S]{0,2500}return\s+true/.test(textValue))out.push('server.js patch appears to contain hard-coded validation success logic');
    }
    if(/public\/app\.js$/i.test(rel) && /\brequire\(["'](?:fs|path|child_process)["']\)|\bprocess\.env\b/.test(textValue))out.push('public/app.js patch contains Node-only runtime references');
    return out;
  }
  async function runProcess(cmd,args,cwd,timeoutMs=45000,env={}){
    return await new Promise((resolve,reject)=>{const child=spawn(cmd,args,{cwd,env:childEnv({...env,CI:'1'}),shell:false});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Validation command timed out'))},timeoutMs);child.stdout?.on('data',d=>stdout+=d.toString());child.stderr?.on('data',d=>stderr+=d.toString());child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,stdout:stdout.slice(-20000),stderr:stderr.slice(-20000)})})});
  }
  function functionSource(textValue,name){
    const r=findFunctionRange(textValue,name);
    return textValue.slice(r.start,r.end);
  }
  function requiredTextFailures(label,beforeText,afterText,required){
    const failures=[];
    for(const item of required){
      if(beforeText.includes(item) && !afterText.includes(item)){
        failures.push(`${label} removed required contract reference: ${item}`);
      }
    }
    return failures;
  }
  function replacedFunctionContractFailures(change,sourceRoot,stageRoot){
    const failures=[];
    for(const f of change.files||[]){
      if(!Array.isArray(f.operations))continue;
      const replacementOps=f.operations.filter(op=>op.type==='replace_function');
      if(!replacementOps.length)continue;
      const originalPath=ensureInside(sourceRoot,f.path);
      const stagedPath=ensureInside(stageRoot,f.path);
      if(!fs.existsSync(originalPath) || !fs.existsSync(stagedPath))continue;
      const originalText=fs.readFileSync(originalPath,'utf8');
      const stagedText=fs.readFileSync(stagedPath,'utf8');
      for(const op of replacementOps){
        let beforeFn='';
        let afterFn='';
        try{
          beforeFn=functionSource(originalText,op.name);
          afterFn=functionSource(stagedText,op.name);
        }catch(e){
          failures.push(`${f.path}:${op.name}: ${String(e.message||e)}`);
          continue;
        }
        if(op.name==='engineeringRunText'){
          if(!afterFn.includes('return')){
            failures.push('engineeringRunText replacement no longer returns a value');
          }
          if(beforeFn.includes('run.status') && !afterFn.includes('run.status')){
            failures.push(
              'engineeringRunText replacement removed run.status lifecycle handling'
            );
          }
          if(beforeFn.includes('run.steps') && !afterFn.includes('run.steps')){
            failures.push(
              'engineeringRunText replacement removed run.steps detail handling'
            );
          }
          if(
            beforeFn.includes('run.finalChangeId') &&
            !afterFn.includes('run.finalChangeId')
          ){
            failures.push(
              'engineeringRunText replacement removed finalChangeId output'
            );
          }
        }
        if(op.name==='pollEngineeringIntent'){
          const required=[
            "evoApi('/api/engineering/runs')",
            "find(x=>x.id===runId)",
            "$('engineeringState')",
            "$('engineeringStatus')",
            'state.messages[assistantIndex]',
            '.content',
            '.streaming',
            '.action',
            'renderMessages',
            'loadEngineeringRuns',
            'persistMessages',
            'loadChanges',
            'loadApprovals',
            'loadInbox',
            'loadActivity',
            'loadWorkspace',
            'loadHomeCapabilities',
            'setPhase',
            'toast',
            'setTimeout'
          ];
          failures.push(
            ...requiredTextFailures(
              'pollEngineeringIntent',
              beforeFn,
              afterFn,
              required
            )
          );
          if(
            beforeFn.includes('setTimeout(()=>pollEngineeringIntent') &&
            !afterFn.includes('setTimeout(()=>pollEngineeringIntent')
          ){
            failures.push(
              'pollEngineeringIntent replacement removed polling/retry scheduling'
            );
          }
          if(
            beforeFn.includes('m.content=') &&
            afterFn.includes('state.messages[assistantIndex]=')
          ){
            failures.push(
              'pollEngineeringIntent replacement appears to replace the message object instead of mutating m.content'
            );
          }
          if(
            afterFn.includes('/api/engineering/runs/${runId}')
          ){
            failures.push(
              'pollEngineeringIntent replacement invented a per-run Engineering API endpoint'
            );
          }
          const suspicious=[
            'loadIn0box',
            'updateAskThreadMessage',
            'refreshCapabilities'
          ];
          for(const token of suspicious){
            if(afterFn.includes(token) && !beforeFn.includes(token)){
              failures.push(
                `pollEngineeringIntent replacement introduced unknown/suspicious reference: ${token}`
              );
            }
          }
        }
      }
    }
    return failures;
  }
  async function validateStagedChange(change,stageRoot){  const sourceRoot =
      change.target === 'self'
        ? SELF_APP_ROOT
        : safeWorkspacePath(change.root || '');
    const checks=[]; const add=(name,ok,detail='')=>checks.push({name,result:ok?'PASS':'FAIL',detail:String(detail||'').slice(0,4000)});
    for(const f of change.files||[]){
      const full=ensureInside(stageRoot,f.path); if(!fs.existsSync(full)){add(`exists ${f.path}`,false,'staged file missing');continue}
      const textValue=fs.readFileSync(full,'utf8');
      if(/\.js$/i.test(f.path)){const r=await runProcess('node',['--check',full],stageRoot);add(`syntax ${f.path}`,r.code===0,r.stderr||r.stdout)}
      if(/app\.js$/i.test(f.path)){const dup=duplicateTopLevelFunctions(textValue);add(`duplicate functions ${f.path}`,dup.length===0,dup.join(', '))}
      if(/\.html$/i.test(f.path)){const dup=duplicateHtmlIds(textValue);add(`duplicate ids ${f.path}`,dup.length===0,dup.join(', '))}
      const boundary=runtimeBoundaryFailures(f.path,f.operations);add(`runtime boundary ${f.path}`,boundary.length===0,boundary.join('; '));
    }
    const contractFailures =
      replacedFunctionContractFailures(
        change,
        sourceRoot,
        stageRoot
      );
    add(
      'replaced function contract',
      contractFailures.length===0,
      contractFailures.join('; ')
    );  if(change.target==='self'){
      // server.js and the modules split out of it (app/server/*.js) are all core.
      const serverModules=fs.existsSync(path.join(stageRoot,'server'))?fs.readdirSync(path.join(stageRoot,'server')).filter(f=>f.endsWith('.js')).map(f=>'server/'+f):[];
      for(const rel of ['server.js',...serverModules,'public/app.js','public/sw.js']){const full=path.join(stageRoot,rel);if(fs.existsSync(full)){const r=await runProcess('node',['--check',full],stageRoot);add(`core syntax ${rel}`,r.code===0,r.stderr||r.stdout)}}
      const html=path.join(stageRoot,'public','index.html');if(fs.existsSync(html)){const dup=duplicateHtmlIds(fs.readFileSync(html,'utf8'));add('core duplicate HTML ids',dup.length===0,dup.join(', '))}
      const dom=domReferenceFailures(stageRoot);add('DOM reference contract',dom.length===0,dom.length?`Missing IDs: ${dom.join(', ')}`:'all referenced IDs resolved');
      const smokePort=3200+Math.floor(Math.random()*300); const stageData=path.join(CHANGE_STAGE_ROOT,change.id,'smoke-data');fs.rmSync(stageData,{recursive:true,force:true});fs.mkdirSync(stageData,{recursive:true});
      const child=spawn('node',[path.join(stageRoot,'server.js')],{cwd:stageRoot,env:childEnv({PORT:String(smokePort),LOCAL_UI_PORT:'',APP_VERSION:`${APP_VERSION}-stage`,DATA_DIR:stageData}),shell:false}); let stderr='';child.stderr?.on('data',d=>stderr+=d.toString());
      let healthy=false,imageModelsOk=false,imageDetail=''; try{for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));try{const r=await fetch(`http://127.0.0.1:${smokePort}/healthz`);if(r.ok){const j=await r.json();if(j.status==='ok'){healthy=true;break}}}catch{}}if(healthy){try{const r=await fetchWithTimeout(`http://127.0.0.1:${smokePort}/api/images/models`,{},10000);imageModelsOk=r.ok;if(r.ok){const j=await r.json();imageDetail=`${Array.isArray(j.models)?j.models.length:0} model(s) discovered`}else imageDetail=`HTTP ${r.status}`}catch(e){imageDetail=String(e.message||e)}}}finally{child.kill('SIGTERM')}
      add('staged server smoke test',healthy,healthy?'health endpoint responded':stderr.slice(-1800));
      add('staged image model discovery',imageModelsOk,imageDetail||'image model API unavailable');
    }
    return {checks,passed:checks.every(x=>x.result==='PASS')};
  }
  function repairContextForChange(change,sourceRoot,errorText){
    const blocks=[];for(const f of change.files||[]){try{const full=ensureInside(sourceRoot,f.path);if(fs.existsSync(full)){const txt=fs.readFileSync(full,'utf8');blocks.push(`CURRENT FILE: ${f.path}\n---\n${excerptForRequest(txt,errorText,12000)}\n---`)}}catch{}}
    return `PATCH/STAGING FAILURE:\n${String(errorText||'unknown failure').slice(0,6000)}\n\nACTUAL CURRENT SOURCE:\n${blocks.join('\n\n').slice(0,36000)}`;
  }
  // Staging deletes and rebuilds the stage tree and then validates for a while; a second concurrent stage of the
  // same change would wipe the tree under the first.
  const stagingChangeIds=new Set();
  async function stageChangeById(changeId){
    if(stagingChangeIds.has(changeId))throw Object.assign(new Error('This change is already being staged'),{statusCode:409});
    stagingChangeIds.add(changeId);
    try{return await stageChangeByIdUnlocked(changeId)}finally{stagingChangeIds.delete(changeId)}
  }
  async function stageChangeByIdUnlocked(changeId){
    const items=changeStore();const i=items.findIndex(x=>x.id===changeId);if(i<0)throw new Error('Change not found');const c=items[i];if(!['planned','validation_failed','patch_failed'].includes(c.status))throw new Error(`Change cannot be staged from status ${c.status}`);const sourceRoot=c.target==='self'?SELF_APP_ROOT:safeWorkspacePath(c.root||'');const base=path.join(CHANGE_STAGE_ROOT,c.id);const stageRoot=path.join(base,c.target==='self'?'app':'workspace');fs.rmSync(base,{recursive:true,force:true});fs.mkdirSync(stageRoot,{recursive:true});if(c.target==='self')copyTree(sourceRoot,stageRoot);const diffs=[];
    try{
      for(const f of c.files||[]){const src=ensureInside(sourceRoot,f.path),dst=ensureInside(stageRoot,f.path);let before='';if(fs.existsSync(src)){before=fs.readFileSync(src,'utf8');if(c.target!=='self'){fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst)}}else if(!f.operations.some(x=>x.type==='create'))throw new Error(`${f.path}: source file does not exist`);const after=applyOpsToText(before,f.operations,f.path);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.writeFileSync(dst,after,'utf8');diffs.push({path:f.path,diff:simpleDiff(before,after),changed:before!==after})}
    }catch(e){c.status='patch_failed';c.updatedAt=nowIso();c.patchError=String(e.message||e);c.validation={passed:false,checks:[{name:'patch application',result:'FAIL',detail:c.patchError}]};saveChanges(items);throw e}
    c.diffs=diffs;c.stageRoot=stageRoot;c.validation=await validateStagedChange(c,stageRoot);c.updatedAt=nowIso();
    storage.transaction(()=>{if(c.validation.passed){c.status='awaiting_approval';const approvals=approvalStore();const approval={id:makeId('approval'),title:plainText.approvalTitle(c),detail:`${c.summary}\n\n${c.files.length} file(s) staged and validated.`,risk:c.target==='self'?'high':'medium',status:'pending',createdAt:nowIso(),updatedAt:nowIso(),meta:{changeId:c.id,target:c.target,type:'change'}};approvals.unshift(approval);saveStore(APPROVALS_STORE,approvals,500);c.approvalId=approval.id;addNotification('approval',approval.title,approval.detail,{approvalId:approval.id,changeId:c.id})}else c.status='validation_failed';saveChanges(items);recordActivity('change',c.validation.passed?'Change staged':'Change validation failed',c.summary,{changeId:c.id});});return c;
  }
  async function apiChanges(req,res,urlObj){
    if(!requireFeature(res,13))return; const id=urlObj.searchParams.get('id'); const items=changeStore();
    if(id){const item=items.find(x=>x.id===id);if(!item)return json(res,404,{error:'Change not found'});return json(res,200,{item:publicChange(item)})}
    json(res,200,{items:items.map(publicChange),pending:items.filter(x=>['planned','patch_failed','validation_failed','staged','awaiting_approval','approved','apply_requested'].includes(x.status)).length});
  }
  async function apiChangeCapabilities(req,res){
    if(!requireFeature(res,17))return;json(res,200,{patchIntelligence:true,plannerTimeoutMs:ENGINEERING_MODEL_TIMEOUT_MS,retryPatchApplicationFailures:true,operations:['replace_function','insert_after_function','insert_after_text','replace_between_markers','replace_regex','replace','create'],validation:['javascript syntax','duplicate browser functions','duplicate HTML ids','DOM reference contract','runtime boundary checks','staged server health','image model discovery']});
  }
  // Plans a change request. With itemId, links that Improve item in the same transaction, before the save runs
  // reconcile, so the new change is never mistaken for an unlinked one.
  async function planChange({request,target:rawTarget,root},{itemId,stay=''}={}){
    const target=rawTarget==='workspace'?'workspace':'self';const rootRel=String(root||'').trim();const targetRoot=target==='self'?SELF_APP_ROOT:safeWorkspacePath(rootRel);
    const plan=await generatePatchPlan(request,targetRoot,{stay});
    const item={id:makeId('chg'),target,root:target==='self'?'app':rootRel,request,summary:plan.summary,notes:plan.notes,files:plan.files,status:plan.files.length?'planned':'needs_context',createdAt:nowIso(),updatedAt:nowIso(),validation:null,diffs:[],route:plan.route};
    storage.transaction(()=>{
      if(itemId){const key=CLAUDE_FINDING_PREFIX+itemId,f=storage.readSetting(key,null);if(f)storage.writeSetting(key,{...f,changeId:item.id,status:'approved',updatedAt:nowIso()})}
      const items=changeStore();items.unshift(item);saveChanges(items);
    });
    recordActivity('change','Change plan created',request.slice(0,180),{changeId:item.id,target});
    return item;
  }
  async function apiChangePlan(req,res){
    if(!requireFeature(res,13))return;
    try{const b=await readBody(req);const request=String(b.request||'').trim();if(!request)return json(res,400,{error:'request is required'});const item=await planChange({request,target:b.target,root:b.root});json(res,201,{item:publicChange(item)})}catch(e){storageError(res,e,500)}
  }
  async function apiChangeStage(req,res){
    if(!requireFeature(res,13))return;
    try{const b=await readBody(req);const c=await stageChangeById(String(b.id||''));json(res,200,{item:publicChange(c)})}catch(e){storageError(res,e,400)}
  }
  async function apiChangeApprove(req,res){
    if(!requireFeature(res,13))return;
    try{const b=await readBody(req);const decision=String(b.decision||'');if(!['approved','rejected'].includes(decision))return json(res,400,{error:'decision must be approved or rejected'});const items=changeStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Change not found'});const c=items[i];if(c.status!=='awaiting_approval')return json(res,409,{error:`Change is not awaiting approval (${c.status})`});decideChange(items,c,decision);json(res,200,{item:publicChange(c)})}catch(e){storageError(res,e,400)}
  }
  // Approving or rejecting a change, from Change requests or from its approval (Approvals page, run view, a notification):
  // the change and its approval move together.
  function decideChange(items,c,decision){
    storage.transaction(()=>{c.status=decision==='approved'?'approved':'rejected';c.updatedAt=nowIso();if(c.approvalId){const approvals=approvalStore();const ai=approvals.findIndex(x=>x.id===c.approvalId);if(ai>=0){approvals[ai].status=decision;approvals[ai].updatedAt=nowIso();saveStore(APPROVALS_STORE,approvals,500)}}saveChanges(items);recordActivity('change',`Change ${decision}`,c.summary,{changeId:c.id});});
  }
  async function apiChangeRequestApply(req,res){
    if(!requireFeature(res,13))return;
    try{const b=await readBody(req);const items=changeStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Change not found'});const c=items[i];if(c.status!=='approved')return json(res,409,{error:`Change must be approved before apply (${c.status})`});if(c.target==='workspace'){const sourceRoot=safeWorkspacePath(c.root||'');const stageRoot=c.stageRoot;if(!stageRoot||!fs.existsSync(stageRoot))return json(res,409,{error:'Staged change is unavailable; stage it again'});const backups=[];for(const f of c.files){const src=ensureInside(stageRoot,f.path),dst=ensureInside(sourceRoot,f.path);fs.mkdirSync(path.dirname(dst),{recursive:true});if(fs.existsSync(dst)){const backup=`${dst}.localai-${Date.now()}.bak`;fs.copyFileSync(dst,backup);backups.push(workspaceRel(backup))}fs.copyFileSync(src,dst)}c.status='applied';c.appliedAt=nowIso();c.backups=backups;recordActivity('change','Workspace change applied',c.summary,{changeId:c.id,files:c.files.length});}
      else if(c.shipVia!=='pr'){markChangeForPr(c);}c.updatedAt=nowIso();saveChanges(items);const shipped=c.target==='self'?shipChangeAsPr(c):null;json(res,200,{item:publicChange(c),shipVia:c.target==='self'?'pr':'workspace',improveItemId:shipped?.id||null})}catch(e){storageError(res,e,400)}
  }
  async function apiChangeDeployResult(req,res){
    if(!requireFeature(res,13))return;
    try{const b=await readBody(req);const status=String(b.status||'');if(!['applied','rolled_back','deploy_failed'].includes(status))return json(res,400,{error:'invalid deployment status'});const items=changeStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Change not found'});items[i].status=status;items[i].deploymentDetail=String(b.detail||'').slice(0,4000);items[i].updatedAt=nowIso();if(status==='applied')items[i].appliedAt=nowIso();saveChanges(items);recordActivity('change',status==='applied'?'Self-update applied':'Self-update rollback/failure',items[i].summary,{changeId:items[i].id,status});json(res,200,{item:publicChange(items[i])})}catch(e){storageError(res,e,400)}
  }
  // ===== END AUTONOMOUS ISSUE DETECTION =======================================



  // ===== ENGINEERING AGENT RUNTIME (v1.16+) ===================================
  const ENGINEERING_RUNS_STORE = 'engineeringRuns';
  function engineeringRunStore(){return objectStore(ENGINEERING_RUNS_STORE)}
  function saveEngineeringRuns(items){saveStore(ENGINEERING_RUNS_STORE,items,300)}
  function engineeringStep(run,name,state='pending',detail=''){const item={name,state,detail:String(detail||'').slice(0,6000),at:nowIso()};run.steps.push(item);run.updatedAt=nowIso();return item}
  // stay: a retry whose request carries the last attempt's error output or validation log stays here.
  function createEngineeringChange(request,target,rootRel,runId,attempt,stay=''){
    const targetRoot=target==='self'?SELF_APP_ROOT:safeWorkspacePath(rootRel);return generatePatchPlan(request,targetRoot,{kind:'code',stay}).then(plan=>{const changes=changeStore();const item={id:makeId('chg'),target,root:target==='self'?'app':rootRel,request,summary:plan.summary,notes:`Engineering run ${runId}, attempt ${attempt}. ${plan.notes||''}`.trim(),files:plan.files,status:plan.files.length?'planned':'needs_context',createdAt:nowIso(),updatedAt:nowIso(),validation:null,diffs:[],sourceEngineeringRunId:runId,engineeringAttempt:attempt,route:plan.route};changes.unshift(item);saveChanges(changes);return item})
  }
  async function internalStageChange(changeId){return await stageChangeById(changeId)}
  function effectiveEngineeringRun(run,changesById){
    const out={
      ...run,
      steps:Array.isArray(run.steps)
        ? run.steps.map(step=>({...step}))
        : []
    };
    if(!run.finalChangeId)return out;
    const change=changesById.get(run.finalChangeId);
    if(!change)return out;
    const lifecycleMap={
      awaiting_approval:'awaiting_approval',
      approved:'approved',
      apply_requested:'apply_requested',
      applied:'applied',
      rejected:'needs_attention',
      deploy_failed:'needs_attention',
      rolled_back:'needs_attention'
    };
    const effective=lifecycleMap[change.status];
    if(!effective)return out;
    out.status=effective;
    out.changeStatus=change.status;
    out.changeUpdatedAt=change.updatedAt||null;
    const approvalStep=out.steps.find(
      step=>step.name==='Human approval required' && step.state==='waiting'
    );
    if(approvalStep && effective!=='awaiting_approval'){
      approvalStep.state='complete';
      approvalStep.at=change.updatedAt||approvalStep.at;
      if(effective==='approved'){
        approvalStep.detail=`Change ${change.id} was approved.`;
      }else if(effective==='apply_requested'){
        approvalStep.detail=`Change ${change.id} was approved and queued for deployment.`;
      }else if(effective==='applied'){
        approvalStep.detail=`Change ${change.id} was approved and deployed.`;
      }else{
        approvalStep.detail=`Change ${change.id} ended with deployment state ${change.status}.`;
      }
    }
    if(effective==='apply_requested'){
      out.steps.push({
        name:'Deployment',
        state:'waiting',
        detail:`Change ${change.id} is queued for the self-update host.`,
        at:change.applyRequestedAt||change.updatedAt||out.updatedAt
      });
    }
    if(effective==='applied'){
      out.steps.push({
        name:'Deployment',
        state:'complete',
        detail:`Change ${change.id} was applied successfully.`,
        at:change.appliedAt||change.updatedAt||out.updatedAt
      });
    }
    if(effective==='needs_attention'){
      out.steps.push({
        name:'Deployment',
        state:'error',
        detail:change.deploymentDetail ||
          `Change ${change.id} ended with status ${change.status}.`,
        at:change.updatedAt||out.updatedAt
      });
      if(!out.error){
        out.error=change.deploymentDetail ||
          `Linked change ${change.id} ended with status ${change.status}.`;
      }
    }
    if(change.updatedAt){
      out.updatedAt=change.updatedAt;
    }
    return out;
  }
  function effectiveEngineeringRuns(){
    const changesById=new Map(
      changeStore().map(change=>[change.id,change])
    );
    return engineeringRunStore().map(
      run=>effectiveEngineeringRun(run,changesById)
    );
  }
  async function apiEngineeringRuns(req,res){
    if(!requireFeature(res,16))return;
    const items=effectiveEngineeringRuns();
    json(res,200,{
      items:items.slice(0,200),
      active:items.filter(x=>x.status==='running').length,
      awaitingApproval:items.filter(x=>x.status==='awaiting_approval').length
    });
  }
  function createEngineeringRunRecord(request,target,rootRel,maxAttempts){
    const runs=engineeringRunStore();
    const run={id:makeId('eng'),request,target,root:target==='self'?'app':rootRel,maxAttempts,status:'running',createdAt:nowIso(),updatedAt:nowIso(),attempt:0,steps:[],changeIds:[],finalChangeId:null,error:null};
    runs.unshift(run);saveEngineeringRuns(runs);recordActivity('engineering','Engineering run started',request.slice(0,180),{runId:run.id,target});return run;
  }
  function refreshEngineeringRun(run){const runs=engineeringRunStore();const i=runs.findIndex(x=>x.id===run.id);if(i>=0)runs[i]=run;else runs.unshift(run);saveEngineeringRuns(runs)}
  async function executeEngineeringRun(run){
    let workingRequest=run.request,lastError='';
    for(let attempt=1;attempt<=run.maxAttempts;attempt++){
      run.attempt=attempt;const planStep=engineeringStep(run,`Attempt ${attempt}: plan`,'running');refreshEngineeringRun(run);
      let change;
      try{change=await createEngineeringChange(workingRequest,run.target,run.target==='self'&&run.root==='app'?'repos':run.root,run.id,attempt,workingRequest!==run.request?'Retries that carry error output stay on this PC':/RECENT CONVERSATION CONTEXT:/.test(run.request)?'Requests that carry a conversation stay on this PC':'')}catch(e){lastError=String(e.message||e);planStep.state='error';planStep.detail=lastError;refreshEngineeringRun(run);if(attempt<run.maxAttempts){workingRequest=`${run.request}\n\nPrevious planning attempt failed. Retry with a smaller source-aware patch. Failure:\n${lastError}`;engineeringStep(run,`Attempt ${attempt}: repair feedback`,'complete',lastError);refreshEngineeringRun(run);continue}break}
      run.changeIds.push(change.id);planStep.state=change.files.length?'complete':'error';planStep.detail=change.files.length?`${change.files.length} file(s) planned`:'No patch operations produced';refreshEngineeringRun(run);
      if(!change.files.length){lastError='Patch planner produced no patch operations';if(attempt<run.maxAttempts){workingRequest=`${run.request}\n\nThe previous planner produced no usable operations. Inspect the supplied source and produce a minimal source-aware patch using replace_function/insert_after_function where possible.`;engineeringStep(run,`Attempt ${attempt}: repair feedback`,'complete',lastError);refreshEngineeringRun(run);continue}break}
      const st=engineeringStep(run,`Attempt ${attempt}: stage + validate`,'running');refreshEngineeringRun(run);let staged;
      try{staged=await internalStageChange(change.id)}catch(e){lastError=String(e.message||e);st.state='error';st.detail=lastError;refreshEngineeringRun(run);if(attempt<run.maxAttempts){const targetRoot=run.target==='self'?SELF_APP_ROOT:safeWorkspacePath(run.root);const context=repairContextForChange(change,targetRoot,lastError);workingRequest=`${run.request}\n\nThe previous patch could not be applied. Do not repeat the brittle operation. Use the actual current source below and create a corrected structural patch.\n\n${context}`;engineeringStep(run,`Attempt ${attempt}: repair feedback`,'complete',context.slice(0,6000));refreshEngineeringRun(run);continue}break}
      st.state=staged.validation?.passed?'complete':'error';st.detail=staged.validation?.passed?'All staging checks passed':(staged.validation?.checks||[]).filter(x=>x.result==='FAIL').map(x=>`${x.name}: ${x.detail}`).join('\n').slice(0,6000);refreshEngineeringRun(run);
      if(staged.validation?.passed){run.status='awaiting_approval';run.finalChangeId=change.id;run.error=null;engineeringStep(run,'Human approval required','waiting',`Validated change ${change.id} is ready for review.`);run.updatedAt=nowIso();refreshEngineeringRun(run);recordActivity('engineering','Engineering run validated',run.request.slice(0,180),{runId:run.id,changeId:change.id,attempt});return run}
      lastError=st.detail||'Validation failed';if(attempt<run.maxAttempts){const targetRoot=run.target==='self'?SELF_APP_ROOT:safeWorkspacePath(run.root);const context=repairContextForChange(change,targetRoot,lastError);workingRequest=`${run.request}\n\nPrevious patch staged but failed real validation. Produce a corrected patch, do not add fake validators, and preserve the approval boundary.\n\n${context}`;engineeringStep(run,`Attempt ${attempt}: repair feedback`,'complete',lastError);refreshEngineeringRun(run)}
    }
    run.status='needs_attention';run.updatedAt=nowIso();run.error=lastError||`Unable to produce a validated patch within ${run.maxAttempts} attempt(s).`;engineeringStep(run,'Stopped safely','error',run.error);refreshEngineeringRun(run);addNotification('engineering','Engineering run needs attention',`${run.request.slice(0,180)} — ${run.error}`,{runId:run.id});recordActivity('engineering','Engineering run stopped',run.error,{runId:run.id});return run;
  }
  async function apiEngineeringRun(req,res){
    if(!requireFeature(res,16))return;
    try{const b=await readBody(req);const request=String(b.request||'').trim();if(!request)return json(res,400,{error:'request is required'});const target=b.target==='workspace'?'workspace':'self',rootRel=String(b.root||'repos').trim(),maxAttempts=Math.max(1,Math.min(3,Number(b.maxAttempts)||3));const run=createEngineeringRunRecord(request,target,rootRel,maxAttempts);await executeEngineeringRun(run);json(res,200,{run})}catch(e){storageError(res,e,500)}
  }
  async function apiEngineeringStart(req,res){
    if(!requireFeature(res,16))return;
    try{const b=await readBody(req);const request=String(b.request||'').trim();if(!request)return json(res,400,{error:'request is required'});const target=b.target==='workspace'?'workspace':'self',rootRel=String(b.root||'repos').trim(),maxAttempts=Math.max(1,Math.min(3,Number(b.maxAttempts)||3));const run=createEngineeringRunRecord(request,target,rootRel,maxAttempts);json(res,202,{run});setImmediate(()=>executeEngineeringRun(run).catch(e=>{run.status='needs_attention';run.error=String(e.message||e);run.updatedAt=nowIso();engineeringStep(run,'Stopped safely','error',run.error);refreshEngineeringRun(run)}))}catch(e){storageError(res,e,500)}
  }
  // ===== END POWERSHELL WORKBENCH =============================================

  // ===== CLAUDE BOARD ==========================================================
  // Progress and review findings reported by Claude Code sessions, ranked by severity, operator votes and
  // decisions. Claude reads the ranking back from /api/claude/priorities. Rows live in settings under
  // per-kind key prefixes (newest key first), so no schema change is needed.
  const CLAUDE_SESSION_PREFIX='claude-session/',CLAUDE_EVENT_PREFIX='claude-event/',CLAUDE_FINDING_PREFIX='claude-finding/';
  const CLAUDE_LIVE_WORKING_MS=2*60*1000,CLAUDE_LIVE_SCAN_EVENTS=500,CLAUDE_STOP_TITLE='Finished responding';
  const CLAUDE_MAX_EVENTS=3000,CLAUDE_MAX_FINDINGS=1000;
  const CLAUDE_SEVERITY_WEIGHT={high:30,medium:15,low:5};
  const CLAUDE_STATUS={proposed:{label:'Proposed',boost:0},approved:{label:'Approved',boost:20},in_progress:{label:'In progress',boost:25},deferred:{label:'Deferred',boost:-25},rejected:{label:'Rejected',boost:-100},fixed:{label:'Fixed',boost:-200}};
  const CLAUDE_EVENT_STATUS=new Set(['started','running','done','failed','info']);
  let claudeKeySeq=0,claudeKeyMs=0;
  // Keys sort by time: zero-padded milliseconds plus a per-process sequence for same-millisecond writes.
  function claudeTimeKey(){const now=Math.max(Date.now(),claudeKeyMs);claudeKeySeq=now===claudeKeyMs?claudeKeySeq+1:0;claudeKeyMs=now;return `${String(now).padStart(14,'0')}-${claudeKeySeq.toString(36).padStart(3,'0')}`}
  function claudeSlug(value,fallback){const s=String(value||'').toLowerCase().replace(/[^a-z0-9_.:-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);return s||fallback}
  function claudeText(value,max){return String(value??'').slice(0,max)}
  function claudeScore(f){const votes=(f.votes?.up||0)-(f.votes?.down||0);return (CLAUDE_SEVERITY_WEIGHT[f.severity]||10)+votes*6+(CLAUDE_STATUS[f.status]?.boost||0)+(Number(f.priorityBoost)||0)}
  function claudeRanked(findings){return findings.map(f=>({...f,score:claudeScore(f)})).sort((a,b)=>b.score-a.score||String(a.createdAt).localeCompare(String(b.createdAt))).map((f,i)=>({...f,rank:i+1}))}
  function claudeFindings(){return storage.listSettings(CLAUDE_FINDING_PREFIX,{limit:CLAUDE_MAX_FINDINGS})}
  // Session keys are ids, not times, so storage.pruneSettings (which keeps the highest keys) can't rank them.
  function claudePruneSessions(){const {drop}=claudeKeptSessions(storage.listSettings(CLAUDE_SESSION_PREFIX),claudeFindings());for(const s of drop)storage.deleteSetting(CLAUDE_SESSION_PREFIX+s.id);return drop.length}
  // ===== IMPROVE (roadmap sub-project 4): the board's findings are the backlog; see app/improve.js =====
  const IMPROVE_FIELDS=['source','signalId','changeId','handedToClaude','handedAt','shipped'];
  // Everything automatic (promote signals, resolve, ship applied changes, stamp the release, link old changes) in one
  // idempotent pass. Called at start-up, after a scan saves, and whenever a change request is saved.
  function runImproveReconcile({startup=false}={}){
    const at=nowIso();let written=0;
    storage.transaction(()=>{
      const {upserts}=improve.reconcile({items:claudeFindings(),changes:changeStore(),signals:issueStore(),release:release?{version:release.version||APP_VERSION,commit:release.commit}:null,startup,at});
      for(const u of upserts){const key=CLAUDE_FINDING_PREFIX+u.id,prev=storage.readSetting(key,null);
        // A whole new item (it has createdAt) never replaces a stored one: reconcile sees only the newest findings.
        if(prev&&u.createdAt)continue;
        storage.writeSetting(key,prev?{...prev,...u}:{sessionId:'improve',category:'other',votes:{up:0,down:0},priorityBoost:0,decidedAt:null,file:'',area:'',scenario:'',fix:'',pr:'',...u});written++}
    });
    return written;
  }
  const IMPROVE_ACTIONS=['start','handToClaude','moveToTop','defer','reject','retry','backToBacklog','discard'];
  function improveRead(id){return storage.readSetting(CLAUDE_FINDING_PREFIX+claudeSlug(id,''),null)}
  function improveWrite(f){f.updatedAt=nowIso();storage.writeSetting(CLAUDE_FINDING_PREFIX+f.id,f);return f}
  // A validated change to Local AI itself ships the way every change does: a pull request, CI, the owner's merge and
  // Safe Deploy. There is no host updater. Approving it hands its Improve item to Claude (In progress, boosted in
  // /api/claude/priorities) with what to do; the session reports the deploy through /api/changes/deploy-result,
  // which marks the change applied and Improve moves the item to Shipped.
  function markChangeForPr(c){c.shipVia='pr';c.handedAt=nowIso();addNotification('change','Handed to Claude to ship',`${c.summary||'Change'}. A Claude session opens a pull request with the staged change; it deploys when you merge it.`,{changeId:c.id})}
  function shipChangeAsPr(c){
    const at=nowIso();
    const existing=claudeFindings().find(f=>f.changeId===c.id);
    const line=String(c.request||'').split('\n').map(l=>l.trim()).find(Boolean);
    const item=existing||{id:`idea-change-${c.id}`,sessionId:'improve',source:'idea',changeId:c.id,category:'idea',severity:'medium',status:'approved',
      title:String(c.summary&&!['Proposed change','Change request'].includes(c.summary)?c.summary:(line||'Change request')).slice(0,120),summary:String(c.request||c.summary||'').slice(0,2000),
      votes:{up:0,down:0},priorityBoost:0,decidedAt:null,file:'',area:'',scenario:'',pr:'',createdAt:at};
    const fix=`Ship staged change ${c.id} as a pull request: GET /api/changes lists it with its files and diffs. After the merge deploys, POST /api/changes/deploy-result {"id":"${c.id}","status":"applied"}.`;
    return improveWrite({...item,...(item.handedToClaude?{}:improve.handToClaude(item,at)),fix});
  }
  // Before this, approved self changes waited at apply_requested for an updater that was never built. Hand those over once.
  function shipQueuedSelfChanges(){
    const items=changeStore();let moved=0;
    for(const c of items)if(c.target==='self'&&c.status==='apply_requested'){c.status='approved';markChangeForPr(c);c.updatedAt=nowIso();moved++}
    if(!moved)return 0;
    saveChanges(items);
    for(const c of items)if(c.shipVia==='pr'&&c.status==='approved')shipChangeAsPr(c);
    return moved;
  }
  function improveChangeRequest(f){return [f.title,f.summary,f.fix].filter(Boolean).join('\n\n')}
  // Only the owner's own ideas may be planned by a cloud model; Signals and Claude's findings carry text Local AI or
  // Claude wrote (runtime detail, file paths), so they stay here.
  const improveStay=f=>f.source==='idea'&&f.ownerTyped===true?'':'Problems Local AI or Claude wrote up stay on this PC';
  // Changes past approval are being shipped (a pull request for self changes); Improve must not retire them.
  const IMPROVE_LOCKED_CHANGE=['approved','apply_requested'];
  // Retires a change Improve no longer wants (rejected), and its pending approval with it.
  function improveRetireChange(changeId){
    storage.transaction(()=>{const items=changeStore(),i=items.findIndex(c=>c.id===changeId);if(i<0)return;const c=items[i];
      c.status='rejected';c.updatedAt=nowIso();
      if(c.approvalId){const approvals=approvalStore(),ai=approvals.findIndex(a=>a.id===c.approvalId&&a.status==='pending');if(ai>=0){approvals[ai].status='rejected';approvals[ai].updatedAt=nowIso();saveStore(APPROVALS_STORE,approvals,500)}}
      saveChanges(items)});
  }
  async function apiImproveItems(req,res){
    try{runImproveReconcile();const changes=changeStore(),byId=new Map(changes.map(c=>[c.id,c]));
      const ranked=claudeRanked(claudeFindings().map(f=>({...f,source:f.source||'claude'})));
      const order={backlog:0,inProgress:1,shipped:2,setAside:3};
      const items=ranked.map(f=>{const c=f.changeId?byId.get(f.changeId):null;return {...f,stage:improve.stageOf(f,byId),change:c?{id:c.id,status:c.status,summary:c.summary||''}:null}})
        .sort((a,b)=>order[a.stage]-order[b.stage]||(a.stage==='shipped'?String(b.updatedAt).localeCompare(String(a.updatedAt)):a.rank-b.rank));
      json(res,200,{items,signals:issueStore().slice(0,250)})}catch(e){storageError(res,e,500)}
  }
  async function apiImproveIdea(req,res){
    try{const b=await readBody(req,512*1024);const made=improve.ideaItem(b.text,nowIso());if(!made)return json(res,400,{error:'Describe the change first.'});
      // The same idea again within minutes (a double tap) is the one item, not a second row.
      const again=improve.recentDuplicate(claudeFindings(),made,made.createdAt),item=again||made;
      if(!again)storage.writeSetting(CLAUDE_FINDING_PREFIX+item.id,{sessionId:'owner',votes:{up:0,down:0},priorityBoost:0,decidedAt:null,file:'',area:'',scenario:'',fix:'',pr:'',...item});
      if(b.start!==true)return json(res,again?200:201,{item});
      // The idea is saved either way; if planning fails, say so and let the owner retry from the Backlog.
      try{const change=await planChange({request:improveChangeRequest(item),target:'self'},{itemId:item.id,stay:improveStay(item)});json(res,201,{item:improveRead(item.id),change:publicChange(change)})}
      catch(e){json(res,201,{item:improveRead(item.id),error:`Saved to your backlog, but planning failed: ${e.message}`})}}catch(e){storageError(res,e,500)}
  }
  // Hand to Claude from where the owner asked (Home, Agent World, New idea): a request to change Local AI itself goes to
  // Claude Code as a handed idea item, which leads /api/claude/priorities. The same request again updates its item.
  // The text lands at the top of Claude's queue, so it gets the same-origin and JSON checks the other owner-only routes have.
  async function apiImproveHandoff(req,res){
    if(!sameOriginJson(req,res))return;
    try{const b=await readBody(req,512*1024);const text=String(b.text??'').trim();if(!text)return json(res,400,{error:'Describe the change first.'});
      const at=nowIso(),title=text.split('\n')[0].trim().slice(0,120).toLowerCase();
      const existing=claudeFindings().find(f=>['proposed','approved'].includes(f.status)&&!f.changeId&&String(f.title||'').trim().toLowerCase()===title)||null;
      const item=improve.handoffItem(text,b.from,at,existing);
      storage.writeSetting(CLAUDE_FINDING_PREFIX+item.id,{sessionId:'owner',category:'idea',votes:{up:0,down:0},priorityBoost:0,decidedAt:null,file:'',area:'',scenario:'',pr:'',...item});
      recordActivity('change','Handed to Claude Code',`${item.title} (from ${improve.HANDOFF_FROM[b.from]||'Improve'})`,{itemId:item.id});
      json(res,existing?200:201,{item:improveRead(item.id)})}catch(e){storageError(res,e,500)}
  }
  async function apiImproveItem(req,res){
    try{const b=await readBody(req);if(!IMPROVE_ACTIONS.includes(b.action))return json(res,400,{error:`action must be one of ${IMPROVE_ACTIONS.join(', ')}`});
      const f=improveRead(b.id);if(!f)return json(res,404,{error:'Item not found'});
      const changes=changeStore(),change=f.changeId?changes.find(c=>c.id===f.changeId):null,live=!!change&&improve.LIVE_CHANGE.includes(change.status);
      const at=nowIso(),stage=improve.stageOf(f,new Map(changes.map(c=>[c.id,c])));
      // Each action belongs to a stage; anything else is refused rather than quietly moving the item.
      const where={backlog:'in the Backlog',inProgress:'in progress',shipped:'shipped',setAside:'set aside'}[stage];
      const refuse=()=>json(res,409,{error:`That isn't available for an item that is ${where}.`});
      if(['handToClaude','moveToTop','start'].includes(b.action)&&stage!=='backlog')return refuse();
      if(b.action==='retry'&&!(live&&['patch_failed','validation_failed'].includes(change.status)))return json(res,409,{error:'Retry needs a change that failed.'});
      if(['defer','reject','backToBacklog'].includes(b.action)&&stage==='shipped')return refuse();
      if(['defer','reject'].includes(b.action)&&change&&live){
        if(IMPROVE_LOCKED_CHANGE.includes(change.status))return json(res,409,{error:'This change is already approved and being shipped as a pull request.'});
        improveRetireChange(change.id);
      }
      switch(b.action){
        case 'start':case 'retry':{
          const failed=live&&['patch_failed','validation_failed'].includes(change.status);
          if(live&&!(b.action==='retry'&&failed))return json(res,409,{error:'A change for this item is already running.'});
          if(failed)improveRetireChange(change.id);
          await planChange({request:improveChangeRequest(f),target:'self'},{itemId:f.id,stay:improveStay(f)});return json(res,200,{item:improveRead(f.id)});
        }
        case 'handToClaude':return json(res,200,{item:improveWrite({...f,...improve.handToClaude(f,at)})});
        case 'moveToTop':{const open=claudeFindings().filter(x=>!['fixed','rejected','deferred'].includes(x.status));return json(res,200,{item:improveWrite({...f,priorityBoost:improve.moveToTopBoost(f,open,claudeScore)})})}
        case 'defer':case 'reject':return json(res,200,{item:improveWrite({...f,status:b.action==='defer'?'deferred':'rejected',decidedAt:at})});
        case 'backToBacklog':case 'discard':{
          if(change&&IMPROVE_LOCKED_CHANGE.includes(change.status))return json(res,409,{error:'This change is already approved and being shipped as a pull request.'});
          if(change&&live)improveRetireChange(change.id);
          // Back in the Backlog means you're reconsidering it, so a hand-off to Claude is withdrawn too.
          const unhand=x=>x.handedToClaude?{handedToClaude:false,priorityBoost:Math.max(0,(Number(x.priorityBoost)||0)-30)}:{};
          if(b.action==='backToBacklog'){const cur=improveRead(f.id);return json(res,200,{item:improveWrite({...cur,...unhand(cur),status:'approved',changeId:null})})}
          const aside=b.then==='aside',cur=improveRead(f.id);return json(res,200,{item:improveWrite({...cur,...unhand(cur),status:aside?'deferred':'approved',changeId:aside?f.changeId:null})});
        }
      }
    }catch(e){storageError(res,e,500)}
  }
  async function apiImproveSignal(req,res){
    try{const b=await readBody(req);if(!['promote','dismiss'].includes(b.action))return json(res,400,{error:'action must be promote or dismiss'});
      const issues=issueStore(),i=issues.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Signal not found'});
      if(b.action==='dismiss'){issues[i].status='ignored';issues[i].updatedAt=nowIso();saveIssues(issues);
        // Its backlog item, if it was promoted and not yet started, is closed with it.
        const promoted=improveRead(improve.signalItemId(issues[i].id));
        if(promoted&&improve.stageOf(promoted,new Map(changeStore().map(c=>[c.id,c])))==='backlog')improveWrite({...promoted,status:'rejected',decisionNote:'Signal dismissed',decidedAt:nowIso()});
        return json(res,200,{signal:issues[i]})}
      const id=improve.signalItemId(issues[i].id);const existing=improveRead(id);if(existing)return json(res,200,{item:existing});
      const item=improve.promoteSignal(issues[i],nowIso());storage.writeSetting(CLAUDE_FINDING_PREFIX+id,{sessionId:'improve',votes:{up:0,down:0},priorityBoost:0,decidedAt:null,file:'',area:'',scenario:'',fix:'',pr:'',...item});
      json(res,200,{item})}catch(e){storageError(res,e,500)}
  }
  function claudeSaveSession(input,at){
    const id=claudeSlug(input.sessionId||input.id,'default');const key=CLAUDE_SESSION_PREFIX+id;const prev=storage.readSetting(key,null)||{id,startedAt:at,eventCount:0};
    const session={...prev,id,title:claudeText(input.sessionTitle||input.title||prev.title||'Claude session',200),cwd:claudeText(input.cwd||prev.cwd||'',300),status:['active','idle','done','failed'].includes(input.sessionStatus)?input.sessionStatus:(prev.status||'active'),updatedAt:at};
    storage.writeSetting(key,session);return session;
  }
  function claudeNormalizeEvent(e,at){
    const status=CLAUDE_EVENT_STATUS.has(e.status)?e.status:'info';
    return {sessionId:claudeSlug(e.sessionId,'default'),at,kind:['action','phase','note','decision'].includes(e.kind)?e.kind:'action',tool:claudeText(e.tool,60),title:claudeText(e.title||e.tool||'Action',240),detail:claudeText(e.detail,1200),status,phase:claudeText(e.phase,120)};
  }
  function claudeNormalizeFinding(f,prev,at){
    const severity=['high','medium','low'].includes(f.severity)?f.severity:(prev?.severity||'medium');
    const status=Object.hasOwn(CLAUDE_STATUS,f.status)?f.status:(prev?.status||'proposed');
    return {
      id:claudeSlug(f.id,`finding-${claudeTimeKey()}`),sessionId:claudeSlug(f.sessionId||prev?.sessionId,'default'),
      title:claudeText(f.title||prev?.title||'Untitled finding',240),category:claudeSlug(f.category||prev?.category,'other'),severity,status,
      area:claudeText(f.area??prev?.area??'',120),file:claudeText(f.file??prev?.file??'',300),summary:claudeText(f.summary??prev?.summary??'',2000),
      scenario:claudeText(f.scenario??prev?.scenario??'',2000),fix:claudeText(f.fix??prev?.fix??'',2000),pr:claudeText(f.pr??prev?.pr??'',120),
      // Operator state survives re-reports.
      votes:prev?.votes||{up:0,down:0},priorityBoost:prev?.priorityBoost||0,decidedAt:prev?.decidedAt||null,...(prev?.decisionNote?{decisionNote:prev.decisionNote}:{}),
      // Improve's backlog fields are set only by the server, so they come from the stored item, never the request.
      ...Object.fromEntries(IMPROVE_FIELDS.filter(k=>prev&&prev[k]!==undefined).map(k=>[k,prev[k]])),
      createdAt:prev?.createdAt||at,updatedAt:at
    };
  }
  // Live sessions from each session's newest event: working while it is under 2 minutes old and not a Stop, otherwise
  // waiting (idle) until 30 minutes pass, then gone. Pure: pass the clock in.
  function claudeLive(sessions,events,now){
    const latest=new Map();
    for(const e of events){const t=Date.parse(e.at);if(Number.isFinite(t)&&(!latest.has(e.sessionId)||t>latest.get(e.sessionId).t))latest.set(e.sessionId,{t,title:e.title})}
    const live=[];
    for(const s of sessions){
      const last=latest.get(s.id);if(!last)continue; // events only: findings also bump updatedAt
      const age=now-last.t;if(age>=CLAUDE_LIVE_WINDOW_MS)continue;
      const stop=last.title===CLAUDE_STOP_TITLE;
      live.push({id:s.id,title:`${s.title||'Claude session'} · ${s.id.replace(/^cc-/,'')}`,state:!stop&&age<CLAUDE_LIVE_WORKING_MS?'working':'waiting',lastEvent:last.title,at:new Date(last.t).toISOString()});
    }
    return live.sort((a,b)=>(a.state==='working'?0:1)-(b.state==='working'?0:1)||b.at.localeCompare(a.at));
  }
  const claudeLiveNow=()=>claudeLive(storage.listSettings(CLAUDE_SESSION_PREFIX),storage.listSettings(CLAUDE_EVENT_PREFIX,{limit:CLAUDE_LIVE_SCAN_EVENTS}),Date.now());
  async function apiClaudeBoard(req,res,urlObj){
    const sessionId=urlObj.searchParams.get('session')||'';const limit=Math.max(1,Math.min(500,Number(urlObj.searchParams.get('events'))||150));
    const now=Date.now(),allFindings=claudeFindings();
    const sessions=claudeKeptSessions(storage.listSettings(CLAUDE_SESSION_PREFIX),allFindings).keep.map(s=>claudeSessionView(s,now));
    const events=storage.listSettings(CLAUDE_EVENT_PREFIX,{limit:sessionId?2000:limit,...(sessionId?{where:{sessionId}}:{})}).slice(0,limit);
    const findings=claudeRanked(allFindings.filter(f=>!sessionId||f.sessionId===sessionId));
    const byStatus={},byCategory={};
    for(const f of findings){byStatus[f.status]=(byStatus[f.status]||0)+1;const c=byCategory[f.category]||(byCategory[f.category]={high:0,medium:0,low:0,open:0,total:0});c[f.severity]++;c.total++;if(!['fixed','rejected'].includes(f.status))c.open++}
    const live=claudeLive(sessions,storage.listSettings(CLAUDE_EVENT_PREFIX,{limit:CLAUDE_LIVE_SCAN_EVENTS}),now);
    json(res,200,{sessions,events,live,findings,summary:{total:findings.length,byStatus,byCategory},statuses:Object.fromEntries(Object.entries(CLAUDE_STATUS).map(([k,v])=>[k,v.label]))});
  }
  async function apiClaudeEvents(req,res){
    try{const b=await readBody(req,512*1024);const list=Array.isArray(b.events)?b.events.slice(0,200):[b];const at=nowIso();
      storage.transaction(()=>{const touched=new Map();for(const raw of list){const e=claudeNormalizeEvent({...raw,sessionId:raw.sessionId||b.sessionId},at);storage.writeSetting(CLAUDE_EVENT_PREFIX+claudeTimeKey(),e);touched.set(e.sessionId,(touched.get(e.sessionId)||0)+1)}
        for(const [id,count] of touched){const s=claudeSaveSession({...b,sessionId:id},at);s.eventCount=(s.eventCount||0)+count;s.lastEvent=list.at(-1)?.title||'';s.lastEventAt=at;storage.writeSetting(CLAUDE_SESSION_PREFIX+id,s)}
        storage.pruneSettings(CLAUDE_EVENT_PREFIX,CLAUDE_MAX_EVENTS);claudePruneSessions()});
      json(res,201,{ok:true,accepted:list.length})}catch(e){storageError(res,e,400)}
  }
  async function apiClaudeFindings(req,res){
    try{const b=await readBody(req,1024*1024);const list=Array.isArray(b.findings)?b.findings.slice(0,300):[b];const at=nowIso();const saved=[],fresh=[];
      storage.transaction(()=>{if(b.sessionId)claudeSaveSession(b,at);for(const raw of list){const id=claudeSlug(raw.id,'');const prev=id?storage.readSetting(CLAUDE_FINDING_PREFIX+id,null):null;
        // signal-* and idea-* ids are Improve's: Claude may update those items, never create them.
        if(/^(signal|idea)-/.test(id)&&!prev)continue;
        // A new finding with no id that repeats one filed minutes ago (same title) updates that one; a finding with an id is matched by it.
        const dupe=!prev&&!id?improve.recentDuplicate(claudeFindings(),{title:raw.title,source:'claude'},at):null;
        const f=claudeNormalizeFinding({...raw,id:dupe?dupe.id:raw.id,sessionId:raw.sessionId||b.sessionId},prev||dupe,at);delete f.ownerTyped;/* Claude's words now, not only the owner's */storage.writeSetting(CLAUDE_FINDING_PREFIX+f.id,f);saved.push(f);if(!prev&&!dupe&&f.status==='proposed')fresh.push(f)}
        if(b.sessionId)claudePruneSessions()});
      // A new finding waiting for the owner's decision reaches the phone; re-posts of the same id don't.
      for(const f of fresh)notifier.notify({kind:'needs-you',title:'Claude needs your decision',body:f.title,url:'/?open=backlog',tag:`finding:${f.id}`});
      json(res,201,{ok:true,items:claudeRanked(saved)})}catch(e){storageError(res,e,400)}
  }
  function claudeUpdateFinding(res,id,mutate){
    const key=CLAUDE_FINDING_PREFIX+claudeSlug(id,'');const f=storage.readSetting(key,null);if(!f)return json(res,404,{error:'Finding not found'});
    mutate(f);f.updatedAt=nowIso();storage.writeSetting(key,f);json(res,200,{item:{...f,score:claudeScore(f)}});
  }
  async function apiClaudeVote(req,res){
    try{const b=await readBody(req);const delta=Number(b.delta);if(![1,-1].includes(delta))return json(res,400,{error:'delta must be 1 or -1'});
      claudeUpdateFinding(res,b.id,f=>{f.votes={up:f.votes?.up||0,down:f.votes?.down||0};if(delta>0)f.votes.up++;else f.votes.down++})}catch(e){storageError(res,e,400)}
  }
  async function apiClaudeDecision(req,res){
    try{const b=await readBody(req);if(!Object.hasOwn(CLAUDE_STATUS,b.status))return json(res,400,{error:`status must be one of ${Object.keys(CLAUDE_STATUS).join(', ')}`});
      let found=null;
      claudeUpdateFinding(res,b.id,f=>{found=f;f.status=b.status;f.decidedAt=nowIso();if(b.note!==undefined)f.decisionNote=claudeText(b.note,1000)});
      // The audit log names the finding; a decision on one that doesn't exist (404 above) isn't logged.
      if(found)recordActivity('claude',`Finding ${CLAUDE_STATUS[b.status].label.toLowerCase()}`,String(found.title||b.id||''),{findingId:b.id});
      if(found)retireChangeOfClosedItem({...found,status:b.status})}catch(e){storageError(res,e,400)}
  }
  // Closing an Improve item (fixed, rejected, set aside) ends its unfinished change too; otherwise the change keeps
  // counting as unfinished on Home and in "What needs me". Changes being shipped (approved) are left alone.
  const IMPROVE_CLOSED=['fixed','rejected','deferred'];
  function retireChangeOfClosedItem(item){
    if(!item?.changeId||!IMPROVE_CLOSED.includes(item.status))return false;
    const c=changeStore().find(x=>x.id===item.changeId);
    if(!c||!improve.LIVE_CHANGE.includes(c.status)||IMPROVE_LOCKED_CHANGE.includes(c.status))return false;
    improveRetireChange(c.id);return true;
  }
  // Items closed before the rule above left their changes open; end those once at start-up. Reopening an item later
  // doesn't revive its retired change (as with Discard): Start plans a new one.
  function retireChangesOfClosedItems(){let n=0;for(const f of claudeFindings())if(retireChangeOfClosedItem(f))n++;return n}
  // What Claude should work on next: open findings in rank order with the operator's decisions.
  async function apiClaudePriorities(req,res,urlObj){
    const open=claudeRanked(claudeFindings()).filter(f=>!['fixed','rejected','deferred'].includes(f.status));
    json(res,200,{generatedAt:nowIso(),items:open.slice(0,Math.max(1,Math.min(200,Number(urlObj.searchParams.get('limit'))||50))).map(({id,rank,score,title,category,severity,status,votes,file,fix,decisionNote})=>({id,rank,score,title,category,severity,status,votes,file,fix,decisionNote}))});
  }
  return { claudeLiveNow, apiChangeApprove, apiChangeCapabilities, apiChangeDeployResult, apiChangePlan, apiChangeRequestApply, apiChangeStage, apiChanges, apiClaudeBoard, apiClaudeDecision, apiClaudeEvents, apiClaudeFindings, apiClaudePriorities, apiClaudeVote, apiEngineeringRun, apiEngineeringRuns, apiEngineeringStart, apiImproveHandoff, apiImproveIdea, apiImproveItem, apiImproveItems, apiImproveSignal, changeStore, claudeFindings, decideChange, duplicateHtmlIds, duplicateTopLevelFunctions, effectiveEngineeringRuns, engineeringRunStore, generatePatchPlan, publicChange, retireChangesOfClosedItems, runImproveReconcile, runProcess, saveChanges, shipQueuedSelfChanges };
}

module.exports = { createChanges, CLAUDE_LIVE_WINDOW_MS, CLAUDE_MAX_SESSIONS, claudeKeptSessions, claudeSessionView };
