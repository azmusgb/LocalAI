'use strict';

// Quality: browser error reports, the self-check scan, and Issues (problems detected, upserted, scanned on a timer).
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createQuality(ctx) {
  const { APP_DIR, PUBLIC_DIR, SELF_APP_ROOT, addNotification, changeStore, duplicateHtmlIds, duplicateTopLevelFunctions, featureAtLeast, fs, generatePatchPlan, getStatusAndRecordTransition, json, makeId, nowIso, objectStore, path, prependRecord, publicChange, readBody, recordActivity, requireFeature, runImproveReconcile, runProcess, saveChanges, saveStore, storageError } = ctx;
  // ===== END CHANGE INTELLIGENCE =============================================



  // ===== QUALITY INTELLIGENCE (v1.14+) =========================================
  const QUALITY_EVENTS_STORE = 'qualityEvents';
  const QUALITY_SCANS_STORE = 'qualityScans';
  function qualityEventStore(){return objectStore(QUALITY_EVENTS_STORE)}
  function qualityScanStore(){return objectStore(QUALITY_SCANS_STORE)}
  function qualitySeverity(type,message){
    const t=String(type||'').toLowerCase(),m=String(message||'').toLowerCase();
    if(t==='error'||/uncaught|syntaxerror|referenceerror|typeerror|failed to load/.test(m))return 'high';
    if(t==='rejection'||/timeout|degraded|warning/.test(m))return 'medium';
    return 'low';
  }
  async function apiQualityClientEvent(req,res){
    if(!requireFeature(res,14))return;
    try{
      const b=await readBody(req,256*1024);const message=String(b.message||'').slice(0,4000);if(!message)return json(res,400,{error:'message is required'});
      // Opaque cross-origin errors carry no file, line or stack and can't be acted on (older cached pages still send them).
      if(/^Script error\.?$/.test(message.trim())&&!b.stack&&!Number(b.line))return json(res,202,{ignored:true,reason:'opaque script error'});
      const item={id:makeId('qevt'),type:String(b.type||'error').slice(0,40),severity:qualitySeverity(b.type,message),message,source:String(b.source||'').slice(0,1000),line:Number(b.line)||null,column:Number(b.column)||null,stack:String(b.stack||'').slice(0,12000),url:String(b.url||'').slice(0,1200),userAgent:String(req.headers['user-agent']||'').slice(0,300),createdAt:nowIso()};
      prependRecord(QUALITY_EVENTS_STORE,item);recordActivity('quality','Client quality event',message.slice(0,180),{qualityEventId:item.id,severity:item.severity});json(res,201,{item});
    }catch(e){storageError(res,e,400)}
  }
  function referencedDomIds(jsText){const ids=new Set();const rx=/\$\(['"]([^'"]+)['"]\)/g;let m;while((m=rx.exec(String(jsText||''))))ids.add(m[1]);return [...ids]}
  function htmlIds(htmlText){const ids=new Set();const rx=/\bid=["']([^"']+)["']/g;let m;while((m=rx.exec(String(htmlText||''))))ids.add(m[1]);return ids}
  async function runQualityScan(){
    const checks=[];const add=(name,result,detail='')=>{const normalized=typeof result==='string'?result:(result?'PASS':'FAIL');checks.push({name,result:['PASS','WARN','FAIL'].includes(normalized)?normalized:'FAIL',detail:String(detail||'').slice(0,3000)})};
    const serverFile=path.join(APP_DIR,'server.js'),appFile=path.join(PUBLIC_DIR,'app.js'),swFile=path.join(PUBLIC_DIR,'sw.js'),htmlFile=path.join(PUBLIC_DIR,'index.html');
    const serverModules=fs.existsSync(path.join(APP_DIR,'server'))?fs.readdirSync(path.join(APP_DIR,'server')).filter(f=>f.endsWith('.js')).map(f=>['server/'+f,path.join(APP_DIR,'server',f)]):[]; // the split-out server modules count as the server
    for(const [name,file] of [['server.js',serverFile],...serverModules,['app.js',appFile],['sw.js',swFile]]){if(fs.existsSync(file)){const r=await runProcess('node',['--check',file],APP_DIR);add(`syntax ${name}`,r.code===0,r.stderr||r.stdout)}else add(`syntax ${name}`,false,'file missing')}
    if(fs.existsSync(appFile)){const app=fs.readFileSync(appFile,'utf8');const dup=duplicateTopLevelFunctions(app);add('duplicate browser functions',dup.length===0,dup.join(', '));if(fs.existsSync(htmlFile)){const html=fs.readFileSync(htmlFile,'utf8'),ids=htmlIds(html),refs=referencedDomIds(app);const uiFile=path.join(PUBLIC_DIR,'ui.js');if(fs.existsSync(uiFile)){const ui=fs.readFileSync(uiFile,'utf8');for(const id of htmlIds(ui))ids.add(id);for(const m of ui.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g))ids.add(m[1])}const missing=refs.filter(x=>!ids.has(x));add('DOM reference contract',missing.length===0,missing.length?`Missing IDs: ${missing.slice(0,40).join(', ')}`:`${refs.length} referenced IDs resolved`)}}
    if(fs.existsSync(htmlFile)){const dup=duplicateHtmlIds(fs.readFileSync(htmlFile,'utf8'));add('duplicate HTML ids',dup.length===0,dup.join(', '))}
    try{const st=await getStatusAndRecordTransition();const coreBad=st.services.filter(x=>x.required!==false&&x.state!=='HEALTHY'),optionalBad=st.services.filter(x=>x.required===false&&x.state!=='HEALTHY');if(coreBad.length)add('service health','FAIL',coreBad.map(x=>`${x.label}:${x.state}`).join(', '));else if(optionalBad.length)add('service health','WARN',`Optional: ${optionalBad.map(x=>`${x.label}:${x.state}`).join(', ')}`);else add('service health','PASS',st.overall)}catch(e){add('service health','FAIL',String(e.message||e))}
    const recent=qualityEventStore().filter(x=>Date.now()-new Date(x.createdAt).getTime()<24*60*60*1000);const high=recent.filter(x=>x.severity==='high'&&!issueSettled(issueStore(),'browser-runtime',x.message,x.createdAt));add('browser runtime 24h',high.length===0,high.length?`${high.length} unresolved high-severity event(s)`:`${recent.length} event(s), no unresolved high-severity errors`);
    const scan={id:makeId('qscan'),createdAt:nowIso(),passed:checks.every(x=>x.result!=='FAIL'),checks,summary:{pass:checks.filter(x=>x.result==='PASS').length,warn:checks.filter(x=>x.result==='WARN').length,fail:checks.filter(x=>x.result==='FAIL').length,events24h:recent.length,high24h:high.length}};
    prependRecord(QUALITY_SCANS_STORE,scan);return scan;
  }
  async function apiQuality(req,res){if(!requireFeature(res,14))return;const scans=qualityScanStore(),events=qualityEventStore();json(res,200,{latest:scans[0]||null,scans:scans.slice(0,20),events:events.slice(0,80),summary:{events:events.length,high:events.filter(x=>x.severity==='high').length}})}
  async function apiQualityScan(req,res){if(!requireFeature(res,14))return;try{const scan=await runQualityScan();recordActivity('quality',scan.passed?'Quality scan passed':'Quality scan found issues',`${scan.summary.pass} pass / ${scan.summary.warn||0} warn / ${scan.summary.fail} fail`,{scanId:scan.id});json(res,200,{scan})}catch(e){storageError(res,e,500)}}
  // ===== END QUALITY INTELLIGENCE =============================================



  // ===== AUTONOMOUS ISSUE DETECTION (v1.15+) ==================================
  const ISSUES_STORE = 'issues';
  function issueStore(){return objectStore(ISSUES_STORE)}
  function saveIssues(items){saveStore(ISSUES_STORE,items,500)}
  function issueKey(kind,name){return `${String(kind||'issue').toLowerCase()}:${String(name||'unknown').toLowerCase().replace(/\s+/g,' ').slice(0,240)}`}
  // When an issue was closed: by the operator (resolvedAt), by a passing scan (autoResolvedAt), or ignored.
  function issueClosedAt(item){return item.resolvedAt||item.autoResolvedAt||(item.status==='ignored'?item.updatedAt:null)||item.updatedAt}
  // True when this occurrence was already counted, or happened before the issue was resolved or ignored.
  function issueSettled(items,kind,name,seenAt){
    const item=items.find(x=>x.key===issueKey(kind,name));if(!item||!seenAt)return false;
    if(item.lastEventAt&&seenAt<=item.lastEventAt&&item.status!=='open')return true;
    return ['resolved','ignored'].includes(item.status)&&seenAt<=issueClosedAt(item);
  }
  // spec.seenAt is when the problem happened (a browser error's time); scans that re-read old events pass it so a
  // past error is counted once and does not reopen an issue resolved after it.
  function upsertIssue(items,spec){
    const key=issueKey(spec.kind,spec.name),seenAt=spec.seenAt||nowIso();let item=items.find(x=>x.key===key&&x.status!=='ignored');
    if(item){
      if(item.lastEventAt&&seenAt<=item.lastEventAt)return item;
      if(item.status==='resolved'&&seenAt<=issueClosedAt(item))return item;
      item.lastSeenAt=seenAt;item.lastEventAt=seenAt;item.occurrences=(item.occurrences||1)+1;item.detail=String(spec.detail||item.detail||'').slice(0,5000);item.severity=spec.severity||item.severity;item.updatedAt=nowIso();if(item.status==='resolved'){item.status='open';delete item.resolvedAt}return item}
    if(items.some(x=>x.key===key&&x.status==='ignored'&&seenAt<=issueClosedAt(x)))return null;
    item={id:makeId('issue'),key,kind:spec.kind||'quality',name:String(spec.name||'Issue').slice(0,500),detail:String(spec.detail||'').slice(0,5000),severity:spec.severity||'medium',status:'open',occurrences:1,createdAt:nowIso(),updatedAt:nowIso(),lastSeenAt:seenAt,lastEventAt:seenAt,changeId:null};items.unshift(item);return item;
  }
  async function detectIssues(){
    const scan=await runQualityScan();const items=issueStore();const seen=[];
    for(const c of scan.checks.filter(x=>x.result==='FAIL')){const sev=/service health|syntax|duplicate|DOM/.test(c.name)?'high':'medium';const item=upsertIssue(items,{kind:'quality-check',name:c.name,detail:c.detail,severity:sev});if(item)seen.push(item.id)}
    const recent=qualityEventStore().filter(x=>Date.now()-new Date(x.createdAt).getTime()<24*60*60*1000&&x.severity==='high').slice(0,50);
    // Oldest first, so each event is compared with the ones counted before it.
    for(const e of [...recent].reverse()){const item=upsertIssue(items,{kind:'browser-runtime',name:e.message.slice(0,220),detail:`${e.source||''}${e.line?`:${e.line}`:''}\n${e.stack||''}`.trim(),severity:'high',seenAt:e.createdAt});if(item)seen.push(item.id)}
    for(const item of items){if(item.kind==='quality-check'&&item.status==='open'&&!seen.includes(item.id)){item.status='resolved';item.autoResolvedAt=nowIso();item.updatedAt=nowIso()}}
    saveIssues(items);runImproveReconcile();return {scan,items:items.slice(0,200),detected:seen.length,open:items.filter(x=>x.status==='open').length};
  }
  async function apiIssues(req,res){if(!requireFeature(res,15))return;const items=issueStore();json(res,200,{items:items.slice(0,250),open:items.filter(x=>x.status==='open').length,high:items.filter(x=>x.status==='open'&&x.severity==='high').length})}
  async function apiIssuesScan(req,res){if(!requireFeature(res,15))return;try{const r=await detectIssues();recordActivity('issue',r.open?'Issue scan complete':'Issue scan clear',`${r.open} open issue(s)`,{detected:r.detected});if(r.open)addNotification('issue','Quality issues detected',`${r.open} issue(s) are open; ${r.items.filter(x=>x.status==='open'&&x.severity==='high').length} high severity.`,{});json(res,200,r)}catch(e){storageError(res,e,500)}}
  async function apiIssueUpdate(req,res){if(!requireFeature(res,15))return;try{const b=await readBody(req);const items=issueStore(),i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Issue not found'});if(['open','resolved','ignored'].includes(b.status)){items[i].status=b.status;if(b.status==='resolved')items[i].resolvedAt=nowIso();else delete items[i].resolvedAt}items[i].updatedAt=nowIso();saveIssues(items);json(res,200,{item:items[i]})}catch(e){storageError(res,e,400)}}
  async function apiIssuePrepareChange(req,res){
    if(!requireFeature(res,15))return;
    try{const b=await readBody(req);const issues=issueStore(),ii=issues.findIndex(x=>x.id===b.id);if(ii<0)return json(res,404,{error:'Issue not found'});const issue=issues[ii];const request=`Fix this Local AI issue while preserving existing behavior.\nIssue: ${issue.name}\nSeverity: ${issue.severity}\nDetails:\n${issue.detail}`;const plan=await generatePatchPlan(request,SELF_APP_ROOT,{stay:'Health-check issues stay on this PC'});const changes=changeStore();const item={id:makeId('chg'),target:'self',root:'app',request,summary:plan.summary,notes:`Prepared from issue ${issue.id}. ${plan.notes||''}`.trim(),files:plan.files,status:plan.files.length?'planned':'needs_context',createdAt:nowIso(),updatedAt:nowIso(),validation:null,diffs:[],sourceIssueId:issue.id,route:plan.route};changes.unshift(item);saveChanges(changes);issue.changeId=item.id;issue.updatedAt=nowIso();saveIssues(issues);recordActivity('issue','Issue promoted to change',issue.name,{issueId:issue.id,changeId:item.id});json(res,201,{issue,item:publicChange(item)})}catch(e){storageError(res,e,500)}
  }
  async function issueSchedulerTick(){if(!featureAtLeast(15))return;try{await detectIssues()}catch{}}
  return { apiIssuePrepareChange, apiIssueUpdate, apiIssues, apiIssuesScan, apiQuality, apiQualityClientEvent, apiQualityScan, issueSchedulerTick, issueStore, saveIssues };
}

module.exports = { createQuality };
