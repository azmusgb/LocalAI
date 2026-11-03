// Print lab (unlisted; lab items in Needs you open it): the Mac's print-lab page (app/print-lab.js stores what `lab sync` sends).
// Needs you first, each with its button (Judge it, It's printing now, Approve, Drop) and the Mac command folded under
// "Run it on the Mac instead", then the open question's budget and stop state, then the open experiments, then Earlier.
// Paired devices send requests to the Mac's pickup queue (lab pull applies them; Local AI never changes a record). The
// printing experiment shows the printer live and a camera snapshot every 10 s while the page is visible. Thumbnails,
// the photo viewer, Compare and the checklist live in print-lab-photos.js, mounted on [data-lab-photos] and
// [data-lab-checklist]. Text from the phone or the Mac is shown with textContent or escaped, never as markup.
(function(root){'use strict';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=x=>x===null||x===undefined?'–':String(Math.round(Number(x)*10)/10);
const STATUS={planned:['Planned','neutral'],built:['Built','neutral'],build_failed:['Build failed','bad'],ready:['Ready to print','accent'],needs_approval:['Needs your approval','attention'],approved:['Approved','accent'],printing:['Printing','attention'],answered:['Answered','good'],abandoned:['Abandoned','neutral']};
// How a usage figure was arrived at (page.json usage.minutes_source / g_source); 'observed' is shown bare.
const USAGE_SOURCE={estimate:'estimated',scaled_estimate:'estimated, partial print',mixed:'partly estimated',none:'no build to estimate from'};
const OUTCOME={supported:['Prediction supported','good'],refuted:['Prediction refuted','accent'],unresolved:['Unresolved','neutral'],inconclusive:['Inconclusive','neutral']};
const VALIDITY={valid:['Fair comparison','good'],confounded:['Confounded','bad'],unknown:["Can't tell if fair",'attention']};
const REASONS={witness_abnormal:'the witness wall printed abnormally',witness_inconclusive:"the witness wall couldn't be judged",anchor_shifted:'the control reprint came out different',anchor_inconclusive:"the control reprint couldn't be judged",layer_time_mismatch:'the plates spent different time per layer',reference_not_printed:'the reference was never printed',reference_unmeasurable:"the reference plate can't be measured",cross_plate_no_anchor:'compared across plates with no control reprint',cross_plate_by_design:'separate plates are the factor being tested',production_mismatch:'this plate differs from how the tile will be printed'};
const DONE=new Set(['answered','abandoned']);
const badge=([label,tone])=>`<span class="badge badge--${tone}">${esc(label)}</span>`;
const value=v=>Array.isArray(v)?[...new Set(v.map(String))].join('/'):typeof v==='number'?n(v):String(v??'').includes('/')?String(v).split('/').pop():String(v??'');
const when=iso=>{const d=new Date(iso);return isNaN(d)?'':d.toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})};
const ago=iso=>{const m=Math.round((Date.now()-new Date(iso))/60000);return !isFinite(m)?'':m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} days ago`};

// Bambuddy's print for a run, and the prints made outside the lab (page.json runs[].print, entered_on_mac, outside).
const BAMBU='https://bambuddy.home.arpa/';
const bambuLink=id=>id==null?'':`<a href="${BAMBU}" target="_blank" rel="noopener">from Bambuddy print #${esc(id)} ↗</a>`;
function runLines(runs){
 return (runs||[]).map(r=>{
  const p=r.print;if(!p&&!r.entered_on_mac)return '';
  const word=p?esc(p.status_word)+(p.failed_at_estimate!=null?` at ~${Math.round(p.failed_at_estimate*100)} % (estimate)`:'')+(p.failure_reason?` (${esc(p.failure_reason)})`:''):'';
  const parts=[runs.length>1?esc(r.id):'',word,p&&p.minutes!=null?dur(Math.round(p.minutes)):'',p&&p.grams!=null?`${Math.round(p.grams)} g`:'',p?bambuLink(p.id):'',r.entered_on_mac?'entered on the Mac':''].filter(Boolean);
  return `<p class="meta lab-print">${parts.join(' · ')}</p>`;
 }).join('');
}
function outsideHtml(list){
 if(!Array.isArray(list)||!list.length)return '';
 return `<section class="card lab-outside"><h2>Outside the lab</h2>${list.map(o=>`<p class="meta">${[esc(o.name||`Print #${o.print}`),esc(o.status_word),esc(when(o.started)),bambuLink(o.print)].filter(Boolean).join(' · ')}</p>`).join('')}</section>`;
}

