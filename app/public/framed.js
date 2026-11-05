// Framed by Pi Hub (Pi Hub amendment A4, step 7a, Local AI's half). Pi Hub's /assistant page shows Local AI in a frame;
// only then Local AI drops its own top bar, rail, phone bar and "← Home" (requirement 3), and shows its five areas as a
// strip at the top of the frame. Opened on its own, or framed by anything else, nothing here changes (requirement 9).
//  - Framed means: inside a frame, and the parent's origin (ancestorOrigins, else the referrer, else the first message's
//    origin) is a Pi Hub origin. The same list is the server's frame-ancestors (app/server/framing.js).
//  - Messages: only from window.parent at a Pi Hub origin; {type:"assistant-context", context} opens Home's composer
//    with that context as plain text (requirement 4's listener; LocalAIAskContext.clean, 300 characters).
//  - Route post: each time the address changes, {type:"assistant-route", route} goes to the parent at its own origin,
//    never "*", so Pi Hub can keep /assistant?to=… in step (requirement 7).
//  - In-frame moves replace the frame's history entry (router.js asks active()), so Pi Hub's Back leaves in one step.
(function(root){'use strict';
const HUB_ORIGINS=Object.freeze(['https://hub.rahe-home.duckdns.org','https://home.home.arpa']);
const isHub=o=>typeof o==='string'&&HUB_ORIGINS.includes(o);
const originOf=u=>{try{return new URL(u).origin}catch{return ''}};

function create(win){
 const doc=win.document;
 let framed=false,hubOrigin='',lastRoute=null;
 const inFrame=(()=>{try{return win.top!==win.self}catch{return true}})(); // a cross-origin top can throw on access in old engines
 const route=()=>String(win.location.hash||'').replace(/^#\/?/,'');

 function post(){
  if(!framed)return;
  const r=route();if(r===lastRoute)return;lastRoute=r;
  try{win.parent.postMessage({type:'assistant-route',route:r},hubOrigin)}catch{}
 }
 function become(origin){
  if(framed||!inFrame||!isHub(origin))return false;
  framed=true;hubOrigin=origin;
  doc.documentElement.classList.add('is-framed');
  // The router writes most moves with replaceState, which fires no event: post after each history write as well.
  for(const k of ['replaceState','pushState']){const f=win.history[k];if(typeof f!=='function')continue;win.history[k]=function(...a){const out=f.apply(this,a);post();return out}}
  win.addEventListener('hashchange',post);
  // A same-page link (#work, #run/…) would add a history entry; framed, it replaces instead.
  doc.addEventListener('click',e=>{
   if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
   const a=e.target?.closest?.('a[href^="#"]');if(!a||a.target||!win.LocalAIRouter)return;
   const h=a.getAttribute('href');if(!h||h==='#')return;
   e.preventDefault();win.LocalAIRouter.go(h,{replace:true});
  },true);
  whenReady(strip);
  post();
  return true;
 }
 function whenReady(fn){if(doc.readyState==='complete')fn();else win.addEventListener('load',()=>fn(),{once:true})}

 // The five areas as a strip at the top of the frame, in the order and words of the registry; the current one follows
 // body[data-domain], which ui.js sets on every page change.
 function strip(){
  const V=win.LocalAIViews,main=doc.querySelector('main');if(!V||!main||doc.getElementById('uxFramedStrip'))return;
  const nav=doc.createElement('nav');nav.id='uxFramedStrip';nav.className='ux-framed-strip';nav.setAttribute('aria-label','Assistant');
  for(const d of V.DOMAINS){const b=doc.createElement('button');b.type='button';b.dataset.domain=d.id;b.textContent=d.label;b.addEventListener('click',()=>win.LocalAIRouter?.go('#'+d.defaultView,{replace:true}));nav.append(b)}
  main.prepend(nav);
  const mark=()=>{const cur=doc.body.dataset.domain||'home';for(const b of nav.children){if(b.dataset.domain===cur)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')}};
  new win.MutationObserver(mark).observe(doc.body,{attributes:true,attributeFilter:['data-domain']});
  mark();
 }

 function onMessage(e){
  if(!inFrame||e.source!==win.parent||!isHub(e.origin))return;
  if(!framed)become(e.origin);
  if(e.origin!==hubOrigin)return;
  const m=e.data;if(!m||typeof m!=='object'||m.type!=='assistant-context'||typeof m.context!=='string')return;
  const C=win.LocalAIAskContext,ctx=C?C.clean(m.context):'';if(!ctx||!win.LocalAIRouter)return;
  win.LocalAIRouter.go('#ask?context='+encodeURIComponent(ctx),{replace:true});
 }

 function start(){
  if(!inFrame)return;
  win.addEventListener('message',onMessage);
  const anc=win.location.ancestorOrigins;
  become(anc&&anc.length?anc[0]:originOf(doc.referrer));
 }
 return {start,active:()=>framed,origin:()=>hubOrigin,onMessage,post};
}

const api={HUB_ORIGINS,isHub,create};
if(typeof module==='object'&&module.exports)module.exports=api;
else{const f=create(root);root.LocalAIFramed={HUB_ORIGINS,active:f.active,origin:f.origin};f.start()}
})(typeof window!=='undefined'?window:globalThis);
