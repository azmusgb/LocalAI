// Read-only deployment evidence. A health response proves neither CI nor acceptance.
(function(root){
'use strict';
const MAX_AGE_MS = 60000;
const WORKSTREAMS = [
 ['localai','Local AI','This appliance'],
 ['workshop','Workshop OS','Device environment unknown'],
 ['inventory','Filament Inventory','Environment unknown'],
 ['pihub','Print Lab / Pi Hub','Environment unknown'],
 ['formworks','FormWorks Utilities','Environment unknown'],
 ['workflow','Mermaid / Workflow Tools','Environment unknown']
];
function sha(value){return typeof value==='string'&&/^[a-f0-9]{40}$/i.test(value)?value.toLowerCase():null;}
function records(health, observedAt, now=Date.now()){
 const valid=health?.status==='ok'&&health?.appliance==='Local AI';
 const fresh=valid&&Number.isFinite(observedAt)&&observedAt<=now&&now-observedAt<=MAX_AGE_MS;
 return WORKSTREAMS.map(([id,name,environment])=>({
  id,name,environment,sourceSha:null,mergedSha:null,artifact:null,
  deployedSha:id==='localai'&&valid?sha(health.releaseCommit):null,
  observedAt:id==='localai'&&valid?observedAt:null,
  evidence:id==='localai'?(valid?(fresh?'fresh':'stale'):'unavailable'):'unconnected',
  runtime:'Unknown',physical:id==='workshop'?'Unknown':'Not applicable'
 }));
}
function gates(record){
 return [
  ['CI Green','unknown','No checks tied to a source SHA.'],
  ['Merged','unknown','No merge evidence connected.'],
  ['Artifact','unknown','No artifact identity or digest connected.'],
  ['Deployed',record.deployedSha&&record.evidence==='fresh'?'reported':'unknown',record.deployedSha?(record.evidence==='fresh'?'Appliance reports this revision; artifact not verified.':'Last reported revision is stale; refresh evidence.'):'No deployed revision reported.'],
  ['Runtime Verified','unknown','Requires verification results for the deployed artifact.'],
  ['Physical Acceptance',record.id==='workshop'?'unknown':'na',record.id==='workshop'?'Requires device candidate and physical checklist.':'Not applicable to this software workstream.']
 ];
}
if(typeof module==='object'&&module.exports){module.exports={sha,records,gates,MAX_AGE_MS};return;}
// Improve › Shipped › Running now (Deployments merged into Shipped, 2 Nov): the revision the appliance reports, how fresh
// that report is, and plainly what is not connected. It refreshes while Shipped is open and goes stale after MAX_AGE_MS.
const host=document.getElementById('shipped');if(!host)return;
// Platform step 4: what is live on every part of the platform (this appliance included) is Pi Hub's System › Versions,
// written by each part's own deploy. This card keeps only what the appliance itself reports, and links there.
// Pi Hub's address comes from ask-context.js's homeUrl (the tool registry, step 7 Decision 6).
const versionsUrl=host=>(root.LocalAIAskContext?.homeUrl(host)||'http://10.0.0.30/')+'versions';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={health:null,observedAt:null,active:false,request:null,timer:null,expired:false,error:''};
let card=null;
function mount(){
 if(card)return card;
 card=document.createElement('section');card.id='shippedNow';card.className='card dep-now';card.setAttribute('aria-labelledby','shippedNowTitle');
 card.innerHTML='<div class="dep-now__head"><h2 id="shippedNowTitle">Running now</h2><button type="button" class="btn-outline" data-dep-refresh>Refresh</button></div><p class="dep-now__line" data-dep-line aria-live="polite"></p><p class="dep-now__note" data-dep-gates></p><p class="dep-now__note" data-dep-others>Deploys of every part, this one included, are on <a data-dep-versions target="_blank" rel="noopener">Pi Hub › Versions</a>.</p>';
 const list=document.getElementById('shippedList');if(list)list.before(card);else host.appendChild(card); // just above the releases, under What's new
 card.querySelector('[data-dep-versions]').href=versionsUrl(location.hostname);
 card.querySelector('[data-dep-refresh]').addEventListener('click',()=>void refresh());
 return card;
}
function render(){
 const c=mount(),[local]=records(state.health,state.observedAt),deployed=gates(local).find(g=>g[0]==='Deployed');
 c.dataset.evidence=local.evidence;
 const when=Number.isFinite(local.observedAt)?new Date(local.observedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
 c.querySelector('[data-dep-line]').innerHTML=local.deployedSha
  ?`Local AI <code title="${escape(local.deployedSha)}">${escape(local.deployedSha.slice(0,7))}</code>, reported by the appliance${when?' at '+escape(when):''}.${local.evidence==='stale'?' This report is old: refresh it.':''}`
  :escape(state.request?'Checking what the appliance runs…':state.error||'The appliance has not reported a revision.');
 c.querySelector('[data-dep-gates]').textContent=deployed[1]==='reported'?'This is the revision the appliance reports. Its deploy record (certified, promoted, rolled back) is on Versions.':'No current report from the appliance. Its last deploy is on Versions.';
 c.querySelector('[data-dep-refresh]').disabled=!!state.request;
}
async function refresh(){
 if(state.request)return;
 const controller=new AbortController();state.request=controller;state.error='';render();
 const timeout=setTimeout(()=>controller.abort(),8000);
 try{
  const response=await fetch('/healthz',{cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error(response.status===401||response.status===403?'Access denied. Sign in and refresh.':`The appliance answered HTTP ${response.status}.`);
  const health=await response.json();
  if(health?.status!=='ok'||health?.appliance!=='Local AI')throw new Error('The appliance sent an answer this page does not recognise.');
  if(!state.active||state.request!==controller)return;
  state.health=health;state.observedAt=Date.now();state.expired=false;
 }catch(error){
  if(!state.active||state.request!==controller)return;
  // Keep the last revision, marked stale, never as a fresh success after a failure.
  if(state.health)state.observedAt=Math.min(state.observedAt,Date.now()-MAX_AGE_MS-1);
  state.error=error.name==='AbortError'?'The appliance did not answer in time. Refresh to try again.':error.message;
 }finally{
  clearTimeout(timeout);
  if(state.request===controller){state.request=null;if(state.active)render()}
 }
}
function activate(){
 state.active=true;render();void refresh();
 clearInterval(state.timer);
 state.timer=setInterval(()=>{if(state.active&&!state.expired&&Number.isFinite(state.observedAt)&&Date.now()-state.observedAt>MAX_AGE_MS){state.expired=true;render()}},1000);
}
function deactivate(){state.active=false;state.request?.abort();state.request=null;clearInterval(state.timer);state.timer=null}
root.LocalAIDeployments={activate,deactivate};
})(typeof window==='undefined'?globalThis:window);
