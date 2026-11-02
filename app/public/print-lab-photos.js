// Print lab: photos at the centre of judging. Thumbnails on each notebook item (up to 6, then "+n", grouped by
// tab), a full-screen viewer (swipe or arrow keys, pinch or double-tap zoom), Compare (two runs of the same question side
// by side, paired by tab, zoom and pan linked; by default the last "good enough" run, else the previous one) and the
// judging checklist (ticks kept on this device only: a memory aid, not a record). Loaded with print-lab.js (ui.js);
// print-lab.js leaves [data-lab-photos] and [data-lab-checklist] and calls mount() after each render. Tabs, runs and
// judge_on come from the Mac's records and are escaped or set as text.
(function(root){'use strict';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LIGHT=['Raking light from one side','Same distance','Tab in frame'];
const SHA=/^[0-9a-f]{64}$/;
let data=null;
const exps=()=>(data&&data.index&&data.index.experiments)||[];
const url=p=>`/api/lab/${encodeURIComponent(data.index.project)}/photo/${p.sha256}.jpg`;
const label=p=>`${p.tab||'No tab'} · ${p.run}`;
// A tab's photos together, tabs in order, photos without a tab last; otherwise as the Mac listed them.
function photosOf(x){
 const ph=(x.photos||[]).filter(p=>p&&SHA.test(p.sha256));
 return ph.map((p,i)=>[p,i]).sort((a,b)=>(a[0].tab||'￿').localeCompare(b[0].tab||'￿')||a[1]-b[1]).map(a=>a[0]);
}
// The runs with photos among the experiments of one question, oldest first.
function runsOf(q){
 const out=[];
 for(const x of exps()){
  if(x.question!==q)continue;
  const ph=photosOf(x);
  for(const run of new Set(ph.map(p=>p.run)))out.push({run,x,at:((x.runs||[]).find(r=>r.id===run)||{}).started_at||'',good:Boolean(x.verdict&&x.verdict.good_enough===true),photos:ph.filter(p=>p.run===run)});
 }
 return out.sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:0);
}
function thumbsHtml(x){
 const ph=photosOf(x);if(!ph.length)return '';
 const id=esc(x.id),more=ph.length-6;
 const thumbs=ph.slice(0,6).map((p,i)=>`<button type="button" class="lab-thumb" data-view="${id}" data-i="${i}" aria-label="Photo ${i+1} of ${ph.length}: ${esc(label(p))}"><img src="${url(p)}" alt="" loading="lazy"><span class="lab-thumb__tab">${esc(p.tab||p.run)}</span></button>`).join('');
 const compare=runsOf(x.question).length>1?`<button type="button" class="btn-outline lab-compare-open" data-exp="${id}">Compare</button>`:'';
 return `<div class="lab-thumbs">${thumbs}${more>0?`<button type="button" class="lab-thumb lab-thumb--more" data-view="${id}" data-i="6" aria-label="${more} more photos">+${more}</button>`:''}</div>${compare}`;
}
const tickKey=id=>'printLab:ticks:'+id;
function ticks(id){try{const t=JSON.parse(localStorage.getItem(tickKey(id))||'[]');return Array.isArray(t)?t:[]}catch{return []}}
function checklistHtml(x){
 const items=[...String(x.judge_on||'').split(';').map(s=>s.trim()).filter(Boolean),...LIGHT],on=ticks(x.id);
 return `<fieldset class="lab-checklist__set"><legend>Before you judge</legend>${items.map((t,i)=>`<label class="lab-checkbox-label"><input type="checkbox" data-tick="${esc(x.id)}" data-i="${i}"${on.includes(i)?' checked':''}><span>${esc(t)}</span></label>`).join('')}</fieldset>`;
}

// Zoom and pan on the images under `area`: double-tap or double-click toggles 1:1 pixel inspection crop, two fingers
// pinch, one drags while zoomed. Every image imgs() returns moves together (Compare's linked zoom). onSwipe(+1|-1) for
// a sideways swipe.
function zoomable(area,imgs,onSwipe){
 const z={s:1,x:0,y:0},pts=new Map();let pinch=null,start=null,last=0,kind='';
 const apply=anim=>{if(z.s<=1){z.s=1;z.x=0;z.y=0}for(const i of imgs()){i.style.transition=anim?'transform .18s ease-out':'none';i.style.transform=`translate(${z.x}px,${z.y}px) scale(${z.s})`}};
 const toggle=(target,tx,ty)=>{
  if(z.s>1){z.s=1;z.x=0;z.y=0;apply(true);return}
  const img=target||imgs()[0];
  const nat=img&&img.naturalWidth&&img.clientWidth?(img.naturalWidth/img.clientWidth):2.5;
  const targetS=Math.min(6,Math.max(2,nat));
  z.s=targetS;
  if(tx!=null&&ty!=null&&img){
   const r=img.getBoundingClientRect();
   z.x=(r.left+r.width/2-tx)*(targetS-1);
   z.y=(r.top+r.height/2-ty)*(targetS-1);
  }else{z.x=0;z.y=0}
  apply(true);
 };
 area.addEventListener('pointerdown',e=>{
  if(e.target.tagName!=='IMG')return;kind=e.pointerType;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pts.size===2){const [a,b]=[...pts.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y)||1,s:z.s};start=null}
  else start={x:e.clientX,y:e.clientY,zx:z.x,zy:z.y};
 });
 area.addEventListener('pointermove',e=>{
  if(!pts.has(e.pointerId))return;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pinch&&pts.size===2){const [a,b]=[...pts.values()];z.s=Math.min(5,Math.max(1,pinch.s*Math.hypot(a.x-b.x,a.y-b.y)/pinch.d));apply(false)}
  else if(start&&z.s>1){z.x=start.zx+e.clientX-start.x;z.y=start.zy+e.clientY-start.y;apply(false)}
 });
 const end=e=>{
  if(!pts.delete(e.pointerId))return;
  if(pinch){if(!pts.size)pinch=null;return}
  if(!start||e.type==='pointercancel'){start=null;return}
  const dx=e.clientX-start.x,dy=e.clientY-start.y;start=null;
  if(z.s===1&&onSwipe&&Math.abs(dx)>50&&Math.abs(dx)>Math.abs(dy)){onSwipe(dx<0?1:-1);return}
  if(e.pointerType==='touch'&&Math.hypot(dx,dy)<10){const t=Date.now();if(t-last<300){toggle(e.target,e.clientX,e.clientY);last=0}else last=t}
 };
 area.addEventListener('pointerup',end);area.addEventListener('pointercancel',end);
 area.addEventListener('dblclick',e=>{if(e.target.tagName==='IMG'&&kind!=='touch')toggle(e.target,e.clientX,e.clientY)});
 return {reset(){z.s=1;apply(false)}};
}

