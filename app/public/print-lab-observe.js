// Projects › Print lab: "Record what happened" (Figma board 06), the phone form for observations.
// One guided session per printed pair or strip: identify the part, then only the questions that belong to each subject
// (the pair: separation and overall; each tile: face, back and mounting; a strip: face, separation and overall), then
// the light. Nothing is preselected; every question also offers "Not looked at", "Couldn't tell" and "Doesn't apply"
// (which asks why). The draft lives on the phone until the Mac records it; the request id is made once and reused, so
// a retry after a lost answer is the same request. Spec: print-lab docs/superpowers/specs/
// 2026-10-26-observation-records-design.md (rev 2). Text from the Mac is shown escaped, never as markup.
(function(root){'use strict';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const VALUES={
  face:[['clean','Clean'],['flawed','Flawed'],['failed','Failed']],
  separation:[['easily','Came apart easily'],['effort','With effort'],['no',"Didn't come apart"]],
  backing:[['whole','Whole'],['marked','Marked'],['damaged','Damaged']],
  mounting:[['fits','Mounts'],['needs_work','Needs work'],['unusable',"Can't be mounted"]],
  acceptance:[['accepted','Accepted'],['accepted_with_defects','Accepted with defects'],['rejected','Rejected']]
};
const MISSING=[['not_assessed','Not looked at'],['unknown',"Couldn't tell"],['not_applicable',"Doesn't apply"]];
const LABEL={face:'Face',separation:'Separation',backing:'Back',mounting:'Mounting',acceptance:'Overall'};
const LIGHTS=[['diagnostic','Diagnostic (raking light from one side)'],['room','Room light'],['installed','Installed, where the tile will live'],['unknown','Not sure']];
const PAIRED=new Set(['full_part','scaled_part']);
const PICKUP="The Mac hasn't picked this up yet. It runs when the Mac is awake; your answers are kept.";

let ctx=null,poll=null;

const draftKey=(p,e)=>`printLab:observe:${p}:${e}`;
const loadDraft=(p,e)=>{try{return JSON.parse(localStorage.getItem(draftKey(p,e))||'{}')}catch{return {}}};
const saveDraft=()=>{if(!ctx)return;try{localStorage.setItem(draftKey(ctx.project,ctx.exp.id),JSON.stringify(ctx.draft))}catch{}};
const clearDraft=()=>{if(!ctx)return;try{localStorage.removeItem(draftKey(ctx.project,ctx.exp.id))}catch{}};

function makeRequestId(){const b=new Uint8Array(8);crypto.getRandomValues(b);return 'rq-'+Array.from(b,x=>x.toString(16).padStart(2,'0')).join('')}

// The subjects this session asks about, each with the outcomes that belong to it (spec: "Subjects and the outcomes").
function plan(exp){
  return PAIRED.has(exp.test_kind)
    ?[{key:'pair',kind:'pair',title:'The pair',outcomes:['separation','acceptance']},
      {key:'tile1',kind:'tile',title:'One tile',side:true,outcomes:['face','backing','mounting']},
      {key:'tile2',kind:'tile',title:'The other tile',side:true,outcomes:['face','backing','mounting']}]
    :[{key:'strip',kind:'strip',title:'The strip',outcomes:['face','separation','acceptance']}];
}

function radios(name,legend,options,checked,extra=''){
  return `<fieldset class="lab-obs__q" data-q="${esc(name)}"><legend>${esc(legend)}</legend>${extra}<div class="lab-obs__opts">`
    +options.map(([v,l])=>`<label class="lab-obs__opt"><input type="radio" name="${esc(name)}" value="${esc(v)}"${checked===v?' checked':''}><span>${esc(l)}</span></label>`).join('')
    +`</div></fieldset>`;
}

function outcomeHtml(subj,o,d){
  const name=`${subj.key}.${o}`,a=(d.answers||{})[name]||{};
  const note=a.status==='not_applicable'||a.status==='unknown'||a.value==='flawed'||a.value==='accepted_with_defects';
  return radios(name,LABEL[o],[...VALUES[o],...MISSING],a.value||a.status)
    +`<div class="lab-sheet__field lab-obs__note"${note?'':' hidden'} data-note="${esc(name)}"><label for="obsNote-${esc(name)}">${a.status==='not_applicable'?'Why it doesn\'t apply':'What you see'}</label>`
    +`<input type="text" id="obsNote-${esc(name)}" maxlength="300" data-note-input="${esc(name)}" value="${esc(a.note||'')}"></div>`;
}

function formHtml(){
  const {exp,draft:d}=ctx;
  const parts=(exp.variants||[]).map(v=>[v.id,`Plate position ${v.tab||v.id}`]);
  const ident=radios('identified','How do you know which part this is?',[['confirmed','I read its label or tab'],['assumed','By where it sat on the plate'],['unidentified',"I can't tell"]],d.identified)
    +`<div class="lab-sheet__field lab-obs__note"${d.identified==='unidentified'?'':' hidden'} data-note="identified"><label for="obsIdentNote">What you know about it</label><input type="text" id="obsIdentNote" maxlength="300" data-note-input="identified" value="${esc(d.identNote||'')}"></div>`;
  const which=parts.length?radios('variant','Which part',parts,d.variant):'';
  const label=`<div class="lab-sheet__field"><label for="obsLabel">Label you can read on the part (if any)</label><input type="text" id="obsLabel" maxlength="40" value="${esc(d.label||'')}"></div>`;
  const subjects=plan(exp).map(s=>`<section class="lab-sheet__section lab-obs__subject" data-subject="${esc(s.key)}"><h3 class="lab-verdict-row__title">${esc(s.title)}</h3>`
    +(s.side?radios(`${s.key}.side`,'Which side',[['left','Left'],['right','Right'],['unknown',"Can't tell"]],(d.sides||{})[s.key]):'')
    +s.outcomes.map(o=>outcomeHtml(s,o,d)).join('')+`</section>`).join('');
  const light=radios('light','Light you looked under',LIGHTS,d.light);
  const words=`<div class="lab-sheet__field"><label for="obsWords">In your own words (optional)</label><textarea id="obsWords" rows="2" maxlength="1000">${esc(d.words||'')}</textarea></div>`;
  return `<section class="lab-sheet__section" data-subject="identify"><h3 class="lab-verdict-row__title">Identify the part</h3>${which}${ident}${label}</section>`
    +subjects+`<section class="lab-sheet__section" data-subject="conditions"><h3 class="lab-verdict-row__title">How you looked</h3>${light}${words}</section>`;
}

// The first unanswered question, in the order the form asks them; null when everything is answered.
function missing(){
  const {exp,draft:d}=ctx,ans=d.answers||{};
  if((exp.variants||[]).length&&!d.variant)return ['variant','Which part'];
  if(!d.identified)return ['identified','How you know which part'];
  if(d.identified==='unidentified'&&!(d.identNote||'').trim())return ['identified','What you know about the part'];
  for(const s of plan(exp)){
    if(s.side&&!(d.sides||{})[s.key])return [`${s.key}.side`,`${s.title}: which side`];
    for(const o of s.outcomes){
      const a=ans[`${s.key}.${o}`];
      if(!a||!(a.value||a.status))return [`${s.key}.${o}`,`${s.title}: ${LABEL[o]}`];
      if(a.status==='not_applicable'&&!(a.note||'').trim())return [`${s.key}.${o}`,`${s.title}: why ${LABEL[o].toLowerCase()} doesn't apply`];
    }
  }
  if(!d.light)return ['light','The light'];
  return null;
}

function snapshots(){
  const {exp,draft:d}=ctx,ans=d.answers||{};
  const variant=d.variant||null,v=(exp.variants||[]).find(x=>x.id===variant);
  const base={experiment:exp.id,run:exp.run||null,build:exp.shown_build||null,variant,
    label:(d.label||'').trim()||null,identified:d.identified,note:d.identified==='unidentified'?(d.identNote||'').trim():null};
  const source={kind:'owner_report',words:(d.words||'').trim(),evidence:[],occurred_at:null,attributed_by:'phone_session'};
  return plan(exp).map(s=>{
    const outcomes={};
    for(const o of ALLOWED[s.kind]){
      const a=ans[`${s.key}.${o}`];
      outcomes[o]=!a?{status:'not_assessed',value:null,note:null}
        :a.value?{status:'assessed',value:a.value,note:(a.note||'').trim()||null}
          :{status:a.status,value:null,note:(a.note||'').trim()||null};
    }
    const side=s.side?((d.sides||{})[s.key]==='unknown'?null:(d.sides||{})[s.key]):null;
    const subject={...base,kind:s.kind,tile:side,label:base.label||(v?v.tab:null)};
    if(s.side&&!side&&subject.identified!=='unidentified')subject.note=(subject.note?subject.note+'; ':'')+"which side isn't known";
    return {subject,viewing:{light:d.light},outcomes,source};
  });
}
// Every outcome a subject can carry is in every snapshot (spec: complete snapshots); unasked ones are not_assessed.
const ALLOWED={tile:['face','backing','mounting','acceptance'],pair:['separation','acceptance'],strip:['face','separation','acceptance'],run:['acceptance']};

function render(){
  const sheet=document.getElementById('labObserveSheet');if(!sheet||!ctx)return;
  sheet.querySelector('#labObserveTitle').textContent=`Record what happened · ${ctx.exp.id}`;
  sheet.querySelector('#labObserveBody').innerHTML=formHtml();
  refresh();
}

function refresh(){
  const m=missing(),send=document.getElementById('labObserveSend'),hint=document.getElementById('labObserveMissing');
  if(send)send.disabled=Boolean(m)||Boolean(ctx.sending);
  if(hint){hint.hidden=!m;hint.innerHTML=m?`Still to answer: <a href="#" data-goto="${esc(m[0])}">${esc(m[1])}</a>`:'';}
}

function onChange(e){
  if(!ctx)return;
  const t=e.target,d=ctx.draft;
  if(t.type==='radio'){
    const name=t.name;
    if(name==='variant')d.variant=t.value;
    else if(name==='identified'){d.identified=t.value;toggleNote('identified',t.value==='unidentified')}
    else if(name==='light')d.light=t.value;
    else if(name.endsWith('.side')){d.sides={...(d.sides||{}),[name.split('.')[0]]:t.value}}
    else{
      const o=name.split('.')[1],isValue=VALUES[o].some(([v])=>v===t.value);
      const prev=(d.answers||{})[name]||{};
      d.answers={...(d.answers||{}),[name]:isValue?{value:t.value,note:prev.note||''}:{status:t.value,note:prev.note||''}};
      toggleNote(name,t.value==='not_applicable'||t.value==='unknown'||t.value==='flawed'||t.value==='accepted_with_defects',t.value==='not_applicable');
    }
  }else if(t.dataset.noteInput){
    const k=t.dataset.noteInput;
    if(k==='identified')d.identNote=t.value;
    else d.answers={...(d.answers||{}),[k]:{...((d.answers||{})[k]||{}),note:t.value}};
  }else if(t.id==='obsLabel')d.label=t.value;
  else if(t.id==='obsWords')d.words=t.value;
  saveDraft();refresh();
}

function toggleNote(name,show,whyLabel){
  const box=document.querySelector(`#labObserveBody [data-note="${CSS.escape(name)}"]`);if(!box)return;
  box.hidden=!show;
  if(whyLabel!==undefined){const l=box.querySelector('label');if(l)l.textContent=whyLabel?"Why it doesn't apply":'What you see'}
}

function status(text,isError){
  const s=document.getElementById('labObserveStatus'),err=document.getElementById('labObserveError');
  if(isError){if(s){s.hidden=true;s.textContent=''}if(err){err.hidden=false;err.textContent=text}}
  else{if(err){err.hidden=true;err.textContent=''}if(s){s.hidden=!text;s.textContent=text||''}}
}

async function send(){
  if(!ctx||missing())return;
  const d=ctx.draft;
  d.requestId=d.requestId||makeRequestId();
  d.sentSnapshots=snapshots();  // what was sent with this id; a retry sends exactly this again
  saveDraft();
  ctx.sending=true;refresh();
  status('Waiting for the Mac');
  try{
    const res=await fetch(`/api/lab/${encodeURIComponent(ctx.project)}/requests`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:d.requestId,kind:'observation',experiment:ctx.exp.id,run:ctx.exp.run||null,payload:{snapshots:d.sentSnapshots}})});
    if(res.status===401){ctx.sending=false;refresh();status("This phone isn't paired with Local AI. Pair it in Settings › Devices.",true);return}
    if(!res.ok){const b=await res.json().catch(()=>({}));ctx.sending=false;refresh();status(b.error||`Local AI refused it (${res.status}). Your answers are kept.`,true);return}
    watch(d.requestId);
  }catch{
    ctx.sending=false;refresh();
    status("Couldn't reach Local AI. Your answers are kept; send again when you're back online.",true);
  }
}

