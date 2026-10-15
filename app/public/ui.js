// Local AI interface scripts: one deferred file. Each section is its own scope and keeps the name of the file it
// replaced; they run in the order the separate scripts used to run.

// ==== ui-kit.js ====
(()=>{'use strict';
const STATUS={awaiting_approval:['Ready to review','accent'],ready:['Ready to review','accent'],needs_attention:['Needs a look','attention'],applied:['Done','good'],completed:['Done','good'],answered:['Done','good'],running:['Running','accent'],failed:['Failed','bad'],queued:['Queued','neutral'],down:['Down','bad'],healthy:['Healthy','good'],optional_offline:['Offline','neutral']};
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
function icon(name,cls){return '<svg class="icon'+(cls?' '+esc(cls):'')+'" aria-hidden="true"><use href="#i-'+esc(name)+'"/></svg>'}
function statusBadge(status){const key=String(status??'').trim().toLowerCase();const hit=STATUS[key];if(hit)return{label:hit[0],tone:hit[1]};const raw=String(status??'').trim().replace(/[_-]+/g,' ');return{label:raw?raw.charAt(0).toUpperCase()+raw.slice(1).toLowerCase():'Unknown',tone:'neutral'}}
function badgeHtml(status){const b=statusBadge(status);return '<span class="badge badge--'+b.tone+'">'+esc(b.label)+'</span>'}
window.LocalAIKit=Object.freeze({icon,statusBadge,badgeHtml});
})();

