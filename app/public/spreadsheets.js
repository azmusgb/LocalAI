// Projects › Spreadsheets: see the workbook open in GridCraft on the Windows computer, ask for it to be read or changed,
// and keep or discard what a Review request changed. The appliance proxies the host bridge (/api/gridcraft), so the
// bridge port never has to be open to the network. One request at a time.
(function(root){'use strict';
const $=id=>document.getElementById(id),API='/api/gridcraft';
const EXAMPLES=[
 'Summarize the sheets in the workbook and what each one holds.',
 'What is the total of the Sales column? Do not change anything.',
 'Check the workbook for empty cells or errors in formulas and tell me where they are.'
];
const MODES={read:'Looks and answers. It cannot change anything.',review:'Makes the changes in GridCraft without saving. You keep or discard them.',apply:'Makes the changes and saves the workbook.'};
const STATUS={review:'Waiting for review',kept:'Kept',discarded:'Discarded',applied:'Applied',done:'No changes',failed:'Failed'};
const PAGE=100;
const st={busy:false,timer:0,started:0,mode:'review',book:null,sheet:'',top:1,runs:[],run:null,sel:null,formulas:false,books:[]};
const active=()=>$('spreadsheets')?.classList.contains('active');
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const show1=v=>v==null?'':typeof v==='object'?(v.error||JSON.stringify(v)):String(v);
const col=n=>{let s='';while(n>0){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=(n-r-1)/26}return s};
const num=c=>[...c.toUpperCase()].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0);
function bounds(rng){const m=/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(String(rng||''));if(!m)return null;return{r1:+m[2],c1:num(m[1]),r2:+(m[4]||m[2]),c2:num(m[3]||m[1])}}
const store={get(k){try{return localStorage.getItem(k)}catch{return null}},set(k,v){try{localStorage.setItem(k,v)}catch{}}};

function setStatus(state,text){const s=$('sheetsStatus');s.dataset.state=state;s.querySelector('span:last-child').textContent=text}
async function health(){
 setStatus('checking','Checking…');
 try{
  const r=await fetch(`${API}/health`,{cache:'no-store',signal:AbortSignal.timeout(8000)}),data=await r.json();
  if(!r.ok||!data.ok)throw new Error(data.error||`HTTP ${r.status}`);
  setStatus(data.gridcraftConnected?'ready':'checking',data.gridcraftConnected?'Ready':'Starting GridCraft…');
  return true;
 }catch{setStatus('down','Windows computer not answering');return false}
}

// ---- Mode ----
function setMode(m){
 st.mode=MODES[m]?m:'review';store.set('sheets.mode',st.mode);
 $('sheetsMode').querySelectorAll('[data-mode]').forEach(b=>{const on=b.dataset.mode===st.mode;b.classList.toggle('active',on);b.setAttribute('aria-checked',on);b.tabIndex=on?0:-1});
 $('sheetsModeHint').textContent=MODES[st.mode];
}

// ---- Changes: cell edits of the shown run, by "Sheet!A1" ----
function changedCells(run){
 const out=new Map();if(!run)return out;
 for(const e of run.edits||[]){const b=bounds(e.range);if(!b||!e.after)continue;
  for(let r=b.r1;r<=b.r2;r++)for(let c=b.c1;c<=b.c2;c++)out.set(`${e.sheet}!${col(c)}${r}`,{before:e.before?.[r-b.r1]?.[c-b.c1],after:e.after?.[r-b.r1]?.[c-b.c1],status:run.status})}
 return out;
}
function changesHtml(run){
 const bySheet={};
 for(const e of run.edits||[])(bySheet[e.sheet||'Sheet']??=[]).push(e);
 let html='';
 for(const [sheet,edits] of Object.entries(bySheet)){
  html+=`<h3>${esc(sheet)}</h3>`;
  for(const e of edits){
   const b=bounds(e.range);
   if(!b||e.truncated||!e.after){html+=`<p class="sheets-change__line">${esc(e.range)} changed (too large to list here).</p>`;continue}
   let rows='';
   for(let r=b.r1;r<=b.r2;r++)for(let c=b.c1;c<=b.c2;c++){
    const before=show1(e.before?.[r-b.r1]?.[c-b.c1]),after=show1(e.after?.[r-b.r1]?.[c-b.c1]);
    if(before===after)continue;
    rows+=`<tr><th scope="row"><button type="button" class="sheets-goto" data-sheet="${esc(e.sheet)}" data-cell="${col(c)}${r}">${col(c)}${r}</button></th><td class="sheets-diff__old">${before?esc(before):'<span class="meta">empty</span>'}</td><td class="sheets-diff__new">${after?esc(after):'<span class="meta">empty</span>'}</td></tr>`;
   }
   if(rows)html+=`<table class="sheets-diff"><thead><tr><th scope="col">Cell</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
 }
 for(const c of run.changes||[])html+=`<p class="sheets-change__line">${esc(c.summary)}${c.sheet?` <span class="meta">(${esc(c.sheet)})</span>`:''}</p>`;
 return html?`<h2>What changed</h2>${html}`:'';
}

// ---- Result panel ----
function show(kind,text,{retry=false}={}){
 const out=$('sheetsResult');out.hidden=false;out.dataset.kind=kind;
 $('sheetsResultText').textContent=text;$('sheetsRetry').hidden=!retry;
}
function showRun(run){
 st.run=run;
 if(!run){$('sheetsChanges').hidden=true;$('sheetsReview').hidden=true;$('sheetsRun').classList.add('btn-primary');$('sheetsRun').classList.remove('btn-outline');return}
 $('sheetsResultTitle').textContent=run.prompt?`“${run.prompt.length>90?run.prompt.slice(0,90)+'…':run.prompt}”`:'Answer';
 show(run.status==='failed'?'error':'done',run.answer||run.error||'Done.',{retry:run.status==='failed'});
 $('sheetsResult').dataset.status=run.status;
 const changes=changesHtml(run);$('sheetsChanges').innerHTML=changes;$('sheetsChanges').hidden=!changes;
 const review=run.status==='review',latest=st.runs[0]?.id===run.id;
 $('sheetsReview').hidden=!review;$('sheetsDiscard').hidden=!latest;
 // One blue action per page: while a request waits for review, deciding is the next step, not another run.
 $('sheetsRun').classList.toggle('btn-primary',!review);$('sheetsRun').classList.toggle('btn-outline',review);
 $('sheetsReviewNote').textContent=review?(latest?'These changes are in GridCraft but not saved yet.':'Only the latest request can be undone. Keep changes saves everything in the workbook.'):'';
 renderHistory();renderGrid();
}

// ---- History ----
function renderHistory(){
 const list=$('sheetsHistory');
 if(!st.runs.length){list.innerHTML='<p class="meta">Requests you run appear here, with what each one changed.</p>';return}
 list.innerHTML=st.runs.slice(0,15).map(r=>{const n=(r.edits||[]).length+(r.changes||[]).length;
  return `<button type="button" class="sheets-run${st.run?.id===r.id?' active':''}" data-run="${esc(r.id)}" aria-pressed="${st.run?.id===r.id}"><span class="sheets-run__prompt">${esc(r.prompt)}</span><span class="sheets-run__meta"><span class="sheets-badge" data-status="${esc(r.status)}">${esc(r.mode==='read'&&r.status==='done'?'Read only':STATUS[r.status]||r.status)}</span>${n?`<span>${n} change${n===1?'':'s'}</span>`:''}<time datetime="${esc(r.createdAt)}">${esc(new Date(r.createdAt).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))}</time></span></button>`}).join('');
}
async function loadRuns(){
 try{const r=await fetch(`${API}/runs`,{cache:'no-store'});if(!r.ok)return;st.runs=(await r.json()).items||[]}catch{return}
 const keep=st.run&&st.runs.find(x=>x.id===st.run.id);
 if(keep)showRun(keep);else if(st.runs[0]?.status==='review'&&!st.busy)showRun(st.runs[0]);else renderHistory();
}

// ---- Workbook ----
function emptyGrid(text){$('sheetsGrid').innerHTML='';$('sheetsGridEmpty').hidden=false;$('sheetsGridEmpty').textContent=text;$('sheetsPager').hidden=true}
async function loadBook(sheet=st.sheet,top=st.top){
 const q=new URLSearchParams();
 if(sheet)q.set('sheet',sheet);
 const used=st.book?.sheets?.find(s=>s.name===sheet)?.usedRange,u=bounds(used);
 if(u&&top>1)q.set('range',`A${top}:${col(Math.min(u.c2,40))}${Math.min(u.r2,top+PAGE-1)}`);
 if(!st.book)emptyGrid('Opening the workbook…');
 try{
  const r=await fetch(`${API}/workbook?${q}`,{cache:'no-store',signal:AbortSignal.timeout(70000)}),data=await r.json();
  if(!r.ok||!data.ok)throw new Error(data.error||`HTTP ${r.status}`);
  st.book=data;st.sheet=data.sheet||'';st.top=bounds(data.range)?.r1||1;
 }catch(e){
  if(!st.book)emptyGrid(`The workbook can't be shown: ${e.message||e}. Check that GridCraft is open on the Windows computer, then choose Refresh.`);
  return;
 }
 renderBook();
}
function renderBook(){
 const b=st.book;if(!b)return;
 $('sheetsTitle').textContent=b.title||b.file||'Workbook';
 $('sheetsDirty').hidden=!b.dirty;
 renderBooks();
 $('sheetsTabs').innerHTML=(b.sheets||[]).map(s=>`<button type="button" role="tab" class="ux-tab${s.name===b.sheet?' active':''}" aria-selected="${s.name===b.sheet}" data-sheet="${esc(s.name)}">${esc(s.name)}</button>`).join('');
 renderGrid();
}
function renderGrid(){
 const b=st.book;if(!b)return;
 const range=bounds(b.range),grid=$('sheetsGrid');
 if(!range||!b.values?.length){emptyGrid(b.sheet?`${b.sheet} is empty.`:'This workbook has no sheets.');$('sheetsRange').textContent='';return}
 $('sheetsGridEmpty').hidden=true;
 const changed=changedCells(st.run),u=bounds(b.usedRange);
 let html='<thead><tr><th class="sheets-corner" aria-hidden="true"></th>';
 for(let c=range.c1;c<=range.c2;c++)html+=`<th scope="col">${col(c)}</th>`;
 html+='</tr></thead><tbody>';
 b.values.forEach((row,i)=>{const r=range.r1+i;html+=`<tr><th scope="row">${r}</th>`;
  row.forEach((v,j)=>{const c=range.c1+j,ref=`${col(c)}${r}`,f=b.formulas?.[i]?.[j],isF=typeof f==='string'&&f.startsWith('='),ch=changed.get(`${b.sheet}!${ref}`);
   const text=st.formulas&&isF?f:show1(v),cls=[isF&&'is-formula',typeof b.raw?.[i]?.[j]==='number'&&!(st.formulas&&isF)&&'is-num',v&&typeof v==='object'&&'is-error',ch&&(ch.status==='review'?'is-pending':ch.status==='discarded'?'is-discarded':'is-changed')].filter(Boolean).join(' ');
   const sel=st.sel===ref;
   html+=`<td role="gridcell" data-cell="${ref}" data-i="${i}" data-j="${j}"${cls?` class="${cls}"`:''} tabindex="${sel?0:-1}" aria-selected="${sel}">${esc(text)}</td>`});
  html+='</tr>'});
 grid.innerHTML=html+'</tbody>';
 if(!grid.querySelector('[tabindex="0"]'))grid.querySelector('td')?.setAttribute('tabindex','0');
 const total=u?u.r2:range.r2,cols=u?u.c2:range.c2;
 $('sheetsRange').textContent=`${b.sheet}, rows ${range.r1}–${range.r2} of ${total}${cols>range.c2?`, first ${range.c2} of ${cols} columns`:''}`;
 $('sheetsPager').hidden=!(range.r1>1||range.r2<total);
 $('sheetsPagerText').textContent=`Rows ${range.r1}–${range.r2} of ${total}`;
 $('sheetsPager').querySelector('[data-sheets-page="-1"]').disabled=range.r1<=1;
 $('sheetsPager').querySelector('[data-sheets-page="1"]').disabled=range.r2>=total;
 if(st.sel)showCell(st.sel,false);
}
function showCell(ref,focus=true){
 const b=st.book,td=$('sheetsGrid').querySelector(`td[data-cell="${ref}"]`);
 if(!b||!td){$('sheetsCell').hidden=true;return}
 st.sel=ref;
 $('sheetsGrid').querySelectorAll('td[aria-selected="true"]').forEach(x=>{x.setAttribute('aria-selected','false');x.tabIndex=-1});
 td.setAttribute('aria-selected','true');td.tabIndex=0;if(focus)td.focus({preventScroll:false});
 const i=+td.dataset.i,j=+td.dataset.j,f=b.formulas?.[i]?.[j],isF=typeof f==='string'&&f.startsWith('=');
 $('sheetsCell').hidden=false;
 $('sheetsCellRef').textContent=`${b.sheet}!${ref}`;
 $('sheetsCellValue').textContent=show1(b.values[i][j])||'Empty';
 $('sheetsCellFormula').hidden=!isF;$('sheetsCellFormula').textContent=isF?f:'';
 const ch=changedCells(st.run).get(`${b.sheet}!${ref}`);
 $('sheetsCellChange').hidden=!ch;
 if(ch)$('sheetsCellChange').textContent=`Changed by this request: ${show1(ch.before)||'empty'} → ${show1(ch.after)||'empty'}`;
}
async function goto(sheet,ref){
 const r=bounds(ref)?.r1||1;st.sel=ref;
 if(sheet!==st.sheet||r<st.top||r>=st.top+PAGE)await loadBook(sheet,Math.floor((r-1)/PAGE)*PAGE+1);
 showCell(ref);
 $('sheetsBook').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
}
function gridKeys(e){
 const td=e.target.closest('td[data-cell]');if(!td)return;
 const d={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]}[e.key];
 if(!d)return;e.preventDefault();
 const next=$('sheetsGrid').querySelector(`td[data-i="${+td.dataset.i+d[0]}"][data-j="${+td.dataset.j+d[1]}"]`);
 if(next)showCell(next.dataset.cell);
}

