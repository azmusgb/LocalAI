// When this device can't reach Local AI, the service worker (sw.js) answers with the copy it saved, marked with
// <meta name="localai-offline-copy" content="<saved at>"> (and by message for shell files). This module says so in a
// banner instead of passing an old copy off as current, checks /healthz every 15 s, and reloads once Local AI answers.
// It also reloads, once, a page whose build (the localai-version/localai-release metas the server writes into
// index.html) differs from what /healthz reports, so a phone stuck on an old shell catches up on the next contact.
// Health and Secure connection ask LocalAIConnection.reachable() before saying anything is fine.
// When this address can't be reached but another one in the saved list answers (Home Wi-Fi vs Tailscale), the saved
// copy says so and moves there after 2 s unless the owner taps Cancel; once per tab session, never from an address that
// answers. On the address it moved to, a quiet line offers the way back once the first one answers again; never automatic.
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
// Caddy's answer while a deploy restarts the appliance (deploy/caddy/Caddyfile): an update, not a failure.
const isUpdatingReply=(status,body)=>status>=502&&status<=504&&body?.updating===true;
// The appliance's other addresses (/healthz and index.html carry them: Home Wi-Fi, Anywhere (Tailscale)). A saved copy
// offers the ones that aren't this page's own: away from home, the Tailscale one still answers.
// https only; plain http only on this machine (127.0.0.1/localhost: a developer's or a test's appliance).
const loopback=h=>h==='127.0.0.1'||h==='localhost'||h==='[::1]';
function address(a){
 let u;try{u=new URL(String(a&&a.url||''))}catch{return null}
 if(u.protocol!=='https:'&&!(u.protocol==='http:'&&loopback(u.hostname)))return null;
 return {label:String(a.label||u.host),url:u.origin+'/',tailscale:/tailscale/i.test(String(a.label||''))||/\.ts\.net$/i.test(u.hostname)};
}
function otherAddresses(list,origin){
 if(!Array.isArray(list))return [];
 const seen=new Set([String(origin||'')]),out=[];
 for(const a of list){
  const x=address(a);if(!x)continue;
  const o=new URL(x.url).origin;if(seen.has(o))continue;
  seen.add(o);out.push(x);
 }
 return out;
}
// This page's own entry in the list, or null (an address the appliance doesn't list, such as localai.home.arpa).
function ownAddress(list,origin){
 for(const a of Array.isArray(list)?list:[]){const x=address(a);if(x&&new URL(x.url).origin===origin)return x}
 return null;
}
const addressName=a=>a.tailscale?'Tailscale':a.label;
// Moving on its own happens once per tab session at most: not after it already moved or the owner cancelled
// (choice, saved on the address it left), and not on an address it moved to (arrivedFrom), so two flaky addresses
// can't bounce the page between them. A page that reaches Local AI never gets here.
const autoSwitchAllowed=({choice,arrivedFrom})=>!choice&&!arrivedFrom;
// The first address that answered, in the list's order (Home Wi-Fi before Tailscale).
function pickReachable(others,answered){const i=(answered||[]).findIndex(Boolean);return i<0?null:others[i]||null}
// The same page, path and hash at the other address.
const switchUrl=(target,loc)=>new URL(target.url).origin+loc.pathname+loc.search+loc.hash;
// The address this page was moved from: remembered for the tab, or the referrer when it is another listed address.
function arrivedFrom(referrer,list,origin,saved){
 const others=otherAddresses(list,origin).map(a=>new URL(a.url).origin);
 if(saved&&others.includes(saved))return saved;
 let r='';try{r=new URL(referrer).origin}catch{}
 return others.includes(r)?r:'';
}
function switchNotice(from,to){return `${from?from.label:'This address'} isn't reachable. Switching to ${addressName(to)}…`}
// The quiet way back, worded for the address it offers.
function backOffer(a){return a.tailscale?{text:'Tailscale answers again',link:'open the Tailscale address'}:{text:`Back on ${/wi-?fi/i.test(a.label)?'home Wi-Fi':a.label}`,link:'open the home address'}}
const api={relativeTime,buildDiffers,buildKey,isLocalAIHealth,isUpdatingReply,otherAddresses,ownAddress,autoSwitchAllowed,pickReachable,switchUrl,arrivedFrom,switchNotice,backOffer};
if(typeof module==='object'&&module.exports){module.exports=api;return}
if(typeof document==='undefined')return;

