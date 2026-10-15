// Work: one timeline of every run you started, grouped by day. Filters and search work on the loaded rows;
// Show more pages by `before`; the list refreshes itself while something runs and a row updates in place.
(function(root){'use strict';
const $=id=>document.getElementById(id),PAGE=60,KEY='localai.work.kind',KINDS=['all','chats','images','missions','changes','other'];
const BUCKET={chat:'chats',research:'chats',image:'images',agent:'missions',engineering:'changes'}; // everything else (automation too) is "other"
const GROUPS=['Today','Yesterday','Earlier this week','Older'],LIVE=new Set(['queued','running','streaming']);
const bucket=it=>BUCKET[it.card?.kind]||'other',key=it=>it.threadId||it.id;
// Threads sort and page by their latest run's (createdAt, id), newest first, the same key the server's `before` uses.
const newest=(a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))||String(b.id).localeCompare(String(a.id));
const store={get:()=>{try{return localStorage.getItem(KEY)}catch{return null}},set:v=>{try{localStorage.setItem(KEY,v)}catch{}}};
const st={threads:new Map(),items:[],more:false,loaded:false,kind:'all',query:'',shown:'',rows:new Map(),timer:0};
function groupOf(it){
 const t=new Date(it.createdAt),d=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime();
 if(isNaN(t))return 3;
 const n=Math.round((d(new Date())-d(t))/864e5);
 return n<=0?0:n===1?1:n<7?2:3;
}
const sig=it=>[it.id,it.status,it.progress,it.updatedAt,it.turns,it.card?.title,it.card?.summary,it.card?.badge?.label].join('|');
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
// Opening a run goes through the runs module, so Close and Back return to Work.
const openRun=it=>window.LocalAIRuns?window.LocalAIRuns.show(it.id):window.LocalAIRouter?.go('#run/'+encodeURIComponent(it.id));
// One card per row: a chat thread's turn count (the card itself shows the summary once), and the row itself opens the run.
function rowFor(it){
 let c=it.card||{};const n=it.turns||1;
 if(c.kind==='chat'&&n>1)c={...c,summary:`Chat · ${n} turns`,preview:c.preview||(c.summary?{type:'text',text:c.summary}:null)};
 const row=window.LocalAIUI.runCard({...it,card:c},{onOpen:openRun,rowOpen:true});
 const act=row.querySelector('.run-card__action');
 if(act){if(/^(Review|Retry)$/i.test(act.textContent.trim()))act.className='btn-outline work-secondary';else act.remove()}
 return row;
}
const text=it=>`${it.card?.title||''} ${it.card?.summary||''}`.toLowerCase();
const visible=()=>{const q=st.query.trim().toLowerCase();return st.items.filter(it=>(st.kind==='all'||bucket(it)===st.kind)&&(!q||text(it).includes(q)))};
function paint(){
 const box=$('workList'),list=visible();
 $('workMore').hidden=!st.more||!list.length;
 if(!st.items.length){
  box.innerHTML='<div class="state-empty empty-state"><div class="empty-state__title">Nothing yet. What should we do?</div><button type="button" class="btn-primary">Start something</button></div>';
  box.querySelector('button').addEventListener('click',()=>{window.LocalAIRouter?.go('#home');const t=Date.now(),f=()=>{const c=$('commandInput');if($('home')?.classList.contains('active')&&c)c.focus();else if(Date.now()-t<1500)setTimeout(f,40)};f()});
  st.shown='';st.rows.clear();return;
 }
 const by=GROUPS.map(()=>[]);list.forEach(it=>by[groupOf(it)].push(it));
 const layout=by.map((g,i)=>g.length?GROUPS[i]+':'+g.map(x=>x.id).join(','):'').join(';')+'|'+list.length;
 if(layout===st.shown&&box.querySelector('.work-group')){ // same rows in the same places: swap only the ones that changed
  for(const it of list){const old=st.rows.get(it.id),s=sig(it);if(old&&old.sig!==s){const row=rowFor(it);old.el.replaceWith(row);st.rows.set(it.id,{el:row,sig:s})}}
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
const url=before=>`/api/runs?threads=1&limit=${PAGE}${before?'&before='+encodeURIComponent(before):''}`;
function render(box,data){
 st.threads.clear();st.rows.clear();st.shown='';
 merge(data.items||[]);st.more=(data.items||[]).length>=PAGE;st.loaded=true;paint();schedule();
}
const load=()=>window.LocalAIUI.fetchJson(url());
const first=()=>window.LocalAIUI.loadInto($('workList'),load,{render,what:'your work'}).catch(()=>{});
// A quiet refresh of the newest page: updates rows in place, adds new threads, keeps what Show more loaded.
async function refresh(){
 try{const d=await window.LocalAIUI.fetchJson(url());merge(d.items||[],{window:true});paint()}catch{}
}
async function more(){
 const b=$('workMore'),last=st.items[st.items.length-1];if(!last)return;
 b.disabled=true;
 try{const d=await window.LocalAIUI.fetchJson(url(last.id));merge(d.items||[],{older:true});st.more=(d.items||[]).length>=PAGE;b.textContent='Show more';paint();schedule()}
 catch{b.textContent="Couldn't load more. Try again"}
 b.disabled=false;
}
function setKind(k,{mirror=true,remember=true}={}){
 if(!KINDS.includes(k))k='all';
 st.kind=k;
 document.querySelectorAll('[data-work-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.workKind===k)));
 // Agent World (the live mission map) has no menu entry since Missions became a Work filter; link to it from there.
 const aw=$('workAgentWorld');if(aw)aw.hidden=k!=='missions';
 if(remember)store.set(k);
 if(mirror){const h='#work'+(k==='all'?'':'?kind='+k);if(location.hash!==h)history.replaceState(null,'',location.pathname+location.search+h)}
 if(st.loaded)paint();
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
 setKind(k||(KINDS.includes(store.get())?store.get():'all'),{remember:!!k});
 if(st.loaded)refresh();else first();
 schedule();
}
function init(){
 const sec=$('work');if(!sec)return;
 sec.querySelectorAll('[data-work-kind]').forEach(b=>b.addEventListener('click',()=>setKind(b.dataset.workKind)));
 $('workSearch').addEventListener('input',e=>{st.query=e.target.value;if(st.loaded)paint()});
 $('workMore').addEventListener('click',more);
 $('workOpenAgentWorld')?.addEventListener('click',()=>window.showView?.('agents'));
 setKind(KINDS.includes(store.get())?store.get():'all',{mirror:false,remember:false});
 let was=active();
 new MutationObserver(()=>{const now=active();if(now&&!was)activate();was=now}).observe(sec,{attributes:true,attributeFilter:['class']});
 // #agents while Work is already open, or Back to another #work?kind=…: the router has settled the hash by the next turn.
 window.addEventListener('hashchange',()=>setTimeout(()=>{const k=active()&&fromHash();if(k&&k!==st.kind)setKind(k,{mirror:false})},0));
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&active()&&st.loaded)refresh().then(schedule)});
 if(was)activate();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
