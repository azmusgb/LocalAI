// Projects › Print lab: the Mac's print-lab page (app/print-lab.js stores what `lab sync` sends).
// Needs you first (each with the command to run on the Mac), then the open question's budget and stop state, then the
// open experiments, then Earlier. Paired devices can submit verdicts and upload photos to the Mac's pickup queue.
(function(root){'use strict';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=x=>x===null||x===undefined?'–':String(Math.round(Number(x)*10)/10);
const STATUS={planned:['Planned','neutral'],built:['Built','neutral'],build_failed:['Build failed','bad'],ready:['Ready to print','accent'],needs_approval:['Needs your approval','attention'],approved:['Approved','accent'],printing:['Printing','attention'],answered:['Answered','good'],abandoned:['Abandoned','neutral']};
const OUTCOME={supported:['Prediction supported','good'],refuted:['Prediction refuted','accent'],unresolved:['Unresolved','neutral'],inconclusive:['Inconclusive','neutral']};
const VALIDITY={valid:['Fair comparison','good'],confounded:['Confounded','bad'],unknown:["Can't tell if fair",'attention']};
const REASONS={witness_abnormal:'the witness wall printed abnormally',witness_inconclusive:"the witness wall couldn't be judged",anchor_shifted:'the control reprint came out different',anchor_inconclusive:"the control reprint couldn't be judged",layer_time_mismatch:'the plates spent different time per layer',reference_not_printed:'the reference was never printed',reference_unmeasurable:"the reference plate can't be measured",cross_plate_no_anchor:'compared across plates with no control reprint',cross_plate_by_design:'separate plates are the factor being tested',production_mismatch:'this plate differs from how the tile will be printed'};
const DONE=new Set(['answered','abandoned']);
const badge=([label,tone])=>`<span class="badge badge--${tone}">${esc(label)}</span>`;
const value=v=>Array.isArray(v)?[...new Set(v.map(String))].join('/'):typeof v==='number'?n(v):String(v??'').includes('/')?String(v).split('/').pop():String(v??'');
const when=iso=>{const d=new Date(iso);return isNaN(d)?'':d.toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})};
const ago=iso=>{const m=Math.round((Date.now()-new Date(iso))/60000);return !isFinite(m)?'':m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} days ago`};

let currentProject='';
let currentData=null;
let currentRequests=[];
let currentExp=null;
let currentReqId=null;
let pollTimer=null;
let selectedPhotoFiles=[];
let selectedPhotoTabs=[];
let currentPhotosExp=null;

function makeRequestId(){
  const b=new Uint8Array(8);
  crypto.getRandomValues(b);
  return 'rq-'+Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
}

async function prepareJpeg(file){
  let blob=file;
  try{
    const bmp=await createImageBitmap(file);
    let w=bmp.width,h=bmp.height;
    const max=2400;
    if(w>max||h>max){
      if(w>h){h=Math.round(h*max/w);w=max;}
      else{w=Math.round(w*max/h);h=max;}
    }
    const canvas=document.createElement('canvas');
    canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d');
    ctx.drawImage(bmp,0,0,w,h);
    bmp.close?.();
    blob=await new Promise(res=>canvas.toBlob(res,'image/jpeg',0.9));
  }catch{}
  const buf=await blob.arrayBuffer();
  const hashBuf=await crypto.subtle.digest('SHA-256',buf);
  const sha=Array.from(new Uint8Array(hashBuf),b=>b.toString(16).padStart(2,'0')).join('');
  return {blob,sha};
}

function renderRequestsList(items){
  if(!items||!items.length)return '';
  return items.slice(0,5).map(r=>{
    const tone=r.status==='applied'?'good':r.status==='refused'?'bad':'attention';
    const title=r.kind?(r.kind[0].toUpperCase()+r.kind.slice(1)):'Request';
    return `<div class="lab-request"><span class="badge badge--${tone}">${esc(title)} · ${esc(r.status)}</span>${r.message?` <span class="meta">${esc(r.message)}</span>`:''}</div>`;
  }).join('');
}

function addOrUpdateCardRequest(item){
  if(!item||!item.experiment)return;
  const idx=currentRequests.findIndex(r=>r.id===item.id);
  if(idx>=0)currentRequests[idx]=Object.assign({},currentRequests[idx],item);
  else currentRequests.unshift(item);
  const el=document.getElementById('lab-requests-'+item.experiment);
  if(el){
    const expReqs=currentRequests.filter(r=>r.experiment===item.experiment);
    el.innerHTML=renderRequestsList(expReqs);
  }
}

function validateVerdict(){
  const sendBtn=document.getElementById('labVerdictSend');
  const incToggle=document.getElementById('labVerdictInconclusiveToggle');
  const incReason=document.getElementById('labVerdictInconclusiveReason');
  if(!sendBtn)return;
  if(incToggle&&incToggle.checked){
    document.querySelectorAll('#labVerdictBody .lab-verdict-row').forEach(r=>r.classList.remove('lab-row--missing'));
    sendBtn.disabled=!incReason?.value.trim();
    return;
  }
  let allComplete=true;
  const rows=document.querySelectorAll('#labVerdictBody .lab-verdict-row');
  rows.forEach(row=>{
    let rowComplete=true;
    for(const crit of(currentExp?.criteria||[])){
      const checked=row.querySelector(`button[data-criterion="${crit.key}"][aria-checked="true"]`);
      if(!checked){rowComplete=false;break;}
    }
    if(!rowComplete){
      allComplete=false;
      row.classList.add('lab-row--missing');
    }else{
      row.classList.remove('lab-row--missing');
    }
  });
  sendBtn.disabled=!allComplete;
}

function saveVerdictDraft(){
  if(!currentExp)return;
  const draft={
    grades:{},
    inconclusive:Boolean(document.getElementById('labVerdictInconclusiveToggle')?.checked),
    inconclusiveReason:document.getElementById('labVerdictInconclusiveReason')?.value||'',
    lighting:document.getElementById('labVerdictLighting')?.value||'diagnostic',
    note:document.getElementById('labVerdictNote')?.value||''
  };
  document.querySelectorAll('#labVerdictBody .lab-verdict-row').forEach(row=>{
    const tab=row.dataset.tab;
    draft.grades[tab]={};
    row.querySelectorAll('button[aria-checked="true"]').forEach(btn=>{
      draft.grades[tab][btn.dataset.criterion]=btn.dataset.choice;
    });
  });
  try{
    localStorage.setItem('printLab:draft:'+currentExp.id,JSON.stringify(draft));
  }catch{}
}

function openVerdictSheet(exp){
  currentExp=exp;
  currentReqId=null;
  const sheet=document.getElementById('labVerdictSheet');
  const body=document.getElementById('labVerdictBody');
  const title=document.getElementById('labVerdictTitle');
  if(!sheet||!body)return;
  if(title)title.textContent=`Record verdict · ${exp.id}`;

  const tabs=(exp.variants||[]).map(v=>v.tab||v.id).filter(Boolean);
  body.innerHTML=tabs.map(tab=>{
    const critRows=(exp.criteria||[]).map(c=>`
      <div class="lab-verdict-criterion" role="radiogroup" aria-label="${esc(c.label)} for ${esc(tab)}">
        <span class="lab-verdict-criterion__label">${esc(c.label)}</span>
        <div class="lab-chips">
          ${(c.choices||[]).map(ch=>`<button type="button" class="btn-outline lab-chip" role="radio" aria-checked="false" data-tab="${esc(tab)}" data-criterion="${esc(c.key)}" data-choice="${esc(ch)}">${esc(ch)}</button>`).join('')}
        </div>
      </div>
    `).join('');
    return `<div class="lab-verdict-row" data-tab="${esc(tab)}"><div class="lab-verdict-row__title">Strip ${esc(tab)}</div>${critRows}</div>`;
  }).join('');

  let draft={grades:{},inconclusive:false,inconclusiveReason:'',lighting:'diagnostic',note:''};
  try{
    const saved=localStorage.getItem('printLab:draft:'+exp.id);
    if(saved)draft=Object.assign(draft,JSON.parse(saved));
  }catch{}

  for(const [tab,crits] of Object.entries(draft.grades||{})){
    for(const [critKey,choice] of Object.entries(crits||{})){
      const btn=body.querySelector(`button[data-tab="${tab}"][data-criterion="${critKey}"][data-choice="${choice}"]`);
      if(btn)btn.setAttribute('aria-checked','true');
    }
  }

  const incToggle=document.getElementById('labVerdictInconclusiveToggle');
  const incBox=document.getElementById('labVerdictInconclusiveBox');
  const incReason=document.getElementById('labVerdictInconclusiveReason');
  if(incToggle)incToggle.checked=Boolean(draft.inconclusive);
  if(incBox)incBox.hidden=!draft.inconclusive;
  if(incReason)incReason.value=draft.inconclusiveReason||'';

  const lightingSelect=document.getElementById('labVerdictLighting');
  if(lightingSelect)lightingSelect.value=draft.lighting||'diagnostic';
  const noteInput=document.getElementById('labVerdictNote');
  if(noteInput)noteInput.value=draft.note||'';

  const statusEl=document.getElementById('labVerdictStatus');
  const errorEl=document.getElementById('labVerdictError');
  const replaceBtn=document.getElementById('labVerdictReplace');
  if(statusEl){statusEl.hidden=true;statusEl.textContent='';}
  if(errorEl){errorEl.hidden=true;errorEl.textContent='';}
  if(replaceBtn)replaceBtn.hidden=true;

  validateVerdict();

  if(!sheet.open){
    if(root.LocalAIUI?.showSheet)root.LocalAIUI.showSheet(sheet);
    else sheet.showModal();
  }
}

function pollVerdictResult(project,reqId,expId){
  if(pollTimer)clearInterval(pollTimer);
  const statusEl=document.getElementById('labVerdictStatus');
  const errorEl=document.getElementById('labVerdictError');
  const replaceBtn=document.getElementById('labVerdictReplace');
  const startedAt=Date.now();

  const check=async()=>{
    try{
      const res=await fetch(`/api/lab/${encodeURIComponent(project)}/requests`);
      if(!res.ok)return;
      const data=await res.json();
      const item=(data.items||[]).find(i=>i.id===reqId);
      if(!item)return;

      addOrUpdateCardRequest(item);

      if(item.status==='applied'){
        clearInterval(pollTimer);
        pollTimer=null;
        if(statusEl){statusEl.hidden=false;statusEl.textContent='Recorded';}
        if(errorEl)errorEl.hidden=true;
        try{localStorage.removeItem('printLab:draft:'+expId);}catch{}
        return;
      }

      if(item.status==='refused'){
        clearInterval(pollTimer);
        pollTimer=null;
        if(statusEl)statusEl.hidden=true;
        if(errorEl){
          errorEl.hidden=false;
          errorEl.textContent=item.message||'Verdict refused by the Mac';
        }
        if(item.message&&item.message.includes('already has a verdict')){
          if(replaceBtn)replaceBtn.hidden=false;
        }
        return;
      }

      if(Date.now()-startedAt>120000){
        if(statusEl)statusEl.textContent="The Mac hasn't picked this up. It runs when the Mac is awake.";
      }
    }catch{}
  };

  pollTimer=setInterval(check,500);
  check();
}

async function sendVerdict(isReplace=false){
  if(!currentExp)return;
  const statusEl=document.getElementById('labVerdictStatus');
  const errorEl=document.getElementById('labVerdictError');
  const replaceBtn=document.getElementById('labVerdictReplace');
  const sendBtn=document.getElementById('labVerdictSend');

  let draft={};
  try{draft=JSON.parse(localStorage.getItem('printLab:draft:'+currentExp.id)||'{}');}catch{}

  const reqId=isReplace?makeRequestId():(currentReqId||makeRequestId());
  currentReqId=reqId;

  if(statusEl){statusEl.hidden=false;statusEl.textContent='Waiting for the Mac';}
  if(errorEl){errorEl.hidden=true;errorEl.textContent='';}
  if(replaceBtn)replaceBtn.hidden=true;
  if(sendBtn)sendBtn.disabled=true;

  const payload={
    grades:draft.grades||{},
    lighting:draft.lighting||'diagnostic',
    note:draft.note||null,
    inconclusive:draft.inconclusive?(draft.inconclusiveReason||'unspecified'):null,
    replace:Boolean(isReplace)
  };

  try{
    const res=await fetch(`/api/lab/${encodeURIComponent(currentProject)}/requests`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        id:reqId,
        kind:'verdict',
        experiment:currentExp.id,
        run:currentExp.run||null,
        payload
      })
    });

    if(!res.ok){
      if(res.status===401){
        if(statusEl)statusEl.hidden=true;
        if(errorEl){errorEl.hidden=false;errorEl.textContent="This phone isn't paired with Local AI. Pair it in Settings › Devices.";}
        if(sendBtn)sendBtn.disabled=false;
        return;
      }
      const data=await res.json().catch(()=>({}));
      if(statusEl)statusEl.hidden=true;
      if(errorEl){errorEl.hidden=false;errorEl.textContent=data.error||'Failed to send request';}
      if(sendBtn)sendBtn.disabled=false;
      return;
    }

    addOrUpdateCardRequest({id:reqId,kind:'verdict',experiment:currentExp.id,status:'pending'});
    pollVerdictResult(currentProject,reqId,currentExp.id);
  }catch(err){
    if(statusEl)statusEl.hidden=true;
    if(errorEl){errorEl.hidden=false;errorEl.textContent=err.message||'Network error';}
    if(sendBtn)sendBtn.disabled=false;
  }
}

function openPhotosSheet(exp,files){
  currentPhotosExp=exp;
  selectedPhotoFiles=files;
  selectedPhotoTabs=new Array(files.length).fill(null);
  const sheet=document.getElementById('labPhotosSheet');
  const list=document.getElementById('labPhotosList');
  const title=document.getElementById('labPhotosTitle');
  const statusEl=document.getElementById('labPhotosStatus');
  const errorEl=document.getElementById('labPhotosError');
  const sendBtn=document.getElementById('labPhotosSend');
  if(!sheet||!list)return;

  if(title)title.textContent=`Add photos · ${exp.id}`;
  if(statusEl){statusEl.hidden=true;statusEl.textContent='';}
  if(errorEl){errorEl.hidden=true;errorEl.textContent='';}
  if(sendBtn)sendBtn.disabled=false;

  const tabs=(exp.variants||[]).map(v=>v.tab||v.id).filter(Boolean);
  list.innerHTML=files.map((file,idx)=>{
    const previewUrl=URL.createObjectURL(file);
    const tabChips=tabs.map(t=>`<button type="button" class="btn-outline lab-chip" data-tab="${esc(t)}" aria-checked="false">${esc(t)}</button>`).join('');
    return `<div class="lab-photo-row" data-photo-idx="${idx}"><img class="lab-photo-thumb" src="${previewUrl}" alt="Photo ${idx+1}"><div class="lab-photo-tabs" role="group" aria-label="Select tab for photo ${idx+1}">${tabChips}</div></div>`;
  }).join('');

  if(!sheet.open){
    if(root.LocalAIUI?.showSheet)root.LocalAIUI.showSheet(sheet);
    else sheet.showModal();
  }
}

async function sendPhotos(){
  if(!currentPhotosExp||!selectedPhotoFiles.length)return;
  const sendBtn=document.getElementById('labPhotosSend');
  const statusEl=document.getElementById('labPhotosStatus');
  const errorEl=document.getElementById('labPhotosError');
  const sheet=document.getElementById('labPhotosSheet');

  if(sendBtn)sendBtn.disabled=true;
  if(statusEl){statusEl.hidden=false;statusEl.textContent='Uploading photos…';}
  if(errorEl)errorEl.hidden=true;

  try{
    const uploaded=[];
    for(let i=0;i<selectedPhotoFiles.length;i++){
      const file=selectedPhotoFiles[i];
      const tab=selectedPhotoTabs[i]||null;
      const {blob,sha}=await prepareJpeg(file);
      const putRes=await fetch(`/api/lab/${encodeURIComponent(currentProject)}/incoming/${sha}.jpg`,{
        method:'PUT',
        headers:{'Content-Type':'image/jpeg'},
        body:blob
      });
      if(!putRes.ok){
        if(putRes.status===401)throw new Error("This phone isn't paired with Local AI. Pair it in Settings › Devices.");
        throw new Error('Failed to upload photo');
      }
      uploaded.push({sha256:sha,tab});
    }

    const reqId=makeRequestId();
    const postRes=await fetch(`/api/lab/${encodeURIComponent(currentProject)}/requests`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        id:reqId,
        kind:'photos',
        experiment:currentPhotosExp.id,
        run:currentPhotosExp.run||null,
        payload:{
          run:currentPhotosExp.run||null,
          photos:uploaded
        }
      })
    });

    if(!postRes.ok){
      if(postRes.status===401)throw new Error("This phone isn't paired with Local AI. Pair it in Settings › Devices.");
      throw new Error('Failed to create photos request');
    }

    addOrUpdateCardRequest({id:reqId,kind:'photos',experiment:currentPhotosExp.id,status:'pending'});
    if(sheet.open)sheet.close();
  }catch(err){
    if(statusEl)statusEl.hidden=true;
    if(errorEl){errorEl.hidden=false;errorEl.textContent=err.message||'Failed to upload photos';}
    if(sendBtn)sendBtn.disabled=false;
  }
}

function meter(label,spent,next,total,unit){
 total=Number(total)||1;const a=Math.min(100,100*(spent||0)/total),b=Math.min(100-a,100*(next||0)/total),over=(spent||0)+(next||0)>total+1e-9;
 return `<div class="lab-meter${over?' lab-meter--over':''}"><div class="lab-meter__head"><span>${esc(label)}</span><span>${n(spent)} / ${n(total)} ${unit}</span></div>`
  +`<div class="lab-meter__track" role="img" aria-label="${n(spent)} of ${n(total)} ${unit} used${next?`, the next test adds ${n(next)}`:''}"><span class="lab-meter__spent" style="width:${a.toFixed(1)}%"></span><span class="lab-meter__next" style="width:${b.toFixed(1)}%"></span></div></div>`;
}
const clock=iso=>new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});
// A print still on the printer isn't ready to judge: until its estimated end it says when, and offers no command.
function needView(x,byId){
 const look=`Look at: ${byId[x.id]?.judge_on||'the face'}. Photos help.`;
 if(x.due_at&&Date.now()<new Date(x.due_at))return {action:'Printing',why:`Done about ${clock(x.due_at)} (estimate). Then l${look.slice(1)}`,command:null};
 return {action:x.action,why:x.due_at?look:x.why,command:x.command};
}
function needsHtml(ix,byId){
 if(!ix.needs.length)return '<p class="empty-state">Nothing needs you right now.</p>';
 return `<ul class="list-group lab-needs">${ix.needs.map(n=>{const x={...n,...needView(n,byId)};return `<li class="list-row"><div class="list-row__main"><div class="list-row__title"><a href="#printLab?e=${esc(x.id)}" data-lab-open="${esc(x.id)}">${esc(x.action)} · ${esc(x.id)}</a></div>`
  +`<div class="list-row__sub">${esc(byId[x.id]?.question_text)}</div><div class="list-row__sub">${esc(x.why)}</div>`
  +(x.command?`<div class="lab-cmd"><code>${esc(x.command)}</code><button type="button" class="btn-outline lab-copy" data-copy="${esc(x.command)}" aria-label="Copy the command for ${esc(x.id)}">Copy</button></div>`:'')+'</div></li>'}).join('')}</ul>`;
}
function questionHtml(q,byId){
 const s=q.spent,b=q.budget,nx=q.next,st=q.stop,ev=q.evidence;
 const cur=[...q.experiments].reverse().map(i=>byId[i]).find(x=>x&&!DONE.has(x.status));
 const stop=st.kind?`<p class="lab-stop lab-stop--${st.kind==='owner'?'bad':'attention'}">${esc(st.text[0].toUpperCase()+st.text.slice(1))}</p>`:'<p class="lab-stop">Continue: nothing has stopped this question.</p>';
 return `<section class="card lab-question"><p class="meta">${esc(q.id)} · ${q.answered} of ${q.experiments.length} answered · ${ev.informative} informative, ${ev.uninformative} not</p><h2>${esc(q.question)}</h2>`
  +meter('Time',s.minutes,nx&&nx.minutes,b.minutes,'min')+meter('Material',s.g,nx&&nx.g,b.g,'g')
  +(nx?`<p class="meta">${esc(nx.id)} would add ${n(nx.minutes)} min, ${n(nx.g)} g</p>`:'')+stop
  +(cur?`<div class="lab-now"><p class="meta"><a href="#printLab?e=${esc(cur.id)}" data-lab-open="${esc(cur.id)}">${esc(cur.id)}</a> ${badge(STATUS[cur.status]||[cur.status,'neutral'])}</p><p class="lab-now__q">${esc(cur.question_text)}</p>${cur.why_this_test?`<p class="meta"><b>Why this test?</b> ${esc(cur.why_this_test)}</p>`:''}</div>`:'')
  +'</section>';
}
function photoUrl(project,p){return `/api/lab/${encodeURIComponent(project)}/photo/${esc(p.sha256)}.jpg`}
function experimentHtml(x,project,requests=currentRequests){
 const f=x.factor||{},b=[badge(STATUS[x.status]||[x.status,'neutral'])];
 if(x.outcome){b.push(badge(OUTCOME[x.outcome]||[x.outcome,'neutral']));if(x.validity)b.push(badge(VALIDITY[x.validity.status]||[x.validity.status,'neutral']))}
 if(x.verdict&&x.verdict.kind==='acceptance')b.push(badge(x.verdict.good_enough?['Accepted','good']:['Not good enough','bad']));
 const meta=[(x.test_kind||'').replace(/_/g,' '),f.name?`${f.name.replace(/_/g,' ')}: ${(f.values||[]).map(value).join(' vs ')}`:'',x.provenance!=='prospective'?x.provenance:''].filter(Boolean).join(' · ');
 const vars=x.variants.map(v=>{const u=v.unit?` ${v.unit}`:'',name=v.tab||v.id;return `<li>${esc(name)}: ${v.realized!=null&&v.as_asked===false?`${esc(value(v.requested))} asked, ${n(v.realized)} printed${esc(u)}`:`${esc(v.realized!=null?n(v.realized):value(v.requested))}${esc(u)}`}</li>`}).join('');
 const cost=[x.estimate&&`estimated ${n(x.estimate.minutes)} min, ${n(x.estimate.g)} g`,x.usage&&`used ${n(x.usage.minutes)} min, ${n(x.usage.g)} g`,x.layer_time_median_s&&`${n(x.layer_time_median_s)} s per layer`].filter(Boolean).join(', ');
 const why=x.outcome&&x.validity?x.validity.reasons.map(r=>REASONS[r.code]||r.code).join('; '):'';
 const v=x.verdict,said=v&&(v.note||(v.kind==='acceptance'?(v.good_enough?'good enough':'not good enough'):v.kind));
 const shots=x.photos.filter(p=>p.sha256).map((p,i)=>`<a href="${photoUrl(project,p)}" target="_blank" rel="noopener"${i?'':' class="lab-shots__first"'}><img src="${photoUrl(project,p)}" alt="${esc(x.id)} print ${esc(p.run)}" loading="lazy"></a>`).join('');
 const guards=((x.check||{}).guards||[]).filter(g=>!g.ok).map(g=>`<li class="lab-guard--${g.result==='blocked'?'bad':'attention'}">${esc(g.message)}</li>`).join('');
 const dl=[['Hypothesis',x.hypothesis],['Prediction',x.prediction],['Why this test',x.why_this_test],['Judge on',x.judge_on],['Abandoned because',x.abandoned_reason],['Filament',x.filament]].filter(r=>r[1]).map(([k,t])=>`<dt>${esc(k)}</dt><dd>${esc(t)}</dd>`).join('');

 let actions='';
 if(x.status==='printing'&&!x.verdict){
   const hint='<p class="meta lab-light-hint">Raking light from one side, same distance, tab in frame.</p>';
   const addBtn=`<button type="button" class="btn-outline lab-add-photos" data-exp="${esc(x.id)}">Add photos</button><input type="file" accept="image/*" multiple class="visually-hidden" aria-label="Add photos for ${esc(x.id)}" data-exp="${esc(x.id)}">`;
   const verdictBtn=(x.criteria&&x.criteria.length)?`<button type="button" class="btn-outline lab-record-verdict" data-exp="${esc(x.id)}">Record verdict</button>`:'';
   const expReqs=(requests||[]).filter(r=>r.experiment===x.id);
   const reqsHtml=`<div class="lab-requests" id="lab-requests-${esc(x.id)}" aria-live="polite">${renderRequestsList(expReqs)}</div>`;
   actions=`${hint}<div class="lab-actions">${addBtn}${verdictBtn}</div>${reqsHtml}`;
 }

 return `<article class="card lab-exp" id="lab-${esc(x.id)}"><header class="lab-exp__head"><span class="lab-exp__id">${esc(x.id)}</span>${b.join('')}</header><h3>${esc(x.question_text)}</h3><p class="meta">${esc(meta)}</p>`
  +(vars?`<ul class="lab-variants">${vars}</ul>`:'')+(cost?`<p class="meta">${esc(cost)}</p>`:'')+(why?`<p class="meta">Why: ${esc(why)}</p>`:'')
  +(said?`<p class="lab-verdict">Your verdict: ${esc(said)} <span class="meta">${esc(when(v.at))}</span></p>`:'')
  +(v&&v.defects&&v.defects.length?`<p class="meta lab-defects">Defects: ${esc(v.defects.join('; '))}</p>`:'')
  +actions
  +(shots?`<div class="lab-shots">${shots}</div>`:'')
  +`<details class="lab-details" data-lab-details="${esc(x.id)}"><summary>Details</summary><dl>${dl}</dl>${guards?`<h4>Last check (${esc(String(x.check.status||'').replace(/_/g,' '))})</h4><ul class="lab-guards">${guards}</ul>`:''}</details></article>`;
}
function render(data,requests=currentRequests){
 const ix=data.index,meta=data.meta||{},byId=Object.fromEntries(ix.experiments.map(x=>[x.id,x]));
 const open=ix.questions.filter(q=>!['answered','stopped'].includes(q.status)),recent=x=>x.status==='answered'&&x.verdict&&Date.now()-new Date(x.verdict.at)<3*864e5;
 // Answered in the last three days stays in view: the newest result is what the owner comes to check.
 const active=ix.experiments.filter(x=>!DONE.has(x.status)||recent(x)),earlier=ix.experiments.filter(x=>DONE.has(x.status)&&!recent(x));
 const stale=meta.synced_at&&Date.now()-new Date(meta.synced_at)>2*3600e3;
 return `<p class="meta lab-synced${stale?' lab-synced--stale':''}">Synced from the Mac ${esc(ago(meta.synced_at))}${stale?'. The Mac may be asleep.':''}</p>`
  +(ix.problems.length?`<div class="banner lab-problems" role="alert"><strong>Records the Mac can't read</strong><ul>${ix.problems.map(p=>`<li><b>${esc(p.file)}</b> ${esc(p.error)}</li>`).join('')}</ul></div>`:'')
  +`<div class="lab-layout"><div class="lab-side"><section class="card lab-needs-card"><h2>Needs you</h2>${needsHtml(ix,byId)}</section>`
  +(open.map(q=>questionHtml(q,byId)).join('')||'<section class="card"><div class="empty-state"><div class="empty-state__title">No open question.</div><div>Start one on the Mac with lab question new.</div></div></section>')
  +`</div><div class="lab-notebook"><h2>Notebook</h2>${active.map(x=>experimentHtml(x,ix.project,requests)).join('')||'<p class="empty-state">No open experiments.</p>'}`
  +(earlier.length?`<details class="lab-earlier"><summary>Earlier (${earlier.length})</summary>${earlier.map(x=>experimentHtml(x,ix.project,requests)).join('')}</details>`:'')+'</div></div>';
}
function openExperiment(id){
 const card=document.getElementById(`lab-${id}`);if(!card)return;
 const earlier=card.closest('.lab-earlier');if(earlier)earlier.open=true;
 const d=card.querySelector('.lab-details');if(d)d.open=true;
 card.scrollIntoView({block:'start'});card.setAttribute('tabindex','-1');card.focus({preventScroll:true});
}
async function refresh(){
 const box=document.getElementById('printLabBody'),UI=root.LocalAIUI;if(!box||!UI)return;
 await UI.loadInto(box,async()=>{
  const {projects}=await UI.fetchJson('/api/lab/projects');
  if(!projects.length)return null;
  const pName=projects[0].name;
  currentProject=pName;
  const [labData,reqData]=await Promise.all([
    UI.fetchJson(`/api/lab/${encodeURIComponent(pName)}`),
    fetch(`/api/lab/${encodeURIComponent(pName)}/requests`).then(r=>r.ok?r.json():{items:[]}).catch(()=>({items:[]}))
  ]);
  currentRequests=(reqData&&reqData.items)||[];
  currentData=labData;
  return labData;
 },{what:'the print lab',empty:'No lab data yet. Run lab sync on the Mac.',render:(c,data)=>{if(!data)return false;c.innerHTML=render(data,currentRequests);const e=new URLSearchParams(location.hash.split('?')[1]||'').get('e');if(e)openExperiment(e)}}).catch(()=>{});
}

