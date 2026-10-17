// System › Spreadsheets: ask GridCraft, on the Windows computer, to read or change a workbook. The appliance proxies the
// host bridge (/api/gridcraft), so the bridge port never has to be open to the network. One request at a time.
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
  if(active())$('sheetsResult').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}); // below the fold on a phone
 }catch(e){
  show('error',`That didn't work. ${e.message||e}`,{retry:true});
  health(); // one failed request doesn't mean GridCraft is down: show its real state
 }finally{
  clearInterval(st.timer);tick();st.busy=false;$('sheetsRun').disabled=false;$('sheetsRun').textContent='Run';
 }
}
function init(){
 const sec=$('spreadsheets');if(!sec)return;
 $('sheetsExamples').innerHTML=EXAMPLES.map((x,i)=>`<button type="button" class="suggestion-chip" data-sheets-example="${i}">${x}</button>`).join('');
 sec.querySelectorAll('[data-sheets-example]').forEach(b=>b.addEventListener('click',()=>{$('sheetsPrompt').value=EXAMPLES[b.dataset.sheetsExample];$('sheetsPrompt').focus()}));
 $('sheetsRun').addEventListener('click',run);
 $('sheetsRetry').addEventListener('click',run);
 $('sheetsPrompt').addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')run()});
 let was=active();
 new MutationObserver(()=>{const now=active();if(now&&!was&&!st.busy)health();was=now}).observe(sec,{attributes:true,attributeFilter:['class']});
 if(was)health();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