const dur=m=>m>=60?`${Math.floor(m/60)} h ${m%60} min`:`${m} min`;
const currentProject='';
const currentRequests=[];
const liveData=null;
const FINISHED=new Set(['idle','cancelled','ended']);
const STATE_WORDS={printing:'Printing',paused:'Paused',cancelled:'Stopped',ended:'Print ended. Check the printer.',idle:'Finished',unknown:"The printer's state isn't known right now"};

function renderRequestsList(items){
  if(!items||!items.length)return '';
  return items.slice(0,5).map(r=>{
    const tone=r.status==='applied'?'good':r.status==='refused'?'bad':'attention';
    const title=r.kind?(r.kind[0].toUpperCase()+r.kind.slice(1)):'Request';
    return `<div class="lab-request"><span class="badge badge--${tone}">${esc(title)} · ${esc(r.status)}</span>${r.message?` <span class="meta">${esc(r.message)}</span>`:''}</div>`;
  }).join('');
}

function meter(label,spent,next,total,unit){
 total=Number(total)||1;const a=Math.min(100,100*(spent||0)/total),b=Math.min(100-a,100*(next||0)/total),over=(spent||0)+(next||0)>total+1e-9;
 return `<div class="lab-meter${over?' lab-meter--over':''}"><div class="lab-meter__head"><span>${esc(label)}</span><span>${n(spent)} / ${n(total)} ${unit}</span></div>`
  +`<div class="lab-meter__track" role="img" aria-label="${n(spent)} of ${n(total)} ${unit} used${next?`, the next test adds ${n(next)}`:''}"><span class="lab-meter__spent" style="width:${a.toFixed(1)}%"></span><span class="lab-meter__next" style="width:${b.toFixed(1)}%"></span></div></div>`;
}
// The button(s) for a Needs you item, or '' when it needs the Mac (Fix the plan, Run the check or build).
function actButtons(x,exp){
 const id=esc(x.id);
 if(x.action==='Judge the print')return (exp&&exp.criteria&&exp.criteria.length?`<button type="button" class="btn-primary lab-record-verdict" data-exp="${id}">Judge it</button>`:'')+`<button type="button" class="btn-outline lab-add-photos" data-exp="${id}">Add photos</button>`;
 if(x.action==='Send it to the printer')return `<button type="button" class="btn-primary lab-start" data-exp="${id}">It's printing now</button>`;
 if(x.action==='Approve or drop')return `<button type="button" class="btn-primary lab-approve" data-exp="${id}">Approve</button><button type="button" class="btn-danger lab-drop" data-exp="${id}">Drop</button>`;
 return '';
}
const clock=iso=>new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});
// A print still on the printer isn't ready to judge: until its estimated end it says when, and offers no command or
// button. The printer's own word beats the estimate: once it reports the print finished, Judge it shows straight away.
function needView(x,byId){
 const look=`Look at: ${byId[x.id]?.judge_on||'the face'}. Photos help.`;
 const finished=liveData&&!liveData.conflict&&liveData.experiment===x.id&&FINISHED.has(liveData.state);
 if(x.due_at&&!finished&&Date.now()<new Date(x.due_at))return {action:'Printing',why:`Done about ${clock(x.due_at)} (estimate). Then l${look.slice(1)}`,command:null};
 return {action:x.action,why:x.due_at?look:x.why,command:x.command};
}
function needsHtml(ix,byId){
 if(!ix.needs.length)return '<p class="empty-state">Nothing needs you right now.</p>';
 return `<ul class="list-group lab-needs">${ix.needs.map(n=>{
  const x={...n,...needView(n,byId)};
  const cmd=x.command?`<div class="lab-cmd"><code>${esc(x.command)}</code><button type="button" class="btn-outline lab-copy" data-copy="${esc(x.command)}" aria-label="Copy the command for ${esc(x.id)}">Copy</button></div>`:'',acts=actButtons(x,byId[x.id]);
  return `<li class="list-row"><div class="list-row__main"><div class="list-row__title"><a href="#printLab?e=${esc(x.id)}" data-lab-open="${esc(x.id)}">${esc(x.action)} · ${esc(x.id)}</a></div>`
  +`<div class="list-row__sub">${esc(byId[x.id]?.question_text)}</div><div class="list-row__sub">${esc(x.why)}</div>`
  +(acts?`<div class="lab-acts">${acts}</div>${x.action==='Send it to the printer'?`<p class="meta">Only once it's actually printing.</p>`:''}<p class="lab-act-status" data-act-status="${esc(x.id)}" role="status"></p>${cmd?`<details class="lab-mac" id="lab-mac-${esc(x.id)}"><summary>Run it on the Mac instead</summary>${cmd}</details>`:''}`:cmd)
  +'</div></li>'}).join('')}</ul>`;
}


