// Projects › Print lab: what only the Mac's own page (print-lab lab/page.py, retired) showed, in the same words: the
// spool colour (Bambuddy's colour names, sent by lab sync), a question's plans, each strip's grade, a sweep's finding,
// AI readings and the wipe between a test's first photo and its reference's. Loaded before print-lab.js (ui.js), which
// calls these while it renders; every value from the Mac is escaped, and a colour is used only if it is #rrggbb.
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
const gradeText=v=>v&&v.grade?` · ${esc(v.grade)}`:'';
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
root.LocalAIPrintLabEvidence={spoolColour,plansHtml,gradeText,findingHtml,aiHtml,wipeHtml,NEUTRAL};
})(window);