function watch(id){
  if(poll)clearInterval(poll);
  const started=Date.now(),project=ctx.project;
  const check=async()=>{
    try{
      const res=await fetch(`/api/lab/${encodeURIComponent(project)}/requests`);if(!res.ok)return;
      const item=((await res.json()).items||[]).find(i=>i.id===id);if(!item||!ctx)return;
      if(item.status==='applied'){clearInterval(poll);poll=null;ctx.sending=false;clearDraft();ctx.draft={};status(`Recorded. ${item.message||''}`.trim());refresh();return}
      if(item.status==='refused'||item.status==='conflict'){
        clearInterval(poll);poll=null;ctx.sending=false;
        // The Mac said no: keep the answers, and let the next send be a new request.
        delete ctx.draft.requestId;delete ctx.draft.sentSnapshots;saveDraft();refresh();
        status(item.message||'The Mac refused it. Your answers are kept.',true);return;
      }
      if(Date.now()-started>120000)status(PICKUP);
    }catch{}
  };
  poll=setInterval(check,1000);check();
}

async function open(project,expId){
  let exp=null;
  try{const res=await fetch(`/api/lab/${encodeURIComponent(project)}`);if(res.ok){const b=await res.json();exp=((b.index||{}).experiments||[]).find(x=>x.id===expId)||null}}catch{}
  if(!exp){root.LocalAIUI?.toast?.("Couldn't load this experiment; check the connection.");return}
  ctx={project,exp,draft:loadDraft(project,expId),sending:false};
  ensureSheet();render();
  const sheet=document.getElementById('labObserveSheet');
  if(ctx.draft.requestId){status('Waiting for the Mac');ctx.sending=true;refresh();watch(ctx.draft.requestId)}
  else status('');
  const stop=()=>{if(poll){clearInterval(poll);poll=null}};  // the draft stays; only the polling stops
  if(!sheet.open){if(root.LocalAIUI?.showSheet)root.LocalAIUI.showSheet(sheet,stop);else sheet.showModal()}
}

