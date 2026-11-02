// Settings › Sign-in (report only): who reached Local AI's API without a paired device or the Mac key (app/signin.js).
// Nothing is blocked yet; this list is how the owner finds callers to pair or allow before sign-in is switched on.
(function(root){'use strict';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago=iso=>{const m=Math.round((Date.now()-Date.parse(iso))/60000);return m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} d ago`};
async function load(){
 const list=$('signinList');if(!list)return;
 try{
  const r=await fetch('/api/signin/report',{cache:'no-store'}),d=await r.json();
  if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);
  const cs=d.callers||[];
  $('signinClear').hidden=!cs.length;
  list.innerHTML=cs.length?cs.map(c=>`<div class="signin-row"><strong>${esc(c.kind)} · ${esc(c.ip)}</strong><span class="meta">${c.count} request${c.count===1?'':'s'}, last ${esc(ago(c.lastAt))}: ${esc(c.lastMethod)} ${esc(c.lastPath)}</span></div>`).join('')
   :`<p class="meta">Every request since ${esc(new Date(d.since).toLocaleString())} came from a paired device, the Mac or this computer.</p>`;
 }catch(e){list.innerHTML=`<p class="meta">Couldn't load the list: ${esc(e.message||e)}</p>`}
}
async function clear(){
 const b=$('signinClear');b.disabled=true;
 try{await fetch('/api/signin/report/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await load()}finally{b.disabled=false}
}
function init(){
 const sec=$('settings');if(!sec||!$('signinList'))return;
 $('signinClear').addEventListener('click',clear);
 let was=false;new MutationObserver(()=>{const now=sec.classList.contains('active');if(now&&!was)load();was=now}).observe(sec,{attributes:true,attributeFilter:['class']});
 if(sec.classList.contains('active')){was=true;load()}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
root.LocalAISignInReport={load};
})(window);
