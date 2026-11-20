// Work: one timeline of every run you started, grouped by day. A chip asks the server for its kind (`kind=`, mapped in
// run-cards.js), so an older mission is reachable however many chats came since; search works on the loaded rows.
// Show more pages by `before` within the kind; the list refreshes itself while something runs and a row updates in place.
(function(root){'use strict';
const $=id=>document.getElementById(id),PAGE=60,KEY='localai.work.kind',KINDS=['all','needs','chats','images','missions','sheets','changes','other'];
const GROUPS=['Today','Yesterday','Earlier this week','Older'],LIVE=new Set(['queued','running','streaming']);
const key=it=>it.threadId||it.id,NONE={needs:'Nothing needs you.',chats:'No chats yet.',images:'No images yet.',missions:'No missions yet.',sheets:'No spreadsheet requests yet.',changes:'No changes yet.',other:'Nothing else yet.'};
// Threads sort and page by their latest run's (createdAt, id), newest first, the same key the server's `before` uses.
const newest=(a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))||String(b.id).localeCompare(String(a.id));
const store={get:()=>{try{return localStorage.getItem(KEY)}catch{return null}},set:v=>{try{localStorage.setItem(KEY,v)}catch{}}};
const st={threads:new Map(),items:[],more:false,loaded:false,started:false,kind:'all',gen:0,query:'',shown:'',rows:new Map(),timer:0,selecting:false,picked:new Set(),readAt:null,stale:false}; // gen: bumps when the chip changes, so a late page of the old kind is dropped; readAt: the last good read; stale: a refresh since then failed
function groupOf(it){
 const t=new Date(it.createdAt),d=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime();
 if(isNaN(t))return 3;
 const n=Math.round((d(new Date())-d(t))/864e5);
 return n<=0?0:n===1?1:n<7?2:3;
}
const sig=it=>[st.stale,it.id,it.status,it.progress,it.updatedAt,it.turns,it.kept,it.card?.title,it.card?.summary,it.card?.badge?.label,st.selecting,it.repeat?.length].join('|');
// The server sends one row per thread (its latest run, with `turns`), so each thread lives on exactly one page.
// `window` (a refresh of the newest page) also drops what that page no longer holds: runs deleted or filed away.
function merge(list,{older=false,window=false}={}){
 if(window){
  const last=list.length>=PAGE?list[list.length-1]:null,have=new Set(list.map(key));
  for(const [k,it] of st.threads)if(!have.has(k)&&(!last||newest(it,last)<0))st.threads.delete(k);
 }
 for(const it of list){if(!older||!st.threads.has(key(it)))st.threads.set(key(it),it)}
 st.items=[...st.threads.values()].sort(newest);
}
// Start something: Home's composer, focused once Home is the open page.
function startSomething(){window.LocalAIRouter?.go('#home');const t=Date.now(),f=()=>{const c=$('commandInput');if($('home')?.classList.contains('active')&&c)c.focus();else if(Date.now()-t<1500)setTimeout(f,40)};f()}
// Opening a run goes through the runs module, so Close and Back return to Work.
const openRun=it=>window.LocalAIRuns?window.LocalAIRuns.show(it.id):window.LocalAIRouter?.go('#run/'+encodeURIComponent(it.id));
// One card per row: a chat thread's turn count (the card itself shows the summary once), and the row itself opens the run.
// A7 P6: one automation run again and again in one day group is one row, its newest run, with the count and the time
// range ("24 times · 1:00 AM–12:00 PM"). Select mode shows every run, so each can still be picked.
function fold(g){
 if(st.selecting)return g;
 const out=[],by=new Map();
 for(const it of g){
  const a=it.meta?.automationId;if(!a){out.push(it);continue}
  const e=by.get(a);if(e){e.repeat.push(it);continue}
  const n={...it,repeat:[it]};by.set(a,n);out.push(n);
 }
 return out;
}
const clock=v=>{const d=new Date(v);return isNaN(d)?'':d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})};
function repeatWords(r){
 const first=clock(r[r.length-1].createdAt),last=clock(r[0].createdAt);
 return `${r.length} times`+(first&&last?` · ${first}–${last}`:'');
}
function rowFor(it){
 let c=it.card||{};const n=it.turns||1;
 if(c.kind==='chat'&&n>1)c={...c,summary:`Chat · ${n} turns`,preview:c.preview||(c.summary?{type:'text',text:c.summary}:null)};
 if(it.repeat?.length>1)c={...c,summary:[repeatWords(it.repeat),c.summary].filter(Boolean).join(' · ')};
 // In Select mode a tap picks the row instead of opening it, and the row carries its checkbox.
 const row=window.LocalAIUI.runCard({...it,card:c},{onOpen:x=>st.selecting?pick(key(x),!st.picked.has(key(x))):openRun(x),rowOpen:true,stale:st.stale});
 const act=row.querySelector('.run-card__action');
 if(act){if(!st.selecting&&/^(Review|Try again)$/i.test(act.textContent.trim()))act.className='btn-outline work-secondary';else act.remove()}
 if(st.selecting){
  const box=document.createElement('input');box.type='checkbox';box.className='work-pick';box.dataset.key=key(it);box.checked=st.picked.has(key(it));
  box.setAttribute('aria-label',`Select ${c.title||it.title||'this'}`);box.addEventListener('click',e=>e.stopPropagation());
  box.addEventListener('change',()=>pick(key(it),box.checked));row.classList.add('is-picking');row.prepend(box);
 }else if(typeof it.kept==='boolean')row.querySelector('.list-row__trail')?.appendChild(keepButton(it));
 return row;
}
// ☆ Keep on a chat or research row: Library holds only what you keep. Un-keep takes it out of Library; the row stays.
function keepButton(it){
 const b=document.createElement('button'),name=it.card?.title||it.title||'this chat';b.type='button';b.className='icon-btn work-keep';
 b.textContent=it.kept?'★':'☆';b.setAttribute('aria-pressed',String(it.kept));b.setAttribute('aria-label',it.kept?`Kept in Library: ${name}`:`Keep ${name}`);
 b.title=it.kept?'Kept in Library. Tap to take it out; it stays in Work.':'Keep in Library';
 b.addEventListener('click',async e=>{
  e.stopPropagation();b.disabled=true;const kept=!it.kept;
  try{
   const r=await fetch('/api/library/keep',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:it.id,kept})});
   if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'HTTP '+r.status);
   setKept(it.threadId||it.id,kept);
   window.LocalAIUI?.toast?.(kept?'Kept in Library':"Taken out of Library. It's still in Work.");
  }catch(err){b.disabled=false;window.LocalAIUI?.toast?.(`Couldn't ${kept?'keep':'un-keep'} it. ${err.message||err}`)}
 });
 return b;
}
// Select mode: pick rows, then Delete (n). Undo (in the toast) reloads the list.
function pick(k,on){if(on)st.picked.add(k);else st.picked.delete(k);document.querySelectorAll('#workList .work-pick').forEach(b=>{if(b.dataset.key===k)b.checked=on});selectBar()}
function selectBar(){
 const n=st.picked.size,del=$('workDeleteSelected');
 $('workSelectBar').hidden=!st.selecting;$('workSelect').setAttribute('aria-pressed',String(st.selecting));$('workSelect').textContent=st.selecting?'Done':'Select';
 $('workSelectCount').textContent=n?`${n} picked.`:'Pick what to delete.';del.disabled=!n;del.textContent=n?`Delete (${n})`:'Delete';
}
function setSelecting(on){st.selecting=on;if(!on)st.picked.clear();selectBar();if(st.loaded)paint()}
async function deletePicked(){
 const ids=[...st.picked],b=$('workDeleteSelected');b.disabled=true;
 const out=await window.LocalAIUI.deleteItems(ids.map(id=>({kind:'thread',id})),{onUndo:()=>refresh()});
 if(!out){selectBar();return}
 for(const k of ids)st.threads.delete(k);st.items=[...st.threads.values()].sort(newest);setSelecting(false);
}
function setKept(k,kept){const it=st.threads.get(k);if(!it)return;st.threads.set(k,{...it,kept});st.items=[...st.threads.values()].sort(newest);if(st.loaded)paint()}
const text=it=>`${it.card?.title||''} ${it.card?.summary||''}`.toLowerCase();
const visible=()=>{const q=st.query.trim().toLowerCase();return st.items.filter(it=>!q||text(it).includes(q))};
// Work's faceplate (Pi Hub A7 P1, L2b), from the rows loaded for the chip: how many are running, the newest, and how many
// started today and this week. `failed` (the first page didn't load) shows no count rather than an old one, and so does a
// stale list (a refresh failed): the rows stay, but its running count is no longer known.
const KIND_WORD={needs:'Needs you',chats:'Chats',images:'Images',missions:'Missions',sheets:'Spreadsheets',changes:'Changes',other:'Other'};
// A good read clears the stale notice; a failed quiet refresh keeps the rows and puts it up (A28: unreadable is not current).
function clearStale(){st.stale=false;window.LocalAIUI?.staleNotice?.('workNotice')}
function readOk(){st.readAt=new Date();clearStale()}
function readFailed(){st.stale=true;window.LocalAIUI?.staleNotice?.('workNotice',{since:st.readAt||new Date()});paint()}
function plate(failed){
 const ui=window.LocalAIUI;if(!ui?.plate)return;const latest=$('workLatest'),readings=$('workReadings');
 if(failed){ui.plate('workPlate',{lamp:['unknown','Unknown'],readout:'—'});if(latest)latest.textContent="Couldn't read your work.";if(readings)readings.hidden=true;ui.sources('workSources',"Local AI's run list",'bad');return}
 if(st.stale){ui.plate('workPlate',{lamp:['unknown','Unknown'],readout:'—'});if(readings)readings.hidden=true;ui.sources('workSources',"Local AI's run list",'bad',st.readAt?`last read ${clock(st.readAt)}`:'');return}
 const running=st.items.filter(it=>LIVE.has(it.status)).length,top=st.items[0],filter=st.kind!=='all'?` · ${KIND_WORD[st.kind]}`:'';
 ui.plate('workPlate',{lamp:running?['ok','Running']:['unknown','Idle'],readout:running||'Nothing',unit:running?'running':'running now'});
 if(latest)latest.textContent=top?`Latest${filter}: ${top.card?.title||top.title||'Untitled'}`:st.kind==='all'?'Nothing yet. Start something from Home.':`No ${KIND_WORD[st.kind].toLowerCase()} yet.`;
 if(readings){readings.hidden=!st.items.length;$('workToday').textContent=String(st.items.filter(it=>groupOf(it)===0).length);$('workWeek').textContent=String(st.items.filter(it=>groupOf(it)<=2).length)}
 ui.sources('workSources',"Local AI's run list",'ok',st.readAt?`read ${clock(st.readAt)}`:'');
}
function paint(){
 const box=$('workList'),list=visible();plate();
 $('workMore').hidden=!st.more; // the server filtered by kind: an empty first page means there are none, and st.more is false then
 if(!st.items.length&&st.kind!=='all'){box.innerHTML=`<div class="state-empty empty-state"><div class="empty-state__title">${NONE[st.kind]}</div><div>Try another filter.</div></div>`;st.shown='';st.rows.clear();return}
 if(!st.items.length){
  // One Start something per page: the faceplate's (A7 P1). The list says what will appear here.
  box.innerHTML='<div class="state-empty empty-state"><div class="empty-state__title">Nothing yet</div><div>What you start from Home appears here, newest first.</div></div>';
  st.shown='';st.rows.clear();return;
 }
 const by=GROUPS.map(()=>[]);list.forEach(it=>by[groupOf(it)].push(it));by.forEach((g,i)=>{by[i]=fold(g)});
 const rows=by.flat();
 const layout=by.map((g,i)=>g.length?GROUPS[i]+':'+g.map(x=>x.id).join(','):'').join(';')+'|'+rows.length;
 if(layout===st.shown&&box.querySelector('.work-group')){ // same rows in the same places: swap only the ones that changed
  for(const it of rows){const old=st.rows.get(it.id),s=sig(it);if(old&&old.sig!==s){const row=rowFor(it);old.el.replaceWith(row);st.rows.set(it.id,{el:row,sig:s})}}
  return;
 }
 const y=window.scrollY;st.rows.clear();box.textContent='';
 if(!list.length){box.innerHTML='<div class="state-empty empty-state"><div class="empty-state__title">Nothing matches</div><div>Try another filter or search.</div></div>'}
 by.forEach((g,i)=>{
  if(!g.length)return;
  const sec=document.createElement('section'),h=document.createElement('h2'),grp=document.createElement('div');
  sec.className='work-group';h.className='work-day';h.textContent=GROUPS[i];grp.className='list-group';
  for(const it of g){const row=rowFor(it);st.rows.set(it.id,{el:row,sig:sig(it)});grp.appendChild(row)}
  sec.append(h,grp);box.appendChild(sec);
 });
 st.shown=layout;window.scrollTo(0,y);
}
const url=before=>`/api/runs?threads=1&limit=${PAGE}${st.kind!=='all'?'&kind='+st.kind:''}${before?'&before='+encodeURIComponent(before):''}`;
function render(box,data){
 if(data.gen!==st.gen)return; // the chip changed while this page loaded
 box.removeAttribute('aria-busy');st.threads.clear();st.rows.clear();st.shown='';
 readOk();merge(data.items||[]);st.more=(data.items||[]).length>=PAGE;st.loaded=true;paint();schedule();
}
const load=()=>{const gen=st.gen;return window.LocalAIUI.fetchJson(url()).then(d=>({...d,gen}))};
const first=()=>{const box=$('workList'),gen=st.gen;st.started=true;box.setAttribute('aria-busy','true');return window.LocalAIUI.loadInto(box,load,{render,what:'your work'}).catch(()=>{if(gen===st.gen)plate(true)}).finally(()=>{if(gen===st.gen)box.removeAttribute('aria-busy')})};
// A quiet refresh of the newest page: updates rows in place, adds new threads, keeps what Show more loaded.
async function refresh(){
 const gen=st.gen;try{const d=await window.LocalAIUI.fetchJson(url());if(gen!==st.gen)return;readOk();merge(d.items||[],{window:true});paint()}catch{if(gen===st.gen)readFailed()}
}
async function more(){
 const b=$('workMore'),last=st.items[st.items.length-1];if(!last)return;
 b.disabled=true;const gen=st.gen;
 try{const d=await window.LocalAIUI.fetchJson(url(last.id));if(gen!==st.gen)return;merge(d.items||[],{older:true});st.more=(d.items||[]).length>=PAGE;b.textContent='Show more';paint();schedule()}
 catch{b.textContent="Couldn't load more. Try again"}
 b.disabled=false;
}
// A new chip starts its own list from the server (once Work has loaded at all); returns whether the kind changed.
function setKind(k,{mirror=true,remember=true,fetch=true}={}){
 if(!KINDS.includes(k))k='all';
 const changed=k!==st.kind;
 st.kind=k;
 st.chips?.pick(document.querySelector(`[data-work-kind="${k}"]`));
 // Agent World (the live mission map) has no menu entry since Missions became a Work filter; link to it from there.
 const aw=$('workAgentWorld');if(aw)aw.hidden=k!=='missions';
 if(remember&&k!=='needs')store.set(k); // Needs you is a look from Home's See all, not where Work opens next time
 if(mirror){const h='#work'+(k==='all'?'':'?kind='+k);if(location.hash!==h)history.replaceState(null,'',location.pathname+location.search+h)}
 if(changed){ // the rows on screen are another kind's: clear them and load this one (activate() loads on its own)
  st.gen++;st.threads.clear();st.items=[];st.more=false;st.loaded=false;st.shown='';st.rows.clear();clearStale();st.readAt=null;
  const box=$('workList');if(box&&st.started){box.textContent='';$('workMore').hidden=true;if(fetch)first()}
 }else if(st.loaded)paint();
 return changed;
}
// The hash wins; otherwise what was remembered.
function fromHash(){
 const cur=window.LocalAIRouter?.current(),k=cur?.page==='work'&&cur.query.get('kind');
 return KINDS.includes(k)?k:null;
}
const active=()=>$('work')?.classList.contains('active');
function schedule(){
 clearTimeout(st.timer);
 const live=st.items.some(it=>LIVE.has(it.status));
 st.timer=setTimeout(tick,live?5000:60000);
}
// Polling runs only while Work is the open page; activate() starts it again.
function tick(){if(!active())return;if(!document.hidden&&st.loaded)refresh().then(schedule);else schedule()}
function activate(){
 const k=fromHash();
 setKind(k||(KINDS.includes(store.get())?store.get():'all'),{remember:!!k,fetch:false});
 if(st.loaded)refresh();else first();
 schedule();
}
function init(){
 const sec=$('work');if(!sec)return;
 const chips=sec.querySelector('.work-chips');if(chips&&window.LocalAIUI?.segmented)st.chips=window.LocalAIUI.segmented(chips,{onPick:b=>setKind(b.dataset.workKind)});
 $('workSearch').addEventListener('input',e=>{st.query=e.target.value;if(st.loaded)paint()});
 $('workMore').addEventListener('click',more);
 $('workSelect').addEventListener('click',()=>setSelecting(!st.selecting));
 $('workStart')?.addEventListener('click',startSomething);
 $('workSelectDone').addEventListener('click',()=>setSelecting(false));
 $('workDeleteSelected').addEventListener('click',deletePicked);
 $('workOpenAgentWorld')?.addEventListener('click',()=>window.LocalAIRouter?.open('agents'));
 setKind(KINDS.includes(store.get())?store.get():'all',{mirror:false,remember:false});
 let was=active();
 new MutationObserver(()=>{const now=active();if(now&&!was)activate();was=now}).observe(sec,{attributes:true,attributeFilter:['class']});
 // #agents while Work is already open, or Back to another #work?kind=…: the router has settled the hash by the next turn.
 window.addEventListener('hashchange',()=>setTimeout(()=>{const k=active()&&fromHash();if(k&&k!==st.kind)setKind(k,{mirror:false})},0));
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&active()&&st.loaded)refresh().then(schedule)});
 window.addEventListener('localai:kept',e=>setKept(e.detail?.threadId||e.detail?.runId,!!e.detail?.kept)); // ☆ Keep in the run view
 // Delete in the run view takes the row out; its Undo (or one from Library) brings the list up to date.
 window.addEventListener('localai:deleted',e=>{const k=e.detail?.threadId;if(k&&st.threads.delete(k)){st.items=[...st.threads.values()].sort(newest);if(st.loaded)paint()}});
 window.addEventListener('localai:restored',()=>{if(st.loaded)refresh()});
 window.LocalAIUI.pullToRefresh?.('work',()=>st.loaded?refresh():first()); // a pull down from the top (components.js)
 if(was)activate();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