function ensureSheet(){
  if(document.getElementById('labObserveSheet'))return;
  const host=document.getElementById('printLab');if(!host)return;
  host.insertAdjacentHTML('beforeend',`<dialog id="labObserveSheet" class="lab-sheet lab-obs" aria-labelledby="labObserveTitle">
  <form method="dialog" class="lab-sheet__form">
    <div class="lab-sheet__head"><h2 id="labObserveTitle" class="lab-sheet__title">Record what happened</h2>
      <button type="button" id="labObserveClose" class="btn-outline">Close</button></div>
    <p class="lab-sheet__hint">Answer what you looked at. Nothing is chosen for you; "Not looked at" is a fine answer.</p>
    <div id="labObserveBody" class="lab-sheet__body"></div>
    <p id="labObserveMissing" class="lab-sheet__hint" hidden></p>
    <p id="labObserveStatus" class="lab-sheet__status" role="status" aria-live="polite" hidden></p>
    <p id="labObserveError" class="lab-sheet__error" role="alert" hidden></p>
    <div class="lab-sheet__actions"><button type="button" id="labObserveSend" class="btn-primary" disabled>Send to the Mac</button></div>
  </form></dialog>`);
  const sheet=document.getElementById('labObserveSheet');
  sheet.addEventListener('change',onChange);
  sheet.addEventListener('input',e=>{if(e.target.matches('input[type="text"],textarea'))onChange(e)});
  sheet.addEventListener('click',e=>{
    if(e.target.closest('#labObserveSend')){e.preventDefault();send();return}
    if(e.target.closest('#labObserveClose')){e.preventDefault();if(poll){clearInterval(poll);poll=null}sheet.close();return}
    const g=e.target.closest('[data-goto]');
    if(g){e.preventDefault();const q=sheet.querySelector(`[data-q="${CSS.escape(g.dataset.goto)}"] input`);if(q){q.focus();q.scrollIntoView({block:'center'})}}
  });
}

function init(){
  const sec=document.getElementById('printLab');if(!sec||sec.dataset.obsReady)return;
  sec.dataset.obsReady='1';
  sec.addEventListener('click',e=>{const b=e.target.closest('.lab-observe');if(b){e.preventDefault();open(b.dataset.project,b.dataset.exp)}});
}

root.PrintLabObserve={open,_plan:plan};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
