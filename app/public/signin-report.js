// Settings › Sign-in (report only): who reached Local AI's API without a paired device or the Mac key (app/signin.js).
// Nothing is blocked yet; this list is how the owner finds callers to pair or allow before sign-in is switched on.
// Also this browser's own sign-in (sign-in A2, LocalAISignIn): the words and the one Pair action for a refused read.
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
// This browser's sign-in (sign-in A2). whoami says 'in' or 'out' and the mode; a failed whoami decides nothing (null).
// In report mode a read refused with 401 {signIn:true} says so where it was refused (state, say: fetchJson marks it
// .signIn). Only when sign-in is required for every route does one notice sit under the strip on every page.
let who=null,mode='';
const name=()=>root.LocalAIFramed?.active?.()?'the Assistant':'Local AI';
const MAC='Approve the code on your Mac.',W={see:'Pair this browser to see this.',act:'Pair this browser to do this.'};
const PAIR='<a class="ui-btn" href="#claude" data-signin-pair>Pair this browser</a>';
// Sign-in required: the notice under the strip offers the Mac step and Pair; a page's own line says neither.
const req=()=>who==='out'&&mode==='required';
const words=k=>req()?W[k]:`${W[k]} ${MAC}`;
// k: 'see' (a refused read) or 'act' (a save). pair=false where the screen has a Pair already.
const say=(k='see',cls='',pair=true)=>`<div class="ui-notice ui-notice--warn signin-line ${cls}"><span data-signin-words="${k}">${words(k)}</span>${pair&&!req()?PAIR:''}</div>`;
const state=(pair=true)=>`<div class="state-error empty-state" data-signin-state><div class="empty-state__title">${W.see}</div>${req()?'':`<div data-signin-mac>${MAC}</div>${pair?PAIR:''}`}</div>`;
function paint(){const n=$('signinNotice'),on=req();if(!n||!!n.firstChild===on)return;
 n.innerHTML=on?`<div class="ui-notice ui-notice--warn signin-line signin-notice"><span>Pair this browser to use ${name()}. ${MAC}</span>${PAIR}</div>`:'';
 // Drawn before whoami answered: take them back out.
 if(on)document.querySelectorAll('[data-signin-pair],[data-signin-mac],[data-signin-words]').forEach(e=>{if(n.contains(e))return;if(e.dataset.signinWords)e.textContent=W[e.dataset.signinWords];else e.remove()})}
// At load, and on each page change until signed in (always while sign-in is required).
function ask(){if(who!=='in'||mode==='required')fetch('/api/claude/chat/whoami',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(j=>{if(typeof j?.signedIn!=='boolean')return;who=j.signedIn?'in':'out';mode=j.mode==='required'?'required':'report';paint()},()=>{})}
function mount(){const m=document.querySelector('main');if(!m||$('signinNotice'))return;const n=document.createElement('div');n.id='signinNotice';n.setAttribute('aria-live','polite');const at=$('uxPageStrip')||$('uxContextBar');at?at.after(n):m.prepend(n);paint();ask();root.addEventListener('hashchange',ask)}
// Pair inside a sheet: close it, then go (the router waits for its history entry).
document.addEventListener('click',e=>{const d=e.target.closest?.('[data-signin-pair]')?.closest('dialog[open]');if(d&&root.LocalAIRouter?.go){e.preventDefault();d.close();root.LocalAIRouter.go('#claude')}});
const start=()=>{init();mount()};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
root.LocalAISignInReport={load};
root.LocalAISignIn={state,say,words,name,get pair(){return req()?'':PAIR},get:()=>who,mode:()=>mode};
})(window);