const RECHECK_MS=15000,BUILD_KEY='localai.buildReload',RECONNECT_KEY='localai.reconnectReload';
const meta=name=>document.querySelector(`meta[name="${name}"]`);
const page={version:meta('localai-version')?.content||'',releaseCommit:meta('localai-release')?.content||''};
const mark=meta('localai-offline-copy');
const copy={active:!!mark,savedAt:mark?mark.content:''};
// Saved on each answer from /healthz; the page's own meta is the fallback (both survive with no network).
const ADDR_KEY='localai.addresses';
function parseList(text){try{const v=JSON.parse(text||'null');return Array.isArray(v)?v:null}catch{return null}}
function knownAddresses(){let saved=null;try{saved=parseList(localStorage.getItem(ADDR_KEY))}catch{}return saved||parseList(meta('localai-addresses')?.content)||[]}
function rememberAddresses(list){if(!Array.isArray(list))return;try{localStorage.setItem(ADDR_KEY,JSON.stringify(list))}catch{}}
// One /healthz request at a time, reused for a moment so Health's cards share it. null: Local AI didn't answer.
let pending=null,pendingAt=0;
function healthz(fresh){
 if(!fresh&&pending&&Date.now()-pendingAt<3000)return pending;
 pendingAt=Date.now();
 const signal=typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function'?AbortSignal.timeout(6000):undefined;
 pending=fetch('/healthz',{cache:'no-store',signal}).then(async r=>{let data=null;try{data=await r.json()}catch{}if(!isLocalAIHealth(data))return null;rememberAddresses(data.addresses);return {status:r.status,data}}).catch(()=>null);
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
 showOtherAddresses(el);
}
// One tap to the address that may still work, with what the phone needs for it. Built from saved data only.
function showOtherAddresses(el){
 const others=otherAddresses(knownAddresses(),location.origin);
 let box=el.querySelector('.offline-banner__alt');
 if(!others.length){box?.remove();return}
 if(!box){box=document.createElement('div');box.className='offline-banner__alt';el.querySelector('.offline-banner__text').after(box)}
 box.replaceChildren(...others.map(a=>{
  const row=document.createElement('p'),link=document.createElement('a');
  link.className='btn-primary offline-banner__open';link.href=a.url;link.textContent=a.tailscale?'Open over Tailscale':`Open on ${a.label}`;
  row.append(link);
  if(a.tailscale){const hint=document.createElement('span');hint.className='offline-banner__hint';hint.textContent='Turn on Tailscale on this phone first.';row.append(' ',hint)}
  return row;
 }));
}
// Another address answers if it sends anything back. no-cors needs nothing from the server, and a page can't read
// the reply anyway; a certificate this phone doesn't trust fails like no answer, so a stranger's 10.0.0.21 elsewhere
// doesn't count. No cookies: pairing stays per address.
const PROBE_MS=3000,SWITCH_MS=2000,SWITCH_KEY='localai.addressSwitch',FROM_KEY='localai.switchedFrom';
function probe(url){
 const ctrl=typeof AbortController==='function'?new AbortController():null;let t=0;
 return Promise.race([
  fetch(new URL('/healthz',url).href,{mode:'no-cors',cache:'no-store',credentials:'omit',signal:ctrl?.signal}).then(()=>true,()=>false),
  new Promise(r=>{t=setTimeout(()=>{ctrl?.abort();r(false)},PROBE_MS)})
 ]).finally(()=>clearTimeout(t));
}
const sessionGet=k=>{try{return sessionStorage.getItem(k)||''}catch{return ''}};
const sessionSet=(k,v)=>{try{sessionStorage.setItem(k,v)}catch{}};
const cameFrom=()=>arrivedFrom(document.referrer,knownAddresses(),location.origin,sessionGet(FROM_KEY));
let probing=false,switchTimer=0;
async function maybeSwitch(){
 if(probing||switchTimer||!autoSwitchAllowed({choice:sessionGet(SWITCH_KEY),arrivedFrom:cameFrom()}))return;
 const list=knownAddresses(),others=otherAddresses(list,location.origin);
 if(!others.length)return;
 probing=true;
 try{const target=pickReachable(others,await Promise.all(others.map(a=>probe(a.url))));if(target&&copy.active)startSwitch(list,target)}
 finally{probing=false}
}
function startSwitch(list,target){
 const el=document.getElementById('offlineBanner');
 if(!el||sessionGet(SWITCH_KEY))return;
 const box=document.createElement('div');box.className='offline-banner__switch';
 const text=document.createElement('p');text.textContent=switchNotice(ownAddress(list,location.origin),target);
 const cancel=document.createElement('button');cancel.type='button';cancel.className='btn-outline offline-banner__cancel';cancel.textContent='Cancel';
 const bar=document.createElement('span');bar.className='offline-banner__countdown';bar.setAttribute('aria-hidden','true');
 box.append(text,cancel,bar);
 el.querySelector('.offline-banner__switch')?.remove();el.append(box);el.classList.add('offline-banner--switching');
 const stop=()=>{clearTimeout(switchTimer);switchTimer=0;box.remove();el.classList.remove('offline-banner--switching')};
 cancel.addEventListener('click',()=>{sessionSet(SWITCH_KEY,'cancelled');stop()});
 switchTimer=setTimeout(async()=>{
  // Never leave an address that answers: one last look first.
  if(await healthz(true)){stop();check();return}
  if(!switchTimer)return; // cancelled during that look
  sessionSet(SWITCH_KEY,'switched '+new URL(target.url).origin);
  location.href=switchUrl(target,location);
 },SWITCH_MS);
}
// On the address it moved to: the first one answering again is offered as a link, checked on load, when the phone
// comes back online and when the app comes back to the front. Never automatic, so the owner isn't moved twice.
let backChecking=false;
async function checkBack(){
 if(backChecking)return;
 backChecking=true;
 let a=null,ok=false;
 try{
  await healthz(); // a fresh address list first, when this address answers
  const from=cameFrom();if(!from)return;
  sessionSet(FROM_KEY,from);
  a=otherAddresses(knownAddresses(),location.origin).find(x=>new URL(x.url).origin===from);
  if(!a)return;
  ok=await probe(a.url);
 }finally{backChecking=false}
 let el=document.getElementById('addressBack');
 if(!ok){el?.remove();return}
 if(!el){
  el=document.createElement('p');el.id='addressBack';el.className='address-back';el.setAttribute('role','status');
  const offer=backOffer(a),link=document.createElement('a');link.textContent=offer.link;
  link.addEventListener('click',()=>{link.href=switchUrl(a,location)});
  el.append(`${offer.text} — `,link);
  document.body.prepend(el);
 }
 el.querySelector('a').href=switchUrl(a,location);
}
let timer=0;
async function check(){
 const h=await healthz();
 if(copy.active){
  if(!h){showBanner();maybeSwitch();return}
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
document.addEventListener('visibilitychange',()=>{if(document.hidden)return;checkBack();if(copy.active||Date.now()-lastVisibleCheck>60000){lastVisibleCheck=Date.now();check()}});
window.addEventListener('online',checkBack);
const start=()=>{if(copy.active)enterCopy(copy.savedAt);check();checkBack()};
if(document.body)start();else document.addEventListener('DOMContentLoaded',start,{once:true});
root.LocalAIConnection={reachable,isSavedCopy:()=>copy.active,build:()=>({...page}),isUpdatingReply};
})(typeof window!=='undefined'?window:globalThis);