// ---- Workbook menu: the files in the GridCraft folder on the Windows computer ----
async function loadBooks(){
 try{const r=await fetch(`${API}/workbooks`,{cache:'no-store'}),data=await r.json();if(r.ok&&data.ok)st.books=data.items||[]}catch{/* the menu stays as it was */}
 renderBooks();
}
function renderBooks(){
 const sel=$('sheetsBooks'),cur=st.book?.file||'',names=st.books.map(x=>x.name);
 if(cur&&!names.includes(cur))names.unshift(cur);
 sel.innerHTML=names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('');
 sel.value=cur;sel.hidden=names.length<2; // nothing else to open
}
async function openBook(){
 const sel=$('sheetsBooks'),name=sel.value,cur=st.book?.file||'';
 if(!name||name===cur)return;
 if(st.book?.dirty){
  const effect=`${cur} has unsaved changes in GridCraft. Open ${name} anyway? The changes stay in GridCraft's undo history only until it's closed.`;
  const ask=root.LocalAIUI?.ask,ok=ask?(await ask({title:`Open ${name}?`,effect,confirmLabel:'Open anyway'})).ok:root.confirm(effect);
  if(!ok){sel.value=cur;return}
 }
 sel.disabled=true;$('sheetsRange').textContent=`Opening ${name}…`;
 try{
  const r=await fetch(`${API}/open`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data.ok)throw new Error(data.error||`HTTP ${r.status}`);
  st.book=null;st.sheet='';st.sel=null;st.top=1;$('sheetsCell').hidden=true;
  await loadBook();
  root.LocalAIUI?.toast?.(`Opened ${name}`);
 }catch(e){
  sel.value=cur;renderGrid();
  $('sheetsResultTitle').textContent=`${name} didn't open`;$('sheetsResult').dataset.status='';$('sheetsElapsed').textContent='';
  show('error',e.message||String(e));
 }finally{sel.disabled=false}
}

