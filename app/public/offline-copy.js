// When this device can't reach Local AI, the service worker (sw.js) answers with the copy it saved, marked with
// <meta name="localai-offline-copy" content="<saved at>"> (and by message for shell files). This module says so in a
// banner instead of passing an old copy off as current, checks /healthz every 15 s, and reloads once Local AI answers.
// It also reloads, once, a page whose build (the localai-version/localai-release metas the server writes into
// index.html) differs from what /healthz reports, so a phone stuck on an old shell catches up on the next contact.
// Health and Secure connection ask LocalAIConnection.reachable() before saying anything is fine.
(function(root){'use strict';
function relativeTime(iso,now=Date.now()){
 const t=Date.parse(iso||'');if(!iso||Number.isNaN(t))return 'an earlier visit';
 const s=Math.max(0,(now-t)/1000);
 if(s<45)return 'just now';
 const m=Math.max(1,Math.round(s/60));if(m<60)return m===1?'1 minute ago':`${m} minutes ago`;
 const h=Math.floor(s/3600);if(h<24)return h===1?'1 hour ago':`${h} hours ago`;
 const d=Math.floor(s/86400);return d<2?'yesterday':`${d} days ago`;
}
function buildDiffers(page,health){
 if(!page||!page.version||!health||!health.version)return false;
 return String(health.version)!==String(page.version)||String(health.releaseCommit||'')!==String(page.releaseCommit||'');
}
const buildKey=b=>`${b&&b.version||''}@${b&&b.releaseCommit||''}`;
// Only Local AI's own health payload means Local AI answered. Caddy keeps answering while the appliance restarts
// (502), and a captive portal answers anything; neither is Local AI. A 503 from Local AI itself still is.
const isLocalAIHealth=d=>!!d&&typeof d==='object'&&d.appliance==='Local AI'&&typeof d.version==='string'&&d.version!=='';
const api={relativeTime,buildDiffers,buildKey,isLocalAIHealth};
if(typeof module==='object'&&module.exports){module.exports=api;return}
if(typeof document==='undefined')return;

const RECHECK_MS=15000,BUILD_KEY='localai.buildReload',RECONNECT_KEY='localai.reconnectReload';
const meta=name=>document.querySelector(`meta[name="${name}"]`);
const page={version:meta('localai-version')?.content||'',releaseCommit:meta('localai-release')?.content||''};
const mark=meta('localai-offline-copy');
const copy={active:!!mark,savedAt:mark?mark.content:''};
// One /healthz request at a time, reused for a moment so Health's cards share it. null: Local AI didn't answer.
let pending=null,pendingAt=0;
function healthz(){
 if(pending&&Date.now()-pendingAt<3000)return pending;
 pendingAt=Date.now();
 const signal=typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function'?AbortSignal.timeout(6000):undefined;
 pending=fetch('/healthz',{cache:'no-store',signal}).then(async r=>{let data=null;try{data=await r.json()}catch{}return isLocalAIHealth(data)?{status:r.status,data}:null}).catch(()=>null);
 return pending;
}
async function reachable(){return !!(await healthz())}
// Picks up a new sw.js too, so the next load runs the current worker; never waits long for it.
async function freshReload(){
 try{const reg=await navigator.serviceWorker?.getRegistration?.();if(reg)await Promise.race([reg.update(),new Promise(r=>setTimeout(r,1500))])}catch{}
 location.reload();
}
// Reload once per build: if the reload still runs another build, stay put instead of looping. No sessionStorage, no reload.
function reloadForBuild(health){
 const key=buildKey(health);
 try{if(sessionStorage.getItem(BUILD_KEY)===key)return false;sessionStorage.setItem(BUILD_KEY,key)}catch{return false}
 freshReload();return true;
}
// false: reloaded under 30 s ago (connectivity flapping); the caller keeps the warning and tries again on a later check.
function reloadForReconnect(){
 try{const last=Number(sessionStorage.getItem(RECONNECT_KEY)||0);if(Date.now()-last<30000)return false;sessionStorage.setItem(RECONNECT_KEY,String(Date.now()))}catch{}
 freshReload();return true;
}
function bannerText(){return `Can't reach Local AI. You're looking at a saved copy from ${relativeTime(copy.savedAt)}.`}
function showBanner(){
 let el=document.getElementById('offlineBanner');
 if(!el){
  el=document.createElement('div');el.id='offlineBanner';el.className='banner banner--attention offline-banner';el.setAttribute('role','status');
  el.innerHTML='<svg class="icon" aria-hidden="true"><use href="#i-alert"></use></svg><p class="offline-banner__text"></p><button type="button" class="btn-outline offline-banner__retry">Try again</button>';
  el.querySelector('button').addEventListener('click',e=>{e.currentTarget.disabled=true;e.currentTarget.textContent='Trying…';freshReload()});
  document.body.prepend(el);
 }
 el.querySelector('.offline-banner__text').textContent=bannerText();
}
let timer=0;
async function check(){
 const h=await healthz();
 if(copy.active){
  if(!h){showBanner();return}
  if(!reloadForReconnect()){showBanner();if(!timer)timer=setInterval(check,RECHECK_MS);return}
  clearInterval(timer);timer=0;document.getElementById('offlineBanner')?.remove();return;
 }
 if(h&&h.data&&buildDiffers(page,h.data))reloadForBuild(h.data);
}
function enterCopy(savedAt){
 if(!copy.active){copy.active=true;copy.savedAt=savedAt||''}
 showBanner();
 if(!timer)timer=setInterval(check,RECHECK_MS);
}
navigator.serviceWorker?.addEventListener?.('message',e=>{if(e.data&&e.data.type==='localai-offline-copy')enterCopy(e.data.savedAt)});
let lastVisibleCheck=Date.now();
document.addEventListener('visibilitychange',()=>{if(document.hidden)return;if(copy.active||Date.now()-lastVisibleCheck>60000){lastVisibleCheck=Date.now();check()}});
const start=()=>{if(copy.active)enterCopy(copy.savedAt);check()};
if(document.body)start();else document.addEventListener('DOMContentLoaded',start,{once:true});
root.LocalAIConnection={reachable,isSavedCopy:()=>copy.active,build:()=>({...page})};
})(typeof window!=='undefined'?window:globalThis);
