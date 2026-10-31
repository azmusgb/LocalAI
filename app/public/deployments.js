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
function filterRecords(rows, query='', evidence='all'){
 const q=String(query).trim().toLowerCase();
 return rows.filter(r=>(evidence==='all'||r.evidence===evidence)&&[r.name,r.environment,r.sourceSha,r.deployedSha].filter(Boolean).join(' ').toLowerCase().includes(q));
}
if(typeof module==='object'&&module.exports){module.exports={sha,records,gates,filterRecords,MAX_AGE_MS};return;}
const page=document.getElementById('deployments');if(!page)return;
const $=id=>document.getElementById(id);
const state={health:null,observedAt:null,selected:'localai',active:false,request:null,timer:null,expired:false};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={fresh:'Current report',stale:'Stale report',unavailable:'Unavailable',unconnected:'Not connected'};
function rows(){return records(state.health,state.observedAt);}
function short(value){return value?value.slice(0,7):'Unknown';}
function render(){
 const all=rows(),visible=filterRecords(all,$('deploymentSearch').value,$('deploymentEvidence').value);
 $('deploymentReported').textContent=all.filter(r=>r.evidence==='fresh'&&r.deployedSha).length;
 $('deploymentMissing').textContent=all.filter(r=>r.evidence!=='fresh'||!r.deployedSha).length;
 $('deploymentCount').textContent=`${visible.length} of ${all.length} workstreams`;
 $('deploymentRows').innerHTML=visible.map(r=>`<tr class="${r.id===state.selected?'dep-selected':''}"><th scope="row"><button type="button" class="dep-select" data-deployment="${r.id}" aria-pressed="${r.id===state.selected}">${escape(r.name)}</button></th><td>${escape(r.environment)}</td><td><code>${short(r.sourceSha)}</code></td><td><code title="${escape(r.deployedSha||'No deployed revision evidence')}">${short(r.deployedSha)}</code></td><td><span class="dep-status dep-${r.evidence}">${labels[r.evidence]}</span></td><td>${r.runtime}</td></tr>`).join('');
 $('deploymentEmpty').hidden=visible.length>0;
 const selected=visible.find(r=>r.id===state.selected);
 $('deploymentDetail').hidden=!selected;
 $('deploymentRail').hidden=!selected;
 if(!selected)return;
 $('deploymentSelectedName').textContent=selected.name;
 $('deploymentEnvironment').textContent=selected.environment;
 $('deploymentIdentity').innerHTML=[
  ['Source SHA','Unknown — source feed not connected'],['Merged SHA','Unknown — merge feed not connected'],
  ['Reported deployed SHA',selected.deployedSha||'Unknown — no revision reported'],
  ['Artifact identity / SHA-256','Unknown — artifact evidence not connected'],
  ['Observed at',Number.isFinite(selected.observedAt)?new Date(selected.observedAt).toLocaleString():'Never'],
  ['Evidence source',selected.id==='localai'?'/healthz · '+labels[selected.evidence]:'Deployment feed not connected']
 ].map(([label,value])=>`<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('');
 $('deploymentGates').innerHTML=gates(selected).map(([label,status,detail])=>`<li><span class="dep-gate-icon dep-${status}" aria-hidden="true">${status==='na'?'—':'○'}</span><div><strong>${label}</strong><span>${escape(detail)}</span></div><span class="dep-gate-label">${status==='reported'?'Reported':status==='na'?'N/A':'Unknown'}</span></li>`).join('');
 $('deploymentWarning').textContent=selected.evidence==='stale'?'This report has expired. Refresh before making a deployment decision.':'Source revision and artifact evidence are missing. Promotion readiness cannot be determined.';
 $('deploymentNextTitle').textContent=selected.id==='localai'?'Inspect release evidence':'Connect deployment evidence';
 $('deploymentNextText').textContent=selected.id==='localai'?'Check appliance health and release history. A reported commit does not establish CI, artifact identity, or runtime acceptance.':`Connect an authoritative deployment feed for ${selected.name}, including environment, exact revision, artifact digest and verification evidence.`;
 $('deploymentPrimary').href=selected.id==='localai'?'#status':'#integrations';
 $('deploymentPrimary').textContent=selected.id==='localai'?'Open System Health':'Open Services';
 $('deploymentLocalLinks').hidden=selected.id!=='localai';
 $('deploymentLinksNote').hidden=selected.id==='localai';
}
function status(message){$('deploymentStatus').textContent=message;}
async function refresh(){
 if(state.request)return;
 const controller=new AbortController();state.request=controller;
 const timeout=setTimeout(()=>controller.abort(),8000);
 $('deploymentRefresh').disabled=true;page.setAttribute('aria-busy','true');status('Checking appliance deployment evidence…');
 try{
  const response=await fetch('/healthz',{cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error(response.status===401||response.status===403?'Access denied. Sign in and retry.':`Health endpoint returned HTTP ${response.status}.`);
  const health=await response.json();
  if(health?.status!=='ok'||health?.appliance!=='Local AI')throw new Error('Health endpoint returned an unrecognized response.');
  if(!state.active||state.request!==controller)return;
  state.health=health;state.observedAt=Date.now();state.expired=false;
  status('Appliance report refreshed. Other workstreams have no deployment feed.');
 }catch(error){
  if(!state.active||state.request!==controller)return;
  // Preserve the last revision as explicitly stale, never as fresh success after failure.
  if(state.health)state.observedAt=Math.min(state.observedAt,Date.now()-MAX_AGE_MS-1);
  status((error.name==='AbortError'?'Request timed out. Retry when the appliance is available.':error.message)+(state.health?' Last report retained as stale.':''));
 }finally{
  clearTimeout(timeout);
  if(state.request===controller){state.request=null;$('deploymentRefresh').disabled=false;page.setAttribute('aria-busy','false');if(state.active)render();}
 }
}
function activate(){
 state.active=true;render();void refresh();
 clearInterval(state.timer);
 state.timer=setInterval(()=>{
  if(state.active&&!state.expired&&Number.isFinite(state.observedAt)&&Date.now()-state.observedAt>MAX_AGE_MS){
   state.expired=true;const focused=document.activeElement?.dataset?.deployment;render();
   if(focused)page.querySelector(`[data-deployment="${focused}"]`)?.focus();
   status('Deployment report is stale. Refresh to obtain current evidence.');
  }
 },1000);
}
function deactivate(){state.active=false;state.request?.abort();state.request=null;clearInterval(state.timer);state.timer=null;}
$('deploymentRefresh').addEventListener('click',()=>void refresh());
function filter(){const visible=filterRecords(rows(),$('deploymentSearch').value,$('deploymentEvidence').value);if(!visible.some(r=>r.id===state.selected))state.selected=visible[0]?.id||null;render();}
$('deploymentSearch').addEventListener('input',filter);
$('deploymentEvidence').addEventListener('change',filter);
$('deploymentRows').addEventListener('click',event=>{const button=event.target.closest('[data-deployment]');if(!button)return;state.selected=button.dataset.deployment;render();page.querySelector(`[data-deployment="${state.selected}"]`)?.focus();});
root.LocalAIDeployments={activate,deactivate};
if(page.classList.contains('active'))activate();  // loaded on demand: the page may already be open
})(typeof window==='undefined'?globalThis:window);
