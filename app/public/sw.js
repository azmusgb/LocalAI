const CACHE='local-ai-shell-v1.18-unified-runs-sw7';
const SHELL=['/','/index.html','/app.js','/manifest.json','/mobile-overhaul.css','/mobile-overhaul.js','/execution-runtime.js','/agent-specialists.css','/agent-specialists.js','/ux-architecture-v2.css','/ux-architecture-v2.js','/integration-hub-v2.css','/integration-hub-v2.js','/agent-world-city.css','/agent-world-city.js','/claude-board.css','/claude-board.js','/design-system.css'];
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