const sec=()=>document.getElementById('printLab');
function dialog(id,html){
 let d=document.getElementById(id);
 if(!d){sec().insertAdjacentHTML('beforeend',html);d=document.getElementById(id)}
 return d;
}
// ---- the viewer ----
let view=null,viewZoom=null;
function viewerEl(){
 const d=dialog('labViewer',`<dialog id="labViewer" class="lab-viewer" aria-label="Photo"><div class="lab-viewer__stage"><img class="lab-viewer__img" alt=""></div><p class="lab-viewer__cap" aria-live="polite"></p><div class="lab-viewer__nav"><button type="button" class="btn-outline" data-step="-1" aria-label="Previous photo">‹</button><button type="button" class="btn-outline" data-step="1" aria-label="Next photo">›</button><button type="button" class="btn-outline" id="labViewerClose">Close</button></div></dialog>`);
 if(!viewZoom){
  viewZoom=zoomable(d.querySelector('.lab-viewer__stage'),()=>[d.querySelector('.lab-viewer__img')],step);
  d.addEventListener('click',e=>{const b=e.target.closest('[data-step]');if(b)step(Number(b.dataset.step));else if(e.target.closest('#labViewerClose'))d.close()});
  d.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();step(e.key==='ArrowRight'?1:-1)}});
 }
 return d;
}
function show(){
 const d=viewerEl(),p=view.list[view.i],img=d.querySelector('.lab-viewer__img');
 img.src=url(p);img.alt=`${view.x.id}, ${label(p)}`;
 d.querySelector('.lab-viewer__cap').textContent=`${label(p)} · ${view.i+1} of ${view.list.length}`;
 viewZoom.reset();
}
function step(n){if(!view)return;view.i=(view.i+n+view.list.length)%view.list.length;show()}
function openViewer(x,i){
 const list=photosOf(x);if(!list.length)return;
 view={x,list,i:Math.min(i,list.length-1)};
 const d=viewerEl();show();if(!d.open)d.showModal();
}

