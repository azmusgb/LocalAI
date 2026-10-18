'use strict';

// Automations (scheduled prompts and research) and monitors (health checks, the morning brief), with their schedulers.
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createAutomations(ctx) {
  const { AUTOMATIONS_STORE, AUTOMATION_RUNS_STORE, MONITORS_STORE, activityStore, addNotification, automationRunStore, automationStore, featureAtLeast, getStatusAndRecordTransition, inFlight, json, makeId, normalizeTitle, notificationStore, nowIso, objectStore, readBody, recordActivity, requireFeature, runLocalModel, saveStore, searxSearch, storageError } = ctx;
  function nextRunFor(schedule,from=new Date()){
    const d=new Date(from); if(schedule==='hourly'){d.setMinutes(0,0,0);d.setHours(d.getHours()+1);return d.toISOString()} if(schedule==='daily'){d.setSeconds(0,0);d.setDate(d.getDate()+1);return d.toISOString()} return null;
  }
  async function executeAutomation(a){
    const runs=automationRunStore(); const run={id:makeId('autorun'),automationId:a.id,name:a.name,status:'running',startedAt:nowIso()};runs.unshift(run);saveStore(AUTOMATION_RUNS_STORE,runs,500);
    const untrack=inFlight.track('automation',a.name||'Automation');
    try{if(a.kind==='health'){const s=await getStatusAndRecordTransition();run.output=`Overall: ${s.overall}. ${s.services.map(x=>`${x.label}: ${x.state}`).join('; ')}`;}else if(a.kind==='research'){const rs=await searxSearch(a.prompt);run.output=await runLocalModel(`${a.prompt}\n\n${rs.map((x,i)=>`[${i+1}] ${x.title}\n${x.content}\n${x.url}`).join('\n\n')}`,'Summarize the research with source numbers.');}else{run.output=await runLocalModel(a.prompt||a.name)}run.status='complete'}catch(e){run.status='error';run.error=String(e.message||e)}finally{untrack()}run.finishedAt=nowIso();saveStore(AUTOMATION_RUNS_STORE,runs,500);recordActivity('automation',`Automation ${run.status}`,a.name,{automationId:a.id,runId:run.id});return run;
  }
  async function apiAutomations(req,res){if(!requireFeature(res,4))return;json(res,200,{items:automationStore(),runs:automationRunStore().slice(0,100)})}
  async function apiAutomationCreate(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req);const name=String(b.name||'').trim();if(!name)return json(res,400,{error:'name is required'});const items=automationStore();const schedule=['manual','hourly','daily'].includes(b.schedule)?b.schedule:'manual';const item={id:makeId('auto'),name:normalizeTitle(name,'Automation'),kind:['prompt','research','health'].includes(b.kind)?b.kind:'prompt',prompt:String(b.prompt||'').slice(0,10000),schedule,enabled:b.enabled!==false,createdAt:nowIso(),updatedAt:nowIso(),nextRunAt:schedule==='manual'?null:nextRunFor(schedule)};items.unshift(item);saveStore(AUTOMATIONS_STORE,items,250);json(res,201,{item})}catch(e){storageError(res,e,400)}}
  async function apiAutomationUpdate(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req);const items=automationStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Automation not found'});if(typeof b.enabled==='boolean')items[i].enabled=b.enabled;if(typeof b.name==='string'&&b.name.trim())items[i].name=normalizeTitle(b.name,'Automation');if(['manual','hourly','daily'].includes(b.schedule)){items[i].schedule=b.schedule;items[i].nextRunAt=b.schedule==='manual'?null:nextRunFor(b.schedule)}items[i].updatedAt=nowIso();saveStore(AUTOMATIONS_STORE,items,250);json(res,200,{item:items[i]})}catch(e){storageError(res,e,400)}}
  async function apiAutomationRun(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req);const a=automationStore().find(x=>x.id===b.id);if(!a)return json(res,404,{error:'Automation not found'});json(res,200,{run:await executeAutomation(a)})}catch(e){storageError(res,e,400)}}
  // Runs can outlast the 30s tick, so ticks never overlap and each automation's next run is claimed before it starts.
  let automationTickRunning=false;
  function automationDue(a){return a.enabled&&a.nextRunAt&&new Date(a.nextRunAt)<=new Date()}
  async function automationSchedulerTick(){if(!featureAtLeast(4)||automationTickRunning)return;automationTickRunning=true;try{for(const {id} of automationStore().filter(automationDue)){const items=automationStore();const a=items.find(x=>x.id===id);if(!a||!automationDue(a))continue;a.nextRunAt=nextRunFor(a.schedule);a.updatedAt=nowIso();saveStore(AUTOMATIONS_STORE,items,250);await executeAutomation(a)}}finally{automationTickRunning=false}}
  function monitorStore(){ return objectStore(MONITORS_STORE); }
  async function apiMonitors(req,res){
    if(!requireFeature(res,11))return;
    json(res,200,{items:monitorStore()});
  }
  async function apiMonitorCreate(req,res){
    if(!requireFeature(res,11))return;
    try{const b=await readBody(req);const items=monitorStore();const item={id:makeId('monitor'),name:normalizeTitle(b.name,'Monitor'),kind:String(b.kind||'health'),enabled:b.enabled!==false,createdAt:nowIso(),updatedAt:nowIso(),lastRunAt:null,lastState:'unknown'};items.unshift(item);saveStore(MONITORS_STORE,items,250);json(res,201,{item})}catch(e){storageError(res,e,400)}
  }
  async function runHealthMonitor(item){
    const s=await getStatusAndRecordTransition();const bad=s.services.filter(x=>x.state!=='HEALTHY');
    item.lastRunAt=nowIso();item.lastState=bad.length?'attention':'healthy';item.updatedAt=nowIso();
    if(bad.length)addNotification('monitor',`${item.name}: attention needed`,bad.map(x=>x.label).join(', '),{monitorId:item.id});
    return {overall:s.overall,affected:bad.map(x=>x.label)};
  }
  async function apiMonitorRun(req,res){
    if(!requireFeature(res,11))return;
    try{const b=await readBody(req);const items=monitorStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Monitor not found'});const result=await runHealthMonitor(items[i]);saveStore(MONITORS_STORE,items,250);json(res,200,{item:items[i],result})}catch(e){storageError(res,e,400)}
  }
  async function apiMorningBrief(req,res){
    if(!requireFeature(res,11))return;
    const s=await getStatusAndRecordTransition();const notes=notificationStore().filter(x=>!x.resolved).slice(0,8);const acts=activityStore().slice(0,8);
    json(res,200,{generatedAt:nowIso(),health:s.overall,notifications:notes,activity:acts});
  }
  async function monitorSchedulerTick(){
    if(!featureAtLeast(11))return;
    const items=monitorStore();let changed=false;const now=Date.now();
    for(const m of items){if(!m.enabled||m.kind!=='health')continue;const last=m.lastRunAt?new Date(m.lastRunAt).getTime():0;if(now-last<15*60*1000)continue;await runHealthMonitor(m);changed=true}
    if(changed)saveStore(MONITORS_STORE,items,250);
  }
  return { apiAutomationCreate, apiAutomationRun, apiAutomationUpdate, apiAutomations, apiMonitorCreate, apiMonitorRun, apiMonitors, apiMorningBrief, automationSchedulerTick, monitorSchedulerTick };
}

module.exports = { createAutomations };