const HMS_WORDS={
 '0C008043':'Build plate marker not detected: check plate alignment on heatbed',
 '0C008009':'Build plate marker not detected: check plate position',
 '0C008001':'First layer defects detected by Micro Lidar',
 '0C00C003':'Possible first layer defects detected',
 '0C00C004':'Possible spaghetti failure detected: check bed adhesion',
 '0C008005':'Purged filament pile-up in waste chute: clear chute',
 '0C00C006':'Waste chute may be clogged with purge filament',
 '0C00402C':'Device data link error: reboot printer',
 '0C00402D':'Toolhead camera error: reboot printer',
 '03004000':'Z axis homing failed: check bed lead screws',
 '03004001':'Nozzle cooling timeout before homing',
 '03004002':'Auto bed leveling failed: clean nozzle tip',
 '03004005':'Hotend cooling fan speed abnormal',
 '03004006':'Nozzle is clogged: check extruder and filament path',
 '03004008':'AMS failed to change filament',
 '0300400C':'Task was canceled',
 '03008000':'Printing paused for unknown reason',
 '03008001':'Printing paused by user',
 '03008002':'First layer defects detected by Micro Lidar',
 '03008003':'Spaghetti defect detected by AI monitoring',
 '03008004':'Filament ran out: load new spool',
 '03008005':'Toolhead front cover fell off: remount cover',
 '03008006':'Build plate marker not detected: verify plate alignment',
 '03008007':'Unfinished print recovered after power loss',
 '03008008':'Nozzle temperature malfunction: check heater cartridge',
 '03008009':'Heatbed temperature malfunction: check bed thermistor',
 '0300800A':'Filament pile-up in waste chute: clear chute',
 '0300800B':'Cutter stuck: check cutter handle and sensor lever',
 '0300800C':'Lost motion steps / axis obstruction detected',
 '0300800D':'Extruder abnormal extrusion: check nozzle temperature',
 '0300800F':'Chamber door is open',
 '03008010':'Hotend cooling fan abnormal',
 '03008011':'Build plate type does not match sliced file',
 '03008013':'Printing paused by pause command in G-code',
 '03008014':'Nozzle covered in filament or build plate misplaced',
 '03008016':'Nozzle clogged with filament',
 '03008017':'Foreign object detected on heatbed: clear plate',
 '03008019':'Build plate not detected on heatbed',
 '05004001':'Cloud connection failed',
 '05004003':'G-code file parse error',
 '0500400E':'Printing was cancelled',
 '07004001':'AMS assist motor overload',
 '07008001':'AMS slot 1 filament ran out',
 '07008002':'AMS filament retracted abnormally',
 '07008003':'AMS feed assist motor stuck',
 '07008010':'AMS failed to pull back filament from toolhead',
 '07008011':'AMS filament buffer signal abnormal'
};
function hmsText(code){
 if(!code)return null;
 const c=String(code).replace(/[^0-9A-Fa-f]/g,'').toUpperCase();
 if(HMS_WORDS[c])return HMS_WORDS[c];
 if(c.startsWith('0C'))return 'Vision / camera / lidar scanning anomaly';
 if(c.startsWith('03'))return 'Toolhead / motion / extrusion anomaly';
 if(c.startsWith('07'))return 'AMS filament feed anomaly';
 if(c.startsWith('05'))return 'System / print job communication anomaly';
 return 'Check printer screen for instructions';
}
function liveNow(l){
 const word=l.state==='error'?`Stopped with an error${l.errorCode?' '+l.errorCode:''}`:(STATE_WORDS[l.state]||STATE_WORDS.unknown);
 const pct=Number.isInteger(l.progress)?Math.max(0,Math.min(100,l.progress)):null,parts=[`<b>${esc(word)}</b>`];
 if(pct!==null)parts.push(`${pct}%`);
 if(Number.isInteger(l.minutesLeft))parts.push(`${esc(dur(l.minutesLeft))} left`);
 const end=l.finishAt&&new Date(l.finishAt);if(end&&!isNaN(end))parts.push(`done about ${esc(end.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}))}`);
 const hms=l.state==='error'?(l.errorCode?hmsText(l.errorCode):'Check printer screen for instructions'):null;
 return `<div class="lab-live__now"><p class="lab-live__state">${parts.join(' · ')}</p>`
  +(hms?`<p class="lab-live__hms meta">${l.errorCode?`<b>HMS ${esc(l.errorCode)}:</b> `:''}${esc(hms)}</p>`:'')
  +(pct!==null?`<div class="lab-live__bar" role="progressbar" aria-label="Print progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>`:'')+'</div>';
}
const liveHtml=l=>`<div class="lab-live">${liveNow(l)}<figure class="lab-cam"><img class="lab-cam__img" alt="The printer's camera, a new picture every 10 seconds" hidden><figcaption class="lab-cam__why">Getting a picture…</figcaption></figure></div>`;