// ---- Compare ----
let cmp=null,cmpZoom=null,cmpMode='split';
function compareEl(){
 const d=dialog('labCompare',`<dialog id="labCompare" class="lab-compare" aria-labelledby="labCompareTitle"><div class="lab-compare__head"><h2 id="labCompareTitle" class="lab-sheet__title">Compare</h2><div class="lab-compare__modes" role="radiogroup" aria-label="Compare mode"><button type="button" class="btn-subtle" data-cmp-mode="split" aria-pressed="true">Side by side</button><button type="button" class="btn-subtle" data-cmp-mode="wipe" aria-pressed="false">Curtain slider</button></div><button type="button" class="btn-outline" id="labCompareClose">Close</button></div><div class="lab-compare__pick"><label class="lab-sheet__field">Left<select data-side="0"></select></label><label class="lab-sheet__field">Right<select data-side="1"></select></label></div><div class="lab-compare__body"></div><p class="lab-sheet__hint">Pinch or double-tap to zoom; drag slider in curtain mode.</p></dialog>`);
 if(!cmpZoom){
  const body=d.querySelector('.lab-compare__body');
  cmpZoom=zoomable(body,()=>body.querySelectorAll('img'));
  d.addEventListener('click',e=>{
   if(e.target.closest('#labCompareClose'))d.close();
   const m=e.target.closest('[data-cmp-mode]');
   if(m&&cmp){cmpMode=m.dataset.cmpMode;drawCompare()}
  });
  d.addEventListener('input',e=>{
   const r=e.target.closest('.lab-wipe input[type="range"]');
   if(r)r.parentNode.style.setProperty('--cut',`${r.value}%`);
  });
  d.addEventListener('change',e=>{const s=e.target.closest('select[data-side]');if(s&&cmp){cmp.sides[Number(s.dataset.side)]=s.value;drawCompare()}});
 }
 return d;
}
function drawCompare(){
 const d=compareEl(),by=Object.fromEntries(cmp.runs.map(r=>[r.run,r]));
 d.querySelectorAll('select[data-side]').forEach(sel=>{
  sel.replaceChildren(...cmp.runs.map(r=>{const o=document.createElement('option');o.value=r.run;o.textContent=`${r.run} · ${r.x.id}${r.good?' · good enough':''}`;return o}));
  sel.value=cmp.sides[Number(sel.dataset.side)];
 });
 d.querySelectorAll('[data-cmp-mode]').forEach(b=>{
  b.setAttribute('aria-pressed',String(b.dataset.cmpMode===cmpMode));
 });
 const [a,b]=cmp.sides.map(r=>(by[r]||{photos:[]}).photos),tabs=[...new Set([...a,...b].map(p=>p.tab||''))];
 const cell=p=>`<div class="lab-compare__cell">${p?`<img src="${url(p)}" alt="${esc(label(p))}">`:'<span class="meta">No photo</span>'}</div>`;
 const rows=[];
 for(const t of tabs){
  const l=a.filter(p=>(p.tab||'')===t),r=b.filter(p=>(p.tab||'')===t);
  for(let i=0;i<Math.max(l.length,r.length);i++){
   if(cmpMode==='wipe'&&l[i]&&r[i]){
    rows.push(`<div class="lab-compare__pair"><p class="lab-compare__tab">${esc(t||'No tab')}</p>`
     +`<figure class="lab-wipe" style="--cut:50%"><img src="${url(l[i])}" alt="${esc(label(l[i]))}">`
     +`<img class="lab-wipe__after" src="${url(r[i])}" alt="${esc(label(r[i]))}">`
     +`<input type="range" min="0" max="100" value="50" aria-label="Slide between ${esc(label(l[i]))} and ${esc(label(r[i]))}">`
     +`<figcaption><span>${esc(l[i].run)}</span><span>${esc(r[i].run)}</span></figcaption></figure></div>`);
   }else{
    rows.push(`<div class="lab-compare__pair"><p class="lab-compare__tab">${esc(t||'No tab')}</p><div class="lab-compare__cols">${cell(l[i])}${cell(r[i])}</div></div>`);
   }
  }
 }
 d.querySelector('.lab-compare__body').innerHTML=rows.join('');
 if(cmpMode==='split')cmpZoom.reset();
}
function openCompare(x){
 const runs=runsOf(x.question),mine=runs.filter(r=>r.x===x);if(!mine.length||runs.length<2)return;
 const left=mine[mine.length-1],others=runs.filter(r=>r!==left);
 const right=[...others].reverse().find(r=>r.good)||[...others].reverse().find(r=>r.at<left.at)||others[others.length-1];
 cmp={runs,sides:[left.run,right.run]};
 const d=compareEl();drawCompare();if(!d.open)d.showModal();
}

function mount(d){
 data=d;const s=sec();if(!s||!data)return;
 const byId=Object.fromEntries(exps().map(x=>[x.id,x]));
 for(const el of s.querySelectorAll('[data-lab-photos]'))if(byId[el.dataset.labPhotos])el.innerHTML=thumbsHtml(byId[el.dataset.labPhotos]);
 for(const el of s.querySelectorAll('[data-lab-checklist]'))if(byId[el.dataset.labChecklist])el.innerHTML=checklistHtml(byId[el.dataset.labChecklist]);
}
function init(){
 const s=sec();if(!s)return;
 const find=id=>exps().find(x=>x.id===id);
 s.addEventListener('click',e=>{
  const t=e.target.closest('.lab-thumb[data-view]');if(t){const x=find(t.dataset.view);if(x)openViewer(x,Number(t.dataset.i)||0);return}
  const c=e.target.closest('.lab-compare-open');if(c){const x=find(c.dataset.exp);if(x)openCompare(x)}
 });
 s.addEventListener('change',e=>{
  const b=e.target.closest('input[data-tick]');if(!b)return;
  const id=b.dataset.tick,set=new Set(ticks(id));if(b.checked)set.add(Number(b.dataset.i));else set.delete(Number(b.dataset.i));
  try{localStorage.setItem(tickKey(id),JSON.stringify([...set]))}catch{}
 });
 const d=root.LocalAIPrintLab&&root.LocalAIPrintLab.data&&root.LocalAIPrintLab.data();if(d)mount(d);
}
root.LocalAIPrintLabPhotos={mount};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
