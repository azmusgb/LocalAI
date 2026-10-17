// System › Spreadsheets: ask GridCraft, on the Windows computer, to read or change a workbook. The appliance proxies the
// host bridge (/api/gridcraft), so the bridge port never has to be open to the network. One request at a time.
// Below it, the Workbook card shows the open workbook itself (read-only), with a picker for the GridCraft folder.
(function(root){'use strict';
const $=id=>document.getElementById(id),API='/api/gridcraft';
const EXAMPLES=[
 'Summarize the sheets in the workbook and what each one holds.',
 'What is the total of the Sales column? Do not change anything.',
 'Check the workbook for empty cells or errors in formulas and tell me where they are.'
];
const st={busy:false,timer:0,started:0};
const active=()=>$('spreadsheets')?.classList.contains('active');

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
function show(kind,text,{retry=false}={}){
 const out=$('sheetsResult');out.hidden=false;out.dataset.kind=kind;
 $('sheetsResultText').textContent=text;$('sheetsRetry').hidden=!retry;
}
function tick(){$('sheetsElapsed').textContent=`${Math.round((Date.now()-st.started)/1000)}s`}
async function run(){
 const text=$('sheetsPrompt').value.trim();
 if(!text||st.busy){if(!text)$('sheetsPrompt').focus();return}
 st.busy=true;st.started=Date.now();$('sheetsRun').disabled=true;$('sheetsRun').textContent='Working…';
 show('working','GridCraft is working on it. Larger requests can take a few minutes.');
 $('sheetsElapsed').textContent='0s';st.timer=setInterval(tick,1000);
 try{
  const r=await fetch(`${API}/run`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:text})});
  const data=await r.json().catch(()=>({ok:false,error:`HTTP ${r.status}`}));
  if(!r.ok||!data.ok)throw new Error([data.error||`HTTP ${r.status}`,data.reason].filter(Boolean).join(': '));
  show('done',data.answer||data.stdout||'Done.');
  loadBook(); // the request may have changed it
  if(active())$('sheetsResult').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}); // below the fold on a phone
 }catch(e){
  show('error',`That didn't work. ${e.message||e}`,{retry:true});
  health(); // one failed request doesn't mean GridCraft is down: show its real state
 }finally{
  clearInterval(st.timer);tick();st.busy=false;$('sheetsRun').disabled=false;$('sheetsRun').textContent='Run';
 }
}
// Workbook card: the workbook open in GridCraft, read-only. Each read is one direct GridCraft call, no model.
const wb={book:null,sheet:'',seq:0};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const NUMERIC=/^[-+]?[$€£¥]?\(?[-+]?[$€£¥]?(\d{1,3}(,\d{3})+|\d*)(\.\d+)?\)?%?$/;
const colName=n=>{let s='';for(;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s};
const colNum=s=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
function note(text,kind=''){const n=$('sheetsNote');n.textContent=text;n.dataset.kind=kind}
async function getJson(url,opts){
 const r=await fetch(url,{cache:'no-store',...opts}),data=await r.json().catch(()=>({}));
 if(!r.ok||!data.ok)throw Object.assign(new Error(data.error||`HTTP ${r.status}`),{status:r.status,code:data.code});
 return data;
}
function failText(e){
 if(e.code==='not_running')return "GridCraft isn't open on the Windows computer. Run a request or pick a workbook to start it.";
 if(e.status===409)return 'GridCraft is busy with a request. Refresh when it finishes.';
 if(e.status===502&&/bridge unavailable/i.test(e.message))return "GridCraft isn't answering on the Windows computer.";
 return `Couldn't read the workbook. ${e.message}`;
}
async function loadBook(){
 const seq=++wb.seq;note('Loading the workbook…');
 const list=fetch(`${API}/workbooks`,{cache:'no-store'}).then(r=>r.json()).catch(()=>({}));
 try{
  const book=await getJson(`${API}/workbook`);if(seq!==wb.seq)return;
  wb.book=book;$('sheetsBookTitle').textContent=book.title||'Workbook';$('sheetsDirty').hidden=!book.dirty;
  const names=book.sheets.map(s=>s.name);
  if(!names.includes(wb.sheet))wb.sheet=names.includes(book.activeSheet)?book.activeSheet:names[0]||'';
  renderTabs();picker((await list).workbooks,book.file);
  await loadSheet();
 }catch(e){if(seq!==wb.seq)return;wb.book=null;$('sheetsTabs').innerHTML='';$('sheetsGridWrap').hidden=true;$('sheetsDirty').hidden=true;note(failText(e),'error');picker((await list).workbooks,null)}
}
function picker(list,current){
 const p=$('sheetsPicker');p.hidden=!Array.isArray(list)||!list.length;if(p.hidden)return;
 const opts=list.map(w=>w.name);if(current&&!opts.includes(current))opts.unshift(current);
 p.innerHTML=(current?'':'<option value="">Pick a workbook</option>')+opts.map(n=>`<option${n===current?' selected':''}>${esc(n)}</option>`).join('');
 p.dataset.current=current||'';
}
function renderTabs(){
 const t=$('sheetsTabs');
 t.innerHTML=wb.book.sheets.map((s,i)=>`<button type="button" role="tab" id="sheetsTab${i}" aria-controls="sheetsGridWrap" aria-selected="${s.name===wb.sheet}" tabindex="${s.name===wb.sheet?0:-1}" data-sheet="${esc(s.name)}">${esc(s.name)}</button>`).join('');
 t.hidden=!wb.book.sheets.length;
}
function pickSheet(btn,focus){
 if(!btn)return;wb.sheet=btn.dataset.sheet;
 $('sheetsTabs').querySelectorAll('[role=tab]').forEach(b=>{const on=b===btn;b.setAttribute('aria-selected',on);b.tabIndex=on?0:-1});
 if(focus)btn.focus();loadSheet();
}
async function loadSheet(){
 const seq=++wb.seq,s=wb.book?.sheets.find(x=>x.name===wb.sheet),wrap=$('sheetsGridWrap');
 if(!s){wrap.hidden=true;note('This workbook has no sheets.');return}
 const tab=$('sheetsTabs').querySelector('[aria-selected=true]');if(tab)wrap.setAttribute('aria-labelledby',tab.id);else wrap.setAttribute('aria-label',s.name);
 if(s.cells===0){wrap.hidden=true;note('This sheet is empty.');return}
 const end=s.usedRange?.split(':').pop(),q=new URLSearchParams({sheet:s.name,...(end?{range:`A1:${end}`}:{})});
 note('Loading the sheet…');wrap.setAttribute('aria-busy','true');
 try{
  const data=await getJson(`${API}/range?${q}`);if(seq!==wb.seq)return;
  const rows=data.rows;
  if(!rows.some(r=>r.some(v=>v!==null&&v!==''))){wrap.hidden=true;note('This sheet is empty.');return}
  const m=/^([A-Z]+)(\d+)/.exec(data.range||'A1'),c0=colNum(m[1]),r0=+m[2],w=Math.max(...rows.map(r=>r.length));
  let h='<thead><tr><td class="sheets-grid__corner"></td>';
  for(let c=0;c<w;c++)h+=`<th scope="col">${colName(c0+c)}</th>`;
  h+='</tr></thead><tbody>';
  rows.forEach((r,i)=>{h+=`<tr><th scope="row">${r0+i}</th>`;for(let c=0;c<w;c++)h+=cell(r[c]);h+='</tr>'});
  $('sheetsGrid').innerHTML=h+'</tbody>';wrap.hidden=false;
  note(data.truncated?'Showing the first 200 rows and 30 columns.':'');
 }catch(e){if(seq!==wb.seq)return;wrap.hidden=true;note(failText(e),'error')}
 finally{wrap.removeAttribute('aria-busy')}
}
function cell(v){
 if(v===null||v===undefined||v==='')return'<td></td>';
 if(typeof v==='object')return`<td class="is-error">${esc(v.error||'#ERROR')}</td>`;
 if(typeof v==='boolean')return`<td class="is-num">${v?'TRUE':'FALSE'}</td>`;
 if(typeof v==='number')return`<td class="is-num">${esc(v.toLocaleString(undefined,{maximumFractionDigits:10}))}</td>`;
 return/^#[A-Z0-9/]+[!?]?$/.test(v)&&v.length<10?`<td class="is-error">${esc(v)}</td>`:`<td${NUMERIC.test(v.trim())&&/\d/.test(v)?' class="is-num"':''}>${esc(v)}</td>`;
}
async function openBook(){
 const p=$('sheetsPicker'),name=p.value;if(!name||name===p.dataset.current)return;
 if(wb.book?.dirty&&!(await root.LocalAIUI.ask({title:`Open ${name}?`,effect:"The workbook open now has unsaved changes. GridCraft may lose them.",confirmLabel:'Open'})).ok){p.value=p.dataset.current;return}
 p.disabled=true;note(`Opening ${name}…`);
 try{await getJson(`${API}/open`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});wb.sheet='';await loadBook()}
 catch(e){p.value=p.dataset.current;note(failText(e),'error')}
 finally{p.disabled=false}
}
function init(){
 const sec=$('spreadsheets');if(!sec)return;
 $('sheetsExamples').innerHTML=EXAMPLES.map((x,i)=>`<button type="button" class="suggestion-chip" data-sheets-example="${i}">${x}</button>`).join('');
 sec.querySelectorAll('[data-sheets-example]').forEach(b=>b.addEventListener('click',()=>{$('sheetsPrompt').value=EXAMPLES[b.dataset.sheetsExample];$('sheetsPrompt').focus()}));
 $('sheetsRun').addEventListener('click',run);
 $('sheetsRetry').addEventListener('click',run);
 $('sheetsPrompt').addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')run()});
 $('sheetsRefresh').addEventListener('click',loadBook);
 $('sheetsPicker').addEventListener('change',openBook);
 const tabs=$('sheetsTabs');
 tabs.addEventListener('click',e=>pickSheet(e.target.closest('[role=tab]')));
 tabs.addEventListener('keydown',e=>{
  const all=[...tabs.querySelectorAll('[role=tab]')],i=all.indexOf(document.activeElement);if(i<0)return;
  const j={ArrowRight:i+1,ArrowLeft:i-1,Home:0,End:all.length-1}[e.key];if(j===undefined)return;
  e.preventDefault();pickSheet(all[(j+all.length)%all.length],true);
 });
 let was=active();
 new MutationObserver(()=>{const now=active();if(now&&!was&&!st.busy){health();loadBook()}was=now}).observe(sec,{attributes:true,attributeFilter:['class']});
 if(was){health();loadBook()}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