// ==== agent-specialists.js ====
(()=>{'use strict';
let catalog=[],selected='ux_analyst',source=null,currentMission=null,currentRun=null,history=[],activeResultTab='summary',activeInspectorId='';
const $=id=>document.getElementById(id);
// One shared mission EventSource per tab (agent-specialists.js and agent-world-city.js both subscribe; whichever loads first creates it).
const missionStream=window.LocalAIMissionStream||(window.LocalAIMissionStream=(()=>{const subs=new Set();let es=null;function open(){if(es)return;const s=new EventSource('/api/agents/missions/events');es=s;s.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}for(const x of[...subs])try{x.onMessage?.(m)}catch{}};s.onerror=e=>{for(const x of[...subs])try{x.onError?.(e)}catch{}}}return{subscribe(onMessage,onError){const sub={onMessage,onError};subs.add(sub);try{open()}catch(e){subs.delete(sub);throw e}return()=>subs.delete(sub)}}})());
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
async function req(u,o){const r=await fetch(u,o),j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||('HTTP '+r.status));return j}
function notice(kind,text,actions=''){const el=$('agentInlineNotice');if(!el)return;el.dataset.kind=kind||'info';el.innerHTML='<div><strong>'+esc(kind==='error'?'Needs attention':kind==='success'?'Complete':'Status')+'</strong><span>'+esc(text)+'</span></div>'+actions;el.hidden=false}
function clearNotice(){const el=$('agentInlineNotice');if(el)el.hidden=true}
function humanState(s){return ({pending:'Waiting',running:'Running',complete:'Complete',error:'Needs attention',blocked:'Blocked',needs_attention:'Needs attention',awaiting_approval:'Awaiting approval',apply_requested:'Deployment queued',applied:'Applied'})[s]||String(s||'Unknown').replaceAll('_',' ')}
function cards(){const el=$('specialistRegistry');if(!el)return;el.innerHTML=catalog.filter(a=>!a.infrastructure).map(a=>`<button class="agent-card ${a.id===selected?'active':''}" data-spec="${esc(a.id)}"><span class="agent-card__icon">${esc((a.name||a.id)[0])}</span><span><strong>${esc(a.name)}</strong><small>${esc(a.description)}</small><span class="agent-meta">${(a.capabilities||[]).slice(0,4).map(x=>`<span class="statuschip">${esc(x)}</span>`).join('')}</span></span></button>`).join('');el.querySelectorAll('[data-spec]').forEach(b=>b.onclick=()=>{selected=b.dataset.spec;cards();updateDirectActionLabel()})}
function updateDirectActionLabel(){const a=catalog.find(x=>x.id===selected);const b=$('specialistRunBtn');if(b)b.textContent='Run '+(a?.name||'specialist')}
function manualIds(){return $('manualRouteToggle')?.checked?[...document.querySelectorAll('[data-mission-agent]:checked')].map(x=>x.value):undefined}
function renderRoute(r){const el=$('routePreview');if(!el||!r)return;el.innerHTML=`<div class="route-head"><div><strong>${esc(r.mode==='auto'?'Automatic mission plan':'Manual mission plan')}</strong><small>${esc(r.reason||'')}</small></div><span class="statuschip">${r.workers?.length||0} specialists</span></div><div class="route-flow">${(r.workers||[]).map((w,i)=>{const m=w.routingMeta||{};return `<div class="route-step"><span class="route-step__n">${i+1}</span><span><strong>${esc(w.name)}</strong><small>${esc(w.model||'Auto model')}</small><div class="route-scorebar"><i style="width:${Math.max(0,Math.min(100,m.capabilityScore||0))}%"></i></div><small>Capability ${m.capabilityScore??'—'}% · model fit ${m.modelScore??'—'}% · ${esc(m.availability||'available')}</small><small>${esc(w.reason||'')}</small>${w.dependsOn?.length?`<small>After: ${esc(w.dependsOn.join(', '))}</small>`:''}${m.retryPolicy?.fallbackAgentId?`<small>Fallback: ${esc(m.retryPolicy.fallbackAgentId)}</small>`:''}</span></div>`}).join('')}</div>`}
async function preview(){const goal=$('agentGoal')?.value.trim();if(!goal){notice('error','Enter a mission objective first.');return}clearNotice();const body={goal};const ids=manualIds();if(ids?.length)body.agentIds=ids;const j=await req('/api/agents/dispatch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});renderRoute(j.routing);$('routePreviewWrap')?.removeAttribute('hidden');return j.routing}
function planState(plan){return (plan||[]).map((s,i)=>`<div class="timeline-step ${esc(s.state)}"><span class="timeline-dot"></span><span><strong>${esc(s.name)}</strong><small>${humanState(s.state)}</small></span></div>`).join('')}
function renderRun(r){currentRun=r;const el=$('specialistExecution');if(!el)return;el.innerHTML=`<div class="detail-head"><div><span class="eyebrow">Direct specialist</span><h3>${esc(r.agentName)}</h3></div><span class="statuschip ${esc(r.status)}">${humanState(r.status)}</span></div><div class="timeline-vertical">${planState(r.plan)}</div><div class="execution-output">${esc(r.answer||r.error||'Waiting for output…')}</div>`;if(r.error)notice('error',r.error)}
function workerIcon(w){return (w.name||w.id||'?').trim()[0]?.toUpperCase()||'?'}
function renderTimeline(m){const el=$('agentTimeline');if(!el)return;const workers=m?.workers||[];el.innerHTML=workers.length?workers.map((w,i)=>`<button class="mission-line ${esc(w.state)}" data-worker-id="${esc(w.id)}"><span class="mission-line__rail"><i></i>${i<workers.length-1?'<b></b>':''}</span><span class="mission-line__icon">${esc(workerIcon(w))}</span><span class="mission-line__copy"><strong>${esc(w.name||w.id)}</strong><small>${esc(w.model||w.reason||'')}</small></span><span class="mission-line__state">${humanState(w.state)}</span></button>`).join(''):'<div class="empty">No mission timeline yet.</div>';el.querySelectorAll('[data-worker-id]').forEach(b=>b.onclick=()=>selectWorker(b.dataset.workerId))}
function resultForWorker(id){return currentMission?.results?.find(r=>r.agentId===id)||null}
function selectWorker(id){activeInspectorId=id;renderInspector();window.dispatchEvent(new CustomEvent('localai:agentworld-focus',{detail:{workerId:id}}))}
function renderInspector(){const el=$('agentInspector');if(!el)return;const m=currentMission;if(!m){el.innerHTML='<div class="empty">Select a mission or start new work.</div>';return}const w=(m.workers||[]).find(x=>x.id===activeInspectorId)||(m.workers||[]).find(x=>x.state==='running')||(m.workers||[])[0];if(!w){el.innerHTML='<div class="empty">No worker selected.</div>';return}activeInspectorId=w.id;const r=resultForWorker(w.id),evidence=r?.evidence||[],rm=w.routingMeta||{};el.innerHTML=`<div class="inspector-head"><span class="agent-avatar-lg">${esc(workerIcon(w))}</span><div><span class="eyebrow">Worker inspector</span><h3>${esc(w.name||w.id)}</h3></div><span class="statuschip ${esc(w.state)}">${humanState(w.state)}</span></div><dl class="inspector-grid"><dt>Model</dt><dd>${esc(w.model||r?.model||'Automatic')}</dd><dt>Capability fit</dt><dd>${rm.capabilityScore??'—'}%</dd><dt>Model fit</dt><dd>${rm.modelScore??'—'}%</dd><dt>Availability</dt><dd>${esc(rm.availability||'available')} · load ${rm.workload??0}</dd><dt>Dependencies</dt><dd>${esc((w.dependsOn||[]).join(', ')||'None')}</dd><dt>Grounding</dt><dd>${rm.groundingRequired===false?'Not required':'Required'}</dd><dt>Fallback</dt><dd>${esc(rm.retryPolicy?.fallbackAgentId||'None')}</dd><dt>Evidence</dt><dd>${evidence.length}</dd><dt>Run</dt><dd>${esc(r?.id||m.id)}</dd></dl>${w.reason?`<div class="routing-rationale"><strong>Assignment rationale</strong><span>${esc(w.reason)}</span></div>`:''}${r?.plan?.length?`<div class="mini-plan">${planState(r.plan)}</div>`:''}${evidence.length?`<details class="inspector-details"><summary>Evidence sources</summary><div class="evidence-list">${evidence.map(x=>`<code>${esc(x)}</code>`).join('')}</div></details>`:''}${r?.answer?`<details class="inspector-details" open><summary>Worker output</summary><pre class="agent-result-pre">${esc(r.answer)}</pre></details>`:r?.error?`<div class="inline-error">${esc(r.error)}</div>`:''}`}
function missionSummary(m){const done=(m.workers||[]).filter(w=>w.state==='complete').length,total=(m.workers||[]).length;return {done,total,percent:total?Math.round(done/total*100):0}}
function renderMission(m){if(!m)return;currentMission=m;if(m.routing)renderRoute(m.routing);const s=missionSummary(m),headline=$('agentMissionHeadline'),meta=$('agentMissionMeta'),progress=$('agentMissionProgress');if(headline)headline.textContent=m.goal||'Mission';if(meta)meta.textContent=humanState(m.status)+' · '+s.done+'/'+s.total+' workers complete';if(progress)progress.style.width=s.percent+'%';renderTimeline(m);renderInspector();renderResults();renderHistorySelection();if(m.status==='needs_attention'||m.status==='error')notice('error',m.error||'Mission needs attention.','<button type="button" class="btn" id="agentRetryBtn">Retry mission</button>');else if(m.status==='complete')notice('success','Mission completed successfully.');else clearNotice();setTimeout(()=>{const b=$('agentRetryBtn');if(b)b.onclick=retryMission},0)}
function retryMission(){if(!currentMission?.goal)return;const g=$('agentGoal');if(g)g.value=currentMission.goal;startMission()}
function renderResults(){const el=$('agentResultBody');if(!el)return;const m=currentMission;if(!m){el.innerHTML='<div class="empty">Mission results will appear here.</div>';return}
 if(activeResultTab==='summary'){el.innerHTML=m.answer?`<pre class="agent-result-pre">${esc(m.answer)}</pre>`:`<div class="empty">${m.status==='running'?'Final synthesis will appear when all workers complete.':'No final synthesis available.'}</div>`}
 if(activeResultTab==='workers'){el.innerHTML=(m.results||[]).length?(m.results||[]).map(r=>`<article class="result-card"><div class="detail-head"><strong>${esc(r.agentName||r.agentId)}</strong><span class="statuschip ${esc(r.status)}">${humanState(r.status)}</span></div><pre class="agent-result-pre">${esc(r.answer||r.error||'')}</pre></article>`).join(''):'<div class="empty">No specialist outputs yet.</div>'}
 if(activeResultTab==='evidence'){const rows=[];(m.results||[]).forEach(r=>(r.evidence||[]).forEach(e=>rows.push([r.agentName||r.agentId,e])));el.innerHTML=rows.length?`<div class="evidence-table">${rows.map(([a,e])=>`<div><strong>${esc(a)}</strong><code>${esc(e)}</code></div>`).join('')}</div>`:'<div class="empty">No evidence recorded yet.</div>'}
 if(activeResultTab==='routing'){el.innerHTML=m.routing?`<pre class="agent-result-pre">${esc(JSON.stringify(m.routing,null,2))}</pre>`:'<div class="empty">No routing decision available.</div>'}
}
function renderHistory(){const el=$('agentMissionHistory');if(!el)return;el.innerHTML=history.length?history.slice(0,20).map(m=>{const s=missionSummary(m);return `<button class="history-row ${m.id===currentMission?.id?'active':''}" data-mission-id="${esc(m.id)}"><span class="history-state ${esc(m.status)}"></span><span><strong>${esc(m.goal||m.id)}</strong><small>${humanState(m.status)} · ${s.done}/${s.total} workers · ${new Date(m.updatedAt||m.createdAt).toLocaleString()}</small></span><span>›</span></button>`}).join(''):'<div class="empty">No missions yet. Describe a goal above to run your first one.</div>';el.querySelectorAll('[data-mission-id]').forEach(b=>b.onclick=()=>{const m=history.find(x=>x.id===b.dataset.missionId);if(m){renderMission(m);window.dispatchEvent(new CustomEvent('localai:agentworld-replay-mission',{detail:{mission:m}}))}});applyHistoryFilter()}
function renderHistorySelection(){renderHistory()}
async function loadHistory(){try{const j=await req('/api/agents/missions');history=j.items||j.missions||[];renderHistory();if(!currentMission&&history[0])renderMission(history.find(m=>m.status==='running')||history[0])}catch(e){notice('error','Could not load mission history: '+e.message)}}
async function startMission(){const goal=$('agentGoal')?.value.trim();if(!goal){notice('error','Enter a mission objective first.');return}const body={goal,projectId:$('agentProject')?.value||''},ids=manualIds();if(ids?.length)body.agentIds=ids;const b=$('missionRunBtn');if(b){b.disabled=true;b.textContent='Starting…'}clearNotice();try{await preview();notice('info','Mission accepted. Agent World will update live as workers execute.');req('/api/agents/missions/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(j=>{if(j.mission)renderMission(j.mission);loadHistory()}).catch(e=>{notice('error',e.message,'<button type="button" class="btn" id="agentRetryBtn">Retry</button>');setTimeout(()=>{const r=$('agentRetryBtn');if(r)r.onclick=startMission},0)})}catch(e){notice('error',e.message)}finally{if(b){b.disabled=false;b.textContent='Start Mission'}}}
async function runSpecialist(){const goal=$('agentGoal')?.value.trim();if(!goal){notice('error','Enter an objective first.');return}const b=$('specialistRunBtn');if(b)b.disabled=true;try{const j=await req('/api/agents/specialist/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:selected,goal,projectId:$('agentProject')?.value||''})});renderRun(j.run)}catch(e){notice('error',e.message)}finally{if(b)b.disabled=false}}
function setupTabs(){document.querySelectorAll('[data-agent-result-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-agent-result-tab]').forEach(x=>x.classList.toggle('active',x===b));activeResultTab=b.dataset.agentResultTab;renderResults()})}
function setupAdvanced(){const toggle=$('agentAdvancedToggle'),panel=$('agentAdvancedPanel');if(toggle&&panel)toggle.onclick=()=>{const open=panel.hidden;panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));toggle.textContent=open?'Hide advanced routing':'Advanced routing'};$('manualRouteToggle')?.addEventListener('change',e=>{$('manualRouteOptions').hidden=!e.target.checked})}
function applyHistoryFilter(){const term=($('agentHistorySearch')?.value||'').toLowerCase();document.querySelectorAll('.history-row').forEach(r=>r.hidden=!r.textContent.toLowerCase().includes(term))}
function setupHistoryFilter(){const q=$('agentHistorySearch');if(q)q.addEventListener('input',applyHistoryFilter)}
async function init(){if(!$('specialistRegistry'))return;try{const j=await req('/api/agents/catalog');catalog=j.items||[];cards();updateDirectActionLabel()}catch(e){notice('error','Could not load specialist catalog: '+e.message)}setupTabs();setupAdvanced();setupHistoryFilter();$('routePreviewBtn')?.addEventListener('click',()=>preview().catch(e=>notice('error',e.message)));$('specialistRunBtn')?.addEventListener('click',runSpecialist);$('missionRunBtn')?.addEventListener('click',startMission);await loadHistory();try{source=source||missionStream.subscribe(m=>{const ix=history.findIndex(x=>x.id===m.id);if(ix>=0)history[ix]=m;else history.unshift(m);if(!currentMission||m.id===currentMission.id)renderMission(m);else renderHistory()},()=>notice('info','Live mission stream reconnecting…'))}catch{notice('info','Live mission stream unavailable; history remains accessible.')}}
window.addEventListener('localai:agentworld-select',e=>{if(e.detail?.workerId)selectWorker(e.detail.workerId)});
window.LocalAISpecialists={init,preview,renderMission};
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

  function navigate(view) {
    if (!view) return;
    if (view === 'models' && activateView(view)) return;
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
          <p id="truthAttentionSummary">Checking live capability state…</p>
        </div>
        <span id="truthAttentionCount" class="pill truth-attention-count">Checking</span>
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
            <p class="sub">Installed Ollama models and the models currently resident in memory.</p>
          </div>
          <button id="modelRuntimeRefresh" class="btn" type="button">Refresh</button>
        </div>
        <div id="modelRuntimeSummary" class="model-runtime-summary" aria-live="polite"></div>
        <div class="card model-download" style="margin-top:12px">
          <div class="section-head"><div><h2>Download a model</h2><p>From the Ollama library, stored on the Windows host. A 4B model is about 2.5 GB.</p></div></div>
          <form id="modelPullForm" class="model-pull-form">
            <input id="modelPullName" list="modelPullSuggestions" placeholder="Model name, for example gemma3:4b" aria-label="Model name" autocomplete="off" autocapitalize="off" spellcheck="false">
            <button class="btn primary" type="submit">Download</button>
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
            <div><h2>Installed models</h2><p>Runtime residency is read from Ollama /api/ps. Idle models can unload normally.</p></div>
          </div>
          <div id="modelRuntimeList" class="model-runtime-list"><div class="empty">Loading model runtime…</div></div>
          <div id="modelRuntimeNote" class="model-runtime-note">Model residency is runtime state, not an availability requirement.</div>
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
      button.innerHTML = '<span class="navicon">M</span>Models';
      button.addEventListener('click', () => {
        activateView('models');
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

    gateMode('ask', intelligenceReady, 'local intelligence service is not healthy');
    gateMode('research', researchReady, !intelligenceReady
      ? 'local intelligence service is not healthy'
      : 'web research service is not healthy');
    gateMode('create', createReady, healthy(snapshot, 'comfy')
      ? 'no supported local image model is currently available'
      : 'image generation service is not healthy');
    gateMode('automate', automateReady, 'automation engine is not healthy');
    gateMode('engineering', intelligenceReady, 'local intelligence service is not healthy');

    const webSearch = document.getElementById('webSearch');
    if (webSearch) setTruthAvailability(webSearch, healthy(snapshot, 'search'), 'Unavailable: web research service is not healthy');
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
          detail: item.impact || 'A core capability is affected.',
          action: 'Open Health',
          view: 'status'
        });
      });

    const models = snapshot?.models;
    if (healthy(snapshot, 'ollama') && models?.available === false) {
      items.push({
        severity: 'warning',
        title: 'Model inventory could not be verified',
        detail: models.runtimeError || 'Ollama is reachable, but installed model inventory is unavailable.',
        action: 'Open Models',
        view: 'models'
      });
    } else if (healthy(snapshot, 'ollama') && models?.available === true && models.default && models.defaultInstalled === false) {
      items.push({
        severity: 'critical',
        title: 'Configured default model is not installed',
        detail: `${models.default} is configured as the default but is not present in the verified Ollama inventory.`,
        action: 'Open Models',
        view: 'models'
      });
    }

    if (healthy(snapshot, 'ollama') && models?.available === true && models.runtimeAvailable === false) {
      items.push({
        severity: 'info',
        title: 'Active model residency is unavailable',
        detail: models.runtimeError || 'Installed models are known, but Ollama /api/ps runtime detail could not be read.',
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
        action: 'Open change requests',
        view: 'changes'
      });
    }

    if (Number(snapshot?.issues?.open || 0) > 0) {
      const count = Number(snapshot.issues.open);
      items.push({
        severity: 'warning',
        title: `${count} autonomous ${count === 1 ? 'issue is' : 'issues are'} open`,
        detail: 'Quality scans have unresolved findings.',
        action: 'Open issues',
        view: 'issues'
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
      surface.hidden = false;
      surface.dataset.state = 'attention';
      summary.textContent = 'Live capability state could not be verified. Existing controls remain available.';
      count.textContent = 'State unavailable';
      const row = document.createElement('div');
      row.className = 'truth-attention-item';
      row.dataset.severity = 'critical';
      row.innerHTML = '<span class="truth-attention-marker" aria-hidden="true"></span><div class="truth-attention-copy"><strong>Capability registry unavailable</strong><span>Local AI could not verify the current runtime state. Open Status for diagnostics.</span></div>';
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'btn truth-attention-action';
      action.textContent = 'Open Health';
      action.addEventListener('click', () => navigate('status'));
      row.appendChild(action);
      list.appendChild(row);
      return;
    }

    const items = attentionItems(snapshot);
    // Nothing to do: hide the card. The Healthy pill in the page header already says all is well.
    surface.hidden = !items.length;
    if (!items.length) {
      surface.dataset.state = 'clear';
      summary.textContent = 'No action is required. Core capabilities currently report ready.';
      count.textContent = 'Clear';
      return;
    }

    surface.dataset.state = 'attention';
    const critical = items.filter((item) => item.severity === 'critical').length;
    const warnings = items.filter((item) => item.severity === 'warning').length;
    summary.textContent = critical
      ? `${critical} critical ${critical === 1 ? 'item requires' : 'items require'} attention.`
      : `${warnings || items.length} ${warnings === 1 ? 'item needs' : 'items need'} review.`;
    count.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;

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
      action.className = 'btn truth-attention-action';
      action.textContent = item.action;
      action.addEventListener('click', () => navigate(item.view));

      row.append(marker, copy, action);
      list.appendChild(row);
    });
  }

  function renderHomeModelTruth(snapshot) {
    const box = document.getElementById('homeCapabilities');
    const models = snapshot?.models;
    if (!box || !models) return;

    let tile = document.getElementById('truthModelCapabilityTile');
    if (!tile) {
      tile = document.createElement('button');
      tile.type = 'button';
      tile.id = 'truthModelCapabilityTile';
      tile.className = 'cap-tile cap-chip truth-model-capability';
      tile.addEventListener('click', () => navigate('models'));
      box.appendChild(tile);
    }

    if (models.available === false) {
      tile.innerHTML = '<b>Unknown</b><span>models</span>';
      tile.title = models.runtimeError || 'Model inventory unavailable';
      return;
    }

    tile.innerHTML = `<b>${Number(models.loadedCount || 0)}/${Number(models.installedCount || 0)}</b><span>models loaded</span>`;
    tile.setAttribute('aria-label', `${Number(models.loadedCount || 0)} of ${Number(models.installedCount || 0)} installed models loaded`);
    tile.title = models.default ? `Configured default: ${models.default}` : 'Open model runtime details';
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
      <div class="model-runtime-metric"><strong>${runtimeLabel}</strong><span>Runtime detail</span></div>`;

    if (models?.available === false) {
      list.innerHTML = `<div class="model-runtime-note model-runtime-error"><strong>Model inventory unavailable</strong><div style="margin-top:4px">${esc(models.runtimeError || 'Ollama model inventory could not be read.')}</div></div>`;
      note.textContent = 'The application will not infer installed model state while inventory is unavailable.';
      return;
    }

    if (!installed.length) {
      list.innerHTML = '<div class="empty">No models installed yet. Download one above; start with the default, qwen3:4b-instruct-32k.</div>';
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
        [detail.family, detail.parameterSize, detail.quantizationLevel, detail.format]
          .filter(Boolean)
          .forEach((value) => {
            const chip = document.createElement('span');
            chip.className = 'badge';
            chip.textContent = value;
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
          actions.innerHTML = `<button type="button" class="btn" data-model-remove="${esc(item.name)}">Remove</button>`;
        }
        card.appendChild(actions);
        list.appendChild(card);
      });
    }

    if (models?.default && models.defaultInstalled === false) {
      note.classList.add('model-runtime-error');
      note.textContent = `Configured default ${models.default} is not installed. Requests using the configured default can fail until the model configuration or inventory is corrected.`;
    } else if (models?.runtimeAvailable === false) {
      note.classList.add('model-runtime-error');
      note.textContent = `Installed model inventory is available, but active residency detail is not: ${models.runtimeError || 'Ollama /api/ps unavailable.'}`;
    } else {
      note.classList.remove('model-runtime-error');
      note.textContent = Number(models?.loadedCount || 0) === 0
        ? 'No model is resident right now. This is normal: Ollama loads models on demand and may unload them after idle time.'
        : 'Loaded means currently resident in Ollama runtime memory. Installed models remain available even when they are not loaded.';
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
        renderHomeModelTruth(lastTruthSnapshot);
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
        <div class="model-pull-head"><strong>${esc(p.name)}</strong><span>${label}</span>${p.state === 'running' ? `<button type="button" class="btn" data-pull-cancel="${esc(p.name)}">Cancel</button>` : ''}</div>
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
        <button type="button" class="btn danger" data-model-remove-confirm="${esc(name)}">Remove</button>
        <button type="button" class="btn" data-model-remove-cancel="${esc(name)}">Keep</button>`;
      actions.querySelector('[data-model-remove-cancel]')?.focus();
    } else if (button.dataset.modelRemoveCancel) {
      actions.innerHTML = `<button type="button" class="btn" data-model-remove="${esc(button.dataset.modelRemoveCancel)}">Remove</button>`;
    } else {
      const name = button.dataset.modelRemoveConfirm;
      button.disabled = true;
      button.textContent = 'Removing…';
      try {
        await modelPost('/api/models/delete', { name });
        refreshModelsSurface();
      } catch (error) {
        actions.innerHTML = `<span class="model-pull-error">${esc(error.message)}</span><button type="button" class="btn" data-model-remove="${esc(name)}">Remove</button>`;
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
      if (!response.ok) throw new Error(`Capability registry returned HTTP ${response.status}`);
      const snapshot = await response.json();
      lastTruthSnapshot = snapshot;
      applyCapabilityGates(snapshot);
      renderHomeModelTruth(snapshot);
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
const DESCRIPTIONS=Object.fromEntries(REG.VIEWS.map(v=>[v.id,v.description]));
const q=(s,r=document)=>r.querySelector(s),qa=(s,r=document)=>[...r.querySelectorAll(s)];
let currentDomain='home',sheetOpen=false,allButtons=new Map();
// Sprite icons (index.html) for the phone header and tab bar; decorative, every button also has a text label.
const icon=(name,cls)=>window.LocalAIKit?.icon(name,cls)||'';

function viewButton(view){return allButtons.get(view)||q('.navbtn[data-view="'+view+'"]')}
function domainForView(view){const id=REG.view(view)?.domain;return DOMAINS.find(d=>d.id===id)||DOMAINS[0]}
// Tabs share their parent's nav entry and breadcrumb.
function pageForView(view){return REG.page(view)?.id||view}
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
 if(synthetic&&activateSyntheticView(view))return;
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
   const b=document.createElement('button');b.type='button';b.className='navbtn';b.dataset.view='integrations';b.dataset.uxSynthetic='true';b.innerHTML='<span class="navicon">'+REG.view('integrations').icon+'</span>'+REG.label('integrations');
   b.addEventListener('click',e=>{e.preventDefault();activateSyntheticView('integrations')});
   nav.appendChild(b);
 }
}

function buildDesktopNav(){
 const aside=q('.app>aside'),nav=q('.app>aside nav');if(!aside||!nav)return;
 const originals=qa('.navbtn[data-view]',nav);allButtons=new Map(originals.map(b=>[b.dataset.view,b]));
 const registry=document.createElement('div');registry.id='uxNavRegistry';registry.hidden=true;originals.forEach(b=>registry.appendChild(b));aside.appendChild(registry);
 const shell=document.createElement('div');shell.className='ux-nav-shell';
 const rail=document.createElement('div');rail.className='ux-primary-rail';rail.setAttribute('aria-label','Primary navigation');
 const secondary=document.createElement('div');secondary.className='ux-secondary-nav';
 const secondaryHead=document.createElement('div');secondaryHead.className='ux-secondary-head';secondaryHead.innerHTML='<div><strong id="uxSecondaryTitle">Home</strong><small id="uxSecondaryTagline"></small></div><button type="button" class="ux-nav-collapse" data-nav-collapse="true" aria-label="Hide page list" title="Hide page list">‹</button>';
 const groups=document.createElement('div');groups.className='ux-secondary-groups';groups.id='uxSecondaryGroups';
 secondary.append(secondaryHead,groups);
 DOMAINS.forEach(d=>{
   const b=document.createElement('button');b.type='button';b.className='ux-primary-item';b.dataset.domain=d.id;b.title=d.label;b.innerHTML='<span class="ux-primary-symbol">'+d.symbol+'</span><span>'+d.label+'</span>';
   b.addEventListener('click',()=>navigate(d.defaultView));
   rail.appendChild(b);
 });
 const expand=document.createElement('button');expand.type='button';expand.className='ux-nav-expand';expand.dataset.navCollapse='false';expand.setAttribute('aria-label','Show page list');expand.title='Show page list';expand.textContent='›';rail.appendChild(expand);
 shell.append(rail,secondary);nav.replaceWith(shell);
 shell.addEventListener('click',e=>{const t=e.target.closest('[data-nav-collapse]');if(t)setCollapsed(t.dataset.navCollapse==='true',true)});
 setCollapsed(prefGet('localai.navCollapsed')==='1');
 renderSecondary('home');
}
function renderSecondary(domainId){
 const d=DOMAINS.find(x=>x.id===domainId)||DOMAINS[0],holder=q('#uxSecondaryGroups'),registry=q('#uxNavRegistry');if(!holder)return;
 qa('.navbtn[data-view]',holder).forEach(b=>registry?.appendChild(b));
 q('#uxSecondaryTitle').textContent=d.label;q('#uxSecondaryTagline').textContent=d.tagline;
 holder.innerHTML='';
 d.groups.forEach(g=>{
   const section=document.createElement('section');section.className='ux-secondary-section';
   const h=document.createElement('div');h.className='ux-secondary-label';h.textContent=g.label;section.appendChild(h);
   g.views.forEach(v=>{const src=viewButton(v);if(!src)return;const b=src;b.classList.add('ux-secondary-link');b.title=DESCRIPTIONS[v]||'';b.setAttribute('aria-description',DESCRIPTIONS[v]||'');b.innerHTML='<span class="ux-link-icon" aria-hidden="true">'+(REG.view(v)?.icon||'')+'</span><span class="ux-link-label">'+labelForView(v)+'</span>';section.appendChild(b)});
   holder.appendChild(section);
 });
}
function buildTabs(){
 for(const v of REG.VIEWS){
   if(!v.parent)continue;
   for(const t of REG.tabs(v.id)){
     const section=q('#'+t.id);if(!section||q('.ux-tabs',section))continue;
     const strip=document.createElement('div');strip.className='ux-tabs';strip.setAttribute('role','tablist');strip.setAttribute('aria-label',REG.label(REG.page(t.id).id)+' sections');
     REG.tabs(t.id).forEach(x=>{const b=document.createElement('button');b.type='button';b.className='ux-tab';b.setAttribute('role','tab');b.dataset.uxTab=x.id;b.textContent=x.tab||x.label;b.addEventListener('click',()=>navigate(x.id));strip.appendChild(b)});
     const top=q('.topbar',section);if(top)top.after(strip);else section.prepend(strip);
   }
 }
}
function buildContext(){
 const main=q('main');if(!main||q('#uxContextBar'))return;
 const bar=document.createElement('header');bar.id='uxContextBar';bar.className='ux-context-bar';
 bar.innerHTML='<div class="ux-context-left"><span class="ux-context-brand"><span class="brandmark ux-context-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12c2.6-5.6 11.4-5.6 14 0-2.6 5.6-11.4 5.6-14 0Z" stroke="#0b0d11" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="#0b0d11"/></svg></span><span class="ux-context-brand-names"><small id="uxContextGreeting"></small><strong>Local AI</strong></span></span><button class="ux-breadcrumb-home" type="button" data-ux-go="home">Local AI</button><span class="ux-context-sep">/</span><span class="ux-context-domain" id="uxContextDomain">Home</span><span class="ux-context-sep">/</span><span class="ux-context-view" id="uxContextView">Overview</span></div><div class="ux-context-actions"><button class="ux-context-action icon-btn" type="button" id="uxHeaderAction" hidden></button><button class="ux-context-inbox" type="button" id="uxInboxBtn" data-empty="true" aria-label="Inbox" hidden>'+icon('bell','ux-ico')+'<span>Inbox</span><b id="uxInboxCount">0</b></button><button class="ux-context-search" type="button" id="uxCommandBtn" aria-label="Search commands">'+icon('search','ux-ico')+'<span>Search commands</span><kbd>⌘K</kbd></button><button class="ux-context-menu" id="uxContextMenu" type="button" aria-expanded="false" aria-label="Pages in this section"><span>Menu</span>'+icon('chevron-down','ux-ico')+'</button></div>';
 main.prepend(bar);
 q('[data-ux-go="home"]')?.addEventListener('click',()=>navigate('home'));
 q('#uxCommandBtn')?.addEventListener('click',()=>{const cmd=q('#cmdk');if(cmd){cmd.classList.add('show');cmd.setAttribute('aria-hidden','false');q('#cmdkInput')?.focus()}});
 q('#uxContextMenu')?.addEventListener('click',()=>toggleSheet());
 // Unread alerts plus approvals waiting, reported by app.js after it loads Inbox or Approvals.
 let inbox={unread:0,pending:0};
 window.addEventListener('localai:inbox-count',e=>{inbox={...inbox,...e.detail};const total=inbox.unread+inbox.pending,b=q('#uxInboxBtn');if(!b)return;b.hidden=total===0;b.dataset.empty=String(total===0);q('#uxInboxCount').textContent=String(total);b.setAttribute('aria-label',total?`Inbox, ${total} waiting: ${inbox.unread} unread, ${inbox.pending} approvals waiting`:'Inbox')});
 q('#uxInboxBtn')?.addEventListener('click',()=>navigate(inbox.pending&&!inbox.unread?'approvals':'inbox'));
}
// A page's single action (Health: Check again) shows as an icon in the phone header while that page is open.
const headerActions=new Map();
function syncHeaderAction(view){const b=q('#uxHeaderAction');if(!b)return;const a=headerActions.get(REG.resolve(view||activeView()));b.hidden=!a;q('#uxContextBar')?.classList.toggle('ux-context-has-action',!!a);if(!a){b.onclick=null;return}b.innerHTML=icon(a.icon,'ux-ico');b.setAttribute('aria-label',a.label);b.onclick=a.onClick}
window.LocalAIShell={setAction(view,action){headerActions.set(view,action);syncHeaderAction()},clearAction(view){headerActions.delete(view);syncHeaderAction()}};
// Health's refresh lives in the header on phones; the page's own button stays for desktop.
window.LocalAIShell.setAction('status',{icon:'refresh',label:'Check again',onClick:()=>q('#statusRetryBtn')?.click()});
function greeting(){const h=new Date().getHours();return h<12?'Good morning':h<18?'Good afternoon':'Good evening'}
function prefGet(k){try{return localStorage.getItem(k)}catch{return null}}
function prefSet(k,v){try{localStorage.setItem(k,v)}catch{}}
function setCollapsed(on,fromUser){document.body.classList.toggle('ux-nav-collapsed',on);if(fromUser){prefSet('localai.navCollapsed',on?'1':'0');q(on?'.ux-nav-expand':'.ux-nav-collapse')?.focus()}}
function buildPageStrip(){
 const bar=q('#uxContextBar');if(!bar||q('#uxPageStrip'))return;
 const strip=document.createElement('nav');strip.id='uxPageStrip';strip.className='ux-page-strip';strip.setAttribute('aria-label','Pages in this section');
 bar.after(strip);
 strip.addEventListener('click',e=>{const b=e.target.closest('[data-strip-view]');if(b){toggleSheet(false);navigate(b.dataset.stripView)}});
}
function renderPageStrip(d,page){
 const strip=q('#uxPageStrip');if(!strip)return;
 const views=d.groups.flatMap(g=>g.views).filter(v=>viewButton(v));
 const key=d.id+'|'+views.join(',');
 if(strip.dataset.key!==key){strip.dataset.key=key;strip.innerHTML=views.map(v=>'<button type="button" data-strip-view="'+v+'">'+(REG.view(v)?.short||labelForView(v))+'</button>').join('');}
 strip.hidden=views.length<2||d.id==='home'; // Home's only other page, Inbox, already has a button in the top bar
 qa('[data-strip-view]',strip).forEach(b=>{const on=b.dataset.stripView===page;b.classList.toggle('active',on);if(on){b.setAttribute('aria-current','page');if(strip.scrollWidth>strip.clientWidth)strip.scrollLeft=Math.max(0,b.offsetLeft-strip.clientWidth/2+b.offsetWidth/2)}else b.removeAttribute('aria-current')});
}
function buildMobile(){
 if(q('#uxMobileNav'))return;
 const nav=document.createElement('div');nav.id='uxMobileNav';nav.className='ux-mobile-nav';nav.setAttribute('role','navigation');nav.setAttribute('aria-label','Primary navigation');
 DOMAINS.forEach(d=>{const b=document.createElement('button');b.type='button';b.dataset.domain=d.id;b.innerHTML='<b>'+(icon(d.icon)||d.symbol)+'</b><span>'+d.label+'</span>';b.addEventListener('click',()=>{toggleSheet(false);navigate(d.defaultView)});nav.appendChild(b)});
 const sheet=document.createElement('div');sheet.id='uxMobileSheet';sheet.className='ux-mobile-sheet';sheet.dataset.open='false';sheet.innerHTML='<div class="ux-mobile-sheet-handle"></div><div class="ux-mobile-sheet-head"><div><span class="ux-secondary-kicker">Navigate</span><strong id="uxMobileSheetTitle"></strong><small id="uxMobileSheetTagline"></small></div><button type="button" id="uxMobileSheetClose" aria-label="Close menu">×</button></div><div class="ux-mobile-sheet-items" id="uxMobileSheetItems"></div>';
 sheet.inert=true;sheet.setAttribute('aria-hidden','true');document.body.append(sheet,nav);q('#uxMobileSheetClose')?.addEventListener('click',()=>toggleSheet(false));
 document.addEventListener('click',e=>{if(sheetOpen&&!sheet.contains(e.target)&&!nav.contains(e.target)&&!e.target.closest?.('#uxContextMenu'))toggleSheet(false)});
}
function renderSheet(){
 const d=DOMAINS.find(x=>x.id===currentDomain)||DOMAINS[0],holder=q('#uxMobileSheetItems');if(!holder)return;
 q('#uxMobileSheetTitle').textContent=d.label;q('#uxMobileSheetTagline').textContent=d.tagline;holder.innerHTML='';
 d.groups.forEach(g=>{const section=document.createElement('section');section.className='ux-mobile-section';section.innerHTML='<div class="ux-mobile-section-label">'+g.label+'</div>';g.views.forEach(v=>{if(!viewButton(v))return;const b=document.createElement('button');b.type='button';b.className='ux-mobile-link '+(v===pageForView(activeView())?'active':'');b.innerHTML='<span><strong>'+labelForView(v)+'</strong><small>'+DESCRIPTIONS[v]+'</small></span><span>›</span>';b.addEventListener('click',()=>{navigate(v);toggleSheet(false)});section.appendChild(b)});holder.appendChild(section)});
}
function toggleSheet(force){sheetOpen=typeof force==='boolean'?force:!sheetOpen;const s=q('#uxMobileSheet');if(s){s.dataset.open=String(sheetOpen);s.inert=!sheetOpen;s.setAttribute('aria-hidden',String(!sheetOpen))}q('#uxContextMenu')?.setAttribute('aria-expanded',String(sheetOpen));document.body.classList.toggle('ux-sheet-open',sheetOpen);if(sheetOpen)renderSheet()}
function sync(forced){
 const view=REG.resolve(forced||activeView()),d=domainForView(view);currentDomain=d.id;document.body.dataset.domain=d.id;document.body.dataset.view=view;
 const page=pageForView(view),viewLabel=labelForView(page);renderPageStrip(d,page);q('#uxContextDomain').textContent=d.label;q('#uxContextView').textContent=viewLabel;q('#uxContextBar')?.classList.toggle('ux-context-same',viewLabel===d.label);q('#uxContextBar')?.classList.toggle('ux-context-has-strip',!q('#uxPageStrip')?.hidden);q('#uxContextMenu')?.setAttribute('aria-label',d.label+' pages');syncHeaderAction(view);{const g=q('#uxContextGreeting');if(g)g.textContent=greeting()};
 qa('.ux-primary-item').forEach(b=>b.dataset.active=String(b.dataset.domain===d.id));
 qa('#uxMobileNav [data-domain]').forEach(b=>b.dataset.active=String(b.dataset.domain===d.id));
 if(q('#uxSecondaryTitle')?.textContent!==d.label)renderSecondary(d.id);
 qa('.ux-secondary-link').forEach(b=>b.classList.toggle('active',b.dataset.view===page));
 qa('.ux-tab').forEach(b=>{const on=b.dataset.uxTab===view;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on))});
 if(sheetOpen)renderSheet();
}
function observeViews(){const views=qa('.view');if(!views.length)return;const mo=new MutationObserver(()=>sync());views.forEach(v=>mo.observe(v,{attributes:true,attributeFilter:['class']}));document.addEventListener('click',e=>{const b=e.target.closest?.('.navbtn[data-view]');if(b)requestAnimationFrame(()=>sync(b.dataset.view))})}
function init(){document.body.classList.add('ux-v3');buildIntegrationsView();buildTabs();buildDesktopNav();buildContext();buildPageStrip();buildMobile();observeViews();sync()}
if(document.readyState==='complete')init();else window.addEventListener('load',init,{once:true});
})();

