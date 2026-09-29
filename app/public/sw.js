const CACHE='local-ai-shell-v1.18-agent-city';
const SHELL=['/','/index.html','/app.js','/manifest.json','/mobile-overhaul.css','/mobile-overhaul.js','/agent-specialists.css','/agent-specialists.js','/ux-architecture-v2.css','/ux-architecture-v2.js','/agent-world-city.css','/agent-world-city.js'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==location.origin||url.pathname.startsWith('/api/'))return;
  event.respondWith(fetch(req).then(res=>{const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy));return res;}).catch(()=>caches.match(req).then(r=>r||caches.match('/index.html'))));
});