function questionHtml(q,byId){
 const s=q.spent,b=q.budget,nx=q.next,st=q.stop,ev=q.evidence;
 const cur=[...q.experiments].reverse().map(i=>byId[i]).find(x=>x&&!DONE.has(x.status));
 const stop=st.kind?`<p class="lab-stop lab-stop--${st.kind==='owner'?'bad':'attention'}">${esc(st.text[0].toUpperCase()+st.text.slice(1))}</p>`:'<p class="lab-stop">Continue: nothing has stopped this question.</p>';
 return `<section class="card lab-question"><p class="meta">${esc(q.id)} · ${q.answered} of ${q.experiments.length} answered · ${ev.informative} informative, ${ev.uninformative} not</p><h2>${esc(q.question)}</h2>`
  +meter('Time',s.minutes,nx&&nx.minutes,b.minutes,'min')+meter('Material',s.g,nx&&nx.g,b.g,'g')
  +(nx?`<p class="meta">${esc(nx.id)} would add ${n(nx.minutes)} min, ${n(nx.g)} g</p>`:'')+stop
  +(root.LocalAIPrintLabEvidence?.plansHtml(q)||'')
  +(cur?`<div class="lab-now"><p class="meta"><a href="#printLab?e=${esc(cur.id)}" data-lab-open="${esc(cur.id)}">${esc(cur.id)}</a> ${badge(STATUS[cur.status]||[cur.status,'neutral'])}</p><p class="lab-now__q">${esc(cur.question_text)}</p>${cur.why_this_test?`<p class="meta"><b>Why this test?</b> ${esc(cur.why_this_test)}</p>`:''}</div>`:'')
  +'</section>';
}
function experimentHtml(x,project,requests=currentRequests,byId={},colours={}){
 const Ev=root.LocalAIPrintLabEvidence,f=x.factor||{},b=[badge(STATUS[x.status]||[x.status,'neutral'])];
 if(x.outcome){b.push(badge(OUTCOME[x.outcome]||[x.outcome,'neutral']));if(x.validity)b.push(badge(VALIDITY[x.validity.status]||[x.validity.status,'neutral']))}
 if(x.verdict&&x.verdict.kind==='acceptance')b.push(badge(x.verdict.good_enough?['Accepted','good']:['Not good enough','bad']));
 const meta=[(x.test_kind||'').replace(/_/g,' '),f.name?`${f.name.replace(/_/g,' ')}: ${(f.values||[]).map(value).join(' vs ')}`:'',x.provenance!=='prospective'?x.provenance:''].filter(Boolean).join(' · ');
 const vars=x.variants.map(v=>{const u=v.unit?` ${v.unit}`:'',name=v.tab||v.id;return `<li>${esc(name)}: ${v.realized!=null&&v.as_asked===false?`${esc(value(v.requested))} asked, ${n(v.realized)} printed${esc(u)}`:`${esc(v.realized!=null?n(v.realized):value(v.requested))}${esc(u)}`}${Ev?Ev.gradeText(v):''}</li>`}).join('');
 const qty=(v,unit,src)=>`${n(v)} ${unit}${src&&src!=='observed'?` (${USAGE_SOURCE[src]||'estimated'})`:''}`;
 const cost=[x.estimate&&`estimated ${n(x.estimate.minutes)} min, ${n(x.estimate.g)} g`,x.usage&&`used ${qty(x.usage.minutes,'min',x.usage.minutes_source)}, ${qty(x.usage.g,'g',x.usage.g_source)}`,x.reserved&&`reserved ${n(x.reserved.minutes)} min, ${n(x.reserved.g)} g while it prints`,x.layer_time_median_s&&`${n(x.layer_time_median_s)} s per layer`].filter(Boolean).join(', ');
 const why=x.outcome&&x.validity?x.validity.reasons.map(r=>REASONS[r.code]||r.code).join('; '):'';
 const v=x.verdict,said=v&&(v.note||(v.kind==='acceptance'?(v.good_enough?'good enough':'not good enough'):v.kind));
 const shots=x.photos.some(p=>p.sha256);
 const guards=((x.check||{}).guards||[]).filter(g=>!g.ok).map(g=>`<li class="lab-guard--${g.result==='blocked'?'bad':'attention'}">${esc(g.message)}</li>`).join('');
 const dl=[['Hypothesis',x.hypothesis],['Prediction',x.prediction],['Why this test',x.why_this_test],['Judge on',x.judge_on],['Abandoned because',x.abandoned_reason],['Filament',x.filament]].filter(r=>r[1]).map(([k,t])=>`<dt>${esc(k)}</dt><dd>${esc(t)}</dd>`).join('');

 const live=liveData&&!liveData.conflict&&liveData.experiment===x.id?liveData:null;
 let actions='';
 if(x.status==='printing'&&!x.verdict){
   const hint=`<div class="lab-checklist" data-lab-checklist="${esc(x.id)}"></div>`;
   const addBtn=`<button type="button" class="btn-outline lab-add-photos" data-exp="${esc(x.id)}">Add photos</button><input type="file" accept="image/*" multiple class="visually-hidden" aria-label="Add photos for ${esc(x.id)}" data-exp="${esc(x.id)}">`;
   const done=live&&FINISHED.has(live.state);
   const verdictBtn=(x.criteria&&x.criteria.length)?`<button type="button" class="${done?'btn-primary':'btn-outline'} lab-record-verdict" data-exp="${esc(x.id)}">Judge it</button>`:'';
   const observeBtn=x.run?`<button type="button" class="btn-outline lab-observe" data-exp="${esc(x.id)}" data-project="${esc(currentProject)}">Record what happened</button>`:'';
   const expReqs=(requests||[]).filter(r=>r.experiment===x.id);
   const reqsHtml=`<div class="lab-requests" id="lab-requests-${esc(x.id)}" aria-live="polite">${renderRequestsList(expReqs)}</div>`;
   actions=`${hint}<div class="lab-actions">${verdictBtn}${observeBtn}${addBtn}</div>${reqsHtml}`;
 }else if(x.run&&x.status==='answered'){
   // A judged print can still get what you saw on each tile and the pair (it doesn't change the verdict).
   actions=`<div class="lab-actions"><button type="button" class="btn-outline lab-observe" data-exp="${esc(x.id)}" data-project="${esc(currentProject)}">Record what happened</button></div>`;
 }

 const spine=Ev?Ev.spoolColour(x.filament,colours):'';
 return `<article class="card lab-exp" id="lab-${esc(x.id)}"${spine?` style="--spine:${spine}"`:''}><header class="lab-exp__head">${spine?`<span class="lab-swatch" aria-hidden="true"></span>`:''}<span class="lab-exp__id">${esc(x.id)}</span>${b.join('')}</header><h3>${esc(x.question_text)}</h3><p class="meta">${esc(meta)}</p>`
  +(vars?`<ul class="lab-variants">${vars}</ul>`:'')+(cost?`<p class="meta">${esc(cost)}</p>`:'')+runLines(x.runs)+(why?`<p class="meta">Why: ${esc(why)}</p>`:'')
  +(said?`<p class="lab-verdict">Your verdict: ${esc(said)} <span class="meta">${esc(when(v.at))}</span></p>`:'')
  +(v&&v.defects&&v.defects.length?`<p class="meta lab-defects">Defects: ${esc(v.defects.join('; '))}</p>`:'')
  +(Ev?Ev.findingHtml(x)+Ev.aiHtml(x):'')
  +(live?liveHtml(live):'')+actions
  +(Ev?Ev.wipeHtml(x,byId,p=>`/api/lab/${encodeURIComponent(project)}/photo/${p.sha256}.jpg`):'')
  +(shots?`<div class="lab-photos" data-lab-photos="${esc(x.id)}"></div>`:'')
  +`<details class="lab-details" id="lab-d-${esc(x.id)}" data-lab-details="${esc(x.id)}"><summary>Details</summary><dl>${dl}</dl>${guards?`<h4>Last check (${esc(String(x.check.status||'').replace(/_/g,' '))})</h4><ul class="lab-guards">${guards}</ul>`:''}${Ev?Ev.reconHtml(x):''}</details></article>`;
}
let unreachable=false;
function syncState(meta){
 if(unreachable)return {stale:true,text:"Can't reach Local AI"};
 const stale=!!(meta.synced_at&&Date.now()-new Date(meta.synced_at)>2*3600e3);
 return {stale,text:`Synced from the Mac ${ago(meta.synced_at)}${stale?'. The Mac may be asleep.':''}`};
}
// The line keeps time on a page left open (the watcher updates it on every check); aria-live off so its ticking isn't
// read out from inside the body's live region.
function syncLine(meta){const {stale,text}=syncState(meta);return `<p class="meta lab-synced${stale?' lab-synced--stale':''}" aria-live="off">${esc(text)}</p>`}
function render(data,requests=currentRequests){
 const ix=data.index,meta=data.meta||{},byId=Object.fromEntries(ix.experiments.map(x=>[x.id,x]));
 const open=ix.questions.filter(q=>!['answered','stopped'].includes(q.status)),recent=x=>x.status==='answered'&&x.verdict&&Date.now()-new Date(x.verdict.at)<3*864e5;
 // Answered in the last three days stays in view: the newest result is what the owner comes to check.
 const active=ix.experiments.filter(x=>!DONE.has(x.status)||recent(x)),earlier=ix.experiments.filter(x=>DONE.has(x.status)&&!recent(x));
 const needsCount=(ix.needs||[]).length;
 const jumps=[
  needsCount?`<a href="#lab-sec-needs" class="lab-jump__chip">Needs you <span class="badge badge--attention">${needsCount}</span></a>`:'',
  open.length?`<a href="#lab-sec-questions" class="lab-jump__chip">Questions (${open.length})</a>`:'',
  active.length?`<a href="#lab-sec-notebook" class="lab-jump__chip">Notebook (${active.length})</a>`:'',
  earlier.length?`<a href="#lab-earlier" class="lab-jump__chip">Earlier (${earlier.length})</a>`:''
 ].filter(Boolean).join('');
 const jumpNav=jumps?`<nav class="lab-jump" aria-label="Jump to section">${jumps}</nav>`:'';
 return syncLine(meta)
  +(ix.problems.length?`<div class="banner lab-problems" role="alert"><strong>Records the Mac can't read</strong><ul>${ix.problems.map(p=>`<li><b>${esc(p.file)}</b> ${esc(p.error)}</li>`).join('')}</ul></div>`:'')
  +jumpNav
  +`<div class="lab-layout"><div class="lab-side"><section class="card lab-needs-card" id="lab-sec-needs"><h2>Needs you</h2>${needsHtml(ix,byId)}</section>`
  +`<div class="lab-questions" id="lab-sec-questions">${open.map(q=>questionHtml(q,byId)).join('')||'<section class="card"><div class="empty-state"><div class="empty-state__title">No open question.</div><div>Start one on the Mac with lab question new.</div></div></section>'}</div>`
  +`</div><div class="lab-notebook" id="lab-sec-notebook"><h2>Notebook</h2>${liveData&&liveData.conflict?`<p class="banner banner--attention lab-conflict" role="status">Two runs say they're printing; check the Mac.</p>`:''}${active.map(x=>experimentHtml(x,ix.project,requests,byId,ix.colours)).join('')||'<p class="empty-state">No open experiments.</p>'}`
  +(earlier.length?`<details class="lab-earlier" id="lab-earlier"><summary>Earlier (${earlier.length})</summary>${earlier.map(x=>experimentHtml(x,ix.project,requests,byId,ix.colours)).join('')}</details>`:'')+outsideHtml(ix.outside)+'</div></div>';
}

