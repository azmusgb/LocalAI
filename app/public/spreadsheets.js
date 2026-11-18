// Spreadsheets (a Work kind; Home's Spreadsheet mode sends here): see the workbook open in GridCraft on the Windows computer, ask for it to be read or changed,
// and keep or discard what a Review request changed. The appliance proxies the host bridge (/api/gridcraft), so the
// bridge port never has to be open to the network. One request at a time.
// A cell can also be changed by hand (tap the selected cell, double-click, Enter, F2 or just type; a sheet on phones).
// It goes through the same review: it is in GridCraft but not saved until Keep changes, and Discard undoes it.
(function(root){'use strict';
const $=id=>document.getElementById(id),API='/api/gridcraft';
const EXAMPLES=[
 'Summarize the sheets in the workbook and what each one holds.',
 'What is the total of the Sales column? Do not change anything.',
 'Check the workbook for empty cells or errors in formulas and tell me where they are.'
];
const MODES={read:'Looks and answers. It cannot change anything.',review:'Makes the changes in GridCraft without saving. You keep or discard them.',apply:'Makes the changes and saves the workbook.'};
const STATUS={running:'Running',review:'Waiting for review',kept:'Kept',discarded:'Discarded',applied:'Applied',done:'No changes',failed:'Failed'};
const PAGE=100,COLS=40;
const st={busy:false,timer:0,poll:0,started:0,mode:'review',book:null,sheet:'',top:1,left:1,runs:[],run:null,sel:null,formulas:false,books:[],edit:null,saving:false,stale:false,editSheet:null};
const phone=()=>matchMedia('(max-width:640px)').matches;
const active=()=>$('spreadsheets')?.classList.contains('active');
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const show1=v=>v==null?'':typeof v==='object'?(v.error||JSON.stringify(v)):String(v);
const col=n=>{let s='';while(n>0){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=(n-r-1)/26}return s};
const num=c=>[...c.toUpperCase()].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0);
function bounds(rng){const m=/^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/i.exec(String(rng||'').trim());if(!m)return null;const r1=+m[2],c1=num(m[1]),r2=+(m[4]||m[2]),c2=num(m[3]||m[1]);return{r1:Math.min(r1,r2),c1:Math.min(c1,c2),r2:Math.max(r1,r2),c2:Math.max(c1,c2)}}
function splitRef(raw){const s=String(raw||'').trim();if(!s)return null;const i=s.lastIndexOf('!'),sh=i<0?'':s.slice(0,i).replace(/^'(.*)'$/,'$1').replace(/''/g,"'").trim(),rest=i<0?s:s.slice(i+1).trim(),b=bounds(rest);return b?{sheet:sh||st.sheet,b,isRange:rest.includes(':')}:null}
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
 // Read only means read only: the grid can't be changed by hand either.
 $('sheetsGrid').setAttribute('aria-readonly',st.mode==='read');$('sheetsEditCell').hidden=st.mode==='read';
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
 $('sheetsResultTitle').textContent=run.kind==='edit'?run.prompt:run.prompt?`“${run.prompt.length>90?run.prompt.slice(0,90)+'…':run.prompt}”`:'Answer';
 if(run.status==='running')show('working','GridCraft is still working on this request.');
 else show(run.status==='failed'?'error':'done',run.answer||run.error||'Done.',{retry:run.status==='failed'});
 $('sheetsResult').dataset.status=run.status;
 const changes=changesHtml(run);$('sheetsChanges').innerHTML=changes;$('sheetsChanges').hidden=!changes;
 const review=run.status==='review',latest=st.runs[0]?.id===run.id;
 $('sheetsReview').hidden=!review;$('sheetsDiscard').hidden=!latest||!!run.uncertain;
 // One blue action per page: while a request waits for review, deciding is the next step, not another run.
 $('sheetsRun').classList.toggle('btn-primary',!review);$('sheetsRun').classList.toggle('btn-outline',review);
 $('sheetsReviewNote').textContent=review?(run.uncertain?'This request was stopped in the middle of a change, so it can\'t be undone from here. Keep saves it as it is.':latest?'These changes are in GridCraft but not saved yet.':'Only the latest request can be undone. Keep changes saves everything in the workbook.'):'';
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
function goError(text){const el=$('sheetsGoError');if(el){el.textContent=text;el.hidden=!text}}
function emptyGrid(text){$('sheetsGrid').innerHTML='';$('sheetsGridEmpty').hidden=false;$('sheetsGridEmpty').textContent=text;$('sheetsPager').hidden=true}
async function loadBook(sheet=st.sheet,top=st.top,left=st.left,want=null){
 const q=new URLSearchParams();
 if(sheet)q.set('sheet',sheet);
 const used=(sheet===st.book?.sheet&&st.book?.usedRange)||st.book?.sheets?.find(s=>s.name===sheet)?.usedRange,u=bounds(used);
 if(want?.isRange)q.set('range',`${col(left)}${top}:${col(Math.min(want.c2,left+COLS-1))}${Math.min(want.r2,top+PAGE-1)}`);
 else if(u&&(top>1||left>1||(want&&(want.r2>u.r2||want.c2>u.c2))))q.set('range',`${col(left)}${top}:${col(Math.min(Math.max(u.c2,want?.c2||left),left+COLS-1))}${Math.min(Math.max(u.r2,want?.r2||top),top+PAGE-1)}`);
 if(!st.book)emptyGrid('Opening the workbook…');
 try{
  const r=await fetch(`${API}/workbook?${q}`,{cache:'no-store',signal:AbortSignal.timeout(70000)}),data=await r.json();
  if(!r.ok||!data.ok)throw new Error(data.error||`HTTP ${r.status}`);
  const b=bounds(data.range);st.book=data;st.sheet=data.sheet||'';st.top=b?.r1||1;st.left=b?.c1||1;
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
 const dl=$('sheetsDownload');if(dl){dl.href=b.file?`${API}/download?name=${encodeURIComponent(b.file)}`:`${API}/download`;dl.download=b.file||'workbook.xlsx'}
 renderBooks();
 $('sheetsTabs').innerHTML=(b.sheets||[]).map(s=>`<button type="button" role="tab" class="ux-tab${s.name===b.sheet?' active':''}" aria-selected="${s.name===b.sheet}" data-sheet="${esc(s.name)}">${esc(s.name)}</button>`).join('');
 renderGrid();
}
function renderGrid(){
 const b=st.book;if(!b)return;
 if(st.edit){st.stale=true;return} // never under a cell being typed in: it renders when the edit ends
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
 const focused=grid.contains(document.activeElement); // a re-render keeps keyboard focus on the selected cell
 grid.innerHTML=html+'</tbody>';
 if(!grid.querySelector('[tabindex="0"]'))grid.querySelector('td')?.setAttribute('tabindex','0');
 const total=Math.max(u?u.r2:0,range.r2),cols=Math.max(u?u.c2:0,range.c2),rowsPaged=range.r1>1||range.r2<total,colsPaged=range.c1>1||range.c2<cols;
 $('sheetsRange').textContent=`${b.sheet}, rows ${range.r1}–${range.r2} of ${total}${colsPaged?`, columns ${col(range.c1)}–${col(range.c2)} of ${col(cols)}`:''}`;
 $('sheetsPager').hidden=!(rowsPaged||colsPaged);
 $('sheetsRowPager').hidden=!rowsPaged;$('sheetsColPager').hidden=!colsPaged;
 $('sheetsPagerText').textContent=[rowsPaged&&`Rows ${range.r1}–${range.r2} of ${total}`,colsPaged&&`Columns ${col(range.c1)}–${col(range.c2)} of ${col(cols)}`].filter(Boolean).join(' · ');
 $('sheetsPager').querySelector('[data-sheets-page="-1"]').disabled=range.r1<=1;
 $('sheetsPager').querySelector('[data-sheets-page="1"]').disabled=range.r2>=total;
 $('sheetsPager').querySelector('[data-sheets-cols="-1"]').disabled=range.c1<=1;
 $('sheetsPager').querySelector('[data-sheets-cols="1"]').disabled=range.c2>=cols;
 if(st.sel)showCell(st.sel,false);
 if(focused)grid.querySelector('td[tabindex="0"]')?.focus({preventScroll:true});
}
function showCell(ref,focus=true){
 const b=st.book,td=$('sheetsGrid').querySelector(`td[data-cell="${ref}"]`);
 if(!b||!td){$('sheetsCell').hidden=true;return}
 if(st.sel!==ref)cellError('');
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
 const p=splitRef(sheet&&ref?`${sheet}!${ref}`:ref||sheet);
 if(!p){goError('Enter a cell like B12 or a range like A1:D20.');return}
 if(st.book?.sheets?.length&&!st.book.sheets.some(s=>s.name===p.sheet)){goError(`No sheet named ${p.sheet}.`);return}
 goError('');
 const b=p.b,sel=`${col(b.c1)}${b.r1}`,cur=bounds(st.book?.range);st.sel=sel;
 if(p.isRange)await loadBook(p.sheet,b.r1,b.c1,{...b,isRange:true});
 else if(p.sheet!==st.sheet||!cur||b.r1<cur.r1||b.r1>cur.r2||b.c1<cur.c1||b.c1>cur.c2)await loadBook(p.sheet,Math.floor((b.r1-1)/PAGE)*PAGE+1,Math.floor((b.c1-1)/COLS)*COLS+1,b);
 showCell(sel);
 $('sheetsBook').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
}
function gridKeys(e){
 const td=e.target.closest('td[data-cell]');if(!td||e.target!==td)return; // keys typed into a cell's editor stay there
 if(e.key==='Enter'||e.key==='F2'){e.preventDefault();return startEdit(td.dataset.cell)}
 if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&e.key!==' '){e.preventDefault();return startEdit(td.dataset.cell,e.key)}
 const d={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]}[e.key];
 if(!d)return;e.preventDefault();
 const next=$('sheetsGrid').querySelector(`td[data-i="${+td.dataset.i+d[0]}"][data-j="${+td.dataset.j+d[1]}"]`);
 if(next)showCell(next.dataset.cell);
}

