const CACHE='local-ai-shell-v1.18-unified-runs-bundle2-figtree-states-ask-runcard-thread-push-router-live2-runview-work-merge1-home1-improve-chatbody1-runimg1-ux9-missionweb1-phone1-offline1';
const SHELL=['/','/index.html','/app.js','/manifest.json','/view-registry.js','/router.js','/work.js','/improve.js','/home.js','/run-bodies.js','/app.css','/ui.js','/qr.js','/components.js','/offline-copy.js','/fonts/figtree-latin-wght-normal.woff2'];
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
    if(nav){const index=await caches.match('/index.html');if(index)return savedCopy(index,event,true);}
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
