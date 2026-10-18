// Home: what needs you, your latest threads, and a composer. Send opens the work where you are (a run view).
// app.js lends the old pages through window.LocalAILegacy until Chat, Images and Missions start runs themselves.
(function(root){'use strict';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MODES=[['auto','Auto','Picks for you'],['ask','Chat','Ask a question'],['research','Research','Search the web first'],['create','Image','Make pictures'],['mission','Mission','Give the team a goal'],['automate','Automate','Set up a task'],['engineering','Change Local AI','Always asks you first']];
const LABEL=Object.fromEntries(MODES.map(m=>[m[0],m[1]]));
const MODE_KEY='localai.home.mode',OPT_KEY='localai.home.options';
const store={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}}};
let mode=LABEL[store.get(MODE_KEY)]?store.get(MODE_KEY):'auto',options={},sending=false,flash=0,attention=[],timer=0,loaded=false;
try{options=JSON.parse(store.get(OPT_KEY)||'{}')||{}}catch{}
const active=()=>$('home')?.classList.contains('active');
// With developer tools off, changing Local AI is not offered: a remembered or routed 'engineering' means Auto / Chat.
const devOn=()=>!document.body.classList.contains('dev-tools-off');
const allowed=m=>m!=='engineering'||devOn();

// ---- the mode chip and its sheet ----
const cur=()=>allowed(mode)?mode:'auto';
function paintChip(text){const c=$('homeModeChip');if(!c)return;const t=text||LABEL[cur()]+' ▾';c.textContent=t;c.setAttribute('aria-label',`Mode: ${LABEL[cur()]}. Change mode`)}
let syncing=false;
function setMode(m,{persist=true}={}){
 if(!LABEL[m]||!allowed(m))return;
 mode=m;if(persist)store.set(MODE_KEY,m);
 clearTimeout(flash);paintChip();
 if(syncing)return;syncing=true; // keep the hidden buttons (state.mode, the gate, first-run samples) in step
 try{const b=document.querySelector(`.mode[data-mode="${m}"]`);if(b&&!b.classList.contains('active'))b.click()}finally{syncing=false}
}
function saveOptions(){store.set(OPT_KEY,JSON.stringify(options))}
const cache={};
async function once(key,url){if(!cache[key])cache[key]=root.LocalAIUI.fetchJson(url,{cache:'no-store'}).catch(e=>{delete cache[key];throw e});return cache[key]}
const field=(id,label,opts,value)=>`<label class="ask-sheet__field" for="${id}"><span>${esc(label)}</span><select id="${id}">${opts.map(o=>`<option value="${esc(o.value)}"${o.value===value?' selected':''}>${esc(o.label)}</option>`).join('')}</select></label>`;
async function paintOptions(){
 const box=$('homeModeOptions');if(!box)return;const m=mode;
 box.innerHTML='';box.hidden=!['ask','research','create','mission'].includes(m);if(box.hidden)return;
 box.innerHTML='<p class="home-sheet__note" role="status">Loading options…</p>';
 try{
  if(m==='ask'||m==='research'){
   const j=await once('models','/api/models');if(mode!==m)return;
   const list=(j.models||[]).map(x=>typeof x==='string'?x:x.name||x.id).filter(Boolean),cur=options.model&&list.includes(options.model)?options.model:j.default||list[0]||'';
   box.innerHTML=list.length?field('homeOptModel','Model',list.map(v=>({value:v,label:v})),cur):'<p class="home-sheet__note">No models are installed yet.</p>';
   $('homeOptModel')?.addEventListener('change',e=>{options.model=e.target.value;saveOptions()});
  }else if(m==='create'){
   const j=await once('images','/api/images/models');if(mode!==m)return;
   // Mirror what the Images page has selected right now; its buttons are the source of truth once that page has drawn.
   const pick=(sel,attr)=>document.querySelector(`${sel} .active[${attr}]`)?.getAttribute(attr);
   const engines=(j.engines||[]).map(e=>({value:e.id,label:e.label})),shapes=(j.aspects||[]).map(a=>({value:a.id,label:a.label})),styles=(j.styles||[]).map(s=>({value:s.id,label:s.label}));
   const val=(k,list,live,def)=>{const v=live||options[k]||def;return list.some(o=>o.value===v)?v:list[0]?.value};
   const cur={engine:val('engine',engines,pick('#imageEngines','data-engine'),j.defaultEngine),aspect:val('aspect',shapes,pick('#imageAspects','data-aspect'),'square'),style:val('style',styles,pick('#imageStyles','data-style'),'none')};
   box.innerHTML=(engines.length?field('homeOptEngine','Engine',engines,cur.engine):'<p class="home-sheet__note">No image models found. Check Health.</p>')+(shapes.length?field('homeOptShape','Shape',shapes,cur.aspect):'')+(styles.length?field('homeOptStyle','Style',styles,cur.style):'');
   for(const [id,key,sel,attr] of [['homeOptEngine','engine','#imageEngines','data-engine'],['homeOptShape','aspect','#imageAspects','data-aspect'],['homeOptStyle','style','#imageStyles','data-style']])
    $(id)?.addEventListener('change',e=>{options[key]=e.target.value;saveOptions();document.querySelector(`${sel} [${attr}="${CSS.escape(e.target.value)}"]`)?.click()});
   Object.assign(options,Object.fromEntries(Object.entries(cur).filter(([,v])=>v)));
  }else if(m==='mission'){
   const j=await once('agents','/api/agents/catalog');if(mode!==m)return;
   const list=(j.items||[]).filter(a=>!a.infrastructure),chosen=new Set(options.agentIds||[]);
   const web=`<label class="home-check" for="homeMissionWeb"><input type="checkbox" id="homeMissionWeb" data-home-web${options.missionWeb?' checked':''}><span>Let specialists search the web</span></label><p class="home-sheet__note">Searches leave this machine. Off by default.</p>`;
   box.innerHTML=(list.length?`<fieldset class="home-sheet__group"><legend>Specialists</legend><p class="home-sheet__note">Leave all unchecked and the team is picked for you.</p>${list.map((a,i)=>`<label class="home-check" for="homeAgent${i}"><input type="checkbox" id="homeAgent${i}" data-home-agent value="${esc(a.id)}"${chosen.has(a.id)?' checked':''}><span>${esc(a.name||a.id)}</span></label>`).join('')}</fieldset>`:'<p class="home-sheet__note">No specialists are listed yet.</p>')+web;
   box.onchange=()=>{options.agentIds=[...box.querySelectorAll('[data-home-agent]:checked')].map(x=>x.value);options.missionWeb=!!box.querySelector('[data-home-web]')?.checked;saveOptions()};
  }
 }catch(e){if(mode===m)box.innerHTML=`<p class="home-sheet__note">Couldn't load the options (${esc(e.message)}). The usual choices are used.</p>`}
}
function sheet(){
 let d=$('homeModeSheet');if(d)return d;
 d=document.createElement('dialog');d.id='homeModeSheet';d.className='ask-sheet home-sheet';d.setAttribute('aria-labelledby','homeModeTitle');
 d.innerHTML='<form method="dialog" class="ask-sheet__form"><h2 class="ask-sheet__title" id="homeModeTitle">What kind of work?</h2><div class="home-modes" role="radiogroup" aria-labelledby="homeModeTitle"></div><div id="homeModeOptions" class="home-sheet__options" hidden></div><div class="ask-sheet__actions"><button type="submit" class="btn-primary home-sheet__done">Done</button></div></form>';
 d.addEventListener('click',e=>{if(e.target===d)d.close()});
 // A radio group: one Tab stop (the chosen mode); arrows, Home and End choose another, as radios do, without closing the sheet.
 d.querySelector('.home-modes').addEventListener('keydown',e=>{
  const all=[...d.querySelectorAll('[data-home-mode]:not([disabled])')],i=all.indexOf(e.target);if(i<0)return;
  const n=['ArrowDown','ArrowRight'].includes(e.key)?i+1:['ArrowUp','ArrowLeft'].includes(e.key)?i-1:e.key==='Home'?0:e.key==='End'?all.length-1:null;if(n===null)return;
  e.preventDefault();setMode(all[(n+all.length)%all.length].dataset.homeMode);paintModes();paintOptions();d.querySelector(`[data-home-mode="${cur()}"]`)?.focus();
 });
 d.querySelector('.home-modes').addEventListener('click',e=>{
  const b=e.target.closest('[data-home-mode]');if(!b||b.disabled)return;e.preventDefault();
  setMode(b.dataset.homeMode);paintModes();paintOptions();
  if(!['ask','research','create','mission'].includes(mode))d.close();
 });
 document.body.appendChild(d);return d;
}
// One column of rows on the bottom edge: the current mode is the lowest row, nearest the thumb, with Auto and Chat just
// above it. The order is set as the sheet opens and stays put while it is open, so a row never moves under a finger.
let order=null;
const ordered=()=>{const c=cur();return [...MODES.filter(m=>allowed(m[0])&&m[0]!==c).reverse(),MODES.find(m=>m[0]===c)]};
function paintModes(){
 const box=sheet().querySelector('.home-modes');
 box.innerHTML=(order||ordered()).filter(m=>allowed(m[0])).map(([id,label,hint])=>{
  const gate=document.querySelector(`.mode[data-mode="${id}"]`),off=!!gate?.disabled,why=off?String(gate.title||'').replace(/^Unavailable:\s*/,''):'';
  return `<button type="button" role="radio" class="home-mode" data-home-mode="${id}" aria-checked="${id===cur()}" tabindex="${id===cur()?0:-1}"${off?' disabled':''}><b>${esc(label)}</b><span>${esc(off&&why?'Not available: '+why:hint)}</span></button>`}).join('');
}
function openSheet(){const d=sheet();if(d.open){paintModes();paintOptions();return}
 root.LocalAIUI.showSheet(d,reopened=>{order=null;if(reopened)return;const c=$('homeModeChip');if(c&&c.isConnected)c.focus()});
 order=ordered();paintModes();paintOptions();d.scrollTop=d.scrollHeight;d.querySelector('[data-home-mode][aria-checked="true"]')?.focus()}

