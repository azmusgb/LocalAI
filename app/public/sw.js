const CACHE='local-ai-shell-v1.18-unified-runs-bundle2-figtree-states-ask-runcard-thread-push-router-live2-runview-work-merge1-home1-improve-chatbody1-runimg1-ux9-missionweb1-phone1-install1-offline1-aw1-selfchange1-needs1-fixpart1-a11y1-watch1-awlayers2-nav2-landmarks1-printlab1-assistant1-kit2-recent1-look2-labguide1-labact1-routing1-labobserve1-labhome1-street1-street2';
const SHELL=['/','/index.html','/app.js','/agent-world-watch.js','/manifest.json','/view-registry.js','/router.js','/work.js','/spreadsheets.js','/print-lab-evidence.js','/print-lab-refresh.js','/print-lab.js','/print-lab-guide.js','/print-lab-photos.js','/print-lab-observe.js','/model-routing.js','/signin-report.js','/self-change.js','/needs-you.js','/crew-summary.js','/improve.js','/ask-context.js','/home.js','/run-bodies.js','/app.css','/ui.js','/qr.js','/components.js','/offline-copy.js','/agent-world-words.js','/fix-part.js','/aw/kit.js','/aw/landmarks.js','/street/art.js','/street/street.js','/street/chat.js','/street/images.js','/street/sheets.js','/street/foundry.js','/street/workshop.js','/street/kiosk.js','/fonts/figtree-latin-wght-normal.woff2'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL.map(u=>new Request(u,{cache:'reload'})))).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
// A shell copy is stamped with when it was saved; the install's copies fall back to the server's Date header.
const SAVED='X-LocalAI-Saved-At',MARK='X-LocalAI-Offline-Copy';
function stamped(res){const headers=new Headers(res.headers);headers.set(SAVED,new Date().toISOString());return new Response(res.body,{status:res.status,statusText:res.statusText,headers})}
// Served from the cache because the network failed: mark the response, tell the page in the HTML itself (a page can't
// read its own navigation headers, and a message can't reach a page that doesn't exist yet), and tell the page that
// asked for a shell file by message. app/public/offline-copy.js shows the banner.
async function savedCopy(hit,event,html){
  const savedAt=hit.headers.get(SAVED)||hit.headers.get('Date')||'',when=savedAt&&!Number.isNaN(Date.parse(savedAt))?new Date(savedAt).toISOString():'';
  const headers=new Headers(hit.headers);headers.set(MARK,when||CACHE);
  if(event.clientId)self.clients.get(event.clientId).then(c=>c&&c.postMessage({type:'localai-offline-copy',savedAt:when,cache:CACHE})).catch(()=>{});
  if(!html)return new Response(hit.body,{status:hit.status,statusText:hit.statusText,headers});
  const body=(await hit.text()).replace('<head>',`<head>\n<meta name="localai-offline-copy" content="${when}" data-cache="${CACHE}">`);
  headers.delete('Content-Length');headers.delete('ETag');
  return new Response(body,{status:hit.status,statusText:hit.statusText,headers});
}
// No saved copy at all (the cache is gone or was never filled): a page still says Local AI can't be reached, with Try
// again, the other addresses this device learned (offline-copy.js saves them in localStorage), and a reload once
// Local AI answers again. Everything is inline: nothing else can be loaded.
function noCopyPage(){
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>Local AI</title>
<style>body{margin:0;font:16px/1.45 -apple-system,system-ui,sans-serif;background:Canvas;color:CanvasText}#offlineBanner{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:calc(12px + env(safe-area-inset-top)) 16px 12px;background:color-mix(in srgb,#d97706 14%,Canvas);border-bottom:1px solid color-mix(in srgb,#d97706 40%,Canvas)}#offlineBanner p{margin:0;flex:1 1 220px}#offlineBanner button,#offlineBanner a{min-height:44px;padding:0 14px;border-radius:10px;font:inherit;display:inline-flex;align-items:center;text-decoration:none}#offlineBanner button{border:1px solid currentColor;background:none;color:inherit}#offlineBanner a{background:#2563eb;color:#fff}.offline-banner__alt{flex:1 0 100%;display:grid;gap:6px}.offline-banner__alt p{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}.offline-banner__hint{font-size:14px;opacity:.75}</style></head>
<body><div id="offlineBanner" class="offline-banner offline-banner--no-copy" role="status"><p class="offline-banner__text">Can't reach Local AI, and this device has no saved copy to show.</p><button type="button" class="offline-banner__retry">Try again</button></div>
<script>(function(){var b=document.getElementById('offlineBanner');b.querySelector('button').onclick=function(){this.disabled=true;this.textContent='Trying…';location.reload()};
var list=[];try{list=JSON.parse(localStorage.getItem('localai.addresses')||'[]')||[]}catch(e){}var box=document.createElement('div');box.className='offline-banner__alt';
(Array.isArray(list)?list:[]).forEach(function(a){try{var u=new URL(String(a&&a.url||''));var local=/^(127\\.0\\.0\\.1|localhost|\\[::1\\])$/.test(u.hostname);if(u.origin===location.origin||!(u.protocol==='https:'||(u.protocol==='http:'&&local)))return;
var ts=/tailscale/i.test(String(a.label||''))||/\\.ts\\.net$/i.test(u.hostname),p=document.createElement('p'),l=document.createElement('a');l.className='offline-banner__open';l.href=u.origin+'/'+location.hash;l.textContent=ts?'Open over Tailscale':'Open on '+String(a.label||u.host);p.appendChild(l);
if(ts){var h=document.createElement('span');h.className='offline-banner__hint';h.textContent='Turn on Tailscale on this phone first.';p.appendChild(h)}box.appendChild(p)}catch(e){}});
if(box.childNodes.length)b.appendChild(box);
setInterval(function(){fetch('/healthz',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(d&&d.appliance==='Local AI')location.reload()}).catch(function(){})},15000)})();</script></body></html>`;
  return new Response(html,{status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',[MARK]:'none'}});
}
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==location.origin||url.pathname.startsWith('/api/'))return;
  const shell=SHELL.includes(url.pathname),nav=req.mode==='navigate';
  // Shell files always revalidate with the server (ETag) so a deploy shows up on the next load.
  event.respondWith(fetch(req,shell?{cache:'no-cache'}:undefined).then(res=>{if(shell&&res.ok&&res.type==='basic'){const copy=stamped(res.clone());event.waitUntil(caches.open(CACHE).then(c=>c.put(url.pathname,copy)));}return res;}).catch(async err=>{
    const hit=await caches.match(shell?url.pathname:req);
    if(hit)return savedCopy(hit,event,nav||url.pathname==='/'||url.pathname==='/index.html');
    if(nav){const index=await caches.match('/index.html');if(index)return savedCopy(index,event,true);return noCopyPage();}
    throw err;
  }));
});
// Web Push (app/push.js sends it). iOS requires every push to show a notification, so this always shows one.
self.addEventListener('push',event=>{
  let data={};try{data=event.data?event.data.json():{}}catch{data={title:'Local AI',body:event.data?event.data.text():''}}
  event.waitUntil(self.registration.showNotification(data.title||'Local AI',{body:data.body||'',tag:data.tag||undefined,icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',data:{url:data.url||'/'}}));
});
// Tapping a notification opens its item in an open Local AI window, or in a new one.
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const url=new URL(event.notification.data?.url||'/',self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    const win=list.find(c=>new URL(c.url).origin===self.location.origin);
    if(win){win.postMessage({type:'localai-open',url});return win.focus()}
    return self.clients.openWindow(url);
  }));
});
