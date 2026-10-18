// Local AI interface scripts: one deferred file. Each section is its own scope and keeps the name of the file it
// replaced; they run in the order the separate scripts used to run.

// ==== ui-kit.js ====
(()=>{'use strict';
const STATUS={awaiting_approval:['Ready to review','accent'],ready:['Ready to review','accent'],needs_attention:['Needs a look','attention'],applied:['Done','good'],completed:['Done','good'],answered:['Done','good'],running:['Running','accent'],failed:['Failed','bad'],error:['Failed','bad'],validation_failed:['Needs a look','bad'],patch_failed:['Needs a look','bad'],rejected:['Rejected','neutral'],cancelled:['Cancelled','neutral'],queued:['Queued','neutral'],down:['Down','bad'],healthy:['Healthy','good'],optional_offline:['Offline','neutral']};
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
function icon(name,cls){return '<svg class="icon'+(cls?' '+esc(cls):'')+'" aria-hidden="true"><use href="#i-'+esc(name)+'"/></svg>'}
function statusBadge(status){const key=String(status??'').trim().toLowerCase();const hit=STATUS[key];if(hit)return{label:hit[0],tone:hit[1]};const raw=String(status??'').trim().replace(/[_-]+/g,' ');return{label:raw?raw.charAt(0).toUpperCase()+raw.slice(1).toLowerCase():'Unknown',tone:'neutral'}}
function badgeHtml(status){const b=statusBadge(status);return '<span class="badge badge--'+b.tone+'">'+esc(b.label)+'</span>'}
window.LocalAIKit=Object.freeze({icon,statusBadge,badgeHtml});
})();

// ==== agent-specialists.js ====
(()=>{'use strict';
let catalog=[],selected='ux_analyst',source=null,currentMission=null,history=[],activeInspectorId='';
const $=id=>document.getElementById(id);
// One shared mission EventSource per tab (agent-specialists.js and agent-world-city.js both subscribe; whichever loads first creates it).
const missionStream=window.LocalAIMissionStream||(window.LocalAIMissionStream=(()=>{
 // Open only while Missions is on screen and the tab is visible: nothing else shows live mission state, and a stream
 // held open on every page keeps phones' connections awake and the page from ever going network-idle. Each (re)open
 // calls subscribers' onOpen, so they refetch what happened while it was closed.
 const subs=new Set();let es=null;
 const wanted=()=>document.visibilityState==='visible'&&!!document.querySelector('#agents.active');
 function open(){if(es)return;const s=new EventSource('/api/agents/missions/events');es=s;s.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}for(const x of[...subs])try{x.onMessage?.(m)}catch{}};s.onopen=()=>{for(const x of[...subs])try{x.onOpen?.()}catch{}};s.onerror=e=>{for(const x of[...subs])try{x.onError?.(e)}catch{}}}
 function close(){if(!es)return;es.close();es=null}
 function sync(){if(subs.size&&wanted())open();else close()}
 function watch(){const v=document.getElementById('agents');if(v)new MutationObserver(sync).observe(v,{attributes:true,attributeFilter:['class']});document.addEventListener('visibilitychange',sync);sync()}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watch,{once:true});else watch();
 return{subscribe(onMessage,onError,onOpen){const sub={onMessage,onError,onOpen};subs.add(sub);try{sync()}catch(e){subs.delete(sub);throw e}return()=>{subs.delete(sub);sync()}},isOpen:()=>!!es}})());
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
async function req(u,o){const r=await fetch(u,o),j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||('HTTP '+r.status));return j}
function notice(kind,text,actions=''){const el=$('agentInlineNotice');if(!el)return;el.dataset.kind=kind||'info';el.innerHTML='<div><strong>'+esc(kind==='error'?'Needs attention':kind==='success'?'Complete':'Status')+'</strong><span>'+esc(text)+'</span></div>'+actions;el.hidden=false}
function clearNotice(){const el=$('agentInlineNotice');if(el)el.hidden=true}
function humanState(s){return ({pending:'Waiting',running:'Running',complete:'Complete',error:'Needs attention',blocked:'Blocked',needs_attention:'Needs attention',awaiting_approval:'Awaiting approval',apply_requested:'Deployment queued',applied:'Applied'})[s]||String(s||'Unknown').replaceAll('_',' ')}
function cards(){const el=$('specialistRegistry');if(!el)return;el.innerHTML=catalog.filter(a=>!a.infrastructure).map(a=>`<button class="agent-card ${a.id===selected?'active':''}" data-spec="${esc(a.id)}"><span class="agent-card__icon">${esc((a.name||a.id)[0])}</span><span><strong>${esc(a.name)}</strong><small>${esc(a.description)}</small><span class="agent-meta">${(a.capabilities||[]).slice(0,4).map(x=>`<span class="statuschip">${esc(x)}</span>`).join('')}</span></span></button>`).join('');el.querySelectorAll('[data-spec]').forEach(b=>b.onclick=()=>{selected=b.dataset.spec;cards();updateDirectActionLabel()})}
function updateDirectActionLabel(){const a=catalog.find(x=>x.id===selected);const b=$('specialistRunBtn');if(b)b.textContent='Run '+(a?.name||'specialist')}
// Workers' model (developer tools only): an installed model every specialist in the mission uses; empty is Automatic.
function workerModel(){if(document.body.classList.contains('dev-tools-off'))return'';return $('agentWorkerModel')?.value||''}
let workerModelsLoaded=false;
async function loadWorkerModels(){const sel=$('agentWorkerModel');if(!sel||workerModelsLoaded)return;try{const items=(await req('/api/agents/models')).items||[];const keep=sel.value;sel.innerHTML='<option value="">Automatic</option>'+items.map(m=>`<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');sel.value=items.some(m=>m.name===keep)?keep:'';workerModelsLoaded=true}catch{}}
function manualIds(){return $('manualRouteToggle')?.checked?[...document.querySelectorAll('[data-mission-agent]:checked')].map(x=>x.value):undefined}
function renderRoute(r){const el=$('routePreview');if(!el||!r)return;el.innerHTML=`<div class="route-head"><div><strong>${esc(r.mode==='auto'?'Automatic mission plan':'Manual mission plan')}</strong><small>${esc(r.reason||'')}</small></div><span class="statuschip">${r.workers?.length||0} specialists</span></div><div class="route-flow">${(r.workers||[]).map((w,i)=>{const m=w.routingMeta||{};return `<div class="route-step"><span class="route-step__n">${i+1}</span><span><strong>${esc(w.name)}</strong><small>${esc(w.model||'Auto model')}</small><div class="route-scorebar"><i style="width:${Math.max(0,Math.min(100,m.capabilityScore||0))}%"></i></div><small>Capability ${m.capabilityScore??'—'}% · model fit ${m.modelScore??'—'}% · ${esc(m.availability||'available')}</small><small>${esc(w.reason||'')}</small>${w.dependsOn?.length?`<small>After: ${esc(w.dependsOn.join(', '))}</small>`:''}${m.retryPolicy?.fallbackAgentId?`<small>Fallback: ${esc(m.retryPolicy.fallbackAgentId)}</small>`:''}</span></div>`}).join('')}</div>`}
async function preview(){const goal=$('agentGoal')?.value.trim();if(!goal){notice('error','Say what the team should do first.');return}clearNotice();const body={goal};const ids=manualIds();if(ids?.length)body.agentIds=ids;const wm=workerModel();if(wm)body.workerModel=wm;const j=await req('/api/agents/dispatch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});renderRoute(j.routing);$('routePreviewWrap')?.removeAttribute('hidden');return j.routing}
function planState(plan){return (plan||[]).map((s,i)=>`<div class="timeline-step ${esc(s.state)}"><span class="timeline-dot"></span><span><strong>${esc(s.name)}</strong><small>${humanState(s.state)}</small></span></div>`).join('')}
function renderRun(r){const el=$('specialistExecution');if(!el)return;el.innerHTML=`<div class="detail-head"><div><span class="eyebrow">Direct specialist</span><h3>${esc(r.agentName)}</h3></div><span class="statuschip ${esc(r.status)}">${humanState(r.status)}</span></div><div class="timeline-vertical">${planState(r.plan)}</div><div class="execution-output">${esc(r.answer||r.error||'Waiting for output…')}</div>`;if(r.error)notice('error',r.error)}
// The story: the mission's events in sentences, newest first, a run of events from one worker under that worker.
function renderTimeline(m){const el=$('agentTimeline'),A=window.LocalAIAgentWords;if(!el||!A)return;const groups=A.groupStory(A.storyEvents(m)),all=m?.workers||[],pic=w=>window.LocalAIAgentWorld?.avatar?.(w)||'',t=at=>{const d=Date.parse(at);return d?`<time datetime="${esc(at)}">${new Date(d).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</time>`:''};
 el.innerHTML=groups.length?groups.map(g=>{const w=all.find(x=>(x.id||x.agentId)===g.workerId);return `<li class="aw-story__group" data-tone="${esc(g.items[0].tone)}">${w?`<img class="awc__avatar" src="${pic(w)}" alt="" width="28" height="28">`:'<span class="aw-story__dot" aria-hidden="true"></span>'}<ol>${g.items.map(e=>`<li data-tone="${esc(e.tone)}"><span>${esc(e.text)}</span>${t(e.at)}</li>`).join('')}</ol></li>`}).join(''):'<li class="aw-story__empty">What the team does will be told here.</li>'}
function resultForWorker(id){return currentMission?.results?.find(r=>r.agentId===id)||null}
function selectWorker(id){activeInspectorId=id;renderInspector();if(phone.matches&&snap==='peek')setSnap('half');window.dispatchEvent(new CustomEvent('localai:agentworld-focus',{detail:{workerId:id}}))}
// The worker card: who they are, what they are doing, what they found so far and, if stuck, why and Try again. Model,
// scores and routing are developer details (data-dev-only: shown only with developer tools on).
function renderInspector(){const el=$('agentInspector'),A=window.LocalAIAgentWords,m=currentMission;if(!el||!A)return;const w=(m?.workers||[]).find(x=>x.id===activeInspectorId);el.hidden=!w;if(!w){el.innerHTML='';return}
 const r=resultForWorker(w.id),rm=w.routingMeta||{},b=A.stateBadge(w.state),bad=w.state==='error'||w.state==='blocked',out=String(r?.answer||''),src=(r?.evidenceRecords||[]).length||(r?.evidence||[]).length;
 el.innerHTML=`<div class="aw-worker__head"><img class="awc__avatar" src="${window.LocalAIAgentWorld?.avatar?.(w)||''}" alt="" width="48" height="48"><div><h2 id="awWorkerName">${esc(A.workerName(w))}</h2><p>${esc(A.workerRole(w))}</p></div><span class="badge badge--${b.tone}">${esc(b.label)}</span><button type="button" class="aw-worker__close" id="awWorkerClose" aria-label="Close ${esc(A.workerName(w))}">×</button></div>
 <p class="aw-worker__now${bad?' is-bad':''}">${esc(A.workerStep(w,m))}</p>${bad?`<div class="aw-worker__fix"><span>${w.state==='error'?'Trying again runs the mission again from the start.':'It starts when the workers before it finish.'}</span>${w.state==='error'?'<button type="button" class="btn-primary" id="agentRetryBtn">Try again</button>':''}</div>`:''}
 ${out?`<details class="aw-worker__out"${out.length<600?' open':''}><summary>What ${esc(A.workerName(w))} found${src?` · ${src} source${src===1?'':'s'}`:''}</summary><div class="aw-worker__text">${esc(out)}</div></details>`:''}
 <dl class="aw-worker__dev" data-dev-only><dt>Model</dt><dd>${esc(w.model||r?.model||'Automatic')}</dd><dt>Skill fit</dt><dd>${rm.capabilityScore??'—'}%</dd><dt>Model fit</dt><dd>${rm.modelScore??'—'}%</dd><dt>Grounding</dt><dd>${rm.groundingRequired===false?'Not required':'Required'}</dd><dt>Fallback</dt><dd>${esc(rm.retryPolicy?.fallbackAgentId||'None')}</dd>${w.reason?`<dt>Assignment rationale</dt><dd>${esc(w.reason)}</dd>`:''}</dl>`;
 $('awWorkerClose').onclick=()=>{activeInspectorId='';renderInspector();refocusCrew(w.id)};const t=$('agentRetryBtn');if(t)t.onclick=retryMission}
function refocusCrew(id){window.LocalAIUI?.refocus?.(id,{within:'#awcRoster',key:'awcRoster',control:':scope'})||document.querySelector(`#awcRoster [data-awc-roster="${CSS.escape(id)}"]`)?.focus()}
function missionSummary(m){const done=(m.workers||[]).filter(w=>w.state==='complete').length,total=(m.workers||[]).length;return {done,total,percent:total?Math.round(done/total*100):0}}
function renderMission(m){if(!m)return;currentMission=m;if(m.routing)renderRoute(m.routing);const s=missionSummary(m),A=window.LocalAIAgentWords,st=A?.statusSentence(m),headline=$('agentMissionHeadline'),meta=$('agentMissionMeta'),progress=$('agentMissionProgress');if(headline)headline.textContent=m.goal||'Mission';if(meta)meta.textContent=st?.text||'';if(progress)progress.style.width=s.percent+'%';progress?.parentElement?.setAttribute('aria-valuenow',String(s.percent));renderHead(m);renderTimeline(m);renderInspector();renderResults();clearNotice()}
// The header: the goal, one sentence and one action for the state the mission is in: Try again (stopped), See the
// result (done), Watch live (running, camera not following), Start a mission (none). Running with the camera already
// following needs no loud action: the header shows none and the phone's peek a quiet See the crew, so the collapsed
// sheet always offers a next step. [action, label, quiet]
function primaryFor(m){const t=window.LocalAIAgentWords?.statusSentence(m)?.tone||'idle';return t==='attention'?['retry','Try again']:t==='done'?['result','See the result']:t==='working'?(window.LocalAIAgentWorld?.following?.()?['crew','See the crew',true]:['watch','Watch live']):['start','Start a mission']}
function renderHead(m){const A=window.LocalAIAgentWords,st=A?.statusSentence(m||null),title=$('awTitle'),status=$('awStatus'),page=$('agents');if(!st)return;if(title)title.textContent=m?.goal||'Agent World';if(status){const i=st.label?st.text.indexOf(' · '):-1;status.innerHTML=i>0?`<b>${esc(st.text.slice(0,i))}</b>${esc(st.text.slice(i))}`:esc(st.text)}page?.setAttribute('data-aw-state',st.tone);const empty=$('awEmpty');if(empty&&!m&&!window.LocalAIAgentWorld?.busy?.())empty.hidden=false;else if(empty&&m)empty.hidden=true;
 const [action,label,quiet]=primaryFor(m),head=$('awPrimary'),peek=$('awPeekAction');
 if(head){head.hidden=!!quiet;head.textContent=label;head.dataset.action=action}
 if(peek){peek.hidden=false;peek.textContent=label;peek.dataset.action=action;peek.classList.toggle('btn-primary',!quiet);peek.classList.toggle('btn-outline',!!quiet)}
 document.querySelectorAll('[data-aw-menu="copy"],[data-aw-menu="replay"]').forEach(b=>b.disabled=b.dataset.awMenu==='copy'?!m?.answer:!(m?.timeline||[]).length||m?.status==='running')}
function doPrimary(action){if(action==='retry')retryMission();else if(action==='result')showResult();else if(action==='watch')window.LocalAIAgentWorld?.follow?.(true);else if(action==='crew'){if(phone.matches)setSnap('half');document.querySelector('#awcRoster [data-awc-roster]')?.focus({preventScroll:phone.matches})}else openStart();renderHead(currentMission)}
function showResult(){const r=document.querySelector('#agents .aw-results');if(phone.matches)setSnap('full');r?.scrollIntoView?.({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});$('agentResultBody')?.focus({preventScroll:true})}
// ⋯ menu: Start a new mission, Watch the replay, Open in Work, Copy result, All missions.
function setupMenu(){const btn=$('awMoreBtn'),menu=$('awMenu');if(!btn||!menu)return;const items=()=>[...menu.querySelectorAll('[role^=menuitem]:not(:disabled)')].filter(x=>x.offsetParent);
 const outside=e=>{if(!menu.hidden&&!menu.contains(e.target)&&!btn.contains(e.target)&&!e.target.closest?.('#uxHeaderAction'))close(false)};
 const close=(focus=true)=>{if(menu.hidden)return;menu.hidden=true;document.removeEventListener('pointerdown',outside);btn.setAttribute('aria-expanded','false');if(focus)(phone.matches?document.getElementById('uxHeaderAction'):btn)?.focus()};
 const open=()=>{menu.hidden=false;document.addEventListener('pointerdown',outside);btn.setAttribute('aria-expanded','true');items()[0]?.focus()};
 window.LocalAIAgentMenu={toggle:()=>menu.hidden?open():close()};btn.onclick=()=>menu.hidden?open():close();
 menu.addEventListener('keydown',e=>{const l=items(),i=l.indexOf(document.activeElement);if(e.key==='Escape'){e.preventDefault();close()}else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();l[(i+(e.key==='ArrowDown'?1:-1)+l.length)%l.length]?.focus()}else if(e.key==='Tab')close(false)});
 menu.addEventListener('click',async e=>{const v=e.target.closest('[data-aw-view]');if(v){const k=v.dataset.awView;if(k==='theater'||k==='fit')close(false);window.LocalAIAgentWorld?.view?.(k);return}const b=e.target.closest('[data-aw-menu]');if(!b)return;close(false);const m=currentMission,a=b.dataset.awMenu;
  if(a==='new')doPrimary('start');
  else if(a==='replay'&&m)window.dispatchEvent(new CustomEvent('localai:agentworld-replay-mission',{detail:{mission:m,play:true}}));
  else if(a==='all')window.LocalAIRouter?.go('#work?kind=missions');
  else if(a==='demo')window.LocalAIAgentWorld?.demo?.();
  else if(a==='work'){let id='';try{id=((await req('/api/runs?kind=missions&limit=60')).items||[]).find(x=>(x.meta?.missionId||x.output?.missionId||x.source?.id||x.meta?.sourceId)===m?.id)?.id||''}catch{}if(id&&window.LocalAIRuns)window.LocalAIRuns.show(id);else window.LocalAIRouter?.go('#work?kind=missions')}
  else if(a==='copy'&&m?.answer){try{await navigator.clipboard.writeText(m.answer);window.LocalAIUI?.toast?.('Result copied')}catch{window.LocalAIUI?.toast?.('Couldn’t copy. Select the summary and copy it instead.')}}});
 window.LocalAIShell?.setAction('agents',{icon:'more',label:'More',onClick:()=>window.LocalAIAgentMenu.toggle()})}
function retryMission(){if(!currentMission?.goal)return;const g=$('agentGoal');if(g)g.value=currentMission.goal;startMission()}
// The result: Summary first (or why there is none), then what each worker found (one fold each), then the sources as
// links. The routing decision is a developer detail.
function renderResults(){const el=$('agentResultBody'),A=window.LocalAIAgentWords,m=currentMission;if(!el||!A)return;if(!m){el.innerHTML='<p class="aw-results__none">The result will be here when the team finishes.</p>';return}
 const rs=m.results||[],seen=new Set(),src=[];for(const r of rs){for(const e of r.evidenceRecords||[]){const k=e.source||e.url||e.title;if(k&&!seen.has(k)){seen.add(k);src.push({title:e.title||k,url:e.url||e.source||''})}}for(const e of r.evidence||[]){if(e&&!seen.has(e)){seen.add(e);src.push({title:e,url:e})}}}
 const link=e=>/^https?:\/\//i.test(e.url)?`<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>`:`<span>${esc(e.title)}</span>`,pic=r=>window.LocalAIAgentWorld?.avatar?.({id:r.agentId})||'';
 el.innerHTML=`<h3>Summary</h3>${m.answer?`<div class="aw-results__text">${esc(m.answer)}</div>`:`<p class="aw-results__none">${esc(A.summaryWhy(m))}</p>`}
 <h3>What each worker found</h3>${rs.length?rs.map(r=>{const w={id:r.agentId,name:r.agentName},b=A.stateBadge(r.partial?'partial':r.status);return `<details class="aw-results__worker"><summary><img class="awc__avatar" src="${pic(r)}" alt="" width="28" height="28"><span>${esc(A.workerName(w))}</span><span class="badge badge--${b.tone}">${esc(b.label)}</span></summary><div class="aw-results__text">${esc(r.answer||(r.partial&&r.notes?'Partial notes (it stopped before writing up):\n'+r.notes:'')||(r.status==='error'?A.workerStep({id:r.agentId,state:'error',error:r.error,errorCode:r.errorCode},m):'Nothing yet.'))}</div></details>`}).join(''):'<p class="aw-results__none">Nothing yet.</p>'}
 <h3>Sources</h3>${src.length?`<ul class="aw-results__sources">${src.map(e=>`<li>${link(e)}</li>`).join('')}</ul>`:'<p class="aw-results__none">No sources were used.</p>'}
 <details class="aw-results__dev" data-dev-only><summary>Routing</summary><pre class="agent-result-pre">${m.routing?esc(JSON.stringify(m.routing,null,2)):'No routing recorded.'}</pre></details>`}
// History lives in Work › Missions; this page only needs the missions to pick the one to show.
async function loadHistory(){try{const j=await req('/api/agents/missions');history=j.items||j.missions||[];if(!currentMission){const m=history.find(m=>m.status==='running')||history[0];if(m)renderMission(m);else renderHead(null)}}catch(e){notice('error','Couldn’t load the missions: '+e.message)}}
// Start: the plan is checked first (so a bad goal is said in the sheet), then the mission starts; the sheet closes,
// the camera flies to Command Center and the city wakes. A failure stays in the sheet (or a toast, from Try again).
async function startMission(){const goal=$('agentGoal')?.value.trim(),open=$('awStart')?.open;if(!goal){notice('error','Say what the team should do first.');$('agentGoal')?.focus();return}const body={goal,projectId:$('agentProject')?.value||''},ids=manualIds();if($('agentWebSearch')?.checked)body.webSearch=true;if(ids?.length)body.agentIds=ids;const wm=workerModel();if(wm)body.workerModel=wm;const b=$('missionRunBtn');if(b){b.disabled=true;b.textContent='Starting…'}clearNotice();
 try{await preview();const j=await req('/api/agents/missions/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});closeStart();if(j.mission){currentMission=null;renderMission(j.mission);window.dispatchEvent(new CustomEvent('localai:agentworld-mission',{detail:{mission:j.mission}}))}window.dispatchEvent(new Event('localai:agentworld-start'));window.LocalAIUI?.toast?.('The team is on it');loadHistory()}
 catch(e){if(open)notice('error','Couldn’t start the mission: '+e.message);else window.LocalAIUI?.toast?.('Couldn’t start the mission: '+e.message)}finally{if(b){b.disabled=false;b.textContent='Start'}}}
// The start sheet: one text box, the team in words as you type, two plain options, Advanced only with developer tools.
// Closed, focus goes back to whatever opened it, again once the sheet's history.back() has landed.
let teamTimer=0,teamFor='';
function openStart(){const d=$('awStart');if(!d||d.open)return;const o=document.activeElement;clearNotice();
 window.LocalAIUI.showSheet(d,reopened=>{if(reopened)return;const back=()=>{if(o?.isConnected&&document.activeElement!==o)o.focus()};back();window.LocalAIUI.afterSheetPop(()=>{back();requestAnimationFrame(()=>requestAnimationFrame(back))})});
 $('agentGoal')?.focus();renderTeam()}
function closeStart(){const d=$('awStart');if(d?.open)d.close()}
// A goal that changes Local AI itself is better handed to Claude Code; the line says so as you type, and Start (or
// Start a mission anyway) still starts the mission.
let selfShown=false;
function renderSelfChange(g){const SC=window.LocalAISelfChange,box=$('awSelfChange');if(!SC||!box)return;const on=SC.isSelfChange(g);if(on===selfShown)return;selfShown=on;
 if(!on){SC.hide(box);return}
 SC.offer(box,{text:()=>$('agentGoal')?.value.trim()||'',from:'agentWorld',anyway:()=>{selfShown=false;startMission()},onHanded:()=>{selfShown=false;const t=$('agentGoal');if(t)t.value='';renderTeam();closeStart()}})}
function renderTeam(){const g=$('agentGoal')?.value.trim()||'',el=$('awTeam');renderSelfChange(g);if(!el)return;clearTimeout(teamTimer);if(!g){el.innerHTML='';teamFor='';return}if(g===teamFor)return;
 teamTimer=setTimeout(async()=>{let r;try{const body={goal:g},ids=manualIds();if(ids?.length)body.agentIds=ids;r=(await req('/api/agents/dispatch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).routing}catch{return}if(($('agentGoal')?.value.trim()||'')!==g)return;teamFor=g;renderRoute(r);
  const p=window.LocalAIAgentWords?.teamPreview(r?.workers||[]);if(!p?.text){el.innerHTML='';return}el.innerHTML='<span class="aw-team__label">Who’s on the team</span><span class="aw-team__faces">'+p.workers.map(w=>'<img class="awc__avatar" src="'+(window.LocalAIAgentWorld?.avatar?.(w)||'')+'" alt="" width="32" height="32">').join('')+'</span><p>'+esc(p.text)+'</p>'},450)}
function setupStart(){const d=$('awStart');if(!d)return;$('awStartClose').onclick=closeStart;d.addEventListener('click',e=>{if(e.target===d)closeStart()});$('agentGoal')?.addEventListener('input',renderTeam);
 $('awEmptyStart')?.addEventListener('click',openStart);$('awEmptyDemo')?.addEventListener('click',()=>{$('awEmpty').hidden=true;window.LocalAIAgentWorld?.demo?.()});window.LocalAIAgentStart={open:openStart}}
async function runSpecialist(){const goal=$('agentGoal')?.value.trim();if(!goal){notice('error','Enter an objective first.');return}const b=$('specialistRunBtn');if(b)b.disabled=true;try{const j=await req('/api/agents/specialist/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:selected,goal,projectId:$('agentProject')?.value||''})});renderRun(j.run)}catch(e){notice('error',e.message)}finally{if(b)b.disabled=false}}
function setupAdvanced(){const toggle=$('agentAdvancedToggle'),panel=$('agentAdvancedPanel');if(toggle&&panel)toggle.onclick=()=>{const open=panel.hidden;panel.hidden=!open;if(open)loadWorkerModels();toggle.setAttribute('aria-expanded',String(open));toggle.textContent=open?'Hide advanced':'Advanced'};$('manualRouteToggle')?.addEventListener('change',e=>{$('manualRouteOptions').hidden=!e.target.checked})}
async function init(){if(!$('specialistRegistry'))return;setupSheet();const historyLoaded=loadHistory();try{const j=await req('/api/agents/catalog');catalog=j.items||[];cards();updateDirectActionLabel()}catch(e){notice('error','Couldn’t load the list of workers: '+e.message)}setupAdvanced();setupMenu();setupStart();for(const id of ['awPrimary','awPeekAction'])$(id)?.addEventListener('click',e=>doPrimary(e.currentTarget.dataset.action));window.addEventListener('localai:agentworld-follow',()=>renderHead(currentMission));$('routePreviewBtn')?.addEventListener('click',()=>preview().catch(e=>notice('error',e.message)));$('specialistRunBtn')?.addEventListener('click',runSpecialist);$('missionRunBtn')?.addEventListener('click',startMission);await historyLoaded;try{source=source||missionStream.subscribe(m=>{const ix=history.findIndex(x=>x.id===m.id);if(ix>=0)history[ix]=m;else history.unshift(m);if(!currentMission||m.id===currentMission.id)renderMission(m)},()=>notice('info','Live mission stream reconnecting…'),()=>{const n=$('agentInlineNotice');if(n&&/reconnecting/.test(n.textContent))clearNotice();loadHistory()})}catch{notice('info','Live mission stream unavailable; history remains accessible.')}}
// ---- Phone: everything but the city is a bottom sheet over it, with three snaps ----
// peek (the status sentence and the crew's portraits), half, full. Drag the top of the sheet, tap the handle to step
// up, Back to lower it (one history entry while it is up). At peek the body is inert, so focus never lands in what is
// off screen. On wider screens the same element is the rail beside the city and none of this applies.
const phone=matchMedia('(max-width:760px)');let snap='peek',releaseSheet=null,dragEnd=-1e9;
function sheetY(s,to){const h=s.clientHeight,peek=parseFloat(getComputedStyle(s).getPropertyValue('--aw-peek'))||112;return to==='full'?0:to==='half'?Math.round(h*.45):h-peek}
function setSnap(to,{fromBack=false}={}){
 const s=$('awSheet'),handle=$('awSheetHandle'),body=$('awSheetBody');if(!s)return;snap=to;s.dataset.snap=to;s.classList.remove('is-dragging');
 if(to==='peek')s.style.removeProperty('--aw-y');else s.style.setProperty('--aw-y',sheetY(s,to)+'px');
 const up=to!=='peek'&&phone.matches;handle?.setAttribute('aria-expanded',String(up));handle?.setAttribute('aria-label',up?'Show less':'Show mission details');if(body)body.inert=phone.matches&&!up;
 if(up&&!releaseSheet&&window.LocalAIUI?.sheetHistory)releaseSheet=LocalAIUI.sheetHistory(s,()=>{releaseSheet=null;setSnap('peek',{fromBack:true})});
 if(!up&&releaseSheet){const r=releaseSheet;releaseSheet=null;if(!fromBack)r()}
}
function setupSheet(){
 const s=$('awSheet'),top=s?.querySelector('.aw-sheet__top'),page=$('agents');if(!top)return;let d=null;
 // Capture the pointer only once it moves, so a tap still clicks the handle.
 // The stage sits between the header and the tab bar: measure both (they follow the safe areas).
 const measure=()=>{const b=document.getElementById('uxContextBar')?.getBoundingClientRect().bottom;if(b>0)page.style.setProperty('--aw-top',Math.round(b)+'px');const n=document.getElementById('uxMobileNav')?.getBoundingClientRect();if(n?.height)page.style.setProperty('--aw-bottom',Math.max(0,Math.round(innerHeight-n.top))+'px');if(snap!=='peek')s.style.setProperty('--aw-y',sheetY(s,snap)+'px')};
 $('awSheetHandle').addEventListener('click',()=>{if(performance.now()-dragEnd<300)return;setSnap(snap==='peek'?'half':snap==='half'?'full':'peek')});
 s.querySelector('.aw-sheet__peek').addEventListener('click',()=>{if(performance.now()-dragEnd>=300&&snap==='peek')setSnap('half')});
 top.addEventListener('pointerdown',e=>{if(!phone.matches||e.button>0)return;d={id:e.pointerId,y:e.clientY,t:e.timeStamp,from:sheetY(s,snap),moved:false}});
 top.addEventListener('pointermove',e=>{if(!d||e.pointerId!==d.id)return;const dy=e.clientY-d.y;if(!d.moved&&Math.abs(dy)<6)return;if(!d.moved)try{top.setPointerCapture(e.pointerId)}catch{}d.moved=true;s.classList.add('is-dragging');s.style.setProperty('--aw-y',Math.max(0,Math.min(sheetY(s,'peek'),d.from+dy))+'px')});
 const end=e=>{if(!d||e.pointerId!==d.id)return;const was=d;d=null;if(!was.moved)return;dragEnd=performance.now();
  // Where the sheet would come to rest at this speed picks the snap.
  const dy=e.clientY-was.y,v=dy/Math.max(1,e.timeStamp-was.t),y=was.from+dy+v*160;
  setSnap(['full','half','peek'].reduce((a,b)=>Math.abs(sheetY(s,b)-y)<Math.abs(sheetY(s,a)-y)?b:a))};
 top.addEventListener('pointerup',end);top.addEventListener('pointercancel',end);
 // Leaving the page or the phone layout lowers the sheet without a history step.
 new MutationObserver(()=>{if(!page.classList.contains('active')&&snap!=='peek'){const r=releaseSheet;releaseSheet=null;setSnap('peek',{fromBack:true});r?.()}else if(page.classList.contains('active'))measure()}).observe(page,{attributes:true,attributeFilter:['class']});
 phone.addEventListener?.('change',()=>setSnap('peek'));window.addEventListener('resize',measure);measure();setSnap('peek')
}
window.addEventListener('localai:agentworld-select',e=>{if(e.detail?.workerId)selectWorker(e.detail.workerId)});
window.LocalAISpecialists={init,preview,renderMission};
// Home starts a mission here: 202 {runId} comes back at once and the run view follows the mission. A failure fails the pending view and throws.
window.LocalAIMissions={async start(goal,{pending,agentIds,projectId,webSearch}={}){let j;try{j=await req('/api/agents/missions/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({goal,projectId:projectId||'',agentIds:agentIds?.length?agentIds:undefined,webSearch:webSearch===true||undefined,async:true})});if(!j.runId)throw Error('The mission did not start. Try again.')}catch(e){pending?.fail(e.message||'Something went wrong.');throw e}pending?.resolve(j.runId)},
 // The run view's body shows a mission this way: select it (live while it runs, replayed once it ended), and make Agent World re-measure.
 async show(missionId,{replay=true,alive}={}){let m=null;try{m=(await req('/api/agents/mission?id='+encodeURIComponent(missionId))).mission}catch{}if(!m||(alive&&!alive()))return false;renderMission(m);if(replay&&m.status!=='running')window.dispatchEvent(new CustomEvent('localai:agentworld-replay-mission',{detail:{mission:m}}));else window.dispatchEvent(new CustomEvent('localai:agentworld-mission',{detail:{mission:m}}));requestAnimationFrame(()=>window.dispatchEvent(new Event('resize')));return true}};
document.addEventListener('DOMContentLoaded',()=>init().catch(e=>notice('error',e.message)));
})();

// ==== mobile-overhaul.js ====
(() => {
  'use strict';

  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
  const TRUTH_REFRESH_MS = 30000;
  let truthRefreshTimer = 0;
  let lastTruthSnapshot = null;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  function activateView(view) {
    const target = document.getElementById(view);
    if (!target) return false;
    document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item === target));
    document.querySelectorAll('.navbtn[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
    window.scrollTo({ top: 0, behavior: 'instant' });
    return true;
  }

  // A page opened by tapping goes through the router, so Back follows it; hidden pages keep their own page.
  const routed = (view) => !!window.LocalAIRouter && window.LocalAIViews?.view(view)?.domain !== 'hidden' && (window.LocalAIRouter.go('#' + view), true);

  function navigate(view) {
    if (!view) return;
    if (view === 'models' && activateView(view)) { window.LocalAIRouter?.go('#models'); return; }
    if (routed(view)) return;
    if (typeof window.showView === 'function') {
      window.showView(view);
      return;
    }
    const button = [...document.querySelectorAll('.navbtn[data-view]')]
      .find((item) => item.dataset.view === view);
    if (button) button.click();
  }



  function installMobileHeader() {
    const main = document.querySelector('main');
    if (!main || main.querySelector('.mobile-header')) return;

    main.id = main.id || 'main-content';

    if (!document.querySelector('.skip-link')) {
      const skip = document.createElement('a');
      skip.className = 'skip-link';
      skip.href = '#main-content';
      skip.textContent = 'Skip to content';
      document.body.prepend(skip);
    }

    const header = document.createElement('div');
    header.className = 'mobile-header';
    header.innerHTML = `
      <div class="mobile-brand" aria-label="Local AI">
        <span class="mobile-brand-mark" aria-hidden="true"></span>
        <span>
          <span class="mobile-brand-name">Local AI</span>
          <span class="mobile-brand-sub">Private AI on your machine</span>
        </span>
      </div>
      <button class="pill mobile-health-button" type="button" aria-label="Open system status">
        <span id="mobileHeaderDot" class="dot"></span>
        <span id="mobileHeaderState">Checking…</span>
      </button>`;

    main.prepend(header);
    header.querySelector('.mobile-health-button')?.addEventListener('click', () => navigate('status'));
  }

  function mirrorHealthState() {
    const sourceDot = document.getElementById('homeDot');
    const sourceState = document.getElementById('homeState');
    const targetDot = document.getElementById('mobileHeaderDot');
    const targetState = document.getElementById('mobileHeaderState');
    if (!sourceDot || !targetDot || !targetState) return;

    targetDot.className = sourceDot.className;
    targetState.textContent = sourceState?.textContent || 'Checking…';
  }

  function improveViewportBehavior() {
    document.querySelectorAll('input, textarea').forEach((input) => {
      input.addEventListener('focus', () => {
        if (!isPhone()) return;
        window.setTimeout(() => input.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
      }, { passive: true });
    });

    document.addEventListener('click', (event) => {
      const navButton = event.target.closest?.('.navbtn');
      if (navButton && isPhone()) window.scrollTo({ top: 0, behavior: 'smooth' });
    }, { passive: true });
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const amount = bytes / (1024 ** index);
    return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
  }

  function formatRuntimeDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
  }


  function ensureAttentionSurface() {
    const existing = document.getElementById('truthAttention');
    if (existing) return existing;

    const home = document.getElementById('home');
    const hero = home?.querySelector('.workspace-hero');
    if (!home) return null;

    const section = document.createElement('section');
    section.id = 'truthAttention';
    section.className = 'card truth-attention';
    section.dataset.state = 'clear';
    section.hidden = true;
    section.setAttribute('aria-labelledby', 'truthAttentionTitle');
    section.innerHTML = `
      <div class="truth-attention-head">
        <div>
          <h2 id="truthAttentionTitle">Attention</h2>
          <p id="truthAttentionSummary">Checking what Local AI can do right now…</p>
        </div>
        <span id="truthAttentionCount" class="pill truth-attention-count" hidden></span>
      </div>
      <div id="truthAttentionList" class="truth-attention-list" aria-live="polite"></div>`;

    // Directly under the command box: the one card on Home that asks something of the user.
    if (hero?.parentNode === home) hero.insertAdjacentElement('afterend', section);
    else home.prepend(section);
    return section;
  }

  function ensureModelsSurface() {
    const main = document.querySelector('main');
    if (!main) return null;

    let section = document.getElementById('models');
    if (!section) {
      section = document.createElement('section');
      section.id = 'models';
      section.className = 'view';
      section.innerHTML = `
        <div class="topbar">
          <div>
            <h1>Models</h1>
            <p class="sub">The models on this computer, and which ones are loaded right now.</p>
          </div>
          <button id="modelRuntimeRefresh" class="btn-outline" type="button">Refresh</button>
        </div>
        <div id="modelRuntimeSummary" class="model-runtime-summary" aria-live="polite"></div>
        <div class="card model-download" style="margin-top:12px">
          <div class="section-head"><div><h2>Download a model</h2><p>From the Ollama library, stored on the Windows host. A 4B model is about 2.5 GB.</p></div></div>
          <form id="modelPullForm" class="model-pull-form">
            <input id="modelPullName" list="modelPullSuggestions" placeholder="Model name, for example gemma3:4b" aria-label="Model name" autocomplete="off" autocapitalize="off" spellcheck="false">
            <button class="btn-primary" type="submit">Download</button>
          </form>
          <datalist id="modelPullSuggestions">
            <option value="qwen3:4b-instruct">Fast general model, 2.5 GB</option>
            <option value="qwen3:4b-instruct-32k">The default: same model with a 32k context window</option>
            <option value="gemma3:4b">Google Gemma 3, reads images, 3.3 GB</option>
            <option value="llama3.2:3b">Meta Llama 3.2, 2.0 GB</option>
            <option value="qwen2.5-coder:7b">Code model, 4.7 GB</option>
          </datalist>
          <p id="modelPullError" class="model-pull-error" role="alert" hidden></p>
          <div id="modelPullList" class="model-pull-list" aria-live="polite"></div>
        </div>
        <div class="card" style="margin-top:12px">
          <div class="section-head">
            <div><h2>Installed models</h2><p>Loaded now shows what is in memory. Idle models unload on their own.</p></div>
          </div>
          <div id="modelRuntimeList" class="model-runtime-list"><div class="empty-state">Loading models…</div></div>
          <div id="modelRuntimeNote" class="model-runtime-note">A model doesn’t need to be loaded to be used: Ollama loads it when asked.</div>
        </div>`;
      main.appendChild(section);
      section.querySelector('#modelRuntimeRefresh')?.addEventListener('click', refreshModelsSurface);
      section.querySelector('#modelPullForm')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const input = section.querySelector('#modelPullName');
        startModelPull(input.value).then((ok) => { if (ok) input.value = ''; });
      });
      section.querySelector('#modelPullList')?.addEventListener('click', (event) => {
        const cancel = event.target.closest('[data-pull-cancel]');
        if (cancel) modelPost('/api/models/pull/cancel', { name: cancel.dataset.pullCancel }).finally(pollModelPulls);
      });
      section.querySelector('#modelRuntimeList')?.addEventListener('click', onModelRemoveClick);
      pollModelPulls();
    }

    if (!document.querySelector('.navbtn[data-view="models"]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'navbtn';
      button.dataset.view = 'models';
      button.textContent = 'Models';
      button.addEventListener('click', () => {
        // Through the router like every other page, so the address, the tab title, Back and focus follow.
        if (window.LocalAIRouter) window.LocalAIRouter.go('#models'); else activateView('models');
        if (lastTruthSnapshot?.models) renderModelsSurface(lastTruthSnapshot.models);
        else refreshModelsSurface();
      });
      const statusButton = document.querySelector('.navbtn[data-view="status"]');
      if (statusButton?.parentElement) statusButton.parentElement.insertBefore(button, statusButton);
      else document.querySelector('nav')?.appendChild(button);
    }

    return section;
  }

  function service(snapshot, name) {
    return (Array.isArray(snapshot?.services) ? snapshot.services : [])
      .find((item) => item?.name === name) || null;
  }

  function healthy(snapshot, name) {
    return service(snapshot, name)?.state === 'HEALTHY';
  }

  function setTruthAvailability(control, available, reason) {
    if (!control) return;
    if (!available) {
      control.disabled = true;
      control.classList.add('truth-disabled');
      control.dataset.truthDisabled = 'true';
      control.setAttribute('aria-disabled', 'true');
      if (reason) control.title = reason;
      return;
    }

    if (control.dataset.truthDisabled === 'true') {
      control.disabled = false;
      control.classList.remove('truth-disabled');
      delete control.dataset.truthDisabled;
      control.removeAttribute('aria-disabled');
      if (control.title?.startsWith('Unavailable:')) control.removeAttribute('title');
    }
  }

  function gateMode(name, available, reason) {
    document.querySelectorAll(`.quick[data-quick="${name}"], .mode[data-mode="${name}"]`)
      .forEach((control) => setTruthAvailability(control, available, `Unavailable: ${reason}`));
  }

  function applyCapabilityGates(snapshot) {
    const intelligenceReady = healthy(snapshot, 'ollama');
    const researchReady = intelligenceReady && healthy(snapshot, 'search');
    const createReady = healthy(snapshot, 'comfy') && snapshot?.images?.available === true;
    const automateReady = healthy(snapshot, 'n8n');

    // The reason is what the owner reads when a send fails (Home shows it under the composer): the service by its Health name, and where to look.
    gateMode('ask', intelligenceReady, 'Chat needs Intelligence running. See Health');
    gateMode('research', researchReady, !intelligenceReady
      ? 'Research needs Intelligence running. See Health'
      : 'Research needs Web research running. See Health');
    gateMode('create', createReady, healthy(snapshot, 'comfy')
      ? 'Images need a picture model installed. See Models'
      : 'Images need Image generation running. See Health');
    gateMode('automate', automateReady, 'Automations need the Automation engine running. See Health');
    gateMode('engineering', intelligenceReady, 'Changes need Intelligence running. See Health');

    const webSearch = document.getElementById('webSearch');
    if (webSearch) setTruthAvailability(webSearch, healthy(snapshot, 'search'), 'Unavailable: Web research is not running. See Health');
  }

  function attentionItems(snapshot) {
    const items = [];
    const services = Array.isArray(snapshot?.services) ? snapshot.services : [];

    services
      .filter((item) => item?.required !== false && item?.state !== 'HEALTHY')
      .forEach((item) => {
        items.push({
          severity: item.state === 'DOWN' ? 'critical' : 'warning',
          title: `${item.label || item.name || 'Core service'} is ${String(item.state || 'unavailable').toLowerCase()}`,
          detail: item.impact || 'Part of Local AI is affected.',
          action: 'Open Health',
          view: 'status'
        });
      });

    const models = snapshot?.models;
    if (healthy(snapshot, 'ollama') && models?.available === false) {
      items.push({
        severity: 'warning',
        title: 'Model list could not be verified',
        detail: models.runtimeError || 'Ollama is reachable, but the list of installed models is not.',
        action: 'Open Models',
        view: 'models'
      });
    } else if (healthy(snapshot, 'ollama') && models?.available === true && models.default && models.defaultInstalled === false) {
      items.push({
        severity: 'critical',
        title: 'Configured default model is not installed',
        detail: `${models.default} is set as the default but is not installed in Ollama.`,
        action: 'Open Models',
        view: 'models'
      });
    }

    if (healthy(snapshot, 'ollama') && models?.available === true && models.runtimeAvailable === false) {
      items.push({
        severity: 'info',
        title: 'Active model residency is unavailable',
        detail: models.runtimeError || 'Installed models are known, but which ones are loaded could not be read.',
        action: 'Open Models',
        view: 'models'
      });
    }

    if (healthy(snapshot, 'comfy') && snapshot?.images?.available !== true) {
      items.push({
        severity: 'warning',
        title: 'No supported image model discovered',
        detail: 'Create is gated until a compatible local checkpoint is available.',
        action: 'Open Images',
        view: 'create'
      });
    }

    if (snapshot?.powershell?.configured === false) {
      items.push({
        severity: 'info',
        title: 'Host deployment bridge is not configured',
        detail: 'Engineering can plan changes, but host-level apply operations are unavailable.',
        action: 'Open PowerShell',
        view: 'powershell'
      });
    }

    if (Number(snapshot?.engineering?.awaitingApproval || 0) > 0) {
      const count = Number(snapshot.engineering.awaitingApproval);
      items.push({
        severity: 'info',
        title: `${count} engineering ${count === 1 ? 'run is' : 'runs are'} awaiting approval`,
        detail: 'Review the staged change before deployment.',
        action: 'Open approvals',
        view: 'approvals'
      });
    }

    if (Number(snapshot?.changes?.pending || 0) > 0) {
      const count = Number(snapshot.changes.pending);
      items.push({
        severity: 'info',
        title: `${count} change ${count === 1 ? 'request is' : 'requests are'} unfinished`,
        detail: 'Planned, failed or staged changes are waiting to be finished or discarded.',
        action: 'Open In progress',
        view: 'inProgress'
      });
    }

    if (Number(snapshot?.issues?.open || 0) > 0) {
      const count = Number(snapshot.issues.open);
      items.push({
        severity: 'warning',
        title: `${count} autonomous ${count === 1 ? 'issue is' : 'issues are'} open`,
        detail: 'Quality scans have unresolved findings.',
        action: 'Open Signals',
        view: 'signals'
      });
    }

    const rank = { critical: 0, warning: 1, info: 2 };
    return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }

  function renderAttention(snapshot, loadError = null) {
    const surface = ensureAttentionSurface();
    const list = document.getElementById('truthAttentionList');
    const summary = document.getElementById('truthAttentionSummary');
    const count = document.getElementById('truthAttentionCount');
    if (!surface || !list || !summary || !count) return;

    list.replaceChildren();

    if (loadError) {
      window.LocalAIHome?.setAttention([{ severity: 'critical', title: 'Status unavailable', detail: 'Local AI could not check what is working right now.', action: 'Open Health', view: 'status' }]);
      surface.hidden = false;
      surface.dataset.state = 'attention';
      summary.textContent = 'Local AI could not check what is working right now. Everything else still works.';
      count.hidden = true;   // a pill is a count (E5); the summary says the check failed
      const row = document.createElement('div');
      row.className = 'truth-attention-item';
      row.dataset.severity = 'critical';
      row.innerHTML = '<span class="truth-attention-marker" aria-hidden="true"></span><div class="truth-attention-copy"><strong>Status unavailable</strong><span>Local AI could not check what is working right now. Open Health for details.</span></div>';
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'btn-outline truth-attention-action';
      action.textContent = 'Open Health';
      action.addEventListener('click', () => navigate('status'));
      row.appendChild(action);
      list.appendChild(row);
      return;
    }

    const items = attentionItems(snapshot);
    window.LocalAIHome?.setAttention(items);   // Home's Needs you lists the critical ones
    // Nothing to do: hide the card. The Healthy pill in the page header already says all is well.
    surface.hidden = !items.length;
    if (!items.length) {
      surface.dataset.state = 'clear';
      summary.textContent = 'Nothing needs you. Everything reports ready.';
      count.hidden = true;
      return;
    }

    surface.dataset.state = 'attention';
    const critical = items.filter((item) => item.severity === 'critical').length;
    const warnings = items.filter((item) => item.severity === 'warning').length;
    summary.textContent = critical
      ? `${critical} critical ${critical === 1 ? 'item requires' : 'items require'} attention.`
      : `${warnings || items.length} ${warnings === 1 ? 'item needs' : 'items need'} review.`;
    count.hidden = false; count.textContent = String(items.length);

    items.slice(0, 6).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'truth-attention-item';
      row.dataset.severity = item.severity;

      const marker = document.createElement('span');
      marker.className = 'truth-attention-marker';
      marker.setAttribute('aria-hidden', 'true');

      const copy = document.createElement('div');
      copy.className = 'truth-attention-copy';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const detail = document.createElement('span');
      detail.textContent = item.detail;
      copy.append(title, detail);

      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'btn-outline truth-attention-action';
      action.textContent = item.action;
      action.addEventListener('click', () => navigate(item.view));

      row.append(marker, copy, action);
      list.appendChild(row);
    });
  }

  function renderModelsSurface(models) {
    ensureModelsSurface();
    const summary = document.getElementById('modelRuntimeSummary');
    const list = document.getElementById('modelRuntimeList');
    const note = document.getElementById('modelRuntimeNote');
    if (!summary || !list || !note) return;

    const installed = Array.isArray(models?.installed) ? models.installed : [];
    const loaded = Array.isArray(models?.loaded) ? models.loaded : [];
    const configured = models?.default || '—';
    const runtimeLabel = models?.runtimeAvailable === false ? 'Unavailable' : 'Live';

    summary.innerHTML = `
      <div class="model-runtime-metric"><strong title="${esc(configured)}">${esc(configured)}</strong><span>Configured default</span></div>
      <div class="model-runtime-metric"><strong>${Number(models?.installedCount ?? installed.length)}</strong><span>Installed</span></div>
      <div class="model-runtime-metric"><strong>${Number(models?.loadedCount ?? loaded.length)}</strong><span>Loaded now</span></div>
      <div class="model-runtime-metric" data-dev-only><strong>${runtimeLabel}</strong><span>Loaded list</span></div>`;

    if (models?.available === false) {
      list.innerHTML = `<div class="model-runtime-note model-runtime-error"><strong>Model list unavailable</strong><div style="margin-top:4px">${esc(models.runtimeError || 'Could not read the list of models from Ollama.')}</div></div>`;
      note.textContent = 'Local AI will not guess which models are installed until it can read the list.';
      return;
    }

    if (!installed.length) {
      list.innerHTML = '<div class="empty-state">No models installed yet. Download one above; start with the default, qwen3:4b-instruct-32k.</div>';
    } else {
      list.replaceChildren();
      installed.forEach((item) => {
        const runtime = item.runtime || loaded.find((candidate) => candidate.name === item.name) || null;
        const card = document.createElement('article');
        card.className = `model-runtime-card${item.loaded ? ' is-loaded' : ''}`;

        const head = document.createElement('div');
        head.className = 'model-runtime-head';
        const title = document.createElement('div');
        title.className = 'model-runtime-name';
        title.textContent = item.name || 'Unnamed model';
        const badge = document.createElement('span');
        badge.className = 'statuschip';
        badge.textContent = item.loaded ? 'Loaded' : 'Installed';
        head.append(title, badge);

        const meta = document.createElement('div');
        meta.className = 'model-runtime-meta';
        const detail = item.details || {};
        // Quantization, file format and the memory rows are diagnostic: developer tools only (critique §3.4, D6).
        [detail.family, detail.parameterSize, detail.quantizationLevel, detail.format]
          .forEach((value, i) => {
            if (!value) return;
            const chip = document.createElement('span');
            chip.className = 'badge';
            chip.textContent = value;
            if (i > 1) chip.dataset.devOnly = '';
            meta.appendChild(chip);
          });

        const details = document.createElement('div');
        details.className = 'model-runtime-details';
        const rows = [
          ['Model size', formatBytes(item.sizeBytes)],
          ['VRAM resident', runtime ? formatBytes(runtime.sizeVramBytes) : 'Not loaded'],
          ['Context', runtime?.contextLength ? runtime.contextLength.toLocaleString() : '—'],
          ['Unload target', runtime?.expiresAt ? formatRuntimeDate(runtime.expiresAt) : '—']
        ];
        rows.forEach(([label, value]) => {
          const cell = document.createElement('div');
          cell.className = 'model-runtime-detail';
          if (label !== 'Model size') cell.dataset.devOnly = '';
          const key = document.createElement('span');
          key.textContent = label;
          const val = document.createElement('b');
          val.textContent = value;
          cell.append(key, val);
          details.appendChild(cell);
        });

        card.append(head, meta, details);
        // Remove, with an inline confirmation. The model Local AI uses by default can't be removed.
        const actions = document.createElement('div');
        actions.className = 'model-runtime-actions';
        if ((models?.protectedModels || [models?.default]).includes(item.name)) {
          actions.innerHTML = `<span class="meta">${item.name === models?.default ? 'Used by Local AI by default' : 'Used by Local AI (GridCraft)'}</span>`;
        } else {
          actions.innerHTML = `<button type="button" class="btn-outline" data-model-remove="${esc(item.name)}">Remove</button>`;
        }
        card.appendChild(actions);
        list.appendChild(card);
      });
    }

    if (models?.default && models.defaultInstalled === false) {
      note.classList.add('model-runtime-error');
      note.textContent = `Configured default ${models.default} is not installed. Requests that use the default can fail until it is installed or another default is chosen.`;
    } else if (models?.runtimeAvailable === false) {
      note.classList.add('model-runtime-error');
      note.textContent = `The installed models are known, but which ones are loaded is not: ${models.runtimeError || 'Ollama /api/ps unavailable.'}`;
    } else {
      note.classList.remove('model-runtime-error');
      note.textContent = Number(models?.loadedCount || 0) === 0
        ? 'No model is resident right now. This is normal: Ollama loads models on demand and may unload them after idle time.'
        : 'Loaded means in memory right now. Installed models stay available when they are not loaded.';
    }
  }

  async function refreshModelsSurface() {
    const refresh = document.getElementById('modelRuntimeRefresh');
    if (refresh) {
      refresh.disabled = true;
      refresh.textContent = 'Refreshing…';
    }
    try {
      const response = await fetch('/api/models', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const models = await response.json();
      if (!response.ok && models.available !== false) throw new Error(models.error || `HTTP ${response.status}`);
      renderModelsSurface(models);
      if (lastTruthSnapshot) {
        lastTruthSnapshot = { ...lastTruthSnapshot, models };
        renderAttention(lastTruthSnapshot);
      }
    } catch (error) {
      renderModelsSurface({
        available: false,
        default: lastTruthSnapshot?.models?.default || '—',
        installed: [],
        loaded: [],
        installedCount: 0,
        loadedCount: 0,
        runtimeAvailable: false,
        runtimeError: String(error.message || error)
      });
    } finally {
      if (refresh) {
        refresh.disabled = false;
        refresh.textContent = 'Refresh';
      }
    }
  }

  // ---- Model downloads and removal -------------------------------------------------------------------
  let pullTimer = null;
  let lastPulls = [];
  async function modelPost(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  function showPullError(message) {
    const el = document.getElementById('modelPullError');
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }
  async function startModelPull(name) {
    showPullError('');
    try {
      await modelPost('/api/models/pull', { name: String(name || '').trim() });
      pollModelPulls();
      return true;
    } catch (error) {
      showPullError(error.message);
      return false;
    }
  }
  function pullPercent(p) { return p.total ? Math.min(100, Math.round((p.completed / p.total) * 100)) : 0; }
  function renderModelPulls(items) {
    const list = document.getElementById('modelPullList');
    if (!list) return;
    const visible = items.filter((p) => p.state === 'running' || Date.now() - new Date(p.finishedAt || 0).getTime() < 10 * 60 * 1000);
    list.innerHTML = visible.map((p) => {
      const pct = pullPercent(p);
      const label = p.state === 'running'
        ? (p.total ? `${pct}% · ${formatBytes(p.completed)} of ${formatBytes(p.total)}` : esc(p.status || 'Starting'))
        : p.state === 'done' ? 'Downloaded' : p.state === 'cancelled' ? 'Cancelled' : `Failed: ${esc(p.error || 'unknown error')}`;
      return `<div class="model-pull is-${esc(p.state)}">
        <div class="model-pull-head"><strong>${esc(p.name)}</strong><span>${label}</span>${p.state === 'running' ? `<button type="button" class="btn-outline" data-pull-cancel="${esc(p.name)}">Cancel</button>` : ''}</div>
        <div class="model-pull-bar" role="progressbar" aria-label="${esc(p.name)} download" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.state === 'done' ? 100 : pct}"><i style="width:${p.state === 'done' ? 100 : pct}%"></i></div>
        ${p.state === 'running' && p.total ? `<small>${esc(p.status || '')}</small>` : ''}
      </div>`;
    }).join('');
  }
  async function pollModelPulls() {
    clearTimeout(pullTimer);
    let items = [];
    try { items = (await (await fetch('/api/models/pulls', { cache: 'no-store' })).json()).items || []; } catch {}
    const finishedNow = items.some((p) => p.state === 'done' && !lastPulls.some((q) => q.name === p.name && q.state === 'done'));
    lastPulls = items;
    renderModelPulls(items);
    window.dispatchEvent(new CustomEvent('localai:model-pulls', { detail: { items } }));
    if (finishedNow) refreshModelsSurface();
    if (items.some((p) => p.state === 'running')) pullTimer = setTimeout(pollModelPulls, 1500);
  }
  async function onModelRemoveClick(event) {
    const button = event.target.closest('[data-model-remove],[data-model-remove-confirm],[data-model-remove-cancel]');
    if (!button) return;
    const actions = button.closest('.model-runtime-actions');
    if (button.dataset.modelRemove) {
      const name = button.dataset.modelRemove;
      actions.innerHTML = `<span>Remove ${esc(name)} from the Windows host? You can download it again later.</span>
        <button type="button" class="btn-danger" data-model-remove-confirm="${esc(name)}">Remove</button>
        <button type="button" class="btn-outline" data-model-remove-cancel="${esc(name)}">Keep</button>`;
      actions.querySelector('[data-model-remove-cancel]')?.focus();
    } else if (button.dataset.modelRemoveCancel) {
      actions.innerHTML = `<button type="button" class="btn-outline" data-model-remove="${esc(button.dataset.modelRemoveCancel)}">Remove</button>`;
    } else {
      const name = button.dataset.modelRemoveConfirm;
      button.disabled = true;
      button.textContent = 'Removing…';
      try {
        await modelPost('/api/models/delete', { name });
        refreshModelsSurface();
      } catch (error) {
        actions.innerHTML = `<span class="model-pull-error">${esc(error.message)}</span><button type="button" class="btn-outline" data-model-remove="${esc(name)}">Remove</button>`;
      }
    }
  }
  window.LocalAIModels = { startPull: startModelPull, pollPulls: pollModelPulls };

  async function refreshTruthLayer() {
    try {
      const response = await fetch('/api/capabilities', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(`Status check returned HTTP ${response.status}`);
      const snapshot = await response.json();
      lastTruthSnapshot = snapshot;
      applyCapabilityGates(snapshot);
      renderModelsSurface(snapshot.models || {});
      renderAttention(snapshot);
      window.dispatchEvent(new CustomEvent('localai:truth-updated', { detail: snapshot }));
    } catch (error) {
      document.querySelectorAll('[data-truth-disabled="true"]').forEach((control) => {
        setTruthAvailability(control, true, '');
      });
      renderAttention(null, error);
    }
  }

  function installTruthLayer() {
    ensureAttentionSurface();
    ensureModelsSurface();
    refreshTruthLayer();

    if (truthRefreshTimer) window.clearInterval(truthRefreshTimer);
    truthRefreshTimer = window.setInterval(() => {
      if (!document.hidden) refreshTruthLayer();
    }, TRUTH_REFRESH_MS);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshTruthLayer();
    }, { passive: true });
  }

  function init() {
    installMobileHeader();
    improveViewportBehavior();
    mirrorHealthState();
    installTruthLayer();

    const observer = new MutationObserver(mirrorHealthState);
    const state = document.getElementById('homeState');
    if (state) observer.observe(state, { childList: true, characterData: true, subtree: true });

    window.addEventListener('resize', mirrorHealthState, { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

// ==== ux-architecture-v2.js ====
(()=>{'use strict';
// Domains, sections, labels and descriptions come from view-registry.js.
const REG=window.LocalAIViews;
const DOMAINS=REG.DOMAINS.map(d=>({...d,groups:REG.sections(d.id)}));
const q=(s,r=document)=>r.querySelector(s),qa=(s,r=document)=>[...r.querySelectorAll(s)];
let allButtons=new Map();
// Sprite icons (index.html) for the phone header and tab bar; decorative, every button also has a text label.
const icon=(name,cls)=>window.LocalAIKit?.icon(name,cls)||'';

function viewButton(view){return allButtons.get(view)||q('.navbtn[data-view="'+view+'"]')}
// Developer pages (registry `dev`) leave every menu while Developer tools (Health) is off; their addresses still work.
const devOff=()=>document.body.classList.contains('dev-tools-off');
const listed=view=>!!viewButton(view)&&!(REG.view(view)?.dev&&devOff());
// A domain's groups with the pages a menu may list right now; a group left empty (Tools, with the switch off) is dropped.
const listedGroups=d=>d.groups.map(g=>({label:g.label,views:g.views.filter(listed)})).filter(g=>g.views.length);
// A hidden page (chat, images, missions, runs) lights up the page that owns it.
function domainForView(view){let id=REG.view(view)?.domain;if(id==='hidden')id=REG.view(REG.resolve(view))?.domain;return DOMAINS.find(d=>d.id===id)||DOMAINS[0]}
// Tabs share their parent's nav entry and breadcrumb.
function pageForView(view){return REG.page(view)?.id||view}
// The menu entry a view lights: its page, or for a hidden page (Missions, Chat, Images) the page that owns it.
function menuPage(view){return REG.view(view)?.domain==='hidden'?pageForView(REG.resolve(view)):pageForView(view)}
function labelForView(view){return REG.view(view)?.label||viewButton(view)?.textContent?.trim()||view}
function activeView(){return q('.view.active')?.id||q('.navbtn.active')?.dataset.view||'home'}
function activateSyntheticView(view){
 const target=q('#'+view);if(!target)return false;
 qa('.view').forEach(v=>v.classList.toggle('active',v===target));
 qa('.navbtn[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
 window.scrollTo({top:0,behavior:'instant'});
 requestAnimationFrame(()=>sync(view));
 return true;
}
function navigate(view){
 const synthetic=viewButton(view)?.dataset.uxSynthetic==='true';
 if(synthetic&&activateSyntheticView(view)){window.LocalAIRouter?.go('#'+view);return}
 if(window.LocalAIRouter&&REG.view(view)?.domain!=='hidden'){window.LocalAIRouter.go('#'+view);requestAnimationFrame(()=>sync(view));return}
 if(typeof window.showView==='function'){window.showView(view);requestAnimationFrame(()=>sync(view));return}
 const b=viewButton(view);if(b){b.click();requestAnimationFrame(()=>sync(view));return}
 if(activateSyntheticView(view))return;
 const target=q('#'+view);if(target){qa('.view').forEach(v=>v.classList.toggle('active',v===target));requestAnimationFrame(()=>sync(view))}
}

function buildIntegrationsView(){
 const main=q('main'),nav=q('.app>aside nav');if(!main||!nav)return;
 if(!q('#integrations')){
   const section=document.createElement('section');
   section.id='integrations';section.className='view';section.dataset.uxSynthetic='true';
   // Content and live status are owned by integration-hub-v2.js, which mounts into this section.
   main.appendChild(section);
 }
 if(!q('.navbtn[data-view="integrations"]',nav)){
   const b=document.createElement('button');b.type='button';b.className='navbtn';b.dataset.view='integrations';b.dataset.uxSynthetic='true';b.textContent=REG.label('integrations');
   b.addEventListener('click',e=>{e.preventDefault();activateSyntheticView('integrations');window.LocalAIRouter?.go('#integrations')});
   nav.appendChild(b);
 }
}

// Desktop: the rail of areas; the page strip under the header lists the area's pages (navigation spec N5).
function buildDesktopNav(){
 const aside=q('.app>aside'),nav=q('.app>aside nav');if(!aside||!nav)return;
 const originals=qa('.navbtn[data-view]',nav);allButtons=new Map(originals.map(b=>[b.dataset.view,b]));
 const registry=document.createElement('div');registry.id='uxNavRegistry';registry.hidden=true;originals.forEach(b=>registry.appendChild(b));aside.appendChild(registry);
 const shell=document.createElement('div');shell.className='ux-nav-shell';
 const rail=document.createElement('div');rail.className='ux-primary-rail';rail.setAttribute('role','navigation');rail.setAttribute('aria-label','Primary');
 DOMAINS.forEach(d=>{
   const b=document.createElement('button');b.type='button';b.className='ux-primary-item';b.dataset.domain=d.id;b.title=d.label;b.innerHTML='<span class="ux-primary-symbol" aria-hidden="true">'+(icon(d.icon)||d.symbol)+'</span><span>'+d.label+'</span>';
   b.addEventListener('click',()=>navigate(d.defaultView));
   rail.appendChild(b);
 });
 shell.append(rail);nav.replaceWith(shell);
}
function buildContext(){
 const main=q('main');if(!main||q('#uxContextBar'))return;
 const bar=document.createElement('header');bar.id='uxContextBar';bar.className='ux-context-bar';
 bar.innerHTML='<div class="ux-context-left"><span class="ux-context-brand"><span class="brandmark ux-context-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12c2.6-5.6 11.4-5.6 14 0-2.6 5.6-11.4 5.6-14 0Z" stroke="#0b0d11" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="#0b0d11"/></svg></span><span class="ux-context-brand-names"><small id="uxContextGreeting"></small><strong>Local AI</strong></span></span><button class="ux-breadcrumb-home" type="button" data-ux-go="home">Local AI</button><span class="ux-context-sep">/</span><span class="ux-context-domain" id="uxContextDomain">Home</span><span class="ux-context-sep">/</span><span class="ux-context-view" id="uxContextView">Overview</span></div><div class="ux-context-actions"><button class="ux-context-action icon-btn" type="button" id="uxHeaderAction" hidden></button><button class="ux-context-inbox" type="button" id="uxInboxBtn" data-empty="true" aria-label="Inbox" hidden>'+icon('bell','ux-ico')+'<span>Inbox</span><b id="uxInboxCount">0</b></button><button class="ux-context-search" type="button" id="uxCommandBtn" aria-label="Search commands">'+icon('search','ux-ico')+'<span>Search commands</span><kbd>⌘K</kbd></button></div>';
 main.prepend(bar);
 q('[data-ux-go="home"]')?.addEventListener('click',()=>navigate('home'));
 q('#uxCommandBtn')?.addEventListener('click',()=>{if(window.LocalAICommand)return window.LocalAICommand.open();const cmd=q('#cmdk');if(cmd){cmd.classList.add('show');cmd.setAttribute('aria-hidden','false');q('#cmdkInput')?.focus()}});
 // Unread alerts plus approvals waiting, reported by app.js after it loads Inbox or Approvals.
 let inbox={unread:0,pending:0};
 window.addEventListener('localai:inbox-count',e=>{inbox={...inbox,...e.detail};const total=inbox.unread+inbox.pending,b=q('#uxInboxBtn');
  if(!b)return;b.hidden=total===0;b.dataset.empty=String(total===0);q('#uxInboxCount').textContent=String(total);const n=(c,w)=>c?`${c} ${w}${c===1?'':'s'}`:'';b.setAttribute('aria-label',total?`Inbox, ${[n(inbox.pending,'approval'),n(inbox.unread,'alert')].filter(Boolean).join(' and ')} waiting`:'Inbox')});
 q('#uxInboxBtn')?.addEventListener('click',()=>navigate('inbox')); // one queue (D8): the bell's one number opens the Inbox, which lists what waits first
}
// Agent World's ⋯ menu as an icon in the phone header (its heading is hidden behind the city). It sits beside Search and
// the bell, never in place of them; every other page keeps its action in the page (fixed header slots, navigation spec).
const headerActions=new Map();
function syncHeaderAction(view){const b=q('#uxHeaderAction');if(!b)return;const a=headerActions.get(REG.view(view||activeView())?.id||view||activeView());b.hidden=!a;q('#uxContextBar')?.classList.toggle('ux-context-has-action',!!a);if(!a){b.onclick=null;return}b.innerHTML=icon(a.icon,'ux-ico');b.setAttribute('aria-label',a.label);b.onclick=a.onClick}
window.LocalAIShell={setAction(view,action){headerActions.set(view,action);syncHeaderAction()},clearAction(view){headerActions.delete(view);syncHeaderAction()}};
function greeting(){const h=new Date().getHours();return h<12?'Good morning':h<18?'Good afternoon':'Good evening'}
function buildPageStrip(){
 const bar=q('#uxContextBar');if(!bar||q('#uxPageStrip'))return;
 const strip=document.createElement('nav');strip.id='uxPageStrip';strip.className='ux-page-strip';strip.setAttribute('aria-label','Pages in this section');
 bar.after(strip);
 strip.addEventListener('scroll',()=>fadeStrip(strip),{passive:true});window.addEventListener('resize',()=>fadeStrip(strip),{passive:true});
 strip.addEventListener('click',e=>{const b=e.target.closest('[data-strip-view]');if(b)navigate(b.dataset.stripView)});
}
// One strip for the area, on phones and desktops (navigation spec N5): its pages, and a page's tabs in place of the
// page (Projects › Library, Work › Automations).
function renderPageStrip(d,page,view){
 const strip=q('#uxPageStrip');if(!strip)return;
 const views=listedGroups(d).flatMap(g=>g.views).flatMap(v=>{const t=REG.tabs(v);return t.length?t.map(x=>x.id):[v]});
 const current=REG.view(view)?.id;if(views.includes(current))page=current;
 const key=d.id+'|'+views.join(',');
 if(strip.dataset.key!==key){strip.dataset.key=key;strip.innerHTML=views.map(v=>'<button type="button" data-strip-view="'+v+'" title="'+REG.description(v).replace(/"/g,'&quot;')+'">'+(REG.view(v)?.tab||REG.view(v)?.short||labelForView(v))+'</button>').join('');}
 // Home's only other page, Inbox, already has a button in the top bar; a hidden page (Missions, Chat) is none of these.
 strip.hidden=views.length<2||d.id==='home'||REG.view(view)?.domain==='hidden';
 qa('[data-strip-view]',strip).forEach(b=>{const on=b.dataset.stripView===page;b.classList.toggle('active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
 revealActive(strip);
 fadeStrip(strip);
}
// An overflowing strip scrolls so the open tab is fully in view and the first tab shown starts at the edge: a label is
// never cut mid-word on the left, and the fade on the right says there are more.
function revealActive(strip){
 if(strip.scrollWidth<=strip.clientWidth){strip.scrollLeft=0;return}
 const bs=qa('[data-strip-view]',strip),i=bs.findIndex(b=>b.classList.contains('active'));if(i<0)return;
 const cs=getComputedStyle(strip),pad=parseFloat(cs.paddingLeft)||0,room=strip.clientWidth-pad-(parseFloat(cs.paddingRight)||0),base=strip.getBoundingClientRect().left-strip.scrollLeft;
 const left=b=>b.getBoundingClientRect().left-base,right=b=>left(b)+b.getBoundingClientRect().width;
 let first=0;while(first<i&&right(bs[i])-left(bs[first])>room)first++;
 strip.scrollLeft=first?left(bs[first])-pad:0;
}
// A strip that overflows fades at the edge that has more tabs (CSS reads data-fade-start / data-fade-end).
function fadeStrip(strip){const max=strip.scrollWidth-strip.clientWidth,x=strip.scrollLeft;strip.dataset.fadeStart=String(x>2);strip.dataset.fadeEnd=String(max-x>2)}
function buildMobile(){
 if(q('#uxMobileNav'))return;
 const nav=document.createElement('div');nav.id='uxMobileNav';nav.className='ux-mobile-nav';nav.setAttribute('role','navigation');nav.setAttribute('aria-label','Primary navigation');
 DOMAINS.forEach(d=>{const b=document.createElement('button');b.type='button';b.dataset.domain=d.id;b.innerHTML='<b>'+icon(d.icon)+'</b><span>'+d.label+'</span>';b.addEventListener('click',()=>navigate(d.defaultView));nav.appendChild(b)});
 document.body.append(nav);
}
function sync(forced){
 const view=REG.view(forced||activeView())?.id||forced||activeView(),d=domainForView(view);document.body.dataset.domain=d.id;document.body.dataset.view=view;
 // A hidden page (Missions, Chat, Images) names itself in the top bar and lights the area that owns it.
 const hidden=REG.view(view)?.domain==='hidden',page=pageForView(view),viewLabel=labelForView(page),navPage=menuPage(view);renderPageStrip(d,navPage,view);q('#uxContextDomain').textContent=d.label;q('#uxContextView').textContent=viewLabel;{const single=listedGroups(d).flatMap(g=>g.views).filter(v=>viewButton(v)).length<2;q('#uxContextBar')?.classList.toggle('ux-context-same',!hidden&&(single||viewLabel===d.label))} // the bar names the area; a hidden page (Missions) names itself
 q('#uxContextBar')?.classList.toggle('ux-context-has-strip',!q('#uxPageStrip')?.hidden);syncHeaderAction(view);{const g=q('#uxContextGreeting');if(g)g.textContent=greeting()};
 qa('.ux-primary-item').forEach(b=>{const on=b.dataset.domain===d.id;b.dataset.active=String(on);if(on)b.setAttribute('aria-current','true');else b.removeAttribute('aria-current')});
 qa('#uxMobileNav [data-domain]').forEach(b=>{const on=b.dataset.domain===d.id;b.dataset.active=String(on);if(on)b.setAttribute('aria-current','true');else b.removeAttribute('aria-current')});
}
// Mid-switch no page is active for a moment; syncing then would take it for Home and hide the strip under the focus.
function observeViews(){const views=qa('.view');if(!views.length)return;const mo=new MutationObserver(()=>{if(q('.view.active'))sync()});views.forEach(v=>mo.observe(v,{attributes:true,attributeFilter:['class']}));
 // The Developer tools switch (first-run.js) toggles body.dev-tools-off: the menus redraw with or without the developer pages.
 let dev=devOff();new MutationObserver(()=>{if(devOff()===dev)return;dev=devOff();sync()}).observe(document.body,{attributes:true,attributeFilter:['class']});document.addEventListener('click',e=>{const b=e.target.closest?.('.navbtn[data-view]');if(b)requestAnimationFrame(()=>sync(b.dataset.view))})}
// An error box shown for a field marks that field invalid and describes it with the box; hidden again, it lets go.
// The boxes are drawn by their own pages (home.js, Models, improve.js); this follows their `hidden` attribute.
const ERROR_FIELDS={homeComposerError:'commandInput',modelPullError:'modelPullName',improveIdeaError:'improveIdeaText',improveItemError:'improveItemSheet'};
function linkError(box){const field=document.getElementById(ERROR_FIELDS[box.id]);if(!field)return;const ids=(field.getAttribute('aria-describedby')||'').split(' ').filter(x=>x&&x!==box.id),on=!box.hidden;
 if(on)ids.push(box.id);if(ids.length)field.setAttribute('aria-describedby',ids.join(' '));else field.removeAttribute('aria-describedby');
 if(field.tagName!=='DIALOG'){if(on)field.setAttribute('aria-invalid','true');else field.removeAttribute('aria-invalid')}}
function linkErrors(){const sync=()=>Object.keys(ERROR_FIELDS).forEach(id=>{const b=document.getElementById(id);if(b)linkError(b)});sync();
 new MutationObserver(ms=>{for(const m of ms){if(m.type==='attributes'){if(ERROR_FIELDS[m.target.id])linkError(m.target)}else if(m.addedNodes.length){sync();return}}}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden']})}
// The sticky header draws a 1px line once the page scrolls (body.ux-scrolled), unless page tabs under it draw their own.
function headerLine(){const strip=q('#uxPageStrip'),tabs=!!strip&&!strip.hidden&&strip.getBoundingClientRect().height>0;document.body.classList.toggle('ux-scrolled',window.scrollY>0&&!tabs)}
// iOS scrolls the page under a dialog even with overflow:hidden. While a modal dialog is open on a touch screen, the
// body is pinned (position:fixed at minus the scroll) and put back where it was on close; a page opened from the
// dialog starts at its top instead.
let pinned=null;
function scrollLock(){
 const open=matchMedia('(pointer:coarse)').matches&&!!document.querySelector('dialog[open]');
 if(open&&!pinned){const y=window.scrollY;pinned={y,view:activeView(),hash:location.hash};Object.assign(document.body.style,{position:'fixed',top:-y+'px',left:'0',right:'0',width:'100%'})}
 else if(!open&&pinned){const p=pinned;pinned=null;for(const k of ['position','top','left','right','width'])document.body.style.removeProperty(k);
  const back=()=>{if(!pinned)window.scrollTo({top:p.view===activeView()&&p.hash===location.hash?p.y:0,behavior:'instant'})};
  back();requestAnimationFrame(()=>requestAnimationFrame(back))} // again after a Back's own scroll restoration, which lands a frame later
}
function watchScroll(){
 let frame=0;window.addEventListener('scroll',()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;headerLine()})},{passive:true});
 new MutationObserver(scrollLock).observe(document.body,{attributes:true,attributeFilter:['class']});
 new MutationObserver(scrollLock).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
 headerLine();
}
function init(){document.body.classList.add('ux-v3');linkErrors();buildIntegrationsView();buildDesktopNav();buildContext();buildPageStrip();buildMobile();observeViews();sync();watchScroll()}
if(document.readyState==='complete')init();else window.addEventListener('load',init,{once:true});
})();

// ==== agent-world-city.js ====
(()=>{'use strict';
const W=1280,H=760,T=32,COLS=Math.floor(W/T),ROWS=Math.floor(H/T);
const $=(s,r=document)=>r.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n)),key=(x,y)=>x+','+y,now=()=>performance.now();
// One shared mission EventSource per tab (agent-specialists.js and agent-world-city.js both subscribe; whichever loads first creates it).
const missionStream=window.LocalAIMissionStream||(window.LocalAIMissionStream=(()=>{
 // Open only while Missions is on screen and the tab is visible: nothing else shows live mission state, and a stream
 // held open on every page keeps phones' connections awake and the page from ever going network-idle. Each (re)open
 // calls subscribers' onOpen, so they refetch what happened while it was closed.
 const subs=new Set();let es=null;
 const wanted=()=>document.visibilityState==='visible'&&!!document.querySelector('#agents.active');
 function open(){if(es)return;const s=new EventSource('/api/agents/missions/events');es=s;s.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}for(const x of[...subs])try{x.onMessage?.(m)}catch{}};s.onopen=()=>{for(const x of[...subs])try{x.onOpen?.()}catch{}};s.onerror=e=>{for(const x of[...subs])try{x.onError?.(e)}catch{}}}
 function close(){if(!es)return;es.close();es=null}
 function sync(){if(subs.size&&wanted())open();else close()}
 function watch(){const v=document.getElementById('agents');if(v)new MutationObserver(sync).observe(v,{attributes:true,attributeFilter:['class']});document.addEventListener('visibilitychange',sync);sync()}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watch,{once:true});else watch();
 return{subscribe(onMessage,onError,onOpen){const sub={onMessage,onError,onOpen};subs.add(sub);try{sync()}catch(e){subs.delete(sub);throw e}return()=>{subs.delete(sub);sync()}},isOpen:()=>!!es}})());

const DISTRICTS={
 command:{name:'Command Center',short:'Command',x:17,y:9,w:6,h:5,accent:'#71b7ff',roof:'#315f94',icon:'⌂',kind:'hq'},
 ux:{name:'UX Lab',short:'UX',x:4,y:4,w:6,h:4,accent:'#59e2ed',roof:'#197d8b',icon:'UX',kind:'lab'},
 docs:{name:'Documentation Studio',short:'Docs',x:29,y:4,w:6,h:4,accent:'#c498ff',roof:'#73509b',icon:'D',kind:'studio'},
 engineering:{name:'Engineering Bay',short:'Build',x:4,y:17,w:7,h:5,accent:'#ffb86a',roof:'#975c24',wall:['#6e4630','#3a2619'],icon:'E',kind:'bay'},
 validation:{name:'Validation Lab',short:'Validate',x:29,y:17,w:6,h:5,accent:'#75dfa2',roof:'#347650',icon:'V',kind:'lab'},
 models:{name:'Model Foundry',short:'Models',x:16,y:19,w:8,h:4,accent:'#ff8494',roof:'#8e3747',icon:'M',kind:'foundry'},
 projects:{name:'Projects Quarter',short:'Projects',x:15,y:2,w:10,h:4,accent:'#8db7ff',roof:'#405f95',icon:'P',kind:'archive'},
 repair:{name:'Repair Bay',short:'Repair',x:32,y:10,w:5,h:4,accent:'#ff7383',roof:'#8c3542',icon:'!',kind:'repair'}
};
const ROLE_ZONE={router:'command',mission_router:'command',ux_analyst:'ux',documentation:'docs',synthesis:'command',coordinator:'command',engineer:'engineering',validator:'validation',reviewer:'command',deployer:'engineering',operator:'validation',code_analyst:'engineering',test_engineer:'validation',research_agent:'projects',security_reviewer:'validation',performance_analyst:'models'};
const ROLE_COLOR={router:'#71b7ff',mission_router:'#71b7ff',ux_analyst:'#59e2ed',documentation:'#c498ff',synthesis:'#a8b5ff',coordinator:'#a8b5ff',engineer:'#ffb86a',validator:'#75dfa2',reviewer:'#c498ff',deployer:'#ffb86a',operator:'#75dfa2',code_analyst:'#ffb86a',test_engineer:'#75dfa2',research_agent:'#8db7ff',security_reviewer:'#ff8494',performance_analyst:'#ff8494'};
// A look per role: the prop they carry and, for the builders, a hard hat. The vest is their district's colour; skin,
// hair, shirt and trousers come from the worker id (lookFor), so a crew never looks like clones.
const ROLE_STYLE={router:{tool:'blueprint',hat:'#eef2f5'},mission_router:{tool:'blueprint',hat:'#eef2f5'},ux_analyst:{tool:'tablet'},documentation:{tool:'clipboard'},synthesis:{tool:'radio'},coordinator:{tool:'radio'},engineer:{tool:'wrench',hat:'#ffc640'},validator:{tool:'magnifier'},reviewer:{tool:'clipboard'},deployer:{tool:'crate',hat:'#ffc640'},operator:{tool:'radio',hat:'#ffc640'},code_analyst:{tool:'laptop'},test_engineer:{tool:'magnifier'},research_agent:{tool:'book'},security_reviewer:{tool:'magnifier'},performance_analyst:{tool:'drive'}};
const DEMO_STAGES=[
 {label:'Team lead planning',detail:'Picking the team',states:{router:'running',ux_analyst:'pending',documentation:'pending',synthesis:'pending'}},
 {label:'UX analysis',detail:'UX Analyst is working in the Interface Lab',states:{router:'complete',ux_analyst:'running',documentation:'pending',synthesis:'pending'}},
 {label:'Documentation',detail:'Findings are handed to Documentation',states:{router:'complete',ux_analyst:'complete',documentation:'running',synthesis:'pending'}},
 {label:'Synthesis',detail:'Coordinator is assembling the final mission result',states:{router:'complete',ux_analyst:'complete',documentation:'complete',synthesis:'running'}},
 {label:'Complete',detail:'Mission results are ready',states:{router:'complete',ux_analyst:'complete',documentation:'complete',synthesis:'complete'}}
];

let root,canvas,ctx,current=null,liveSnapshot=null,sourceType='idle',selected=null,hovered=null,raf=0,last=0;
let roads=new Set(),reach=new Set(),agents=new Map(),artifacts=[],packets=[],pulses=[],traffic=[],sparks=[],dust=[],events=[],clouds=[];
let view={zoom:1,panX:0,panY:0,targetZoom:1,targetPanX:0,targetPanY:0};
let drag=null,pointers=new Map(),pinch=null,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
let display={labels:true,flows:true,night:false,crew:true,follow:true};
let demo={active:false,running:false,paused:false,stage:0,speed:1,lastAdvance:0,scenario:'success'};
const REPLAY_KEY='localai.agentworld.replay.v2';
let replay={frames:[],active:false,index:0,playing:false,lastStep:0,speed:1,sourceMissionId:''};
let celebrationUntil=0,focusId='',notes=[];
// Camera: the map box's CSS size, device pixels per CSS pixel (capped at 2), and `base`, the scale at zoom 1, which
// covers the box with the city at any aspect ratio (a phone shows a tall slice, a desktop nearly all of it). Pans are
// CSS pixels; zoom is a multiple of base. The static ground is drawn once into groundCache and copied each frame.
const ZMAX=3;let cam={w:0,h:0,dpr:1,base:1},lastTap=0,groundCache=null,groundKey='';
// Workers are drawn 1.25x on touch screens and narrow windows, where 100% shows them small. Their feet stay put: every
// offset above the feet (sprite, ring, hit area, name tag, bubble) scales with WS.
let WS=1;const WS_Q='(pointer: coarse), (max-width: 720px)';
const sc=z=>cam.base*z;

function zoneForWorker(w){if(['error','blocked'].includes(w.state))return'repair';return ROLE_ZONE[w.id]||ROLE_ZONE[w.agentId]||(/doc/i.test(w.name||'')?'docs':/ux/i.test(w.name||'')?'ux':/model/i.test(w.name||'')?'models':'command')}
function districtCenter(id){const d=DISTRICTS[id]||DISTRICTS.command;return{x:(d.x+d.w/2)*T,y:(d.y+d.h+.8)*T}}
function districtDoor(id){
 const d=DISTRICTS[id]||DISTRICTS.command,cx=(d.x+d.w/2)*T,front=(d.y+d.h)*T;
 return{outside:{x:cx,y:front+T*.48},inside:{x:cx,y:front-T*.42}}
}
function workerTarget(w,zone){
 const d=DISTRICTS[zone]||DISTRICTS.command,workers=(current?.workers||[]).filter(q=>zoneForWorker(q)===zone),id=w.id||w.agentId||w.name,idx=Math.max(0,workers.findIndex(q=>(q.id||q.agentId||q.name)===id));
 const active=w.state==='running'||w.state==='error'||w.state==='blocked';
 if(active){
  const cols=Math.max(2,Math.min(3,Math.floor(d.w/2))),col=idx%cols,row=Math.floor(idx/cols)%2;
  return{x:(d.x+1.35+col*((d.w-2.7)/Math.max(1,cols-1)))*T,y:(d.y+1.65+row*1.15)*T,inside:true}
 }
 const base=districtCenter(zone),slots=[[-42,0],[42,0],[-72,24],[72,24],[0,34],[-34,54],[34,54]],slot=slots[idx%slots.length];
 return{x:base.x+slot[0],y:base.y+slot[1],inside:false}
}
function routeToTarget(agent,target,zone){
 const path=[],from={x:agent.x,y:agent.y};
 if(agent.inside&&agent.insideZone){const exit=districtDoor(agent.insideZone);path.push(exit.inside,exit.outside);from.x=exit.outside.x;from.y=exit.outside.y}
 if(target.inside){
  const door=districtDoor(zone),roadPath=astar(from,door.outside);path.push(...roadPath);
  if(!path.length||Math.hypot(path.at(-1).x-door.outside.x,path.at(-1).y-door.outside.y)>3)path.push(door.outside);
  path.push(door.inside,{x:target.x,y:target.y})
 }else{
  const roadPath=astar(from,target);path.push(...roadPath);
  if(!path.length||Math.hypot(path.at(-1).x-target.x,path.at(-1).y-target.y)>3)path.push({x:target.x,y:target.y})
 }
 return path
}
function road(x,y){roads.add(key(x,y))}
function buildRoads(){
 roads.clear();
 for(let x=2;x<COLS-2;x++){road(x,13);road(x,14)}
 for(let y=2;y<ROWS-1;y++){road(13,y);road(14,y);road(25,y);road(26,y)}
 for(let x=3;x<37;x++){road(x,9);road(x,23)}
 for(let y=4;y<23;y++){road(3,y);road(36,y)}
 for(let x=14;x<=25;x++){road(x,17);road(x,18)}
 // the street network a path can use: road tiles joined to the centre, not kerbs hugging a building or cut-off stubs
 reach.clear();const q=[[13,13]];while(q.length){const[x,y]=q.pop(),k=key(x,y);if(reach.has(k)||blocked(x,y))continue;reach.add(k);q.push([x+1,y],[x-1,y],[x,y+1],[x,y-1])}
}
function blocked(x,y){
 if(x<1||y<1||x>=COLS-1||y>=ROWS-1)return true;
 for(const d of Object.values(DISTRICTS))if(x>=d.x-1&&x<d.x+d.w+1&&y>=d.y-1&&y<d.y+d.h+1)return true;
 return!roads.has(key(x,y))
}
function nearestRoad(pt){let best={x:13,y:13},bd=Infinity;for(const k of reach){const[x,y]=k.split(',').map(Number),px=(x+.5)*T,py=(y+.5)*T,d=(px-pt.x)**2+(py-pt.y)**2;if(d<bd){bd=d;best={x,y}}}return best}
function astar(a,b){
 const start=nearestRoad(a),goal=nearestRoad(b),open=[start],came=new Map(),g=new Map([[key(start.x,start.y),0]]),f=new Map([[key(start.x,start.y),Math.abs(start.x-goal.x)+Math.abs(start.y-goal.y)]]);
 while(open.length){open.sort((u,v)=>(f.get(key(u.x,u.y))??1e9)-(f.get(key(v.x,v.y))??1e9));const cur=open.shift();
  if(cur.x===goal.x&&cur.y===goal.y){const path=[];let p=cur,k=key(p.x,p.y);while(p){path.unshift({x:(p.x+.5)*T,y:(p.y+.5)*T});const prev=came.get(k);p=prev;k=prev?key(prev.x,prev.y):''}return path}
  for(const n of[{x:cur.x+1,y:cur.y},{x:cur.x-1,y:cur.y},{x:cur.x,y:cur.y+1},{x:cur.x,y:cur.y-1}]){if(blocked(n.x,n.y)&&!(n.x===goal.x&&n.y===goal.y))continue;const nk=key(n.x,n.y),tent=(g.get(key(cur.x,cur.y))||0)+1;if(tent<(g.get(nk)??1e9)){came.set(nk,cur);g.set(nk,tent);f.set(nk,tent+Math.abs(n.x-goal.x)+Math.abs(n.y-goal.y));if(!open.some(o=>o.x===n.x&&o.y===n.y))open.push(n)}}}
 return[]
}
function normalizeMission(m){return{type:'mission',id:m.id,status:m.status,goal:m.goal||'Mission',createdAt:m.createdAt,finishedAt:m.finishedAt,updatedAt:m.updatedAt||m.createdAt,workers:(m.workers||[]).map(w=>({...w,id:w.id||w.agentId})),routing:m.routing||null,timeline:m.timeline||[],results:m.results||[],error:m.error||'',raw:m}}
function ensureAgent(w){
 const id=w.id||w.agentId||w.name;if(!id)return;
 let a=agents.get(id),zone=zoneForWorker(w),target=workerTarget(w,zone);
 // The owner's name for the worker ("Team lead", not the server's "Mission Router"): the city's labels use it.
 const nm=window.LocalAIAgentWords?.workerName({...w,id})||w.name||id;
 if(!a){const p=districtCenter('command'),h=hash(id);a={id,name:nm,x:p.x,y:p.y,tx:p.x,ty:p.y,path:[],pathI:0,state:'pending',zone:'command',targetZone:zone,color:ROLE_COLOR[id]||'#8fb5e8',model:w.model||'',dir:h&1?1:-1,style:lookFor(id),activitySeed:h%997/97,inside:false,insideZone:null,targetInside:false,transition:'idle'};agents.set(id,a)}
 const fresh=!a.seen;a.seen=true;const old=a.state;a.name=nm||a.name;a.model=w.model||a.model;a.state=w.state||a.state;a.targetZone=zone;a.color=ROLE_COLOR[id]||a.color;
 if(a.zone!==zone||Math.hypot(a.tx-target.x,a.ty-target.y)>2||a.targetInside!==target.inside){a.tx=target.x;a.ty=target.y;a.targetInside=!!target.inside;a.transition=target.inside?'entering':(a.inside?'exiting':'traveling');a.path=routeToTarget(a,target,zone);a.pathI=0;a.zone=zone}
 if(reduced){a.x=target.x;a.y=target.y;a.path=[];a.inside=!!target.inside;a.insideZone=a.inside?zone:null}
 if(old!==a.state){
  if(!fresh&&sourceType!=='replay'){focusId=id;const t=window.LocalAIAgentWords?.changeSentence(w,current?.raw||current);if(t)note(t,a.state)}
  if(a.state==='running'){spawnPacket('models',zone,a.color,'MODEL');spawnSpark(target.x,target.y,a.color,18)}
  if(a.state==='complete'){
   if(!fresh)a.doneAt=now();spawnArtifact(a);spawnSpark(target.x,target.y,'#75dfa2',26);
   for(const next of current?.workers||[])if((next.dependsOn||[]).includes(id))spawnPacket(zone,zoneForWorker(next),a.color,'HANDOFF')
  }
  if(['error','blocked'].includes(a.state))spawnSpark(target.x,target.y,'#ff7383',36)
 }
}
function spawnArtifact(a){if(artifacts.some(x=>x.workerId===a.id))return;const p=districtCenter(a.zone),kind=['engineer','code_analyst','deployer'].includes(a.id)?'build':['validator','test_engineer','security_reviewer'].includes(a.id)?'certificate':['documentation','research_agent','ux_analyst'].includes(a.id)?'document':'node';artifacts.push({workerId:a.id,label:a.name,kind,x:p.x+26,y:p.y-14,color:a.color,created:now()})}
function spawnPacket(from,to,color,label='EVIDENCE'){if(reduced)return;const p=flowPath(from,to).p;if(p.length)packets.push({path:p,i:0,x:p[0].x,y:p[0].y,color,label,done:false,created:now()})}
function spawnSpark(x,y,color,n=12){if(!reduced)for(let i=0;i<n;i++)sparks.push({x,y,vx:(Math.random()-.5)*80,vy:-20-Math.random()*80,life:.7+Math.random()*.7,color,size:1+Math.random()*2})}
// Notes float over the city's top-left for 4 s, three at most; the story keeps them all.
function note(text,state){notes.unshift({text,state,at:now()});notes=notes.slice(0,3);syncNotes();setTimeout(syncNotes,4100)}
function syncNotes(){const h=$('#awcToasts');if(!h)return;const t=now();notes=notes.filter(n=>t-n.at<4000);h.innerHTML=notes.map(n=>`<li data-state="${esc(n.state)}">${esc(n.text)}</li>`).join('')}
function addEvent(text){events.unshift({text,at:new Date()});events=events.slice(0,12);syncEventFeed()}
function loadReplay(){try{const saved=JSON.parse(localStorage.getItem(REPLAY_KEY)||'null');if(saved&&Array.isArray(saved.frames)){replay.frames=saved.frames.slice(-120);replay.index=Math.max(0,replay.frames.length-1);replay.speed=saved.speed||1;replay.sourceMissionId=saved.sourceMissionId||''}}catch{}}
function persistReplay(){try{localStorage.setItem(REPLAY_KEY,JSON.stringify({frames:replay.frames.slice(-120),speed:replay.speed,sourceMissionId:replay.sourceMissionId}))}catch{}}
function timelineMission(base,event){
 const m=normalizeMission(base),states=new Map((event.workers||[]).map(w=>[w.id,w]));
 m.status=event.status||m.status;m.updatedAt=event.at||m.updatedAt;m.workers=m.workers.map(w=>({...w,...(states.get(w.id)||{})}));
 return m
}
function primeMissionReplay(m){
 const timeline=m?.timeline||[];if(!timeline.length)return false;
 replay.frames=timeline.map((e,i)=>({at:Date.parse(e.at)||Date.now()+i,reason:e.type||'state',detail:e.detail||'',workerId:e.workerId||'',sig:e.sig||String(i),mission:timelineMission(m,e)})).slice(-120);
 replay.index=Math.max(0,replay.frames.length-1);replay.sourceMissionId=m.id||'';persistReplay();syncReplay();return true
}
function loadMissionReplay(m){if(!m)return;if(!primeMissionReplay(m)){const n=normalizeMission(m);replay.frames=[{at:Date.parse(n.updatedAt)||Date.now(),reason:'snapshot',detail:'Historical mission snapshot',workerId:'',sig:n.id,mission:n}];replay.index=0;replay.sourceMissionId=n.id||'';persistReplay();syncReplay()}addEvent('Replay loaded: '+(m.goal||m.id||'mission'))}
function recordReplayFrame(reason){
 if(replay.active||!current)return;const sig=(current.workers||[]).map(w=>w.id+':'+w.state).join('|')+'|'+current.status;const last=replay.frames.at(-1);if(last?.sig===sig)return;
 replay.frames.push({at:Date.now(),reason,detail:'',workerId:'',sig,mission:JSON.parse(JSON.stringify(current))});replay.frames=replay.frames.slice(-120);replay.index=replay.frames.length-1;replay.sourceMissionId=current.id||replay.sourceMissionId;persistReplay();syncReplay()
}
function replayEventClass(frame){const m=frame?.mission,ws=m?.workers||[];if(ws.length&&ws.every(w=>w.state==='complete'))return'done';if(ws.some(w=>w.state==='error'||w.state==='blocked')||/attention|fail/.test(String(frame?.reason)))return'bad';if(ws.some(w=>w.state==='running'))return'active';return'wait'}
function syncReplay(){
 if(!root)return;const range=$('#awcReplayRange'),label=$('#awcReplayLabel'),markers=$('#awcReplayMarkers'),play=$('#awcReplayPlay'),scrub=$('#awcScrub'),n=replay.frames.length,frame=replay.frames[replay.index];
 if(scrub)scrub.hidden=!(n>1&&(replay.active||sourceType==='mission'&&current?.status!=='running'));
 if(range){range.max=Math.max(0,n-1);range.value=replay.index;range.disabled=n<2}
 const when=f=>f?new Date(f.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'';
 if(label)label.textContent=n?(replay.active?'Step '+(replay.index+1)+' of '+n+' · '+when(frame):n+' steps'):'';
 if(markers){markers.innerHTML=replay.frames.map((f,i)=>`<button type="button" data-replay-index="${i}" class="${replayEventClass(f)} ${i===replay.index&&replay.active?'active':''}" aria-label="Step ${i+1}, ${esc(when(f))}"></button>`).join('');markers.querySelectorAll('[data-replay-index]').forEach(b=>b.onclick=()=>applyReplayFrame(Number(b.dataset.replayIndex)))}
 if(play){play.textContent=replay.playing?'❚❚':'▶';play.setAttribute('aria-label',replay.playing?'Pause the replay':'Play the replay')}
 const live=$('#awcReplayLive');if(live)live.hidden=!replay.active;const sp=document.querySelector('[data-aw-view="speed"]');if(sp)sp.textContent='Replay speed: '+replay.speed+'×'
}
function applyReplayFrame(i,preservePlaying=false){
 if(!replay.frames.length)return;const wasPlaying=replay.playing;replay.active=true;replay.playing=preservePlaying&&wasPlaying;replay.index=clamp(Number(i)||0,0,replay.frames.length-1);const frame=replay.frames[replay.index];agents.clear();artifacts=[];packets=[];sparks=[];dust=[];current=JSON.parse(JSON.stringify(frame.mission));sourceType='replay';current.workers.forEach(ensureAgent);selected=frame.workerId?{type:'agent',id:String(frame.workerId).split(',')[0]}:selected;syncHud();syncSelection();syncReplay()
}
function toggleReplay(){if(replay.frames.length<2)return;if(!replay.active)applyReplayFrame(0);replay.playing=!replay.playing;replay.lastStep=now();syncReplay()}
function cycleReplaySpeed(){replay.speed=replay.speed===1?2:replay.speed===2?4:1;persistReplay();syncReplay()}
function returnReplayLive(){replay.active=false;replay.playing=false;if(liveSnapshot){agents.clear();current=liveSnapshot;sourceType='mission';current.workers.forEach(ensureAgent)}syncHud();syncSelection();syncReplay()}
function applyMission(m){
 if(!m||demo.active)return;const prev=current,next=normalizeMission(m),wasComplete=prev?.status==='complete';
 if(!prev||prev.id!==next.id){agents.clear();artifacts=[];packets=[];sparks=[];dust=[]}
 current=next;liveSnapshot=next;sourceType='mission';current.workers.forEach(ensureAgent);
 if(!prev||prev.id!==current.id)addEvent('Mission entered Agent World');
 if(next.timeline?.length)primeMissionReplay(next);else recordReplayFrame('mission');
 if(next.status==='complete'&&!wasComplete&&prev?.id===next.id&&!reduced){const p=districtCenter('command');spawnSpark(p.x,p.y,'#75dfa2',54);celebrationUntil=now()+3600;addEvent('Mission complete · the summary is ready')}
 syncHud()
}
function engWorkers(run){const s=run.status||'idle';return[{id:'engineer',name:'Engineer',state:s==='running'?'running':s==='needs_attention'?'error':s==='applied'?'complete':'pending'},{id:'validator',name:'Validator',state:s==='running'?'running':s==='awaiting_approval'?'complete':'pending'},{id:'reviewer',name:'Reviewer',state:s==='awaiting_approval'?'running':['approved','apply_requested','applied'].includes(s)?'complete':'pending'},{id:'deployer',name:'Deployer',state:['approved','apply_requested'].includes(s)?'running':s==='applied'?'complete':'pending'},{id:'operator',name:'Operator',state:s==='applied'?'complete':'pending'}]}
function applyEngineering(run){if(!run||demo.active||(sourceType==='mission'&&current?.status==='running'))return;current={type:'engineering',id:run.id,status:run.status,goal:run.request||'Engineering run',workers:engWorkers(run),raw:run};sourceType='engineering';current.workers.forEach(ensureAgent);syncHud()}
function demoMission(){
 const states=DEMO_STAGES[demo.stage].states,workers=[{id:'router',name:'Team lead',model:'deterministic dispatcher'},{id:'ux_analyst',name:'UX Analyst',model:'qwen3:4b-instruct-32k'},{id:'documentation',name:'Documentation Agent',model:'qwen3:4b-instruct-32k'},{id:'synthesis',name:'Coordinator',model:'qwen3:4b-instruct-32k'}].map(w=>({...w,state:states[w.id]||'pending',dependsOn:w.id==='ux_analyst'?['router']:w.id==='documentation'?['ux_analyst']:w.id==='synthesis'?['documentation']:[]}));
 if(demo.scenario==='failure'&&demo.stage>=2){workers.find(w=>w.id==='documentation').state='error';workers.find(w=>w.id==='synthesis').state='blocked'}
 return{type:'mission',id:'demo-city-mission',status:demo.scenario==='failure'&&demo.stage>=2?'needs_attention':demo.stage===4?'complete':'running',goal:demo.scenario==='failure'?'Demo: recover a failed documentation handoff':'Demo: audit and improve Local AI mobile UX',workers,error:demo.scenario==='failure'&&demo.stage>=2?'Documentation Agent needs attention':''}
}
function applyDemo(){const next=demoMission();if(!demo.active||current?.id!==next.id){agents.clear();artifacts=[];packets=[];sparks=[]}current=next;sourceType='demo';current.workers.forEach(ensureAgent);syncHud();addEvent('Demo: '+DEMO_STAGES[demo.stage].label);recordReplayFrame('demo-stage-'+demo.stage)}
function startDemo(){document.querySelector('.aw-page')?.classList.add('is-demo');demo.active=true;demo.running=true;demo.paused=false;demo.stage=0;demo.lastAdvance=now();applyDemo();fitWorld();syncDemoControls()}
function stepDemo(){if(!demo.active)startDemo();else{demo.stage=Math.min(DEMO_STAGES.length-1,demo.stage+1);demo.lastAdvance=now();applyDemo();if(demo.stage===DEMO_STAGES.length-1)demo.running=false}syncDemoControls()}
function returnLive(){document.querySelector('.aw-page')?.classList.remove('is-demo');replay.active=false;replay.playing=false;demo.active=false;demo.running=false;demo.paused=false;agents.clear();artifacts=[];packets=[];sparks=[];dust=[];if(liveSnapshot){current=liveSnapshot;sourceType='mission';current.workers.forEach(ensureAgent)}else{current=null;sourceType='idle';idleCrew()}syncHud();syncDemoControls();syncReplay();fitWorld()}
function syncDemoControls(){const l=$('#awcLiveBtn');if(l)l.hidden=!demo.active}
function syncHud(){
 if(!root)return;const workers=current?.workers||[],running=workers.filter(w=>w.state==='running').length,bad=workers.filter(w=>['error','blocked'].includes(w.state)).length;
 root.dataset.source=sourceType;root.dataset.state=bad?'attention':running?'running':current?.status==='complete'?'complete':workers.length?'waiting':'idle';syncRoster();syncReplay();paint()
}
// Crew rows, the accessible equivalent of the city: portrait, name, role in words, state, and what they are doing now.
// The sheet's peek row shows the same crew as small portraits beside the status sentence.
function syncRoster(){
 const A=window.LocalAIAgentWords,workers=current?.workers||[],m=current?(current.raw||current):null,h=$('#awcRoster');if(!A)return;
 if(h){h.innerHTML=workers.length?workers.map(w=>{const b=A.stateBadge(w.state);return `<button type="button" class="awc__rosterItem ${esc(w.state)}" data-awc-roster="${esc(w.id)}"><img class="awc__avatar" src="${avatar(w)}" alt="" width="40" height="40"><span class="awc__rosterText"><strong>${esc(A.workerName(w))}</strong><small>${esc(A.workerRole(w))}</small><span>${esc(A.workerStep(w,m))}</span></span><em class="badge badge--${b.tone}">${esc(b.label)}</em></button>`}).join(''):'<div class="awc__empty">No workers yet.</div>';h.querySelectorAll('[data-awc-roster]').forEach(b=>b.onclick=()=>focusWorker(b.dataset.awcRoster))}
 const av=$('#awSheetAvatars');if(av)av.innerHTML=workers.map(w=>`<img class="awc__avatar is-${esc(w.state)}" data-worker="${esc(w.id)}" src="${avatar(w)}" alt="" width="30" height="30">`).join('');
 const st=$('#awSheetStatus');if(st){const t=A.statusSentence(m),i=t.label?t.text.indexOf(' · '):-1;st.dataset.tone=t.tone;st.innerHTML=i>0?`<b>${esc(t.text.slice(0,i))}</b>${esc(t.text.slice(i))}`:esc(t.text)}
}
// A worker's pixel portrait: head and shoulders from the city's own sprite sheet.
const portraits=new Map();
function avatar(w){
 const s=lookFor(w.id||w.agentId||w.name);if(portraits.has(s.key))return portraits.get(s.key);let url='';
 try{const c=document.createElement('canvas'),g=c.getContext('2d');c.width=c.height=48;g.imageSmoothingEnabled=false;g.drawImage(sheetFor(s),4,0,12,12,0,0,48,48);url=c.toDataURL()}catch{}
 portraits.set(s.key,url);return url
}
function syncEventFeed(){if(!root)return;const h=$('#awcEventFeed');if(h)h.innerHTML=events.length?events.slice(0,4).map(e=>`<div><span>${esc(e.text)}</span><time>${e.at.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></div>`).join(''):'<div><span>Waiting for activity</span></div>'}
let externalFocus=false;
function syncSelection(){
 if(!root)return;const h=$('#awcSelection');h.dataset.empty=String(!selected);if(!selected){h.innerHTML='<span>Select a worker or building</span><small>Inspect district state and focus the camera.</small>';return}
 if(selected.type==='agent'){const a=agents.get(selected.id);if(!a)return;const A=window.LocalAIAgentWords,w=(current?.workers||[]).find(q=>(q.id||q.agentId)===a.id)||a;h.innerHTML=`<strong>${esc(A?A.workerName(w):a.name)}</strong><small>${esc(A?A.stateBadge(a.state).label+' · '+A.workerRole(w):a.state)}</small>`;if(!externalFocus)window.dispatchEvent(new CustomEvent('localai:agentworld-select',{detail:{workerId:a.id}}))}
 else{const d=DISTRICTS[selected.id],workers=[...agents.values()].filter(a=>a.zone===selected.id);h.innerHTML=`<strong>${esc(d.name)}</strong><small>${workers.length?workers.map(a=>esc(a.name)).join(', '):'No workers in district'}</small>`}
}
// The pan that keeps the city covering the box at zoom z (centred on an axis where the city is the smaller).
function clampPan(z,px,py){const s=sc(z),mx=cam.w-W*s,my=cam.h-H*s;return{x:mx>0?mx/2:clamp(px,mx,0),y:my>0?my/2:clamp(py,my,0)}}
function limitTargetPan(){const p=clampPan(view.targetZoom,view.targetPanX,view.targetPanY);view.targetPanX=p.x;view.targetPanY=p.y}
function fitWorld(){focusPoint(W/2,H/2,1)}
function focusPoint(x,y,z=1.8){view.targetZoom=clamp(z,1,ZMAX);const s=sc(view.targetZoom);view.targetPanX=cam.w/2-x*s;view.targetPanY=cam.h/2-y*s;limitTargetPan();syncZoomLabel()}
function focusActive(){const a=[...agents.values()].find(x=>x.state==='running')||[...agents.values()][0];if(a){selected={type:'agent',id:a.id};syncSelection();focusPoint(a.x,a.y,2)}}
function userCamera(){if(display.follow)toggleFollow(false)}
function focusWorker(id){const a=agents.get(id);if(a){if(!externalFocus)userCamera();selected={type:'agent',id};syncSelection();focusPoint(a.x,a.y,2)}}
function zoomAt(factor,cx=cam.w/2,cy=cam.h/2){const old=sc(view.targetZoom),nz=clamp(view.targetZoom*factor,1,ZMAX),wx=(cx-view.targetPanX)/old,wy=(cy-view.targetPanY)/old;view.targetZoom=nz;view.targetPanX=cx-wx*sc(nz);view.targetPanY=cy-wy*sc(nz);limitTargetPan();syncZoomLabel()}
function syncZoomLabel(){const l=$('#awcZoomLabel');if(l)l.textContent=Math.round(view.targetZoom*100)+'%'}
function screenPoint(e){const r=canvas.getBoundingClientRect(),px=e.clientX-r.left,py=e.clientY-r.top,s=sc(view.zoom);return{px,py,x:(px-view.panX)/s,y:(py-view.panY)/s}}
// The backing store follows the box: CSS size × device pixels, re-measured whenever the box changes (phone sheet,
// theater, a run view borrowing the city), keeping the same spot in the middle. It paints at once, so the city never
// waits on the animation loop (or on an IntersectionObserver) to appear.
function resize(){
 const wrap=canvas?.parentElement;if(!wrap)return;const w=wrap.clientWidth,h=wrap.clientHeight;if(!w||!h)return;
 const dpr=Math.min(2,devicePixelRatio||1),bw=Math.round(w*dpr),bh=Math.round(h*dpr);if(w===cam.w&&h===cam.h&&canvas.width===bw&&canvas.height===bh&&WS===(matchMedia(WS_Q).matches?1.25:1))return;
 const first=!cam.w,s=sc(view.targetZoom),cx=first?W/2:(cam.w/2-view.targetPanX)/s,cy=first?H/2:(cam.h/2-view.targetPanY)/s;
 WS=matchMedia(WS_Q).matches?1.25:1;cam={w,h,dpr,base:Math.max(w/W,h/H)};canvas.width=bw;canvas.height=bh;ctx=canvas.getContext('2d');
 focusPoint(cx,cy,view.targetZoom);view.zoom=view.targetZoom;view.panX=view.targetPanX;view.panY=view.targetPanY;paint()
}
function paint(){if(ctx&&cam.w&&!raf)draw(now())}
function hitAt(x,y){
 for(const a of agents.values())if(Math.hypot(x-a.x,y-a.y+28*(WS-1))<27*WS)return{type:'agent',id:a.id};
 for(const[id,d]of Object.entries(DISTRICTS))if(x>=d.x*T&&x<=(d.x+d.w)*T&&y>=d.y*T&&y<=(d.y+d.h)*T)return{type:'district',id};
 return null
}
function selectAt(e){const p=screenPoint(e);selected=hitAt(p.x,p.y);syncSelection();if(selected?.type==='district'){const d=DISTRICTS[selected.id];focusPoint((d.x+d.w/2)*T,(d.y+d.h/2)*T,1.65)}}
function updateHover(e){
 if(drag||pointers.size>1)return;const p=screenPoint(e),hit=hitAt(p.x,p.y);hovered=hit;const tip=$('#awcTooltip');if(!tip)return;
 if(!hit||hit.type!=='agent'){tip.hidden=true;return}
 const a=agents.get(hit.id),A=window.LocalAIAgentWords;tip.innerHTML='<strong>'+esc(A?A.workerName(a):a.name)+'</strong><span>'+esc(A?A.stateBadge(a.state).label:a.state)+' · '+esc(DISTRICTS[a.zone]?.name||a.zone)+'</span>';tip.hidden=false;
 tip.style.left=clamp(e.offsetX+12,8,canvas.clientWidth-176)+'px';tip.style.top=clamp(e.offsetY-54,8,canvas.clientHeight-54)+'px'
}
function toggleDisplay(k){display[k]=!display[k];document.querySelector('[data-aw-view="'+k+'"]')?.setAttribute('aria-checked',String(display[k]));if(k==='night')root?.classList.toggle('is-night',display.night)}
function toggleFollow(on=!display.follow){display.follow=!!on;$('#awcFollow')?.setAttribute('aria-pressed',String(display.follow));if(display.follow){const a=agents.get(focusId)||[...agents.values()].find(x=>x.state==='running');if(a)focusPoint(a.x,a.y,Math.max(1.7,view.targetZoom))}window.dispatchEvent(new Event('localai:agentworld-follow'))}
// Theater moves the frame to <body>: an ancestor of the Agents page creates a containing block that traps position:fixed.
let theaterHome=null;
function setTheaterHost(on){if(on&&!theaterHome){theaterHome=document.createComment('agent-world');root.before(theaterHome);document.body.appendChild(root)}else if(!on&&theaterHome){theaterHome.replaceWith(root);theaterHome=null}}
function toggleExpanded(){const on=!root.classList.contains('is-expanded');setTheaterHost(on);root.classList.toggle('is-expanded',on);document.body.classList.toggle('awc-stage-expanded',on);const v=document.querySelector('[data-aw-view="theater"]');if(v)v.textContent=on?'Exit full screen':'Full screen';setTimeout(()=>{if(on)focusActive();else fitWorld()},40)}
function exitExpanded(){if(!root?.classList.contains('is-expanded'))return;root.classList.remove('is-expanded');setTheaterHost(false);document.body.classList.remove('awc-stage-expanded');const v=document.querySelector('[data-aw-view="theater"]');if(v)v.textContent='Full screen';fitWorld()}

function mount(){
 const host=$('#agentWorldCityMount');if(!host)return;root=document.createElement('section');root.className='awc awc-v3';root.dataset.state='idle';root.innerHTML=`
 <div class="awc__gameShell">
  <div class="awc__mapWrap">
   <canvas id="awcCanvas" tabindex="0" aria-label="Agent World city map. Drag to move, pinch or scroll to zoom, tap a worker or building. Keys: plus and minus zoom, 0 fits the city, F follows, T full screen. The crew list has the same information."></canvas>
   <div class="awc__tooltip" id="awcTooltip" hidden></div>
   <div class="awc__mapHud">
    <div class="awc__selection" id="awcSelection" data-empty="true"><span>Select a worker or building</span><small>Click to inspect</small></div>
    <div class="awc__minimap" id="awcMinimap" aria-hidden="true"></div>
   </div>
   <ul class="awc__toasts" id="awcToasts" aria-hidden="true"></ul>
   <div class="awc__controls" role="toolbar" aria-label="Zoom and follow"><button id="awcZoomOut" type="button" aria-label="Zoom out">−</button><span id="awcZoomLabel" aria-live="polite">100%</span><button id="awcZoomIn" type="button" aria-label="Zoom in">+</button><button id="awcFollow" type="button" aria-pressed="true" title="Keep the camera on the busy worker (F)">Follow</button></div>
  </div>
 </div>
 <div class="awc__scrub" id="awcScrub" hidden><button id="awcReplayPlay" type="button" aria-label="Play the replay">▶</button><div class="awc__scrubTrack"><div class="awc__replayMarkers" id="awcReplayMarkers"></div><input id="awcReplayRange" type="range" min="0" max="0" value="0" disabled aria-label="Replay position"></div><span id="awcReplayLabel"></span><button id="awcReplayLive" type="button" hidden>Back to now</button></div>
 <button id="awcLiveBtn" class="awc__demoChip" type="button" hidden>Demo · Stop</button>`;
 host.appendChild(root);loadReplay();syncReplay();canvas=$('#awcCanvas');ctx=canvas.getContext('2d');
 $('#awcReplayPlay').onclick=toggleReplay;$('#awcReplayLive').onclick=returnReplayLive;$('#awcReplayRange').oninput=e=>applyReplayFrame(e.target.value);$('#awcFollow').onclick=()=>toggleFollow();$('#awcZoomIn').onclick=()=>{userCamera();zoomAt(1.2)};$('#awcZoomOut').onclick=()=>{userCamera();zoomAt(.84)};$('#awcLiveBtn').onclick=returnLive;

 canvas.addEventListener('wheel',e=>{e.preventDefault();userCamera();const p=screenPoint(e);zoomAt(e.deltaY<0?1.12:.89,p.px,p.py)},{passive:false});
 canvas.addEventListener('dblclick',e=>{e.preventDefault();userCamera();fitWorld()});
 canvas.addEventListener('pointerdown',e=>{try{canvas.setPointerCapture(e.pointerId)}catch{}const p=screenPoint(e);pointers.set(e.pointerId,{x:p.px,y:p.py});if(pointers.size===1){drag={id:e.pointerId,startX:p.px,startY:p.py,panX:view.targetPanX,panY:view.targetPanY,moved:false};pinch=null}else if(pointers.size===2){const ps=[...pointers.values()];pinch={distance:Math.max(1,Math.hypot(ps[1].x-ps[0].x,ps[1].y-ps[0].y)),zoom:view.targetZoom,panX:view.targetPanX,panY:view.targetPanY,cx:(ps[0].x+ps[1].x)/2,cy:(ps[0].y+ps[1].y)/2};drag=null}});
 canvas.addEventListener('pointermove',e=>{updateHover(e);if(!pointers.has(e.pointerId))return;const p=screenPoint(e);pointers.set(e.pointerId,{x:p.px,y:p.py});
  if(pointers.size===2&&pinch){userCamera();const ps=[...pointers.values()],dist=Math.max(1,Math.hypot(ps[1].x-ps[0].x,ps[1].y-ps[0].y)),cx=(ps[0].x+ps[1].x)/2,cy=(ps[0].y+ps[1].y)/2,nz=clamp(pinch.zoom*dist/pinch.distance,1,ZMAX),wx=(pinch.cx-pinch.panX)/sc(pinch.zoom),wy=(pinch.cy-pinch.panY)/sc(pinch.zoom);view.targetZoom=nz;view.targetPanX=cx-wx*sc(nz);view.targetPanY=cy-wy*sc(nz);limitTargetPan();syncZoomLabel();return}
  if(!drag||drag.id!==e.pointerId)return;const dx=p.px-drag.startX,dy=p.py-drag.startY;if(Math.abs(dx)+Math.abs(dy)>4){drag.moved=true;userCamera()}view.targetPanX=drag.panX+dx;view.targetPanY=drag.panY+dy;limitTargetPan()});
 // A tap selects; two taps in quick succession fit the city (touch has no double-click).
 canvas.addEventListener('pointerup',e=>{const wasSingle=pointers.size===1,moved=drag?.moved||false;pointers.delete(e.pointerId);if(wasSingle&&!moved){if(e.pointerType==='touch'&&e.timeStamp-lastTap<320){lastTap=0;userCamera();fitWorld()}else{lastTap=e.timeStamp;selectAt(e)}}if(pointers.size===1){const[id,p]=[...pointers.entries()][0];drag={id,startX:p.x,startY:p.y,panX:view.targetPanX,panY:view.targetPanY,moved:true}}else drag=null;if(pointers.size<2)pinch=null});
 canvas.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);drag=null;if(pointers.size<2)pinch=null});canvas.addEventListener('pointerleave',()=>{const t=$('#awcTooltip');if(t)t.hidden=true});
 canvas.addEventListener('keydown',e=>{if(['+','=','-','0'].includes(e.key))userCamera();if(e.key==='+'||e.key==='=')zoomAt(1.2);if(e.key==='-')zoomAt(.84);if(e.key==='0')fitWorld();if(e.key==='f')toggleFollow();if(e.key==='a')focusActive();if(e.key==='t')toggleExpanded();if(e.key==='Enter'&&hovered){selected=hovered;syncSelection()}});document.addEventListener('keydown',e=>{if(e.key==='Escape')exitExpanded()});
 // The Agents panel answers our select event with a focus event; don't echo it back as another select.
 window.addEventListener('localai:agentworld-focus',e=>{externalFocus=true;try{focusWorker(e.detail?.workerId)}finally{externalFocus=false}});
 if('ResizeObserver' in window)new ResizeObserver(resize).observe($('.awc__mapWrap',root));window.addEventListener('resize',resize);
 window.LocalAIAgentWorld={camera:()=>({zoom:view.targetZoom,panX:view.targetPanX,panY:view.targetPanY,shown:{zoom:view.zoom,panX:view.panX,panY:view.panY},...cam}),avatar,following:()=>display.follow,follow:on=>toggleFollow(on),demo:()=>{startDemo();syncDemoControls()},demoStep:()=>stepDemo(),busy:()=>demo.active||replay.active,display:()=>({...display}),view:k=>k==='speed'?cycleReplaySpeed():k==='theater'?toggleExpanded():k==='fit'?(userCamera(),fitWorld()):toggleDisplay(k),walking:()=>[...agents.values()].filter(workerIsMoving).length,names:()=>[...agents.values()].map(a=>a.name),
  moments:()=>({flags:[...agents.values()].filter(a=>a.state==='complete').map(a=>a.id),warnings:[...agents.values()].filter(a=>a.state==='error'||a.state==='blocked').map(a=>a.id),fireworks:celebrationUntil>now()})};
 // __awcSim (tests): put a worker somewhere still, or a car somewhere on its street, in world pixels.
 try{if(localStorage.getItem('localai.debug')==='1'){window.__awcLayout=layout;window.__awcSim={put(id,x,y){const a=agents.get(id);if(a){a.x=a.tx=x;a.y=a.ty=y;a.path=[];a.pathI=0;a.onSite=false}},car(i,x,y){const c=traffic[i];if(c){c.x=x;c.y=y;c.go=1}}}}}catch{}
 document.body.classList.add('agent-world-city-ready');buildRoads();plantScenery();seedAmbient();syncDemoControls();syncHud();syncEventFeed();resize();start();bootstrap()
}
const IDLE=[['router','Team lead'],['ux_analyst','UX Analyst'],['documentation','Documentation Agent'],['research_agent','Research Agent'],['engineer','Engineer']];
function idleCrew(){if(current||agents.size)return;for(const[id,name]of IDLE)ensureAgent({id,name,state:'pending'})}
// Zebra crossings (drawn in drawGroundStatic) as world boxes, with the axis of the street they cross: cars on that axis
// slow and stop short of one while a worker is on it or about to step on it, then pull away again.
const CROSSINGS=[13,25].flatMap(cx=>[...[12,15].map(ty=>({x:cx*T,y:ty*T,w:2*T,h:T,axis:'y'})),...[cx-1,cx+2].map(tx=>({x:tx*T,y:13*T,w:T,h:2*T,axis:'x'}))]);
function carGo(c,dt){
 let go=1;const X=c.axis==='x',pos=X?c.x:c.y,lane=X?c.y:c.x,front=pos+c.dir*7;
 for(const z of CROSSINGS){
  if(z.axis!==c.axis)continue;const lo=X?z.x:z.y,hi=lo+(X?z.w:z.h),l0=X?z.y:z.x,l1=l0+(X?z.h:z.w);if(lane<l0||lane>l1)continue;
  const gap=c.dir>0?lo-front:front-hi;if(gap<-2||gap>56)continue;
  if([...agents.values()].some(a=>a.x>z.x-12&&a.x<z.x+z.w+12&&a.y>z.y-12&&a.y<z.y+z.h+12))go=Math.min(go,gap<=6?0:clamp((gap-6)/40,.25,1))
 }
 // brake at once, pull away over about a second
 return go<(c.go??1)?go:Math.min(go,(c.go??1)+dt)
}
function seedAmbient(){traffic=[{x:2*T,y:13.5*T,v:28,axis:'x',dir:1,color:'#6aaeff'},{x:36*T,y:14.5*T,v:23,axis:'x',dir:-1,color:'#ffc56b'},{x:25.5*T,y:3*T,v:20,axis:'y',dir:1,color:'#c18cff'},{x:13.5*T,y:21*T,v:18,axis:'y',dir:-1,color:'#75dfa2'}];clouds=[{x:160,y:80,s:1.1},{x:880,y:130,s:.8},{x:560,y:40,s:.6}]}
function update(dt,ts){
 if(display.follow&&!drag&&!pointers.size){const f=agents.get(focusId),a=f&&f.state!=='pending'?f:[...agents.values()].find(q=>q.state==='running');if(a){view.targetZoom=Math.max(view.targetZoom,1.7);view.targetPanX=cam.w/2-a.x*sc(view.targetZoom);view.targetPanY=cam.h/2-a.y*sc(view.targetZoom);limitTargetPan();const zl=Math.round(view.targetZoom*100);if(zl!==update.zl){update.zl=zl;syncZoomLabel()}}}
 const k=reduced?1:Math.min(1,dt*4);view.zoom+=(view.targetZoom-view.zoom)*k;view.panX+=(view.targetPanX-view.panX)*k;view.panY+=(view.targetPanY-view.panY)*k;
 if(celebrationUntil>ts&&ts-(update.lastBurst||0)>380){update.lastBurst=ts;const d=DISTRICTS.command,cx=(d.x+d.w/2)*T+(Math.random()-.5)*160,cy=d.y*T-60-Math.random()*70,c=['#75dfa2','#71b7ff','#f5c04f','#ff8494','#c498ff'][Math.floor(Math.random()*5)];for(let i=0;i<26;i++){const r=Math.random()*Math.PI*2,v=60+Math.random()*70;sparks.push({x:cx,y:cy,vx:Math.cos(r)*v,vy:Math.sin(r)*v-30,life:.9+Math.random()*.6,color:c,size:2+Math.random()*1.5})}}
 for(const a of agents.values()){
  const moving=workerIsMoving(a),running=a.state==='running'&&moving;
  a.motion=running?'running':moving?'walking':a.state==='running'?'working':'idle';
  if(!moving)continue;
  const p=a.path[a.pathI],dx=p.x-a.x,dy=p.y-a.y,d=Math.hypot(dx,dy);
  if(d<3){a.pathI++;if(a.pathI>=a.path.length){a.inside=!!a.targetInside;a.insideZone=a.inside?a.zone:null;a.transition=a.inside?'working':'idle';a.motion=a.state==='running'?'working':'idle';a.arrivedAt=ts;spawnSpark(a.x,a.y,a.inside?'#71b7ff':'#f5c04f',5)}continue}
  a.dir=dx<0?-1:1;
  const base=running?150:64,arrival=a.pathI>=a.path.length-1?clamp(d/42,.45,1):1,speed=base*arrival;
  a.x+=dx/d*speed*dt;a.y+=dy/d*speed*dt;
  if(running)spawnRunDust(a,ts)
 }
 for(const p of packets){if(p.done||!p.path[p.i])continue;const t=p.path[p.i],dx=t.x-p.x,dy=t.y-p.y,d=Math.hypot(dx,dy);if(d<3){p.i++;if(p.i>=p.path.length){p.done=true;spawnSpark(p.x,p.y,p.color,8);if(p.label==='HANDOFF'){addEvent('Handoff received');pulses.push({x:p.x,y:p.y,t:ts})}}continue}p.x+=dx/d*150*dt;p.y+=dy/d*150*dt}packets=packets.filter(p=>!p.done);pulses=pulses.filter(q=>ts-q.t<700);
 updateConstruction(dt,ts);updateCrew(dt);
 if(reduced){sparks=[];dust=[]}
 for(const s of sparks){s.x+=s.vx*dt;s.y+=s.vy*dt;s.vy+=90*dt;s.life-=dt}sparks=sparks.filter(s=>s.life>0);for(const d of dust){d.x+=d.vx*dt;d.y+=d.vy*dt;d.r+=dt*5;d.life-=dt}dust=dust.filter(d=>d.life>0);
 for(const c of traffic){c.go=carGo(c,dt);const v=c.v*c.dir*c.go*dt;if(c.axis==='x'){c.x+=v;if(c.x>38*T)c.x=2*T;if(c.x<2*T)c.x=38*T}else{c.y+=v;if(c.y>23*T)c.y=3*T;if(c.y<3*T)c.y=23*T}}
 if(demo.active&&demo.running&&!demo.paused&&!reduced&&ts-demo.lastAdvance>3200/demo.speed){if(demo.stage<DEMO_STAGES.length-1){demo.stage++;applyDemo();recordReplayFrame('demo');demo.lastAdvance=ts}else demo.running=false;syncDemoControls()}
 if(replay.active&&replay.playing&&ts-replay.lastStep>1200/replay.speed){if(replay.index<replay.frames.length-1){replay.index++;const f=replay.frames[replay.index];agents.clear();artifacts=[];packets=[];sparks=[];dust=[];current=JSON.parse(JSON.stringify(f.mission));sourceType='replay';current.workers.forEach(ensureAgent);selected=f.workerId?{type:'agent',id:String(f.workerId).split(',')[0]}:selected;syncHud();syncSelection();replay.lastStep=ts;syncReplay()}else{replay.playing=false;syncReplay()}}
}
function px(x,y,w,h,c){ctx.fillStyle=c;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h))}
function pathPoly(points,fill){ctx.fillStyle=fill;ctx.beginPath();ctx.moveTo(points[0][0],points[0][1]);for(let i=1;i<points.length;i++)ctx.lineTo(points[i][0],points[i][1]);ctx.closePath();ctx.fill()}
// Text is drawn in device pixels at a whole-pixel size and position (fk = device px per world px this frame), so it
// stays crisp at any zoom and only a handful of font strings are ever parsed.
let fk=1;const fonts={},font=n=>fonts[n]||(fonts[n]='800 '+n+'px ui-monospace,monospace');
function txt(t,x,y,c='#d9e7f4',size=11,align='center'){ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle=c;ctx.font=font(Math.max(1,Math.round(size*fk)));ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillText(t,Math.round(cam.dpr*view.panX+x*fk),Math.round(cam.dpr*view.panY+y*fk));ctx.restore()}
// ---- Ground ----------------------------------------------------------------------------------------------------
// Everything that doesn't move is drawn once into groundCache (per scale and day/night): grass, water, streets with
// sidewalks and zebra crossings, lamp posts (lit at night), benches and planters. Only the trees are drawn each frame,
// one sprite each, so they can sway. Light comes from the top left, so shadows fall down and to the right.
const inDistrict=(x,y,m=0)=>Object.values(DISTRICTS).some(d=>x>=d.x-m&&x<d.x+d.w+m&&y>=d.y-m&&y<d.y+d.h+m);
const wh=(a,b,c=0)=>((a*73856093)^(b*19349663)^(c*83492791))>>>0;
let trees=[],lamps=[];
function plantScenery(){
 trees=[];lamps=[];
 for(let y=3;y<ROWS;y++)for(let x=1;x<COLS-1;x++){
  if(roads.has(key(x,y))||inDistrict(x,y,1))continue;const h=wh(x,y,7)%100,near=[[1,0],[-1,0],[0,1],[0,-1]].some(([a,b])=>roads.has(key(x+a,y+b)));
  if(h<(near?12:46))trees.push([(x+.5)*T+(h%7)*2-6,(y+.5)*T+(h%5)*2-4,h%3,h<20])
 }
 roads.forEach(k=>{const[x,y]=k.split(',').map(Number);if((x+y)%5)return;for(const[a,b]of[[0,-1],[-1,0]])if(!roads.has(key(x+a,y+b))&&!inDistrict(x+a,y+b)){lamps.push(a?[x*T-4,(y+.5)*T]:[(x+.5)*T,y*T-4]);break}})
}
// The ground is cached at 1× or 2× the world's size (2× once the city is drawn bigger than 1.2 device pixels per world
// pixel) and copied each frame: nearest-neighbour when enlarged, so the pixel art stays crisp.
function drawGround(ts){
 const q=sc(view.zoom)*cam.dpr>1.2?2:1,k=q+(display.night?'n':'d');
 if(groundKey!==k){const c=groundCache||document.createElement('canvas'),g=(c.width=W*q,c.height=H*q,c.getContext('2d'));if(g){const prev=ctx;ctx=g;ctx.setTransform(q,0,0,q,0,0);drawGroundStatic();ctx=prev;groundCache=c;groundKey=k}}
 if(groundKey===k){ctx.imageSmoothingEnabled=sc(view.zoom)*cam.dpr<q;ctx.drawImage(groundCache,0,0,W,H);ctx.imageSmoothingEnabled=false}else drawGroundStatic();
 for(const[x,y,s,b]of trees)drawTree(x,y,ts,s,b)
}
function drawGroundStatic(){
 const N=display.night,G=N?['#0b1e1c','#0c221f','#0e2622']:['#19402d','#1b4530','#1e4b34'];
 // grass: broad soft patches and a few tufts
 for(let y=0;y<H;y+=T)for(let x=0;x<W;x+=T){const n=Math.sin(x*.009+y*.004)+Math.sin(y*.012-x*.003),h=wh(x,y);px(x,y,T,T,G[n<-.5?0:n<.6?1:2]);if(h%13===0){px(x+8+h%14,y+10+h%11,2,4,N?'#17382c':'#2b6847');px(x+11+h%14,y+12+h%11,2,2,N?'#17382c':'#2b6847')}}
 // water / edge
 pathPoly([[0,0],[W,0],[W,56],[1010,74],[820,48],[620,65],[420,45],[180,70],[0,52]],N?'#071a27':'#143a4c');
 ctx.strokeStyle=N?'#0c3248':'#23627e';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(0,52);ctx.bezierCurveTo(260,78,420,37,640,60);ctx.bezierCurveTo(860,82,1020,45,W,58);ctx.stroke();
 // streets, with a sidewalk and kerb wherever a street meets grass
 const walk=N?'#2a3135':'#7b7f77',kerb=N?'#1b2226':'#5b5f58';
 roads.forEach(k=>{const[x,y]=k.split(',').map(Number);px(x*T,y*T,T,T,N?'#1c2630':'#313c47')});
 roads.forEach(k=>{const[x,y]=k.split(',').map(Number),X=x*T,Y=y*T;
  if(!roads.has(key(x,y-1))){px(X,Y-6,T,6,walk);px(X,Y-1,T,1,kerb)}if(!roads.has(key(x,y+1))){px(X,Y+T,T,6,walk);px(X,Y+T,T,1,kerb)}
  if(!roads.has(key(x-1,y))){px(X-6,Y,6,T,walk);px(X-1,Y,1,T,kerb)}if(!roads.has(key(x+1,y))){px(X+T,Y,6,T,walk);px(X+T,Y,1,T,kerb)}});
 for(let x=0;x<COLS;x++){if(roads.has(key(x,13)))px(x*T+8,13*T+31,16,2,'#d6ab52')}
 for(let y=0;y<ROWS;y++){if(roads.has(key(13,y)))px(13*T+31,y*T+8,2,16,'#d6ab52');if(roads.has(key(25,y)))px(25*T+31,y*T+8,2,16,'#d6ab52')}
 // zebra crossings on every street leading into the big junctions
 const zebra=N?'#59636b':'#c9cec8';
 for(const cx of[13,25]){for(const ty of[12,15])for(let i=0;i<6;i++)px(cx*T+4+i*10,ty*T+6,5,20,zebra);for(const tx of[cx-1,cx+2])for(let i=0;i<6;i++)px(tx*T+6,13*T+4+i*10,20,5,zebra)}
 // plaza
 px(16*T,11*T,9*T,5*T,N?'#3f443f':'#746f59');for(let i=0;i<18;i++)px(16*T+(i%6)*T/1.5+9,11*T+Math.floor(i/6)*T/1.5+10,4,4,N?'#545a54':'#999078');
 for(const[id,d]of Object.entries(DISTRICTS))drawDistrictScene(id,d,0,true);
 // lamp posts: a pool of light under each at night
 for(const[x,y]of lamps){if(N){const g=ctx.createRadialGradient(x,y+2,2,x,y+2,30);g.addColorStop(0,'rgba(255,214,140,.32)');g.addColorStop(1,'rgba(255,214,140,0)');ctx.fillStyle=g;ctx.fillRect(x-30,y-28,60,60)}px(x+1,y-1,4,2,'rgba(0,0,0,.3)');px(x-1,y-20,2,20,'#3a434b');px(x-1,y-20,7,2,'#3a434b');px(x+3,y-19,4,3,N?'#fff1c2':'#c9d2da')}
}
// Trees: three shapes in two sizes, drawn once per shape into a sprite (with the shadow) and swayed a pixel.
const treeSprites=new Map();
function treeSprite(s,b){
 const k=s+'.'+b+display.night;if(treeSprites.has(k))return treeSprites.get(k);const c=document.createElement('canvas'),g=c.getContext('2d'),N=display.night,dk=N?'#123d2a':'#1f5f39',md=N?'#185034':'#2a7a49',lt=N?'#1f5d3d':'#3c9a5c';
 c.width=c.height=64;g.scale(2,2);const o=(cx,cy,r,f)=>{g.fillStyle=f;g.beginPath();g.arc(cx,cy,r,0,7);g.fill()};
 g.fillStyle='rgba(0,0,0,.25)';g.beginPath();g.ellipse(20,27,10,4,0,0,7);g.fill();g.fillStyle='#4d3522';g.fillRect(14,17,4,11);
 if(s===0){o(16,12,10,dk);o(14,10,8,md);o(12,8,4,lt)}
 else if(s===1){for(let i=0;i<3;i++){g.fillStyle=i?md:dk;g.beginPath();g.moveTo(16,1+i*6);g.lineTo(26-i*2,14+i*4);g.lineTo(6+i*2,14+i*4);g.fill()}g.fillStyle=lt;g.fillRect(12,8,3,3)}
 else{o(10,14,7,dk);o(22,14,7,dk);o(16,8,8,md);o(13,6,4,lt);o(8,12,3,lt)}
 const r={c,z:b?1:.72};treeSprites.set(k,r);return r
}
function drawTree(x,y,ts,s=0,b=1){const t=treeSprite(s,b),sz=32*t.z,sway=reduced?0:Math.round(Math.sin(ts/900+x*.05));ctx.drawImage(t.c,Math.round(x-sz/2)+sway,Math.round(y-sz*.8),sz,sz)}
// District aprons: a path to the door, planters either side of it, benches, and each district's yard props. The still
// parts go into the ground cache (still = true); the few lights that pulse are drawn each frame.
function drawDistrictScene(id,d,ts,still){
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,pulse=(Math.sin(ts/420)+1)/2,N=display.night;
 if(!still){
  if(id==='validation'){ctx.save();ctx.globalAlpha=.18+.12*pulse;ctx.fillStyle='#75dfa2';ctx.fillRect(x+8,y+18,w-16,4);ctx.restore()}
  else if(id==='repair'){ctx.fillStyle='rgba(255,115,131,'+(.28+.25*pulse)+')';ctx.beginPath();ctx.arc(x+w+16,y+18,8,0,Math.PI*2);ctx.fill()}
  return
 }
 px(x+w*.32,y+h+8,w*.36,14,N?'#2a3337':'#7a786c');px(x+w/2-3,y+h,6,24,N?'#3c4547':'#9a9583');
 for(const s of[-1,1]){const px0=x+w/2+s*16-4;px(px0,y+h+2,8,6,'#5b4632');ctx.fillStyle=N?'#18452f':'#2d7a49';ctx.beginPath();ctx.arc(px0+4,y+h,5,0,7);ctx.fill();px(x+w/2+s*(w*.3)-8,y+h+30,16,3,'#7a5a3a');px(x+w/2+s*(w*.3)-7,y+h+33,2,3,'#4a3828');px(x+w/2+s*(w*.3)+5,y+h+33,2,3,'#4a3828')}
 if(id==='command'){for(const dx of[-34,28]){px(x+w/2+dx,y+h+27,6,18,'#55432d');px(x+w/2+dx-6,y+h+23,18,5,'#6e5a3d')}}
 else if(id==='ux'){px(x-24,y+24,18,54,'#254b55');px(x-21,y+28,12,18,'#59e2ed');px(x-21,y+51,12,18,'#315f69')}
 else if(id==='docs'){for(let i=0;i<4;i++){px(x+w+10,y+18+i*20,22,14,'#493f5a');px(x+w+13,y+21+i*20,4,8,'#c498ff');px(x+w+20,y+21+i*20,3,8,'#8db7ff')}px(x-26,y+h-22,20,14,'#d8dde3');px(x-24,y+h-26,16,4,'#f4f1e6');px(x-23,y+h-16,14,2,'#3a4048')}
 else if(id==='engineering'){px(x-30,y+h-20,26,18,'#5d4a32');px(x-27,y+h-17,20,4,'#ffb86a');for(let i=0;i<3;i++){px(x+18+i*30,y+h+27,22,8,'#54442f');px(x+22+i*30,y+h+20,14,7,'#8c744e')}}
 else if(id==='validation'){for(let i=0;i<3;i++){const gx=x+18+i*38;px(gx,y+h+22,28,4,'#75dfa2');px(gx,y+h+8,3,18,'#486c59');px(gx+25,y+h+8,3,18,'#486c59')}}
 else if(id==='models'){for(let i=0;i<4;i++){const sx=x+12+i*42;px(sx,y+h+20,28,22,'#182838');px(sx+4,y+h+24,20,3,'#ff8494');px(sx+4,y+h+31,20,3,'#71b7ff')}}
 else if(id==='repair'){for(let i=0;i<7;i++)px(x-12+i*16,y+h+20,10,5,i%2?'#1e2024':'#ffb23d');px(x+w+14,y+2,4,16,'#6c3940')}
}
function drawInterior(id,d,ts){
 const workers=[...agents.values()].filter(a=>a.inside&&a.insideZone===id&&!a.onSite),active=workers.length>0;if(!active)return;
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,pulse=(Math.sin(ts/220)+1)/2;
 ctx.save();const lvl=buildLevel(id);if(lvl<.995){ctx.beginPath();ctx.rect(x-20,y+h-h*lvl,w+40,h);ctx.clip()}ctx.globalAlpha=.96;px(x+8,y+24,w-16,h-36,display.night?'#0c1720':'#15232b');ctx.globalAlpha=1;
 // floor grid and role stations
 ctx.strokeStyle='rgba(255,255,255,.055)';ctx.lineWidth=1;for(let xx=x+16;xx<x+w-14;xx+=22){ctx.beginPath();ctx.moveTo(xx,y+28);ctx.lineTo(xx,y+h-16);ctx.stroke()}
 for(let yy=y+34;yy<y+h-18;yy+=20){ctx.beginPath();ctx.moveTo(x+12,yy);ctx.lineTo(x+w-12,yy);ctx.stroke()}
 const stations=workers.map(a=>({a,x:a.tx,y:a.ty}));for(const s of stations){px(s.x-15,s.y+12,30,6,'#324150');px(s.x-12,s.y+5,24,8,'#1c2a35');px(s.x-8,s.y+1,16,5,roleStyle(s.a).accent);if(s.a.state==='running'){ctx.strokeStyle=roleStyle(s.a).accent;ctx.globalAlpha=.35+.3*pulse;ctx.strokeRect(s.x-18,s.y-22,36,43);ctx.globalAlpha=1}}
 const door=districtDoor(id);px(door.inside.x-10,door.inside.y-5,20,9,'#09121a');ctx.strokeStyle=d.accent;ctx.strokeRect(door.inside.x-11,door.inside.y-6,22,11);
 ctx.restore()
}

function districtWorkers(id){return current?.workers?.filter(q=>zoneForWorker(q)===id)||[]}
// ---- Construction: buildings rise with their district's progress ---------------------------------------
// Each district with crew has a build level (0 = foundation, 1 = finished). It eases toward the real progress
// and creeps upward while a worker is running, so you can watch floors go up. Districts without crew are
// finished buildings. Failed or blocked districts show damage and a repair crew instead.
const build={};let buildMission='';
function buildState(id){return build[id]||(build[id]={level:.12,topped:0,placed:-1,lastSpark:0})}
function districtFlags(id){const w=districtWorkers(id);return{workers:w,active:w.some(q=>q.state==='running'),bad:w.some(q=>['error','blocked'].includes(q.state)),done:w.length>0&&w.every(q=>q.state==='complete')}}
function buildLevel(id){const f=districtFlags(id);return f.workers.length?buildState(id).level:1}
function updateConstruction(dt,ts){
 const key=current?.id||current?.goal||'';if(key!==buildMission){buildMission=key;for(const k of Object.keys(build))delete build[k]}
 for(const[id,d]of Object.entries(DISTRICTS)){
  const f=districtFlags(id);if(!f.workers.length)continue;const b=buildState(id);
  let target=f.done?1:.12+.83*districtProgress(id);
  if(f.active)target=Math.max(target,Math.min(.95,b.level+.035));
  b.level+=(target-b.level)*Math.min(1,dt*(f.done?1.4:.9));
  const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,top=y+h-h*b.level;
  if(f.active&&b.level<.995&&ts-b.lastSpark>140){b.lastSpark=ts;spawnSpark(x+10+Math.random()*(w-20),top,Math.random()<.5?'#ffd36b':'#ffffff',3)}
  if(f.done&&!b.topped&&b.level>.97){b.topped=ts;spawnSpark(x+w/2,y+4,'#3ed598',18);spawnSpark(x+w/2,y+4,'#ffb224',12);addEvent(d.name+' topped out')}
  if(!f.done)b.topped=0
 }
}
// Steel frame above the finished floors, plus the glowing line where new floors are being added.
function drawSkeleton(d,x,y,w,h,top,bad,ts){
 const steel=bad?'rgba(160,172,186,.55)':'rgba(255,178,36,.78)',depth=14;
 ctx.save();ctx.strokeStyle=steel;ctx.lineWidth=2;
 for(let xx=x+2;xx<=x+w;xx+=22){ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,y+8);ctx.stroke()}
 ctx.beginPath();ctx.moveTo(x+w,top);ctx.lineTo(x+w,y+8);ctx.lineTo(x+w+depth,y);ctx.lineTo(x+w+depth,Math.min(y+h-depth,top-8));ctx.stroke();
 ctx.lineWidth=1.5;for(let yy=top-18;yy>y+4;yy-=18){ctx.beginPath();ctx.moveTo(x,yy);ctx.lineTo(x+w,yy);ctx.lineTo(x+w+depth,yy-8);ctx.stroke()}
 ctx.beginPath();ctx.moveTo(x,y+8);ctx.lineTo(x+w,y+8);ctx.lineTo(x+w+depth,y);ctx.stroke();
 ctx.globalAlpha=.35;for(let xx=x+2;xx<x+w-20;xx+=44){ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx+22,Math.max(y+8,top-18));ctx.stroke()}
 ctx.restore();
 const glow=.55+.45*Math.sin(ts/180);ctx.save();ctx.shadowColor=bad?'#ff6b6b':'#ffb224';ctx.shadowBlur=10*glow;px(x-2,top-2,w+4,3,bad?'#ff9b9b':'#ffd27a');ctx.restore()
}
// Tower crane that lifts steel beams from the pallet to the top of the frame.
function drawCrane(id,d,x,y,w,h,top,active,bad,ts){
 const mastX=x+w+24,base=y+h+4,jibY=y-38,jibL=x+4,jibR=mastX+30,steel=bad?'#7b5560':'#e3a22a',dark=bad?'#4d2b33':'#7a5414';
 ctx.save();
 // mast lattice
 px(mastX-4,jibY,3,base-jibY,steel);px(mastX+5,jibY,3,base-jibY,steel);ctx.strokeStyle=steel;ctx.lineWidth=1;ctx.beginPath();for(let yy=jibY;yy<base-8;yy+=10){ctx.moveTo(mastX-3,yy);ctx.lineTo(mastX+6,yy+10);ctx.moveTo(mastX+6,yy);ctx.lineTo(mastX-3,yy+10)}ctx.stroke();
 px(mastX-10,base-4,24,6,'#3b4a58');
 // jib, counter-jib, counterweight, cab, tie lines
 px(jibL,jibY-2,jibR-jibL,4,steel);px(mastX+14,jibY-1,18,9,'#55606b');px(mastX-6,jibY+3,14,10,'#203448');px(mastX-4,jibY+5,7,5,bad?'#ff6b6b':'#9fd8ff');
 ctx.strokeStyle=dark;ctx.beginPath();ctx.moveTo(mastX+1,jibY-16);ctx.lineTo(jibL+20,jibY-2);ctx.moveTo(mastX+1,jibY-16);ctx.lineTo(jibR,jibY-2);ctx.stroke();px(mastX,jibY-18,3,16,steel);
 const blink=Math.floor(ts/500)%2===0;px(mastX,jibY-22,3,3,bad?(blink?'#ff6b6b':'#4d1d22'):(blink?'#ff4d4d':'#5a1616'));
 // load cycle
 const pickX=x+w+8,P=4600,t=ts+(id.length*977),cycle=Math.floor(t/P),p=(t%P)/P,b=buildState(id);
 const targetX=x+16+((cycle*37)%Math.max(24,w-40));let tx=pickX,hy=base-10,load=false;
 if(active&&!bad){
  if(p<.2){tx=pickX;hy=jibY+12+(base-10-jibY-12)*(p/.2);load=p>.12}
  else if(p<.45){const k=(p-.2)/.25;tx=pickX+(targetX-pickX)*k;hy=base-10-(base-10-(jibY+16))*Math.min(1,k*1.6);load=true}
  else if(p<.65){const k=(p-.45)/.2;tx=targetX;hy=jibY+16+(top-6-(jibY+16))*k;load=true}
  else{const k=(p-.65)/.35;tx=targetX+(pickX-targetX)*k;hy=top-6-(top-6-(jibY+12))*Math.min(1,k*2);load=false;if(b.placed!==cycle){b.placed=cycle;spawnSpark(targetX,top-4,'#ffd36b',10);for(let i=0;i<5;i++)dust.push({x:targetX+(Math.random()-.5)*20,y:top,vx:(Math.random()-.5)*20,vy:-8,r:2,life:.5})}}
 }else{tx=mastX-26;hy=jibY+18}
 px(tx-5,jibY+1,10,4,'#2a3a49');ctx.strokeStyle='#c8d3dd';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(tx,jibY+5);ctx.lineTo(tx,hy);ctx.stroke();px(tx-3,hy,6,4,'#f0c24a');
 if(load){px(tx-13,hy+4,26,5,steel);px(tx-13,hy+4,3,5,dark);px(tx+10,hy+4,3,5,dark);ctx.strokeStyle='rgba(200,211,221,.7)';ctx.beginPath();ctx.moveTo(tx,hy+4);ctx.lineTo(tx-10,hy+4);ctx.moveTo(tx,hy+4);ctx.lineTo(tx+10,hy+4);ctx.stroke()}
 ctx.restore()
}
// Pallets, rebar, a cement mixer and a hazard barrier beside a building under construction.
function drawMaterials(x,y,w,h,active,ts){
 const gy=y+h+4;
 for(let r=0;r<3;r++)for(let c=0;c<3-r;c++)px(x+w+4+c*5+r*2,gy-4-r*4,5,4,r%2?'#b4593f':'#c96a4a');px(x+w+2,gy,18,3,'#6b5434');
 for(let i=0;i<4;i++)px(x-34+i*2,gy-2-i,22,2,'#7d8893');
 const mx=x-24,my=gy-16,rot=active?ts/260:0;px(mx-12,my+12,26,4,'#2f3a44');ctx.save();ctx.translate(mx,my+4);ctx.rotate(-.35);ctx.fillStyle='#d9dde2';ctx.beginPath();ctx.ellipse(0,0,11,8,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#e3a22a';ctx.lineWidth=2;for(let i=0;i<3;i++){const a=rot+i*2.1;ctx.beginPath();ctx.moveTo(Math.cos(a)*10,Math.sin(a)*6);ctx.lineTo(Math.cos(a+1)*10,Math.sin(a+1)*6);ctx.stroke()}ctx.restore();px(mx-10,my+14,4,4,'#222');px(mx+6,my+14,4,4,'#222');
 for(let i=0;i<w;i+=10)px(x+i,y+h+1,5,3,i%20?'#1b1b1b':'#ffb224');
}
// Damage on a failed district: cracked panels, smoke and sparks from the repair crew.
function drawDamage(x,y,w,h,repairing,ts){
 ctx.save();ctx.strokeStyle='rgba(10,14,20,.85)';ctx.lineWidth=2;
 for(const[cx,cy]of[[.28,.38],[.66,.55],[.45,.78]]){const ox=x+w*cx,oy=y+h*cy;ctx.beginPath();ctx.moveTo(ox-10,oy-6);ctx.lineTo(ox-3,oy);ctx.lineTo(ox-6,oy+5);ctx.lineTo(ox+4,oy+9);ctx.lineTo(ox+10,oy+4);ctx.stroke();px(ox-4,oy-1,7,6,'rgba(255,107,107,.25)')}
 for(let i=0;i<5;i++){const k=((ts/1700)+i/5)%1;ctx.globalAlpha=(1-k)*.35;ctx.fillStyle='#9aa4ae';ctx.beginPath();ctx.arc(x+w*.3+Math.sin(k*6+i)*6,y+14-k*46,4+k*9,0,Math.PI*2);ctx.fill()}
 ctx.restore();
 if(repairing&&Math.random()<.35)spawnSpark(x+w*.66,y+h*.55,Math.random()<.5?'#9fd8ff':'#ffffff',2)
}
// Green pennant on the roof once a district's work is complete.
function drawTopping(x,y,w,ts){const fx=x+w-14,fy=y-14,wave=Math.sin(ts/200)*2;px(fx,fy,2,20,'#cfd8e0');pathPoly([[fx+2,fy],[fx+16,fy+4+wave],[fx+2,fy+9]],'#3ed598')}
// ---- Buildings -------------------------------------------------------------------------------------------------
// Each district has its own silhouette and a prop that says what it does: Command Center's antenna tower and big
// status screen, UX Lab's glass front with wireframes on its screens, Documentation Studio's book-stacked windows,
// Engineering Bay's sawtooth roof and hangar door, Validation Lab's check beacon (green and blinking once it passes),
// Model Foundry's chimney and furnace, Projects Quarter's filing towers, Repair Bay's roller door (up while someone is
// being fixed). Windows light in a slowly changing pattern and glow at night; light spills onto the pavement.
function drawWindows(id,d,x,y,w,h,ts,f){
 const N=display.night,e=Math.floor(ts/9000),rate=f.active?72:f.done?58:42,lit=N?'#ffd27a':f.active?'#d9fbff':f.done?'#b9efcc':'#bfdfe9',off=N?'#122230':'#294657',books=['#c0563f','#d9b25e','#7aa2d6','#8fc98f'];
 for(let r=0,yy=y+28;yy<y+h-22;yy+=18,r++)for(let c=0,xx=x+14;xx<x+w-16;xx+=22,c++){
  if(!(wh(c+id.length*7,r,e+(c*r)%4)%100<rate)){px(xx,yy,10,8,off);continue}
  if(id==='docs'){px(xx,yy,10,8,N?'#3a2a1a':'#33424e');for(let b=0;b<4;b++)px(xx+1+b*2,yy+2+b%2,2,6-b%2,books[(b+c+r)%4]);continue}
  px(xx,yy,10,8,lit);px(xx+1,yy+1,8,1,'rgba(255,255,255,.25)');if(N){ctx.globalAlpha=.16;px(xx-3,yy-3,16,14,'#ffc861');ctx.globalAlpha=1}
 }
}
function drawRoofProps(id,d,x,y,w,wall,blink,done,ts){
 const N=display.night,A=ctx.globalAlpha;
 if(id==='command'){px(x+w*.6,y-22,w*.26,26,wall);px(x+w*.6,y-24,w*.26,4,shade(d.roof,1.2));px(x+w*.73,y-46,2,24,'#8fa3b5');px(x+w*.73-4,y-38,10,2,'#8fa3b5');px(x+w*.73-1,y-50,4,4,blink?'#71b7ff':'#23476b')}
 else if(id==='engineering')for(let xx=x+2;xx<x+w-20;xx+=26){pathPoly([[xx,y+4],[xx+24,y+4],[xx+24,y-12]],shade(d.roof,1.15));px(xx+20,y-10,3,13,'#9fd8ff')}
 else if(id==='validation'){px(x+w-20,y-18,3,18,'#486c59');const g=done?(blink?'#75dfa2':'#3c7a58'):'#2c4a3a';ctx.fillStyle=g;ctx.beginPath();ctx.arc(x+w-18,y-24,8,0,7);ctx.fill();px(x+w-23,y-24,3,2,'#0b1a12');px(x+w-20,y-23,2,2,'#0b1a12');px(x+w-18,y-27,2,4,'#0b1a12')}
 else if(id==='models'){px(x+w-48,y-34,12,40,'#4a3838');px(x+w-50,y-36,16,4,'#2a2020');ctx.globalAlpha=A*(reduced?.5:.4+.3*Math.sin(ts/120));px(x+w-46,y-35,8,2,'#ffb36b');ctx.globalAlpha=A;if(!reduced)for(let i=0;i<3;i++){const k=(ts/2400+i/3)%1;ctx.globalAlpha=A*(1-k)*.3;ctx.fillStyle='#9aa4ae';ctx.beginPath();ctx.arc(x+w-42+k*10,y-40-k*40,4+k*8,0,7);ctx.fill()}ctx.globalAlpha=A}
 else if(id==='projects')for(const tx of[x+w-96,x+w-58]){px(tx,y-30,30,36,wall);px(tx,y-33,30,4,d.roof);for(let yy=y-24;yy<y+4;yy+=7){px(tx+4,yy,22,1,shade(d.roof,.8));px(tx+13,yy+2,4,2,d.accent)}}
 else if(id==='docs'){pathPoly([[x+w-70,y+2],[x+w-40,y-18],[x+w-10,y+2]],shade(d.roof,1.15));px(x+w-46,y-8,12,8,N?'#ffd27a':'#cfe0f7')}
}
function drawBuilding(id,d,ts){
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,depth=14,f=districtFlags(id),{workers,active,bad,done}=f,selectedDistrict=selected?.type==='district'&&selected.id===id,pulse=(Math.sin(ts/240)+1)/2,N=display.night,blink=reduced||Math.floor(ts/500)%2;
 const level=buildLevel(id),under=level<.995,top=y+h-h*level,sy=Math.max(y,top-8),wall=d.wall?d.wall[N?1:0]:shade(d.roof,N?.3:.42);
 // shadow, cast down and to the right; light from the windows on the pavement at night
 pathPoly([[x+w+depth,sy],[x+w+depth+22,sy+18],[x+w+depth+22,y+h+12],[x+12,y+h+12],[x,y+h]],'rgba(0,0,0,.28)');
 if(N){ctx.globalAlpha=.09;px(x-8,y+h,w+depth+16,24,'#ffc861');ctx.globalAlpha=1}
 ctx.save();
 px(x-4,y+h-6,w+depth+8,8,N?'#2a333b':'#59616a');
 // Only the finished floors are solid; the rest is drawn as a steel frame below.
 ctx.save();if(under){ctx.beginPath();ctx.rect(x-40,top,w+depth+80,h+80);ctx.clip()}
 pathPoly([[x+w,y+8],[x+w+depth,y],[x+w+depth,y+h-depth],[x+w,y+h]],shade(d.roof,N?.22:.3));
 px(x,y+8,w,h-8,wall);px(x,y+8,2,h-8,shade(wall,1.36));
 pathPoly([[x,y+8],[x+depth,y],[x+w+depth,y],[x+w,y+8]],d.roof);px(x,y+7,w,2,shade(d.roof,1.35));px(x+8,y+14,w-16,4,d.accent);
 if(id==='ux'){px(x+6,y+22,w-12,h-30,N?'#123039':'#2b6f7d');for(let xx=x+6;xx<x+w-6;xx+=20)px(xx,y+22,2,h-30,'#1a4650');for(let i=0;i<5;i++){const sx=x+14+i*34,s2=y+30+(i%2)*26;px(sx,s2,16,12,'#0c1a22');px(sx+2,s2+2,12,2,d.accent);px(sx+2,s2+6,5,4,'#8fb3bf');px(sx+9,s2+6,5,1,'#8fb3bf');px(sx+9,s2+8,4,1,'#8fb3bf')}}
 else drawWindows(id,d,x,y,w,h,ts,f);
 if(id==='command'){const ws=current?.workers||[],p=ws.length?Math.round(100*ws.filter(q=>q.state==='complete').length/ws.length):0,sx=x+w/2-36;px(sx,y+24,72,28,'#0a141c');px(sx+2,y+26,68,24,'#10202c');txt(ws.length?p+'%':'READY',sx+36,y+35,d.accent,10);px(sx+6,y+45,60,3,'#22384a');px(sx+6,y+45,60*p/100,3,'#75dfa2')}
 else if(id==='engineering'){px(x+w-62,y+h-36,46,36,'#262d34');for(let yy=y+h-34;yy<y+h;yy+=5)px(x+w-60,yy,42,1,'#3a434c');px(x+w-62,y+h-38,46,3,d.accent)}
 else if(id==='models'){const fl=reduced?.8:.65+.35*Math.sin(ts/90)*Math.sin(ts/53);px(x+12,y+h-26,28,16,'#2a1a14');ctx.globalAlpha=fl;px(x+14,y+h-24,24,12,'#ff9a3c');ctx.globalAlpha=1}
 else if(id==='repair'){const up=workers.length?24:0;px(x+w/2-26,y+h-32,52,32,'#141a20');if(up){ctx.globalAlpha=.6;px(x+w/2-24,y+h-10,48,10,'#ffb23d');ctx.globalAlpha=1}for(let yy=y+h-32;yy<y+h-up;yy+=4)px(x+w/2-26,yy,52,3,'#59626c')}
 // door
 if(id!=='repair'){px(x+w/2-9,y+h-22,18,22,'#0d1720');px(x+w/2-5,y+h-17,4,4,d.accent)}
 ctx.restore();
 // what stands on the roof, once it's built; while it's going up, the finished silhouette shows faintly behind the
 // scaffold (a ghost of the walls and roof, its props, and a dashed outline), so the district is recognisable
 if(!under)drawRoofProps(id,d,x,y,w,wall,blink,done,ts);
 else{
  ctx.save();ctx.beginPath();ctx.rect(x-40,y-80,w+depth+80,top-y+80);ctx.clip();ctx.globalAlpha=.22;
  pathPoly([[x+w,y+8],[x+w+depth,y],[x+w+depth,y+h-depth],[x+w,y+h]],shade(d.roof,N?.22:.3));px(x,y+8,w,h-8,wall);pathPoly([[x,y+8],[x+depth,y],[x+w+depth,y],[x+w,y+8]],d.roof);
  ctx.globalAlpha=.4;drawRoofProps(id,d,x,y,w,wall,true,false,ts);
  ctx.globalAlpha=.5;ctx.strokeStyle=d.accent;ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(x,y+h);ctx.lineTo(x,y+8);ctx.lineTo(x+depth,y);ctx.lineTo(x+w+depth,y);ctx.lineTo(x+w+depth,y+h-depth);ctx.moveTo(x,y+8);ctx.lineTo(x+w,y+8);ctx.lineTo(x+w+depth,y);ctx.moveTo(x+w,y+8);ctx.lineTo(x+w,y+h);ctx.stroke();ctx.setLineDash([]);ctx.restore()
 }
 if(under)drawSkeleton(d,x,y,w,h,top,bad,ts);
 // Damage sits on whatever has been built so far.
 if(bad){const by=Math.max(y,top);drawDamage(x,by,w,y+h-by,workers.some(q=>q.state==='running'),ts)}
 if(done&&!under)drawTopping(x,y,w,ts);
 if(active){ctx.strokeStyle=d.accent;ctx.globalAlpha=.55+.35*pulse;ctx.lineWidth=3;ctx.strokeRect(x-4,y-4,w+depth+8,h+10);ctx.globalAlpha=1}
 if(bad){ctx.strokeStyle='#ff7383';ctx.lineWidth=4;ctx.globalAlpha=.6+.4*pulse;ctx.strokeRect(x-5,y-5,w+depth+10,h+11);ctx.globalAlpha=1;px(x+w-16,y+11,10,10,pulse>.5?'#ff7383':'#6f2632')}
 if(selectedDistrict){ctx.strokeStyle='#ffffff';ctx.lineWidth=2;ctx.setLineDash([6,4]);ctx.strokeRect(x-8,y-8,w+depth+16,h+17);ctx.setLineDash([])}
 ctx.restore()
}
function districtProgress(id){
 const w=districtWorkers(id);if(!w.length)return 0;return w.reduce((n,q)=>n+(q.state==='complete'?1:q.state==='running'?.55:q.state==='blocked'?.2:0),0)/w.length
}
function drawWorksite(id,d,ts){
 const workers=districtWorkers(id),active=workers.some(w=>w.state==='running'),bad=workers.some(w=>['error','blocked'].includes(w.state)),progress=districtProgress(id);if(!workers.length)return;
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,level=buildLevel(id),under=level<.995,top=y+h-h*level;
 if(under||active||bad){
  for(let i=0;i<3;i++){const cx=x+16+i*18,cy=y+h+12;pathPoly([[cx,cy],[cx+5,cy-10],[cx+10,cy]],bad?'#ff7383':'#f5a623');px(cx+2,cy-5,6,2,'#fff3b0')}
  // scaffolding up to the working height
  ctx.strokeStyle=bad?'rgba(255,115,131,.55)':'rgba(205,215,225,.5)';ctx.lineWidth=1.5;const sTop=Math.min(y+h-8,top-6);
  for(const sx of[x-10,x+w+2]){ctx.strokeRect(sx,sTop,8,y+h-sTop);for(let yy=sTop;yy<y+h-6;yy+=14){ctx.beginPath();ctx.moveTo(sx,yy);ctx.lineTo(sx+8,yy+14);ctx.stroke();px(sx-1,yy,10,2,'#8b6a3c')}}
 }
 if(under)drawMaterials(x,y,w,h,active,ts);
 for(const a of agents.values())if(a.onSite&&a.zone===id&&(a.climbing||a.y<y+h-40))drawLadder(x+8,y+h,Math.max(y+8,top-2));
 if(under||active)drawCrane(id,d,x,y,w,h,top,active,bad,ts);
 px(x,y+h+19,w,5,'rgba(5,10,16,.7)');px(x,y+h+19,w*(under?level:progress||1),5,bad?'#ff7383':level>=.995?'#3ed598':'#ffb224')
}
// ---- Crew at work: running workers leave the interior and work on the site --------------------------
// A running worker whose district is under construction stands on the top finished floor (or at the damage
// when repairing). Their real position moves, so selection and tooltips still follow them.
function siteSpot(a){
 const d=DISTRICTS[a.zone];if(!d)return null;const f=districtFlags(a.zone),lvl=buildLevel(a.zone);if(a.state!=='running'||workerIsMoving(a)||!a.inside)return null;
 if(!(lvl<.995||f.bad))return null;const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,top=y+h-h*lvl;
 // stand clear of the roof sign: the name plate at the left end, the progress pill at the right
 const hi=x+w-30,sx=clamp(a.tx??x+w/2,Math.min(hi,x+tw(d.name,9)+22+FW*WS),hi);
 return f.bad&&lvl>=.995?{x:sx,y:y+h*.55-12}:{x:sx,y:Math.max(y+14,top)-20}
}
function updateCrew(dt){
 for(const a of agents.values()){
  const spot=siteSpot(a);
  if(spot){a.onSite=true;const dy=spot.y-a.y;a.climbing=Math.abs(dy)>3;a.x+=(spot.x-a.x)*Math.min(1,dt*4);a.y+=dy*Math.min(1,dt*(a.climbing?2.2:6))}
  else if(a.onSite&&!workerIsMoving(a)){const home={x:a.tx??a.x,y:a.ty??a.y},dy=home.y-a.y;a.climbing=Math.abs(dy)>3;a.x+=(home.x-a.x)*Math.min(1,dt*4);a.y+=dy*Math.min(1,dt*2.2);if(Math.hypot(home.x-a.x,dy)<1.5){a.onSite=false;a.climbing=false}}
  else if(workerIsMoving(a)){a.onSite=false;a.climbing=false}
 }
}
function drawLadder(x,y1,y2){ctx.save();ctx.strokeStyle='#c9a46a';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x-5,y1);ctx.lineTo(x-5,y2);ctx.moveTo(x+5,y1);ctx.lineTo(x+5,y2);for(let yy=y2+3;yy<y1;yy+=6){ctx.moveTo(x-5,yy);ctx.lineTo(x+5,yy)}ctx.stroke();ctx.restore()}
// A working worker gives off a little of their job: sparks from a wrench, paper from a clipboard, light from a screen.
const FX={wrench:'#ffd36b',clipboard:'#f4f1e6',book:'#f4f1e6',blueprint:'#cfe0f7',tablet:'#9ff3fa',laptop:'#9fdcff',magnifier:'#eaffff',radio:'#a8b5ff',drive:'#6ee7a0',crate:'#c5b99a'};
function drawWorkingAction(a,ts){
 if(reduced||a.state!=='running'||workerIsMoving(a)||a.climbing||ts-(a.lastFx||0)<520)return;a.lastFx=ts;const s=roleStyle(a),d=a.dir||1;
 sparks.push({x:a.x+d*16*WS,y:a.y+22-32*WS,vx:d*(4+Math.random()*10),vy:-28-Math.random()*16,life:.55,color:FX[s.tool]||s.accent,size:2})
}
function drawTraffic(){for(const c of traffic){ctx.save();ctx.translate(c.x,c.y);px(-7,-4,14,8,c.color);px(-4,-6,8,3,'#b8dbff');px(-5,4,3,2,'#0b0e12');px(2,4,3,2,'#0b0e12');ctx.restore()}}
function dependencyState(from,to){
 if(['error','blocked'].includes(from.state)||['error','blocked'].includes(to.state))return'blocked';
 if(from.state==='complete'&&to.state==='running')return'active';
 if(from.state==='complete')return'ready';
 return'waiting'
}
// A dependency is drawn along the streets between the two districts (the same A* the workers walk), faint, with
// packets riding it while the hand-off is live. Paths are found once per district pair: the roads never change.
const flowPaths=new Map();
function flowPath(a,b){
 const k=a+'>'+b;if(!flowPaths.has(k)){const s=doorLeg(a),e=doorLeg(b),p=[...s,...astar(s.at(-1),e.at(-1)).slice(1,-1),...e.reverse()];let len=0;const seg=p.slice(1).map((q,i)=>{const l=Math.hypot(q.x-p[i].x,q.y-p[i].y);len+=l;return l});flowPaths.set(k,{p,seg,len})}
 return flowPaths.get(k)
}
// From a district's door (districtCenter) straight down its path to the street, then along the kerb to the middle of
// the road tile: two straight legs, never a diagonal. Doors face south; the nearest street tile in the door's column
// (or the one beside it) within three tiles, else the nearest anywhere, joined with an L.
function doorLeg(id){
 const p=districtCenter(id),c=Math.floor(p.x/T);let t=null;
 for(let y=Math.floor(p.y/T);y<Math.floor(p.y/T)+3&&!t;y++)for(const x of[c,c-1,c+1])if(reach.has(key(x,y))){t={x,y};break}
 t=t||nearestRoad(p);const e={x:(t.x+.5)*T,y:(t.y+.5)*T},legs=[p,{x:p.x,y:e.y},e];
 return legs.filter((q,i)=>!i||Math.hypot(q.x-legs[i-1].x,q.y-legs[i-1].y)>.5)
}
function along(f,t){let d=t*f.len;for(let i=0;i<f.seg.length;i++){if(d<=f.seg[i]){const a=f.p[i],b=f.p[i+1],k=f.seg[i]?d/f.seg[i]:0;return{x:a.x+(b.x-a.x)*k,y:a.y+(b.y-a.y)*k}}d-=f.seg[i]}return f.p.at(-1)}
function drawFlows(ts){
 if(!display.flows||!current?.workers?.length)return;ctx.save();ctx.lineJoin=ctx.lineCap='round';
 for(const w of current.workers)for(const dep of w.dependsOn||[]){
  const a=current.workers.find(x=>x.id===dep),za=a&&zoneForWorker(a),zb=zoneForWorker(w);if(!a||za===zb)continue;
  const f=flowPath(za,zb),st=dependencyState(a,w),c=st==='blocked'?'255,115,131':st==='active'?'89,226,237':st==='ready'?'117,223,162':'150,170,190';
  ctx.strokeStyle='rgba('+c+','+(st==='waiting'?.2:.36)+')';ctx.lineWidth=st==='active'?3:2;ctx.setLineDash(st==='blocked'?[4,6]:[]);ctx.beginPath();ctx.moveTo(f.p[0].x,f.p[0].y);for(const q of f.p)ctx.lineTo(q.x,q.y);ctx.stroke();
  if(!reduced&&(st==='active'||st==='ready'))for(let i=0,n=st==='active'?3:1;i<n;i++){const q=along(f,(ts/(f.len*12)+i/n)%1);px(q.x-4,q.y-4,8,8,'rgba(5,10,16,.85)');px(q.x-3,q.y-3,6,6,'rgb('+c+')')}
 }
 ctx.setLineDash([]);ctx.restore()
}
function roleStyle(a){return a.style||ROLE_STYLE[a.id]||ROLE_STYLE.synthesis}
function workerIsMoving(a){return !!(a.path?.length&&a.pathI<a.path.length)}
function workerIsRunning(a){return a.state==='running'&&workerIsMoving(a)}
function spawnRunDust(a,ts){
 if(reduced||ts-(a.lastDust||0)<85)return;a.lastDust=ts;
 for(let i=0;i<2;i++)dust.push({x:a.x-a.dir*(7+Math.random()*5),y:a.y+16+Math.random()*3,vx:-a.dir*(10+Math.random()*16),vy:-4-Math.random()*8,r:2+Math.random()*2,life:.42})
}
// ---- Workers: pixel sprites drawn once per look --------------------------------------------------------------
// A worker is FW x FH art pixels, each 2 world px. Its sheet holds every frame facing right (row 0) and left (row 1):
// stand, a 4-frame walk, two work frames, look around, check watch, two waves, thumbs-up, sitting. Each frame is
// one drawImage, so a bigger crew costs no more per worker than before.
const FW=20,FH=28,F={stand:0,walk:1,work:5,look:7,watch:8,wave:9,thumbs:11,sit:12};
const POSES=[{},{legs:[-2,0,2,0],sw:-1},{by:-1,legs:[0,1,0,0]},{legs:[2,0,-2,0],sw:1},{by:-1,legs:[0,0,0,1]},{arm:'work',k:0},{arm:'work',k:1},{eye:'back'},{arm:'watch',eye:'down'},{arm:'wave',k:0,front:1},{arm:'wave',k:1,front:1},{arm:'thumb',front:1},{sit:1}];
const SKIN=['#f2cba8','#e2ad86','#c98d63','#a8714b','#875536','#683f28'],HAIR=['#251a16','#4a2e1f','#7b4a26','#b8843f','#dcc07a','#8d8f99','#a33d2c'],SHIRT=['#e9eef3','#3c4a5d','#90a4b9','#6a4458'],PANTS=['#2e3a52','#4b3e30','#25292f','#59626f'];
const hash=s=>{let h=2166136261;for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0};
const shade=(c,f)=>'#'+[1,3,5].map(i=>Math.round(clamp(parseInt(c.slice(i,i+2),16)*f,0,255)).toString(16).padStart(2,'0')).join('');
function lookFor(id){
 const k=String(id||'').replace(/-followup-\d+$/,''),r=ROLE_STYLE[k]||ROLE_STYLE.synthesis,h=hash(id),vest=(DISTRICTS[ROLE_ZONE[k]]||DISTRICTS.command).accent;
 return{key:k+'.'+h,tool:r.tool,hat:r.hat,vest,accent:vest,skin:SKIN[h%6],hair:HAIR[(h>>>3)%7],cut:(h>>>6)%4,shirt:SHIRT[(h>>>9)%4],pants:PANTS[(h>>>12)%4]}
}
// Hair (four cuts) or a hard hat striped in the district colour.
function drawWorkerHat(R,s,b,front){
 const H=s.hair;
 if(s.hat){R(7,b,6,1,s.hat);R(6,1+b,8,2,s.hat);R(9,b,2,3,s.vest);R(5,3+b,11,1,shade(s.hat,.75));R(6,4+b,1,1,H);return}
 R(6,2+b,8,2,H);R(7,1+b,6,1,H);R(6,4+b,1,2,H);if(front)R(13,4+b,1,2,H);else R(13,3+b,1,1,H);
 if(s.cut===1)R(5,3+b,2,7,H);else if(s.cut===2)R(3,1+b,3,3,H);else if(s.cut===3){R(5,b,10,3,H);R(5,3+b,1,4,H);R(14,3+b,1,2,H)}
}
// The prop, at the hand (hx,hy): carried at the side, or in use (two frames, k).
function drawWorkerTool(R,s,work,k,hx,hy){
 const t=s.tool,m='#b9c4cd';
 if(t==='tablet'){if(work){R(hx-1,hy-4,4,5,'#1c2733');R(hx,hy-3,2,3,k?'#c8fbff':'#5fdde8')}else{R(hx,hy+1,3,4,'#1c2733');R(hx+1,hy+2,1,2,'#5fdde8')}}
 else if(t==='laptop'){if(work){R(hx-4,hy+1,7,1,'#a3adb8');R(hx+2,hy-4,1,5,'#a3adb8');R(hx+1,hy-3,1,3,k?'#c6ecff':'#6fb8e8')}else R(hx-2,hy+1,6,2,'#a3adb8')}
 else if(t==='clipboard'){if(work){R(hx-1,hy-4,4,5,'#8a5a2b');R(hx,hy-3,2,4,'#f1eee2');R(hx,hy-5,2,1,m);R(hx-2+k,hy-3+k,1,2,'#f2c94c')}else{R(hx,hy+1,3,4,'#8a5a2b');R(hx+1,hy+2,1,2,'#f1eee2')}}
 else if(t==='book'){if(work){R(hx-2,hy-3,6,3,'#f1eee2');R(hx,hy-3,1,3,'#b84a3a');R(hx-2,hy,6,1,'#b84a3a');R(hx+(k?2:-1),hy-2,1,1,'#8a93a0')}else R(hx,hy+1,3,4,'#b84a3a')}
 else if(t==='magnifier'){const x=work?hx+1+k:hx-1,y=work?hy-4:hy+2;R(x+1,y,2,1,m);R(x,y+1,1,2,m);R(x+3,y+1,1,2,m);R(x+1,y+3,2,1,m);R(x+1,y+1,2,2,'#bfeaff');R(work?x-1:x+2,work?y+4:y-1,1,2,'#6b4a2f')}
 else if(t==='radio'){const y=work?hy-3:hy+1;R(hx+1,y,2,4,'#1d242c');R(hx+2,y-3,1,3,'#8797a8');R(hx+1,y+1,1,1,work&&k?'#ff6b6b':'#4ade80')}
 else if(t==='blueprint'){if(work){R(hx-3,hy-4,6,5,'#3d78d6');R(hx-2,hy-3,4,1,'#cfe0f7');R(hx-2,hy-1,3,1,'#cfe0f7');R(hx-2+k*3,hy-2,1,1,'#ffffff')}else{R(hx-2,hy+1,6,2,'#3d78d6');R(hx-2,hy+1,1,2,'#cfe0f7')}}
 else if(t==='wrench'){if(work&&!k){R(hx+1,hy-5,1,5,m);R(hx,hy-6,3,1,m);R(hx,hy-7,1,1,m);R(hx+2,hy-7,1,1,m)}else if(work){R(hx+2,hy,5,1,m);R(hx+6,hy-1,1,3,m);R(hx+7,hy-1,1,1,m);R(hx+7,hy+1,1,1,m)}else{R(hx+1,hy+1,1,5,m);R(hx,hy+5,3,1,m);R(hx,hy+6,1,1,m);R(hx+2,hy+6,1,1,m)}}
 else if(t==='crate'){const y=hy-(work&&k?4:3);R(hx-3,y,6,5,'#9a6b3a');R(hx-3,y+2,6,1,'#6b4626')}
 else if(t==='drive'){if(work){R(hx-1,hy-4,4,4,'#3b4149');R(hx-1,hy-2,4,1,'#252a30');R(hx+2,hy-4,1,1,k?'#4ade80':'#1d5c36')}else R(hx,hy+1,4,3,'#3b4149')}
}
function paintWorker(g,o,p,s){
 const R=(x,y,w,h,c)=>{g.fillStyle=c;g.fillRect(o+x,y,w,h)},b=p.sit?4:p.by||0,[bd,bl,fd,fl]=p.legs||[0,0,0,0],sw=p.sw||0,sk=s.skin,skd=shade(sk,.8),sd=shade(s.shirt,.78),eye='#16181f',boot='#2a211b';
 const leg=(x,dx,l,c)=>{R(x,19+b,3,3-b,c);R(x+dx,22-l,3,3,c);R(x+dx,25-l,4,2,boot)};
 // back arm, legs, body
 R(4,12+b,2,3,sd);R(4-sw,15+b,2,2,sd);R(4-sw,17+b,2,2,skd);
 if(p.sit){R(8,22,8,2,s.pants);R(14,24,3,1,s.pants);R(14,25,4,2,boot)}else{leg(6,bd,bl,shade(s.pants,.75));leg(11,fd,fl,s.pants)}
 R(6,11+b,9,8,s.shirt);R(6,12+b,9,6,s.vest);R(6,12+b,1,6,shade(s.vest,.72));R(6,15+b,9,1,'#f3efc4');R(11,12+b,1,3,s.shirt);R(6,18+b,9,1,'#2b241f');
 // front arm and the prop
 let hx=15+sw,hy=17+b,work=false;
 if(p.arm==='work'){work=true;if(s.tool==='magnifier'){R(15,11+b,2,3,s.shirt);R(16,9+b,2,2,s.shirt);hx=16;hy=7+b}else if(s.tool==='radio'){R(15,11+b,2,3,s.shirt);R(14,10+b,2,1,s.shirt);hx=13;hy=8+b}else{R(15,12+b,2,2,s.shirt);R(16,14+b,1,1,s.shirt);hx=17;hy=14+b}}
 else if(p.arm==='watch'){R(15,12+b,2,3,s.shirt);R(12,15+b,4,1,s.shirt);hx=11;hy=15+b;R(13,15+b,1,1,'#d8dde3')}
 else if(p.arm==='wave'){R(15,10,2,3,s.shirt);R(16+p.k,6,2,4,s.shirt);hx=16+p.k*2;hy=4}
 else if(p.arm==='thumb'){R(15,12,2,2,s.shirt);R(16,9,2,3,s.shirt);hx=16;hy=7;R(17,6,1,1,sk)}
 else{R(15,12+b,2,3,s.shirt);R(15+sw,15+b,2,2,s.shirt)}
 if(!['wave','thumb','watch'].includes(p.arm)&&!p.sit)drawWorkerTool(R,s,work,p.k||0,hx,hy);
 R(hx,hy,2,2,sk);
 // head
 R(7,2+b,6,1,sk);R(6,3+b,8,6,sk);R(7,9+b,6,1,sk);R(9,10+b,3,1,skd);
 if(p.front){R(8,6+b,1,2,eye);R(11,6+b,1,2,eye);R(9,8+b,2,1,skd)}
 else if(p.eye==='back'){R(7,6+b,1,2,eye);R(9,6+b,1,2,eye);R(12,6+b,1,2,skd)}
 else{const e=p.eye==='down'?1:0;R(10,6+b+e,1,2-e,eye);R(12,6+b+e,1,2-e,eye);R(7,6+b,1,2,skd);R(11,8+b,2,1,skd)}
 drawWorkerHat(R,s,b,p.front)
}
const sheets=new Map();
function sheetFor(s){
 let c=sheets.get(s.key);if(c)return c;c=document.createElement('canvas');const n=POSES.length,w=FW*n;c.width=w;c.height=FH*2;const g=c.getContext('2d');
 POSES.forEach((p,f)=>paintWorker(g,f*FW,p,s));
 // a dark 1 px outline so a worker reads on any ground, then a soft shadow behind the feet
 const d=g.getImageData(0,0,w,FH),q=d.data,o=new Uint8ClampedArray(q),r=w*4,on=i=>q[i]>=120;
 for(let i=3;i<q.length;i+=4)if(!on(i)){const x=(i>>2)%w;if((x%FW&&on(i-4))||((x+1)%FW&&on(i+4))||on(i-r)||on(i+r)){o[i-3]=10;o[i-2]=14;o[i-1]=20;o[i]=210}}
 g.putImageData(new ImageData(o,w),0,0);g.globalCompositeOperation='destination-over';g.fillStyle='rgba(0,0,0,.3)';for(let f=0;f<n;f++){g.fillRect(f*FW+4,26,12,2);g.fillRect(f*FW+6,25,8,1)}
 g.globalCompositeOperation='source-over';for(let f=0;f<n;f++){g.save();g.translate(f*FW+FW,0);g.scale(-1,1);g.drawImage(c,f*FW,0,FW,FH,0,FH,FW,FH);g.restore()}
 sheets.set(s.key,c);return c
}
// Which frame, by state: walk while moving (faster when running), the prop's action while working, look around and
// check the watch while waiting, thumbs-up then relax when done, sit on the kerb when stopped, wave when blocked.
// Reduced motion keeps one still frame per state.
// Debug and tests (localStorage localai.debug = 1), in canvas pixels: where each worker is drawn and its frame, the
// district signs, the name tags and bubbles, and the scenery (tree kinds, lamp count).
function layout(){const k=sc(view.zoom)*cam.dpr,box=(x,y,w,h)=>({x:view.panX*cam.dpr+x*k,y:view.panY*cam.dpr+y*k,w:w*k,h:h*k});return{workers:[...agents.values()].map(a=>({id:a.id,state:a.state,frame:a.frame,moving:workerIsMoving(a),vest:roleStyle(a).vest,box:box(Math.round(a.x/2)*2-FW*WS,Math.round(a.y/2)*2+22-FH*2*WS,FW*2*WS,FH*2*WS)})),workerScale:WS,labels:L.signs.map(r=>({...box(r.x,r.y,r.w,r.h),faded:!!r.faded})),bubbles:L.bubbles.map(r=>box(r.x,r.y,r.w,r.h)),trees:trees.map(t=>t[2]+(t[3]?'L':'S')),lamps:lamps.length,
 flows:flowList().map(([a,b])=>({from:a,to:b,points:flowPath(a,b).p.map(q=>({x:q.x,y:q.y}))})),
 cars:traffic.map(c=>({x:c.x,y:c.y,axis:c.axis,dir:c.dir,go:c.go??1})),crossings:CROSSINGS}}
function flowList(){const out=[];for(const w of current?.workers||[])for(const dep of w.dependsOn||[]){const a=current.workers.find(x=>x.id===dep),za=a&&zoneForWorker(a),zb=zoneForWorker(w);if(a&&za!==zb)out.push([za,zb])}return out}
function workerFrame(a,ts){
 const t=ts/1000+a.activitySeed,st=a.state;
 if(reduced)return st==='running'?F.work:st==='error'?F.sit:st==='blocked'?F.wave:F.stand;
 if(workerIsMoving(a)||a.climbing)return F.walk+Math.floor(t*(st==='running'?10:6))%4;
 if(st==='running')return F.work+Math.floor(t*4)%2;
 if(st==='error')return F.sit;
 if(st==='blocked')return F.wave+Math.floor(t*3)%2;
 if(st==='complete')return ts-(a.doneAt||-1e4)<1800?F.thumbs:F.stand;
 const c=t/7%1;return c<.62?F.stand:c<.8?F.look:F.watch
}
// The sprite's feet are at y+22 whatever the scale.
function blit(a,f,x,y){ctx.drawImage(sheetFor(roleStyle(a)),f*FW,a.dir<0?FH:0,FW,FH,x-FW*WS,y+22-FH*2*WS,FW*2*WS,FH*2*WS)}
function drawRunningWorkerSprite(a,ts,x,y,f){
 // a worker hurrying to a job: two speed lines behind them
 const d=a.dir||1,k=WS;ctx.globalAlpha=.4;px(x-d*30*k-(d<0?0:8),y-6*k,8,2,roleStyle(a).accent);px(x-d*26*k-(d<0?0:6),y+2,6,2,roleStyle(a).accent);ctx.globalAlpha=1;blit(a,f,x,y)
}
// ---- Signs and bubbles -----------------------------------------------------------------------------------------
// A district's sign sits on its roof edge: the name on a plate, and progress as its own pill at the right end (above
// the name when the roof is too short for both). Signs are laid out before the workers are drawn, so a name tag or
// bubble steps sideways (then up) off any sign or other bubble; signs are drawn last, over the city.
let L={signs:[],bubbles:[]};const widths=new Map();
function tw(t,n){const k=n+t;if(!widths.has(k)){ctx.font=font(n);widths.set(k,Math.ceil(ctx.measureText(t).width))}return widths.get(k)}
function layoutSigns(){
 L={signs:[],bubbles:[]};if(!display.labels)return;
 for(const[id,d]of Object.entries(DISTRICTS)){
  const f=districtFlags(id),lvl=buildLevel(id),x=d.x*T,y=d.y*T,nw=tw(d.name,9)+16,n={x:x+2,y:y-12,w:nw,h:14,text:d.name,c:f.bad?'#ffb0b0':f.active?'#fff':'#c6d4e1',accent:d.accent};L.signs.push(n);
  if(f.workers.length&&(lvl<.995||f.bad)){const t=Math.round(lvl*100)+'%',w=tw(t,8)+14,rx=x+d.w*T+12-w,fits=rx>=n.x+nw+4;L.signs.push({pill:1,x:fits?rx:n.x,y:fits?y-11:y-27,w,h:12,text:t,pct:lvl,bad:f.bad})}
 }
}
// A sign over a worker (one walking along the roof behind it) is see-through for as long as they overlap.
function drawSigns(){
 const ws=[...agents.values()].map(a=>({x:a.x-FW*WS,y:a.y+22-FH*2*WS,w:FW*2*WS,h:FH*2*WS}));
 for(const r of L.signs){
  r.faded=ws.some(b=>b.x<r.x+r.w&&r.x<b.x+b.w&&b.y<r.y+r.h&&r.y<b.y+b.h);ctx.globalAlpha=r.faded?.38:1;
  if(r.pill){ctx.fillStyle='rgba(6,11,17,.9)';ctx.beginPath();ctx.roundRect(r.x,r.y,r.w,r.h,6);ctx.fill();px(r.x+5,r.y+r.h-3,(r.w-10)*r.pct,2,r.bad?'#ff7383':'#ffb224');txt(r.text,r.x+r.w/2,r.y+r.h/2-1,r.bad?'#ffb0b0':'#ffd27a',8)}
  else{px(r.x,r.y+r.h,r.w,2,'rgba(0,0,0,.35)');px(r.x,r.y,r.w,r.h,'rgba(6,11,17,.9)');px(r.x,r.y,3,r.h,r.accent);txt(r.text,r.x+9,r.y+r.h/2,r.c,9,'left')}
 }
 ctx.globalAlpha=1
}
// Finds room for a tag or bubble: where asked if it's clear, else the nearer side of whatever it hits, else a row up.
function place(r){
 const hit=(x,y)=>L.signs.find(o=>x<o.x+o.w+2&&x+r.w+2>o.x&&y<o.y+o.h+2&&y+r.h+2>o.y)||L.bubbles.find(o=>x<o.x+o.w+2&&x+r.w+2>o.x&&y<o.y+o.h+2&&y+r.h+2>o.y);
 for(let up=0;up<4;up++,r.y-=r.h+3){let x=r.x;for(let i=0;i<5;i++){const o=hit(x,r.y);if(!o){r.x=x;L.bubbles.push(r);return r}const lf=o.x-r.w-2,rt=o.x+o.w+2;x=Math.abs(lf-r.x)<=Math.abs(rt-r.x)?lf:rt}}
 return null
}
// One short word or mark: the step's verb while working, ✓ done, … waiting, ! stopped.
const VERB={router:'Planning',mission_router:'Planning',ux_analyst:'Reviewing',documentation:'Writing',code_analyst:'Reading',test_engineer:'Testing',research_agent:'Searching',security_reviewer:'Checking',performance_analyst:'Measuring',synthesis:'Combining',coordinator:'Combining',engineer:'Building',validator:'Testing',reviewer:'Reviewing',deployer:'Shipping',operator:'Watching'};
function drawWorkerBubble(r,t,c,x){ctx.fillStyle='rgba(5,10,16,.9)';ctx.beginPath();ctx.roundRect(r.x,r.y,r.w,r.h,5);ctx.fill();const k=clamp(x,r.x+6,r.x+r.w-6);pathPoly([[k-3,r.y+r.h],[k+3,r.y+r.h],[k,r.y+r.h+3]],'rgba(5,10,16,.9)');txt(t,r.x+r.w/2,r.y+r.h/2,c,8)}
// Name tag ("Team lead", "Code Analyst"): for the selected worker, and on hover.
function drawNameTag(r,t){ctx.fillStyle='rgba(5,10,16,.92)';ctx.beginPath();ctx.roundRect(r.x,r.y,r.w,r.h,4);ctx.fill();txt(t,r.x+r.w/2,r.y+r.h/2,'#eef6ff',8)}
function drawWorkerSprite(a,ts){
 const x=Math.round(a.x/2)*2,y=Math.round(a.y/2)*2,sel=selected?.type==='agent'&&selected.id===a.id,f=a.frame=workerFrame(a,ts),c=roleStyle(a).accent;let top=y+22-59*WS;
 if(sel){ctx.save();ctx.fillStyle='rgba(255,255,255,.14)';ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.shadowColor=c;ctx.shadowBlur=10;ctx.beginPath();ctx.ellipse(x,y+19,19*WS,7*WS,0,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.restore()}
 if(workerIsRunning(a))drawRunningWorkerSprite(a,ts,x,y,f);else blit(a,f,x,y);
 if(display.labels&&(sel||hovered?.type==='agent'&&hovered.id===a.id)){const w=tw(a.name,8)+12,r=place({x:x-w/2,y:top-13,w,h:13});if(r){drawNameTag(r,a.name);top=r.y-3}}
 if(sel||a.state==='running'&&view.zoom>1.4){const s=a.state,t=s==='running'?VERB[a.id.replace(/-followup-\d+$/,'')]||'Working':s==='complete'?'✓':s==='pending'?'…':'!',w=tw(t,8)+12,r=place({x:x-w/2,y:top-13,w,h:13});if(r)drawWorkerBubble(r,t,s==='running'?c:s==='complete'?'#75dfa2':s==='pending'?'#9fb0c0':'#ffb0b0',x)}
 else if(a.state==='running'){ctx.globalAlpha=reduced?1:.6+.4*Math.sin(ts/180);px(x-2,y+22-66*WS,4,4,c);ctx.globalAlpha=1}
}
function drawAgents(ts){
 for(const d of dust){ctx.globalAlpha=clamp(d.life/.42,0,1)*.5;ctx.fillStyle=display.night?'#70808c':'#c5b99a';ctx.beginPath();ctx.arc(d.x,d.y,d.r,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=1;for(const a of agents.values()){drawWorkerSprite(a,ts);drawWorkingAction(a,ts)}
 for(const p of packets){ctx.save();ctx.shadowColor=p.color;ctx.shadowBlur=12;px(p.x-6,p.y-5,12,9,'#182431');px(p.x-5,p.y-4,10,7,p.color);px(p.x-2,p.y-2,4,2,'#fff');ctx.restore()}
 for(const q of pulses){const k=(now()-q.t)/700;ctx.strokeStyle='rgba(117,223,162,'+(1-k)+')';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(q.x,q.y,6+k*22,3+k*9,0,0,Math.PI*2);ctx.stroke()}
 for(const a of artifacts){
  ctx.save();ctx.shadowColor=a.color;ctx.shadowBlur=8;
  if(a.kind==='build'){px(a.x-10,a.y-8,20,14,'#263746');px(a.x-8,a.y-6,16,10,a.color);px(a.x-5,a.y-3,10,5,'#14202b')}
  else if(a.kind==='certificate'){px(a.x-9,a.y-8,18,15,'#edf6ef');px(a.x-6,a.y-5,12,2,a.color);ctx.fillStyle=a.color;ctx.beginPath();ctx.arc(a.x+4,a.y+2,3,0,Math.PI*2);ctx.fill()}
  else if(a.kind==='node'){ctx.fillStyle=a.color;ctx.beginPath();ctx.arc(a.x,a.y,8,0,Math.PI*2);ctx.fill();px(a.x-2,a.y-2,4,4,'#fff')}
  else{px(a.x-8,a.y-9,16,15,'#eef5ff');px(a.x-6,a.y-6,12,2,a.color);px(a.x-6,a.y-2,9,1,'#8093a5');px(a.x-6,a.y+1,7,1,'#8093a5')}
  ctx.restore()
 }
 for(const s of sparks){ctx.globalAlpha=clamp(s.life,0,1);px(s.x,s.y,s.size,s.size,s.color)}ctx.globalAlpha=1
}
function drawClouds(ts){if(display.night)return;ctx.save();ctx.globalAlpha=.08;for(const c of clouds){const x=(c.x+(reduced?0:ts)*.006*c.s)%W,y=c.y;ctx.fillStyle='#d8f0ff';ctx.beginPath();ctx.arc(x,y,26*c.s,0,Math.PI*2);ctx.arc(x+28*c.s,y+6,20*c.s,0,Math.PI*2);ctx.arc(x-25*c.s,y+8,17*c.s,0,Math.PI*2);ctx.fill()}ctx.restore()}function drawMoments(ts){let i=0;for(const a of agents.values()){if(a.state!=='complete'&&a.state!=='error'&&a.state!=='blocked')continue;const d=DISTRICTS[a.zone];if(!d)continue;
 if(a.state==='complete'){const fx=d.x*T+18+(i++%4)*16,fy=d.y*T-34,wave=reduced?0:Math.sin(ts/220+fx)*2;px(fx,fy,2,22,'#cfd8e0');pathPoly([[fx+2,fy],[fx+14,fy+4+wave],[fx+2,fy+9]],a.color||'#3ed598')}
 else{const x=a.x+16*WS,y=a.y+22-52*WS,bl=reduced||Math.floor(ts/500)%2===0;pathPoly([[x,y-12],[x+11,y+8],[x-11,y+8]],bl?'#ffc640':'#e0a020');txt('!',x,y+2,'#2a1600',11)}}}
function drawCommandCelebration(ts){
 if(ts>celebrationUntil)return;const d=DISTRICTS.command,x=(d.x+d.w/2)*T,y=d.y*T-10,life=clamp((celebrationUntil-ts)/3600,0,1);
 ctx.save();ctx.globalAlpha=Math.min(1,life*2);
 for(let i=0;i<18;i++){const a=i/18*Math.PI*2,r=18+(1-life)*90,c=i%3===0?'#75dfa2':i%3===1?'#71b7ff':'#f5c04f';px(x+Math.cos(a)*r,y+Math.sin(a)*r*.55,4,4,c)}
 ctx.strokeStyle='rgba(117,223,162,'+(.35+.35*Math.sin(ts/160))+')';ctx.lineWidth=3;ctx.beginPath();ctx.arc(x,y,20+(1-life)*28,0,Math.PI*2);ctx.stroke();txt('DONE!',x,y-30,'#eafff1',9);ctx.restore()
}

function drawMinimap(){
 const el=$('#awcMinimap');if(!el)return;
 const markers=Object.entries(DISTRICTS).map(([id,d])=>`<i style="left:${((d.x+d.w/2)*T/W)*100}%;top:${((d.y+d.h/2)*T/H)*100}%;--c:${d.accent}" title="${esc(d.name)}"></i>`).join('');
 el.innerHTML='<span></span>'+markers;
}
function draw(ts){
 if(!ctx||!cam.w)return;const s=sc(view.zoom);fk=s*cam.dpr;ctx.setTransform(cam.dpr,0,0,cam.dpr,0,0);ctx.clearRect(0,0,cam.w,cam.h);ctx.save();ctx.translate(view.panX,view.panY);ctx.scale(s,s);drawGround(ts);ctx.imageSmoothingEnabled=false;drawFlows(ts);drawTraffic();for(const[id,d]of Object.entries(DISTRICTS)){drawDistrictScene(id,d,ts);drawBuilding(id,d,ts);drawInterior(id,d,ts);drawWorksite(id,d,ts)}layoutSigns();drawAgents(ts);drawMoments(ts);drawCommandCelebration(ts);drawClouds(ts);drawSigns();if(!current&&!display.night){const g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,'rgba(255,170,90,.20)');g.addColorStop(.6,'rgba(255,140,70,.08)');g.addColorStop(1,'rgba(120,60,90,.14)');ctx.fillStyle=g;ctx.fillRect(0,0,W,H)}if(display.night){ctx.fillStyle='rgba(3,7,14,.18)';ctx.fillRect(0,0,W,H)}ctx.restore()
}
// Animate only while the city canvas is on screen and the tab is visible; at most one rAF chain.
let io=null,observed=null,onScreen=!('IntersectionObserver' in window);
function canAnimate(){return !!(canvas&&canvas.isConnected&&onScreen&&!document.hidden)}
function stop(){if(raf){cancelAnimationFrame(raf);raf=0}last=0}
function loop(ts){raf=0;if(!canAnimate()){last=0;return}const dt=last?Math.min(.05,(ts-last)/1000||0):0;last=ts;update(dt,ts);draw(ts);raf=requestAnimationFrame(loop)}
function start(){
 if(canvas&&observed!==canvas&&'IntersectionObserver' in window){io?.disconnect();onScreen=false;observed=canvas;io=new IntersectionObserver(entries=>{onScreen=entries[entries.length-1].isIntersecting;onScreen?start():stop()});io.observe(canvas)}
 if(!raf&&canAnimate())raf=requestAnimationFrame(loop)
}
document.addEventListener('visibilitychange',()=>document.hidden?stop():start());
async function bootstrap(){try{const r=await fetch('/api/agents/missions'),j=await r.json(),items=j.items||j.missions||[],active=items.find(m=>m.status==='running')||items[0];if(active){applyMission(active);connectSSE();return}}catch{}try{const r=await fetch('/api/engineering/runs'),j=await r.json(),runs=j.items||[],active=runs.find(x=>x.status==='running')||runs[0];if(active)applyEngineering(active)}catch{}idleCrew();connectSSE()}
let unsubscribeSSE=null;
// On every (re)open, catch up on the mission that ran while Missions was off screen.
async function refreshLiveMission(){try{const r=await fetch('/api/agents/missions'),j=await r.json(),items=j.items||j.missions||[],m=items.find(x=>x.status==='running')||items[0];if(m)applyMission(m)}catch{}}
function connectSSE(){if(unsubscribeSSE)return;try{unsubscribeSSE=missionStream.subscribe(m=>{liveSnapshot=normalizeMission(m);applyMission(m)},null,refreshLiveMission)}catch{}}
document.addEventListener('localai:engineering-run',e=>applyEngineering(e.detail?.run||e.detail));window.addEventListener('localai:agentworld-start',()=>{const d=DISTRICTS.command;focusPoint((d.x+d.w/2)*T,(d.y+d.h/2)*T,1.6)});window.addEventListener('localai:agentworld-mission',e=>{if(e.detail?.mission&&!replay.active)applyMission(e.detail.mission)});window.addEventListener('localai:agentworld-replay-mission',e=>{const m=e.detail?.mission;if(m){loadMissionReplay(m);if((m.timeline||[]).length>1){applyReplayFrame(0);if(e.detail.play&&!replay.playing)toggleReplay()}}});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{mount();drawMinimap()},{once:true});else{mount();drawMinimap()}
})();

// ==== claude-board.js ====
(() => {
  'use strict';

  // Claude board: live progress of Claude Code sessions plus a ranked, votable board of the findings they report.
  const POLL_MS = 4000;
  const SEVERITIES = ['high', 'medium', 'low'];
  // Lifecycle: you decide (proposed -> approved / later / won't do); Claude moves approved work to in progress and done.
  const STATUS = {
    proposed: { label: 'Needs your decision', short: 'Proposed', step: 0 },
    approved: { label: 'Queued for Claude', short: 'Queued', step: 1 },
    in_progress: { label: 'Claude is working', short: 'Working', step: 2 },
    fixed: { label: 'Done', short: 'Done', step: 3 },
    deferred: { label: 'Later', short: 'Later', step: -1 },
    rejected: { label: "Won't do", short: "Won't do", step: -1 }
  };
  // [status to set, button label, style, past-tense toast]
  const ACTIONS = {
    proposed: [['approved', 'Approve', 'primary', 'Approved'], ['deferred', 'Later', '', 'Moved to later'], ['rejected', "Won't do", 'quiet', "Marked won't do"]],
    approved: [['proposed', 'Undo approval', '', 'Approval undone'], ['deferred', 'Later', 'quiet', 'Moved to later']],
    in_progress: [['approved', 'Pause', '', 'Paused; back in the queue']],
    fixed: [['proposed', 'Reopen', 'quiet', 'Reopened']],
    deferred: [['proposed', 'Reopen', '', 'Reopened'], ['approved', 'Approve', 'primary', 'Approved']],
    rejected: [['proposed', 'Reopen', 'quiet', 'Reopened']]
  };
  const TABS = [['decide', 'Needs your decision', (f) => f.status === 'proposed'], ['queued', 'Queued for Claude', (f) => f.status === 'approved'],
    ['working', 'Claude is working', (f) => f.status === 'in_progress'], ['done', 'Done', (f) => f.status === 'fixed'],
    ['aside', 'Set aside', (f) => f.status === 'deferred' || f.status === 'rejected'], ['all', 'All', () => true]];
  const catLabel = (c) => ({ ux: 'UX', api: 'API', ci: 'CI' })[c] || c;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const view = { data: null, session: '', statusFilter: '', noteId: '', toastTimer: 0, category: '', severity: '', timer: 0, busy: false, openIds: new Set() };
  const $ = (id) => document.getElementById(id);

  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(s)) return '';
    if (s < 60) return `${Math.round(s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  async function api(url, body) {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  async function load() {
    if (view.busy) return;
    view.busy = true;
    try {
      view.data = await api(`/api/claude/board${view.session ? `?session=${encodeURIComponent(view.session)}` : ''}`);
      $('claudeLive').className = 'claude-live on';
      $('claudeLive').textContent = 'live';
      render();
    } catch (e) {
      $('claudeLive').className = 'claude-live off';
      $('claudeLive').textContent = 'offline';
      $('claudeFindings').innerHTML = `<div class="empty-state">Claude board unavailable: ${esc(e.message)}</div>`;
    } finally { view.busy = false; }
  }

  function render() {
    const d = view.data;
    renderSessions(d.sessions);
    renderLive(d.live || []);
    renderProgress(d.summary, d.statuses);
    renderTimeline(d.events);
    renderMatrix(d.summary.byCategory);
    // Don't redraw the list under someone typing a note; the next refresh after they finish catches up.
    if (!(view.noteId && document.activeElement?.closest?.('[data-claude-note-form]'))) renderFindings(d.findings);
  }

  function renderSessions(sessions) {
    const sel = $('claudeSession');
    const opts = ['<option value="">All sessions</option>', ...sessions.map((s) => `<option value="${esc(s.id)}"${s.id === view.session ? ' selected' : ''}>${esc(s.title)} · ${esc(ago(s.updatedAt))}</option>`)];
    const html = opts.join('');
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  }

  // "Live now": one chip per session the progress feed says is active. Tapping filters the page to it; tapping again clears.
  // Chips are keyed by session id and updated in place, so a poll never replaces the element under a tap or keyboard focus.
  function renderLive(live) {
    const box = $('claudeLiveNow');
    box.hidden = !live.length;
    const ids = live.map((l) => l.id).join('\n');
    if (box.dataset.ids !== ids) {
      box.dataset.ids = ids;
      box.innerHTML = live.map((l) => `<button type="button" class="claude-livechip" data-claude-live="${esc(l.id)}"><i class="dot" aria-hidden="true"></i><span class="claude-livechip-body"><b class="claude-livechip-title"></b><span class="claude-livechip-step"><span class="claude-livechip-state"></span><span class="claude-livechip-text"></span><span class="claude-livechip-ago"></span></span></span></button>`).join('');
    }
    const chips = box.children;
    live.forEach((l, i) => {
      const chip = chips[i], working = l.state === 'working', state = working ? 'working' : 'waiting', when = ago(l.at);
      chip.setAttribute('aria-pressed', String(l.id === view.session));
      chip.setAttribute('aria-label', `${l.title}, ${state}, ${l.lastEvent}, ${when}`);
      chip.querySelector('.dot').className = `dot ${state}`;
      const set = (sel, text) => { const el = chip.querySelector(sel); if (el.textContent !== text) el.textContent = text; };
      set('.claude-livechip-title', l.title);
      set('.claude-livechip-state', working ? 'Working' : 'Waiting');
      set('.claude-livechip-text', l.lastEvent);
      set('.claude-livechip-ago', when);
    });
  }

  function renderProgress(summary, statuses) {
    const total = summary.total || 0;
    const order = ['fixed', 'in_progress', 'approved', 'proposed', 'deferred', 'rejected'];
    const bar = total ? order.map((k) => {
      const n = summary.byStatus[k] || 0;
      return n ? `<span class="seg st-${k}" style="flex:${n}" title="${esc(STATUS[k].label)}: ${n}"></span>` : '';
    }).join('') : '<span class="seg empty-seg" style="flex:1"></span>';
    const fixed = summary.byStatus.fixed || 0;
    $('claudeProgress').innerHTML = `
      <div class="claude-progress-head"><strong>${fixed} of ${total} findings done</strong><span>${summary.byStatus.proposed || 0} need your decision · ${(summary.byStatus.approved || 0) + (summary.byStatus.in_progress || 0)} with Claude</span></div>
      <div class="claude-bar">${bar}</div>
      <div class="claude-legend">${order.map((k) => `<span><i class="dot st-${k}"></i>${esc(STATUS[k].short)} ${summary.byStatus[k] || 0}</span>`).join('')}</div>`;
  }

  function renderTimeline(events) {
    const box = $('claudeTimeline');
    if (!events.length) { box.innerHTML = '<div class="empty-state">No Claude activity reported yet.</div>'; return; }
    box.innerHTML = events.slice(0, 80).map((e) => `
      <div class="claude-event ev-${esc(e.status)} kind-${esc(e.kind)}">
        <i class="dot"></i>
        <div class="claude-event-body">
          <div class="claude-event-title">${e.phase ? `<span class="claude-phase">${esc(e.phase)}</span>` : ''}${esc(e.title)}</div>
          ${e.detail ? `<div class="claude-event-detail">${esc(e.detail)}</div>` : ''}
        </div>
        <span class="claude-event-time" title="${esc(e.at)}">${esc(e.tool || '')} ${esc(ago(e.at))}</span>
      </div>`).join('');
  }

  function renderMatrix(byCategory) {
    const cats = Object.entries(byCategory).sort((a, b) => b[1].open - a[1].open || b[1].total - a[1].total);
    const max = Math.max(1, ...cats.flatMap(([, c]) => SEVERITIES.map((s) => c[s])));
    if (!cats.length) { $('claudeMatrix').innerHTML = '<div class="empty-state">No findings yet.</div>'; return; }
    $('claudeMatrix').innerHTML = `<table class="claude-matrix"><thead><tr><th>Category</th>${SEVERITIES.map((s) => `<th>${s}</th>`).join('')}<th>Open</th></tr></thead><tbody>${cats.map(([cat, c]) => `
      <tr class="${view.category === cat ? 'selected' : ''}">
        <th><button type="button" data-claude-cat="${esc(cat)}">${esc(catLabel(cat))}</button></th>
        ${SEVERITIES.map((s) => `<td><button type="button" class="heat sev-${s}${view.category === cat && view.severity === s ? ' selected' : ''}" style="--heat:${c[s] / max}" data-claude-cat="${esc(cat)}" data-claude-sev="${s}" aria-label="${esc(catLabel(cat))}, ${s}: ${c[s] || 'none'}" ${c[s] ? '' : 'disabled'}>${c[s] || ''}</button></td>`).join('')}
        <td class="open-count">${c.open}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  function visible(findings) {
    const tab = TABS.find(([k]) => k === view.statusFilter) || TABS[0];
    return findings.filter((f) => tab[2](f)
      && (!view.category || f.category === view.category) && (!view.severity || f.severity === view.severity));
  }

  function lifecycle(status) {
    const step = STATUS[status]?.step ?? 0;
    if (step < 0) return `<span class="claude-life aside" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`;
    return `<span class="claude-life" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<i class="${i < step ? 'past' : i === step ? 'now' : ''}"></i>`).join('')}</span>`;
  }

  function renderFindings(findings) {
    if (!view.statusFilter) view.statusFilter = findings.some((f) => f.status === 'proposed') ? 'decide' : 'queued';
    const liveWorking = (view.data?.live || []).filter((l) => l.state === 'working').length;
    $('claudeFilters').innerHTML = TABS.map(([k, label, test]) => {
      const n = findings.filter(test).length;
      const text = k === 'working' && liveWorking ? `${label} · ${liveWorking} live` : label;
      return `<button type="button" class="chip tab${view.statusFilter === k ? ' active' : ''}" data-claude-status="${k}" aria-pressed="${view.statusFilter === k}">${esc(text)} <b>${n}</b></button>`;
    }).join('') + (view.category ? `<button type="button" class="chip clear" data-claude-clear>${esc(view.category)}${view.severity ? ` · ${esc(view.severity)}` : ''} ✕</button>` : '');
    const list = visible(findings);
    const top = Math.max(1, ...findings.map((f) => f.score));
    $('claudeFindingCount').textContent = `${list.length} shown`;
    if (!list.length) {
      const empty = { decide: 'Nothing is waiting for your decision.', queued: 'Nothing is queued. Approve a finding to send it to Claude.', working: 'Claude is not working on anything right now.', done: 'Nothing is done yet.', aside: 'Nothing has been set aside.' }[view.statusFilter] || 'Nothing matches these filters.';
      $('claudeFindings').innerHTML = `<div class="empty-state">${esc(empty)}</div>`;
      return;
    }
    $('claudeFindings').innerHTML = list.map((f) => {
      const st = STATUS[f.status] || STATUS.proposed;
      const actions = (ACTIONS[f.status] || []).map(([to, label, style]) => `<button type="button" class="btn-outline ${style}" data-claude-decision="${to}">${esc(label)}</button>`).join('');
      const note = view.noteId === f.id
        ? `<form class="claude-note-form" data-claude-note-form><textarea rows="2" maxlength="1000" placeholder="Context or instructions for Claude">${esc(f.decisionNote || '')}</textarea><div><button type="submit" class="btn-primary">Save note</button><button type="button" class="btn-outline" data-claude-note-cancel>Cancel</button></div></form>`
        : `<button type="button" class="link" data-claude-note>${f.decisionNote ? 'Edit note' : 'Add a note for Claude'}</button>`;
      return `
      <article class="claude-finding st-${esc(f.status)}" data-id="${esc(f.id)}">
        <div class="claude-rank"><b>#${f.rank}</b><span class="claude-score" title="Priority score: severity + 6 × net votes + decision">${f.score}</span>
          <span class="claude-score-bar"><i style="width:${Math.max(4, Math.round(Math.max(0, f.score) / top * 100))}%"></i></span></div>
        <div class="claude-finding-main">
          <div class="claude-finding-head"><span class="claude-state st-${esc(f.status)}">${f.status === 'in_progress' ? '<i class="spin"></i>' : ''}${esc(st.label)}</span>${lifecycle(f.status)}</div>
          <div class="claude-finding-title">${esc(f.title)}</div>
          <div class="claude-chips">
            <span class="chip sev-${esc(f.severity)}">${esc(f.severity)}</span><span class="chip">${esc(catLabel(f.category))}</span>
            ${f.pr ? `<span class="chip pr">${esc(f.pr)}</span>` : ''}${f.file ? `<span class="chip file">${esc(f.file)}</span>` : ''}
          </div>
          ${f.decisionNote && view.noteId !== f.id ? `<p class="claude-note">“${esc(f.decisionNote)}”</p>` : ''}
          <details${view.openIds.has(f.id) ? ' open' : ''} data-claude-details="${esc(f.id)}"><summary>Details</summary>
            ${f.summary ? `<p>${esc(f.summary)}</p>` : ''}${f.scenario ? `<p><b>Failure scenario</b> ${esc(f.scenario)}</p>` : ''}${f.fix ? `<p><b>Fix</b> ${esc(f.fix)}</p>` : ''}
          </details>
        </div>
        <div class="claude-vote" role="group" aria-label="Priority">
          <button type="button" class="btn-outline" data-claude-vote="1" aria-label="Raise priority" title="Raise priority">▲</button>
          <span title="${f.votes.up} up · ${f.votes.down} down">${f.votes.up - f.votes.down}</span>
          <button type="button" class="btn-outline" data-claude-vote="-1" aria-label="Lower priority" title="Lower priority">▼</button>
        </div>
        <div class="claude-decide">${actions}${note}</div>
      </article>`;
    }).join('');
  }

  // Decisions update the card immediately, then sync; a toast offers Undo for six seconds.
  function toast(message, undo) {
    let el = $('claudeToast');
    // Paused while the pointer or focus is on it (Undo stays reachable); hiding empties it so no invisible Undo stays in the Tab order.
    const hide = () => { clearTimeout(view.toastTimer); el.classList.remove('show'); el.replaceChildren(); };
    const later = () => { clearTimeout(view.toastTimer); view.toastTimer = setTimeout(() => { if (!el.matches(':hover') && !el.contains(document.activeElement)) hide(); }, 6000); };
    if (!el) {
      el = document.createElement('div'); el.id = 'claudeToast'; el.className = 'claude-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el);
      el.addEventListener('mouseenter', () => clearTimeout(view.toastTimer)); el.addEventListener('focusin', () => clearTimeout(view.toastTimer));
      el.addEventListener('mouseleave', () => { if (el.classList.contains('show')) el._later(); });
      el.addEventListener('focusout', (e) => { if (el.classList.contains('show') && !el.contains(e.relatedTarget)) el._later(); });
    }
    el._later = later;
    el.innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button" class="btn-outline">Undo</button>' : ''}`;
    el.classList.add('show');
    if (undo) el.querySelector('button').onclick = () => { hide(); undo(); };
    later();
  }
  async function decide(id, status, { note, quiet } = {}) {
    const f = view.data?.findings.find((x) => x.id === id);
    if (!f) return;
    const before = { status: f.status, note: f.decisionNote };
    const action = (ACTIONS[f.status] || []).find(([to]) => to === status);
    f.status = status;
    if (note !== undefined) f.decisionNote = note;
    render();
    try {
      await api('/api/claude/findings/decision', { id, status, ...(note !== undefined ? { note } : {}) });
      if (!quiet) toast(`${action ? action[3] : 'Saved'}: ${f.title}`, () => decide(id, before.status, { note: before.note ?? '', quiet: true }));
    } catch (e) {
      f.status = before.status; f.decisionNote = before.note; render();
      toast(`Couldn't save: ${e.message}`);
    }
    load();
  }

  async function act(fn) {
    // app.js is a module, so there is no window.toast: say it in the shared toast, never a blocking alert().
    try { await fn(); await load(); } catch (e) { const m = `Couldn't do that: ${e.message}`; if (window.LocalAIUI?.toast) window.LocalAIUI.toast(m); else toast(m); }
  }

  function bind() {
    $('claudeRefresh').addEventListener('click', load);
    $('claudeSession').addEventListener('change', (e) => { view.session = e.target.value; load(); });
    $('claude').addEventListener('toggle', (e) => {
      const id = e.target.dataset?.claudeDetails;
      if (id) e.target.open ? view.openIds.add(id) : view.openIds.delete(id);
    }, true);
    $('claude').addEventListener('submit', (e) => {
      const form = e.target.closest('[data-claude-note-form]');
      if (!form) return;
      e.preventDefault();
      const id = form.closest('.claude-finding')?.dataset.id, f = view.data?.findings.find((x) => x.id === id);
      view.noteId = '';
      if (f) decide(id, f.status, { note: form.querySelector('textarea').value.trim(), quiet: true }).then(() => toast('Note saved for Claude'));
    });
    $('claude').addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.claudeLive) {
        view.session = view.session === t.dataset.claudeLive ? '' : t.dataset.claudeLive;
        render();
        $('claudeSession').value = view.session;
        load();
        return;
      }
      if (t.dataset.claudeStatus) { view.statusFilter = t.dataset.claudeStatus; render(); return; }
      if (t.hasAttribute('data-claude-note')) { view.noteId = t.closest('.claude-finding')?.dataset.id || ''; render(); $('claude').querySelector('[data-claude-note-form] textarea')?.focus(); return; }
      if (t.hasAttribute('data-claude-note-cancel')) { view.noteId = ''; render(); return; }
      if (t.hasAttribute('data-claude-clear')) { view.category = ''; view.severity = ''; render(); return; }
      if (t.dataset.claudeCat) {
        const same = view.category === t.dataset.claudeCat && view.severity === (t.dataset.claudeSev || '');
        view.category = same ? '' : t.dataset.claudeCat;
        view.severity = same ? '' : (t.dataset.claudeSev || '');
        render();
        return;
      }
      const id = t.closest('.claude-finding')?.dataset.id;
      if (!id) return;
      if (t.dataset.claudeVote) act(() => api('/api/claude/findings/vote', { id, delta: Number(t.dataset.claudeVote) }));
      if (t.dataset.claudeDecision) decide(id, t.dataset.claudeDecision);
    });
  }

  // Poll only while the view is on screen and the tab is visible.
  function syncPolling() {
    const active = $('claude')?.classList.contains('active') && document.visibilityState === 'visible';
    if (active && !view.timer) { load(); view.timer = setInterval(load, POLL_MS); }
    if (!active && view.timer) { clearInterval(view.timer); view.timer = 0; }
  }

  function init() {
    const section = $('claude');
    if (!section) return;
    bind();
    new MutationObserver(syncPolling).observe(section, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', syncPolling);
    syncPolling();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

// ==== claude-chat.js ====
(() => {
  'use strict';

  // Claude chat: talk to a Claude Code session on the Mac from this page. Everything goes through the appliance relay
  // (/api/claude/chat/); this device proves itself with an HttpOnly cookie it gets by pairing with a code approved on the Mac.
  // Message text is only ever written with textContent, never as HTML.
  const API = '/api/claude/chat/';
  const FAST_MS = 2000, SLOW_MS = 15000, SESSIONS_MS = 10000, PAIR_MS = 2000;
  const INFLIGHT_MS = 10 * 60 * 1000; // a sending/delivered message older than this is left as it is (no reply is coming)
  const STATUS_LABEL = { delivering: 'sending' }; // the relay's "delivering" is transient: the bridge holds it until it acks
  const NOTE = "Web messages reach Claude as messages from another session: it acts within this session's permissions, but won't change its settings or approve prompts because of them.";
  const OFFLINE = 'This session is offline. Start or resume it on your Mac with `claude-chat`.';
  const HTTP_WARNING = 'This page is served over plain HTTP, so the pairing cookie crosses your Wi-Fi unencrypted until HTTPS is set up. Revoke a device if it may be exposed.';
  const UNREACHABLE = "Can't reach Local AI right now (it may be restarting). Trying again…";
  const STORE_KEY = 'localai.claudeChat.session';
  // The pending pairing, so a reload shows the same code instead of asking for another (5 can be pending at once).
  const PAIR_KEY = 'localai.claudeChat.pair';
  const pairStore = {
    get() { try { return sessionStorage.getItem(PAIR_KEY) || ''; } catch { return ''; } },
    set(id) { try { if (id) sessionStorage.setItem(PAIR_KEY, id); else sessionStorage.removeItem(PAIR_KEY); } catch {} }
  };
  const NOT_KEPT = "Your Mac approved the code, but this browser didn't keep the pairing (it may block cookies here). Try again, or use the secure address if it's set up.";
  // Over plain HTTP, the secure address may already work on this device (and may already be paired there). Same probe
  // and per-tab cache as Health › Secure connection: a no-cors fetch succeeds only if this device trusts the certificate.
  const SECURE_URL = `https://${location.hostname}/`;
  async function secureWorks() {
    try { const seen = sessionStorage.getItem('localai.httpsTrusted'); if (seen) return seen === '1'; } catch {}
    let ok; try { await fetch(`${SECURE_URL}healthz`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(4000) }); ok = true; } catch { ok = false; }
    try { sessionStorage.setItem('localai.httpsTrusted', ok ? '1' : '0'); } catch {}
    return ok;
  }
  const $ = (id) => document.getElementById(id);
  const st = { mode: 'init', sessions: [], session: '', messages: [], after: 0, sending: false, pair: null, pairError: '', pairTimer: 0, whoFailed: false,
    pollTimer: 0, sessionsAt: 0, polling: false, devices: [], devicesOpen: false, draft: '', built: '', paired: null, who: null };

  const store = {
    get() { try { return localStorage.getItem(STORE_KEY) || ''; } catch { return ''; } },
    set(v) { try { localStorage.setItem(STORE_KEY, v); } catch {} }
  };

  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  async function api(route, body) {
    const r = await fetch(API + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok) throw new HttpError(r.status, j.error || `HTTP ${r.status}`);
    return j;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const isActive = () => !!document.querySelector('#claude.active');
  const current = () => st.sessions.find((s) => s.sessionId === st.session);
  const when = (ms) => {
    const s = Math.max(0, (Date.now() - Number(ms)) / 1000);
    if (!Number.isFinite(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };

  // ---- Pairing ----
  function stopPairTimer() { if (st.pairTimer) { clearInterval(st.pairTimer); st.pairTimer = 0; } }

  async function startPairing() {
    stopPairTimer();
    st.mode = 'pair';
    st.pair = null;
    st.pairError = '';
    render();
    try {
      st.pair = await api('pair-request', { resume: pairStore.get() || undefined });
      pairStore.set(st.pair.id);
      render();
      if (location.protocol === 'http:' && st.secureOk === undefined) { st.secureOk = null; secureWorks().then((ok) => { st.secureOk = ok; if (st.mode === 'pair') render(); }); }
      st.pairTimer = setInterval(checkPair, PAIR_MS);
    } catch (e) {
      if (!e.status || e.status >= 500) { st.mode = 'error'; st.pairError = UNREACHABLE; render(); return; } // schedule() retries
      st.pairError = e.status === 429 ? 'Too many pending pairing requests — try again in a few minutes.' : `Could not start pairing: ${e.message}`;
      render();
    }
  }

  async function checkPair() {
    if (!st.pair || !isActive() || document.visibilityState !== 'visible') return;
    try {
      const r = await api(`pair-status?id=${encodeURIComponent(st.pair.id)}`);
      if (r.status === 'approved') {
        stopPairTimer(); st.pair = null; pairStore.set('');
        await loadSessions(true);
        // Approved, yet the sessions call is still unauthorized: the browser refused the cookie. Say so; don't keep waiting.
        if (st.paired === false && st.mode === 'pair') { st.pairError = NOT_KEPT; render(); }
      }
      else if (r.status === 'expired') { stopPairTimer(); pairStore.set(''); st.pair = { expired: true }; render(); }
    } catch { /* keep waiting; the next tick tries again */ }
  }

  // ---- Sessions and messages ----
  const askWho = () => api('whoami').then((r) => { st.paired = !!r.paired; }, () => { st.whoFailed = true; });
  async function loadSessions(force) {
    // Ask whoami before the first sessions request, so an unpaired device goes straight to pairing without a 401.
    if (!force) {
      if (st.whoFailed) { st.whoFailed = false; st.who = askWho(); }
      await st.who;
      if (st.paired === false) { if (st.mode !== 'pair' && isActive()) startPairing(); return; }
    }
    try {
      const r = await api('sessions');
      st.paired = true;
      st.sessionsAt = Date.now();
      st.sessions = r.items || [];
      if (st.mode !== 'paired') { st.mode = 'paired'; st.messages = []; st.after = 0; }
      if (!st.sessions.some((s) => s.sessionId === st.session)) {
        const saved = store.get();
        st.session = st.sessions.some((s) => s.sessionId === saved) ? saved : (st.sessions.find((s) => s.online) || st.sessions[0] || {}).sessionId || '';
        st.messages = []; st.after = 0;
      }
      render();
      if (force || st.mode === 'paired') poll();
    } catch (e) {
      if (e.status === 401) { st.paired = false; if (st.mode !== 'pair' && isActive()) startPairing(); else if (st.mode === 'paired') st.mode = 'init'; }
      // Not reached, or a server error (a deploy restarts the appliance): say so; schedule() keeps retrying.
      else if (st.mode === 'init' || st.mode === 'error') { st.mode = 'error'; st.pairError = !e.status || e.status >= 500 ? UNREACHABLE : `Chat is unavailable: ${e.message}`; render(); }
    }
  }

  async function poll() {
    if (st.polling || st.mode !== 'paired' || !st.session) return;
    st.polling = true;
    const sid = st.session;
    try {
      // One request. While messages are still in flight, start just before the oldest of them so the reply carries their
      // current statuses (and any deletion shows as a gap) plus everything newer. A message queued on an offline session
      // is skipped here: the 10 s sessions refresh notices when it comes back online. A sending (delivering) or delivered
      // message counts only for 10 minutes after it was sent, so one that never gets a reply cannot keep the window open forever.
      const online = current()?.online;
      const recent = (m) => Date.now() - (m.at || 0) < INFLIGHT_MS;
      const inflight = st.messages.filter((m) => m.source === 'web' && (((m.status === 'delivered' || m.status === 'delivering') && recent(m)) || (m.status === 'queued' && online)));
      const from = inflight.length ? Math.max(0, Math.min(...inflight.map((m) => m.seq)) - 1) : st.after;
      const r = await api(`messages?sessionId=${encodeURIComponent(sid)}&after=${from}`);
      if (sid !== st.session) return;
      const items = r.items || [];
      const known = new Map(st.messages.filter((m) => m.seq <= from || items.some((x) => x.id === m.id)).map((m) => [m.id, m]));
      for (const m of items) known.set(m.id, m);
      st.messages = [...known.values()].sort((a, b) => a.seq - b.seq);
      st.after = st.messages.reduce((n, m) => Math.max(n, m.seq), 0);
      renderLog();
      renderComposer();
    } catch (e) {
      if (e.status === 401) { st.paired = false; startPairing(); }
    } finally { st.polling = false; }
  }

  function schedule() {
    clearTimeout(st.pollTimer);
    const fast = isActive() && document.visibilityState === 'visible';
    st.pollTimer = setTimeout(async () => {
      if (st.mode === 'paired') {
        if (fast && Date.now() - st.sessionsAt >= SESSIONS_MS) await loadSessions(); else await poll();
      } else if ((st.mode === 'init' || st.mode === 'error') && fast) await loadSessions();
      schedule();
    }, fast ? FAST_MS : SLOW_MS);
  }

  async function send() {
    const input = $('claudeChatInput');
    const text = input.value.trim();
    const s = current();
    if (!text || st.sending || !s || !s.online) return;
    st.sending = true;
    renderComposer();
    try {
      const r = await api('send', { sessionId: st.session, text });
      input.value = '';
      st.draft = '';
      if (!st.messages.some((m) => m.id === r.item.id)) { st.messages.push(r.item); st.messages.sort((a, b) => a.seq - b.seq); st.after = Math.max(st.after, r.item.seq); }
      renderLog(true);
    } catch (e) {
      setNote(e.status === 409 ? OFFLINE : `Could not send: ${e.message}`, true);
      if (e.status === 409) loadSessions();
    } finally { st.sending = false; renderComposer(); }
  }

  async function remove(id) {
    const leased = st.messages.find((m) => m.id === id)?.status === 'delivering';
    try {
      await api('messages/delete', { id });
      st.messages = st.messages.filter((m) => m.id !== id);
      renderLog();
    } catch (e) {
      // A message still sending is held by the bridge's lease (up to 60 s); once that runs out it is queued and deletable.
      const busy = leased ? 'Still being delivered — try again in a moment.' : 'That message was already picked up, so it cannot be deleted.';
      setNote(e.status === 409 ? busy : `Could not delete: ${e.message}`, true);
      poll();
    }
  }

  // ---- Devices ----
  async function loadDevices() {
    try { st.devices = (await api('devices')).items || []; } catch (e) { if (e.status === 401) { startPairing(); return; } st.devices = []; }
    renderDevices();
  }
  async function revoke(id) {
    try { await api('devices/revoke', { id }); } catch (e) { setNote(`Could not revoke: ${e.message}`, true); return; }
    const was = st.devices.find((d) => d.id === id);
    if (was?.current) { st.mode = 'pair'; st.paired = false; st.sessions = []; st.session = ''; st.messages = []; st.after = 0; startPairing(); }
    else loadDevices();
  }

  // ---- Rendering ----
  function setNote(text, bad) {
    const n = $('claudeChatNotice');
    if (!n) return;
    n.textContent = text || '';
    n.hidden = !text;
    n.classList.toggle('bad', !!bad);
  }

  function renderPair() {
    const root = $('claudeChat');
    root.replaceChildren();
    root.dataset.mode = 'pair';
    const box = el('div', 'claude-chat-pair');
    box.id = 'claudeChatPair';
    box.append(el('h2', null, 'Chat with Claude Code'), el('p', 'meta', 'Pair this device once to message your Mac sessions from here.'));
    if (st.pairError) {
      box.append(el('p', 'claude-chat-error', st.pairError));
      const retry = el('button', 'btn-outline', 'Try again'); retry.type = 'button'; retry.dataset.chatAction = 'pair';
      box.append(retry);
    } else if (st.pair?.expired) {
      box.append(el('p', 'claude-chat-error', 'That code expired.'));
      const again = el('button', 'btn-primary', 'Get a new code'); again.type = 'button'; again.dataset.chatAction = 'pair';
      box.append(again);
    } else {
      const code = el('div', 'claude-chat-code', st.pair ? st.pair.code : '…');
      code.id = 'claudeChatCode';
      box.append(el('p', 'meta', 'Your pairing code'), code, el('p', 'meta', 'On your Mac, run:'));
      const cmd = el('div', 'claude-chat-cmd');
      cmd.append(el('code', null, st.pair ? `localai-chat pair ${st.pair.code}` : '…'));
      const copy = el('button', 'btn-outline', 'Copy'); copy.type = 'button'; copy.dataset.chatAction = 'copy';
      cmd.append(copy);
      box.append(cmd, el('p', 'meta claude-chat-wait', st.pair ? 'Waiting for approval… this page switches over by itself.' : 'Requesting a code…'));
    }
    if (location.protocol === 'http:') {
      if (st.secureOk) {
        const go = el('a', 'btn-primary claude-chat-secure', 'Open the secure address');
        go.href = `${SECURE_URL}#claude`;
        box.append(el('p', 'meta', 'This device trusts the secure address. If it was paired there, chat works there right away.'), go);
      }
      box.append(el('p', 'banner banner--attention claude-chat-warning', HTTP_WARNING));
    }
    root.append(box);
    st.built = 'pair';
  }

  function buildPaired() {
    const root = $('claudeChat');
    root.replaceChildren();
    root.dataset.mode = 'paired';
    const head = el('div', 'claude-chat-head');
    head.append(el('h2', null, 'Chat'));
    const sel = el('select'); sel.id = 'claudeChatSession'; sel.setAttribute('aria-label', 'Claude Code session');
    head.append(sel);
    const state = el('span', 'pill'); state.id = 'claudeChatState';
    head.append(state);
    const log = el('div', 'claude-chat-log'); log.id = 'claudeChatLog'; log.setAttribute('aria-live', 'polite');
    const notice = el('div', 'claude-chat-notice'); notice.id = 'claudeChatNotice'; notice.hidden = true; notice.setAttribute('role', 'status');
    const composer = el('div', 'claude-chat-composer');
    const input = el('textarea'); input.id = 'claudeChatInput'; input.rows = 3; input.setAttribute('aria-label', 'Message to Claude');
    input.placeholder = 'Message Claude (Cmd/Ctrl+Enter to send)';
    const sendBtn = el('button', 'btn-primary', 'Send'); sendBtn.id = 'claudeChatSend'; sendBtn.type = 'button';
    composer.append(input, sendBtn);
    const hint = el('p', 'meta claude-chat-hint'); hint.id = 'claudeChatHint';
    const note = el('p', 'meta claude-chat-note', NOTE);
    const dev = el('details', 'claude-chat-devices'); dev.id = 'claudeChatDevices';
    dev.append(el('summary', null, 'Paired devices'), el('div', 'claude-chat-devlist'));
    root.append(head, log, notice, composer, hint, note, dev);
    input.addEventListener('input', () => { st.draft = input.value; renderComposer(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
    sendBtn.addEventListener('click', send);
    sel.addEventListener('change', () => {
      st.session = sel.value; store.set(st.session); st.messages = []; st.after = 0; renderLog(true); renderComposer(); poll();
    });
    dev.addEventListener('toggle', () => { st.devicesOpen = dev.open; if (dev.open) loadDevices(); });
    st.built = 'paired';
  }

  function renderSessions() {
    const sel = $('claudeChatSession');
    if (!sel) return;
    const want = st.sessions.map((s) => `${s.sessionId}|${s.title}|${s.online}`).join('\n') + `#${st.session}`;
    if (sel.dataset.sig === want) return;
    sel.dataset.sig = want;
    sel.replaceChildren();
    if (!st.sessions.length) { const o = el('option', null, 'No sessions yet'); o.value = ''; sel.append(o); }
    for (const s of st.sessions) {
      const o = el('option', null, `${s.online ? '● ' : '○ '}${s.title || s.sessionId}${s.cwd ? ' — ' + String(s.cwd).split('/').filter(Boolean).pop() : ''}`);
      o.value = s.sessionId;
      sel.append(o);
    }
    sel.value = st.session;
  }

  function renderMessage(m) {
    const row = el('div', `claude-chat-msg ${m.source === 'reply' ? 'reply' : m.source === 'web' ? 'web' : 'terminal'}`);
    row.dataset.id = m.id;
    const who = m.source === 'reply' ? 'Claude' : m.source === 'web' ? `Web · ${m.deviceName || 'this device'}` : 'Terminal';
    const meta = el('div', 'claude-chat-meta');
    meta.append(el('span', 'claude-chat-who', who), el('span', 'claude-chat-at', m.at ? when(new Date(m.at).getTime()) : ''));
    row.append(meta, el('div', 'claude-chat-text', m.text));
    if (m.truncated) row.append(el('div', 'meta', 'Truncated: the message was longer than 50,000 characters.'));
    if (m.source === 'web') {
      const foot = el('div', 'claude-chat-foot');
      // Queued, or still sending (its bridge may have vanished mid-delivery), on an offline session: it will not arrive
      // until the session is resumed, so offer to delete it rather than let it run unexpectedly later.
      const offline = (m.status === 'queued' || m.status === 'delivering') && current() && !current().online;
      foot.append(el('span', `claude-chat-status ${offline ? 'bad' : m.status}`, offline ? 'not delivered' : STATUS_LABEL[m.status] || m.status));
      if (m.status === 'queued' || offline) {
        const del = el('button', 'btn-outline', 'Delete'); del.type = 'button'; del.dataset.chatAction = 'delete'; del.dataset.id = m.id;
        foot.append(del);
      }
      row.append(foot);
    }
    return row;
  }

  function renderLog(forceBottom) {
    const log = $('claudeChatLog');
    if (!log) return;
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const sig = st.messages.map((m) => `${m.id}:${m.status}`).join(',') + `|${current()?.online}`;
    if (log.dataset.sig !== sig) {
      log.dataset.sig = sig;
      log.replaceChildren();
      if (!st.session) log.append(el('div', 'empty', 'No sessions yet. Start one on your Mac with `claude-chat`.'));
      else if (!st.messages.length) log.append(el('div', 'empty', 'No messages yet.'));
      for (const m of st.messages) log.append(renderMessage(m));
    }
    if (forceBottom || near) log.scrollTop = log.scrollHeight;
  }

  function renderComposer() {
    const input = $('claudeChatInput'), btn = $('claudeChatSend');
    if (!input) return;
    const s = current(), online = !!s?.online;
    input.disabled = !online;
    btn.disabled = st.sending || !online || !input.value.trim();
    $('claudeChatHint').textContent = s && !online ? OFFLINE : '';
    $('claudeChatHint').hidden = !(s && !online);
    const state = $('claudeChatState');
    state.textContent = !s ? 'no session' : online ? 'online' : 'offline';
    state.classList.toggle('ok', online);
  }

  function renderDevices() {
    const list = document.querySelector('#claudeChatDevices .claude-chat-devlist');
    if (!list) return;
    list.replaceChildren();
    if (!st.devices.length) list.append(el('div', 'empty', 'No paired devices.'));
    for (const d of st.devices) {
      const row = el('div', 'claude-chat-device');
      const info = el('div');
      info.append(el('strong', null, d.name || 'Unnamed device'), el('span', 'meta', `${d.current ? ' · this device' : ''} · seen ${d.lastSeenAt ? when(d.lastSeenAt) : 'never'}`));
      const b = el('button', 'btn-outline', d.current ? 'Revoke this device' : 'Revoke'); b.type = 'button'; b.dataset.chatAction = 'revoke'; b.dataset.id = d.id;
      row.append(info, b);
      list.append(row);
    }
  }

  function render() {
    if (!$('claudeChat')) return;
    if (st.mode === 'pair' || st.mode === 'error') { renderPair(); return; }
    if (st.mode !== 'paired') return;
    if (st.built !== 'paired') buildPaired();
    renderSessions();
    renderLog();
    renderComposer();
    if ($('claudeChatInput').value !== st.draft) $('claudeChatInput').value = st.draft;
  }

  function init() {
    const root = $('claudeChat');
    if (!root) return;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-chat-action]');
      if (!b) return;
      const a = b.dataset.chatAction;
      if (a === 'pair') { st.mode = 'init'; startPairing(); }
      if (a === 'delete') remove(b.dataset.id);
      if (a === 'revoke') revoke(b.dataset.id);
      if (a === 'copy') {
        const text = root.querySelector('.claude-chat-cmd code')?.textContent || '';
        (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => { b.textContent = 'Copied'; }, () => {
          const r = document.createRange(); r.selectNodeContents(root.querySelector('.claude-chat-cmd code')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        });
      }
    });
    const wake = () => { schedule(); if (isActive() && document.visibilityState === 'visible') { if (st.mode === 'init') loadSessions(); else if (st.mode === 'paired') poll(); } };
    new MutationObserver(wake).observe($('claude'), { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', wake);
    st.who = askWho();
    st.who.then(() => { if (st.paired || isActive()) loadSessions(); });
    schedule();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

// ==== integration-hub-v2.js (was loaded at runtime) ====
(() => {
  'use strict';

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];

  const INTEGRATIONS = [
    {
      id: 'n8n', name: 'n8n', tier: 'native', decision: 'Built in', source: 'n8n',
      summary: 'Runs your automations: scheduled tasks, multi-step workflows and connections to other apps.',
      guidance: "After you connect an account or add a public webhook, run n8n's security check (Security audit docs below).",
      actions: [
        { type: 'view', view: 'automations', label: 'Open n8n workflows' },
        { type: 'url', url: 'https://docs.n8n.io/hosting/securing/security-audit/', label: 'Security audit docs' }
      ]
    },
    {
      id: 'comfyui', name: 'ComfyUI', tier: 'native', decision: 'Built in · images', source: 'comfy',
      summary: 'Makes the pictures you ask for, on this computer. Nothing is sent to an outside service.',
      guidance: 'Add-ons for ComfyUI only work from Local AI if they support its API mode; check before installing one.',
      actions: [
        { type: 'view', view: 'create', label: 'Open Images' },
        { type: 'url', url: 'https://docs.comfy.org/custom-nodes/overview', label: 'Custom-node guidance' }
      ]
    },
    {
      id: 'svd', name: 'Stable Video Diffusion', tier: 'extend', decision: 'Not set up',
      summary: 'Would turn a still image into a short video clip. It runs inside ComfyUI once its model is installed.',
      guidance: 'Shows as ready once Local AI finds the model and add-ons it needs in ComfyUI.',
      actions: [{ type: 'view', view: 'create', label: 'Open Images' }]
    },
    {
      id: 'sadtalker', name: 'SadTalker', tier: 'extend', decision: 'Not set up',
      summary: 'Would make a still portrait talk, from a photo and a voice clip. It would run inside ComfyUI.',
      guidance: 'Only worth adding if you need talking portraits; check the add-on is maintained before installing it.',
      actions: [{ type: 'view', view: 'create', label: 'Open Images' }]
    },
    {
      id: 'gridcraft', name: 'GridCraft', tier: 'bridge', decision: 'On the Windows computer', source: 'gridcraft',
      summary: 'Lets Local AI open, check, edit and save spreadsheets on the Windows computer.',
      guidance: 'Works on one request at a time. Nothing leaves your network.',
      actions: [{ type: 'view', view: 'spreadsheets', label: 'Open Spreadsheets' }]
    },
    {
      id: 'artcraft', name: 'ArtCraft', tier: 'bridge', decision: 'On the Windows computer · uses cloud services', source: 'artcraft',
      summary: "An image and video studio. What you type and the pictures you use go to ArtCraft's cloud services and your ArtCraft account, unlike Images, which stays on this computer.",
      guidance: 'Use Images for anything private. What ArtCraft makes is kept in your ArtCraft account, not on this computer.',
      actions: [{ type: 'post', url: '/api/artcraft/open', label: 'Open on the Windows computer', done: 'ArtCraft is opening on the Windows computer', already: "It's already open there" }]
    },
    {
      id: 'penpot', name: 'Penpot', tier: 'bridge', decision: 'Not set up',
      summary: 'A design app Local AI could read and update designs in, if you run your own copy.',
      guidance: 'Its access key is a password: keep it out of screenshots, notes and shared files.',
      actions: [
        { type: 'url', url: 'https://help.penpot.app/technical-guide/getting-started/', label: 'Self-host guide' },
        { type: 'url', url: 'https://help.penpot.app/mcp/', label: 'MCP guide' }
      ]
    },
    {
      id: 'obsidian', name: 'Obsidian', tier: 'bridge', decision: 'Not set up',
      summary: 'Would let Local AI read your Obsidian notes as Sources for a project.',
      guidance: 'It would only read the vault folder you choose, never change it.',
      actions: [{ type: 'view', view: 'projects', label: 'Open Projects' }]
    },
    {
      id: 'huggingface', name: 'Hugging Face', tier: 'bridge', decision: 'For finding models',
      summary: 'Where new AI models come from. You chat in Local AI as usual; Hugging Face is only for finding and downloading models.',
      guidance: 'Before downloading a model, check its licence and that it fits this computer (size and memory).',
      actions: [{ type: 'url', url: 'https://huggingface.co/models', label: 'Browse models' }]
    },
    {
      id: 'photopea', name: 'Photopea', tier: 'utility', decision: 'Outside website',
      summary: 'A free photo editor website, handy for touching up an image you made here.',
      guidance: 'It is a website on the internet: an image you open there leaves your network.',
      actions: [{ type: 'url', url: 'https://www.photopea.com/', label: 'Open Photopea' }]
    },
    {
      id: 'languagetool', name: 'LanguageTool', tier: 'utility', decision: 'Optional',
      summary: 'A grammar and style checker, for when you want a second opinion on writing.',
      guidance: 'If you use it in automations, run your own copy so your text stays private.',
      actions: [{ type: 'url', url: 'https://languagetool.org/', label: 'LanguageTool' }]
    }
  ];

  const ALTERNATIVES = [
    ['Gemini / Nano Banana / ImageFX / Google Flow', 'Cloud images and video', 'Not built in', 'Does what your local models and ComfyUI already do, but in the cloud. Worth adding only if local results fall clearly short.'],
    ['DALL·E 3', 'Cloud images', 'Not built in', 'ComfyUI stays the way pictures are made; a cloud service would only ever be something you switch on yourself.'],
    ['Hugging Chat / Hugging Face Chat', 'Cloud chat', 'Skip', 'Local AI is already your chat. Hugging Face is more useful here as the place models come from.'],
    ['Meta AI / You.com', 'Cloud assistants and search', 'Skip', 'They do what Chat and Research do, and would split your history and send your questions outside.'],
    ['LMArena / Chatbot Arena', 'Model comparison', 'Reference only', 'Handy for comparing models before you download one; Local AI does not need it to work.'],
    ['Coze / Bardeen', 'Cloud automations and agents', 'Skip', 'n8n and Local AI missions already do this, on this computer and under your control.'],
    ['Pixlr X / Lovart', 'Design and photo apps', 'Skip', 'Photopea and Penpot cover photo editing and design with less overlap.'],
    ['Laxis', 'Meeting notes', 'Skip for now', 'Recording meetings is not something Local AI does, and this would send them to the cloud.'],
    ['Google Slides', 'Presentations', 'Later', 'Better that Local AI learns to export slides than ties itself to one office suite.'],
    ['10Web', 'Website builder', 'Skip', 'For a website, the developer pages in Local AI fit better.'],
    ['Icons8', 'Icons and pictures', 'Reference only', 'A good place to find icons and pictures; nothing to connect.']
  ];

  function tierBadge(tier) {
    const labels = { native: 'Built in', extend: 'Add-on', bridge: 'Connects to', utility: 'Outside' };
    return `<span class="ux-int-tier ${tier}">${labels[tier] || tier}</span>`;
  }

  function navigate(view) {
    const button = q(`.navbtn[data-view="${CSS.escape(view)}"]`);
    if (button) {
      button.click();
      return;
    }
    const target = q(`#${CSS.escape(view)}`);
    if (!target) return;
    qa('.view').forEach(item => item.classList.toggle('active', item === target));
  }

  function actionHtml(item, action) {
    if (action.type === 'url') {
      return `<a class="btn-outline ux-int-action" data-external="true" href="${action.url}" target="_blank" rel="noopener noreferrer" aria-label="${action.label} for ${item.name} (opens external site)">${action.label} ↗</a>`;
    }
    if (action.type === 'post') {
      return `<button class="btn-outline ux-int-action" type="button" data-integration-post="${item.id}">${action.label}</button>`;
    }
    if (action.type === 'page') {
      return `<a class="btn-outline ux-int-action" href="${action.url}">${action.label}</a>`;
    }
    return `<button class="btn-outline ux-int-action" type="button" data-integration-view="${action.view}">${action.label}</button>`;
  }

  function renderCards() {
    const holder = q('#uxIntegrationCardsV2');
    if (!holder) return;
    holder.innerHTML = INTEGRATIONS.map(item => {
      const actions = item.actions.map(action => actionHtml(item, action)).join('');
      const live = item.source
        ? `<span class="ux-int-live" data-integration-source-v2="${item.source}"><span class="dot"></span> Checking</span>`
        : '<span class="ux-int-live neutral"><span class="dot"></span> Not verified</span>';
      return `<article class="ux-int-card" data-tier="${item.tier}" aria-labelledby="ux-int-v2-${item.id}">
        <div class="ux-int-card-head"><div><div class="ux-int-name" id="ux-int-v2-${item.id}">${item.name}</div><div class="ux-int-decision">${item.decision}</div></div>${tierBadge(item.tier)}</div>
        <p>${item.summary}</p>
        <div class="ux-int-guidance">${item.guidance}</div>
        <div class="ux-int-card-foot">${live}<div class="ux-int-actions">${actions}</div></div>
      </article>`;
    }).join('');
    qa('[data-integration-view]', holder).forEach(button => button.addEventListener('click', () => navigate(button.dataset.integrationView)));
    qa('[data-integration-post]', holder).forEach(button => button.addEventListener('click', () => postAction(button)));
  }

  // An action that asks the appliance to do something (open ArtCraft on the Windows computer), then says what happened.
  async function postAction(button) {
    const action = INTEGRATIONS.find(item => item.id === button.dataset.integrationPost)?.actions.find(a => a.type === 'post');
    if (!action || button.disabled) return;
    const say = text => window.LocalAIUI?.toast(text);
    button.disabled = true;
    try {
      const response = await fetch(action.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      say(data.alreadyRunning ? action.already : action.done);
      window.setTimeout(loadStatus, 3000);
    } catch (error) {
      say(`That didn't work. ${error.message || error}`);
    } finally {
      button.disabled = false;
    }
  }

  function renderAlternatives() {
    const holder = q('#uxIntegrationAlternativesV2');
    if (!holder) return;
    holder.innerHTML = ALTERNATIVES.map(([name, type, decision, reason]) =>
      `<div class="ux-int-row"><div><strong>${name}</strong><span>${type}</span></div><div class="ux-int-row-decision">${decision}</div><p>${reason}</p></div>`
    ).join('');
  }

  function updateService(source, service) {
    const element = q(`[data-integration-source-v2="${source}"]`);
    if (!element) return;
    const state = service?.state || 'UNKNOWN';
    const optional = service?.displayState === 'OPTIONAL_OFFLINE';
    element.className = `ux-int-live ${String(state).toLowerCase()}`;
    const label = service?.label || (optional ? 'Optional offline' : state === 'HEALTHY' ? 'Healthy' : state === 'DOWN' ? 'Down' : state === 'DEGRADED' ? 'Degraded' : 'Status unavailable');
    element.innerHTML = `<span class="dot ${optional ? '' : state}"></span> `;
    element.append(label); // ArtCraft's label carries a version string from the Windows computer
  }

  function setBusy(busy) {
    const button = q('#uxIntegrationRefreshV2');
    if (!button) return;
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
    button.textContent = busy ? 'Checking…' : 'Check again';
  }

  async function loadStatus() {
    if (loadStatus.pending) return loadStatus.pending;
    const task = (async () => {
      const summary = q('#uxIntegrationStatusSummaryV2');
      const checked = q('#uxIntegrationLastCheckedV2');
      if (summary) summary.textContent = 'Checking local services…';
      if (checked) checked.textContent = '';
      setBusy(true);
      try {
        // Each check gives up after 8 s, so one slow bridge (GridCraft on the host) can't leave the page on "Checking…".
        const timed = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined);
        const results = await Promise.allSettled([
          fetch('/api/status', { cache: 'no-store', signal: timed() }),
          fetch('/api/capabilities', { cache: 'no-store', signal: timed() }),
          fetch('/api/gridcraft/health', { cache: 'no-store', signal: timed() }),
          fetch('/api/artcraft/status', { cache: 'no-store', signal: timed() })
        ]);
        const artcraft = results[3].status === 'fulfilled' ? await results[3].value.json().catch(() => null) : null;
        updateService('artcraft', !artcraft?.ok ? { state: 'NEUTRAL', label: 'Windows computer not answering' }
          : artcraft.running ? { state: 'HEALTHY', label: `Open now${artcraft.version ? ` · ${artcraft.version}` : ''}` }
            : artcraft.installed ? { state: 'NEUTRAL', label: `Installed, not open${artcraft.version ? ` · ${artcraft.version}` : ''}` }
              : { state: 'DOWN', label: 'Not installed' });
        const gridcraft = results[2].status === 'fulfilled' ? await results[2].value.json().catch(() => null) : null;
        updateService('gridcraft', gridcraft?.ok
          ? { state: gridcraft.gridcraftConnected ? 'HEALTHY' : 'DEGRADED' }
          : { state: 'DOWN', displayState: 'OPTIONAL_OFFLINE' });
        let status = null;
        let capabilities = null;
        if (results[0].status === 'fulfilled' && results[0].value.ok) status = await results[0].value.json();
        if (results[1].status === 'fulfilled' && results[1].value.ok) capabilities = await results[1].value.json();

        const services = Array.isArray(status?.services) ? status.services : [];
        updateService('n8n', services.find(service => service.name === 'n8n'));
        updateService('comfy', services.find(service => service.name === 'comfy'));

        if (status) {
          const healthy = services.filter(service => ['n8n', 'comfy'].includes(service.name) && service.state === 'HEALTHY').length;
          q('#uxIntegrationNativeCountV2').textContent = `${healthy}/2`;
          summary.textContent = healthy === 2 ? 'Both core services are working.' : healthy === 1 ? 'One core service needs attention.' : 'The core services need attention.';
        } else {
          q('#uxIntegrationNativeCountV2').textContent = '—';
          summary.textContent = 'Live status is unavailable; what each service is for is unchanged.';
        }

        q('#uxIntegrationMediaStateV2').textContent = capabilities
          ? capabilities?.images?.available === true ? 'Ready' : 'No supported model'
          : 'Status only';
        checked.textContent = `Checked ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      } catch {
        if (summary) summary.textContent = 'Could not check the services.';
        if (checked) checked.textContent = 'Status request failed';
      } finally {
        setBusy(false);
      }
    })();
    loadStatus.pending = task;
    try { return await task; }
    finally { loadStatus.pending = null; }
  }

  function mount() {
    const section = q('#integrations');
    if (!section || section.dataset.integrationV2 === 'true') return Boolean(section);
    section.dataset.integrationV2 = 'true';
    section.innerHTML = `
      <div class="topbar"><div><h1>Services</h1><p class="sub">What Local AI connects to, how each one is doing, and what each one is for.</p></div><button class="btn-outline" type="button" id="uxIntegrationRefreshV2" aria-busy="false">Check again</button></div>
      <div class="card ux-int-hero ux-int-v2"><div><h2>Connected services</h2><p id="uxIntegrationStatusSummaryV2" role="status" aria-live="polite">Checking local services…</p><span id="uxIntegrationLastCheckedV2" class="ux-int-checked"></span></div><div class="ux-int-metrics"><div><b id="uxIntegrationNativeCountV2">—</b><span>core services healthy</span></div><div><b id="uxIntegrationMediaStateV2">—</b><span>image and media</span></div><div><b>Opt-in</b><span>cloud and outside services</span></div></div></div>
      <div class="section-head ux-int-section-head"><div><h2>What each one does</h2><p>What it is for here, and whether it is ready.</p></div></div><div id="uxIntegrationCardsV2" class="ux-int-grid"></div>
      <details class="ux-int-about"><summary>How services are chosen</summary><div class="card ux-int-policy"><div><h2>What gets built in</h2></div><div class="ux-int-policy-grid"><div><strong>1. On this computer first</strong><span>Ollama, n8n and ComfyUI do the work by default, so nothing leaves your network.</span></div><div><strong>2. One service per job</strong><span>No second chat, automation or image service that would split your history in two.</span></div><div><strong>3. A connection has to be worth it</strong><span>Penpot and Obsidian would share real designs and notes with Local AI, not just open another tab.</span></div><div><strong>4. The cloud only when you choose it</strong><span>Accounts and uploads to outside services happen only when you set them up yourself.</span></div></div></div>
      <div class="card ux-int-research"><div><h2>Safeguards</h2></div><div class="ux-int-research-grid"><div><strong>n8n security check</strong><span>Run it after you connect an account, add a community add-on or a public webhook. It checks accounts, data, files and add-ons.</span><a data-external="true" href="https://docs.n8n.io/hosting/securing/security-audit/" target="_blank" rel="noopener noreferrer" aria-label="n8n security check guidance (opens external site)">Official guidance ↗</a></div><div><strong>ComfyUI add-ons</strong><span>Some add-ons only work in ComfyUI's own window, not when Local AI asks for an image. Check before you rely on one.</span><a data-external="true" href="https://docs.comfy.org/custom-nodes/overview" target="_blank" rel="noopener noreferrer" aria-label="ComfyUI add-on guidance (opens external site)">Add-on guidance ↗</a></div><div><strong>Penpot on your own server</strong><span>Penpot can run at home and let Local AI read and update designs. Its access key is a password and never goes into the page.</span><a data-external="true" href="https://help.penpot.app/mcp/" target="_blank" rel="noopener noreferrer" aria-label="Penpot connection guidance (opens external site)">Penpot guide ↗</a></div></div></div>
      <div class="card ux-int-next"><div><h2>Planned next</h2></div><div class="ux-int-next-grid"><div><b>Shipped</b><strong>Live n8n and ComfyUI health</strong><span>This page checks both every time you open it.</span></div><div><b>Next</b><strong>Video and talking portraits</strong><span>Show Stable Video Diffusion and SadTalker as ready once their models are installed in ComfyUI.</span></div><div><b>Next</b><strong>Obsidian notes as Sources</strong><span>Pick a notes folder and add its files to a project's Sources, each with where it came from.</span></div><div><b>Opt-in</b><strong>Penpot connection</strong><span>Connect your own Penpot without its access key ever reaching the browser.</span></div></div></div>
      </details>
      <details class="ux-int-reviewed"><summary>Reviewed alternatives <span>${ALTERNATIVES.length} services kept out on purpose</span></summary><div class="section-head ux-int-section-head"><div><h2>Reviewed, not added</h2><p>Some are useful on their own, but none earns a place inside Local AI today.</p></div></div><div id="uxIntegrationAlternativesV2" class="ux-int-table"></div></details>`;

    renderCards();
    renderAlternatives();
    q('#uxIntegrationRefreshV2')?.addEventListener('click', loadStatus);
    loadStatus();

    const observer = new MutationObserver(() => {
      if (section.classList.contains('active')) window.setTimeout(loadStatus, 75);
    });
    observer.observe(section, { attributes: true, attributeFilter: ['class'] });
    return true;
  }

  function init() {
    if (mount()) return;
    const observer = new MutationObserver(() => {
      if (mount()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

// ==== execution-runtime.js (was loaded at runtime) ====
(() => {
  'use strict';

  const state = { inerted: [], opener: null, runs: [], selectedId: null, timer: 0, loading: false, drawerSig: '', projects: null, viewError: '', fetched: null, gap: '', pending: null, inApp: false, closing: false };
  const KINDS = { chat: ['Chat', 'compose'], research: ['Research', 'globe'], image: ['Image', 'image'], agent: ['Mission', 'automate'], automation: ['Automation', 'refresh'], engineering: ['Change', 'build'] };
  // Home starts a run by mode name; a run not yet reported is labelled by the kind that mode becomes.
  const MODE_KINDS = { ask: 'chat', create: 'image', mission: 'agent' };
  const kindOf = (kind) => MODE_KINDS[kind] || kind;
  const kindLabel = (kind) => (KINDS[kindOf(kind)] || ['Run'])[0];
  const lookup = (id) => state.runs.find((item) => item.id === id) || (state.fetched?.id === id ? state.fetched : null);
  const ACTIVE = new Set(['queued', 'running', 'streaming', 'awaiting_approval']);

  function el(id) { return document.getElementById(id); }
  function active(run) { return ACTIVE.has(run?.status); }
  function safeDate(value) {
    const date = new Date(value || 0);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function statusLabel(status) {
    return ({ queued: 'Queued', running: 'Running', streaming: 'Streaming', awaiting_approval: 'Awaiting approval', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' })[status] || status || 'Unknown';
  }
  // A time the run view shows: a missing or invalid one is a dash, never the 1969 epoch.
  function shownDate(value) { return value ? (safeDate(value)?.toLocaleString() || '—') : '—'; }
  function outputText(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  function drawerSignature(run) {
    return run ? [run.id, run.status, run.updatedAt, run.progress, outputText(run.output).length, run.error || '', run.pinned ? 1 : 0, run.kept ? 1 : 0, run.projectId || '', run.card?.approval?.id || '', Array.isArray(run.events) ? run.events.length : 0].join('|') : '';
  }


  function activateRunsView() {
    const view = el('runs');
    if (!view) return;
    if (window.LocalAIRouter?.open) { window.LocalAIRouter.open('runs'); window.scrollTo({ top: 0, behavior: 'auto' }); return; }   // a person opened it: Back returns
    document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item === view));
    document.querySelectorAll('.navbtn[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === 'runs'));
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function ensureSurface() {
    const main = document.querySelector('main');
    if (!main) return;

    if (!el('runs')) {
      const section = document.createElement('section');
      section.id = 'runs';
      section.className = 'view';
      section.innerHTML = `
        <div class="topbar"><div><h1>Runs</h1><p class="sub">Every run: chats, images, missions, automations and changes.</p></div><button id="runsRefresh" type="button" class="btn-outline">Refresh</button></div>
        <div id="runMetrics" class="run-summary-grid"></div>
        <div class="card" style="margin-top:12px"><div class="section-head"><div><h2>All runs</h2><p>Open a run to see what happened, its result, and to cancel or retry it.</p></div></div><div id="runList" class="run-list"><div class="empty-state">Loading runs…</div></div></div>`;
      main.appendChild(section);
      el('runsRefresh')?.addEventListener('click', () => loadRuns(true));
    }

    if (!document.querySelector('.navbtn[data-view="runs"]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'navbtn';
      button.dataset.view = 'runs';
      button.textContent = 'Runs';
      button.addEventListener('click', () => { activateRunsView(); loadRuns(true); });
      const activityButton = document.querySelector('.navbtn[data-view="activity"]');
      if (activityButton?.parentElement) activityButton.parentElement.insertBefore(button, activityButton);
      else document.querySelector('nav')?.appendChild(button);
    }

    if (!el('homeRunCenter')) {
      const home = el('home');
      if (home) {
        const panel = document.createElement('section');
        panel.id = 'homeRunCenter';
        panel.className = 'card home-run-center';
        panel.hidden = true;
        panel.innerHTML = '<div class="section-head"><div><h2>Runs</h2><p id="homeRunSummary">Checking what is running…</p></div><button id="homeRunsOpen" type="button" class="btn-outline">View runs</button></div><div id="homeRunList" class="run-list"></div>';
        const attention = el('truthAttention');
        if (attention?.parentNode === home) attention.insertAdjacentElement('afterend', panel);
        else home.prepend(panel);
        el('homeRunsOpen')?.addEventListener('click', () => { activateRunsView(); loadRuns(true); });
      }
    }

    if (!el('runDrawerBackdrop')) {
      const backdrop = document.createElement('div');
      backdrop.id = 'runDrawerBackdrop';
      backdrop.className = 'run-drawer-backdrop';
      backdrop.setAttribute('aria-hidden', 'true');
      backdrop.innerHTML = '<aside id="runDrawer" class="run-drawer" role="dialog" aria-modal="true" aria-labelledby="runDrawerTitle"></aside><dialog id="runDetailsSheet" class="run-details-sheet" aria-labelledby="runDetailsTitle"></dialog><div id="runLiveRegion" class="run-live-region" aria-live="polite"></div>';
      document.body.appendChild(backdrop);
      backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeRunView(); });
      const dlg = el('runDetailsSheet');
      dlg.addEventListener('click', (event) => { if (event.target === dlg) dlg.close(); });   // the dimmed area outside the sheet
      document.addEventListener('click', (event) => { if (!event.target.closest?.('.run-menu, #runMoreBtn')) closeMenu(); });
    }
  }

  // Every run is one shared card (components.js); clicking it or its action opens the run view.
  function makeRunRow(run) {
    return window.LocalAIUI.runCard(run, { onOpen: (item) => openRun(item.id) });
  }

  function render() {
    ensureSurface();
    const runs = state.runs;
    const activeRuns = runs.filter(active);
    const failed = runs.filter((run) => run.status === 'failed');
    const completed = runs.filter((run) => run.status === 'completed');
    const awaiting = runs.filter((run) => run.status === 'awaiting_approval');

    const metrics = el('runMetrics');
    if (metrics) {
      metrics.innerHTML = `<div class="run-metric"><b>${activeRuns.length}</b><span>Active</span></div><div class="run-metric"><b>${awaiting.length}</b><span>Awaiting approval</span></div><div class="run-metric"><b>${failed.length}</b><span>Failed in history</span></div><div class="run-metric"><b>${completed.length}</b><span>Completed in history</span></div>`;
    }

    const list = el('runList');
    if (list) {
      list.replaceChildren();
      if (!runs.length) list.innerHTML = '<div class="empty-state">No runs yet.</div>';
      else runs.forEach((run) => list.appendChild(makeRunRow(run)));
    }

    const homeList = el('homeRunList');
    const homeSummary = el('homeRunSummary');
    if (homeList && homeSummary) {
      homeList.replaceChildren();
      // Home shows only live or waiting runs; finished ones are already listed under Recent work and in System › Runs.
      const visible = [...activeRuns, ...awaiting.filter((run) => !activeRuns.includes(run))].slice(0, 4);
      const panel = el('homeRunCenter');
      if (panel) panel.hidden = !visible.length;
      homeSummary.textContent = activeRuns.length
        ? `${activeRuns.length} ${activeRuns.length === 1 ? 'run is' : 'runs are'} active now.`
        : `${awaiting.length} ${awaiting.length === 1 ? 'run is' : 'runs are'} waiting for approval.`;
      visible.forEach((run) => homeList.appendChild(makeRunRow(run)));
    }

    if (state.fetched && state.fetched.id === state.selectedId) {   // a run older than the list: keep it fresh on its own
      if (runs.some((run) => run.id === state.fetched.id)) state.fetched = null;
      else if (active(state.fetched)) fetchRun(state.selectedId, true);
    }
    if (state.selectedId && el('runDrawerBackdrop')?.classList.contains('show') && !state.gap && !state.pending && drawerSignature(lookup(state.selectedId)) !== state.drawerSig) renderDrawer(state.selectedId);
  }

  function iconBtn(name, label, id) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'icon-btn'; b.setAttribute('aria-label', label); if (id) b.id = id;
    b.innerHTML = window.LocalAIKit?.icon(name) || ''; return b;
  }
  // Header: Back, title, subtitle, and (for a loaded run) Details and More.
  function viewHead(title, sub, run) {
    const head = document.createElement('div'); head.className = 'run-drawer-head';
    const back = iconBtn('chevron-left', 'Back'); back.addEventListener('click', closeRunView);
    const copy = document.createElement('div'); copy.className = 'run-drawer-copy';
    const t = document.createElement('h2'); t.id = 'runDrawerTitle'; t.className = 'run-drawer-title'; t.textContent = title; t.title = title;   // desktops: the full text is on hover
    // Phones clamp it to two lines and have no hover: a tap (or Enter) opens the whole title, a second one folds it; aria-expanded says which.
    if (matchMedia('(max-width:760px)').matches) {
      t.setAttribute('role', 'button'); t.tabIndex = 0; t.setAttribute('aria-expanded', 'false');
      const flip = () => { const open = t.classList.toggle('is-open'); t.setAttribute('aria-expanded', String(open)); };
      t.addEventListener('click', flip); t.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    }
    const s = document.createElement('div'); s.className = 'run-drawer-sub'; if (typeof sub === 'string') s.textContent = sub; else s.append(...sub);
    copy.append(t, s); head.append(back, copy);
    if (run) {
      // ☆ Keep: Library holds only what you keep (owner decision, 18 Oct). A chat or research run says whether it is kept.
      if (typeof run.kept === 'boolean') head.appendChild(keepButton(run));
      const info = iconBtn('info', 'Details', 'runDetailsBtn'); info.addEventListener('click', openDetails);
      const more = iconBtn('more', 'More', 'runMoreBtn'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
      const menu = document.createElement('div'); menu.className = 'run-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
      const item = (label, ok, fn) => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.textContent = label; b.disabled = !ok; b.addEventListener('click', () => { closeMenu(); fn(b); }); return b; };
      menu.append(item('Cancel run', !!run.cancellable && active(run), (b) => cancelRun(run.id, b)), item('Retry', !!run.retryable, (b) => retryRun(run.id, b)));
      more.addEventListener('click', () => { const open = menu.hidden; closeMenu(); if (open) { menu.hidden = false; more.setAttribute('aria-expanded', 'true'); menu.querySelector('button:not(:disabled)')?.focus(); } });
      head.append(info, more, menu);
    }
    return head;
  }
  function closeMenu() { const m = document.querySelector('.run-menu'); if (m && !m.hidden) { m.hidden = true; el('runMoreBtn')?.setAttribute('aria-expanded', 'false'); return true; } return false; }
  function stateBlock(kind, lines) {   // a centred message: Starting…, Loading…, not available
    const box = document.createElement('div'); box.className = 'run-view-state';
    const ico = document.createElement('span'); ico.className = 'run-view-state__icon'; ico.innerHTML = window.LocalAIKit?.icon(kind) || ''; box.appendChild(ico);
    lines.forEach((node) => box.appendChild(node)); return box;
  }
  const textNode = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; };

  function renderDrawer(runId = state.selectedId) {
    const drawer = el('runDrawer');
    if (!drawer) return;
    const run = lookup(runId);
    // A body that can update in place keeps its slot while the same run is re-rendered; scroll and focus stay where they were.
    const kind = run ? (run.card?.kind || run.type) : '', prev = state.body, upd = window.LocalAIUI.runBodyUpdateFor?.(kind);
    const keep = !!(run && prev && prev.runId === run.id && prev.kind === kind && upd && prev.slot.isConnected && drawer.contains(prev.slot));
    const keepTop = drawer.scrollTop, focused = keep && prev.slot.contains(document.activeElement) ? document.activeElement : null;
    const lost = focusSpot();   // the header and sections are rebuilt: remember what had focus so its equivalent gets it back
    if (keep) prev.slot.remove(); else { window.LocalAIRunBodies?.release?.(); state.body = null; }   // a body that borrowed page elements gives them back before the view is rebuilt
    drawer.replaceChildren();
    el('runDetailsSheet').replaceChildren();
    state.drawerSig = drawerSignature(run);
    if (!run) { renderGap(drawer); if (lost) refocus(lost); return; }   // Starting…/Loading… is rebuilt too (the router re-renders it): keep focus in the view
    const card = run.card, kit = window.LocalAIKit;
    // The header names the project only once the run is filed in one (E2): an unfiled run says nothing about it.
    const sub = [kindLabel(card?.kind || run.type)];
    if (run.projectId) {
      const project = document.createElement('span'); project.className = 'run-view-project';
      project.textContent = !state.projects ? 'Filed' : (state.projects.find((p) => p.id === run.projectId)?.name || 'Project removed');
      sub.push(' · ', project);
    }
    const runTitle = run.threadTitle || run.title || 'Untitled run';   // a conversation keeps its first message as its name
    drawer.appendChild(viewHead(runTitle, sub, run));
    document.title = `${runTitle} · Local AI`;   // browser history names the run (E8); showView sets the page's title back

    // Status badge, then a progress bar while the run is live.
    const vh = document.createElement('div'); vh.className = 'run-view-head';
    const badge = card?.badge || kit?.statusBadge(run.status) || { label: statusLabel(run.status), tone: 'neutral' };
    const chip = document.createElement('span'); chip.className = `badge badge--${badge.tone}`; chip.textContent = badge.label;
    vh.appendChild(chip); drawer.appendChild(vh);
    if (active(run)) {
      const pct = Math.max(0, Math.min(100, Number(run.progress) || 0));
      const bar = document.createElement('div'); bar.className = 'run-card__bar run-view-bar'; bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', 'Progress');
      bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(pct));
      const fill = document.createElement('span'); fill.style.setProperty('--progress', `${pct}%`); bar.appendChild(fill); drawer.appendChild(bar);
    }
    if (state.viewError) drawer.appendChild(errorBox());
    if (card?.approval) drawer.appendChild(approvalBar(card.approval));

    if (run.summary) appendSection(drawer, 'Summary', run.summary);
    if (run.error) appendSection(drawer, 'Error', run.error);
    // The kind body slot: a body registered for this kind owns it; otherwise the Output block.
    const mount = window.LocalAIUI.runBodyFor(kind);
    if (mount) {
      let slot = null;
      if (keep) { let ok = false; try { ok = upd(run, prev.slot) !== false; } catch {} if (ok) { slot = prev.slot; drawer.appendChild(slot); if (focused?.isConnected) focused.focus({ preventScroll: true }); } else { window.LocalAIRunBodies?.release?.(); state.body = null; } }
      if (!slot) {
        slot = document.createElement('section'); slot.className = 'run-section run-body';
        try { mount(run, slot); } catch (error) { slot.textContent = `This run's details could not be shown: ${error.message}`; }
        drawer.appendChild(slot);
      }
      state.body = { runId: run.id, kind, slot };
    } else {
      const output = outputText(run.output);
      if (output) appendSection(drawer, 'Output', output, true);
    }
    fillDetails(run);
    if (keep) drawer.scrollTop = keepTop;
    if (lost) refocus(lost);
  }
  // Focus that survives a rebuild: describe the focused control inside the run view or its sheet, then find its equivalent (id, label, text) in the new content.
  function focusSpot() {
    const a = document.activeElement, box = a && (a.closest('#runDetailsSheet') || a.closest('#runDrawer'));
    if (!box || a === box) return null;
    return { sheet: box.id === 'runDetailsSheet', id: a.id, label: a.getAttribute('aria-label') || '', text: a.textContent.trim(), tag: a.tagName };
  }
  function refocus(spot) {
    if (document.activeElement?.closest?.('#runDrawer, #runDetailsSheet')) return;
    const box = el(spot.sheet && el('runDetailsSheet').open ? 'runDetailsSheet' : 'runDrawer'), all = [...box.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')];
    const to = (spot.id && all.find((n) => n.id === spot.id)) || (spot.label && all.find((n) => n.getAttribute('aria-label') === spot.label)) || (spot.text && all.find((n) => n.tagName === spot.tag && n.textContent.trim() === spot.text)) || all.find((n) => !n.disabled && !n.hidden) || box;
    if (to === box) box.tabIndex = -1;
    to.focus({ preventScroll: true });
  }
  // The page behind a run view is inert (out of the Tab order and hidden from screen readers) while it is open.
  function setInert(on) {
    if (on) { state.inerted = [...document.body.children].filter((n) => !n.inert && n.id !== 'runDrawerBackdrop' && !/^(SCRIPT|STYLE|LINK|SVG|DIALOG|TEMPLATE)$/i.test(n.tagName) && !n.matches('[aria-live], [role="status"], [role="alert"]')); state.inerted.forEach((n) => { n.inert = true; }); }
    else { (state.inerted || []).forEach((n) => { n.inert = false; }); state.inerted = []; }
  }
  // Tab and Shift+Tab cycle inside the top layer: an ask sheet, else the ⓘ sheet, else the run view.
  function trapTab(event) {
    if (event.key !== 'Tab' || !el('runDrawerBackdrop')?.classList.contains('show')) return;
    const box = document.querySelector('dialog.ask-sheet[open]') || (el('runDetailsSheet')?.open ? el('runDetailsSheet') : el('runDrawer'));
    const items = [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled && !n.closest('[hidden], [inert]') && n.getClientRects().length);
    const a = document.activeElement;
    if (!items.length) { event.preventDefault(); return; }
    if (!box.contains(a)) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus(); }
    else if (event.shiftKey && a === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
    else if (!event.shiftKey && a === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
  }
  // Closing returns focus to what opened the run (or that run's row, or the page heading) once the page behind has settled.
  function restoreFocus(opener) {
    const ok = () => document.activeElement && document.activeElement !== document.body && !document.activeElement.closest('#runDrawerBackdrop');
    if (ok()) return;   // page-change code already placed focus
    const shown = (n) => n && n.isConnected && n.getClientRects().length;
    const row = opener.runId && [...document.querySelectorAll('[data-run-id]')].filter((n) => !n.closest('#runDrawerBackdrop') && shown(n)).find((n) => n.dataset.runId === opener.runId);
    const to = shown(opener.el) ? opener.el : row && (row.querySelector('button') || row);
    if (to) { if (!to.matches('button, [href], input, select, textarea, [tabindex]')) to.tabIndex = -1; to.focus(); }
    if (ok()) return;
    const h = [...document.querySelectorAll('h1')].find(shown) || document.querySelector('main, [role="main"]');
    if (h) { h.tabIndex = -1; h.focus(); }
  }
  function errorBox() { const err = document.createElement('div'); err.className = 'run-view-error'; err.setAttribute('role', 'alert'); err.textContent = state.viewError; return err; }

  // Not a loaded run: Starting… (a run being created), Loading…, or why there is nothing to show.
  const pendingText = (p) => `Creating your image… ${Math.floor((Date.now() - p.startedAt) / 1000)} s`;
  function renderGap(drawer) {
    const p = state.pending;
    if (p && !state.gap) {
      drawer.appendChild(viewHead(p.title || 'New run', kindLabel(p.kind)));
      if (p.error) {
        const msg = textNode('status-error', p.error); msg.setAttribute('role', 'alert');
        const btn = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn-outline'; b.textContent = label; b.addEventListener('click', fn); return b; };
        // What to do next: send it again, see why the model isn't answering, or leave it.
        const actions = document.createElement('div'); actions.className = 'run-view-state__actions';
        if (typeof p.retry === 'function') actions.appendChild(btn('Try again', () => { const again = p.retry; state.pending = null; Promise.resolve().then(again).catch(() => {}); }));
        if (/\bmodel\b/i.test(p.error)) actions.appendChild(btn('Open Models', () => window.LocalAIRouter?.go('#models')));   // the router closes the run view, as Open Work does
        actions.appendChild(btn('Close', closeRunView));
        drawer.appendChild(stateBlock((KINDS[kindOf(p.kind)] || [0, 'system'])[1], [msg, actions]));
      } else {
        const spin = document.createElement('span'); spin.className = 'run-spinner'; spin.setAttribute('aria-hidden', 'true');
        // An image is drawn before its run is reported, so its wait is shown honestly: a label and the seconds so far.
        const text = textNode('run-view-state__text', p.kind === 'create' ? pendingText(p) : 'Starting…'); text.setAttribute('role', 'status');
        drawer.appendChild(stateBlock((KINDS[kindOf(p.kind)] || [0, 'system'])[1], [spin, text]));
      }
      return;
    }
    drawer.appendChild(viewHead('Run', ''));
    if (state.gap === 'missing') {
      const open = document.createElement('button'); open.type = 'button'; open.className = 'btn-outline'; open.textContent = 'Open Work'; open.addEventListener('click', () => window.LocalAIRouter?.go('#work'));
      drawer.appendChild(stateBlock('work', [textNode('run-view-state__text', 'This run is no longer available'), open]));
    } else if (state.gap === 'error') {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn-outline'; retry.textContent = 'Try again'; retry.addEventListener('click', () => routeRun(state.selectedId));
      drawer.appendChild(stateBlock('work', [textNode('run-view-state__text', 'This run could not be loaded.'), retry]));
    } else {
      const spin = document.createElement('span'); spin.className = 'run-spinner'; spin.setAttribute('aria-hidden', 'true');
      const text = textNode('run-view-state__text', 'Loading…'); text.setAttribute('role', 'status');
      drawer.appendChild(stateBlock('work', [spin, text]));
    }
  }

  // The ⓘ sheet: Pin, File…, the details grid and the Timeline.
  function fillDetails(run) {
    const sheet = el('runDetailsSheet'), box = document.createElement('div'); box.className = 'run-details-sheet__body';
    const head = document.createElement('div'); head.className = 'run-details-sheet__head';
    const h = document.createElement('h2'); h.id = 'runDetailsTitle'; h.textContent = 'Details';
    const x = iconBtn('x', 'Close details'); x.addEventListener('click', () => sheet.close());
    head.append(h, x); box.appendChild(head);
    if (state.viewError) box.appendChild(errorBox());
    const acts = document.createElement('div'); acts.className = 'run-view-head';
    if (String(run.id).startsWith('legacy-')) {
      const note = document.createElement('span'); note.className = 'run-view-project'; note.textContent = 'Managed on its own page'; acts.appendChild(note);
    } else {
      const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'btn-outline run-act';
      pin.textContent = run.pinned ? 'Unpin' : 'Pin'; pin.setAttribute('aria-pressed', String(!!run.pinned));
      pin.addEventListener('click', () => updateRun(run, { pinned: !run.pinned }, run.pinned ? 'Run unpinned.' : 'Run pinned.'));
      const file = document.createElement('button'); file.type = 'button'; file.className = 'btn-outline run-act'; file.textContent = 'File…';
      file.addEventListener('click', () => fileRun(run));
      acts.append(pin, file);
    }
    box.appendChild(acts);
    const details = document.createElement('div');
    details.className = 'run-detail-grid';
    const values = [
      ['Status', statusLabel(run.status)], ['Progress', `${Math.max(0, Math.min(100, Number(run.progress) || 0))}%`],
      ['Started', shownDate(run.startedAt)], ['Finished', shownDate(run.finishedAt)],
      ['Try', String(run.attempt || 1)], ['Retry of', run.retryOf || '—'], ['Run ID', run.id]
    ];
    values.forEach(([label, value]) => {
      const cell = document.createElement('div'); cell.className = 'run-detail';
      const key = document.createElement('span'); key.textContent = label;
      const text = document.createElement('b'); text.textContent = value;
      cell.append(key, text); details.appendChild(cell);
    });
    box.appendChild(details);

    if (Array.isArray(run.events) && run.events.length) {
      const section = document.createElement('section'); section.className = 'run-section';
      const heading = document.createElement('h3'); heading.textContent = 'Timeline'; section.appendChild(heading);
      const timeline = document.createElement('div'); timeline.className = 'run-timeline';
      run.events.forEach((event) => {
        const row = document.createElement('div'); row.className = 'run-event';
        const marker = document.createElement('span'); marker.className = 'run-event-marker';
        const text = document.createElement('div');
        const detail = document.createElement('div'); detail.className = 'run-event-detail'; detail.textContent = event.detail || statusLabel(event.status);
        const time = document.createElement('div'); time.className = 'run-event-time'; time.textContent = shownDate(event.at);
        text.append(detail, time); row.append(marker, text); timeline.appendChild(row);
      });
      section.appendChild(timeline); box.appendChild(section);
    }
    sheet.appendChild(box);
  }
  function openDetails() {
    const sheet = el('runDetailsSheet'); if (!sheet || sheet.open || !sheet.childElementCount) return;
    const release = window.LocalAIUI.showSheet(sheet, (reopened) => { if (state.detailsRelease === release) state.detailsRelease = null; if (!reopened && state.selectedId) el('runDetailsBtn')?.focus(); });
    state.detailsRelease = release; sheet.querySelector('button')?.focus();
  }

  // Approve and Reject only record a decision, so they are plain confirms (no typed word), whatever the risk.
  function approvalBar(approval) {
    const bar = document.createElement('section'); bar.className = 'run-approval'; bar.setAttribute('aria-label', 'Approval needed');
    const head = document.createElement('div'); head.className = 'run-approval__title'; head.textContent = approval.title || 'Approval needed';
    const tone = { high: 'bad', medium: 'attention' }[approval.risk] || 'neutral';
    const risk = document.createElement('span'); risk.className = `badge badge--${tone}`; risk.textContent = `${approval.risk ? approval.risk[0].toUpperCase() + approval.risk.slice(1) : 'Unknown'} risk`;
    const top = document.createElement('div'); top.className = 'run-view-head'; top.style.marginTop = '0'; top.append(head, risk);
    bar.appendChild(top);
    if (approval.detail) { const d = document.createElement('div'); d.className = 'run-approval__detail'; d.textContent = approval.detail; bar.appendChild(d); }
    const row = document.createElement('div'); row.className = 'run-approval__actions';
    [['Approve', 'approved', 'btn-primary', 'This records your decision.'], ['Reject', 'rejected', 'btn-outline', 'This records your decision. The change stays unapplied.']].forEach(([label, decision, cls, effect]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label;
      b.addEventListener('click', async () => {
        const answer = await window.LocalAIUI.ask({ title: `${label} “${approval.title || 'this request'}”?`, effect, confirmLabel: label, tone: 'default' });
        if (!answer.ok) return;
        b.disabled = true;
        try { await post('/api/approvals/decide', { id: approval.id, decision }); el('runLiveRegion').textContent = decision === 'approved' ? 'Approved.' : 'Rejected.'; await loadRuns(true); }
        catch (error) { viewFail(`Could not record the decision: ${error.message}`); b.disabled = false; }
      });
      row.appendChild(b);
    });
    bar.appendChild(row);
    return bar;
  }

  // Errors show in the run view (and are announced); the next successful action or opening a run clears them.
  function viewFail(message) {
    state.viewError = message; el('runLiveRegion').textContent = message;
    if (state.selectedId && lookup(state.selectedId)) renderDrawer(state.selectedId);
  }
  // The projects list is fetched when a run view opens and again before filing, so a filed run shows its project's name.
  async function loadProjects() {
    try { state.projects = (await window.LocalAIUI.fetchJson('/api/projects')).items || []; return true; } catch { return false; }
  }

  // Pin or file a run. The server answers {item}; keep the list's card and show the change right away.
  async function updateRun(run, patch, done) {
    try {
      const { item } = await post('/api/runs/update', { id: run.id, ...patch });
      const i = state.runs.findIndex((r) => r.id === run.id);
      if (i >= 0) state.runs[i] = { ...state.runs[i], ...item, card: state.runs[i].card };
      state.viewError = ''; el('runLiveRegion').textContent = done;
      render(); if (state.selectedId === run.id) renderDrawer(run.id);
    } catch (error) { viewFail(`Could not update the run: ${error.message}`); }
  }

  function keepButton(run) {
    const b = document.createElement('button'); b.type = 'button'; b.id = 'runKeepBtn'; b.className = 'btn-outline run-keep';
    b.textContent = run.kept ? '★ Kept' : '☆ Keep'; b.setAttribute('aria-pressed', String(!!run.kept));
    b.title = run.kept ? 'In your Library. Tap to take it out; it stays in Work.' : 'Keep this conversation in your Library';
    b.addEventListener('click', () => keepRun(run, !run.kept, b));
    return b;
  }
  // Keep or un-keep the run's whole conversation. Un-keep takes it out of Library only; the runs stay in Work.
  async function keepRun(run, kept, button) {
    if (button) button.disabled = true;
    try {
      await post('/api/library/keep', { runId: run.id, kept });
      state.runs = state.runs.map((r) => ((run.threadId && r.threadId === run.threadId) || r.id === run.id ? { ...r, kept } : r));
      if (state.fetched && ((run.threadId && state.fetched.threadId === run.threadId) || state.fetched.id === run.id)) state.fetched = { ...state.fetched, kept };
      state.viewError = ''; el('runLiveRegion').textContent = kept ? 'Kept in your Library.' : "Taken out of Library. It's still in Work.";
      window.dispatchEvent(new CustomEvent('localai:kept', { detail: { runId: run.id, threadId: run.threadId || '', kept } }));
      render(); if (state.selectedId) renderDrawer(state.selectedId);
      window.LocalAIUI?.toast?.(kept ? 'Kept in Library' : "Taken out of Library. It's still in Work.");
    } catch (error) { viewFail(`Could not ${kept ? 'keep' : 'un-keep'} this: ${error.message}`); if (button?.isConnected) button.disabled = false; }
  }

  async function fileRun(run) {
    if (!(await loadProjects())) { viewFail('Could not load projects.'); return; }
    const options = [{ value: '', label: 'Not filed' }, ...state.projects.map((p) => ({ value: p.id, label: p.name }))];
    const answer = await window.LocalAIUI.ask({ title: 'File this run', effect: 'Filed runs are kept with their project.', confirmLabel: 'File', select: { label: 'Project', options, value: run.projectId || '' } });
    if (!answer.ok) return;
    await updateRun(run, { projectId: answer.value || null }, answer.value ? 'Run filed.' : 'Run unfiled.');
  }

  function appendSection(parent, headingText, content, code = false) {
    const section = document.createElement('section'); section.className = 'run-section';
    const heading = document.createElement('h3'); heading.textContent = headingText;
    const body = document.createElement(code ? 'pre' : 'div');
    if (code) body.className = 'run-output';
    else body.className = headingText === 'Error' ? 'status-error' : 'muted';
    body.textContent = content;
    section.append(heading, body); parent.appendChild(section);
  }

  // Opening a run is routing: #run/<id>. The router calls routeRun(id) (and routeRun(null) when the hash leaves a run).
  function openRun(id) {
    state.inApp = true;
    if (window.LocalAIRouter) window.LocalAIRouter.go(`#run/${encodeURIComponent(id)}`); else routeRun(id);
  }
  // Closing goes back when the run view was opened by in-app navigation, else (deep link, reload) to Home.
  function closeRunView() {
    if (state.closing) return;
    if (!window.LocalAIRouter) { hideView(); return; }
    state.closing = true;
    { const r = state.detailsRelease; state.detailsRelease = null; r?.(); }   // a ⓘ sheet that just closed has not reported it yet: pop its entry first
    window.LocalAIUI.dropStaleSheet?.();   // a sheet entry left by a reload or Forward has this run's hash too: step past it first
    window.LocalAIUI.afterSheetPop(() => {   // after a closing details sheet has popped its own entry
      if (!state.closing) return;   // the pop already closed the view
      if (!(state.inApp || history.state?.localaiRun)) { window.LocalAIRouter.go('#home', { replace: true }); return; }
      history.back();
      // Back that lands on this same hash never fires hashchange; never stay stuck: go Home instead.
      clearTimeout(state.closeTimer); state.closeTimer = setTimeout(() => { state.closeTimer = 0; if (state.closing) { state.closing = false; window.LocalAIRouter.go('#home', { replace: true }); } }, 400);
    });
  }
  function showView() {
    const backdrop = el('runDrawerBackdrop');
    if (!backdrop) return;
    const was = backdrop.classList.contains('show');
    if (!was) { const a = document.activeElement; state.opener = a && a !== document.body && !a.closest('#runDrawerBackdrop') ? { el: a, runId: a.closest('[data-run-id]')?.dataset.runId || (state.selectedId !== 'pending' ? state.selectedId : '') } : null; }
    backdrop.classList.add('show'); backdrop.setAttribute('aria-hidden', 'false'); document.body.classList.add('run-view-open');
    if (!was) setInert(true);
    renderDrawer(state.selectedId);
    if (!was) el('runDrawer')?.querySelector('button')?.focus();
  }
  function hideView() {
    window.LocalAIRunBodies?.release?.(); state.body = null;
    const backdrop = el('runDrawerBackdrop'), wasOpen = backdrop?.classList.contains('show'), opener = state.opener || { el: null, runId: state.selectedId };
    if (backdrop) { backdrop.classList.remove('show'); backdrop.setAttribute('aria-hidden', 'true'); }
    const sheet = el('runDetailsSheet'); if (sheet?.open) { state.selectedId = null; sheet.close(); }
    document.body.classList.remove('run-view-open');
    { const page = document.querySelector('main .view.active')?.id; if (page && window.LocalAIViews) document.title = window.LocalAIViews.title(page); }   // the run's title gives way to the page's again
    setInert(false); state.opener = null;
    if (wasOpen) queueMicrotask(() => restoreFocus(opener));
    clearTimeout(state.closeTimer); state.closeTimer = 0;
    Object.assign(state, { selectedId: null, drawerSig: '', fetched: null, gap: '', pending: null, inApp: false, closing: false, viewError: '' });
  }
  async function fetchRun(id, quiet) {
    try {
      const response = await fetch(`/api/runs?id=${encodeURIComponent(id)}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (state.selectedId !== id) return;
      if (response.ok && data.item) { state.fetched = data.item; state.gap = ''; if (state.pending?.resolved === id) state.pending = null; }
      else if (quiet) return;
      else { state.gap = response.status === 404 ? 'missing' : 'error'; if (state.pending?.resolved === id) state.pending = null; }
    } catch { if (quiet || state.selectedId !== id) return; state.gap = 'error'; }
    if (el('runDrawerBackdrop')?.classList.contains('show')) {
      renderDrawer(id);
      if (lookup(id)) projectName(id);
    }
  }
  // The projects list is fetched when a run view opens so a filed run shows its project's name; only the name is updated.
  function projectName(id) {
    loadProjects().then((ok) => {
      const run = lookup(id), span = el('runDrawer')?.querySelector('.run-view-project');
      if (ok && run?.projectId && span && state.selectedId === id) span.textContent = state.projects.find((p) => p.id === run.projectId)?.name || 'Project removed';
    });
  }
  // Router handler: show the run named by #run/<id>, or close the view when id is null.
  function routeRun(id) {
    if (id === null || id === undefined) { hideView(); return; }
    state.closing = false;
    if (state.selectedId !== id) { state.viewError = ''; state.gap = ''; state.fetched = null; }
    state.selectedId = id;
    if (state.inApp) { try { history.replaceState({ localaiRun: true }, '', location.href); } catch {} }   // marks this entry as opened in-app, so Back and Forward keep working
    if (id === 'pending') {
      if (state.pending) { showView(); return; }
      state.selectedId = null; window.LocalAIRouter?.go('#home', { replace: true }); return;   // nothing to resume (reload, or Forward after a failed start)
    }
    if (lookup(id)) { if (state.pending?.resolved === id) state.pending = null; showView(); projectName(id); return; }
    state.gap = '';
    showView();
    fetchRun(id, false);
  }
  function openPending({ kind, title, retry } = {}) {
    const token = { kind: String(kind || ''), title: String(title || ''), error: '', resolved: '', startedAt: Date.now(), retry: typeof retry === 'function' ? retry : null };
    state.pending = token;
    if (token.kind === 'create') { const t = setInterval(() => { const n = el('runDrawer')?.querySelector('.run-view-state__text'); if (state.pending !== token || token.resolved || token.error || !n) { if (state.pending !== token || token.resolved || token.error) clearInterval(t); return; } n.textContent = pendingText(token); }, 1000); } state.selectedId = 'pending'; state.gap = ''; state.fetched = null; state.inApp = true; state.closing = false;
    showView();
    if (window.LocalAIRouter) window.LocalAIRouter.go('#run/pending');
    return {
      resolve(runId) { if (state.pending !== token || token.resolved) return; token.resolved = String(runId); window.dispatchEvent(new CustomEvent('localai:run-opened', { detail: { runId: token.resolved, kind: token.kind } })); if (window.LocalAIRouter) window.LocalAIRouter.go(`#run/${encodeURIComponent(runId)}`, { replace: true }); else routeRun(token.resolved); },
      fail(message) { if (state.pending !== token || token.resolved || token.error) return; token.error = String(message || 'Something went wrong.'); el('runLiveRegion').textContent = token.error; renderDrawer('pending'); }
    };
  }

  async function post(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function cancelRun(runId, button) {
    button.disabled = true; button.textContent = 'Cancelling…';
    try {
      await post('/api/runs/cancel', { id: runId });
      el('runLiveRegion').textContent = 'Run cancelled.';
      await loadRuns(true);
    } catch (error) {
      el('runLiveRegion').textContent = `Cancel failed: ${error.message}`;
      button.disabled = false; button.textContent = 'Cancel run';
    }
  }

  async function retryRun(runId, button) {
    button.disabled = true; button.textContent = 'Retrying…';
    try {
      await post('/api/runs/retry', { id: runId });
      el('runLiveRegion').textContent = 'Retry started.';
      closeRunView();
      await loadRuns(true);
    } catch (error) {
      el('runLiveRegion').textContent = `Retry failed: ${error.message}`;
      button.disabled = false; button.textContent = 'Retry';
    }
  }

  function schedule() {
    if (state.timer) window.clearTimeout(state.timer);
    const delay = state.runs.some(active) ? 3000 : 15000;
    state.timer = window.setTimeout(() => { if (!document.hidden) loadRuns(false); else schedule(); }, delay);
  }

  async function loadRuns(force = false) {
    if (state.loading && !force) return;
    state.loading = true;
    try {
      const response = await fetch('/api/runs?limit=120', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      state.runs = Array.isArray(data.items) ? data.items : [];
      render();
    } catch (error) {
      const list = el('runList');
      if (list) { list.replaceChildren(); const box = document.createElement('div'); box.className = 'status-error'; box.textContent = `Runs unavailable: ${error.message}`; list.appendChild(box); }
    } finally {
      state.loading = false;
      schedule();
    }
  }

  // Open a run from elsewhere (the Audit log links here). Accepts a ledger id or the id of the work that produced it.
  async function openRunBySource(id) {
    const match = () => state.runs.find((run) => run.id === id || run.source?.id === id || run.meta?.sourceId === id);
    if (!match()) await loadRuns(true);
    const run = match();
    if (run) openRun(run.id);   // on top of the page you are on, so Back and Close return to it
    return Boolean(run);
  }
  // The one way for a page to open a run view: pushes a history entry marked as in-app, so Close and Back return to the page you were on.
  function show(id) { openRun(String(id)); }
  window.LocalAIRuns = { open: openRunBySource, openPending, show, refresh: () => loadRuns(true) };

  function init() {
    ensureSurface();
    loadRuns(true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadRuns(true); }, { passive: true });
    // Escape closes the top layer only: a confirm, else the ⓘ sheet (the browser closes it), else the menu, else the run view.
    document.addEventListener('keydown', trapTab, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && el('runDrawerBackdrop')?.classList.contains('show') && !document.querySelector('dialog.ask-sheet[open]') && !el('runDetailsSheet')?.open && !closeMenu()) closeRunView();
    });
    window.LocalAIRouter?.onRun(routeRun);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

// ===== Long lists ============================================================
// Long lists show their first items and a "Show N more" button: a few on a phone, three times as many on a
// larger screen. Without it the Files and Library pages ran to tens of thousands of pixels. Lists re-render often (polling), so a MutationObserver
// re-applies the limit; "Show more" is remembered per list until the page reloads.
(() => {
  'use strict';
  const LIMITS = { inboxList: 10, activityList: 15, runList: 10, libraryGrid: 24, knowledgeList: 10, automationList: 10 };
  // Paged lists show one more page per tap instead of everything at once (Library: 24 at a time on a phone, F3).
  const PAGED = new Set(['libraryGrid']);
  const phone = window.matchMedia('(max-width: 760px)');
  const observers = new Map();

  function apply(list) {
    const observer = observers.get(list);
    observer?.disconnect();
    list.querySelector(':scope > .mobile-more')?.remove();
    const items = [...list.children];
    const page = LIMITS[list.id] * (phone.matches ? 1 : 3), paged = PAGED.has(list.id);
    const limit = paged ? page * Math.max(1, Number(list.dataset.pages) || 1) : page;
    // Clipping only one or two items saves nothing; show them.
    const clip = list.dataset.showAll !== 'true' && items.length > limit + 2;
    items.forEach((item, i) => item.classList.toggle('mobile-clipped', clip && i >= limit));
    if (clip) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn-outline mobile-more';
      more.textContent = `Show ${paged ? Math.min(page, items.length - limit) : items.length - limit} more`;
      more.addEventListener('click', () => { if (paged) list.dataset.pages = String(limit / page + 1); else list.dataset.showAll = 'true'; apply(list); list.querySelector(':scope > .mobile-more')?.focus(); });
      list.appendChild(more);
    }
    observer?.observe(list, { childList: true });
  }

  function bind() {
    for (const id of Object.keys(LIMITS)) {
      const list = document.getElementById(id);
      if (!list || observers.has(list)) continue;
      observers.set(list, new MutationObserver(() => apply(list)));
      apply(list);
    }
  }

  // Not window 'load': that waits for every image, and a slow image service can hold it back for a long time.
  // The retries pick up lists other scripts create after startup (Runs).
  const start = () => { bind(); setTimeout(bind, 0); setTimeout(bind, 3000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  phone.addEventListener('change', () => observers.forEach((_, list) => apply(list)));
})();

// ==== first-run.js ====
// "Get started" on Home for a new install, and the Developer tools preference that adds the developer pages.
(()=>{'use strict';
const q=(s,r=document)=>r.querySelector(s),qa=(s,r=document)=>[...r.querySelectorAll(s)];
const DEV_KEY='localai.devTools',DONE_KEY='localai.firstRun.done';
const pref={get(k){try{return localStorage.getItem(k)}catch{return null}},set(k,v){try{localStorage.setItem(k,v)}catch{}}};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function getJson(url){const r=await fetch(url,{cache:'no-store'});return r.json()}
let config=null;
async function loadConfig(){if(!config)config=await getJson('/api/config').catch(()=>({}));return config}

// Developer tools: the developer pages (registry `dev`: Files, Repository, PowerShell, Browser & computer,
// n8n workflows), plus the diagnostic tiles marked data-dev-only. An install that has used them
// starts with them shown; a new one starts with them hidden. The choice is remembered per browser.
function applyDevTools(on,fromToggle=false){
 document.body.classList.toggle('dev-tools-off',!on);
 qa('[data-dev-tools-toggle]').forEach(i=>{i.checked=on});
 const active=q('.view.active')?.id;
 const v=window.LocalAIViews?.view(active);
 if(fromToggle&&!on&&v?.dev&&typeof window.showView==='function')window.showView('home');
}
async function initDevTools(){
 const saved=pref.get(DEV_KEY);
 if(saved!==null)return applyDevTools(saved==='1');
 applyDevTools(!!(await loadConfig()).developerHistory);
}
function mountDevToolsToggle(){
 const status=q('#status');if(!status||q('.dev-tools-pref',status))return;
 const row=document.createElement('label');row.className='dev-tools-pref card';
 row.innerHTML='<input type="checkbox" data-dev-tools-toggle><span><strong>Show developer tools</strong><small>Adds the developer tools: Files, Repository, PowerShell, Browser &amp; computer, n8n workflows.</small></span>';
 status.appendChild(row); // a setting, so it follows the health results
 row.querySelector('input').addEventListener('change',e=>{pref.set(DEV_KEY,e.target.checked?'1':'0');applyDevTools(e.target.checked,true)});
 row.querySelector('input').checked=!document.body.classList.contains('dev-tools-off');
}

// Get started: shown until dismissed, and only while something is missing (no model yet, or nothing made yet).
const SAMPLES=[
 {mode:'ask',label:'Ask a question',text:'In three sentences, what can a private AI on my own computer help me with?'},
 {mode:'research',label:'Research the web',text:'What are the most useful free tools for organising family photos?'},
 {mode:'create',label:'Make an image',text:'A lighthouse at dusk, soft watercolor'}
];
function stepHtml(id,title){return `<li data-step="${id}" data-state="checking"><span class="first-run-mark" aria-hidden="true"></span><div><strong>${title}</strong><div class="first-run-detail">Checking…</div></div></li>`}
function setStep(card,id,state,html){const li=q(`[data-step="${id}"]`,card);if(!li)return;li.dataset.state=state;q('.first-run-detail',li).innerHTML=html}
async function checkSteps(card){
 const [status,models]=await Promise.all([getJson('/api/status').catch(()=>null),getJson('/api/models').catch(()=>null)]);
 const coreDown=(status?.services||[]).filter(s=>s.required!==false&&s.state==='DOWN');
 if(!status)setStep(card,'service','todo','Local AI did not answer. Check that Docker Desktop is running on the Windows host, then reload this page.');
 else if(coreDown.length)setStep(card,'service','todo',`Running, but ${esc(coreDown.map(s=>s.label||s.name).join(', '))} ${coreDown.length===1?'is':'are'} not answering. <a href="#" data-goto="status">See Health</a>`);
 else setStep(card,'service','done','Running on this computer. Nothing you type leaves it unless you turn on web research.');
 const model=models?.default||config?.model||'the default model';
 if(models?.defaultInstalled)setStep(card,'model','done',`<code>${esc(model)}</code> is installed and ready.`);
 else setStep(card,'model','todo',`<code>${esc(model)}</code> isn't installed yet. It's about 2.5 GB. <button type="button" class="btn-primary" data-first-run-download="${esc(model)}">Download it now</button> <button type="button" class="btn-outline" data-first-run-recheck>Check again</button><div class="first-run-progress" aria-live="polite"></div>`);
 return !!models?.defaultInstalled;
}
function runSample(s){
 q(`.mode[data-mode="${s.mode}"]`)?.click();
 const input=q('#commandInput');if(!input)return;input.value=s.text;input.dispatchEvent(new Event('input',{bubbles:true}));
 q('#commandGo')?.click();
 pref.set(DONE_KEY+'.tried','1');
}
async function mountFirstRun(){
 if(pref.get(DONE_KEY)==='1')return;
 const home=q('#home'),hero=q('#homeRecentSection');if(!home||!hero||q('#firstRun'))return;
 const [models,runs]=await Promise.all([getJson('/api/models').catch(()=>null),getJson('/api/runs?limit=1').catch(()=>null)]);
 if(models?.defaultInstalled&&(runs?.items||[]).length)return; // anything in Work: a first task was tried
 await loadConfig();
 const card=document.createElement('section');card.id='firstRun';card.className='first-run card';card.setAttribute('aria-labelledby','firstRunTitle');
 card.innerHTML=`<div class="first-run-head"><div><h2 id="firstRunTitle">Get started</h2><p>Two checks, then try a first task. Everything runs on this computer.</p></div><button type="button" class="icon-btn" data-first-run-dismiss aria-label="Hide Get started">×</button></div>
 <ol class="first-run-steps">${stepHtml('service','Local AI is running')}${stepHtml('model','A language model is installed')}<li data-step="try" data-state="todo"><span class="first-run-mark" aria-hidden="true"></span><div><strong>Try a first task</strong><div class="first-run-detail">Pick one. It runs right here, and the result is in Work. Tap ☆ Keep to keep it in your Library.</div><div class="first-run-samples">${SAMPLES.map((s,i)=>`<button type="button" class="btn-outline" data-sample="${i}"><span>${esc(s.label)}</span><small>${esc(s.text)}</small></button>`).join('')}</div></div></li></ol>
 <div class="first-run-foot"><span class="meta">Developer tools are ${document.body.classList.contains('dev-tools-off')?'hidden':'shown'}. Change this in <a href="#" data-goto="status">Health</a>.</span><button type="button" class="btn-outline" data-first-run-dismiss>I'm set up, hide this</button></div>`;
 hero.before(card) // Get started takes Recent's place while it shows;
 window.dispatchEvent(new CustomEvent('localai:first-run')); // Home may have painted its rows already
 // Step 3 is done when a run really opens (the pending run gets its id), not when a sample is tapped: a send that fails is no first task.
 window.addEventListener('localai:run-opened',()=>{const li=q('[data-step="try"]',card);if(li&&card.isConnected)li.dataset.state='done'});
 window.addEventListener('localai:model-pulls',e=>{
  const step=q('[data-step="model"]',card);if(!step||step.dataset.state==='done')return;
  const p=(e.detail.items||[]).find(x=>x.name===(config?.model||''));const box=q('.first-run-progress',step);if(!p||!box)return;
  const pct=p.total?Math.round(p.completed/p.total*100):0;
  box.innerHTML=p.state==='failed'?`<span class="model-pull-error">Download failed: ${esc(p.error)}</span>`:`<div class="model-pull-bar" role="progressbar" aria-label="Model download" aria-valuenow="${p.state==='done'?100:pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p.state==='done'?100:pct}%"></i></div><small>${p.state==='done'?'Downloaded.':esc(p.status||'Starting')+(p.total?` · ${pct}%`:'')}</small>`;
  const btn=q('[data-first-run-download]',step);if(btn){btn.disabled=p.state==='running';btn.textContent=p.state==='running'?'Downloading…':'Download it now'}
  if(p.state==='done')checkSteps(card);
 });
 card.addEventListener('click',e=>{
  const t=e.target.closest('button,a');if(!t)return;
  if(t.matches('[data-first-run-dismiss]')){pref.set(DONE_KEY,'1');card.remove();window.dispatchEvent(new CustomEvent('localai:first-run'))}
  else if(t.matches('[data-first-run-recheck]'))checkSteps(card);
  else if(t.dataset.firstRunDownload){t.disabled=true;t.textContent='Starting…';window.LocalAIModels?.startPull(t.dataset.firstRunDownload).then(ok=>{if(!ok){t.disabled=false;t.textContent='Download it now'}})}
  else if(t.dataset.sample!==undefined)runSample(SAMPLES[Number(t.dataset.sample)]);
  else if(t.dataset.goto){e.preventDefault();window.LocalAIRouter?.open(t.dataset.goto)}
 });
 checkSteps(card);
}
// Home location: where "what's the weather" is answered when Siri sends no location (Shortcuts asks on the phone).
async function mountHomeLocation(){
 const status=q('#status');if(!status||q('.voice-home-pref',status))return;
 const row=document.createElement('div');row.className='voice-home-pref card';
 row.innerHTML='<span><strong data-voice-home-label>Home location</strong><small data-voice-home-note>Used for spoken weather when your phone does not share where it is.</small></span><button type="button" class="btn-outline">Change…</button>';
 (q('.dev-tools-pref',status)||status).after(row);
 const label=q('[data-voice-home-label]',row),note=q('[data-voice-home-note]',row);
 const show=h=>{label.textContent='Home location: '+(h&&h.place?h.place:'Not set')};
 show(await getJson('/api/voice/home').catch(()=>({})));
 q('button',row).addEventListener('click',async()=>{
  const a=await window.LocalAIUI.ask({title:'Home location',effect:'A city, like Phoenix, AZ.',confirmLabel:'Save',input:{label:'City',type:'text'}});
  if(!a.ok||!String(a.value||'').trim())return;
  try{
   const r=await fetch('/api/voice/home',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({place:String(a.value).trim()})});
   const j=await r.json().catch(()=>({}));
   if(!r.ok)throw new Error(j.error||"Couldn't save that.");
   show(j);note.textContent='Used for spoken weather when your phone does not share where it is.';
  }catch(e){note.textContent=e.message}
 });
}
function init(){initDevTools().then(()=>{mountDevToolsToggle();mountHomeLocation()});mountFirstRun()}
window.LocalAIFirstRun={applyDevTools,DEV_KEY,DONE_KEY};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();

// ==== secure-connection.js ====
// Health page: whether this page is on HTTPS, whether this device trusts Local AI's certificate authority, and
// how to set that up. HTTPS is served by Caddy on ports 443/80 (deploy/Install-LocalAI-HTTPS.ps1).
(()=>{'use strict';
const q=(s,r=document)=>r.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const root=window,host=location.hostname,isLocal=/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(host);
const httpsUrl=`https://${host}/`,caUrl=`http://${host}/localai-ca.crt`;
// A no-cors request succeeds only if TLS succeeds, i.e. this device trusts the certificate. An untrusted certificate
// is logged by the browser as a console error that a page can't suppress, so probe only when Health is opened, and
// remember the answer for this tab's session.
const TRUST_KEY='localai.httpsTrusted';
async function trusted(){
 try{const seen=sessionStorage.getItem(TRUST_KEY);if(seen)return seen==='1'}catch{}
 let ok;try{await fetch(`${httpsUrl}healthz`,{mode:'no-cors',cache:'no-store',signal:AbortSignal.timeout(4000)});ok=true}catch{ok=false}
 try{sessionStorage.setItem(TRUST_KEY,ok?'1':'0')}catch{}
 return ok;
}
const STEPS=[
 ['Mac','Open the downloaded file. Keychain Access opens: add it to System, double-click “Caddy Local Authority”, open Trust and choose Always Trust.'],
 ['iPhone or iPad','Open the download link in Safari and allow it. Then Settings › General › VPN &amp; Device Management › install the profile, and Settings › General › About › Certificate Trust Settings › turn it on.'],
 ['Android','Settings › Security › Encryption &amp; credentials › Install a certificate › CA certificate, then pick the downloaded file.'],
 ['Windows','Double-click the file › Install Certificate › Local Machine › Trusted Root Certification Authorities. (The Local AI computer itself is already set up.)']
];
// The device's own steps come first; the others stay for setting up a different device from here.
function platform(){const ua=navigator.userAgent||'';if(/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1))return 'iPhone or iPad';if(/Android/.test(ua))return 'Android';if(/Macintosh/.test(ua))return 'Mac';if(/Windows/.test(ua))return 'Windows';return ''}
function stepsHtml(){const mine=platform(),order=[...STEPS].sort((a,b)=>(b[0]===mine)-(a[0]===mine));return order.map(([d,t])=>`<dt>${d}${d===mine?' <span class="badge badge--good">This device</span>':''}</dt><dd>${t}</dd>`).join('')}
// Home shows a "use the secure address" item on plain HTTP until this device opts out here.
const NUDGE_KEY='localai.secureNudge.off';
const nudgeOff=()=>{try{return localStorage.getItem(NUDGE_KEY)==='1'}catch{return false}};
// A phone can't easily type an address: from a computer, show scannable codes for the certificate and the secure page.
// Only where a camera-holding device would be pointed at this screen (a mouse or trackpad), and only when this page
// was opened by the computer's network address, which is the one a phone can reach.
// remote: this computer's Tailscale name, when set up (deploy/Install-LocalAI-HTTPS.ps1), for use away from home.
// addresses: every HTTPS address it answers on ({label,url}: Home Wi-Fi, Anywhere (Tailscale)).
async function access(){try{const r=await fetch('/api/access',{cache:'no-store'});const j=r.ok?await r.json():{};return {remote:String(j.remoteName||''),addresses:Array.isArray(j.addresses)?j.addresses:[]}}catch{return {remote:'',addresses:[]}}}
// Both addresses, with the one that works everywhere called out: a Home Screen icon keeps the address it was added from.
function addressesHtml(list){
 const rows=list.map(a=>{let u;try{u=new URL(String(a.url))}catch{return ''}return `<dt>${esc(a.label)}${u.origin===location.origin?' <span class="badge badge--good">This page</span>':''}</dt><dd><a href="${esc(u.origin+'/')}">${esc(u.origin)}</a></dd>`}).join('');
 if(!rows)return '';
 const away=list.some(a=>/tailscale/i.test(String(a.label||'')));
 return `<div class="secure-addresses"><dl>${rows}</dl>${away?'<p class="meta">Add to Home Screen from the Tailscale address to use Local AI anywhere. It works at home too, with Tailscale turned on on the phone.</p>':''}</div>`;
}
function phoneHtml(remote){
 if(!(matchMedia('(pointer: fine)').matches&&root.LocalAIQR))return '';
 const qr=(url,label)=>{try{return root.LocalAIQR.svg(url,label)}catch{return ''}};
 const away=remote?`<li class="secure-phone__away"><p><b>Away from home.</b> With the Tailscale app installed and signed in on the phone, scan to open <b>${esc(`https://${remote}/`)}</b>. It uses the same certificate, so do steps 1 and 2 first.</p>${qr(`https://${remote}/`,'QR code: open Local AI away from home')}</li>`:'';
 if(isLocal)return `<details class="secure-phone"><summary>Set up a phone or tablet</summary><p class="meta">Open this page using the computer's network address (for example <b>http://&lt;its IP address&gt;:3080</b>) and the codes to scan appear here.</p>${away?`<ol class="secure-phone__steps">${away}</ol>`:''}</details>`;
 return `<details class="secure-phone"><summary>Set up a phone or tablet</summary><ol class="secure-phone__steps">
 <li><p><b>1.</b> Scan with the phone's camera to download the certificate.</p>${qr(caUrl,'QR code: download the certificate')}</li>
 <li><p><b>2.</b> Trust it on the phone (see <b>iPhone or iPad</b> or <b>Android</b> under Set up HTTPS on this device).</p></li>
 <li><p><b>3.</b> Scan to open <b>${esc(httpsUrl)}</b>, then add it to the Home Screen from there.</p>${qr(httpsUrl,'QR code: open Local AI securely')}</li>${away}</ol></details>`;
}
async function render(card){
 const secure=location.protocol==='https:',{remote,addresses}=await access();
 let state,detail;
 // Without an answer from Local AI nothing here can be confirmed (the page may be a saved copy): say so, neutrally.
 const reach=root.LocalAIConnection?.reachable;
 if(reach&&!(await reach())){card.dataset.state='unknown';card.innerHTML=`<div class="secure-head"><span class="secure-dot" aria-hidden="true"></span><div><h2>Secure connection</h2><p>Can't check: Local AI isn't reachable.</p></div></div>`;delete card.dataset.rendered;return}
 if(secure){state='good';detail='This page is on a secure connection.'}
 else if(isLocal){state='good';detail='You are on the Local AI computer itself, which browsers already treat as secure.'}
 else{const ok=await trusted();state=ok?'ready':'todo';detail=ok?`This device already trusts Local AI's certificate. Switch to <a href="${esc(httpsUrl)}">${esc(httpsUrl)}</a>.`:'This page uses plain HTTP, so other devices on the network could read what you send, and some features (copy to clipboard, installing as an app, signing PowerShell jobs) are unavailable.'}
 card.dataset.state=state;
 card.innerHTML=`<div class="secure-head"><span class="secure-dot" aria-hidden="true"></span><div><h2>Secure connection</h2><p>${detail}</p></div></div>${addressesHtml(addresses)}
 ${state==='todo'?`<details class="secure-setup"><summary>Set up HTTPS on this device</summary><ol class="secure-steps"><li><a class="btn-primary" href="${esc(caUrl)}" download>Download the certificate</a> <span class="meta">Local AI's own certificate authority. Its private key never leaves the Local AI computer, which uses it only to sign Local AI's certificate.</span></li><li>Trust it on this device:<dl>${stepsHtml()}</dl></li><li>Open <a href="${esc(httpsUrl)}">${esc(httpsUrl)}</a>. To use the name <b>localai.home.arpa</b>, add it for ${esc(host)} in your router's DNS settings.</li></ol>${nudgeOff()?'':'<button type="button" class="btn-outline secure-nudge-off">Don\'t remind me on Home</button>'}</details>`:''}${phoneHtml(remote)}`;
 card.querySelector('.secure-nudge-off')?.addEventListener('click',e=>{try{localStorage.setItem(NUDGE_KEY,'1')}catch{}e.currentTarget.replaceWith(Object.assign(document.createElement('p'),{className:'meta',textContent:'Home won\'t remind you on this device.'}))});
 focusSetup(card);
}
// Arriving from Home's reminder (#status?secure=1): open the setup and bring it into view.
function focusSetup(card){
 if(new URLSearchParams(location.hash.split('?')[1]||'').get('secure')!=='1')return;
 const d=card.querySelector('.secure-setup')||card.querySelector('.secure-phone');if(!d)return;
 d.open=true;card.scrollIntoView({block:'start',behavior:'smooth'});
}
// Below the service list: what's running comes first; this is setup advice.
function mount(){const status=q('#status');if(!status)return;let card=q('.secure-card',status);if(!card){card=document.createElement('section');card.className='card secure-card';const services=q('#serviceList',status)?.closest('.card');(services||q('.dev-tools-pref',status)||q('.topbar',status))?.after(card)}if(card.dataset.rendered){focusSetup(card);return}card.dataset.rendered='1';render(card)}
// Render (and so probe) only once Health is on screen.
function watch(){const status=q('#status');if(!status)return;const go=()=>{if(status.classList.contains('active'))mount()};go();new MutationObserver(go).observe(status,{attributes:true,attributeFilter:['class']})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(watch,0),{once:true});else setTimeout(watch,0);
})();

// ==== whats-new.js ====
// Health › What's new: the running version and the merged changes in each recent release (from /api/releases),
// plus a one-time notice after an update. The deploy records release notes (deploy/Deployment-LocalAI.ps1).
(()=>{'use strict';
const q=(s,r=document)=>r.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SEEN_KEY='localai.seenVersion';
const pref={get(){try{return localStorage.getItem(SEEN_KEY)}catch{return null}},set(v){try{localStorage.setItem(SEEN_KEY,v)}catch{}}};
const when=iso=>{const d=new Date(iso);return Number.isNaN(d.getTime())?'':d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})};
let data=null;
async function load(){try{const r=await fetch('/api/releases',{cache:'no-store'});if(r.ok)data=await r.json()}catch{}return data}
function render(card){
 if(!data){card.hidden=true;return}
 const {current,history,repoUrl}=data,list=(history||[]).slice(0,8);
 const note=n=>`<li>${esc(n.title)}${n.pr?` <a href="${esc(repoUrl)}/pull/${n.pr}" target="_blank" rel="noopener">#${n.pr}</a>`:''}</li>`;
 card.innerHTML=`<div class="section-head"><div><h2>What's new</h2><p>Version <b>${esc(current.version)}</b>${current.deployedAt?` · updated ${esc(when(current.deployedAt))}`:''}${current.commit?` · <code>${esc(current.commit.slice(0,10))}</code>`:''}</p></div></div>
 ${list.length?`<div class="whatsnew-list">${list.map((r,i)=>`<details class="whatsnew-release"${i===0?' open':''}><summary><b>${esc(r.version)}</b><span>${esc(when(r.deployedAt))} · ${r.notes?.length||0} change${r.notes?.length===1?'':'s'}</span></summary>${r.notes?.length?`<ul>${r.notes.map(note).join('')}</ul>`:'<p class="meta">No change list was recorded for this release.</p>'}</details>`).join('')}</div>`:'<p class="meta">Release notes appear here after the next update.</p>'}`;
}
function mount(){const status=q('#status');if(!status||q('.whatsnew-card',status))return;const card=document.createElement('section');card.className='card whatsnew-card';card.id='whatsNew';
 // After the health results (the services card), like the Secure connection card: what's running comes first.
 (q('#serviceList',status)?.closest('.card')||q('.dev-tools-pref',status)||q('.topbar',status))?.after(card);render(card)}
// After an update, say so once, and let the notice open What's new.
function announce(){
 const v=data?.current?.version,seen=pref.get();if(!v)return;pref.set(v);
 if(!seen||seen===v)return;
 // Not timed: it stays until the owner opens What's new or dismisses it, and hiding it empties it (no invisible Tab stop).
 const box=document.createElement('span');box.className='whatsnew-toast__body';
 box.innerHTML=`<span>Updated to ${esc(v)}.</span> <button type="button" class="whatsnew-open">See what's new</button><button type="button" class="whatsnew-dismiss" aria-label="Dismiss">×</button>`;
 const UI=window.LocalAIUI,t=UI?.toast?UI.toast(box,{ms:0}):null;if(!t)return;t.classList.add('whatsnew-toast');
 box.querySelector('.whatsnew-open').onclick=()=>{UI.hideToast();window.LocalAIRouter?.open('status');setTimeout(()=>q('#whatsNew')?.scrollIntoView({block:'start'}),100)};
 box.querySelector('.whatsnew-dismiss').onclick=()=>UI.hideToast();
}
async function start(){await load();mount();announce()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(start,50),{once:true});else setTimeout(start,50);
})();

// ==== notifications.js ====
// Health › Notifications: turns phone notifications on for this device and sets what it gets (Web Push;
// app/push.js sends, app/notify.js decides). On iPhone, Apple allows push only from the Home Screen app, over HTTPS
// with the Local AI certificate trusted.
(()=>{'use strict';
const q=(s,r=document)=>r.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isIOS=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const standalone=()=>navigator.standalone===true||matchMedia('(display-mode: standalone)').matches;
const supported=()=>'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
const deviceName=()=>/iPad/.test(navigator.userAgent)?'iPad':isIOS?'iPhone':/Android/.test(navigator.userAgent)?'Android phone':'This browser';
const keyBytes=b64=>Uint8Array.from(atob(b64.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((b64.length+3)%4)),c=>c.charCodeAt(0));
const KINDS=[['needs-you','Needs you','Approvals, and Claude findings waiting for your decision'],['failed','Failed','Runs, automatic updates and backups that failed'],['service','Down and recovered','A core service down for 2 minutes, and back again'],['finished','Finished','Runs of 30 seconds or more, when Local AI isn\'t open'],['answer','Answers','A spoken question that took too long, answered here instead']];
const when=iso=>iso?new Date(iso).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'never';
async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);return j}
// navigator.serviceWorker.ready never settles if the worker failed to register, so give it 5 s.
const workerReady=()=>Promise.race([navigator.serviceWorker.ready,new Promise((_,no)=>setTimeout(()=>no(new Error('worker')),5000))]);
async function subscription(){if(!supported())return null;const reg=await workerReady();return reg.pushManager.getSubscription()}
const say=(card,html)=>{q('.notify-body',card).innerHTML=html};
const status=(card,text)=>{q('.notify-status',card).textContent=text};

function settingsHtml(me,devices){
 const kinds=KINDS.map(([id,label,hint])=>`<label class="notify-kind"><input type="checkbox" data-notify-kind="${id}"${me.kinds.includes(id)?' checked':''}><span><b>${label}</b><small>${hint}</small></span></label>`).join('');
 const list=devices.map(d=>`<li data-device="${esc(d.id)}"><span><b>${esc(d.name)}</b>${d.id===me.id?' (this device)':''}<small>Last delivered ${esc(when(d.lastOkAt))}${d.lastError?` · last error: ${esc(d.lastError)}`:''}</small></span><span class="notify-device-actions"><button type="button" class="btn-outline" data-notify-rename="${esc(d.id)}">Rename</button><button type="button" class="btn-outline" data-notify-remove="${esc(d.id)}">Remove</button></span></li>`).join('');
 return `<p>Notifications are on for this device.</p>
 <div class="notify-actions"><button type="button" class="btn-outline" data-notify-test>Send a test</button><button type="button" class="btn-outline" data-notify-off>Turn off on this device</button></div>
 <fieldset class="notify-group"><legend>What notifies this device</legend>${kinds}</fieldset>
 <fieldset class="notify-group"><legend>Quiet hours</legend><label class="notify-kind"><input type="checkbox" data-notify-quiet-on${me.quiet.on?' checked':''}><span><b>Only failures and outages</b><small>Everything else waits in the Inbox.</small></span></label>
 <div class="notify-times"><label>From <input type="time" data-notify-quiet-start value="${esc(me.quiet.start)}"></label><label>to <input type="time" data-notify-quiet-end value="${esc(me.quiet.end)}"></label></div></fieldset>
 <fieldset class="notify-group"><legend>Your devices</legend><ul class="notify-devices">${list}</ul></fieldset>`;
}

let me=null;
async function render(card){
 me=null;
 if(!isSecureContext){say(card,`<p>Notifications need the secure address. Open <a href="https://${location.hostname}/">https://${location.hostname}/</a> (set up the certificate under Secure connection first).</p>`);return}
 if(isIOS&&!standalone()){say(card,'<p><b>Add Local AI to your Home Screen.</b> In Safari tap Share › Add to Home Screen, then open Local AI from its new icon and come back here. iPhone shows notifications only for Home Screen apps.</p>');return}
 if(!supported()){say(card,'<p>This browser can\'t receive notifications.</p>');return}
 let sub;
 try{sub=await subscription()}catch{say(card,'<p><b>Local AI\'s background service didn\'t start</b>, so this device can\'t receive notifications yet. Reload Local AI and try again.</p>');return}
 const {devices=[]}=await fetch('/api/push/devices',{cache:'no-store'}).then(r=>r.json()).catch(()=>({}));
 me=sub&&devices.find(d=>d.endpoint===sub.endpoint);
 if(sub&&!me){say(card,'<p><b>Notifications stopped on this device.</b> Local AI no longer has this device on its list, for example after it was removed.</p><button type="button" class="btn-primary" data-notify-allow>Turn them on again</button>');return}
 if(!sub){say(card,'<p>Get a notification when Local AI needs you, something fails or goes down, or a long run finishes.</p><button type="button" class="btn-primary" data-notify-allow>Allow notifications</button>');return}
 say(card,settingsHtml(me,devices));
}
async function allow(card){
 const perm=await Notification.requestPermission();
 if(perm!=='granted'){status(card,'Notifications are blocked. Allow them for Local AI in Settings › Notifications, then try again.');return}
 const reg=await workerReady();
 const old=await reg.pushManager.getSubscription();if(old)await old.unsubscribe().catch(()=>{});
 const {publicKey}=await (await fetch('/api/push/key',{cache:'no-store'})).json();
 const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(publicKey)});
 await post('/api/push/subscribe',{subscription:sub.toJSON(),name:deviceName()});
 await render(card);
}
async function save(card,patch){if(!me)return;const {device}=await post('/api/push/devices/update',{id:me.id,...patch});me=device;status(card,'Saved.')}
function mount(){
 const host=q('#status');if(!host||q('.notify-card',host))return;
 const card=document.createElement('section');card.className='card notify-card';card.id='notifications';
 card.innerHTML='<h2>Notifications</h2><div class="notify-body"></div><p class="notify-status meta" role="status"></p>';
 // Below the Appliance summary, so health comes first and the notifications offer second.
 (q(':scope > .two',host)||q('.secure-card',host)||q('.topbar',host))?.after(card);
 card.addEventListener('click',async e=>{
  const rename=e.target.closest('[data-notify-rename]');
  if(rename){const li=rename.closest('li'),b=q('b',li);li.querySelector('.notify-device-actions').innerHTML=`<input class="notify-rename" maxlength="40" value="${esc(b.textContent)}" aria-label="Device name"><button type="button" class="btn-primary" data-notify-rename-save="${esc(rename.dataset.notifyRename)}">Save</button>`;q('.notify-rename',li).focus();return}
  const btn=e.target.closest('[data-notify-allow],[data-notify-test],[data-notify-off],[data-notify-remove],[data-notify-rename-save]');if(!btn)return;
  btn.disabled=true;status(card,'');
  try{
   if(btn.matches('[data-notify-allow]'))await allow(card);
   else if(btn.matches('[data-notify-test]')){
    const r=await post('/api/push/test',me?{id:me.id}:{});
    status(card,r.sent?'Sent. It should arrive in a few seconds.'
     :r.failed?`The push service refused it (${r.error}). Try again in a minute; if it keeps happening, turn notifications off and on again.`
     :r.removed?'This device is no longer subscribed. Turn notifications on again.'
     :'No device is set up for notifications yet.');
    await render(card);
   }
   else if(btn.matches('[data-notify-off]')){const sub=await subscription();if(sub){await post('/api/push/unsubscribe',{endpoint:sub.endpoint});await sub.unsubscribe().catch(()=>{})}await render(card)}
   else if(btn.matches('[data-notify-rename-save]')){await post('/api/push/devices/update',{id:btn.dataset.notifyRenameSave,name:q('.notify-rename',btn.closest('li')).value});await render(card)}
   else{await post('/api/push/devices/remove',{id:btn.dataset.notifyRemove});await render(card)}
  }catch(err){status(card,`That didn't work: ${err.message}`)}
  finally{if(btn.isConnected)btn.disabled=false}
 });
 card.addEventListener('change',e=>{
  const t=e.target;if(!me)return;
  const done=p=>p.catch(err=>status(card,`That didn't work: ${err.message}`));
  if(t.matches('[data-notify-kind]'))done(save(card,{kinds:[...card.querySelectorAll('[data-notify-kind]:checked')].map(x=>x.dataset.notifyKind)}));
  if(t.matches('[data-notify-quiet-on],[data-notify-quiet-start],[data-notify-quiet-end]'))done(save(card,{quiet:{on:q('[data-notify-quiet-on]',card).checked,start:q('[data-notify-quiet-start]',card).value,end:q('[data-notify-quiet-end]',card).value}}));
 });
 render(card);
}
// While Local AI is on screen, tell the appliance, so "finished" notifications don't buzz about what you're watching.
function heartbeat(){if(document.visibilityState==='visible')fetch('/api/push/presence',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{})}
setInterval(heartbeat,30000);document.addEventListener('visibilitychange',heartbeat);heartbeat();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(mount,0),{once:true});else setTimeout(mount,0);
})();