function sheetsHtml(){
  return `
<dialog id="labVerdictSheet" class="lab-sheet" aria-labelledby="labVerdictTitle">
  <form method="dialog" class="lab-sheet__form">
    <div class="lab-sheet__head">
      <h2 id="labVerdictTitle" class="lab-sheet__title">Record verdict</h2>
      <button type="button" id="labVerdictCancel" class="btn-outline" aria-label="Cancel verdict">Cancel</button>
    </div>
    <div id="labVerdictBody" class="lab-sheet__body"></div>
    <div class="lab-sheet__section">
      <label class="lab-checkbox-label">
        <input type="checkbox" id="labVerdictInconclusiveToggle">
        <span>Print failed or can&#39;t tell</span>
      </label>
      <div id="labVerdictInconclusiveBox" class="lab-sheet__field" hidden>
        <label for="labVerdictInconclusiveReason">Reason</label>
        <input type="text" id="labVerdictInconclusiveReason" placeholder="e.g. bed adhesion failure">
      </div>
    </div>
    <div class="lab-sheet__section">
      <div class="lab-sheet__field">
        <label for="labVerdictLighting">Light used</label>
        <select id="labVerdictLighting">
          <option value="diagnostic" selected>Diagnostic (raking light from one side)</option>
          <option value="room">Room light</option>
          <option value="installed">Installed (where the tile will live)</option>
        </select>
      </div>
      <div class="lab-sheet__field">
        <label for="labVerdictNote">Note</label>
        <input type="text" id="labVerdictNote" placeholder="What you see">
      </div>
    </div>
    <p id="labVerdictStatus" class="lab-sheet__status" role="status" aria-live="polite" hidden></p>
    <p id="labVerdictError" class="lab-sheet__error" role="alert" hidden></p>
    <div class="lab-sheet__actions">
      <button type="button" id="labVerdictReplace" class="btn-outline" hidden>Replace verdict</button>
      <button type="button" id="labVerdictSend" class="btn-primary" disabled>Send to the Mac</button>
    </div>
  </form>
</dialog>
<dialog id="labPhotosSheet" class="lab-sheet" aria-labelledby="labPhotosTitle">
  <form method="dialog" class="lab-sheet__form">
    <div class="lab-sheet__head">
      <h2 id="labPhotosTitle" class="lab-sheet__title">Add photos</h2>
      <button type="button" id="labPhotosCancel" class="btn-outline" aria-label="Cancel photos">Cancel</button>
    </div>
    <p class="meta lab-sheet__hint">Choose which tab each photo shows:</p>
    <div id="labPhotosList" class="lab-sheet__body"></div>
    <p id="labPhotosStatus" class="lab-sheet__status" role="status" aria-live="polite" hidden></p>
    <p id="labPhotosError" class="lab-sheet__error" role="alert" hidden></p>
    <div class="lab-sheet__actions">
      <button type="button" id="labPhotosSend" class="btn-primary">Send photos</button>
    </div>
  </form>
</dialog>`;
}