// ==== agent-world-city.js ====
(()=>{'use strict';
const W=1280,H=760,T=32,COLS=Math.floor(W/T),ROWS=Math.floor(H/T);
const $=(s,r=document)=>r.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n)),key=(x,y)=>x+','+y,now=()=>performance.now();
// One shared mission EventSource per tab (agent-specialists.js and agent-world-city.js both subscribe; whichever loads first creates it).
const missionStream=window.LocalAIMissionStream||(window.LocalAIMissionStream=(()=>{const subs=new Set();let es=null;function open(){if(es)return;const s=new EventSource('/api/agents/missions/events');es=s;s.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}for(const x of[...subs])try{x.onMessage?.(m)}catch{}};s.onerror=e=>{for(const x of[...subs])try{x.onError?.(e)}catch{}}}return{subscribe(onMessage,onError){const sub={onMessage,onError};subs.add(sub);try{open()}catch(e){subs.delete(sub);throw e}return()=>subs.delete(sub)}}})());

const DISTRICTS={
 command:{name:'Command Center',short:'Command',x:17,y:9,w:6,h:5,accent:'#71b7ff',roof:'#315f94',icon:'⌂',kind:'hq'},
 ux:{name:'UX Lab',short:'UX',x:4,y:4,w:6,h:4,accent:'#59e2ed',roof:'#197d8b',icon:'UX',kind:'lab'},
 docs:{name:'Documentation Studio',short:'Docs',x:29,y:4,w:6,h:4,accent:'#c498ff',roof:'#73509b',icon:'D',kind:'studio'},
 engineering:{name:'Engineering Bay',short:'Build',x:4,y:17,w:7,h:5,accent:'#ffb86a',roof:'#975c24',icon:'E',kind:'bay'},
 validation:{name:'Validation Lab',short:'Validate',x:29,y:17,w:6,h:5,accent:'#75dfa2',roof:'#347650',icon:'V',kind:'lab'},
 models:{name:'Model Foundry',short:'Models',x:16,y:19,w:8,h:4,accent:'#ff8494',roof:'#8e3747',icon:'M',kind:'foundry'},
 projects:{name:'Projects Quarter',short:'Projects',x:15,y:2,w:10,h:4,accent:'#8db7ff',roof:'#405f95',icon:'P',kind:'archive'},
 repair:{name:'Repair Bay',short:'Repair',x:32,y:10,w:5,h:4,accent:'#ff7383',roof:'#8c3542',icon:'!',kind:'repair'}
};
const ROLE_ZONE={router:'command',mission_router:'command',ux_analyst:'ux',documentation:'docs',synthesis:'command',coordinator:'command',engineer:'engineering',validator:'validation',reviewer:'command',deployer:'engineering',operator:'validation',code_analyst:'engineering',test_engineer:'validation',research_agent:'projects',security_reviewer:'validation',performance_analyst:'models'};
const ROLE_COLOR={router:'#71b7ff',mission_router:'#71b7ff',ux_analyst:'#59e2ed',documentation:'#c498ff',synthesis:'#a8b5ff',coordinator:'#a8b5ff',engineer:'#ffb86a',validator:'#75dfa2',reviewer:'#c498ff',deployer:'#ffb86a',operator:'#75dfa2',code_analyst:'#ffb86a',test_engineer:'#75dfa2',research_agent:'#8db7ff',security_reviewer:'#ff8494',performance_analyst:'#ff8494'};
const ROLE_STYLE={
 router:{skin:'#d9a77f',hair:'#2a211e',shirt:'#d9792c',vest:'#ff9d33',pants:'#6b4a2f',accent:'#71b7ff',tool:'headset',hat:'#f2bf3e',badge:'R'},
 mission_router:{skin:'#d9a77f',hair:'#2a211e',shirt:'#d9792c',vest:'#ff9d33',pants:'#6b4a2f',accent:'#71b7ff',tool:'headset',hat:'#f2bf3e',badge:'R'},
 ux_analyst:{skin:'#e6b98d',hair:'#6c3f35',shirt:'#d87e30',vest:'#ffa43b',pants:'#6e4d32',accent:'#59e2ed',tool:'tablet',hat:'#f6c548',badge:'UX'},
 documentation:{skin:'#c99572',hair:'#332522',shirt:'#c9712c',vest:'#ff9d33',pants:'#60452f',accent:'#c498ff',tool:'clipboard',hat:'#f3bd3d',badge:'D'},
 synthesis:{skin:'#e1b58f',hair:'#3d3340',shirt:'#db7d2d',vest:'#ffa43b',pants:'#655039',accent:'#a8b5ff',tool:'holo',hat:'#f4c64a',badge:'C'},
 coordinator:{skin:'#e1b58f',hair:'#3d3340',shirt:'#db7d2d',vest:'#ffa43b',pants:'#655039',accent:'#a8b5ff',tool:'holo',hat:'#f4c64a',badge:'C'},
 engineer:{skin:'#d7a07a',hair:'#402d23',shirt:'#cf6e24',vest:'#ff942b',pants:'#60452e',accent:'#ffb86a',tool:'wrench',hat:'#ffc640',badge:'E'},
 validator:{skin:'#ebc09b',hair:'#302925',shirt:'#d87b2e',vest:'#ffa43b',pants:'#66513a',accent:'#75dfa2',tool:'scanner',hat:'#f5c64b',badge:'V'},
 reviewer:{skin:'#bd8968',hair:'#262329',shirt:'#c96f2b',vest:'#ff9b31',pants:'#594331',accent:'#c498ff',tool:'clipboard',hat:'#efb93c',badge:'RV'},
 deployer:{skin:'#dba47e',hair:'#3a2a21',shirt:'#cf7026',vest:'#ff962c',pants:'#60472f',accent:'#ffb86a',tool:'crate',hat:'#ffc640',badge:'DP'},
 operator:{skin:'#d0a47f',hair:'#242b2f',shirt:'#d4782a',vest:'#ffa036',pants:'#63503b',accent:'#75dfa2',tool:'radio',hat:'#f4c448',badge:'OP'}
,
 code_analyst:{skin:'#d8aa83',hair:'#2b2422',shirt:'#c96e2b',vest:'#ff9a31',pants:'#594632',accent:'#ffb86a',tool:'tablet',hat:'#f2bd3d',badge:'CA'},
 test_engineer:{skin:'#e4b58b',hair:'#342923',shirt:'#cf762d',vest:'#ffa43b',pants:'#5e4b35',accent:'#75dfa2',tool:'scanner',hat:'#f5c64b',badge:'TE'},
 research_agent:{skin:'#c99673',hair:'#392a27',shirt:'#d1782c',vest:'#ff9d33',pants:'#5e4933',accent:'#8db7ff',tool:'clipboard',hat:'#f0bd42',badge:'RS'},
 security_reviewer:{skin:'#d9a67f',hair:'#28242b',shirt:'#c86c2c',vest:'#ff9632',pants:'#594331',accent:'#ff8494',tool:'scanner',hat:'#efb93c',badge:'SC'},
 performance_analyst:{skin:'#e0b38c',hair:'#342b2a',shirt:'#d2762d',vest:'#ffa23a',pants:'#604b36',accent:'#ff8494',tool:'holo',hat:'#f3c247',badge:'PF'}
}
const DEMO_STAGES=[
 {label:'Router planning',detail:'Matching capabilities, dependencies and models',states:{router:'running',ux_analyst:'pending',documentation:'pending',synthesis:'pending'}},
 {label:'UX analysis',detail:'UX Analyst is working in the Interface Lab',states:{router:'complete',ux_analyst:'running',documentation:'pending',synthesis:'pending'}},
 {label:'Documentation',detail:'Grounded findings are handed to Documentation',states:{router:'complete',ux_analyst:'complete',documentation:'running',synthesis:'pending'}},
 {label:'Synthesis',detail:'Coordinator is assembling the final mission result',states:{router:'complete',ux_analyst:'complete',documentation:'complete',synthesis:'running'}},
 {label:'Complete',detail:'Mission artifacts are ready',states:{router:'complete',ux_analyst:'complete',documentation:'complete',synthesis:'complete'}}
];

let root,canvas,ctx,current=null,liveSnapshot=null,sourceType='idle',selected=null,hovered=null,raf=0,last=0;
let roads=new Set(),agents=new Map(),artifacts=[],packets=[],traffic=[],sparks=[],dust=[],events=[],clouds=[];
let view={zoom:1,panX:0,panY:0,targetZoom:1,targetPanX:0,targetPanY:0};
let drag=null,pointers=new Map(),pinch=null,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
let display={labels:true,flows:true,night:false,crew:true,follow:false};
let demo={active:false,running:false,paused:false,stage:0,speed:1,lastAdvance:0,scenario:'success'};
const REPLAY_KEY='localai.agentworld.replay.v2';
let replay={frames:[],active:false,index:0,playing:false,lastStep:0,speed:1,sourceMissionId:''};
let celebrationUntil=0;

function humanState(s){return({needs_attention:'Needs attention',running:'Running',complete:'Complete',blocked:'Blocked',error:'Needs attention',pending:'Waiting',awaiting_approval:'Awaiting approval',applied:'Applied'})[s]||String(s||'Idle').replaceAll('_',' ')}
function zoneForWorker(w){if(['error','blocked'].includes(w.state))return'repair';return ROLE_ZONE[w.id]||ROLE_ZONE[w.agentId]||(/doc/i.test(w.name||'')?'docs':/ux/i.test(w.name||'')?'ux':/model/i.test(w.name||'')?'models':'command')}
function districtCenter(id){const d=DISTRICTS[id]||DISTRICTS.command;return{x:(d.x+d.w/2)*T,y:(d.y+d.h+.8)*T}}
function districtDoor(id){
 const d=DISTRICTS[id]||DISTRICTS.command,cx=(d.x+d.w/2)*T,front=(d.y+d.h)*T;
 return{outside:{x:cx,y:front+T*.48},inside:{x:cx,y:front-T*.42}}
}
function pointInsideDistrict(p,id){
 const d=DISTRICTS[id]||DISTRICTS.command;return p.x>d.x*T+6&&p.x<(d.x+d.w)*T-6&&p.y>d.y*T+18&&p.y<(d.y+d.h)*T-8
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
}
function blocked(x,y){
 if(x<1||y<1||x>=COLS-1||y>=ROWS-1)return true;
 for(const d of Object.values(DISTRICTS))if(x>=d.x-1&&x<d.x+d.w+1&&y>=d.y-1&&y<d.y+d.h+1)return true;
 return!roads.has(key(x,y))
}
function nearestRoad(pt){let best={x:14,y:14},bd=Infinity;for(const k of roads){const[x,y]=k.split(',').map(Number),px=(x+.5)*T,py=(y+.5)*T,d=(px-pt.x)**2+(py-pt.y)**2;if(d<bd){bd=d;best={x,y}}}return best}
function astar(a,b){
 const start=nearestRoad(a),goal=nearestRoad(b),open=[start],came=new Map(),g=new Map([[key(start.x,start.y),0]]),f=new Map([[key(start.x,start.y),Math.abs(start.x-goal.x)+Math.abs(start.y-goal.y)]]);
 while(open.length){open.sort((u,v)=>(f.get(key(u.x,u.y))??1e9)-(f.get(key(v.x,v.y))??1e9));const cur=open.shift();
  if(cur.x===goal.x&&cur.y===goal.y){const path=[];let p=cur,k=key(p.x,p.y);while(p){path.unshift({x:(p.x+.5)*T,y:(p.y+.5)*T});const prev=came.get(k);p=prev;k=prev?key(prev.x,prev.y):''}return path}
  for(const n of[{x:cur.x+1,y:cur.y},{x:cur.x-1,y:cur.y},{x:cur.x,y:cur.y+1},{x:cur.x,y:cur.y-1}]){if(blocked(n.x,n.y)&&!(n.x===goal.x&&n.y===goal.y))continue;const nk=key(n.x,n.y),tent=(g.get(key(cur.x,cur.y))||0)+1;if(tent<(g.get(nk)??1e9)){came.set(nk,cur);g.set(nk,tent);f.set(nk,tent+Math.abs(n.x-goal.x)+Math.abs(n.y-goal.y));if(!open.some(o=>o.x===n.x&&o.y===n.y))open.push(n)}}}
 return[]
}
function normalizeMission(m){return{type:'mission',id:m.id,status:m.status,goal:m.goal||'Mission',updatedAt:m.updatedAt||m.createdAt,workers:(m.workers||[]).map(w=>({...w,id:w.id||w.agentId})),routing:m.routing||null,timeline:m.timeline||[],results:m.results||[],error:m.error||'',raw:m}}
function ensureAgent(w){
 const id=w.id||w.agentId||w.name;if(!id)return;
 let a=agents.get(id),zone=zoneForWorker(w),target=workerTarget(w,zone);
 if(!a){const p=districtCenter('command'),style=ROLE_STYLE[id]||ROLE_STYLE[(w.agentId||'')]||ROLE_STYLE.synthesis;a={id,name:w.name||id,glyph:(w.name||id).trim()[0]?.toUpperCase()||'A',x:p.x,y:p.y,tx:p.x,ty:p.y,path:[],pathI:0,state:'pending',zone:'command',targetZone:zone,color:ROLE_COLOR[id]||'#8fb5e8',model:w.model||'',dir:1,bob:Math.random()*Math.PI*2,step:Math.random()*Math.PI*2,style,activitySeed:Math.random()*10,inside:false,insideZone:null,targetInside:false,transition:'idle'};agents.set(id,a)}
 const old=a.state;a.name=w.name||a.name;a.model=w.model||a.model;a.state=w.state||a.state;a.targetZone=zone;a.color=ROLE_COLOR[id]||a.color;
 if(a.zone!==zone||Math.hypot(a.tx-target.x,a.ty-target.y)>2||a.targetInside!==target.inside){a.tx=target.x;a.ty=target.y;a.targetInside=!!target.inside;a.transition=target.inside?'entering':(a.inside?'exiting':'traveling');a.path=routeToTarget(a,target,zone);a.pathI=0;a.zone=zone}
 if(old!==a.state){
  addEvent(a.name+' → '+humanState(a.state));
  if(a.state==='running'){spawnPacket('models',zone,a.color,'MODEL');spawnSpark(target.x,target.y,a.color,18)}
  if(a.state==='complete'){
   spawnArtifact(a);spawnSpark(target.x,target.y,'#75dfa2',26);
   for(const next of current?.workers||[])if((next.dependsOn||[]).includes(id))spawnPacket(zone,zoneForWorker(next),a.color,'HANDOFF')
  }
  if(['error','blocked'].includes(a.state))spawnSpark(target.x,target.y,'#ff7383',36)
 }
}
function spawnArtifact(a){if(artifacts.some(x=>x.workerId===a.id))return;const p=districtCenter(a.zone),kind=['engineer','code_analyst','deployer'].includes(a.id)?'build':['validator','test_engineer','security_reviewer'].includes(a.id)?'certificate':['documentation','research_agent','ux_analyst'].includes(a.id)?'document':'node';artifacts.push({workerId:a.id,label:a.name,kind,x:p.x+26,y:p.y-14,color:a.color,created:now()})}
function spawnPacket(from,to,color,label='EVIDENCE'){const p=astar(districtCenter(from),districtCenter(to));if(p.length)packets.push({path:p,i:0,x:p[0].x,y:p[0].y,color,label,done:false,created:now()})}
function spawnSpark(x,y,color,n=12){for(let i=0;i<n;i++)sparks.push({x,y,vx:(Math.random()-.5)*80,vy:-20-Math.random()*80,life:.7+Math.random()*.7,color,size:1+Math.random()*2})}
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
function replayEventClass(frame){const r=String(frame?.reason||'').toLowerCase();if(/error|attention|blocked|fail/.test(r))return'bad';if(/complete|result/.test(r))return'done';if(/handoff|dispatch|synthesis/.test(r))return'active';return'wait'}
function syncReplay(){
 if(!root)return;const range=$('#awcReplayRange',root),label=$('#awcReplayLabel',root),markers=$('#awcReplayMarkers',root),frame=replay.frames[replay.index];
 if(range){range.max=Math.max(0,replay.frames.length-1);range.value=replay.index;range.disabled=replay.frames.length<2}
 if(label)label.textContent=replay.frames.length?(replay.active?'Replay '+(replay.index+1)+' / '+replay.frames.length+' · '+String(frame?.reason||'state').replaceAll('-',' '):replay.frames.length+' event'+(replay.frames.length===1?'':'s')+' ready'):'0 events';
 if(markers){markers.innerHTML=replay.frames.map((f,i)=>`<button type="button" data-replay-index="${i}" class="${replayEventClass(f)} ${i===replay.index?'active':''}" title="${esc((f.reason||'state')+(f.detail?' — '+f.detail:''))}"></button>`).join('');markers.querySelectorAll('[data-replay-index]').forEach(b=>b.onclick=()=>applyReplayFrame(Number(b.dataset.replayIndex)))}
 $('#awcReplayPlay',root).textContent=replay.playing?'Pause':'Play';$('#awcReplaySpeed',root).textContent=replay.speed+'×';$('#awcReplayLive',root).hidden=!replay.active;
 const detail=$('#awcReplayDetail',root);if(detail)detail.textContent=frame?(new Date(frame.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})+' · '+(frame.detail||String(frame.reason||'state').replaceAll('-',' '))):'Select a mission from history to inspect its execution.'
}
function applyReplayFrame(i,preservePlaying=false){
 if(!replay.frames.length)return;const wasPlaying=replay.playing;replay.active=true;replay.playing=preservePlaying&&wasPlaying;replay.index=clamp(Number(i)||0,0,replay.frames.length-1);const frame=replay.frames[replay.index];agents.clear();artifacts=[];packets=[];sparks=[];dust=[];current=JSON.parse(JSON.stringify(frame.mission));sourceType='replay';current.workers.forEach(ensureAgent);selected=frame.workerId?{type:'agent',id:String(frame.workerId).split(',')[0]}:selected;syncHud();syncSelection();syncReplay()
}
function stepReplay(delta){if(!replay.frames.length)return;if(!replay.active)applyReplayFrame(replay.index);else applyReplayFrame(clamp(replay.index+delta,0,replay.frames.length-1));}
function toggleReplay(){if(replay.frames.length<2)return;if(!replay.active)applyReplayFrame(0);replay.playing=!replay.playing;replay.lastStep=now();syncReplay()}
function cycleReplaySpeed(){replay.speed=replay.speed===1?2:replay.speed===2?4:1;persistReplay();syncReplay()}
function returnReplayLive(){replay.active=false;replay.playing=false;if(liveSnapshot){agents.clear();current=liveSnapshot;sourceType='mission';current.workers.forEach(ensureAgent)}syncHud();syncSelection();syncReplay()}
function applyMission(m){
 if(!m||demo.active)return;const prev=current,next=normalizeMission(m),wasComplete=prev?.status==='complete';
 if(!prev||prev.id!==next.id){agents.clear();artifacts=[];packets=[];sparks=[];dust=[]}
 current=next;liveSnapshot=next;sourceType='mission';current.workers.forEach(ensureAgent);
 if(!prev||prev.id!==current.id)addEvent('Mission entered Agent World');
 if(next.timeline?.length)primeMissionReplay(next);else recordReplayFrame('mission');
 if(next.status==='complete'&&!wasComplete){const p=districtCenter('command');spawnSpark(p.x,p.y,'#75dfa2',54);celebrationUntil=now()+3600;addEvent('Mission complete · Command Center received final synthesis')}
 syncHud()
}
function engWorkers(run){const s=run.status||'idle';return[{id:'engineer',name:'Engineer',state:s==='running'?'running':s==='needs_attention'?'error':s==='applied'?'complete':'pending'},{id:'validator',name:'Validator',state:s==='running'?'running':s==='awaiting_approval'?'complete':'pending'},{id:'reviewer',name:'Reviewer',state:s==='awaiting_approval'?'running':['approved','apply_requested','applied'].includes(s)?'complete':'pending'},{id:'deployer',name:'Deployer',state:['approved','apply_requested'].includes(s)?'running':s==='applied'?'complete':'pending'},{id:'operator',name:'Operator',state:s==='applied'?'complete':'pending'}]}
function applyEngineering(run){if(!run||demo.active||(sourceType==='mission'&&current?.status==='running'))return;current={type:'engineering',id:run.id,status:run.status,goal:run.request||'Engineering run',workers:engWorkers(run),raw:run};sourceType='engineering';current.workers.forEach(ensureAgent);syncHud()}
function demoMission(){
 const states=DEMO_STAGES[demo.stage].states,workers=[{id:'router',name:'Mission Router',model:'deterministic dispatcher'},{id:'ux_analyst',name:'UX Analyst',model:'qwen3:4b-instruct-32k'},{id:'documentation',name:'Documentation Agent',model:'qwen3:4b-instruct-32k'},{id:'synthesis',name:'Coordinator',model:'qwen3:4b-instruct-32k'}].map(w=>({...w,state:states[w.id]||'pending',dependsOn:w.id==='ux_analyst'?['router']:w.id==='documentation'?['ux_analyst']:w.id==='synthesis'?['documentation']:[]}));
 if(demo.scenario==='failure'&&demo.stage>=2){workers.find(w=>w.id==='documentation').state='error';workers.find(w=>w.id==='synthesis').state='blocked'}
 return{type:'mission',id:'demo-city-mission',status:demo.scenario==='failure'&&demo.stage>=2?'needs_attention':demo.stage===4?'complete':'running',goal:demo.scenario==='failure'?'Demo: recover a failed documentation handoff':'Demo: audit and improve Local AI mobile UX',workers,error:demo.scenario==='failure'&&demo.stage>=2?'Documentation Agent needs attention':''}
}
function applyDemo(){const next=demoMission();if(!demo.active||current?.id!==next.id){agents.clear();artifacts=[];packets=[];sparks=[]}current=next;sourceType='demo';current.workers.forEach(ensureAgent);syncHud();addEvent('Demo: '+DEMO_STAGES[demo.stage].label);recordReplayFrame('demo-stage-'+demo.stage)}
function startDemo(){demo.active=true;demo.running=true;demo.paused=false;demo.stage=0;demo.lastAdvance=now();applyDemo();fitWorld();syncDemoControls()}
function stepDemo(){if(!demo.active)startDemo();else{demo.stage=Math.min(DEMO_STAGES.length-1,demo.stage+1);demo.lastAdvance=now();applyDemo();if(demo.stage===DEMO_STAGES.length-1)demo.running=false}syncDemoControls()}
function resetDemo(){demo.stage=0;demo.running=false;demo.paused=false;applyDemo();syncDemoControls()}
function returnLive(){replay.active=false;replay.playing=false;demo.active=false;demo.running=false;demo.paused=false;agents.clear();artifacts=[];packets=[];sparks=[];dust=[];if(liveSnapshot){current=liveSnapshot;sourceType='mission';current.workers.forEach(ensureAgent)}else{current=null;sourceType='idle'}syncHud();syncDemoControls();syncReplay();fitWorld()}
function toggleDemoPlay(){if(!demo.active){startDemo();return}demo.running=true;demo.paused=!demo.paused;demo.lastAdvance=now();syncDemoControls()}
function cycleSpeed(){demo.speed=demo.speed===1?2:demo.speed===2?4:1;syncDemoControls()}
function syncDemoControls(){if(!root)return;$('#awcDemoPlay',root).textContent=demo.active&&demo.running&&!demo.paused?'Pause':'Play';$('#awcDemoSpeed',root).textContent=demo.speed+'×';$('#awcLiveBtn',root).hidden=!demo.active;$('#awcDemoScenario',root).value=demo.scenario}
function activeStage(){
 if(demo.active)return DEMO_STAGES[demo.stage];
 const w=current?.workers||[],running=w.find(x=>x.state==='running'),bad=w.find(x=>['error','blocked'].includes(x.state));
 if(bad)return{label:'Needs attention',detail:(bad.name||bad.id)+' requires intervention'};
 if(running)return{label:running.name||running.id,detail:'Worker active in '+(DISTRICTS[zoneForWorker(running)]?.name||'Agent World')};
 if(current?.status==='complete')return{label:'Complete',detail:'Mission finished'};
 return{label:'Standing by',detail:'Waiting for mission activity'}
}
function syncHud(){
 if(!root)return;const stage=activeStage(),workers=current?.workers||[],done=workers.filter(w=>w.state==='complete').length,running=workers.filter(w=>w.state==='running').length,bad=workers.filter(w=>['error','blocked'].includes(w.state)).length;
 $('#awcSource',root).textContent=sourceType.toUpperCase();$('#awcObjective',root).textContent=current?.goal||'No active mission';$('#awcObjective',root).title=current?.goal||'';root.dataset.state=bad?'attention':running?'running':current?.status==='complete'?'complete':workers.length?'waiting':'idle';$('#awcStage',root).textContent=stage.label;$('#awcStageDetail',root).textContent=stage.detail;$('#awcStatus',root).textContent=current?humanState(current.status):'Idle';$('#awcProgressText',root).textContent=workers.length?done+'/'+workers.length+' complete':'No workers';$('#awcProgress',root).style.width=(workers.length?Math.round(done/workers.length*100):0)+'%';$('#awcStatRun',root).textContent=running;$('#awcStatDone',root).textContent=done;$('#awcStatAlert',root).textContent=bad;$('#awcStatArtifacts',root).textContent=artifacts.length;$('#awcAttention',root).hidden=!bad;syncRoster()
}
function syncRoster(){
 const h=$('#awcRoster',root);if(!h)return;const workers=current?.workers||[];h.innerHTML=workers.length?workers.map(w=>{const s=ROLE_STYLE[w.id]||ROLE_STYLE[w.agentId]||ROLE_STYLE.synthesis;return `<button class="awc__rosterItem ${esc(w.state)}" data-awc-roster="${esc(w.id)}"><span class="awc__rosterGlyph" style="--worker:${esc(s.accent)}">${esc((s.badge||w.name||w.id||'?').slice(0,2))}</span><span><strong>${esc(w.name||w.id)}</strong><small>${esc(DISTRICTS[zoneForWorker(w)]?.short||zoneForWorker(w))} · ${esc(s.tool)}</small></span><em>${esc(humanState(w.state))}</em></button>`}).join(''):'<div class="awc__empty">No workers active.</div>';h.querySelectorAll('[data-awc-roster]').forEach(b=>b.onclick=()=>focusWorker(b.dataset.awcRoster))
}
function syncEventFeed(){if(!root)return;const h=$('#awcEventFeed',root);if(h)h.innerHTML=events.length?events.slice(0,4).map(e=>`<div><span>${esc(e.text)}</span><time>${e.at.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></div>`).join(''):'<div><span>Waiting for activity</span></div>'}
let externalFocus=false;
function syncSelection(){
 if(!root)return;const h=$('#awcSelection',root);if(!selected){h.innerHTML='<span>Select a worker or building</span><small>Inspect district state and focus the camera.</small>';return}
 if(selected.type==='agent'){const a=agents.get(selected.id);if(!a)return;const w=(current?.workers||[]).find(q=>(q.id||q.agentId)===a.id),rm=w?.routingMeta||{};h.innerHTML=`<strong>${esc(a.name)}</strong><small>${esc(humanState(a.state))} · ${esc(DISTRICTS[a.zone]?.name||a.zone)} · ${esc(a.model||'automatic model')}</small>${rm.capabilityScore!=null?`<small>Capability ${rm.capabilityScore}% · model ${rm.modelScore??'—'}% · ${esc(rm.availability||'available')} · deps ${rm.dependencyCount??0}</small>`:''}`;if(!externalFocus)window.dispatchEvent(new CustomEvent('localai:agentworld-select',{detail:{workerId:a.id}}))}
 else{const d=DISTRICTS[selected.id],workers=[...agents.values()].filter(a=>a.zone===selected.id);h.innerHTML=`<strong>${esc(d.name)}</strong><small>${workers.length?workers.map(a=>esc(a.name)).join(', '):'No workers in district'}</small>`}
}
function fitWorld(){view.targetZoom=1;view.targetPanX=0;view.targetPanY=0;syncZoomLabel()}
function focusPoint(x,y,z=1.8){view.targetZoom=clamp(z,1,3);view.targetPanX=W/2-x*view.targetZoom;view.targetPanY=H/2-y*view.targetZoom;limitTargetPan();syncZoomLabel()}
function focusActive(){const a=[...agents.values()].find(x=>x.state==='running')||[...agents.values()][0];if(a){selected={type:'agent',id:a.id};syncSelection();focusPoint(a.x,a.y,2)}}
function focusWorker(id){const a=agents.get(id);if(a){selected={type:'agent',id};syncSelection();focusPoint(a.x,a.y,2)}}
function zoomAt(factor,cx=W/2,cy=H/2){const old=view.targetZoom,nz=clamp(old*factor,1,3),wx=(cx-view.targetPanX)/old,wy=(cy-view.targetPanY)/old;view.targetZoom=nz;view.targetPanX=cx-wx*nz;view.targetPanY=cy-wy*nz;limitTargetPan();syncZoomLabel()}
function limitTargetPan(){if(view.targetZoom<=1){view.targetPanX=0;view.targetPanY=0;return}view.targetPanX=clamp(view.targetPanX,W-W*view.targetZoom,0);view.targetPanY=clamp(view.targetPanY,H-H*view.targetZoom,0)}
function syncZoomLabel(){if(root)$('#awcZoomLabel',root).textContent=Math.round(view.targetZoom*100)+'%'}
function screenPoint(e){const r=canvas.getBoundingClientRect(),sx=W/r.width,sy=H/r.height,px=(e.clientX-r.left)*sx,py=(e.clientY-r.top)*sy;return{px,py,x:(px-view.panX)/view.zoom,y:(py-view.panY)/view.zoom}}
function hitAt(x,y){
 for(const a of agents.values())if(Math.hypot(x-a.x,y-a.y)<27)return{type:'agent',id:a.id};
 for(const[id,d]of Object.entries(DISTRICTS))if(x>=d.x*T&&x<=(d.x+d.w)*T&&y>=d.y*T&&y<=(d.y+d.h)*T)return{type:'district',id};
 return null
}
function selectAt(e){const p=screenPoint(e);selected=hitAt(p.x,p.y);syncSelection();if(selected?.type==='district'){const d=DISTRICTS[selected.id];focusPoint((d.x+d.w/2)*T,(d.y+d.h/2)*T,1.65)}}
function updateHover(e){
 if(drag||pointers.size>1)return;const p=screenPoint(e),hit=hitAt(p.x,p.y);hovered=hit;const tip=$('#awcTooltip',root);if(!tip)return;
 if(!hit||hit.type!=='agent'){tip.hidden=true;return}
 const a=agents.get(hit.id);tip.innerHTML='<strong>'+esc(a.name)+'</strong><span>'+esc(humanState(a.state))+' · '+esc(DISTRICTS[a.zone]?.name||a.zone)+'</span>';tip.hidden=false;
 tip.style.left=clamp(e.offsetX+12,8,canvas.clientWidth-176)+'px';tip.style.top=clamp(e.offsetY-54,8,canvas.clientHeight-54)+'px'
}
function toggleDisplay(k){display[k]=!display[k];root?.querySelector('[data-awc-display="'+k+'"]')?.setAttribute('aria-pressed',String(display[k]));if(k==='night')root?.classList.toggle('is-night',display.night)}
function toggleCrew(){display.crew=!display.crew;root?.classList.toggle('crew-hidden',!display.crew);$('#awcCrewToggle',root)?.setAttribute('aria-pressed',String(display.crew))}
function toggleFollow(){display.follow=!display.follow;$('#awcFollow',root)?.setAttribute('aria-pressed',String(display.follow));if(display.follow)focusActive()}
// Theater moves the frame to <body>: an ancestor of the Agents page creates a containing block that traps position:fixed.
let theaterHome=null;
function setTheaterHost(on){if(on&&!theaterHome){theaterHome=document.createComment('agent-world');root.before(theaterHome);document.body.appendChild(root)}else if(!on&&theaterHome){theaterHome.replaceWith(root);theaterHome=null}}
function toggleExpanded(){const on=!root.classList.contains('is-expanded');setTheaterHost(on);root.classList.toggle('is-expanded',on);document.body.classList.toggle('awc-stage-expanded',on);$('#awcExpand',root).textContent=on?'Exit theater':'Theater';setTimeout(()=>{if(on)focusActive();else fitWorld()},40)}
function exitExpanded(){if(!root?.classList.contains('is-expanded'))return;root.classList.remove('is-expanded');setTheaterHost(false);document.body.classList.remove('awc-stage-expanded');$('#awcExpand',root).textContent='Theater';fitWorld()}

