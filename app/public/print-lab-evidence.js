// Projects › Print lab: what only the Mac's own page (print-lab lab/page.py, retired) showed, in the same words: the
// spool colour (Bambuddy's colour names, sent by lab sync), a question's plans, each strip's grade, a sweep's finding,
// AI readings, the reference wipe, and parameter reconciliation (Requested vs Sliced vs Observed). Loaded before
// print-lab.js (ui.js), which calls these while it renders; every value from the Mac is escaped, and a colour is used only if it is #rrggbb.
(function(root){'use strict';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const NEUTRAL='#8698b1',HEX=/^#[0-9a-fA-F]{6}$/;
const shot=x=>((x&&x.photos)||[]).find(p=>p&&/^[0-9a-f]{64}$/.test(p.sha256||''));

// The longest colour name found in the filament text wins ("light matte terracotta" before "terracotta").
function spoolColour(filament,colours){
 const text=String(filament||'').toLowerCase(),c=colours||{};
 const name=Object.keys(c).sort((a,b)=>b.length-a.length).find(k=>k&&text.includes(k.toLowerCase())&&HEX.test(c[k]));
 return name?c[name]:NEUTRAL;
}
function plansHtml(q){
 const rows=((q&&q.plans)||[]).map(p=>`<li>After ${esc(p.after)}, if ${esc(p.if)}: ${esc(p.next)}</li>`).join('');
 return rows?`<h3 class="label">Plans</h3><ul class="lab-plans">${rows}</ul>`:'';
}
const plain=v=>v==null?'':Array.isArray(v)?v.map(plain).filter(Boolean).join(', '):typeof v==='object'?Object.entries(v).map(([k,x])=>[k,plain(x)]).filter(([,x])=>x!=='').map(([k,x])=>`${k} ${x}`).join(' · '):String(v);
const gradeText=v=>v&&v.grade?` · ${esc(plain(v.grade))}`:'';
const findingHtml=x=>x&&x.finding?`<p class="lab-verdict">Finding: ${esc(x.finding)}</p>`:'';
const aiHtml=x=>((x&&x.ai_observations)||[]).map(o=>`<p class="lab-ai">AI reading (${Math.round((o.confidence||0)*100)}% sure${o.confirmed?'':', unconfirmed'}): ${esc(o.assessment)}</p>`).join('');
// This test's first photo over its reference's (the experiment named before a reference variant's last "-");
// print-lab.js moves the cut from the range input.
function wipeHtml(x,byId,photoSrc){
 const mine=shot(x);if(!mine)return '';
 const ref=((x.reference_variants)||[]).map(r=>byId&&byId[String(r).replace(/-[^-]*$/,'')]).find(r=>r&&shot(r));
 if(!ref)return '';
 return `<figure class="lab-wipe" style="--cut:50%"><img src="${esc(photoSrc(shot(ref)))}" alt="${esc(ref.id)}, the reference">`
  +`<img class="lab-wipe__after" src="${esc(photoSrc(mine))}" alt="${esc(x.id)}">`
  +`<input type="range" min="0" max="100" value="50" aria-label="Drag between ${esc(ref.id)} and ${esc(x.id)}">`
  +`<figcaption><span>${esc(ref.id)}</span><span>${esc(x.id)}</span></figcaption></figure>`;
}
const fmt=x=>x==null?'—':typeof x==='number'?String(Math.round(x*10)/10):String(x);
function observedHtml(x,v){
 if(v&&v.grade){
  const g=plain(v.grade);
  const gl=g.toLowerCase();
  const tone=gl==='clean'?'good':(gl==='faint'?'attention':'neutral');
  return `<span class="badge badge--${tone}">${esc(g)}</span>`;
 }
 const obs=(x.observations||[]).find(o=>o&&o.subject&&(o.subject.variant===v.id||o.group===v.tab));
 if(obs&&obs.outcomes){
  const summary=Object.entries(obs.outcomes).map(([k,val])=>{
   const s=val&&typeof val==='object'?(val.value||val.status||''):String(val);
   return `${k}: ${s}`;
  }).filter(s=>!s.endsWith(': ')).join(' · ');
  if(summary)return esc(summary);
 }
 if(x.verdict){
  if(x.verdict.good_enough===true){
   return `<span class="badge badge--good">Accepted</span>`+(x.verdict.defects&&x.verdict.defects.length?` <span class="meta">(${esc(x.verdict.defects.join('; '))})</span>`:'');
  }
  if(x.verdict.good_enough===false){
   return `<span class="badge badge--bad">Not good enough</span>`+(x.verdict.defects&&x.verdict.defects.length?` <span class="meta">(${esc(x.verdict.defects.join('; '))})</span>`:'');
  }
  if(x.verdict.note)return esc(x.verdict.note);
  if(x.verdict.kind)return esc(x.verdict.kind);
 }
 if(x.finding)return esc(x.finding);
 if(x.ai_observations&&x.ai_observations.length){
  const ai=(x.ai_observations||[]).find(o=>o.variant===v.id)||x.ai_observations[0];
  if(ai&&ai.assessment)return `<span class="meta">AI: ${esc(ai.assessment)}</span>`;
 }
 if(x.status==='printing')return '<span class="meta">Pending inspection</span>';
 return '—';
}
function reconHtml(x){
 if(!x||!x.variants||!x.variants.length)return '';
 const rows=x.variants.map(v=>{
  const u=v.unit?` ${v.unit}`:'';
  const varCol=v.tab&&v.id&&v.tab!==v.id?`<strong>${esc(v.tab)}</strong> <span class="meta">(${esc(v.id)})</span>`:`<strong>${esc(v.id||v.tab||'—')}</strong>`;
  const req=v.requested!=null?`${esc(fmt(v.requested))}${esc(u)}`:'—';
  let sliced=v.realized!=null?`${esc(fmt(v.realized))}${esc(u)}`:'—';
  if(v.realized!=null&&v.as_asked===false){
   sliced+=` <span class="badge badge--attention" title="Clamped by volumetric flow limit or acceleration cap">Capped</span>`;
  }
  const obs=observedHtml(x,v);
  return `<tr><td>${varCol}</td><td>${req}</td><td>${sliced}</td><td>${obs}</td></tr>`;
 }).join('');
 return `<div class="lab-recon"><h4>Parameter reconciliation</h4><div class="lab-recon__scroll"><table class="lab-recon__table"><thead><tr><th scope="col">Variant</th><th scope="col">Requested</th><th scope="col">Sliced</th><th scope="col">Observed</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
root.LocalAIPrintLabEvidence={spoolColour,plansHtml,gradeText,findingHtml,aiHtml,wipeHtml,reconHtml,plain,observedHtml,NEUTRAL};
})(window);
