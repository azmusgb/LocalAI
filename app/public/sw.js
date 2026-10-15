const CACHE='local-ai-shell-v1.18-unified-runs-bundle2-figtree-states-ask-runcard-thread-push-router-live2-runview';
const SHELL=['/','/index.html','/app.js','/manifest.json','/view-registry.js','/router.js','/app.css','/ui.js','/components.js','/fonts/figtree-latin-wght-normal.woff2'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL.map(u=>new Request(u,{cache:'reload'})))).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==location.origin||url.pathname.startsWith('/api/'))return;
  const shell=SHELL.includes(url.pathname);
  // Shell files always revalidate with the server (ETag) so a deploy shows up on the next load.
  event.respondWith(fetch(req,shell?{cache:'no-cache'}:undefined).then(res=>{if(shell&&res.ok&&res.type==='basic'){const copy=res.clone();event.waitUntil(caches.open(CACHE).then(c=>c.put(url.pathname,copy)));}return res;}).catch(async err=>{const hit=await caches.match(shell?url.pathname:req);if(hit)return hit;if(req.mode==='navigate'){const index=await caches.match('/index.html');if(index)return index;}throw err;}));
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