function renderRedirect(box){
 if(!box)return;
 const hash=location.hash||'';
 const searchPart=hash.includes('?')?hash.split('?')[1]:'';
 const params=new URLSearchParams(searchPart);
 const expId=params.get('e');
 const proj=params.get('p');
 const doAction=params.get('do');
 const hubBase=root.LocalAIAskContext?.homeUrl?.(location.hostname)?.replace(/\/+$/,'')
   ||(location.hostname.endsWith('.rahe-home.duckdns.org')?'https://hub.rahe-home.duckdns.org':'http://10.0.0.30');
 const targetParams=new URLSearchParams();
 if(proj)targetParams.set('p',proj);
 if(expId)targetParams.set('e',expId);
 if(doAction)targetParams.set('do',doAction);
 const qs=targetParams.toString();
 const targetUrl=hubBase+'/lab'+(qs?'?'+qs:'');
 
 // Automatic redirect when active in view
 if(location.hash.startsWith('#printLab')||location.hash.startsWith('#/printLab')){
   try{
     location.replace(targetUrl);
     return;
   }catch{}
 }

 box.innerHTML=`<div class="card lab-redirect-card"><h2>Print lab is on Pi Hub</h2><p class="sub">Testing records, verdicts, and photos now live directly on Pi Hub so they stay available when this PC is off.</p><div class="actions"><a class="btn-primary" href="${esc(targetUrl)}" rel="noopener">Open Print lab on Pi Hub ↗</a></div></div>`;
}

async function refresh(){
 const box=document.getElementById('printLabBody');
 if(!box)return;
 renderRedirect(box);
}

function init(){
 const sec=document.getElementById('printLab');if(!sec)return;
 const box=document.getElementById('printLabBody');
 renderRedirect(box);
 const active=()=>sec.classList.contains('active');let was=active();
 new MutationObserver(()=>{
  const now=active();
  if(now&&!was)refresh();
  was=now;
 }).observe(sec,{attributes:true,attributeFilter:['class']});
 window.addEventListener('hashchange',()=>{
  if(active())refresh();
 });
 if(was)refresh();
}
root.LocalAIPrintLab={render,refresh,data:()=>null};
if(typeof module==='object'&&module.exports)module.exports={render};
else if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(typeof window!=='undefined'?window:globalThis);