// ---- Run, keep, discard ----
function tick(){$('sheetsElapsed').textContent=`${Math.round((Date.now()-st.started)/1000)}s`}
async function run(){
 const text=$('sheetsPrompt').value.trim();
 if(!text||st.busy){if(!text)$('sheetsPrompt').focus();return}
 st.busy=true;st.started=Date.now();$('sheetsRun').disabled=true;$('sheetsRun').textContent='Working…';
 showRun(null);$('sheetsResultTitle').textContent='Answer';$('sheetsResult').dataset.status='';
 show('working','GridCraft is working on it. Larger requests can take a few minutes.');
 $('sheetsElapsed').textContent='0s';st.timer=setInterval(tick,1000);
 try{
  const r=await fetch(`${API}/run`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:text,mode:st.mode})});
  const data=await r.json().catch(()=>({ok:false,error:`HTTP ${r.status}`}));
  if(data.run){st.runs=[data.run,...st.runs.filter(x=>x.id!==data.run.id)];showRun(data.run)}
  if(!r.ok||!data.ok)throw new Error([data.error||`HTTP ${r.status}`,data.reason].filter(Boolean).join(': '));
  if(!data.run)show('done',data.answer||'Done.');
  if(active())$('sheetsResult').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}); // below the fold on a phone
 }catch(e){
  show('error',`That didn't work. ${e.message||e}`,{retry:true});
  health(); // one failed request doesn't mean GridCraft is down: show its real state
 }finally{
  clearInterval(st.timer);tick();st.busy=false;$('sheetsRun').disabled=false;$('sheetsRun').textContent='Run';
  if(st.mode!=='read'||!st.book)loadBook();
 }
}
async function decide(action){
 const run=st.run;if(!run)return;
 const btn=$(action==='keep'?'sheetsKeep':'sheetsDiscard');btn.disabled=true;
 $('sheetsReviewNote').textContent=action==='keep'?'Saving the workbook…':'Undoing the changes…';
 try{
  const r=await fetch(`${API}/runs/${encodeURIComponent(run.id)}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data.ok)throw new Error(data.error||`HTTP ${r.status}`);
  await loadRuns();
  $('sheetsReviewNote').textContent='';
  root.LocalAIUI?.toast?.(action==='keep'?'Changes kept and the workbook saved':'Changes discarded');
  loadBook();
 }catch(e){$('sheetsReviewNote').textContent=`${action==='keep'?'Keep':'Discard'} didn't work. ${e.message||e}`}
 finally{btn.disabled=false}
}

function refresh(){health().then(ok=>{if(ok){loadBook();loadRuns();loadBooks()}else if(!st.book)emptyGrid('The Windows computer is not answering, so the workbook can\'t be shown. Check System › Health.')})}
function init(){
 const sec=$('spreadsheets');if(!sec)return;
 $('sheetsExamples').innerHTML=EXAMPLES.map((x,i)=>`<button type="button" class="btn-outline" data-sheets-example="${i}">${x}</button>`).join('');
 sec.querySelectorAll('[data-sheets-example]').forEach(b=>b.addEventListener('click',()=>{$('sheetsPrompt').value=EXAMPLES[b.dataset.sheetsExample];$('sheetsPrompt').focus()}));
 setMode(store.get('sheets.mode')||'review');
 $('sheetsMode').addEventListener('click',e=>{const b=e.target.closest('[data-mode]');if(b)setMode(b.dataset.mode)});
 $('sheetsMode').addEventListener('keydown',e=>{const k={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[e.key];if(!k)return;e.preventDefault();const m=Object.keys(MODES),n=m[(m.indexOf(st.mode)+k+m.length)%m.length];setMode(n);$('sheetsMode').querySelector(`[data-mode="${n}"]`).focus()});
 $('sheetsRun').addEventListener('click',run);
 $('sheetsRetry').addEventListener('click',run);
 $('sheetsPrompt').addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')run()});
 $('sheetsKeep').addEventListener('click',()=>decide('keep'));
 $('sheetsDiscard').addEventListener('click',()=>decide('discard'));
 $('sheetsRefresh').addEventListener('click',refresh);
 $('sheetsBooks').addEventListener('change',openBook);
 $('sheetsFormulas').addEventListener('click',e=>{st.formulas=!st.formulas;e.currentTarget.setAttribute('aria-pressed',st.formulas);renderGrid()});
 $('sheetsTabs').addEventListener('click',e=>{const b=e.target.closest('[data-sheet]');if(b&&b.dataset.sheet!==st.sheet){st.sel=null;$('sheetsCell').hidden=true;loadBook(b.dataset.sheet,1)}});
 $('sheetsPager').addEventListener('click',e=>{const b=e.target.closest('[data-sheets-page]');if(b)loadBook(st.sheet,Math.max(1,st.top+PAGE*+b.dataset.sheetsPage))});
 $('sheetsGrid').addEventListener('click',e=>{const td=e.target.closest('td[data-cell]');if(td)showCell(td.dataset.cell)});
 $('sheetsGrid').addEventListener('keydown',gridKeys);
 $('sheetsAskCell').addEventListener('click',()=>{const p=$('sheetsPrompt'),ref=$('sheetsCellRef').textContent;p.value=(p.value.trim()?p.value.trim()+' ':'')+`${ref} `;p.focus();p.setSelectionRange(p.value.length,p.value.length)});
 $('sheetsHistory').addEventListener('click',e=>{const b=e.target.closest('[data-run]');if(b)showRun(st.runs.find(x=>x.id===b.dataset.run))});
 $('sheetsChanges').addEventListener('click',e=>{const b=e.target.closest('.sheets-goto');if(b)goto(b.dataset.sheet,b.dataset.cell)});
 let was=active();
 new MutationObserver(()=>{const now=active();if(now&&!was&&!st.busy)refresh();was=now}).observe(sec,{attributes:true,attributeFilter:['class']});
 if(was)refresh();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
