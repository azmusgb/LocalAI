// Improve › Backlog and Signals (roadmap sub-project 4). Items and signals come from /api/improve/items; every action
// posts to /api/improve/* and then reloads. In progress and Shipped arrive with task 5. Spec:
// docs/superpowers/specs/2026-10-15-improve-design.md.
(function(root){'use strict';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ICON={claude:'sparkle',signal:'alert',idea:'compose'};
const SOURCE={claude:'From Claude',signal:'Signal',idea:'Your idea'};
const TONE={high:'bad',medium:'attention',low:'neutral'};
const LABEL={high:'High',medium:'Medium',low:'Low'};
const st={data:null,openId:''};
const icon=n=>root.LocalAIKit?.icon(n)||'';
const ago=iso=>{const s=(Date.now()-new Date(iso))/1000;if(!isFinite(s))return '';if(s<3600)return Math.max(1,Math.round(s/60))+'m ago';if(s<86400)return Math.round(s/3600)+'h ago';return Math.round(s/86400)+'d ago'};
const sev=x=>`<span class="badge badge--${TONE[x]||'neutral'}">${LABEL[x]||'Medium'}</span>`;
async function post(path,body){return root.LocalAIUI.fetchJson(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
async function load(){st.data=await root.LocalAIUI.fetchJson('/api/improve/items',{cache:'no-store'});return st.data}

function backlogRow(it){
 const row=document.createElement('div');row.className='list-row improve-row';row.dataset.itemId=it.id;
 const net=(it.votes?.up||0)-(it.votes?.down||0);
 row.innerHTML=`<span class="list-row__icon" title="${SOURCE[it.source]||''}">${icon(ICON[it.source]||'sparkle')}</span>`+
  `<button type="button" class="improve-row__open list-row__main"><span class="list-row__title">${esc(it.title)}</span>`+
  `<span class="list-row__sub">${sev(it.severity)} <span>${SOURCE[it.source]||''}</span>${it.handedToClaude?' <span class="badge badge--accent">Handed to Claude</span>':''}</span></button>`+
  `<span class="list-row__trail improve-votes"><button type="button" class="icon-btn" data-vote="1" aria-label="Vote up: ${esc(it.title)}">▲</button><span aria-label="Net votes">${net}</span><button type="button" class="icon-btn" data-vote="-1" aria-label="Vote down: ${esc(it.title)}">▼</button></span>`;
 row.querySelector('.improve-row__open').onclick=()=>openItem(it.id);
 row.querySelectorAll('[data-vote]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await post('/api/claude/findings/vote',{id:it.id,delta:Number(b.dataset.vote)});await refresh()}catch(e){b.disabled=false;showToast(e.message)}});
 return row;
}
function renderBacklog(box,data){
 const items=(data.items||[]).filter(i=>i.stage==='backlog');
 box.replaceChildren(...items.map(backlogRow));return items.length>0;
}
function signalRow(s,inBacklog){
 const row=document.createElement('div');row.className='list-row improve-row';row.dataset.signalId=s.id;
 row.innerHTML=`<span class="list-row__icon">${icon('alert')}</span><span class="list-row__main"><span class="list-row__title">${esc(s.name)}</span>`+
  `<span class="list-row__sub">${sev(s.severity)} Seen ${Number(s.occurrences)||1} time${Number(s.occurrences)===1?'':'s'} · ${esc(ago(s.lastSeenAt||s.updatedAt))}${inBacklog?' · In the Backlog':''}</span></span>`+
  `<span class="list-row__trail">${inBacklog?'':'<button type="button" class="btn-outline" data-act="promote">Promote</button>'}<button type="button" class="btn-outline" data-act="dismiss">Dismiss</button></span>`;
 row.querySelectorAll('[data-act]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await post('/api/improve/signal',{id:s.id,action:b.dataset.act});await refresh()}catch(e){b.disabled=false;showToast(e.message)}});
 return row;
}
function renderSignals(box,data){
 const have=new Set((data.items||[]).map(i=>i.id)),open=(data.signals||[]).filter(s=>s.status==='open');
 box.replaceChildren(...open.map(s=>signalRow(s,have.has('signal-'+s.id))));return open.length>0;
}
async function loadDetails(){
 const box=$('signalsScan');if(!box)return;
 await root.LocalAIUI.loadInto(box,()=>root.LocalAIUI.fetchJson('/api/quality',{cache:'no-store'}),{what:'the quality checks',empty:'No checks have run yet.',render:(el,q)=>{
  const checks=[...(q.latest?.checks||[])].sort((a,b)=>(a.result==='FAIL'?0:1)-(b.result==='FAIL'?0:1));
  const events=(q.events||[]).slice(0,10);
  if(!checks.length&&!events.length)return false;
  el.innerHTML=`${checks.length?`<h3>Latest checks</h3><ul class="improve-checks">${checks.map(c=>`<li><span class="badge badge--${c.result==='FAIL'?'bad':'good'}">${c.result==='FAIL'?'Failed':'Passed'}</span> ${esc(c.name)}${c.detail?` <span class="list-row__sub">${esc(c.detail)}</span>`:''}</li>`).join('')}</ul>`:''}`+
   `${events.length?`<h3>Recent browser errors</h3><ul class="improve-checks">${events.map(e=>`<li>${esc(e.message)} <span class="list-row__sub">${esc(e.source||'')} · ${esc(ago(e.createdAt))}</span></li>`).join('')}</ul>`:''}`;
  return true}});
}

function openItem(id){
 const it=(st.data?.items||[]).find(i=>i.id===id);const d=$('improveItemSheet');if(!it||!d)return;st.openId=id;
 $('improveItemTitle').textContent=it.title;
 $('improveItemBody').innerHTML=`<p class="list-row__sub">${sev(it.severity)} ${SOURCE[it.source]||''}${it.handedToClaude?' · Handed to Claude':''}</p>`+
  (it.summary?`<p>${esc(it.summary)}</p>`:'')+(it.fix?`<p><strong>Suggested fix:</strong> ${esc(it.fix)}</p>`:'')+(it.file?`<p><code>${esc(it.file)}</code></p>`:'')+(it.decisionNote?`<p class="list-row__sub">${esc(it.decisionNote)}</p>`:'');
 const acts=[['start','Start','btn-primary'],...(it.handedToClaude?[]:[['handToClaude','Hand to Claude','btn-outline']]),['moveToTop','Move to top','btn-outline'],['defer','Defer','btn-outline'],['reject','Reject','btn-outline']];
 const box=$('improveItemActions');box.innerHTML=acts.map(([a,l,c])=>`<button type="button" class="${c}" data-item-act="${a}">${l}</button>`).join('');
 box.querySelectorAll('[data-item-act]').forEach(b=>b.onclick=()=>itemAction(it.id,b.dataset.itemAct,b));
 $('improveItemError').hidden=true;if(!d.open)d.showModal();
}
async function itemAction(id,action,btn){
 const err=$('improveItemError');btn.disabled=true;
 try{await post('/api/improve/item',{id,action});$('improveItemSheet').close();await refresh()}
 catch(e){err.textContent=e.message;err.hidden=false;btn.disabled=false}
}
function openIdea(){const d=$('improveIdeaSheet');if(!d)return;$('improveIdeaText').value='';$('improveIdeaError').hidden=true;d.showModal();$('improveIdeaText').focus()}
async function submitIdea(start,btn){
 const text=$('improveIdeaText').value,err=$('improveIdeaError');
 if(!text.trim()){err.textContent='Describe the change first.';err.hidden=false;return}
 btn.disabled=true;
 try{const r=await post('/api/improve/idea',{text,start});await refresh();if(r.error){err.textContent=r.error;err.hidden=false}else $('improveIdeaSheet').close()}
 catch(e){err.textContent=e.message;err.hidden=false}
 finally{btn.disabled=false}
}
async function runChecks(btn){if(btn)btn.disabled=true;try{await post('/api/issues/scan',{});await refresh();loadDetails()}catch(e){showToast(e.message)}finally{if(btn)btn.disabled=false}}
function showToast(m){const t=$('toast');if(!t)return;t.textContent=m;t.classList.add('show');clearTimeout(t._hide);t._hide=setTimeout(()=>t.classList.remove('show'),3000)}

// One request feeds both lists; each list shows its own error state if it fails.
async function refresh(){
 const p=load();
 // The first call shares this refresh's request; a Retry from the error state fetches again.
 const once=()=>{let first=true;return()=>{if(first){first=false;return p}return load()}};
 const opts=(render,what,empty)=>({render,what,empty});
 await Promise.all([
  $('backlogList')&&root.LocalAIUI.loadInto($('backlogList'),once(),opts(renderBacklog,'the backlog','Nothing in the Backlog. Add an idea, or promote a Signal.')),
  $('signalsList')&&root.LocalAIUI.loadInto($('signalsList'),once(),opts(renderSignals,'the signals','No open Signals. Local AI looks healthy.'))
 ]).catch(()=>{});
}
function init(){
 if(!$('backlog'))return;
 $('improveNewIdea').onclick=openIdea;$('signalsRunChecks').onclick=e=>runChecks(e.currentTarget);
 document.querySelectorAll('[data-idea-start]').forEach(b=>b.onclick=()=>submitIdea(b.dataset.ideaStart==='true',b));
 const register=()=>{root.LocalAIShell?.setAction('backlog',{icon:'plus',label:'New idea',onClick:openIdea});root.LocalAIShell?.setAction('signals',{icon:'refresh',label:'Run checks now',onClick:()=>runChecks()})};
 if(root.LocalAIShell)register();else root.addEventListener('load',register,{once:true});
 for(const id of ['backlog','signals']){const sec=$(id);let was=sec.classList.contains('active');
  new MutationObserver(()=>{const now=sec.classList.contains('active');if(now&&!was){refresh();if(id==='signals')loadDetails()}was=now}).observe(sec,{attributes:true,attributeFilter:['class']});
  if(was){refresh();if(id==='signals')loadDetails()}}
}
root.LocalAIImprove={refresh,openItem};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