// ---- Needs you and Recent ----
// The runs module opens the run on top of Home, so Back returns here.
const openRun=it=>root.LocalAIRuns?root.LocalAIRuns.show(it.id):root.LocalAIRouter?.go('#run/'+encodeURIComponent(it.id));
function infoRow(title,sub,label,tone,go){
 const kit=root.LocalAIKit,row=document.createElement('button');
 row.type='button';row.className='list-row home-attn';
 row.innerHTML=`<span class="list-row__icon">${kit?kit.icon('system'):''}</span><span class="list-row__main"><span class="list-row__title">${esc(title)}</span><span class="list-row__sub">${esc(sub)}</span></span><span class="list-row__trail"><span class="badge badge--${tone}">${esc(label)}</span></span>`;
 row.addEventListener('click',go);
 return row;
}
const attentionRow=a=>infoRow(a.title,a.detail,'Fix','bad',()=>root.LocalAIRouter.open(a.view||'status'));
// A pending approval that is not itself a run: open its run when one exists, else decide it here in the approval sheet
// (one queue, D8). After a decision Needs you reloads and focus moves to the next approval, or the one before, or the next
// thing on Home.
function approvalRow(a,run){
 const row=infoRow(String(a.title||'').replace(/\s+chg-\d+-[0-9a-f]+$/,'')||'Approval needed',a.detail||'Waiting for your decision','Review','attention',()=>run?openRun(run):decideHere(a));
 row.dataset.approvalId=a.id;return row;
}
async function decideHere(a){
 const ids=approvals.map(x=>x.a.id),i=ids.indexOf(a.id),next=ids[i+1],prev=i>0?ids[i-1]:null;
 if(!await root.LocalAIUI.approvalSheet(a))return;
 await loadNeeds();
 const sec=$('homeNeedsYou'),first=sec&&!sec.hidden?$('homeNeedsList')?.querySelector('button'):null;
 root.LocalAIUI.refocus(a.id,{within:'#homeNeedsList',key:'approvalId',next,prev,fallback:first||$('homeRecentTitle')});
}
let needs=[],approvals=[],newSignals=0;
// Another device on plain HTTP can't use voice, notifications or Add to Home Screen; point it at the setup until it opts out there.
const onPlainHttp=()=>location.protocol==='http:'&&!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const secureNudge=()=>{if(!onPlainHttp())return false;try{return localStorage.getItem('localai.secureNudge.off')!=='1'}catch{return true}};
const secureRow=()=>infoRow('Use the secure address on this device','Voice, notifications and adding Local AI to your Home Screen need it. Setup takes about a minute.','Set up','attention',()=>root.LocalAIRouter.open('status?secure=1'));
// Serious Signals promoted into the Backlog in the last day, waiting for a decision.
const signalsRow=n=>infoRow(`${n} new signal${n===1?'':'s'} in your backlog`,'Problems Local AI noticed. Start, defer or reject them.','Review','attention',()=>root.LocalAIRouter.open('backlog'));
// What asks for a decision, a fix or a setup step always shows. Failures fill the list up to CAP rows, newest first, one
// row per goal ("Failed ×5"); the rest are behind "See all N", which opens Work's Needs you filter.
const CAP=3;
function seeAllRow(n){
 const row=document.createElement('button');row.type='button';row.className='list-row home-attn home-needs-all';
 row.innerHTML=`<span class="list-row__main"><span class="list-row__title">See all ${n}</span></span><span class="list-row__trail" aria-hidden="true">›</span>`;
 row.setAttribute('aria-label',`See all ${n} in Work`);
 row.addEventListener('click',()=>root.LocalAIRouter?.go('#work?kind=needs'));
 return row;
}
// Opening a failure marks it (and the repeats on its row) seen on the server: it leaves Needs you on every device. The row
// goes once the run view closes, so nothing moves under the open run.
let stale=false;
function failedRow(g){
 const n=g.runs.length,it=n>1&&g.run.card?{...g.run,card:{...g.run.card,badge:{tone:'bad',...g.run.card?.badge,label:`Failed ×${n}`}}}:g.run;
 const row=recentRow(it,r=>{const ids=new Set(g.runs.map(x=>x.id));root.LocalAINeedsYou.markSeen([...ids]);needs=needs.filter(x=>!ids.has(x.id));stale=true;openRun(r)});
 if(n>1)row.dataset.needsCount=n;
 return row;
}
function paintNeeds(){
 const box=$('homeNeedsList'),sec=$('homeNeedsYou');if(!box||!sec)return;
 stale=false;
 // While Get started is on the page its step 1 already covers stopped services; the same news is not repeated as "Fix" rows.
 const serviceRows=document.getElementById('firstRun')?[]:attention.map(attentionRow);
 const failed=root.LocalAINeedsYou.group(needs.filter(r=>r.status==='failed'));
 const act=[...needs.filter(r=>r.status!=='failed').map(r=>recentRow(r)),...approvals.map(x=>approvalRow(x.a,x.run)),...serviceRows,...(newSignals?[signalsRow(newSignals)]:[]),...(secureNudge()?[secureRow()]:[])];
 const n=act.length+failed.length,room=act.length+failed.length>CAP?Math.max(0,CAP-act.length):failed.length;
 box.replaceChildren(...act,...failed.slice(0,room).map(failedRow),...(room<failed.length?[seeAllRow(n)]:[]));
 $('homeNeedsCount').textContent=n?'· '+n:'';
 sec.hidden=!n;
}
function recentRow(it,onOpen=openRun){
 // A conversation shows once, under its first message, with its turn count (as Work does).
 const n=it.turns||1;if(it.card?.kind==='chat'&&n>1)it={...it,card:{...it.card,summary:`Chat · ${n} turns`,preview:it.card.preview||(it.card.summary?{type:'text',text:it.card.summary}:null)}};
 const row=root.LocalAIUI.runCard(it,{onOpen,rowOpen:true}),act=row.querySelector('.run-card__action');
 if(act)act.remove(); // the row itself opens the run
 if(it.status==='awaiting_approval')row.querySelector('.run-card__bar')?.remove(); // waiting on you is not progress
 return row;
}
// ---- Printer: one calm line while a print runs or stops with an error (Workshop display's read-only token) ----
// The appliance polls the display; ?part=printer answers from its last read, so Home never sends the display anything.
// Nothing shows when the printer is idle or unknown, or when no token is set (printer: null).
const span=m=>m<60?`${m} min`:`${Math.floor(m/60)} h${m%60?` ${m%60} min`:''}`;
function printerWords(p){
 if(!p||p.access!=='ok')return '';
 const pct=Number.isInteger(p.progress)?`${p.progress}%`:null,left=Number.isInteger(p.minutesLeft)?`${span(p.minutesLeft)} left`:null;
 if(p.state==='printing')return ['Printer',pct||'Printing',left].filter(Boolean).join(' · ');
 if(p.state==='paused')return ['Printer','Paused',pct].filter(Boolean).join(' · ');
 if(p.state==='error')return `Printer · Stopped with an error${p.errorCode?` (${p.errorCode})`:''}`;
 return '';
}
function paintPrinter(p){
 const sec=$('homePrinter'),box=$('homePrinterLine');if(!sec||!box)return;
 const words=printerWords(p);sec.hidden=!words;if(!words){box.replaceChildren();return}
 const kit=root.LocalAIKit,row=document.createElement('button');
 row.type='button';row.className='list-row home-attn';row.dataset.printerState=p.state;
 row.innerHTML=`<span class="list-row__icon">${kit?kit.icon(p.state==='error'?'alert':'clock'):''}</span><span class="list-row__main"><span class="list-row__title">${esc(words)}</span></span>`;
 row.setAttribute('aria-label',`${words}. Open Workshop display in Services`);
 row.addEventListener('click',()=>root.LocalAIRouter.open('integrations?card=workshop'));
 box.replaceChildren(row);
}
const loadPrinter=()=>root.LocalAIUI.fetchJson('/api/workshop/status?part=printer',{cache:'no-store'}).then(d=>paintPrinter(d?.printer),()=>{});
// Recent leaves out what Needs you already shows (the same run, or another card for the same thread): one row per thing.
let lastRecent=null;
const threadKey=r=>r.threadId||r.id;
function paintRecent(box,data){
 lastRecent={box,data};
 const shown=new Set(needs.map(threadKey)),all=(data.items||[]).slice(0,6),items=all.filter(r=>!shown.has(threadKey(r)));
 if(!all.length)return false;
 if(!items.length){box.innerHTML='<div class="state-empty empty-state">Everything recent is in Needs you, above.</div>';return true}
 box.replaceChildren(...items.map(r=>recentRow(r)));
 return true;
}
const recentUrl='/api/runs?threads=1&limit=6';
async function loadNeeds(){
 const [d,p,imp]=await Promise.allSettled([root.LocalAIUI.fetchJson('/api/runs?limit=120',{cache:'no-store'}),root.LocalAIUI.fetchJson('/api/approvals',{cache:'no-store'}),devOn()?root.LocalAIUI.fetchJson('/api/improve/items',{cache:'no-store'}):Promise.resolve({items:[]})]);
 if(imp.status==='fulfilled'){const day=Date.now()-864e5;newSignals=(imp.value.items||[]).filter(i=>i.source==='signal'&&i.status==='proposed'&&i.stage==='backlog'&&Date.parse(i.createdAt)>day).length}
 const runs=d.status==='fulfilled'?d.value.items||[]:null;
 if(runs)needs=root.LocalAINeedsYou.pick(runs);
 if(p.status==='fulfilled'){
  const waiting=new Set(needs.filter(r=>r.status==='awaiting_approval').map(r=>r.meta?.changeId).filter(Boolean));
  approvals=(p.value.items||[]).filter(a=>a.status==='pending'&&!(a.meta?.changeId&&waiting.has(a.meta.changeId)))
   .map(a=>({a,run:a.meta?.changeId&&(runs||[]).find(r=>r.meta?.changeId===a.meta.changeId)||null}));
 }
 paintNeeds();
 if(lastRecent?.box.isConnected&&!lastRecent.box.querySelector(':scope > .state-loading,:scope > .state-error'))paintRecent(lastRecent.box,lastRecent.data); // Recent may have painted before Needs you knew its rows
}
let inflight=null;
function refresh(){
 if(inflight)return inflight;
 if(!active()||!onHomeHash())return Promise.resolve();
 const box=$('homeRecent2');if(!box)return Promise.resolve();
 const first=!loaded;
 const recent=first?root.LocalAIUI.loadInto(box,()=>root.LocalAIUI.fetchJson(recentUrl,{cache:'no-store'}),{what:'your recent work',empty:'Nothing yet. Ask a question or make an image below.',render:paintRecent}).then(()=>{loaded=true},()=>{})
  :root.LocalAIUI.fetchJson(recentUrl,{cache:'no-store'}).then(d=>{if(!paintRecent(box,d))box.innerHTML='<div class="state-empty empty-state">Nothing yet. Ask a question or make an image below.</div>'}).catch(()=>{});
 return inflight=Promise.all([recent,loadNeeds(),loadPrinter()]).finally(()=>{inflight=null});
}
function schedule(){clearTimeout(timer);timer=setTimeout(()=>{if(active()&&!document.hidden)refresh().then(schedule);else schedule()},30000)}

