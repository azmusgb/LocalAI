// Projects › Print lab: the Mac's print-lab page, read-only (app/print-lab.js stores what `lab sync` sends).
// Needs you first (each with the command to run on the Mac), then the open question's budget and stop state, then the
// open experiments, then Earlier. Nothing here writes: verdicts and approvals stay on the Mac (slim 1B).
(function(root){'use strict';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=x=>x===null||x===undefined?'–':String(Math.round(Number(x)*10)/10);
const STATUS={planned:['Planned','neutral'],built:['Built','neutral'],build_failed:['Build failed','bad'],ready:['Ready to print','accent'],needs_approval:['Needs your approval','attention'],approved:['Approved','accent'],printing:['Printing','attention'],answered:['Answered','good'],abandoned:['Abandoned','neutral']};
const OUTCOME={supported:['Prediction supported','good'],refuted:['Prediction refuted','accent'],unresolved:['Unresolved','neutral'],inconclusive:['Inconclusive','neutral']};
const VALIDITY={valid:['Fair comparison','good'],confounded:['Confounded','bad'],unknown:["Can't tell if fair",'attention']};
const REASONS={witness_abnormal:'the witness wall printed abnormally',witness_inconclusive:"the witness wall couldn't be judged",anchor_shifted:'the control reprint came out different',anchor_inconclusive:"the control reprint couldn't be judged",layer_time_mismatch:'the plates spent different time per layer',reference_not_printed:'the reference was never printed',reference_unmeasurable:"the reference plate can't be measured",cross_plate_no_anchor:'compared across plates with no control reprint',cross_plate_by_design:'separate plates are the factor being tested',production_mismatch:'this plate differs from how the tile will be printed'};
const DONE=new Set(['answered','abandoned']);
const badge=([label,tone])=>`<span class="badge badge--${tone}">${esc(label)}</span>`;
const value=v=>Array.isArray(v)?[...new Set(v.map(String))].join('/'):typeof v==='number'?n(v):String(v??'').includes('/')?String(v).split('/').pop():String(v??'');
const when=iso=>{const d=new Date(iso);return isNaN(d)?'':d.toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})};
const ago=iso=>{const m=Math.round((Date.now()-new Date(iso))/60000);return !isFinite(m)?'':m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} days ago`};
function meter(label,spent,next,total,unit){
 total=Number(total)||1;const a=Math.min(100,100*(spent||0)/total),b=Math.min(100-a,100*(next||0)/total),over=(spent||0)+(next||0)>total+1e-9;
 return `<div class="lab-meter${over?' lab-meter--over':''}"><div class="lab-meter__head"><span>${esc(label)}</span><span>${n(spent)} / ${n(total)} ${unit}</span></div>`
  +`<div class="lab-meter__track" role="img" aria-label="${n(spent)} of ${n(total)} ${unit} used${next?`, the next test adds ${n(next)}`:''}"><span class="lab-meter__spent" style="width:${a.toFixed(1)}%"></span><span class="lab-meter__next" style="width:${b.toFixed(1)}%"></span></div></div>`;
}
function needsHtml(ix,byId){
 if(!ix.needs.length)return '<p class="empty-state">Nothing needs you right now.</p>';
 return `<ul class="list-group lab-needs">${ix.needs.map(x=>`<li class="list-row"><div class="list-row__main"><div class="list-row__title"><a href="#printLab?e=${esc(x.id)}" data-lab-open="${esc(x.id)}">${esc(x.action)} · ${esc(x.id)}</a></div>`
  +`<div class="list-row__sub">${esc(byId[x.id]?.question_text)}</div><div class="list-row__sub">${esc(x.why)}</div>`
  +`<div class="lab-cmd"><code>${esc(x.command)}</code><button type="button" class="btn-outline lab-copy" data-copy="${esc(x.command)}" aria-label="Copy the command for ${esc(x.id)}">Copy</button></div></div></li>`).join('')}</ul>`;
}
function questionHtml(q,byId){
 const s=q.spent,b=q.budget,nx=q.next,st=q.stop,ev=q.evidence;
 const cur=[...q.experiments].reverse().map(i=>byId[i]).find(x=>x&&!DONE.has(x.status));
 const stop=st.kind?`<p class="lab-stop lab-stop--${st.kind==='owner'?'bad':'attention'}">${esc(st.text[0].toUpperCase()+st.text.slice(1))}</p>`:'<p class="lab-stop">Continue: nothing has stopped this question.</p>';
 return `<section class="card lab-question"><p class="meta">${esc(q.id)} · ${q.answered} of ${q.experiments.length} answered · ${ev.informative} informative, ${ev.uninformative} not</p><h2>${esc(q.question)}</h2>`
  +meter('Time',s.minutes,nx&&nx.minutes,b.minutes,'min')+meter('Material',s.g,nx&&nx.g,b.g,'g')
  +(nx?`<p class="meta">${esc(nx.id)} would add ${n(nx.minutes)} min, ${n(nx.g)} g</p>`:'')+stop
  +(cur?`<div class="lab-now"><p class="meta"><a href="#printLab?e=${esc(cur.id)}" data-lab-open="${esc(cur.id)}">${esc(cur.id)}</a> ${badge(STATUS[cur.status]||[cur.status,'neutral'])}</p><p class="lab-now__q">${esc(cur.question_text)}</p>${cur.why_this_test?`<p class="meta"><b>Why this test?</b> ${esc(cur.why_this_test)}</p>`:''}</div>`:'')
  +'</section>';
}
function photoUrl(project,p){return `/api/lab/${encodeURIComponent(project)}/photo/${esc(p.sha256)}.jpg`}
function experimentHtml(x,project){
 const f=x.factor||{},b=[badge(STATUS[x.status]||[x.status,'neutral'])];
 if(x.outcome){b.push(badge(OUTCOME[x.outcome]||[x.outcome,'neutral']));if(x.validity)b.push(badge(VALIDITY[x.validity.status]||[x.validity.status,'neutral']))}
 const meta=[(x.test_kind||'').replace(/_/g,' '),f.name?`${f.name.replace(/_/g,' ')}: ${(f.values||[]).map(value).join(' vs ')}`:'',x.provenance!=='prospective'?x.provenance:''].filter(Boolean).join(' · ');
 const vars=x.variants.map(v=>{const u=v.unit?` ${v.unit}`:'',name=v.tab||v.id;return `<li>${esc(name)}: ${v.realized!=null&&v.as_asked===false?`${esc(value(v.requested))} asked, ${n(v.realized)} printed${esc(u)}`:`${esc(v.realized!=null?n(v.realized):value(v.requested))}${esc(u)}`}</li>`}).join('');
 const cost=[x.estimate&&`estimated ${n(x.estimate.minutes)} min, ${n(x.estimate.g)} g`,x.usage&&`used ${n(x.usage.minutes)} min, ${n(x.usage.g)} g`,x.layer_time_median_s&&`${n(x.layer_time_median_s)} s per layer`].filter(Boolean).join(', ');
 const why=x.outcome&&x.validity?x.validity.reasons.map(r=>REASONS[r.code]||r.code).join('; '):'';
 const v=x.verdict,said=v&&(v.note||(v.kind==='acceptance'?(v.good_enough?'good enough':'not good enough'):v.kind));
 const shots=x.photos.filter(p=>p.sha256).map((p,i)=>`<a href="${photoUrl(project,p)}" target="_blank" rel="noopener"${i?'':' class="lab-shots__first"'}><img src="${photoUrl(project,p)}" alt="${esc(x.id)} print ${esc(p.run)}" loading="lazy"></a>`).join('');
 const guards=((x.check||{}).guards||[]).filter(g=>!g.ok).map(g=>`<li class="lab-guard--${g.result==='blocked'?'bad':'attention'}">${esc(g.message)}</li>`).join('');
 const dl=[['Hypothesis',x.hypothesis],['Prediction',x.prediction],['Why this test',x.why_this_test],['Judge on',x.judge_on],['Abandoned because',x.abandoned_reason],['Filament',x.filament]].filter(r=>r[1]).map(([k,t])=>`<dt>${esc(k)}</dt><dd>${esc(t)}</dd>`).join('');
 return `<article class="card lab-exp" id="lab-${esc(x.id)}"><header class="lab-exp__head"><span class="lab-exp__id">${esc(x.id)}</span>${b.join('')}</header><h3>${esc(x.question_text)}</h3><p class="meta">${esc(meta)}</p>`
  +(vars?`<ul class="lab-variants">${vars}</ul>`:'')+(cost?`<p class="meta">${esc(cost)}</p>`:'')+(why?`<p class="meta">Why: ${esc(why)}</p>`:'')
  +(said?`<p class="lab-verdict">Your verdict: ${esc(said)} <span class="meta">${esc(when(v.at))}</span></p>`:'')
  +(shots?`<div class="lab-shots">${shots}</div>`:'')
  +`<details class="lab-details" data-lab-details="${esc(x.id)}"><summary>Details</summary><dl>${dl}</dl>${guards?`<h4>Last check (${esc(String(x.check.status||'').replace(/_/g,' '))})</h4><ul class="lab-guards">${guards}</ul>`:''}</details></article>`;
}
function render(data){
 const ix=data.index,meta=data.meta||{},byId=Object.fromEntries(ix.experiments.map(x=>[x.id,x]));
 const open=ix.questions.filter(q=>!['answered','stopped'].includes(q.status)),active=ix.experiments.filter(x=>!DONE.has(x.status)),earlier=ix.experiments.filter(x=>DONE.has(x.status));
 const stale=meta.synced_at&&Date.now()-new Date(meta.synced_at)>2*3600e3;
 return `<p class="meta lab-synced${stale?' lab-synced--stale':''}">Synced from the Mac ${esc(ago(meta.synced_at))}${stale?'. The Mac may be asleep.':''}</p>`
  +(ix.problems.length?`<div class="banner lab-problems" role="alert"><strong>Records the Mac can't read</strong><ul>${ix.problems.map(p=>`<li><b>${esc(p.file)}</b> ${esc(p.error)}</li>`).join('')}</ul></div>`:'')
  +`<div class="lab-layout"><div class="lab-side"><section class="card lab-needs-card"><h2>Needs you</h2>${needsHtml(ix,byId)}</section>`
  +(open.map(q=>questionHtml(q,byId)).join('')||'<section class="card"><div class="empty-state"><div class="empty-state__title">No open question.</div><div>Start one on the Mac with lab question new.</div></div></section>')
  +`</div><div class="lab-notebook"><h2>Notebook</h2>${active.map(x=>experimentHtml(x,ix.project)).join('')||'<p class="empty-state">No open experiments.</p>'}`
  +(earlier.length?`<details class="lab-earlier"><summary>Earlier (${earlier.length})</summary>${earlier.map(x=>experimentHtml(x,ix.project)).join('')}</details>`:'')+'</div></div>';
}
function openExperiment(id){
 const card=document.getElementById(`lab-${id}`);if(!card)return;
 const earlier=card.closest('.lab-earlier');if(earlier)earlier.open=true;
 const d=card.querySelector('.lab-details');if(d)d.open=true;
 card.scrollIntoView({block:'start'});card.setAttribute('tabindex','-1');card.focus({preventScroll:true});
}
async function refresh(){
 const box=document.getElementById('printLabBody'),UI=root.LocalAIUI;if(!box||!UI)return;
 await UI.loadInto(box,async()=>{
  const {projects}=await UI.fetchJson('/api/lab/projects');
  if(!projects.length)return null;
  return UI.fetchJson(`/api/lab/${encodeURIComponent(projects[0].name)}`);
 },{what:'the print lab',empty:'No lab data yet. Run lab sync on the Mac.',render:(c,data)=>{if(!data)return false;c.innerHTML=render(data);const e=new URLSearchParams(location.hash.split('?')[1]||'').get('e');if(e)openExperiment(e)}}).catch(()=>{});
}
function init(){
 const sec=document.getElementById('printLab');if(!sec)return;
 sec.addEventListener('click',e=>{
  const c=e.target.closest('[data-copy]');
  if(c){const t=c.dataset.copy,done=()=>root.LocalAIUI?.toast?.('Copied. Paste it in Terminal on the Mac.');
   if(navigator.clipboard&&root.isSecureContext)navigator.clipboard.writeText(t).then(done,()=>{});else{const code=c.previousElementSibling;const r=document.createRange();r.selectNodeContents(code);const s=getSelection();s.removeAllRanges();s.addRange(r)}return}
  const o=e.target.closest('[data-lab-open]');if(o){e.preventDefault();history.replaceState(history.state,'',`#printLab?e=${o.dataset.labOpen}`);openExperiment(o.dataset.labOpen)}
 });
 const active=()=>sec.classList.contains('active');let was=active();
 new MutationObserver(()=>{const now=active();if(now&&!was)refresh();was=now}).observe(sec,{attributes:true,attributeFilter:['class']});
 if(was)refresh();
}
root.LocalAIPrintLab={render,refresh};
if(typeof module==='object'&&module.exports)module.exports={render};
else if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(typeof window!=='undefined'?window:globalThis);
