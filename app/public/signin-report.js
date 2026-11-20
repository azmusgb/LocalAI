// Settings › Sign-in (report only): who reached Local AI's API without a paired device or the Mac key (app/signin.js).
// Nothing is blocked yet; this list is how the owner finds callers to pair or allow before sign-in is switched on.
// Also this browser's own sign-in (sign-in A2, LocalAISignIn): one notice above every page while it isn't signed in.
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
// Signed in: 'in' | 'out' | null (not known). whoami decides at load and on each page change until it says 'in'; any
// 401 {signIn:true} on any request says 'out'. A failed whoami decides nothing, so only a real refusal shows the notice.
let who=null;
const PAIR='<a class="ui-btn" href="#claude" data-signin-pair>Pair this browser</a>';
const say=(text,cls)=>`<p class="ui-notice ui-notice--warn ${cls}"><span>${esc(text)}</span>${PAIR}</p>`;
// A page whose read was refused: what it would show, and the way to pairing (Improve › Claude Code pairs this browser).
const state=(what='this')=>`<div class="state-error empty-state" data-signin-state><div class="empty-state__title">Sign in on this device to see ${esc(what)}.</div>${PAIR}</div>`;
function paint(){const n=$('signinNotice');if(n&&!!n.firstChild!==(who==='out'))n.innerHTML=who==='out'?say("This browser isn't signed in to Local AI, so some pages stay hidden.",'signin-notice'):''}
function set(v){if(v!==who){who=v;paint()}}
function ask(){if(who!=='in')fetch('/api/claude/chat/whoami',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(j=>{if(typeof j?.signedIn==='boolean')set(j.signedIn?'in':'out')},()=>{})}
// Watches every reply (the shared helpers, the pages' own fetches) without touching it: the caller gets the same promise.
const f=root.fetch;
if(f)root.fetch=function(...a){const p=f.apply(this,a);p.then(r=>{if(r.status===401)r.clone().json().then(j=>{if(j?.signIn===true)set('out')},()=>{})},()=>{});return p};
function mount(){const m=document.querySelector('main');if(!m||$('signinNotice'))return;const n=document.createElement('div');n.id='signinNotice';n.setAttribute('aria-live','polite');const at=$('uxPageStrip')||$('uxContextBar');at?at.after(n):m.prepend(n);paint();ask();root.addEventListener('hashchange',ask)}
const start=()=>{init();mount()};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
root.LocalAISignInReport={load};
root.LocalAISignIn={state,say,pair:PAIR,get:()=>who};
})(window);