function init(){
 const sec=document.getElementById('printLab');if(!sec)return;

 if(!document.getElementById('labVerdictSheet')){
   sec.insertAdjacentHTML('beforeend',sheetsHtml());
 }

 sec.addEventListener('click',e=>{
  const c=e.target.closest('[data-copy]');
  if(c){const t=c.dataset.copy,done=()=>root.LocalAIUI?.toast?.('Copied. Paste it in Terminal on the Mac.');
   if(navigator.clipboard&&root.isSecureContext)navigator.clipboard.writeText(t).then(done,()=>{});else{const code=c.previousElementSibling;const r=document.createRange();r.selectNodeContents(code);const s=getSelection();s.removeAllRanges();s.addRange(r)}return}
  const o=e.target.closest('[data-lab-open]');if(o){e.preventDefault();history.replaceState(history.state,'',`#printLab?e=${o.dataset.labOpen}`);openExperiment(o.dataset.labOpen);return}
  const addBtn=e.target.closest('.lab-add-photos');
  if(addBtn){
    const expId=addBtn.dataset.exp;
    const input=sec.querySelector(`input[type="file"][data-exp="${expId}"]`);
    if(input)input.click();
    return;
  }
  const recBtn=e.target.closest('.lab-record-verdict');
  if(recBtn){
    const expId=recBtn.dataset.exp;
    const exp=currentData?.index?.experiments?.find(x=>x.id===expId);
    if(exp)openVerdictSheet(exp);
    return;
  }
 });

 sec.addEventListener('change',e=>{
   const fileInput=e.target.closest('input[type="file"][data-exp]');
   if(fileInput&&fileInput.files&&fileInput.files.length){
     const expId=fileInput.dataset.exp;
     const exp=currentData?.index?.experiments?.find(x=>x.id===expId);
     if(exp)openPhotosSheet(exp,Array.from(fileInput.files));
     fileInput.value='';
   }
 });

 const verdictSheet=document.getElementById('labVerdictSheet');
 if(verdictSheet){
   verdictSheet.addEventListener('click',e=>{
     const chip=e.target.closest('#labVerdictBody button[data-choice]');
     if(chip){
       const wrap=chip.closest('.lab-chips');
       if(wrap)wrap.querySelectorAll('button').forEach(b=>b.setAttribute('aria-checked',b===chip?'true':'false'));
       saveVerdictDraft();
       validateVerdict();
       return;
     }
     if(e.target.closest('#labVerdictCancel')){
       verdictSheet.close();
       if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
       return;
     }
     if(e.target.closest('#labVerdictSend')){
       sendVerdict(false);
       return;
     }
     if(e.target.closest('#labVerdictReplace')){
       sendVerdict(true);
       return;
     }
   });

   const incToggle=document.getElementById('labVerdictInconclusiveToggle');
   const incBox=document.getElementById('labVerdictInconclusiveBox');
   const incReason=document.getElementById('labVerdictInconclusiveReason');
   if(incToggle){
     incToggle.addEventListener('change',()=>{
       if(incBox)incBox.hidden=!incToggle.checked;
       saveVerdictDraft();
       validateVerdict();
     });
   }
   if(incReason){
     incReason.addEventListener('input',()=>{
       saveVerdictDraft();
       validateVerdict();
     });
   }
   const lightingSelect=document.getElementById('labVerdictLighting');
   if(lightingSelect)lightingSelect.addEventListener('change',saveVerdictDraft);
   const noteInput=document.getElementById('labVerdictNote');
   if(noteInput)noteInput.addEventListener('input',saveVerdictDraft);
 }

 const photosSheet=document.getElementById('labPhotosSheet');
 if(photosSheet){
   photosSheet.addEventListener('click',e=>{
     const tabBtn=e.target.closest('.lab-photo-row button[data-tab]');
     if(tabBtn){
       const row=tabBtn.closest('.lab-photo-row');
       const idx=Number(row.dataset.photoIdx);
       selectedPhotoTabs[idx]=tabBtn.dataset.tab;
       row.querySelectorAll('button[data-tab]').forEach(b=>b.setAttribute('aria-checked',b===tabBtn?'true':'false'));
       return;
     }
     if(e.target.closest('#labPhotosCancel')){
       photosSheet.close();
       return;
     }
     if(e.target.closest('#labPhotosSend')){
       sendPhotos();
       return;
     }
   });
 }

 const active=()=>sec.classList.contains('active');let was=active();
 new MutationObserver(()=>{const now=active();if(now&&!was)refresh();was=now}).observe(sec,{attributes:true,attributeFilter:['class']});
 if(was)refresh();
}
root.LocalAIPrintLab={render,refresh};
if(typeof module==='object'&&module.exports)module.exports={render};
else if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(typeof window!=='undefined'?window:globalThis);
