// Improve › Backlog, In progress, Shipped and Signals (roadmap sub-project 4). Items and signals come from
// /api/improve/items; every action posts to /api/improve/* and then reloads. Spec:
// docs/superpowers/specs/2026-10-15-improve-design.md.
(function(root){'use strict';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// One icon per meaning (E7): sparkle is Claude, alert is a Signal, improve is a change you asked for.
const ICON={claude:'sparkle',signal:'alert',idea:'improve'};
const SOURCE={claude:'From Claude',signal:'Signal',idea:'Your idea'};
const LABEL={high:'High',medium:'Medium',low:'Low'};
const st={data:null,openId:'',sessions:[]};
// A running change's state, in words: [label, badge tone].
const CHANGE_STATE={planned:['Planning','neutral'],staged:['Testing','neutral'],awaiting_approval:['Waiting for your OK','attention'],patch_failed:['Needs a look','bad'],validation_failed:['Needs a look','bad'],approved:['Shipping','accent'],apply_requested:['Shipping','accent']};
const failed=it=>['patch_failed','validation_failed'].includes(it.change?.status);
const badge=([label,tone])=>`<span class="badge badge--${tone}">${esc(label)}</span>`;
// Board sessions are cc-<first 8 of the Claude session id>; findings carry the full id.
const sessionOf=it=>it.sessionId?st.sessions.find(s=>s.id===it.sessionId||s.id==='cc-'+String(it.sessionId).slice(0,8)):null;
const icon=n=>root.LocalAIKit?.icon(n)||'';
const ago=iso=>{const s=(Date.now()-new Date(iso))/1000;if(!isFinite(s))return '';if(s<3600)return Math.max(1,Math.round(s/60))+'m ago';if(s<86400)return Math.round(s/3600)+'h ago';return Math.round(s/86400)+'d ago'};
const sev=x=>`<span class="badge badge--neutral badge--severity">${LABEL[x]||'Medium'}</span>`;   // severity is neutral; colour is for status (E7)
async function post(path,body){return root.LocalAIUI.fetchJson(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
async function load(){
 // Release history places items closed on the board (no release stamp) in the release that followed them.
 const [data,rel]=await Promise.all([root.LocalAIUI.fetchJson('/api/improve/items',{cache:'no-store'}),root.LocalAIUI.fetchJson('/api/releases',{cache:'no-store'}).catch(()=>null)]);
 st.data=data;st.releases=(rel?.history||[]).filter(r=>r&&r.version&&Date.parse(r.deployedAt)).sort((a,b)=>Date.parse(a.deployedAt)-Date.parse(b.deployedAt));
 return st.data;
}

function backlogRow(it){
 const row=document.createElement('div');row.className='list-row improve-row';row.dataset.itemId=it.id;
 const net=(it.votes?.up||0)-(it.votes?.down||0);
 row.innerHTML=`<span class="list-row__icon" title="${SOURCE[it.source]||''}">${icon(ICON[it.source]||'improve')}</span>`+
  `<button type="button" class="improve-row__open list-row__main"><span class="list-row__title">${esc(it.title)}</span>`+
  `<span class="list-row__sub">${sev(it.severity)} <span>${SOURCE[it.source]||''}</span>${it.handedToClaude?' <span class="badge badge--neutral">Handed to Claude</span>':''}</span></button>`+
  `<span class="list-row__trail improve-votes"><button type="button" class="icon-btn" data-vote="1" aria-label="Vote up: ${esc(it.title)}">▲</button><span aria-label="Net votes">${net}</span><button type="button" class="icon-btn" data-vote="-1" aria-label="Vote down: ${esc(it.title)}">▼</button></span>`;
 row.querySelector('.improve-row__open').onclick=()=>openItem(it.id);
 row.querySelectorAll('[data-vote]').forEach(b=>b.onclick=async()=>{b.disabled=true;rowError(row,'');try{await post('/api/claude/findings/vote',{id:it.id,delta:Number(b.dataset.vote)});await refresh()}catch(e){b.disabled=false;rowError(row,`Couldn't save your vote: ${e.message}`)}});
 return row;
}
function renderBacklog(box,data){
 const items=(data.items||[]).filter(i=>i.stage==='backlog');
 box.replaceChildren(...items.map(backlogRow));return items.length>0;
}
function inProgressRow(it){
 const row=document.createElement('div');row.className='list-row improve-row';row.dataset.itemId=it.id;
 const s=sessionOf(it),state=it.change?badge(CHANGE_STATE[it.change.status]||['Working','neutral']):badge(['Claude','accent']);
 // The session's state, not its latest step: one session holds many items, so its step would repeat on each of them.
 const quiet=s&&s.status!=='active'&&Date.now()-Date.parse(s.updatedAt||'')>6*36e5;
 const claude=!it.change?` <span>${!s?"Claude's session isn't reporting":quiet?`Paused: Claude last worked on this ${esc(ago(s.updatedAt))}`:`Claude's session is ${s.status==='active'?'active':'idle'}${s.updatedAt?' · '+esc(ago(s.updatedAt)):''}`}</span>`:'';
 row.innerHTML=`<span class="list-row__icon">${icon(ICON[it.source]||'improve')}</span>`+
  `<button type="button" class="improve-row__open list-row__main"><span class="list-row__title">${esc(it.title)}</span><span class="list-row__sub">${state}${claude}</span></button>`;
 row.querySelector('.improve-row__open').onclick=()=>openItem(it.id);
 return row;
}
function renderInProgress(box,data){
 const items=(data.items||[]).filter(i=>i.stage==='inProgress');
 box.replaceChildren(...items.map(inProgressRow));return items.length>0;
}
const day=iso=>{const d=new Date(iso);return isFinite(d)?d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):''};
function shippedRow(it){
 const row=document.createElement('div');row.className='list-row improve-row';row.dataset.itemId=it.id;
 const pr=/^https:\/\/github\.com\/[^\s"]+\/pull\/(\d+)/.exec(it.pr||'');
 const how=pr?`<a href="${esc(it.pr)}" target="_blank" rel="noopener">Pull request #${pr[1]}</a>`:esc(it.decisionNote==='Resolved on its own'?'Resolved on its own':'');
 row.innerHTML=`<span class="list-row__icon">${icon('check')}</span><span class="list-row__main"><span class="list-row__title">${esc(it.title)}</span>`+
  `<span class="list-row__sub">${esc(day(it.shipped?.at||it.updatedAt))}${how?' · '+how:''}</span></span>`;
 return row;
}
const SHOWN_RELEASES=6;
function renderShipped(box,data){
 const at=it=>String(it.shipped?.at||it.decidedAt||it.updatedAt||'');
 const items=(data.items||[]).filter(i=>i.stage==='shipped').sort((a,b)=>at(b).localeCompare(at(a)));
 const rel=st.releases||[],relAt=new Map(rel.map(r=>[r.version,Date.parse(r.deployedAt)]));
 // Stamped items keep their release. Others go to the first release deployed after they closed: "Next release" when
 // none has yet, "Earlier" when they closed before the oldest release on record (or there is no history).
 const key=it=>{
  if(it.shipped?.version)return 'v:'+it.shipped.version;
  if(it.shipped?.pending)return 'next';
  const t=Date.parse(at(it));if(!t||!rel.length||t<Date.parse(rel[0].deployedAt))return 'earlier';
  const r=rel.find(r=>Date.parse(r.deployedAt)>=t);return r?'v:'+r.version:'next';
 };
 const groups=new Map();for(const it of items){const k=key(it);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(it)}
 // Next release first, then releases newest first (by deploy time, else by their newest item), Earlier last.
 const when=([k,list])=>k==='next'?Infinity:k==='earlier'?-Infinity:relAt.get(k.slice(2))||Date.parse(at(list[0]))||0;
 const section=([k,list])=>{const g=document.createElement('section');g.className='improve-release';
  const h=document.createElement('h3');h.textContent=k==='next'?'Next release':k==='earlier'?'Earlier':`Version ${k.slice(2)}`;g.append(h,...list.map(shippedRow));return g};
 const ordered=[...groups].sort((a,b)=>when(b)-when(a)).map(section);
 // A long history stays short: older releases fold away.
 if(ordered.length>SHOWN_RELEASES){const d=document.createElement('details');d.className='improve-details';const n=ordered.slice(SHOWN_RELEASES).reduce((c,g)=>c+g.querySelectorAll('.improve-row').length,0);
  d.innerHTML=`<summary>Older releases (${n} change${n===1?'':'s'})</summary>`;d.append(...ordered.slice(SHOWN_RELEASES));box.replaceChildren(...ordered.slice(0,SHOWN_RELEASES),d)}
 else box.replaceChildren(...ordered);
 return items.length>0;
}
function signalRow(s,inBacklog){
 const row=document.createElement('div');row.className='list-row improve-row';row.dataset.signalId=s.id;
 row.innerHTML=`<span class="list-row__icon">${icon('alert')}</span><span class="list-row__main"><span class="list-row__title">${esc(s.name)}</span>`+
  `<span class="list-row__sub">${sev(s.severity)} Seen ${Number(s.occurrences)||1} time${Number(s.occurrences)===1?'':'s'} · ${esc(ago(s.lastSeenAt||s.updatedAt))}${inBacklog?' · In the Backlog':''}</span></span>`+
  `<span class="list-row__trail">${inBacklog?'':'<button type="button" class="btn-outline" data-act="promote">Promote</button>'}<button type="button" class="btn-outline" data-act="dismiss">Dismiss</button></span>`;
 row.querySelectorAll('[data-act]').forEach(b=>b.onclick=async()=>{b.disabled=true;rowError(row,'');try{await post('/api/improve/signal',{id:s.id,action:b.dataset.act});await refresh()}catch(e){b.disabled=false;rowError(row,`Couldn't ${b.dataset.act==='promote'?'promote':'dismiss'} it: ${e.message}`)}});
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
  const details=$('signalsDetails');if(details)details.hidden=!checks.length&&!events.length;   // no empty "Latest checks" (E3)
  if(!checks.length&&!events.length)return false;
  el.innerHTML=`${checks.length?`<ul class="improve-checks">${checks.map(c=>`<li><span class="badge badge--${c.result==='FAIL'?'bad':'good'}">${c.result==='FAIL'?'Failed':'Passed'}</span> ${esc(c.name)}${c.detail?` <span class="list-row__sub">${esc(c.detail)}</span>`:''}</li>`).join('')}</ul>`:''}`+
   `${events.length?`<h3>Recent browser errors</h3><ul class="improve-checks">${events.map(e=>`<li>${esc(e.message)} <span class="list-row__sub">${esc(e.source||'')} · ${esc(ago(e.createdAt))}</span></li>`).join('')}</ul>`:''}`;
  return true}});
}

function openItem(id){
 const it=(st.data?.items||[]).find(i=>i.id===id);const d=$('improveItemSheet');if(!it||!d)return;st.openId=id;
 $('improveItemTitle').textContent=it.title;
 $('improveItemBody').innerHTML=`<p class="list-row__sub">${sev(it.severity)} ${SOURCE[it.source]||''}${it.handedToClaude?' · Handed to Claude':''}</p>`+
  (it.summary?`<p>${esc(it.summary)}</p>`:'')+(it.fix?`<p><strong>Suggested fix:</strong> ${esc(it.fix)}</p>`:'')+(it.file?`<p><code>${esc(it.file)}</code></p>`:'')+(it.stage==='backlog'?`<label class="improve-note" for="improveItemNote">Note for Claude</label><textarea id="improveItemNote" rows="2" maxlength="1000">${esc(it.decisionNote||'')}</textarea><button type="button" class="btn-outline" id="improveItemNoteSave">Save note</button>`:it.decisionNote?`<p class="list-row__sub">${esc(it.decisionNote)}</p>`:'')+(it.stage==='inProgress'&&it.change?`<p>${badge(CHANGE_STATE[it.change.status]||['Working','neutral'])}${['approved','apply_requested'].includes(it.change.status)?' Claude ships it as a pull request.':''}</p>`:'');
 // In progress offers the change's next step: test it, approve it, or retry it. Once approved it is Claude's to ship.
 const c=it.change,locked=['approved','apply_requested'].includes(c?.status);
 const next=!c?[]:failed(it)?[['retry','Retry','btn-primary']]:c.status==='planned'?[['stage','Test the change','btn-primary']]:c.status==='awaiting_approval'?[['approve','Approve','btn-primary']]:[];
 const acts=it.stage==='inProgress'?[...next,...(c&&!failed(it)?[['diff','See the changes','btn-outline']]:[]),...(locked?[]:[['backToBacklog','Back to backlog','btn-outline'],...(c?[['discard','Discard','btn-outline']]:[])])]
  :it.stage==='backlog'?[['start','Start','btn-primary'],...(it.handedToClaude?[]:[['handToClaude','Hand to Claude','btn-outline']]),['moveToTop','Move to top','btn-outline'],['defer','Defer','btn-outline'],['reject','Reject','btn-outline']]:[];
 showActs(it.id,acts);
 const save=$('improveItemNoteSave');if(save)save.onclick=()=>saveNote(it,save);
 $('improveItemError').hidden=true;showSheet(d);
}
function showActs(id,acts){
 const box=$('improveItemActions');box.innerHTML=acts.map(([a,l,c,then])=>`<button type="button" class="${c}" data-item-act="${a}"${then?` data-then="${then}"`:''}>${l}</button>`).join('');
 box.querySelectorAll('[data-item-act]').forEach(b=>b.onclick=()=>b.dataset.itemAct==='discard'&&!b.dataset.then
  // Discard asks what happens to the item: back in the Backlog, or set aside.
  ?showActs(id,[['discard','Back to backlog','btn-outline','backlog'],['discard','Set aside','btn-outline','aside']])
  :CHANGE_ACTS[b.dataset.itemAct]?changeAction(id,b.dataset.itemAct,b)
  :itemAction(id,b.dataset.itemAct,b,b.dataset.then));
}
// The change's diff, inside the sheet. Before it is tested there is no diff yet, only the files it plans to touch.
function showDiff(c){
 const body=$('improveItemBody');body.querySelector('.improve-diff')?.remove();
 const box=document.createElement('div');box.className='improve-diff';
 const diffs=c?.diffs||[],files=c?.files||[];
 box.innerHTML=(c?.notes?`<p>${esc(c.notes)}</p>`:'')+(diffs.length?diffs.map(d=>`<details open><summary>${esc(d.path)}</summary><pre>${esc(d.diff)}</pre></details>`).join('')
  :`<p class="list-row__sub">${files.length?`Changes ${files.map(f=>esc(f.path)).join(', ')}. Test the change to see the exact diff.`:'No files planned yet.'}</p>`);
 body.append(box);box.scrollIntoView?.({block:'nearest'});
}
// The change itself: test (stage) it, approve it after a confirmation, or read its diff on Change requests.
const CHANGE_ACTS={stage:1,approve:1,diff:1};
async function changeAction(id,action,btn){
 const it=(st.data?.items||[]).find(i=>i.id===id),cid=it?.change?.id,err=$('improveItemError');if(!cid)return;
 if(action==='diff'){btn.disabled=true;try{showDiff((await root.LocalAIUI.fetchJson('/api/changes?id='+encodeURIComponent(cid),{cache:'no-store'})).item)}catch(e){err.textContent=e.message;err.hidden=false}finally{btn.disabled=false}return}
 if(action==='approve'&&!(await root.LocalAIUI.ask({title:'Approve this change?',effect:'Claude ships it to Local AI as a pull request.',confirmLabel:'Approve'})).ok)return;
 btn.disabled=true;
 try{await post(action==='stage'?'/api/changes/stage':'/api/changes/approve',action==='stage'?{id:cid}:{id:cid,decision:'approved'});await settle(id,DONE[action])}
 catch(e){err.textContent=e.message;err.hidden=false;btn.disabled=false}
}
// A note travels with the item to Claude (the board's decisionNote); the item's status stays as it is.
async function saveNote(it,btn){
 const err=$('improveItemError');btn.disabled=true;
 try{await post('/api/claude/findings/decision',{id:it.id,status:it.status,note:$('improveItemNote').value.trim()});await settle(it.id,'Note saved for Claude')}
 catch(e){err.textContent=e.message;err.hidden=false;btn.disabled=false}
}
// What each action did, in words, for the status toast.
const DONE={moveToTop:'Moved to top',defer:'Deferred',reject:'Rejected',handToClaude:'Claude will pick this up in its next session',backToBacklog:'Back in the Backlog',
 start:'Started. It is in In progress',stage:'Testing the change',approve:'Approved. Claude ships it as a pull request',retry:'Trying the change again'};
const LIST={backlog:'backlogList',inProgress:'inProgressList',shipped:'shippedList'};
// The rows around an item on screen now, so focus has somewhere to go if the item leaves its list.
function neighbours(id){const row=document.querySelector(`.view.active .improve-row[data-item-id="${CSS.escape(id)}"]`);const sib=(n,dir)=>{while(n&&(n=n[dir])&&!n.dataset?.itemId);return n?.dataset?.itemId||''};
 return {list:row?.parentElement?.id||'',next:sib(row,'nextElementSibling'),prev:sib(row,'previousElementSibling')}}
// After the sheet closes and the list is redrawn: focus the item's row (or its neighbour), and say what happened.
// Start goes to In progress, where the item is highlighted.
async function settle(id,said,{go}={}){
 const around=neighbours(id);$('improveItemSheet').close();
 if(go&&root.LocalAIRouter){root.LocalAIRouter.open(go)}
 await refresh();
 // Opening a page starts its own refresh, and the page change moves focus a frame later: wait for both before placing focus.
 for(let p=st.last;;p=st.last){await p;if(p===st.last)break}
 if(go)await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 const list=go?LIST[go]:around.list||LIST.backlog;
 root.LocalAIUI.refocus?.(id,{within:'#'+list,next:go?'':around.next,prev:go?'':around.prev,control:'.improve-row__open',fallback:'.empty-state',highlight:!!go});
 if(said)root.LocalAIUI.announce?.(said);
}
async function itemAction(id,action,btn,then){
 const err=$('improveItemError');btn.disabled=true;
 try{await post('/api/improve/item',then?{id,action,then}:{id,action});
  await settle(id,action==='discard'?(then==='aside'?'Set aside':'Back in the Backlog'):DONE[action],{go:action==='start'?'inProgress':''})}
 catch(e){err.textContent=e.message;err.hidden=false;btn.disabled=false}
}
// Shows a sheet that Back closes (LocalAIUI.sheetHistory); closing it any other way pops that history entry again.
function showSheet(d){
 if(d.open)return;d.showModal();
 const release=root.LocalAIUI.sheetHistory?.(d,()=>d.close());
 if(release)d.addEventListener('close',release,{once:true});
}
// Opens the idea sheet, optionally with text (Home's Change Local AI mode). Resolves {start, error?} once saved, or null if closed unsaved.
function openIdea(text){
 const d=$('improveIdeaSheet');if(!d)return Promise.resolve(null);
 $('improveIdeaText').value=typeof text==='string'?text:'';$('improveIdeaError').hidden=true;showSheet(d);$('improveIdeaText').focus();
 return new Promise(res=>{st.ideaDone=res;d.addEventListener('close',()=>{if(st.ideaDone===res){st.ideaDone=null;res(null)}},{once:true})});
}
async function submitIdea(start,btn){
 const text=$('improveIdeaText').value,err=$('improveIdeaError');
 if(!text.trim()){err.textContent='Describe the change first.';err.hidden=false;return}
 btn.disabled=true;
 try{const r=await post('/api/improve/idea',{text,start});const done=st.ideaDone;st.ideaDone=null;await refresh();if(r.error){err.textContent=r.error;err.hidden=false;done?.({start,error:r.error})}else{done?.({start});$('improveIdeaSheet').close()}}
 catch(e){err.textContent=e.message;err.hidden=false}
 finally{btn.disabled=false}
}
async function runChecks(btn){if(btn)btn.disabled=true;checksError('');try{await post('/api/issues/scan',{});await refresh();loadDetails()}catch(e){checksError(`Couldn't run the checks: ${e.message}`)}finally{if(btn)btn.disabled=false}}
// Errors stay in the page until the next try (an alert box), not in a toast that fades before it can be read.
function alertBox(cls){const p=document.createElement('p');p.className='improve-error '+cls;p.setAttribute('role','alert');return p}
// Under the row the action was taken on (a vote, Promote, Dismiss).
function rowError(row,msg){let p=row.nextElementSibling?.classList.contains('improve-row__error')?row.nextElementSibling:null;
 if(!msg){p?.remove();return}if(!p){p=alertBox('improve-row__error');row.after(p)}p.textContent=msg}
// Signals' Run checks: under the page's top bar (where its button is), above the list; the header button on phones runs the same.
function checksError(msg){const sec=$('signals');if(!sec)return;let p=$('signalsError');
 if(!msg){if(p)p.hidden=true;return}if(!p){p=alertBox('improve-page-error');p.id='signalsError';(sec.querySelector('.topbar')||sec.firstElementChild).after(p)}p.textContent=msg;p.hidden=false}

// Claude sessions' live status, for items Claude is working on; the list still shows without it.
async function sessions(){try{st.sessions=(await root.LocalAIUI.fetchJson('/api/claude/board',{cache:'no-store'})).sessions||[]}catch{st.sessions=[]}}
// One request feeds every list; each list shows its own error state if it fails.
async function refresh(){
 const p=load();
 // The first call shares this refresh's request; a Retry from the error state fetches again.
 const once=()=>{let first=true;return()=>{if(first){first=false;return p}return load()}};
 const opts=(render,what,empty)=>({render,what,empty});
 return st.last=Promise.all([
  $('backlogList')&&root.LocalAIUI.loadInto($('backlogList'),once(),opts(renderBacklog,'the backlog','Nothing in the Backlog. Add an idea, or promote a Signal.')),
  $('signalsList')&&root.LocalAIUI.loadInto($('signalsList'),once(),opts(renderSignals,'the signals','Problems Local AI notices appear here. Run checks looks for some now.')),
  $('inProgressList')&&root.LocalAIUI.loadInto($('inProgressList'),()=>Promise.all([once()(),sessions()]).then(([d])=>d),opts(renderInProgress,'what is in progress','Nothing in progress. Start an item from the Backlog.')),
  $('shippedList')&&root.LocalAIUI.loadInto($('shippedList'),once(),opts(renderShipped,'what has shipped','Changes appear here once they ship. Start one from the Backlog.'))
 ]).catch(()=>{});
}
function init(){
 if(!$('backlog'))return;
 $('improveNewIdea').onclick=openIdea;$('signalsRunChecks').onclick=e=>runChecks(e.currentTarget);
 document.querySelectorAll('[data-idea-start]').forEach(b=>b.onclick=()=>submitIdea(b.dataset.ideaStart==='true',b));
 for(const id of ['backlog','inProgress','shipped','signals']){const sec=$(id);if(!sec)continue;root.LocalAIUI.pullToRefresh?.(id,refresh);let was=sec.classList.contains('active');
  new MutationObserver(()=>{const now=sec.classList.contains('active');if(now&&!was){refresh();if(id==='signals')loadDetails()}was=now}).observe(sec,{attributes:true,attributeFilter:['class']});
  if(was){refresh();if(id==='signals')loadDetails()}}
}
root.LocalAIImprove={refresh,openItem,openIdea};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
