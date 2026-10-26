// Needs you: which runs Home lists under "Needs you", and how repeats of one goal fold into one row. Shared by Home
// (window.LocalAINeedsYou), the server's Work filter (/api/runs?threads=1&kind=needs) and tests/needs-you.test.cjs, so
// Home, Work, the phone and the desktop agree.
// A run needs you when it is the latest turn of its thread and
//  - it waits for your approval: always, however old, until you decide; or
//  - it failed, and none of these is true: you opened it (on any device: the server keeps `seenAt`), it failed more than
//    a day ago, or something newer answers it (a retry of it, or a later run of the same goal that didn't fail).
// Every run stays in Work either way; this only decides what Home asks you about.
(function(root){'use strict';
const DAY=864e5,ms=v=>Date.parse(v)||0,started=r=>ms(r.createdAt||r.updatedAt),failedAt=r=>ms(r.finishedAt||r.updatedAt||r.createdAt);
// One goal: the same kind of run with the same words (a mission's goal, an image's prompt, a chat's first message).
const goal=r=>`${r.type||''}|${String(r.threadTitle||r.title||r.card?.title||'').replace(/\s+/g,' ').trim().toLowerCase()}`;
function pick(runs,{now=Date.now()}={}){
 const list=(runs||[]).filter(Boolean),latest=new Map(),answered=new Map(),retried=new Set();
 for(const r of list){
  const k=r.threadId||r.id,p=latest.get(k);
  if(!p||started(r)>started(p)||(started(r)===started(p)&&String(r.id)>String(p.id)))latest.set(k,r);
  if(r.retryOf)retried.add(r.retryOf);
  if(r.status!=='failed'&&r.status!=='cancelled'){const g=goal(r);answered.set(g,Math.max(answered.get(g)||0,started(r)))}
 }
 const needs=r=>r.status==='awaiting_approval'||(r.status==='failed'&&!r.seenAt&&now-failedAt(r)<DAY&&!retried.has(r.id)&&!((answered.get(goal(r))||0)>started(r)));
 const rank=r=>r.status==='awaiting_approval'?0:1;
 return [...latest.values()].filter(needs).sort((a,b)=>rank(a)-rank(b)||failedAt(b)-failedAt(a)||String(b.id).localeCompare(String(a.id)));
}
// Failures of one goal become one entry (newest first, `runs` holds them all); anything else stays one entry each.
function group(runs){
 const out=[],by=new Map();
 for(const r of runs||[]){
  if(r.status!=='failed'){out.push({run:r,runs:[r]});continue}
  const g=goal(r),e=by.get(g);if(e){e.runs.push(r);continue}
  const n={run:r,runs:[r]};by.set(g,n);out.push(n);
 }
 return out;
}
// Home's Recent, newest first: leaves out what Needs you shows (the same run or thread), and folds repeats of one
// automation (an hourly check) into its newest run, so one schedule can't fill the list. At most n rows.
function recent(items,shown,n=6){
 const key=r=>r.threadId||r.id,skip=new Set((shown||[]).map(key)),seen=new Set(),out=[];
 for(const r of items||[]){
  if(!r||skip.has(key(r)))continue;
  const a=r.meta?.automationId;if(a){if(seen.has(a))continue;seen.add(a)}
  out.push(r);if(out.length>=n)break;
 }
 return out;
}
// Opening a failed run (here, or from Work, on any device) marks it seen; once per run per page load.
const posted=new Set();
function markSeen(ids){
 const fresh=(ids||[]).map(String).filter(id=>id&&!posted.has(id));if(!fresh.length||typeof fetch!=='function')return Promise.resolve(false);
 fresh.forEach(id=>posted.add(id));
 return fetch('/api/runs/seen',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:fresh})}).then(r=>r.ok,()=>false).then(ok=>{if(!ok)fresh.forEach(id=>posted.delete(id));return ok});
}
// Pi Hub's one "Needs you" list (/api/home/hub-needs) on Home: every item but localai:needs-<n>, the hub's one-line
// summary of the approvals and failures Home already lists as its own rows. Each row says where it opens: Local AI's
// own lab and watch items open here (Print lab, Health); the rest open on Pi Hub at the item's path.
const TONES=new Set(['bad','attention','warn']);
const text=v=>typeof v==='string'?v:'';
function hubRows(items){
 if(!Array.isArray(items))return [];
 return items.filter(i=>i&&typeof i==='object'&&text(i.id)&&text(i.title)&&!/^localai:needs-/.test(i.id)).map(i=>{
  const id=i.id,lab=/^localai:(judge|lab)-/.test(id);
  return {id,title:i.title,detail:text(i.detail),tone:TONES.has(i.tone)?i.tone:'warn',open:lab?{view:'printLab'}:/^localai:/.test(id)?{view:'status'}:{hub:text(i.link)||'/'}};
 });
}
// Bad first, then attention, then warn (Pi Hub's order); the same tone keeps its order.
const RANK={bad:0,attention:1,warn:2};
const byTone=list=>list.map((x,i)=>[x,i]).sort((a,b)=>(RANK[a[0].tone]??2)-(RANK[b[0].tone]??2)||a[1]-b[1]).map(p=>p[0]);
const api={pick,group,recent,markSeen,goal,hubRows,byTone,DAY};
if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalAINeedsYou=api;
})(typeof window!=='undefined'?window:globalThis);