// ---- greeting ----
function greet(){const h=new Date().getHours(),g=$('homeGreeting');if(g)g.textContent=h<5?'Still up?':h<12?'Good morning':h<18?'Good afternoon':'Good evening'}

// ---- send ----
function setError(msg){const e=$('homeComposerError');if(!e)return;e.textContent=msg||'';e.hidden=!msg}
function busy(on){sending=on;const b=$('commandGo');if(b)b.disabled=on}
const grow=()=>{const t=$('commandInput');if(!t)return;t.style.height='auto';t.style.height=Math.min(t.scrollHeight,140)+'px'};
function clearInput(){const t=$('commandInput');if(t){t.value='';grow()}}
function gateCheck(intent){
 const b=document.querySelector(`.mode[data-mode="${intent}"]`);
 if(b?.disabled)throw new Error(String(b.title||'').replace(/^Unavailable:\s*/,'')||'That is not available right now.');
}
const titleOf=t=>String(t).replace(/\s+/g,' ').trim().slice(0,80);
// Start a run through the page that owns it. The run view opens first ("Starting…"), then the starter fills it in.
async function viaStarter(name,intent,text,extra){
 const S=root[name];
 const L=root.LocalAILegacy;
 if(!S||typeof S.start!=='function'){L.open(intent,text);clearInput();return}
 // Try again in the run view sends the same text the same way.
 const pending=root.LocalAIRuns.openPending({kind:intent,title:titleOf(text),retry:()=>send(text,intent)});
 clearInput();
 try{await S.start(text,{...extra,pending})}catch(e){pending.fail(e.message);throw e}
}
async function dispatch(intent,text,route){
 gateCheck(intent);
 const L=root.LocalAILegacy;
 if(intent==='engineering'&&root.LocalAIImprove?.openIdea){
  // Change Local AI asks each time: Add to backlog, or Start now and follow it in In progress. Closing the sheet keeps the text.
  const r=await root.LocalAIImprove.openIdea(text,{from:'home'});if(!r)return;
  clearInput();if(r.start&&!r.error)root.LocalAIRouter.open('inProgress');
 }else if(intent==='engineering'){
  const request=L.engineeringRequest(text,route);
  const r=await fetch('/api/engineering/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request,target:'self',root:'app',maxAttempts:3})});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);
  if(!data.run?.id)throw new Error('The change did not start. Try again.');
  openRun({id:'legacy-engineering:'+data.run.id});clearInput();
 }else if(intent==='ask'||intent==='research')await viaStarter('LocalAIChat',intent,text,{research:intent==='research',model:options.model});
 else if(intent==='create')await viaStarter('LocalAIImages','create',text,{engine:options.engine,aspect:options.aspect,style:options.style});
 else if(intent==='mission')await viaStarter('LocalAIMissions','mission',text,{agentIds:options.agentIds?.length?options.agentIds:undefined,webSearch:options.missionWeb===true});else if(intent==='automate'){L.open('automate',text);clearInput()}
 else throw new Error('Choose a mode and try again.');
}
let autoWait=null;
function waitAuto(ms){return new Promise(res=>{const t=setTimeout(()=>{autoWait=null;res(true)},ms);autoWait={cancel:()=>{clearTimeout(t);autoWait=null;res(false)}}})}
// A mission (or, with developer tools off, a chat) asking to change Local AI itself: offer Claude Code first, once.
// Either answer is one tap; the text stays in the box until it is handed over or sent.
function offerClaude(text,intent){
 const SC=root.LocalAISelfChange,box=$('homeSelfChange');if(!SC||!box)return false;
 SC.offer(box,{text,from:'home',anywayLabel:intent==='mission'?'Start a mission anyway':'Ask anyway',anyway:()=>send(text,intent,{anyway:true}),onHanded:clearInput});
 return true;
}
async function send(text,m=cur(),{anyway=false}={}){
 text=String(text??'').trim();
 if(!text||sending)return;
 const input=$('commandInput');busy(true);setError('');root.LocalAISelfChange?.hide($('homeSelfChange'));
 try{
  let intent=m,route=null;
  if(m==='auto'){
   route=await root.LocalAILegacy.resolveIntentRequest(text,'auto');intent=route.intent||'ask';if(!allowed(intent))intent='ask'; // Auto never starts a change with developer tools off: Chat answers instead
   paintChip('→ '+(LABEL[intent]||intent));clearTimeout(flash);flash=setTimeout(()=>paintChip(),1500);
   // A tap on the chip within the window changes the mode instead: nothing starts and the text stays.
   if(!await waitAuto(1500)){setMode(LABEL[intent]?intent:'ask');openSheet();return}
  }
  if(!anyway&&(intent==='mission'&&root.LocalAISelfChange?.isSelfChange(text)||intent==='ask'&&route?.intent==='engineering')&&offerClaude(text,intent))return;
  await dispatch(intent,text,route);
 }catch(e){
  if(input&&!input.value){input.value=text;grow()} // the text stays so nothing is lost
  setError(e.message||'Something went wrong. Try again.');
 }finally{busy(false)}
}

// ---- wiring ----
function fromHash(){const R=root.LocalAIRouter;if(!R)return;const cur=R.current(),m=cur.query.get('mode')||R.intentFor(cur.page).mode;if(m&&LABEL[m])setMode(m)}
function onHomeHash(){const p=root.LocalAIRouter?.current().page;return !p||p==='home'||root.LocalAIViews?.resolve(p)==='home'}
function activate(){fromHash();greet();if(root.LocalAIUI)refresh().then(schedule)}
function dockToNav(){
 // On phones the composer sits exactly on the tab bar, whatever its height is. While the owner types, the tab bar
 // steps aside (body.home-typing, see app.css) and the composer sits on the keyboard: iOS keeps innerHeight and only
 // shrinks visualViewport, so the keyboard is innerHeight - vv.height - vv.offsetTop (as the run view's reply box does).
 const c=$('homeComposer'),n=$('uxMobileNav');if(!c)return;
 const typing=document.body.classList.contains('home-typing');
 const phone=matchMedia('(max-width:760px)').matches&&n&&(typing||getComputedStyle(n).display!=='none');
 if(!phone){c.style.removeProperty('--home-dock');document.documentElement.style.removeProperty('--home-pad');return}
 const vv=root.visualViewport,keyboard=vv?Math.round(innerHeight-vv.height-vv.offsetTop):0;
 const dock=keyboard>0?keyboard+'px':typing?'env(safe-area-inset-bottom)':Math.round(innerHeight-n.getBoundingClientRect().top)+'px';
 c.style.setProperty('--home-dock',dock);
 document.documentElement.style.setProperty('--home-pad',Math.ceil(c.getBoundingClientRect().height)+'px');
}
function typing(on){document.body.classList.toggle('home-typing',on);dockToNav()}
function init(){
 if(!$('homeComposer'))return;
 paintChip();greet();
 new MutationObserver(()=>{paintChip();if(stale&&!document.body.classList.contains('run-view-open'))paintNeeds()}).observe(document.body,{attributes:true,attributeFilter:['class']}); // developer tools toggled; a run view closed
 $('homeModeChip').addEventListener('click',()=>autoWait?autoWait.cancel():openSheet());
 $('commandGo').addEventListener('click',()=>send($('commandInput').value));
 $('commandInput').addEventListener('input',()=>{grow();dockToNav();root.LocalAISelfChange?.hide($('homeSelfChange'))});
 $('commandInput').addEventListener('focus',()=>typing(true));
 $('commandInput').addEventListener('blur',()=>typing(false));
 $('homeSeeAll').addEventListener('click',()=>root.LocalAIRouter?.go('#work'));
 document.addEventListener('click',e=>{const b=e.target.closest?.('.mode[data-mode]');if(b&&!syncing)setMode(b.dataset.mode)});
 addEventListener('resize',dockToNav,{passive:true});
 if(root.visualViewport){root.visualViewport.addEventListener('resize',dockToNav,{passive:true});root.visualViewport.addEventListener('scroll',dockToNav,{passive:true})}
 if(root.ResizeObserver)new ResizeObserver(dockToNav).observe($('homeComposer'));
 // The tab bar is built after this script; look again once it exists.
 let tries=0;(function wait(){if($('uxMobileNav')){dockToNav();if(root.ResizeObserver)new ResizeObserver(dockToNav).observe($('uxMobileNav'))}else if(tries++<40)setTimeout(wait,100)})();
 new MutationObserver(()=>{if(active())activate();else if(document.body.classList.contains('home-typing'))typing(false)}).observe($('home'),{attributes:true,attributeFilter:['class']}); // leaving Home brings the tab bar back even if no blur fired
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&active())refresh().then(schedule)});
 // Home is on screen before the router has read the hash; a link to another page should not make Home load.
 if(active()&&onHomeHash())setTimeout(activate,0);
}
addEventListener('localai:first-run',paintNeeds); // Get started appeared or was dismissed: decide again who shows the service rows
root.LocalAIHome={send,activate,refresh,mode:()=>cur(),setMode,printerWords,
 // ui.js hands over the critical items of the capability check (a stopped service, an unreachable registry).
 setAttention(items){attention=(items||[]).filter(a=>a&&a.severity==='critical');paintNeeds()}};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