function mount(){
 const host=$('#agentWorldCityMount');if(!host)return;root=document.createElement('section');root.className='awc awc-v3';root.dataset.state='idle';root.innerHTML=`
 <header class="awc__commandbar">
  <div class="awc__brand">
   <svg class="awc__mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M6 22a10 10 0 0 1 20 0z" fill="currentColor"/><rect x="4" y="22" width="24" height="4" rx="2" fill="currentColor"/><path d="M14 12h4v6h-4z" fill="#0b1624" opacity=".35"/></svg>
   <div class="awc__brandText"><div class="awc__titleRow"><h2 class="awc__title">Agent World</h2><span class="awc__live"><i></i><b id="awcSource">IDLE</b></span></div><div class="awc__sub">Mission construction crew</div></div>
  </div>
  <dl class="awc__topstats">
   <div class="awc__stat is-run"><dt>Working</dt><dd id="awcStatRun">0</dd></div>
   <div class="awc__stat is-done"><dt>Done</dt><dd id="awcStatDone">0</dd></div>
   <div class="awc__stat is-alert"><dt>Alerts</dt><dd id="awcStatAlert">0</dd></div>
   <div class="awc__stat is-art"><dt>Artifacts</dt><dd id="awcStatArtifacts">0</dd></div>
  </dl>
  <div class="awc__toolbar" role="toolbar" aria-label="Map controls">
   <div class="awc__group"><button id="awcFit" type="button" title="Show the whole city (0)">Fit</button><button id="awcCenter" type="button" title="Jump to the active worker (A)">Active</button><button id="awcFollow" type="button" aria-pressed="false" title="Keep the camera on the active worker (F)">Follow</button></div>
   <div class="awc__group"><button id="awcZoomOut" type="button" aria-label="Zoom out">−</button><span id="awcZoomLabel" aria-live="polite">100%</span><button id="awcZoomIn" type="button" aria-label="Zoom in">+</button></div>
   <div class="awc__group"><button type="button" data-awc-display="labels" aria-pressed="true">Labels</button><button type="button" data-awc-display="flows" aria-pressed="true">Flows</button><button type="button" data-awc-display="night" aria-pressed="false">Night</button></div>
   <div class="awc__group"><button id="awcCrewToggle" type="button" aria-pressed="true">Crew</button><button id="awcExpand" data-game-primary="true" type="button" title="Full-screen view (T)">Theater</button></div>
  </div>
 </header>
 <div class="awc__missionstrip">
  <div class="awc__missioncopy"><span class="awc__eyebrow">Objective</span><strong id="awcObjective">No active mission</strong></div>
  <div class="awc__phase"><span class="awc__phaseDot"></span><span><strong id="awcStage">Standing by</strong><small id="awcStageDetail">Waiting for mission activity</small></span></div>
  <div class="awc__missionstate">
   <div class="awc__missionstateTop"><b id="awcStatus">Idle</b><span id="awcProgressText">No workers</span><span class="awc__attention" id="awcAttention" hidden>Attention</span></div>
   <div class="awc__progress" aria-hidden="true"><span id="awcProgress"></span></div>
  </div>
 </div>
 <div class="awc__gameShell">
  <div class="awc__mapWrap">
   <canvas width="${W}" height="${H}" id="awcCanvas" tabindex="0" aria-label="Interactive Agent World map. Drag to pan, scroll or pinch to zoom, click a district or worker to inspect. Keys: 0 fit, A active worker, F follow, plus and minus zoom, T theater."></canvas>
   <div class="awc__scanlines"></div>
   <div class="awc__tooltip" id="awcTooltip" hidden></div>
   <div class="awc__mapHud">
    <div class="awc__selection" id="awcSelection"><span>Select a worker or building</span><small>Click to inspect</small></div>
    <div class="awc__minimap" id="awcMinimap" aria-hidden="true"></div>
   </div>
   <div class="awc__eventFeed" id="awcEventFeed" aria-live="polite"></div>
   <div class="awc__legend" aria-label="Map legend"><span><i class="run"></i>Running</span><span><i class="done"></i>Complete</span><span><i class="wait"></i>Waiting</span><span><i class="bad"></i>Attention</span><span><i class="dep"></i>Active dependency</span><span><i class="art"></i>Artifact</span></div>
  </div>
  <div class="awc__ops" role="complementary" aria-label="Mission details">
   <div class="awc__opsScroll">
    <section class="awc__section"><div class="awc__opsHead"><h3>Crew</h3><span class="awc__eyebrow">Live roster</span></div>
     <div class="awc__roster" id="awcRoster"><div class="awc__empty">No workers active.</div></div></section>
    <section class="awc__section"><div class="awc__opsHead"><h3>Districts</h3><span class="awc__eyebrow">Jump to</span></div>
     <div class="awc__districtLegend">${Object.entries(DISTRICTS).map(([id,d])=>`<button type="button" data-awc-district="${id}"><i style="--district:${d.accent}"></i><span>${d.short}</span></button>`).join('')}</div></section>
    <section class="awc__section awc__replayPanel"><div class="awc__opsHead"><h3>Replay</h3><strong id="awcReplayLabel">0 events</strong></div><div class="awc__replayMarkers" id="awcReplayMarkers"></div><input id="awcReplayRange" type="range" min="0" max="0" value="0" disabled aria-label="Mission replay position"><small id="awcReplayDetail">Select a mission from history to inspect its execution.</small><div class="awc__replayActions"><button id="awcReplayPrev" type="button" aria-label="Previous replay event">◀</button><button id="awcReplayPlay" type="button">Play</button><button id="awcReplayNext" type="button" aria-label="Next replay event">▶</button><button id="awcReplaySpeed" type="button">1×</button><button id="awcReplayLive" type="button" hidden>Live</button></div></section>
    <section class="awc__section awc__demoPanel"><div class="awc__opsHead"><h3>Simulation</h3><span class="awc__eyebrow">Try the city without a real mission</span></div><select id="awcDemoScenario" aria-label="Demo scenario"><option value="success">Successful mission</option><option value="failure">Failure and repair</option></select><div class="awc__demoActions"><button id="awcDemoPlay" type="button">Play</button><button id="awcDemoStep" type="button">Step</button><button id="awcDemoReset" type="button">Reset</button><button id="awcDemoSpeed" type="button">1×</button></div><button id="awcLiveBtn" class="awc__liveBtn" type="button" hidden>Return to live mission</button></section>
    <p class="awc__hint">Drag to pan, scroll or pinch to zoom, click a district or worker. Keys: 0 fit · A active · F follow · +/− zoom · T theater.</p>
   </div>
  </div>
 </div>`;
 host.appendChild(root);loadReplay();syncReplay();canvas=$('#awcCanvas',root);ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
 $('#awcReplayPrev',root).onclick=()=>stepReplay(-1);$('#awcReplayPlay',root).onclick=toggleReplay;$('#awcReplayNext',root).onclick=()=>stepReplay(1);$('#awcReplaySpeed',root).onclick=cycleReplaySpeed;$('#awcReplayLive',root).onclick=returnReplayLive;$('#awcReplayRange',root).oninput=e=>applyReplayFrame(e.target.value);$('#awcExpand',root).onclick=toggleExpanded;$('#awcCrewToggle',root).onclick=toggleCrew;$('#awcFollow',root).onclick=toggleFollow;$('#awcFit',root).onclick=fitWorld;$('#awcCenter',root).onclick=focusActive;$('#awcZoomIn',root).onclick=()=>zoomAt(1.2);$('#awcZoomOut',root).onclick=()=>zoomAt(.84);$('#awcDemoPlay',root).onclick=toggleDemoPlay;$('#awcDemoStep',root).onclick=stepDemo;$('#awcDemoReset',root).onclick=resetDemo;$('#awcDemoSpeed',root).onclick=cycleSpeed;$('#awcLiveBtn',root).onclick=returnLive;$('#awcDemoScenario',root).onchange=e=>{demo.scenario=e.target.value;if(demo.active)applyDemo()};
 root.querySelectorAll('[data-awc-display]').forEach(b=>b.onclick=()=>toggleDisplay(b.dataset.awcDisplay));root.querySelectorAll('[data-awc-district]').forEach(b=>b.onclick=()=>{selected={type:'district',id:b.dataset.awcDistrict};syncSelection();const d=DISTRICTS[b.dataset.awcDistrict];focusPoint((d.x+d.w/2)*T,(d.y+d.h/2)*T,1.7)});
 canvas.addEventListener('wheel',e=>{e.preventDefault();const p=screenPoint(e);zoomAt(e.deltaY<0?1.12:.89,p.px,p.py)},{passive:false});
 canvas.addEventListener('pointerdown',e=>{try{canvas.setPointerCapture(e.pointerId)}catch{}const p=screenPoint(e);pointers.set(e.pointerId,{x:p.px,y:p.py});if(pointers.size===1){drag={id:e.pointerId,startX:p.px,startY:p.py,panX:view.targetPanX,panY:view.targetPanY,moved:false};pinch=null}else if(pointers.size===2){const ps=[...pointers.values()],dx=ps[1].x-ps[0].x,dy=ps[1].y-ps[0].y;pinch={distance:Math.max(1,Math.hypot(dx,dy)),zoom:view.targetZoom,panX:view.targetPanX,panY:view.targetPanY,cx:(ps[0].x+ps[1].x)/2,cy:(ps[0].y+ps[1].y)/2};drag=null}});
 canvas.addEventListener('pointermove',e=>{updateHover(e);if(!pointers.has(e.pointerId))return;const r=canvas.getBoundingClientRect(),sx=W/r.width,sy=H/r.height,px=(e.clientX-r.left)*sx,py=(e.clientY-r.top)*sy;pointers.set(e.pointerId,{x:px,y:py});if(pointers.size===2&&pinch){const ps=[...pointers.values()],dx=ps[1].x-ps[0].x,dy=ps[1].y-ps[0].y,dist=Math.max(1,Math.hypot(dx,dy)),cx=(ps[0].x+ps[1].x)/2,cy=(ps[0].y+ps[1].y)/2,nz=clamp(pinch.zoom*(dist/pinch.distance),1,3),wx=(pinch.cx-pinch.panX)/pinch.zoom,wy=(pinch.cy-pinch.panY)/pinch.zoom;view.targetZoom=nz;view.targetPanX=cx-wx*nz;view.targetPanY=cy-wy*nz;limitTargetPan();syncZoomLabel();return}if(!drag||drag.id!==e.pointerId)return;const dx=px-drag.startX,dy=py-drag.startY;if(Math.abs(dx)+Math.abs(dy)>4)drag.moved=true;view.targetPanX=drag.panX+dx;view.targetPanY=drag.panY+dy;limitTargetPan()});
 canvas.addEventListener('pointerup',e=>{const wasSingle=pointers.size===1,moved=drag?.moved||false;pointers.delete(e.pointerId);if(wasSingle&&!moved)selectAt(e);if(pointers.size===1){const[id,p]=[...pointers.entries()][0];drag={id,startX:p.x,startY:p.y,panX:view.targetPanX,panY:view.targetPanY,moved:true}}else drag=null;if(pointers.size<2)pinch=null});
 canvas.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);drag=null;if(pointers.size<2)pinch=null});canvas.addEventListener('pointerleave',()=>{const t=$('#awcTooltip',root);if(t)t.hidden=true});
 canvas.addEventListener('keydown',e=>{if(e.key==='+'||e.key==='=')zoomAt(1.2);if(e.key==='-')zoomAt(.84);if(e.key==='0')fitWorld();if(e.key==='f')toggleFollow();if(e.key==='a')focusActive();if(e.key==='t')toggleExpanded();if(e.key==='Enter'&&hovered){selected=hovered;syncSelection()}});document.addEventListener('keydown',e=>{if(e.key==='Escape')exitExpanded()});
 // The Agents panel answers our select event with a focus event; don't echo it back as another select.
 window.addEventListener('localai:agentworld-focus',e=>{externalFocus=true;try{focusWorker(e.detail?.workerId)}finally{externalFocus=false}});
 document.body.classList.add('agent-world-city-ready');buildRoads();seedAmbient();syncDemoControls();syncHud();syncEventFeed();start();bootstrap()
}
function seedAmbient(){traffic=[{x:2*T,y:13.5*T,v:28,axis:'x',dir:1,color:'#6aaeff'},{x:36*T,y:14.5*T,v:23,axis:'x',dir:-1,color:'#ffc56b'},{x:25.5*T,y:3*T,v:20,axis:'y',dir:1,color:'#c18cff'},{x:13.5*T,y:21*T,v:18,axis:'y',dir:-1,color:'#75dfa2'}];clouds=[{x:160,y:80,s:1.1},{x:880,y:130,s:.8},{x:560,y:40,s:.6}]}
function update(dt,ts){
 if(display.follow&&!drag&&!pointers.size){const a=[...agents.values()].find(q=>q.state==='running');if(a){view.targetZoom=Math.max(view.targetZoom,1.7);view.targetPanX=W/2-a.x*view.targetZoom;view.targetPanY=H/2-a.y*view.targetZoom;limitTargetPan()}}
 view.zoom+= (view.targetZoom-view.zoom)*Math.min(1,dt*10);view.panX+=(view.targetPanX-view.panX)*Math.min(1,dt*10);view.panY+=(view.targetPanY-view.panY)*Math.min(1,dt*10);
 for(const a of agents.values()){
  const moving=workerIsMoving(a),running=a.state==='running'&&moving;
  a.motion=running?'running':moving?'walking':a.state==='running'?'working':'idle';
  a.bob+=dt*(running?12:7);a.step+=dt*(running?19:10);
  if(!moving)continue;
  const p=a.path[a.pathI],dx=p.x-a.x,dy=p.y-a.y,d=Math.hypot(dx,dy);
  if(d<3){a.pathI++;if(a.pathI>=a.path.length){a.inside=!!a.targetInside;a.insideZone=a.inside?a.zone:null;a.transition=a.inside?'working':'idle';a.motion=a.state==='running'?'working':'idle';a.arrivedAt=ts;spawnSpark(a.x,a.y,a.inside?'#71b7ff':'#f5c04f',5)}continue}
  a.dir=dx<0?-1:1;
  const base=running?150:64,arrival=a.pathI>=a.path.length-1?clamp(d/42,.45,1):1,speed=base*arrival;
  a.x+=dx/d*speed*dt;a.y+=dy/d*speed*dt;
  if(running)spawnRunDust(a,ts)
 }
 for(const p of packets){if(p.done||!p.path[p.i])continue;const t=p.path[p.i],dx=t.x-p.x,dy=t.y-p.y,d=Math.hypot(dx,dy);if(d<3){p.i++;if(p.i>=p.path.length){p.done=true;spawnSpark(p.x,p.y,p.color,8);if(p.label==='HANDOFF')addEvent('Handoff received')}continue}p.x+=dx/d*150*dt;p.y+=dy/d*150*dt}packets=packets.filter(p=>!p.done);
 updateConstruction(dt,ts);updateCrew(dt);
 for(const s of sparks){s.x+=s.vx*dt;s.y+=s.vy*dt;s.vy+=90*dt;s.life-=dt}sparks=sparks.filter(s=>s.life>0);for(const d of dust){d.x+=d.vx*dt;d.y+=d.vy*dt;d.r+=dt*5;d.life-=dt}dust=dust.filter(d=>d.life>0);
 for(const c of traffic){if(c.axis==='x'){c.x+=c.v*c.dir*dt;if(c.x>38*T)c.x=2*T;if(c.x<2*T)c.x=38*T}else{c.y+=c.v*c.dir*dt;if(c.y>23*T)c.y=3*T;if(c.y<3*T)c.y=23*T}}
 if(demo.active&&demo.running&&!demo.paused&&!reduced&&ts-demo.lastAdvance>3200/demo.speed){if(demo.stage<DEMO_STAGES.length-1){demo.stage++;applyDemo();recordReplayFrame('demo');demo.lastAdvance=ts}else demo.running=false;syncDemoControls()}
 if(replay.active&&replay.playing&&ts-replay.lastStep>1200/replay.speed){if(replay.index<replay.frames.length-1){replay.index++;const f=replay.frames[replay.index];agents.clear();artifacts=[];packets=[];sparks=[];dust=[];current=JSON.parse(JSON.stringify(f.mission));sourceType='replay';current.workers.forEach(ensureAgent);selected=f.workerId?{type:'agent',id:String(f.workerId).split(',')[0]}:selected;syncHud();syncSelection();replay.lastStep=ts;syncReplay()}else{replay.playing=false;syncReplay()}}
}
function px(x,y,w,h,c){ctx.fillStyle=c;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h))}
function pathPoly(points,fill){ctx.fillStyle=fill;ctx.beginPath();ctx.moveTo(points[0][0],points[0][1]);for(let i=1;i<points.length;i++)ctx.lineTo(points[i][0],points[i][1]);ctx.closePath();ctx.fill()}
function txt(t,x,y,c='#d9e7f4',size=11,align='center'){ctx.fillStyle=c;ctx.font='800 '+size+'px ui-monospace,monospace';ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillText(t,x,y)}
function drawGround(ts){
 px(0,0,W,H,display.night?'#07121b':'#0d2220');
 for(let y=0;y<H;y+=T)for(let x=0;x<W;x+=T){const n=((x/T*13+y/T*7)%11);px(x,y,T,T,display.night?(n<4?'#0b211f':'#0e2822'):(n<3?'#17382b':n<7?'#1a422f':'#1d4933'));if(n===0){px(x+6,y+8,3,3,'#2d6548');px(x+22,y+20,2,2,'#2a5c43')}}
 // water / edge
 pathPoly([[0,0],[W,0],[W,56],[1010,74],[820,48],[620,65],[420,45],[180,70],[0,52]],display.night?'#071a27':'#143a4c');
 ctx.strokeStyle=display.night?'#0c3248':'#23627e';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(0,52);ctx.bezierCurveTo(260,78,420,37,640,60);ctx.bezierCurveTo(860,82,1020,45,W,58);ctx.stroke();
 // roads
 roads.forEach(k=>{const[x,y]=k.split(',').map(Number);px(x*T,y*T,T,T,display.night?'#1b2530':'#2b343f');px(x*T+2,y*T+2,T-4,T-4,display.night?'#232f3b':'#35414d')});
 for(let x=0;x<COLS;x++){if(roads.has(key(x,13)))px(x*T+8,13*T+15,16,2,'#d6ab52');if(roads.has(key(x,14)))px(x*T+8,14*T+15,16,2,'#d6ab52')}
 for(let y=0;y<ROWS;y++){if(roads.has(key(13,y)))px(13*T+15,y*T+8,2,16,'#d6ab52');if(roads.has(key(25,y)))px(25*T+15,y*T+8,2,16,'#d6ab52')}
 // crosswalks
 for(const [tx,ty,vert] of [[13,9,false],[25,9,false],[13,23,false],[25,23,false],[13,13,true],[25,13,true]])for(let i=0;i<5;i++)px(tx*T+(vert?8+i*4:5+i*5),ty*T+(vert?5+i*5:8),vert?2:3,vert?3:2,'#98a3ab');
 // plaza + paths
 px(16*T,11*T,9*T,5*T,display.night?'#3f443f':'#746f59');for(let i=0;i<18;i++)px(16*T+(i%6)*T/1.5+9,11*T+Math.floor(i/6)*T/1.5+10,4,4,display.night?'#545a54':'#999078');
 // trees
 for(const [x,y] of [[2,2],[3,3],[37,3],[38,4],[2,22],[38,22],[9,2],[30,2],[9,25],[30,25],[11,6],[28,6],[11,20],[28,20]])drawTree(x*T+T/2,y*T+T/2,ts);
}
function drawTree(x,y,ts){px(x-2,y+3,4,9,'#4d3522');const sway=Math.sin(ts/700+x*.02)*1.2;ctx.fillStyle=display.night?'#13402c':'#22663c';ctx.beginPath();ctx.arc(x+sway,y,9,0,Math.PI*2);ctx.fill();ctx.fillStyle=display.night?'#195037':'#2d8050';ctx.beginPath();ctx.arc(x-3+sway,y-3,6,0,Math.PI*2);ctx.fill()}
function drawDistrictScene(id,d,ts){
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,pulse=(Math.sin(ts/420)+1)/2;
 // paved service apron and pedestrian path to the door
 px(x+w*.32,y+h+8,w*.36,14,display.night?'#2a3337':'#7a786c');px(x+w/2-3,y+h,6,24,display.night?'#3c4547':'#9a9583');
 if(id==='command'){
  px(x+w/2-34,y-18,68,10,'#23384d');px(x+w/2-2,y-36,4,18,'#5f7689');ctx.fillStyle='#71b7ff';ctx.beginPath();ctx.arc(x+w/2,y-39,4+pulse*2,0,Math.PI*2);ctx.fill();
  for(const dx of[-34,28]){px(x+w/2+dx,y+h+27,6,18,'#55432d');px(x+w/2+dx-6,y+h+23,18,5,'#6e5a3d')}
 }else if(id==='ux'){
  px(x-24,y+24,18,54,'#254b55');px(x-21,y+28,12,18,'#59e2ed');px(x-21,y+51,12,18,'#315f69');
  for(let i=0;i<3;i++){px(x+18+i*32,y+h+24,24,5,'#74624c');px(x+20+i*32,y+h+29,3,9,'#493a2d');px(x+37+i*32,y+h+29,3,9,'#493a2d')}
 }else if(id==='docs'){
  for(let i=0;i<4;i++){px(x+w+10,y+18+i*20,22,14,'#493f5a');px(x+w+13,y+21+i*20,4,8,'#c498ff');px(x+w+20,y+21+i*20,3,8,'#8db7ff')}
 }else if(id==='engineering'){
  px(x-30,y+h-20,26,18,'#5d4a32');px(x-27,y+h-17,20,4,'#ffb86a');
  for(let i=0;i<3;i++){px(x+18+i*30,y+h+27,22,8,'#54442f');px(x+22+i*30,y+h+20,14,7,'#8c744e')}
 }else if(id==='validation'){
  for(let i=0;i<3;i++){const gx=x+18+i*38;px(gx,y+h+22,28,4,'#75dfa2');px(gx,y+h+8,3,18,'#486c59');px(gx+25,y+h+8,3,18,'#486c59')}
  ctx.save();ctx.globalAlpha=.18+.12*pulse;ctx.fillStyle='#75dfa2';ctx.fillRect(x+8,y+18,w-16,4);ctx.restore()
 }else if(id==='models'){
  for(let i=0;i<4;i++){const sx=x+12+i*42;px(sx,y+h+20,28,22,'#182838');px(sx+4,y+h+24,20,3,'#ff8494');px(sx+4,y+h+31,20,3,'#71b7ff')}
  ctx.strokeStyle='#ff8494';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x+w-18,y-14,10,Math.PI,Math.PI*2);ctx.stroke()
 }else if(id==='projects'){
  for(let i=0;i<5;i++){px(x+12+i*42,y+h+22,30,7,'#405f95');px(x+16+i*42,y+h+29,4,12,'#2b3d5d');px(x+34+i*42,y+h+29,4,12,'#2b3d5d')}
 }else if(id==='repair'){
  for(let i=0;i<7;i++)px(x-12+i*16,y+h+20,10,5,i%2?'#1e2024':'#ffb23d');
  ctx.fillStyle='rgba(255,115,131,'+(.28+.25*pulse)+')';ctx.beginPath();ctx.arc(x+w+16,y+18,8,0,Math.PI*2);ctx.fill();px(x+w+14,y+2,4,16,'#6c3940')
 }
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
function drawBuilding(id,d,ts){
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,depth=14,workers=districtWorkers(id),active=workers.some(q=>q.state==='running'),bad=workers.some(q=>['error','blocked'].includes(q.state)),done=workers.length&&workers.every(q=>q.state==='complete'),selectedDistrict=selected?.type==='district'&&selected.id===id,pulse=(Math.sin(ts/240)+1)/2;
 const level=buildLevel(id),under=level<.995,top=y+h-h*level;
 ctx.save();
 ctx.shadowColor='rgba(0,0,0,.35)';ctx.shadowBlur=18;px(x+8,y+12,w-2,h-2,'rgba(0,0,0,.28)');ctx.shadowBlur=0;
 px(x-4,y+h-6,w+depth+8,8,display.night?'#2a333b':'#59616a');
 // Only the finished floors are solid; the rest is drawn as a steel frame below.
 ctx.save();if(under){ctx.beginPath();ctx.rect(x-40,top,w+depth+80,h+80);ctx.clip()}
 // side face
 pathPoly([[x+w,y+8],[x+w+depth,y],[x+w+depth,y+h-depth],[x+w,y+h]],display.night?'#152332':'#233749');
 // front
 px(x,y+8,w,h-8,display.night?'#172634':'#223646');
 // roof base and accent
 pathPoly([[x,y+8],[x+depth,y],[x+w+depth,y],[x+w,y+8]],d.roof);
 px(x+8,y+14,w-16,6,d.accent);
 // windows
 const win=active?(pulse>.35?'#ddfbff':'#70dce7'):done?'#7ce0a4':display.night?'#172d3e':'#24455a';
 for(let yy=y+28;yy<y+h-20;yy+=18)for(let xx=x+14;xx<x+w-14;xx+=22){px(xx,yy,10,7,win);px(xx+1,yy+1,8,1,'rgba(255,255,255,.18)')}
 // door + signage
 px(x+w/2-9,y+h-22,18,22,'#0d1720');px(x+w/2-5,y+h-17,4,4,d.accent);
 px(x+10,y+10,28,18,'rgba(6,12,18,.72)');txt(d.icon,x+24,y+19,d.accent,d.icon.length>1?9:13);
 ctx.restore();
 if(under)drawSkeleton(d,x,y,w,h,top,bad,ts);
 // Damage sits on whatever has been built so far.
 if(bad){const by=Math.max(y,top);drawDamage(x,by,w,y+h-by,workers.some(q=>q.state==='running'),ts)}
 if(done&&!under)drawTopping(x,y,w,ts);
 if(display.labels){const tag=workers.length&&(under||bad)?d.name+'  '+(bad?'repair ':'')+Math.round(level*100)+'%':d.name;ctx.fillStyle='rgba(6,11,17,.88)';ctx.fillRect(x+4,y-21,Math.min(w+depth,tag.length*7+18),17);txt(tag,x+10,y-12,bad?'#ffb0b0':active?'#fff':'#c6d4e1',9,'left')}
 if(active){ctx.strokeStyle=d.accent;ctx.globalAlpha=.55+.35*pulse;ctx.lineWidth=3;ctx.strokeRect(x-4,y-4,w+depth+8,h+10);ctx.globalAlpha=1}
 if(done){ctx.fillStyle='#75dfa2';ctx.beginPath();ctx.arc(x+w-8,y+18,5,0,Math.PI*2);ctx.fill()}
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
 const sx=clamp(a.tx??x+w/2,x+16,x+w-16);
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
function siteTrade(a){
 if(districtFlags(a.zone).bad)return'repair';
 const tool=roleStyle(a).tool;
 return{wrench:'hammer',scanner:'weld',tablet:'glass',crate:'bricks',clipboard:'blueprint',holo:'signal',headset:'signal',radio:'signal'}[tool]||'hammer'
}
function drawLadder(x,y1,y2){ctx.save();ctx.strokeStyle='#c9a46a';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x-5,y1);ctx.lineTo(x-5,y2);ctx.moveTo(x+5,y1);ctx.lineTo(x+5,y2);for(let yy=y2+3;yy<y1;yy+=6){ctx.moveTo(x-5,yy);ctx.lineTo(x+5,yy)}ctx.stroke();ctx.restore()}
function drawSiteWork(a,ts){
 const x=a.x,y=a.y,seed=a.activitySeed||0,sx=x+9,sy=y-6,trade=siteTrade(a),s=roleStyle(a);
 const arm=(ang,len=13)=>{const hx=sx+Math.cos(ang)*len,hy=sy+Math.sin(ang)*len;ctx.strokeStyle=s.skin;ctx.lineWidth=6;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(hx,hy);ctx.stroke();ctx.fillStyle='#f2b23d';ctx.beginPath();ctx.arc(hx,hy,3.5,0,Math.PI*2);ctx.fill();return{hx,hy}};
 if(a.climbing){const k=Math.sin(ts/110+seed);arm(-1.9+k*.5,12);return}
 if(trade==='hammer'){
  const t=((ts/520)+seed)%1,ang=t<.72?-.4-1.9*(t/.72):-2.3+2.3*((t-.72)/.28),{hx,hy}=arm(ang);
  const hx2=hx+Math.cos(ang)*9,hy2=hy+Math.sin(ang)*9;ctx.strokeStyle='#8b5a2b';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(hx,hy);ctx.lineTo(hx2,hy2);ctx.stroke();
  ctx.save();ctx.translate(hx2,hy2);ctx.rotate(ang+Math.PI/2);px(-5,-3,10,5,'#9aa6b1');ctx.restore();
  const cyc=Math.floor((ts/520)+seed);if(t>.96&&a.lastStrike!==cyc){a.lastStrike=cyc;spawnSpark(x+20,y+16,'#ffd36b',5);dust.push({x:x+20,y:y+18,vx:6,vy:-6,r:2,life:.45})}
 }else if(trade==='weld'){
  px(x-8,y-24,16,7,'#1d2a33');px(x-6,y-23,12,4,'#2f8fa8');
  const {hx,hy}=arm(-.15);ctx.strokeStyle='#4b5866';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(hx,hy);ctx.lineTo(hx+8,hy+5);ctx.stroke();
  const fl=Math.random();ctx.save();ctx.shadowColor='#bfefff';ctx.shadowBlur=16+fl*12;ctx.fillStyle=fl>.5?'#ffffff':'#bfefff';ctx.beginPath();ctx.arc(hx+9,hy+6,2+fl*2.5,0,Math.PI*2);ctx.fill();ctx.restore();
  if(fl>.55)spawnSpark(hx+9,hy+6,fl>.8?'#ffffff':'#ffb224',2)
 }else if(trade==='glass'){
  const t=((ts/1600)+seed)%1,lift=Math.sin(t*Math.PI)*6;arm(-1.25);
  ctx.save();ctx.globalAlpha=.75;px(x+4,y-34-lift,18,20,'#5fd3e8');ctx.globalAlpha=1;ctx.strokeStyle='#d8f6ff';ctx.lineWidth=1;ctx.strokeRect(x+4,y-34-lift,18,20);
  if(t>.45&&t<.55){ctx.strokeStyle='rgba(255,255,255,.9)';ctx.beginPath();ctx.moveTo(x+7,y-30-lift);ctx.lineTo(x+13,y-24-lift);ctx.stroke()}ctx.restore()
 }else if(trade==='bricks'){
  const t=((ts/1300)+seed)%1,up=Math.sin(t*Math.PI);const {hx,hy}=arm(-.3-1.1*up);px(hx-6,hy-8,12,8,'#c96a4a');px(hx-6,hy-5,12,1,'#8a3f2b');
  if(t>.48&&t<.52)dust.push({x:hx,y:hy-2,vx:0,vy:-4,r:1.5,life:.35})
 }else if(trade==='blueprint'){
  px(x-4,y-8,26,12,'#2c5aa0');ctx.strokeStyle='rgba(255,255,255,.75)';ctx.lineWidth=1;ctx.strokeRect(x-1,y-6,8,7);ctx.beginPath();ctx.moveTo(x+9,y-4);ctx.lineTo(x+19,y-4);ctx.moveTo(x+9,y);ctx.lineTo(x+16,y);ctx.stroke();
  const t=Math.sin(ts/260+seed);const {hx,hy}=arm(.25+t*.35,12);px(hx-1,hy-6,2,7,'#f2d06b')
 }else if(trade==='signal'){
  const w=Math.sin(ts/170+seed);arm(-1.75+w*.35,14);px(x-17,y-20,5,9,'#16222c');px(x-16,y-18,3,2,s.accent);
  ctx.save();ctx.strokeStyle=s.accent;ctx.lineWidth=1.5;for(let i=0;i<3;i++){const k=((ts/700)+i/3)%1;ctx.globalAlpha=(1-k)*.8;ctx.beginPath();ctx.arc(x-15,y-22,4+k*12,-2.4,-.8);ctx.stroke()}ctx.restore()
 }else{
  const ang=-.6+Math.sin(ts/140+seed)*.7,{hx,hy}=arm(-.2);ctx.save();ctx.translate(hx+4,hy);ctx.rotate(ang);ctx.strokeStyle='#d5dee8';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(10,0);ctx.stroke();ctx.beginPath();ctx.arc(12,0,3.5,0,Math.PI*2);ctx.stroke();ctx.restore();
  if(Math.random()<.25)spawnSpark(hx+12,hy,Math.random()<.5?'#ff9b9b':'#ffffff',2)
 }
}
function drawWorkingAction(a,ts){
 if(a.onSite){drawSiteWork(a,ts);return}
 if(a.state!=='running'||workerIsMoving(a))return;const s=roleStyle(a),phase=Math.sin(ts/120+a.activitySeed),x=a.x,y=a.y;
 if(['engineer','code_analyst','deployer'].includes(a.id)){ctx.strokeStyle='#d7e0e8';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x+10,y-1);ctx.lineTo(x+17+phase*3,y-11);ctx.stroke()}
 else if(['validator','test_engineer','security_reviewer'].includes(a.id)){ctx.save();ctx.globalAlpha=.18+.12*Math.abs(phase);ctx.fillStyle=s.accent;ctx.beginPath();ctx.moveTo(x+10,y-6);ctx.lineTo(x+34,y-16);ctx.lineTo(x+34,y+5);ctx.closePath();ctx.fill();ctx.restore()}
 else if(['ux_analyst','documentation','research_agent'].includes(a.id)){px(x+10,y-7,13,9,'#111d29');px(x+12,y-5,9,5,s.accent);px(x+12+Math.floor((ts/180)%7),y+2,2,2,'#fff')}
 else{ctx.strokeStyle=s.accent;ctx.globalAlpha=.65;ctx.strokeRect(x+10,y-15,18,12);ctx.beginPath();ctx.moveTo(x+13,y-5);ctx.lineTo(x+18,y-10);ctx.lineTo(x+23,y-7);ctx.lineTo(x+26,y-13);ctx.stroke();ctx.globalAlpha=1}
}
function drawTraffic(){for(const c of traffic){ctx.save();ctx.translate(c.x,c.y);px(-7,-4,14,8,c.color);px(-4,-6,8,3,'#b8dbff');px(-5,4,3,2,'#0b0e12');px(2,4,3,2,'#0b0e12');ctx.restore()}}
function dependencyState(from,to){
 if(['error','blocked'].includes(from.state)||['error','blocked'].includes(to.state))return'blocked';
 if(from.state==='complete'&&to.state==='running')return'active';
 if(from.state==='complete')return'ready';
 return'waiting'
}
function drawFlows(ts){
 if(!display.flows||!current?.workers?.length)return;
 ctx.save();ctx.lineCap='round';
 for(const w of current.workers){for(const dep of w.dependsOn||[]){const a=current.workers.find(x=>x.id===dep);if(!a)continue;const p1=districtCenter(zoneForWorker(a)),p2=districtCenter(zoneForWorker(w)),state=dependencyState(a,w),pulse=(Math.sin(ts/180)+1)/2;
  ctx.setLineDash(state==='waiting'?[3,9]:state==='blocked'?[2,6]:[7,6]);ctx.lineDashOffset=-(ts/(state==='active'?45:90))%13;
  ctx.strokeStyle=state==='blocked'?'rgba(255,115,131,.82)':state==='active'?('rgba(89,226,237,'+(.55+.35*pulse)+')'):state==='ready'?'rgba(117,223,162,.55)':'rgba(120,145,170,.26)';
  ctx.lineWidth=state==='active'?3:2;ctx.shadowColor=state==='active'?'#59e2ed':'transparent';ctx.shadowBlur=state==='active'?10:0;ctx.beginPath();ctx.moveTo(p1.x,p1.y);ctx.lineTo(p2.x,p2.y);ctx.stroke();
  if(state==='active'){const t=((ts/900)%1),mx=p1.x+(p2.x-p1.x)*t,my=p1.y+(p2.y-p1.y)*t;ctx.fillStyle='#eaffff';ctx.beginPath();ctx.arc(mx,my,3,0,Math.PI*2);ctx.fill()}
 }}
 ctx.setLineDash([]);ctx.shadowBlur=0;ctx.restore()
}
function roleStyle(a){return a.style||ROLE_STYLE[a.id]||ROLE_STYLE.synthesis}
function workerIsMoving(a){return !!(a.path?.length&&a.pathI<a.path.length)}
function workerIsRunning(a){return a.state==='running'&&workerIsMoving(a)}
function spawnRunDust(a,ts){
 if(reduced||ts-(a.lastDust||0)<85)return;a.lastDust=ts;
 for(let i=0;i<2;i++)dust.push({x:a.x-a.dir*(7+Math.random()*5),y:a.y+16+Math.random()*3,vx:-a.dir*(10+Math.random()*16),vy:-4-Math.random()*8,r:2+Math.random()*2,life:.42})
}
function drawWorkerTool(a,x,y,bob,walk){
 const s=roleStyle(a),dir=a.dir||1,handX=x+dir*9,handY=y-3+bob,tool=s.tool;
 if(tool==='tablet'){px(handX+(dir>0?0:-8),handY-2,8,6,'#14212d');px(handX+(dir>0?1:-7),handY-1,6,4,s.accent)}
 else if(tool==='clipboard'){px(handX+(dir>0?0:-7),handY-2,7,8,'#e9e3ce');px(handX+(dir>0?2:-5),handY,3,1,'#556272');px(handX+(dir>0?2:-5),handY+3,3,1,'#556272')}
 else if(tool==='wrench'){ctx.strokeStyle='#d5dee8';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(handX,handY+5);ctx.lineTo(handX+dir*7,handY-3);ctx.stroke();ctx.beginPath();ctx.arc(handX+dir*8,handY-4,3,0,Math.PI*2);ctx.stroke()}
 else if(tool==='scanner'){px(handX+(dir>0?0:-6),handY-1,6,7,'#172531');px(handX+(dir>0?1:-5),handY,4,2,s.accent);ctx.globalAlpha=.25;ctx.fillStyle=s.accent;ctx.beginPath();ctx.moveTo(handX+dir*5,handY+1);ctx.lineTo(handX+dir*18,handY-4);ctx.lineTo(handX+dir*18,handY+7);ctx.closePath();ctx.fill();ctx.globalAlpha=1}
 else if(tool==='headset'){ctx.strokeStyle=s.accent;ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y-18+bob,7,Math.PI,Math.PI*2);ctx.stroke();px(x+dir*7,y-18+bob,2,6,s.accent);px(x+dir*8,y-13+bob,5,2,s.accent)}
 else if(tool==='holo'){ctx.strokeStyle=s.accent;ctx.globalAlpha=.7;ctx.lineWidth=1;ctx.strokeRect(handX+(dir>0?0:-10),handY-6,10,8);ctx.globalAlpha=.18;ctx.fillStyle=s.accent;ctx.fillRect(handX+(dir>0?0:-10),handY-6,10,8);ctx.globalAlpha=1}
 else if(tool==='crate'){px(handX+(dir>0?-1:-9),handY-2,10,9,'#8b643c');px(handX+(dir>0?1:-7),handY,6,1,'#d7aa61');px(handX+(dir>0?3:-5),handY-2,1,9,'#5b4028')}
 else if(tool==='radio'){px(handX+(dir>0?0:-5),handY-3,5,8,'#16222c');px(handX+(dir>0?1:-4),handY-1,3,2,s.accent);ctx.strokeStyle='#8797a8';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(handX+dir*2,handY-3);ctx.lineTo(handX+dir*4,handY-8);ctx.stroke()}
}
function drawWorkerHat(a,x,y,bob){
 const s=roleStyle(a),helmet=s.hat||'#f4c448';
 // oversized rounded hard hat with brim, closer to a chunky construction-game character
 ctx.fillStyle=helmet;ctx.beginPath();ctx.ellipse(x,y-27+bob,10,6,0,Math.PI,Math.PI*2);ctx.fill();
 px(x-9,y-27+bob,18,5,helmet);px(x-6,y-31+bob,12,5,helmet);px(x+(a.dir>0?4:-10),y-24+bob,10,3,'#d39a2d');
 // helmet role stripe
 px(x-2,y-31+bob,4,7,s.accent);
 // hair showing under helmet
 px(x-7,y-23+bob,4,4,s.hair);px(x+3,y-23+bob,4,3,s.hair)
}
function drawWorkerBubble(a,x,y,ts){
 if(a.state==='running'){const labels={router:'ROUTE',mission_router:'ROUTE',ux_analyst:'AUDIT',documentation:'WRITE',synthesis:'MERGE',coordinator:'MERGE',engineer:'BUILD',validator:'TEST',reviewer:'REVIEW',deployer:'SHIP',operator:'WATCH'},label=labels[a.id]||'WORK',pulse=(Math.sin(ts/350+a.activitySeed)+1)/2,w=Math.max(34,label.length*6+12);ctx.fillStyle='rgba(5,10,16,.88)';ctx.fillRect(x-w/2,y-46,w,14);px(x-2,y-32,4,4,'rgba(5,10,16,.88)');txt(label,x,y-39,pulse>.35?'#ffffff':roleStyle(a).accent,7)}
 else if(a.state==='complete'){ctx.fillStyle='rgba(5,10,16,.86)';ctx.fillRect(x-16,y-43,32,14);txt('DONE',x,y-36,'#75dfa2',7)}
 else if(['error','blocked'].includes(a.state)){ctx.fillStyle='rgba(70,18,27,.92)';ctx.fillRect(x-18,y-43,36,14);txt('!',x,y-36,'#ffd2d7',10)}
}
function drawRunningWorkerSprite(a,ts){
 const s=roleStyle(a),phase=Math.sin(a.step),kick=Math.cos(a.step),dir=a.dir||1,x=a.x,y=a.y-2+Math.abs(phase)*1.4,stateColor=s.accent;
 ctx.save();ctx.translate(x,y);ctx.rotate(dir*.07);
 // stretched moving shadow
 ctx.fillStyle='rgba(0,0,0,.28)';ctx.beginPath();ctx.ellipse(-dir*4,21,18,5,-dir*.08,0,Math.PI*2);ctx.fill();
 // speed streaks
 ctx.globalAlpha=.38;ctx.strokeStyle=s.accent;ctx.lineWidth=2;
 for(let i=0;i<3;i++){ctx.beginPath();ctx.moveTo(-dir*(20+i*6),-2+i*6);ctx.lineTo(-dir*(9+i*4),-2+i*6);ctx.stroke()}ctx.globalAlpha=1;
 // legs: long opposing running stride
 ctx.strokeStyle=s.pants;ctx.lineWidth=8;ctx.lineCap='round';
 ctx.beginPath();ctx.moveTo(-4,6);ctx.lineTo(-8-dir*phase*8,13);ctx.lineTo(-13-dir*phase*12,18);ctx.stroke();
 ctx.beginPath();ctx.moveTo(4,6);ctx.lineTo(8+dir*phase*8,12);ctx.lineTo(12+dir*phase*12,17);ctx.stroke();
 // boots
 ctx.strokeStyle='#2a211b';ctx.lineWidth=5;
 ctx.beginPath();ctx.moveTo(-13-dir*phase*12,18);ctx.lineTo(-18-dir*phase*12,18);ctx.stroke();
 ctx.beginPath();ctx.moveTo(12+dir*phase*12,17);ctx.lineTo(17+dir*phase*12,17);ctx.stroke();
 // torso leaned into the run
 ctx.fillStyle=s.shirt;ctx.beginPath();ctx.roundRect(-12,-10,24,20,6);ctx.fill();
 ctx.fillStyle=s.vest||'#ff9d33';ctx.beginPath();ctx.roundRect(-10,-9,20,15,4);ctx.fill();
 px(-2+x-x,-9+y-y,4,15,s.shirt); // local vest opening
 ctx.fillStyle='#ffe885';ctx.fillRect(-9,-3,18,2);ctx.fillRect(-9,2,18,2);
 ctx.fillStyle='#4d3828';ctx.fillRect(-11,6,22,4);
 // arms pump hard opposite the legs
 ctx.strokeStyle=s.skin;ctx.lineWidth=8;
 ctx.beginPath();ctx.moveTo(-10,-5);ctx.lineTo(-15+dir*phase*8,-1);ctx.lineTo(-10+dir*phase*13,5);ctx.stroke();
 ctx.beginPath();ctx.moveTo(10,-5);ctx.lineTo(15-dir*phase*8,-2);ctx.lineTo(10-dir*phase*13,-10);ctx.stroke();
 ctx.fillStyle='#f2b23d';ctx.beginPath();ctx.arc(-10+dir*phase*13,5,4,0,Math.PI*2);ctx.arc(10-dir*phase*13,-10,4,0,Math.PI*2);ctx.fill();
 // head and hard hat
 ctx.fillStyle=s.skin;ctx.beginPath();ctx.roundRect(-10,-27,20,15,6);ctx.fill();
 ctx.fillStyle=s.hair;ctx.fillRect(-7,-24,14,4);
 ctx.fillStyle='#18222b';ctx.fillRect(-5,-20,3,3);ctx.fillRect(2,-20,3,3);
 ctx.fillStyle=s.hat||'#f4c448';ctx.beginPath();ctx.ellipse(0,-29,10,6,0,Math.PI,Math.PI*2);ctx.fill();ctx.fillRect(-9,-29,18,5);ctx.fillRect(-6,-33,12,5);ctx.fillStyle=s.accent;ctx.fillRect(-2,-33,4,7);
 // role patch + backpack
 ctx.fillStyle=s.accent;ctx.beginPath();ctx.roundRect(4,-7,6,6,2);ctx.fill();ctx.fillStyle='#4a4036';ctx.fillRect(-dir*14,-5,4,11);
 ctx.restore();
 // tool stays readable while running
 drawWorkerTool(a,x+dir*2,y+1,0,phase*3);
 // running state beacon
 ctx.save();ctx.shadowColor=stateColor;ctx.shadowBlur=14;ctx.fillStyle=stateColor;ctx.beginPath();ctx.arc(x,y-40,3+(Math.sin(ts/150)+1),0,Math.PI*2);ctx.fill();ctx.restore()
}
function drawWorkerSprite(a,ts){
 const s=roleStyle(a),moving=workerIsMoving(a),running=workerIsRunning(a),walk=moving?Math.sin(a.step)*2.4:0,idle=!moving?Math.sin(ts/680+a.activitySeed)*.7:0,bob=(a.state==='running'?Math.sin(a.bob)*1.1:idle),x=a.x,y=a.y+bob,sel=selected?.type==='agent'&&selected.id===a.id,stateColor=['error','blocked'].includes(a.state)?'#ff7383':a.state==='complete'?'#75dfa2':a.state==='pending'?'#6d7985':s.accent;
 if(sel){ctx.save();ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.shadowColor=stateColor;ctx.shadowBlur=14;ctx.beginPath();ctx.ellipse(x,y+18,21,10,0,0,Math.PI*2);ctx.stroke();ctx.restore()}
 if(running){drawRunningWorkerSprite(a,ts)}
 else{
  ctx.fillStyle='rgba(0,0,0,.30)';ctx.beginPath();ctx.ellipse(x,y+20,14,6,0,0,Math.PI*2);ctx.fill();
  ctx.fillStyle=s.pants;ctx.beginPath();ctx.roundRect(x-10,y+4+walk,8,14,3);ctx.fill();ctx.beginPath();ctx.roundRect(x+2,y+4-walk,8,14,3);ctx.fill();
  ctx.fillStyle='#2a211b';ctx.beginPath();ctx.roundRect(x-11,y+15+walk,10,5,2);ctx.fill();ctx.beginPath();ctx.roundRect(x+1,y+15-walk,10,5,2);ctx.fill();
  ctx.fillStyle=a.state==='pending'?'#8a7563':s.shirt;ctx.beginPath();ctx.roundRect(x-12,y-10,24,20,6);ctx.fill();
  ctx.fillStyle=s.vest||'#ff9d33';ctx.beginPath();ctx.roundRect(x-10,y-9,20,15,4);ctx.fill();px(x-2,y-9,4,15,s.shirt);px(x-9,y-3,18,2,'#ffe885');px(x-9,y+2,18,2,'#ffe885');px(x-11,y+6,22,4,'#4d3828');px(x-2,y+6,5,4,'#d59a3d');
  ctx.fillStyle=s.skin;ctx.beginPath();ctx.ellipse(x-14,y-2-walk*.25,5,9,-.15,0,Math.PI*2);ctx.fill();if(!a.onSite){ctx.beginPath();ctx.ellipse(x+14,y-2+walk*.25,5,9,.15,0,Math.PI*2);ctx.fill()}
  ctx.fillStyle='#f2b23d';ctx.beginPath();ctx.arc(x-15,y+5-walk*.25,4,0,Math.PI*2);ctx.fill();if(!a.onSite){ctx.beginPath();ctx.arc(x+15,y+5+walk*.25,4,0,Math.PI*2);ctx.fill()}
  px(x-4,y-14,8,5,s.skin);ctx.fillStyle=s.skin;ctx.beginPath();ctx.roundRect(x-10,y-27,20,15,6);ctx.fill();ctx.beginPath();ctx.arc(x-10,y-20,3,0,Math.PI*2);ctx.arc(x+10,y-20,3,0,Math.PI*2);ctx.fill();
  px(x-6,y-23,5,2,s.hair);px(x+1,y-23,5,2,s.hair);px(x-5,y-20,3,3,'#18222b');px(x+2,y-20,3,3,'#18222b');px(x-2,y-16,5,2,'#965b46');
  drawWorkerHat(a,x,y,bob);if(!a.onSite)drawWorkerTool(a,x,y+2,bob,walk);
  ctx.fillStyle=s.accent;ctx.beginPath();ctx.roundRect(x+4,y-7,6,6,2);ctx.fill();ctx.fillStyle='#071019';ctx.font='900 5px ui-monospace,monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText((s.badge||a.glyph).slice(0,2),x+7,y-4);px(x+(a.dir>0?-14:10),y-5,4,11,'#4a4036');
  ctx.save();ctx.shadowColor=stateColor;ctx.shadowBlur=a.state==='running'?14:6;ctx.fillStyle=stateColor;ctx.beginPath();ctx.arc(x,y-38,3+(a.state==='running'?(Math.sin(ts/180)+1):0),0,Math.PI*2);ctx.fill();ctx.restore()
 }
 const isHover=hovered?.type==='agent'&&hovered.id===a.id;
 if(display.labels&&(sel||isHover)){const labelW=Math.min(110,Math.max(58,a.name.length*6+16));ctx.fillStyle='rgba(5,10,16,.92)';ctx.fillRect(x-labelW/2,y+25,labelW,17);txt(a.name,x,y+33,'#eef6ff',8)}
 if(sel||(a.state==='running'&&view.zoom>1.55))drawWorkerBubble(a,x,y-1,ts)
}
function drawAgents(ts){
 for(const d of dust){ctx.globalAlpha=clamp(d.life/.42,0,1)*.5;ctx.fillStyle=display.night?'#70808c':'#c5b99a';ctx.beginPath();ctx.arc(d.x,d.y,d.r,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=1;for(const a of agents.values()){drawWorkerSprite(a,ts);drawWorkingAction(a,ts)}
 for(const p of packets){ctx.save();ctx.shadowColor=p.color;ctx.shadowBlur=12;px(p.x-6,p.y-5,12,9,'#182431');px(p.x-5,p.y-4,10,7,p.color);px(p.x-2,p.y-2,4,2,'#fff');ctx.restore();if(view.zoom>1.35){ctx.fillStyle='rgba(5,10,16,.88)';ctx.fillRect(p.x-22,p.y-20,44,11);txt(p.label||'DATA',p.x,p.y-14,'#eaf5ff',6)}}
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
function drawClouds(ts){if(display.night)return;ctx.save();ctx.globalAlpha=.08;for(const c of clouds){const x=(c.x+ts*.006*c.s)%W,y=c.y;ctx.fillStyle='#d8f0ff';ctx.beginPath();ctx.arc(x,y,26*c.s,0,Math.PI*2);ctx.arc(x+28*c.s,y+6,20*c.s,0,Math.PI*2);ctx.arc(x-25*c.s,y+8,17*c.s,0,Math.PI*2);ctx.fill()}ctx.restore()}function drawCommandCelebration(ts){
 if(ts>celebrationUntil)return;const d=DISTRICTS.command,x=(d.x+d.w/2)*T,y=d.y*T-10,life=clamp((celebrationUntil-ts)/3600,0,1);
 ctx.save();ctx.globalAlpha=Math.min(1,life*2);
 for(let i=0;i<18;i++){const a=i/18*Math.PI*2,r=18+(1-life)*90,c=i%3===0?'#75dfa2':i%3===1?'#71b7ff':'#f5c04f';px(x+Math.cos(a)*r,y+Math.sin(a)*r*.55,4,4,c)}
 ctx.strokeStyle='rgba(117,223,162,'+(.35+.35*Math.sin(ts/160))+')';ctx.lineWidth=3;ctx.beginPath();ctx.arc(x,y,20+(1-life)*28,0,Math.PI*2);ctx.stroke();txt('MISSION COMPLETE',x,y-30,'#eafff1',8);ctx.restore()
}

function drawMinimap(){
 const el=$('#awcMinimap',root);if(!el)return;
 const markers=Object.entries(DISTRICTS).map(([id,d])=>`<i style="left:${((d.x+d.w/2)*T/W)*100}%;top:${((d.y+d.h/2)*T/H)*100}%;--c:${d.accent}" title="${esc(d.name)}"></i>`).join('');
 el.innerHTML='<span></span>'+markers;
}
function draw(ts){
 ctx.clearRect(0,0,W,H);ctx.save();ctx.translate(view.panX,view.panY);ctx.scale(view.zoom,view.zoom);drawGround(ts);drawFlows(ts);drawTraffic();for(const[id,d]of Object.entries(DISTRICTS)){drawDistrictScene(id,d,ts);drawBuilding(id,d,ts);drawInterior(id,d,ts);drawWorksite(id,d,ts)}drawAgents(ts);drawCommandCelebration(ts);drawClouds(ts);if(display.night){ctx.fillStyle='rgba(3,7,14,.18)';ctx.fillRect(0,0,W,H)}ctx.restore()
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
async function bootstrap(){try{const r=await fetch('/api/agents/missions'),j=await r.json(),items=j.items||j.missions||[],active=items.find(m=>m.status==='running')||items[0];if(active){applyMission(active);connectSSE();return}}catch{}try{const r=await fetch('/api/engineering/runs'),j=await r.json(),runs=j.items||[],active=runs.find(x=>x.status==='running')||runs[0];if(active)applyEngineering(active)}catch{}connectSSE()}
let unsubscribeSSE=null;
function connectSSE(){if(unsubscribeSSE)return;try{unsubscribeSSE=missionStream.subscribe(m=>{liveSnapshot=normalizeMission(m);applyMission(m)})}catch{}}
document.addEventListener('localai:engineering-run',e=>applyEngineering(e.detail?.run||e.detail));window.addEventListener('localai:agentworld-replay-mission',e=>{const m=e.detail?.mission;if(m){loadMissionReplay(m);if((m.timeline||[]).length>1)applyReplayFrame(0)}});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{mount();drawMinimap()},{once:true});else{mount();drawMinimap()}
})();

// ==== claude-board.js ====
(() => {
  'use strict';

  // Claude board: live progress of Claude Code sessions plus a ranked, votable board of the findings they report.
  const POLL_MS = 4000;
  const SEVERITIES = ['high', 'medium', 'low'];
  const OPEN = new Set(['proposed', 'approved', 'in_progress']);
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
      $('claudeFindings').innerHTML = `<div class="empty">Claude board unavailable: ${esc(e.message)}</div>`;
    } finally { view.busy = false; }
  }

  function render() {
    const d = view.data;
    renderSessions(d.sessions);
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

  function renderProgress(summary, statuses) {
    const total = summary.total || 0;
    const order = ['fixed', 'in_progress', 'approved', 'proposed', 'deferred', 'rejected'];
    const bar = total ? order.map((k) => {
      const n = summary.byStatus[k] || 0;
      return n ? `<span class="seg st-${k}" style="flex:${n}" title="${esc(STATUS[k].label)}: ${n}"></span>` : '';
    }).join('') : '<span class="seg empty-seg" style="flex:1"></span>';
    const fixed = summary.byStatus.fixed || 0;
    const open = order.filter((k) => OPEN.has(k)).reduce((n, k) => n + (summary.byStatus[k] || 0), 0);
    $('claudeProgress').innerHTML = `
      <div class="claude-progress-head"><strong>${fixed} of ${total} findings done</strong><span>${summary.byStatus.proposed || 0} need your decision · ${(summary.byStatus.approved || 0) + (summary.byStatus.in_progress || 0)} with Claude</span></div>
      <div class="claude-bar">${bar}</div>
      <div class="claude-legend">${order.map((k) => `<span><i class="dot st-${k}"></i>${esc(STATUS[k].short)} ${summary.byStatus[k] || 0}</span>`).join('')}</div>`;
  }

  function renderTimeline(events) {
    const box = $('claudeTimeline');
    if (!events.length) { box.innerHTML = '<div class="empty">No Claude activity reported yet.</div>'; return; }
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
    if (!cats.length) { $('claudeMatrix').innerHTML = '<div class="empty">No findings yet.</div>'; return; }
    $('claudeMatrix').innerHTML = `<table class="claude-matrix"><thead><tr><th>Category</th>${SEVERITIES.map((s) => `<th>${s}</th>`).join('')}<th>Open</th></tr></thead><tbody>${cats.map(([cat, c]) => `
      <tr class="${view.category === cat ? 'selected' : ''}">
        <th><button type="button" data-claude-cat="${esc(cat)}">${esc(catLabel(cat))}</button></th>
        ${SEVERITIES.map((s) => `<td><button type="button" class="heat sev-${s}${view.category === cat && view.severity === s ? ' selected' : ''}" style="--heat:${c[s] / max}" data-claude-cat="${esc(cat)}" data-claude-sev="${s}" ${c[s] ? '' : 'disabled'}>${c[s] || ''}</button></td>`).join('')}
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
    $('claudeFilters').innerHTML = TABS.map(([k, label, test]) => {
      const n = findings.filter(test).length;
      return `<button type="button" class="chip tab${view.statusFilter === k ? ' active' : ''}" data-claude-status="${k}" aria-pressed="${view.statusFilter === k}">${esc(label)} <b>${n}</b></button>`;
    }).join('') + (view.category ? `<button type="button" class="chip clear" data-claude-clear>${esc(view.category)}${view.severity ? ` · ${esc(view.severity)}` : ''} ✕</button>` : '');
    const list = visible(findings);
    const top = Math.max(1, ...findings.map((f) => f.score));
    $('claudeFindingCount').textContent = `${list.length} shown`;
    if (!list.length) {
      const empty = { decide: 'Nothing is waiting for your decision.', queued: 'Nothing is queued. Approve a finding to send it to Claude.', working: 'Claude is not working on anything right now.', done: 'Nothing is done yet.', aside: 'Nothing has been set aside.' }[view.statusFilter] || 'Nothing matches these filters.';
      $('claudeFindings').innerHTML = `<div class="empty">${esc(empty)}</div>`;
      return;
    }
    $('claudeFindings').innerHTML = list.map((f) => {
      const st = STATUS[f.status] || STATUS.proposed;
      const actions = (ACTIONS[f.status] || []).map(([to, label, style]) => `<button type="button" class="btn small ${style}" data-claude-decision="${to}">${esc(label)}</button>`).join('');
      const note = view.noteId === f.id
        ? `<form class="claude-note-form" data-claude-note-form><textarea rows="2" maxlength="1000" placeholder="Context or instructions for Claude">${esc(f.decisionNote || '')}</textarea><div><button type="submit" class="btn small primary">Save note</button><button type="button" class="btn small quiet" data-claude-note-cancel>Cancel</button></div></form>`
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
          <button type="button" class="btn" data-claude-vote="1" aria-label="Raise priority" title="Raise priority">▲</button>
          <span title="${f.votes.up} up · ${f.votes.down} down">${f.votes.up - f.votes.down}</span>
          <button type="button" class="btn" data-claude-vote="-1" aria-label="Lower priority" title="Lower priority">▼</button>
        </div>
        <div class="claude-decide">${actions}${note}</div>
      </article>`;
    }).join('');
  }

  // Decisions update the card immediately, then sync; a toast offers Undo for six seconds.
  function toast(message, undo) {
    let el = $('claudeToast');
    if (!el) { el = document.createElement('div'); el.id = 'claudeToast'; el.className = 'claude-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button" class="btn small">Undo</button>' : ''}`;
    el.classList.add('show');
    if (undo) el.querySelector('button').onclick = () => { el.classList.remove('show'); undo(); };
    clearTimeout(view.toastTimer);
    view.toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
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
    try { await fn(); await load(); } catch (e) { (window.toast || alert)(e.message); }
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
  const STORE_KEY = 'localai.claudeChat.session';
  const $ = (id) => document.getElementById(id);
  const st = { mode: 'init', sessions: [], session: '', messages: [], after: 0, sending: false, pair: null, pairError: '', pairTimer: 0,
    pollTimer: 0, sessionsAt: 0, polling: false, devices: [], devicesOpen: false, draft: '', built: '' };

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
      st.pair = await api('pair-request', {});
      render();
      st.pairTimer = setInterval(checkPair, PAIR_MS);
    } catch (e) {
      st.pairError = e.status === 429 ? 'Too many pending pairing requests — try again in a few minutes.' : `Could not start pairing: ${e.message}`;
      render();
    }
  }

  async function checkPair() {
    if (!st.pair || !isActive() || document.visibilityState !== 'visible') return;
    try {
      const r = await api(`pair-status?id=${encodeURIComponent(st.pair.id)}`);
      if (r.status === 'approved') { stopPairTimer(); st.pair = null; await loadSessions(true); }
      else if (r.status === 'expired') { stopPairTimer(); st.pair = { expired: true }; render(); }
    } catch { /* keep waiting; the next tick tries again */ }
  }

  // ---- Sessions and messages ----
  async function loadSessions(force) {
    try {
      const r = await api('sessions');
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
      if (e.status === 401) { if (st.mode !== 'pair' && isActive()) startPairing(); else if (st.mode === 'paired') st.mode = 'init'; }
      else if (st.mode === 'init') { st.mode = 'error'; st.pairError = `Chat is unavailable: ${e.message}`; render(); }
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
      if (e.status === 401) startPairing();
    } finally { st.polling = false; }
  }

  function schedule() {
    clearTimeout(st.pollTimer);
    const fast = isActive() && document.visibilityState === 'visible';
    st.pollTimer = setTimeout(async () => {
      if (st.mode === 'paired') {
        if (fast && Date.now() - st.sessionsAt >= SESSIONS_MS) await loadSessions(); else await poll();
      } else if (st.mode === 'init' && fast) await loadSessions();
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
    if (was?.current) { st.mode = 'pair'; st.sessions = []; st.session = ''; st.messages = []; st.after = 0; startPairing(); }
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
      const retry = el('button', 'btn', 'Try again'); retry.type = 'button'; retry.dataset.chatAction = 'pair';
      box.append(retry);
    } else if (st.pair?.expired) {
      box.append(el('p', 'claude-chat-error', 'That code expired.'));
      const again = el('button', 'btn primary', 'Get a new code'); again.type = 'button'; again.dataset.chatAction = 'pair';
      box.append(again);
    } else {
      const code = el('div', 'claude-chat-code', st.pair ? st.pair.code : '…');
      code.id = 'claudeChatCode';
      box.append(el('p', 'meta', 'Your pairing code'), code, el('p', 'meta', 'On your Mac, run:'));
      const cmd = el('div', 'claude-chat-cmd');
      cmd.append(el('code', null, st.pair ? `localai-chat pair ${st.pair.code}` : '…'));
      const copy = el('button', 'btn', 'Copy'); copy.type = 'button'; copy.dataset.chatAction = 'copy';
      cmd.append(copy);
      box.append(cmd, el('p', 'meta claude-chat-wait', st.pair ? 'Waiting for approval… this page switches over by itself.' : 'Requesting a code…'));
    }
    box.append(el('p', 'claude-chat-warning', HTTP_WARNING));
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
    const sendBtn = el('button', 'btn primary', 'Send'); sendBtn.id = 'claudeChatSend'; sendBtn.type = 'button';
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
        const del = el('button', 'btn quiet', 'Delete'); del.type = 'button'; del.dataset.chatAction = 'delete'; del.dataset.id = m.id;
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
      const b = el('button', 'btn quiet', d.current ? 'Revoke this device' : 'Revoke'); b.type = 'button'; b.dataset.chatAction = 'revoke'; b.dataset.id = d.id;
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
    api('whoami').then((r) => { if (r.paired || isActive()) loadSessions(); }, () => loadSessions());
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
      id: 'n8n', name: 'n8n', tier: 'native', decision: 'Native owner', source: 'n8n',
      summary: 'Primary workflow automation engine. Keep orchestration here instead of adding Bardeen, Coze, or another parallel automation runtime.',
      guidance: "After adding credentials, community nodes, or public webhooks, run n8n's official security audit and review any risky-node findings.",
      actions: [
        { type: 'view', view: 'automations', label: 'Open n8n workflows' },
        { type: 'url', url: 'https://docs.n8n.io/hosting/securing/security-audit/', label: 'Security audit docs' }
      ]
    },
    {
      id: 'comfyui', name: 'ComfyUI', tier: 'native', decision: 'Native media owner', source: 'comfy',
      summary: 'Primary local generative-media backend. Image, video, and avatar workflows should extend this service rather than create another media stack.',
      guidance: 'For automated workflows, prefer custom nodes that work in ComfyUI API mode. Nodes that require direct client/server communication may not be callable from Local AI.',
      actions: [
        { type: 'view', view: 'create', label: 'Open Images' },
        { type: 'url', url: 'https://docs.comfy.org/custom-nodes/overview', label: 'Custom-node guidance' }
      ]
    },
    {
      id: 'svd', name: 'Stable Video Diffusion', tier: 'extend', decision: 'Verify before enabling',
      summary: 'Treat SVD as a ComfyUI model/workflow capability, not a standalone integration. Do not present it as installed until the runtime exposes the required model and nodes.',
      guidance: 'Capability state is intentionally “not verified” until backend discovery is added.',
      actions: [{ type: 'view', view: 'create', label: 'Open Images' }]
    },
    {
      id: 'sadtalker', name: 'SadTalker', tier: 'extend', decision: 'Defer / verify first',
      summary: 'Keep talking-head generation modular and behind ComfyUI. Add it only when avatar output is a real workflow requirement and the node path is API-compatible.',
      guidance: 'Avoid installing custom nodes solely because they appear in a tool list; verify maintenance, runtime fit, and API behavior first.',
      actions: [{ type: 'view', view: 'create', label: 'Open Images' }]
    },
    {
      id: 'gridcraft', name: 'GridCraft', tier: 'bridge', decision: 'Host bridge', source: 'gridcraft',
      summary: 'Local spreadsheet agent. Ask Local AI to inspect, edit, verify and save GridCraft workbooks on the Windows host.',
      guidance: 'Requests go through the appliance to the host bridge, which runs one request at a time. No cloud service is involved.',
      actions: [{ type: 'page', url: '/gridcraft.html', label: 'Open GridCraft' }]
    },
    {
      id: 'penpot', name: 'Penpot', tier: 'bridge', decision: 'Self-host + MCP',
      summary: 'Best design-system bridge from the reviewed tools. Penpot supports self-hosting and an MCP workflow for design inspection, asset export, design-to-code, and design updates.',
      guidance: 'Prefer a self-hosted Penpot instance. Treat an MCP key like a secret: never embed it in browser-visible configuration, source, screenshots, or logs.',
      actions: [
        { type: 'url', url: 'https://help.penpot.app/technical-guide/getting-started/', label: 'Self-host guide' },
        { type: 'url', url: 'https://help.penpot.app/mcp/', label: 'MCP guide' }
      ]
    },
    {
      id: 'obsidian', name: 'Obsidian', tier: 'bridge', decision: 'Local vault bridge',
      summary: 'Use Obsidian as a local Markdown source for Projects and Knowledge, not as a replacement for Local AI memory or project state.',
      guidance: 'The eventual bridge should mount or select a vault folder, ingest supported files, record source paths, and remain read-only by default.',
      actions: [{ type: 'view', view: 'projects', label: 'Open Projects' }]
    },
    {
      id: 'huggingface', name: 'Hugging Face', tier: 'bridge', decision: 'Model registry only',
      summary: 'Use Hugging Face for model discovery and acquisition. Keep Local AI as the chat/orchestration surface so history, routing, privacy, and capability state stay coherent.',
      guidance: 'Do not auto-install a model merely because it appears in search; compatibility, license, size, and local resource fit should be explicit gates.',
      actions: [{ type: 'url', url: 'https://huggingface.co/models', label: 'Browse models' }]
    },
    {
      id: 'photopea', name: 'Photopea', tier: 'utility', decision: 'Manual external editor',
      summary: 'Useful for occasional browser-based touch-up after local generation, but it should remain outside the appliance runtime and persistence model.',
      guidance: 'Opening Photopea crosses the local appliance boundary; do not silently upload Local AI artifacts.',
      actions: [{ type: 'url', url: 'https://www.photopea.com/', label: 'Open Photopea' }]
    },
    {
      id: 'languagetool', name: 'LanguageTool', tier: 'utility', decision: 'Optional deterministic QA',
      summary: 'Useful when you need a deterministic grammar/style pass. Ordinary writing remains with local models, so LanguageTool should be opt-in rather than a default dependency.',
      guidance: 'Prefer a local/self-hosted service if this becomes part of an automated workflow.',
      actions: [{ type: 'url', url: 'https://languagetool.org/', label: 'LanguageTool' }]
    }
  ];

  const ALTERNATIVES = [
    ['Gemini / Nano Banana / ImageFX / Google Flow', 'Cloud creative stack', 'Skip as core', 'Duplicates local model and ComfyUI capabilities and weakens the local-first boundary. Add a cloud adapter only for a concrete quality gap.'],
    ['DALL·E 3', 'Cloud image generation', 'Skip as core', 'Keep ComfyUI as the default media backend and expose cloud providers only as explicit opt-in fallbacks.'],
    ['Hugging Chat / Hugging Face Chat', 'Cloud chat frontend', 'Skip', 'Local AI already provides the chat/orchestration layer. Hugging Face is more valuable here as a model registry.'],
    ['Meta AI / You.com', 'Cloud assistants/search', 'Skip', 'They duplicate Ask/Research and would fragment history, routing, privacy, and capability state.'],
    ['LMArena / Chatbot Arena', 'Model comparison', 'Reference only', 'Useful for external model evaluation, but not an appliance runtime dependency.'],
    ['Coze / Bardeen', 'Cloud automation/agents', 'Skip', 'n8n plus Local AI agents already cover this space with better control and local deployment.'],
    ['Pixlr X / Lovart', 'Design/image tools', 'Skip', 'Photopea plus Penpot provides a simpler editor/design pair with less overlap.'],
    ['Laxis', 'Meeting notes', 'Skip for now', 'Meeting capture is outside the current Local AI core and would add a narrow cloud workflow.'],
    ['Google Slides', 'Presentations', 'Defer', 'Prefer a future artifact/export capability rather than coupling the appliance to one office suite.'],
    ['10Web', 'Website builder', 'Skip', 'Local AI engineering/workbench features are a better fit for code-backed site work.'],
    ['Icons8', 'Asset library', 'Reference only', 'Useful content source, not an integration. Keep it outside the runtime dependency graph.']
  ];

  function tierBadge(tier) {
    const labels = { native: 'Native', extend: 'Local extension', bridge: 'Bridge', utility: 'Utility' };
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
      return `<a class="btn ux-int-action" data-external="true" href="${action.url}" target="_blank" rel="noopener noreferrer" aria-label="${action.label} for ${item.name} (opens external site)">${action.label} ↗</a>`;
    }
    if (action.type === 'page') {
      return `<a class="btn ux-int-action" href="${action.url}">${action.label}</a>`;
    }
    return `<button class="btn ux-int-action" type="button" data-integration-view="${action.view}">${action.label}</button>`;
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
    const label = optional ? 'Optional offline' : state === 'HEALTHY' ? 'Healthy' : state === 'DOWN' ? 'Down' : state === 'DEGRADED' ? 'Degraded' : 'Status unavailable';
    element.innerHTML = `<span class="dot ${optional ? '' : state}"></span> ${label}`;
  }

  function setBusy(busy) {
    const button = q('#uxIntegrationRefreshV2');
    if (!button) return;
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
    button.textContent = busy ? 'Checking…' : 'Refresh status';
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
        const results = await Promise.allSettled([
          fetch('/api/status', { cache: 'no-store' }),
          fetch('/api/capabilities', { cache: 'no-store' }),
          fetch('/api/gridcraft/health', { cache: 'no-store' })
        ]);
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
          summary.textContent = healthy === 2 ? 'Core local integrations are healthy.' : healthy === 1 ? 'One core local integration needs attention.' : 'Core local integration health needs attention.';
        } else {
          q('#uxIntegrationNativeCountV2').textContent = '—';
          summary.textContent = 'Live service status is unavailable; integration recommendations are unchanged.';
        }

        q('#uxIntegrationMediaStateV2').textContent = capabilities
          ? capabilities?.images?.available === true ? 'Ready' : 'No supported model'
          : 'Status only';
        checked.textContent = `Checked ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      } catch {
        if (summary) summary.textContent = 'Could not read live integration status.';
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
      <div class="topbar"><div><h1>Integrations</h1><p class="sub">A local-first integration policy grounded in the reviewed tools and the current appliance architecture. Native services stay authoritative; bridges are explicit; cloud fallbacks remain opt-in.</p></div><button class="btn" type="button" id="uxIntegrationRefreshV2" aria-busy="false">Refresh status</button></div>
      <div class="ux-int-hero ux-int-v2"><div><span class="eyebrow">Recommended architecture</span><h2>Extend the capabilities Local AI already owns instead of collecting parallel AI apps.</h2><p id="uxIntegrationStatusSummaryV2" role="status" aria-live="polite">Checking local services…</p><span id="uxIntegrationLastCheckedV2" class="ux-int-checked"></span></div><div class="ux-int-metrics"><div><b id="uxIntegrationNativeCountV2">—</b><span>native services healthy</span></div><div><b id="uxIntegrationMediaStateV2">—</b><span>local media capability</span></div><div><b>Explicit</b><span>external trust crossings</span></div></div></div>
      <div class="section-head ux-int-section-head"><div><h2>Implement / keep</h2><p>Recommended components and the guardrails that keep them from fragmenting Local AI.</p></div></div><div id="uxIntegrationCardsV2" class="ux-int-grid"></div>
      <div class="card ux-int-policy"><div><div class="eyebrow">Integration rules</div><h2>What gets into the core</h2></div><div class="ux-int-policy-grid"><div><strong>1. Native before cloud</strong><span>Ollama, n8n and ComfyUI remain the default execution path.</span></div><div><strong>2. One owner per capability</strong><span>Do not add another primary chat, automation, or media surface that fragments state.</span></div><div><strong>3. Bridges must create durable value</strong><span>Penpot and Obsidian should exchange inspectable artifacts or source context, not merely open another tab.</span></div><div><strong>4. Cloud is an explicit fallback</strong><span>Credentials and uploads require deliberate user action after a measured local capability gap is documented.</span></div></div></div>
      <div class="card ux-int-research"><div><div class="eyebrow">Research-backed safeguards</div><h2>Operational requirements</h2></div><div class="ux-int-research-grid"><div><strong>n8n security audit</strong><span>Use the official audit after adding credentials, community nodes, or public webhooks; it checks credential, database, filesystem, node, and instance risks.</span><a data-external="true" href="https://docs.n8n.io/hosting/securing/security-audit/" target="_blank" rel="noopener noreferrer" aria-label="n8n security audit official guidance (opens external site)">Official guidance ↗</a></div><div><strong>ComfyUI API compatibility</strong><span>Custom nodes that require direct client/server communication may not be usable through API-mode automation. Verify this before making a node part of a Local AI workflow.</span><a data-external="true" href="https://docs.comfy.org/custom-nodes/overview" target="_blank" rel="noopener noreferrer" aria-label="ComfyUI custom-node model guidance (opens external site)">Custom-node model ↗</a></div><div><strong>Penpot self-host + MCP</strong><span>Penpot can run on your own server and exposes an MCP workflow for design-to-code/design-to-design work. MCP keys are secrets and stay out of client code.</span><a data-external="true" href="https://help.penpot.app/mcp/" target="_blank" rel="noopener noreferrer" aria-label="Penpot MCP guidance (opens external site)">Penpot MCP ↗</a></div></div></div>
      <div class="card ux-int-next"><div><div class="eyebrow">Implementation order</div><h2>Next technical steps</h2></div><div class="ux-int-next-grid"><div><b>Shipped</b><strong>Live n8n / ComfyUI health</strong><span>Uses the appliance status and capability endpoints already present.</span></div><div><b>Next</b><strong>ComfyUI capability discovery</strong><span>Detect video/avatar model and node readiness before SVD or SadTalker can show as available.</span></div><div><b>Next</b><strong>Obsidian vault ingestion</strong><span>Mount/select a local vault and ingest supported source files into Project Knowledge with source provenance.</span></div><div><b>Opt-in</b><strong>Penpot MCP bridge</strong><span>Connect a self-hosted Penpot design workspace without exposing MCP credentials to the browser.</span></div></div></div>
      <details class="ux-int-reviewed"><summary>Reviewed alternatives <span>${ALTERNATIVES.length} tools/groups intentionally kept out of the core</span></summary><div class="section-head ux-int-section-head"><div><h2>Reviewed, not integrated</h2><p>Useful independently in some cases, but not justified as Local AI runtime dependencies today.</p></div></div><div id="uxIntegrationAlternativesV2" class="ux-int-table"></div></details>`;

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

  const state = { runs: [], selectedId: null, timer: 0, loading: false, drawerSig: '' };
  const ACTIVE = new Set(['queued', 'running', 'streaming', 'awaiting_approval']);

  function el(id) { return document.getElementById(id); }
  function active(run) { return ACTIVE.has(run?.status); }
  function safeDate(value) {
    const date = new Date(value || 0);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function relativeTime(value) {
    const date = safeDate(value);
    if (!date) return '—';
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
  }
  function statusLabel(status) {
    return ({ queued: 'Queued', running: 'Running', streaming: 'Streaming', awaiting_approval: 'Awaiting approval', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' })[status] || status || 'Unknown';
  }
  function statusTone(status) {
    if (status === 'completed') return 'complete';
    if (status === 'failed' || status === 'cancelled') return 'error';
    if (status === 'awaiting_approval') return 'waiting';
    return active({ status }) ? 'running' : '';
  }
  function outputText(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  function drawerSignature(run) {
    return run ? [run.id, run.status, run.updatedAt, run.progress, outputText(run.output).length, run.error || '', Array.isArray(run.events) ? run.events.length : 0].join('|') : '';
  }


  function activateRunsView() {
    const view = el('runs');
    if (!view) return;
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
        <div class="topbar"><div><h1>Runs</h1><p class="sub">One execution history for AI, images, agents, automations, and engineering.</p></div><button id="runsRefresh" type="button" class="btn">Refresh</button></div>
        <div id="runMetrics" class="run-summary-grid"></div>
        <div class="card" style="margin-top:12px"><div class="section-head"><div><h2>Execution history</h2><p>Open a run for lifecycle events, output, errors, cancel, or retry when supported.</p></div></div><div id="runList" class="run-list"><div class="empty">Loading runs…</div></div></div>`;
      main.appendChild(section);
      el('runsRefresh')?.addEventListener('click', () => loadRuns(true));
    }

    if (!document.querySelector('.navbtn[data-view="runs"]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'navbtn';
      button.dataset.view = 'runs';
      button.innerHTML = '<span class="navicon">▶</span>Runs';
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
        panel.innerHTML = '<div class="section-head"><div><h2>Runs</h2><p id="homeRunSummary">Checking current execution state…</p></div><button id="homeRunsOpen" type="button" class="btn">View runs</button></div><div id="homeRunList" class="run-list"></div>';
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
      backdrop.innerHTML = '<aside id="runDrawer" class="run-drawer" role="dialog" aria-modal="true" aria-labelledby="runDrawerTitle"></aside><div id="runLiveRegion" class="run-live-region" aria-live="polite"></div>';
      document.body.appendChild(backdrop);
      backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeDrawer(); });
    }
  }

  function makeRunRow(run) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-row';
    button.dataset.runId = run.id;
    button.addEventListener('click', () => openDrawer(run.id));

    const main = document.createElement('div');
    main.className = 'run-row-main';
    const title = document.createElement('div');
    title.className = 'run-row-title';
    title.textContent = run.title || 'Untitled run';
    const meta = document.createElement('div');
    meta.className = 'run-row-meta';
    [run.type || 'task', relativeTime(run.updatedAt || run.createdAt), run.source?.kind ? `source: ${run.source.kind}` : ''].filter(Boolean).forEach((text) => {
      const span = document.createElement('span'); span.textContent = text; meta.appendChild(span);
    });
    const progress = document.createElement('div');
    progress.className = 'run-row-progress';
    const fill = document.createElement('span');
    fill.style.setProperty('--progress', `${Math.max(0, Math.min(100, Number(run.progress) || 0))}%`);
    progress.appendChild(fill);
    main.append(title, meta, progress);

    const status = document.createElement('span');
    status.className = `statuschip run-status ${statusTone(run.status)}`;
    status.textContent = statusLabel(run.status);
    button.append(main, status);
    return button;
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
      if (!runs.length) list.innerHTML = '<div class="empty">No execution history yet.</div>';
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

    if (state.selectedId && el('runDrawerBackdrop')?.classList.contains('show') && drawerSignature(runs.find((run) => run.id === state.selectedId)) !== state.drawerSig) renderDrawer(state.selectedId);
  }

  function renderDrawer(runId) {
    const run = state.runs.find((item) => item.id === runId);
    const drawer = el('runDrawer');
    if (!run || !drawer) return;
    state.drawerSig = drawerSignature(run);
    drawer.replaceChildren();

    const head = document.createElement('div');
    head.className = 'run-drawer-head';
    const copy = document.createElement('div');
    const title = document.createElement('div');
    title.id = 'runDrawerTitle';
    title.className = 'run-drawer-title';
    title.textContent = run.title || 'Untitled run';
    const sub = document.createElement('div');
    sub.className = 'run-drawer-sub';
    sub.textContent = `${run.type || 'task'} · ${statusLabel(run.status)} · updated ${relativeTime(run.updatedAt)}`;
    copy.append(title, sub);
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'btn run-drawer-close'; close.textContent = 'Close'; close.addEventListener('click', closeDrawer);
    head.append(copy, close);
    drawer.appendChild(head);

    const actions = document.createElement('div');
    actions.className = 'run-drawer-actions';
    if (run.cancellable && active(run)) {
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn danger'; cancel.textContent = 'Cancel run'; cancel.addEventListener('click', () => cancelRun(run.id, cancel)); actions.appendChild(cancel);
    }
    if (run.retryable) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn primary'; retry.textContent = 'Retry'; retry.addEventListener('click', () => retryRun(run.id, retry)); actions.appendChild(retry);
    }
    if (actions.childElementCount) drawer.appendChild(actions);

    const details = document.createElement('div');
    details.className = 'run-detail-grid';
    const values = [
      ['Status', statusLabel(run.status)], ['Progress', `${Math.max(0, Math.min(100, Number(run.progress) || 0))}%`],
      ['Started', safeDate(run.startedAt)?.toLocaleString() || '—'], ['Finished', safeDate(run.finishedAt)?.toLocaleString() || '—'],
      ['Attempt', String(run.attempt || 1)], ['Retry of', run.retryOf || '—'], ['Run ID', run.id]
    ];
    values.forEach(([label, value]) => {
      const box = document.createElement('div'); box.className = 'run-detail';
      const key = document.createElement('span'); key.textContent = label;
      const text = document.createElement('b'); text.textContent = value;
      box.append(key, text); details.appendChild(box);
    });
    drawer.appendChild(details);

    if (run.summary) appendSection(drawer, 'Summary', run.summary);
    if (run.error) appendSection(drawer, 'Error', run.error);
    const output = outputText(run.output);
    if (output) appendSection(drawer, 'Output', output, true);

    if (Array.isArray(run.events) && run.events.length) {
      const section = document.createElement('section'); section.className = 'run-section';
      const heading = document.createElement('h3'); heading.textContent = 'Timeline'; section.appendChild(heading);
      const timeline = document.createElement('div'); timeline.className = 'run-timeline';
      run.events.forEach((event) => {
        const row = document.createElement('div'); row.className = 'run-event';
        const marker = document.createElement('span'); marker.className = 'run-event-marker';
        const text = document.createElement('div');
        const detail = document.createElement('div'); detail.className = 'run-event-detail'; detail.textContent = event.detail || statusLabel(event.status);
        const time = document.createElement('div'); time.className = 'run-event-time'; time.textContent = safeDate(event.at)?.toLocaleString() || '—';
        text.append(detail, time); row.append(marker, text); timeline.appendChild(row);
      });
      section.appendChild(timeline); drawer.appendChild(section);
    }
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

  function openDrawer(runId) {
    state.selectedId = runId;
    const backdrop = el('runDrawerBackdrop');
    if (!backdrop) return;
    renderDrawer(runId);
    backdrop.classList.add('show');
    backdrop.setAttribute('aria-hidden', 'false');
    el('runDrawer')?.querySelector('button')?.focus();
  }

  function closeDrawer() {
    const backdrop = el('runDrawerBackdrop');
    if (!backdrop) return;
    backdrop.classList.remove('show');
    backdrop.setAttribute('aria-hidden', 'true');
    state.selectedId = null;
    state.drawerSig = '';
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
      closeDrawer();
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
      if (list) { list.replaceChildren(); const box = document.createElement('div'); box.className = 'status-error'; box.textContent = `Execution history unavailable: ${error.message}`; list.appendChild(box); }
    } finally {
      state.loading = false;
      schedule();
    }
  }

  // Open a run from elsewhere (the Audit log links here). Accepts a ledger id or the id of the work that produced it.
  async function openRunBySource(id) {
    const match = () => state.runs.find((run) => run.id === id || run.source?.id === id || run.meta?.sourceId === id);
    if (!match()) await loadRuns(true);
    activateRunsView();
    const run = match();
    if (run) openDrawer(run.id);
    return Boolean(run);
  }
  window.LocalAIRuns = { open: openRunBySource };

  function init() {
    ensureSurface();
    loadRuns(true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadRuns(true); }, { passive: true });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && el('runDrawerBackdrop')?.classList.contains('show')) closeDrawer(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

// ===== Long lists ============================================================
// Long lists show their first items and a "Show N more" button: a few on a phone, three times as many on a
// larger screen. Without it the Change ledger,
// Files and Library pages ran to tens of thousands of pixels. Lists re-render often (polling), so a MutationObserver
// re-applies the limit; "Show more" is remembered per list until the page reloads.
(() => {
  'use strict';
  const LIMITS = { changeList: 8, engineeringRuns: 6, inboxList: 10, approvalList: 10, activityList: 15, runList: 10, issueList: 10, libraryGrid: 12, knowledgeList: 10, qualityEvents: 10, monitorList: 10, automationList: 10 };
  const phone = window.matchMedia('(max-width: 760px)');
  const observers = new Map();

  function apply(list) {
    const observer = observers.get(list);
    observer?.disconnect();
    list.querySelector(':scope > .mobile-more')?.remove();
    const items = [...list.children];
    const limit = LIMITS[list.id] * (phone.matches ? 1 : 3);
    // Clipping only one or two items saves nothing; show them.
    const clip = list.dataset.showAll !== 'true' && items.length > limit + 2;
    items.forEach((item, i) => item.classList.toggle('mobile-clipped', clip && i >= limit));
    if (clip) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn mobile-more';
      more.textContent = `Show ${items.length - limit} more`;
      more.addEventListener('click', () => { list.dataset.showAll = 'true'; apply(list); });
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
// "Get started" on Home for a new install, and the Developer tools preference that hides the Build domain.
(()=>{'use strict';
const q=(s,r=document)=>r.querySelector(s),qa=(s,r=document)=>[...r.querySelectorAll(s)];
const DEV_KEY='localai.devTools',DONE_KEY='localai.firstRun.done';
const pref={get(k){try{return localStorage.getItem(k)}catch{return null}},set(k,v){try{localStorage.setItem(k,v)}catch{}}};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function getJson(url){const r=await fetch(url,{cache:'no-store'});return r.json()}
let config=null;
async function loadConfig(){if(!config)config=await getJson('/api/config').catch(()=>({}));return config}

// Developer tools: change requests, the Claude board, Workbench and PowerShell. An install that has used them
// starts with them shown; a new one starts with them hidden. The choice is remembered per browser.
function applyDevTools(on,fromToggle=false){
 document.body.classList.toggle('dev-tools-off',!on);
 qa('[data-dev-tools-toggle]').forEach(i=>{i.checked=on});
 const active=q('.view.active')?.id;
 if(fromToggle&&!on&&window.LocalAIViews?.view(active)?.domain==='build'&&typeof window.showView==='function')window.showView('home');
}
async function initDevTools(){
 const saved=pref.get(DEV_KEY);
 if(saved!==null)return applyDevTools(saved==='1');
 applyDevTools(!!(await loadConfig()).developerHistory);
}
function mountDevToolsToggle(){
 const status=q('#status');if(!status||q('.dev-tools-pref',status))return;
 const row=document.createElement('label');row.className='dev-tools-pref card';
 row.innerHTML='<input type="checkbox" data-dev-tools-toggle><span><strong>Show developer tools</strong><small>Adds Build to the menu: change requests, the Claude board, Workbench and PowerShell.</small></span>';
 status.querySelector('.topbar')?.after(row);
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
 else setStep(card,'model','todo',`<code>${esc(model)}</code> isn't installed yet. It's about 2.5 GB. <button type="button" class="btn primary" data-first-run-download="${esc(model)}">Download it now</button> <button type="button" class="btn" data-first-run-recheck>Check again</button><div class="first-run-progress" aria-live="polite"></div>`);
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
 const home=q('#home'),hero=q('#home .workspace-hero');if(!home||!hero||q('#firstRun'))return;
 const [models,library]=await Promise.all([getJson('/api/models').catch(()=>null),getJson('/api/library').catch(()=>null)]);
 if(models?.defaultInstalled&&(library?.items||[]).length)return;
 await loadConfig();
 const card=document.createElement('section');card.id='firstRun';card.className='first-run card';card.setAttribute('aria-labelledby','firstRunTitle');
 card.innerHTML=`<div class="first-run-head"><div><h2 id="firstRunTitle">Get started</h2><p>Two checks, then try a first task. Everything runs on this computer.</p></div><button type="button" class="iconbtn" data-first-run-dismiss aria-label="Hide Get started">×</button></div>
 <ol class="first-run-steps">${stepHtml('service','Local AI is running')}${stepHtml('model','A language model is installed')}<li data-step="try" data-state="todo"><span class="first-run-mark" aria-hidden="true"></span><div><strong>Try a first task</strong><div class="first-run-detail">Pick one. It runs right here, and the result is saved to your Library.</div><div class="first-run-samples">${SAMPLES.map((s,i)=>`<button type="button" class="btn" data-sample="${i}"><span>${esc(s.label)}</span><small>${esc(s.text)}</small></button>`).join('')}</div></div></li></ol>
 <div class="first-run-foot"><span class="meta">Developer tools are ${document.body.classList.contains('dev-tools-off')?'hidden':'shown'}. Change this in <a href="#" data-goto="status">Health</a>.</span><button type="button" class="btn primary" data-first-run-dismiss>I'm set up, hide this</button></div>`;
 hero.after(card);
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
  if(t.matches('[data-first-run-dismiss]')){pref.set(DONE_KEY,'1');card.remove()}
  else if(t.matches('[data-first-run-recheck]'))checkSteps(card);
  else if(t.dataset.firstRunDownload){t.disabled=true;t.textContent='Starting…';window.LocalAIModels?.startPull(t.dataset.firstRunDownload).then(ok=>{if(!ok){t.disabled=false;t.textContent='Download it now'}})}
  else if(t.dataset.sample!==undefined){runSample(SAMPLES[Number(t.dataset.sample)]);const li=q('[data-step="try"]',card);li.dataset.state='done'}
  else if(t.dataset.goto){e.preventDefault();window.showView?.(t.dataset.goto)}
 });
 checkSteps(card);
}
function init(){initDevTools().then(mountDevToolsToggle);mountFirstRun()}
window.LocalAIFirstRun={applyDevTools,DEV_KEY,DONE_KEY};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();

// ==== secure-connection.js ====
// Health page: whether this page is on HTTPS, whether this device trusts Local AI's certificate authority, and
// how to set that up. HTTPS is served by Caddy on ports 443/80 (deploy/Install-LocalAI-HTTPS.ps1).
(()=>{'use strict';
const q=(s,r=document)=>r.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const host=location.hostname,isLocal=/^(localhost|127\.0\.0\.1|::1)$/.test(host);
const httpsUrl=`https://${host}/`,caUrl=`http://${host}/localai-ca.crt`;
// A no-cors request succeeds only if TLS succeeds, i.e. this device trusts the certificate.
async function trusted(){try{await fetch(`${httpsUrl}healthz`,{mode:'no-cors',cache:'no-store',signal:AbortSignal.timeout(4000)});return true}catch{return false}}
const STEPS=[
 ['Mac','Open the downloaded file. Keychain Access opens: add it to System, double-click “Caddy Local Authority”, open Trust and choose Always Trust.'],
 ['iPhone or iPad','Open the download link in Safari and allow it. Then Settings › General › VPN &amp; Device Management › install the profile, and Settings › General › About › Certificate Trust Settings › turn it on.'],
 ['Android','Settings › Security › Encryption &amp; credentials › Install a certificate › CA certificate, then pick the downloaded file.'],
 ['Windows','Double-click the file › Install Certificate › Local Machine › Trusted Root Certification Authorities. (The Local AI computer itself is already set up.)']
];
async function render(card){
 const secure=location.protocol==='https:';
 let state,detail;
 if(secure){state='good';detail='This page is on a secure connection.'}
 else if(isLocal){state='good';detail='You are on the Local AI computer itself, which browsers already treat as secure.'}
 else{const ok=await trusted();state=ok?'ready':'todo';detail=ok?`This device already trusts Local AI's certificate. Switch to <a href="${esc(httpsUrl)}">${esc(httpsUrl)}</a>.`:'This page uses plain HTTP, so other devices on the network could read what you send, and some features (copy to clipboard, installing as an app, signing PowerShell jobs) are unavailable.'}
 card.dataset.state=state;
 card.innerHTML=`<div class="secure-head"><span class="secure-dot" aria-hidden="true"></span><div><h2>Secure connection</h2><p>${detail}</p></div></div>
 ${state==='todo'?`<ol class="secure-steps"><li><a class="btn primary" href="${esc(caUrl)}" download>Download the certificate</a> <span class="meta">Local AI's own certificate authority. Its private key never leaves the Local AI computer, which uses it only to sign Local AI's certificate.</span></li><li>Trust it on this device:<dl>${STEPS.map(([d,t])=>`<dt>${d}</dt><dd>${t}</dd>`).join('')}</dl></li><li>Open <a href="${esc(httpsUrl)}">${esc(httpsUrl)}</a>. To use the name <b>localai.home.arpa</b>, add it for ${esc(host)} in your router's DNS settings.</li></ol>`:''}`;
}
function mount(){const status=q('#status');if(!status||q('.secure-card',status))return;const card=document.createElement('section');card.className='card secure-card';(q('.dev-tools-pref',status)||q('.topbar',status))?.after(card);render(card)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(mount,0),{once:true});else setTimeout(mount,0);
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
function mount(){const status=q('#status');if(!status||q('.whatsnew-card',status))return;const card=document.createElement('section');card.className='card whatsnew-card';card.id='whatsNew';(q('.secure-card',status)||q('.dev-tools-pref',status)||q('.topbar',status))?.after(card);render(card)}
// After an update, say so once, and let the notice open What's new.
function announce(){
 const v=data?.current?.version,seen=pref.get();if(!v)return;pref.set(v);
 if(!seen||seen===v)return;
 const t=document.getElementById('toast');if(!t)return;
 t.innerHTML=`Updated to ${esc(v)}. <button type="button" class="whatsnew-open">See what's new</button>`;t.classList.add('show','whatsnew-toast');
 t.querySelector('.whatsnew-open').onclick=()=>{t.classList.remove('show');window.showView?.('status');setTimeout(()=>q('#whatsNew')?.scrollIntoView({block:'start'}),100)};
 clearTimeout(t._hide);t._hide=setTimeout(()=>t.classList.remove('show','whatsnew-toast'),10000);
}
async function start(){await load();mount();announce()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(start,50),{once:true});else setTimeout(start,50);
})();