// ---- Changing a cell by hand: inline on a computer, a small sheet on a phone. Enter (or Save) commits, Esc cancels.
function cellError(text){for(const id of ['sheetsCellError','sheetsEditError']){$(id).textContent=text;$(id).hidden=!text}}
function editBlocked(){
 if(st.mode==='read')return 'Read only is on, so cells can\'t be changed. Choose Review or Apply to change them.';
 if(st.busy)return 'GridCraft is busy with a request. Change the cell when it finishes.';
 if(st.saving)return 'The last change is still being made. Try again in a moment.';
 return '';
}
const cellAt=ref=>$('sheetsGrid').querySelector(`td[data-cell="${ref}"]`);
function cellInput(td){ // what the cell holds: its formula, or its value as typed
 const i=+td.dataset.i,j=+td.dataset.j,f=st.book.formulas?.[i]?.[j],raw=st.book.raw?.[i]?.[j];
 const v=typeof f==='string'&&f.startsWith('=')?f:raw??f??st.book.values?.[i]?.[j];
 return v==null||typeof v==='object'?'':String(v);
}
function startEdit(ref,typed){
 const td=ref&&cellAt(ref);if(!td||st.edit||!st.book)return;
 showCell(ref,false);
 const why=editBlocked();if(why){cellError(why);return}
 cellError('');
 if(phone())return openEditSheet(td);
 const old=cellInput(td),sheet=st.book.sheet;
 st.edit={ref};td.classList.add('is-editing');
 td.innerHTML=`<input class="sheets-grid__input" aria-label="${esc(`New value for ${sheet}!${ref}`)}" autocomplete="off" spellcheck="false">`;
 const input=td.firstChild;input.value=typed??old;input.focus();if(typed==null)input.select();
 let done=false;
 const finish=async how=>{
  if(done)return;done=true;
  const text=input.value,commit=how!=='cancel'&&text!==old;st.edit=null;
  if(commit){td.classList.replace('is-editing','is-saving');td.textContent=text}
  if(!commit||st.stale){st.stale=false;renderGrid()}
  if(how!=='blur')cellAt(ref)?.focus();
  if(!commit)return;
  const err=await saveCell(sheet,ref,text);
  if(st.book?.sheet===sheet){if(err)renderGrid();if(how!=='blur')cellAt(ref)?.focus()}
  if(err)cellError(`${sheet}!${ref} wasn't changed. ${err}`);
 };
 input.addEventListener('keydown',e=>{
  e.stopPropagation();
  if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();finish('enter')}
  else if(e.key==='Escape'){e.preventDefault();finish('cancel')}
 });
 input.addEventListener('blur',()=>finish('blur'));
}
function openEditSheet(td){
 const d=$('sheetsEdit'),b=st.book;if(d.open)return;
 const ref=td.dataset.cell,i=+td.dataset.i,j=+td.dataset.j,f=b.formulas?.[i]?.[j],isF=typeof f==='string'&&f.startsWith('=');
 st.editSheet={sheet:b.sheet,ref,old:cellInput(td)};
 $('sheetsEditTitle').textContent=`Change ${b.sheet}!${ref}`;
 $('sheetsEditNow').textContent=`Now: ${show1(b.values?.[i]?.[j])||'empty'}${isF?`\nFormula: ${f}`:''}\nNothing is saved until you choose Keep changes.`;
 const input=$('sheetsEditInput');input.value=st.editSheet.old;cellError('');
 $('sheetsEditSave').disabled=false;$('sheetsEditSave').textContent='Save';
 const done=reopened=>{st.editSheet=null;if(!reopened)cellAt(ref)?.focus()};
 root.LocalAIUI.showSheet(d,done); // Back closes it too
 input.focus();input.select();
}
async function submitEditSheet(e){
 e.preventDefault();
 const s=st.editSheet,save=$('sheetsEditSave'),d=$('sheetsEdit');if(!s||save.disabled)return;
 const text=$('sheetsEditInput').value;
 if(text===s.old){d.close();return}
 const why=editBlocked();if(why){cellError(why);return}
 save.disabled=true;save.textContent='Saving…';
 const err=await saveCell(s.sheet,s.ref,text);
 save.disabled=false;save.textContent='Save';
 if(err)cellError(`${s.sheet}!${s.ref} wasn't changed. ${err}`);else if(d.open)d.close();
}
// Returns '' when GridCraft changed the cell, else why not. The change joins the requests as a Direct edit waiting for review.
async function saveCell(sheet,ref,text){
 st.saving=true;
 try{
  const r=await fetch(`${API}/cell`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sheet,cell:ref,input:text})});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data.ok||!data.run)return data.error||`HTTP ${r.status}`;
  st.runs=[data.run,...st.runs.filter(x=>x.id!==data.run.id)];
  showRun(data.run);
  root.LocalAIUI?.toast?.(`${sheet}!${ref} changed. It isn't saved until you choose Keep changes.`);
  return '';
 }catch(e){return e.message||String(e)}
 finally{st.saving=false;loadBook()}
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
async function confirmDirty(title,verb,label){
 if(!st.book?.dirty)return true;
 const cur=st.book.file||'The open workbook',effect=`${cur} has unsaved changes in GridCraft. ${verb} anyway? The changes stay in GridCraft's undo history only until it's closed.`;
 const ask=root.LocalAIUI?.ask;return ask?(await ask({title,effect,confirmLabel:label})).ok:root.confirm(effect);
}
async function switchBook(ep,body,working,done,failed){
 const sel=$('sheetsBooks'),cur=st.book?.file||'';
 sel.disabled=true;$('sheetsRange').textContent=working;
 try{
  const r=await fetch(`${API}/${ep}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data.ok)throw new Error(data.error||`HTTP ${r.status}`);
  st.book=null;st.sheet='';st.sel=null;st.top=1;st.left=1;$('sheetsCell').hidden=true;goError('');
  if(ep!=='open')await loadBooks();
  await loadBook();
  root.LocalAIUI?.toast?.(done);
 }catch(e){
  sel.value=cur;renderGrid();
  $('sheetsResultTitle').textContent=failed;$('sheetsResult').dataset.status='';$('sheetsElapsed').textContent='';
  show('error',e.message||String(e));
 }finally{sel.disabled=false}
}
async function openBook(){
 const sel=$('sheetsBooks'),name=sel.value,cur=st.book?.file||'';
 if(!name||name===cur)return;
 if(!await confirmDirty(`Open ${name}?`,`Open ${name}`,'Open anyway')){sel.value=cur;return}
 await switchBook('open',{name},`Opening ${name}…`,`Opened ${name}`,`${name} didn't open`);
}
async function newBook(){
 const cur=st.book?.file||'The open workbook',effect=st.book?.dirty?`${cur} has unsaved changes in GridCraft. Starting a new workbook leaves them in GridCraft's undo history only until it's closed.`:'Creates a blank .xlsx workbook in the GridCraft folder and opens it.';
 const ask=root.LocalAIUI?.ask,ans=ask?await ask({title:'New workbook',effect,confirmLabel:'Create workbook',input:{label:'File name',placeholder:'Budget-2027.xlsx'}}):{ok:true,value:root.prompt('File name:')||''};
 if(!ans.ok||!ans.value)return;
 const raw=ans.value.trim(),name=/\.[a-z0-9]+$/i.test(raw)?raw:`${raw}.xlsx`;
 await switchBook('new',{name},`Creating ${name}…`,`Created ${name}`,`${name} wasn't created`);
}
async function uploadBook(e){
 const f=e.target.files?.[0];e.target.value='';if(!f)return;
 if(!await confirmDirty(`Upload ${f.name}?`,`Upload and open ${f.name}`,'Upload anyway'))return;
 const buf=new Uint8Array(await f.arrayBuffer());let bin='';
 for(let i=0;i<buf.length;i+=8192)bin+=String.fromCharCode(...buf.subarray(i,i+8192));
 await switchBook('upload',{name:f.name,data:btoa(bin)},`Uploading ${f.name}…`,`Uploaded ${f.name}`,`${f.name} wasn't uploaded`);
}

// ---- Run, keep, discard ----
function tick(){$('sheetsElapsed').textContent=`${Math.round((Date.now()-st.started)/1000)}s`}
// What the running request has done so far (the bridge reads the agent's steps as they happen): the newest few, in words.
const STEPS_SHOWN=6;
function renderSteps(steps){
 const list=$('sheetsSteps'),shown=steps.slice(-STEPS_SHOWN),earlier=steps.length-shown.length;
 list.hidden=!steps.length;
 list.innerHTML=(earlier?`<li class="sheets-steps__more">${earlier} earlier step${earlier===1?'':'s'}</li>`:'')
  +shown.map((x,i)=>`<li class="${x.failed?'is-failed':i===shown.length-1?'is-current':''}">${esc(x.text)}${x.failed?' (didn’t work)':''}</li>`).join('');
}
async function pollSteps(){
 try{
  const r=await fetch(`${API}/progress`,{cache:'no-store'});const data=await r.json();
  if(st.busy&&r.ok&&data.ok&&data.running)renderSteps(data.steps||[]);
 }catch{} // progress is a nicety: the request itself reports how it ended
}
function stopSteps(){clearInterval(st.poll);st.poll=0;renderSteps([])}
async function run(){
 const text=$('sheetsPrompt').value.trim();
 if(!text||st.busy){if(!text)$('sheetsPrompt').focus();return}
 st.busy=true;st.started=Date.now();$('sheetsRun').disabled=true;$('sheetsRun').textContent='Working…';
 showRun(null);$('sheetsResultTitle').textContent='Answer';$('sheetsResult').dataset.status='';
 show('working','GridCraft is working on it. Larger requests can take a few minutes.');
 $('sheetsElapsed').textContent='0s';st.timer=setInterval(tick,1000);st.poll=setInterval(pollSteps,1500);
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
  clearInterval(st.timer);stopSteps();tick();st.busy=false;$('sheetsRun').disabled=false;$('sheetsRun').textContent='Run';
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

function refresh(){health().then(ok=>{if(ok){loadBook();loadRuns();loadBooks()}else if(!st.book)emptyGrid('The Windows computer is not answering, so the workbook can\'t be shown. Check that it is on and GridCraft is open, then choose Refresh.')})}
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
 $('sheetsRefresh').addEventListener('click',()=>{goError('');refresh()});
 $('sheetsBooks').addEventListener('change',openBook);
 $('sheetsNew').addEventListener('click',newBook);
 $('sheetsUpload').addEventListener('click',()=>$('sheetsUploadInput').click());
 $('sheetsUploadInput').addEventListener('change',uploadBook);
 $('sheetsGo').addEventListener('submit',e=>{e.preventDefault();goto('',$('sheetsGoInput').value)});
 $('sheetsFormulas').addEventListener('click',e=>{st.formulas=!st.formulas;e.currentTarget.setAttribute('aria-pressed',st.formulas);renderGrid()});
 $('sheetsTabs').addEventListener('click',e=>{const b=e.target.closest('[data-sheet]');if(b&&b.dataset.sheet!==st.sheet){st.sel=null;$('sheetsCell').hidden=true;goError('');loadBook(b.dataset.sheet,1,1)}});
 $('sheetsPager').addEventListener('click',e=>{const r=e.target.closest('[data-sheets-page]'),c=e.target.closest('[data-sheets-cols]');if(r)loadBook(st.sheet,Math.max(1,st.top+PAGE*+r.dataset.sheetsPage),st.left);else if(c)loadBook(st.sheet,st.top,Math.max(1,st.left+COLS*+c.dataset.sheetsCols))});
 // A tap or click selects a cell; one on the cell already selected (or a double-click) changes it.
 $('sheetsGrid').addEventListener('click',e=>{const td=e.target.closest('td[data-cell]');if(!td||st.edit)return;if(st.sel===td.dataset.cell&&!$('sheetsCell').hidden&&e.detail<2)startEdit(td.dataset.cell);else showCell(td.dataset.cell)});
 $('sheetsGrid').addEventListener('dblclick',e=>{const td=e.target.closest('td[data-cell]');if(td&&!st.edit)startEdit(td.dataset.cell)});
 $('sheetsEditCell').addEventListener('click',()=>startEdit(st.sel));
 $('sheetsEdit').addEventListener('submit',submitEditSheet);
 $('sheetsEditCancel').addEventListener('click',()=>$('sheetsEdit').close());
 $('sheetsGrid').addEventListener('keydown',gridKeys);
 $('sheetsAskCell').addEventListener('click',()=>{const p=$('sheetsPrompt'),ref=$('sheetsCellRef').textContent;p.value=(p.value.trim()?p.value.trim()+' ':'')+`${ref} `;p.focus();p.setSelectionRange(p.value.length,p.value.length)});
 $('sheetsHistory').addEventListener('click',e=>{const b=e.target.closest('[data-run]');if(b)showRun(st.runs.find(x=>x.id===b.dataset.run))});
 $('sheetsChanges').addEventListener('click',e=>{const b=e.target.closest('.sheets-goto');if(b)goto(b.dataset.sheet,b.dataset.cell)});
 let was=active();
 new MutationObserver(()=>{const now=active();if(now&&!was&&!st.busy)refresh();was=now}).observe(sec,{attributes:true,attributeFilter:['class']});
 if(was)refresh();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
// Home's Spreadsheet mode: the text becomes this page's request, run in the mode chosen here (Review unless changed).
root.LocalAISheets={ask(text){const p=$('spreadsheets')&&$('sheetsPrompt');if(!p)return false;p.value=String(text||'');run();return true}};
})(window);
