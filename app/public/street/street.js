// Main Street: window.LocalAIStreet. home.js loads street/*.js (its STREET_MODS) the first time Home shows the street.
// Each building file registers one def: {id, width, state(world), stillKey?(state), drawStill(ctx, state, env),
// drawLive(ctx, state, t, env), animates?(state), chip(state) -> {title, detail, tone}, roof?, open?(item), item?(state), stamp?(state),
// beacon?: {x, y}, lights?(state)} (beacon: where traffic.js hangs the needs-you light, default {x: width - 22, y: 200};
// lights: what glows at night, night.js). animates
// says whether drawLive moves for that state (a def without it counts as moving); when it is false drawLive must draw
// the same at any t. width is in scene units; the
// scene is 360 units tall with the ground line at y = 300, and a building draws in its own box x in [0, width]. env is
// {night, reduced, zoom, dpr}. Buildings stand left to right in ORDER, 24 units apart; a key with no def is skipped.
// The engine: mount(el, {mode:'strip', onOpen(id, item)}) -> {destroy()} draws the street on one canvas. The .street box is
// the horizontal scroller (native swipe on a phone; drag, shift+wheel and a trackpad's sideways swipe on a desktop; a
// plain vertical wheel is left to the page) and the canvas is sticky inside it, so
// the camera is its scrollLeft. Each frame draws the sky, the far city (with
// parallax), the sidewalk and the road, then each building's cached still and its drawLive. Stills are one offscreen
// canvas per building, keyed id|zoom|dpr|night|stillKey|stamp; stamp (a clock's hour) redraws a still without counting as a
// change, so it never moves the camera. The loop runs on rAF at up to 30 fps while the strip is on
// screen, the page visible, motion allowed and some building in view animates; otherwise it draws one frame and stops
// (a world, resize, scroll or the strip showing again restarts it). Under reduced motion one frame (t = 0) is drawn per
// world or resize.
// Night (night.js, when loaded): env.night is 19:00-07:00, read on mount and watched (one shared timer); a change re-keys
// every still and redraws once. A night still also caches the building's light layer; a night frame draws night.js's sky,
// the far city faded, then over everything its dim wash and, added, each light layer and the traffic's glows.
// A chip click calls onOpen(def.id, def.item?.(state) ?? null); a state with hidden:true takes its building off the street (layout, drawing, chip) until a world shows it again. A shared poller (below) feeds setWorld from /api/world. setWorld(world) recomputes each state and the chips (and unhides the strip); stats() is a test and perf hook.
(function(root){'use strict';
const ORDER=Object.freeze(['chat','images','missions','garage','sheets','clock','foundry','workshop','kiosk','yard']);
const byId=new Map();let ver=0;
function register(def){if(!def||typeof def.id!=='string'||!def.id)throw new TypeError('a street def needs an id');byId.set(def.id,def);ver++;return def}
function defs(){return ORDER.filter(id=>byId.has(id)).map(id=>byId.get(id))}
const H=360,GAP=24,PAD=24,SLOT=200,FRAME=1000/30-1,QUIET=10000,WAIT=8000,MIN_GAP=2000;
let seen=false,lastW=null;const states=new Map(),keys=new Map(),mounts=new Set(),warned=new Set();
const st={frames:0,avg:0,stills:0};
function warnOnce(id,what,e){if(warned.has(id))return;warned.add(id);console.warn('Main Street: '+id+' '+what+' failed',e)}
function stillKey(d,s){try{return d.stillKey?String(d.stillKey(s)):''}catch(e){warnOnce(d.id,'stillKey',e);return''}}
function stamp(d,s){try{return d.stamp?String(d.stamp(s)):''}catch(e){warnOnce(d.id,'stamp',e);return''}}
// The world changed: new states, the buildings whose picture changed, then every mount repaints.
function setWorld(w){
 seen=true;lastW=w;const changed=[];
 for(const d of defs()){
  try{states.set(d.id,d.state(w))}catch(e){warnOnce(d.id,'state',e);if(!states.has(d.id))states.set(d.id,{})}
  const k=stillKey(d,states.get(d.id));if(keys.has(d.id)&&keys.get(d.id)!==k)changed.push(d.id);keys.set(d.id,k);
 }
 for(const m of mounts)m.world(changed,w);
}
// The shared poller: one /api/world request every 10 s while some strip is on screen and the page visible (one at a time,
// at least 2 s apart; a strip coming on screen or the page becoming visible polls at once, or when the 2 s are up). Only
// a good answer (ok, JSON, schema 1) within 8 s goes to setWorld; any other answer, or none in 8 s, marks every strip
// stale until the next good one.
let timer=0,busy=false,was=false,failed=false,lastAt=-Infinity,later=0;
// A node is rendered unless it or an ancestor is display:none (Home's view is, while another page is open).
const visible=n=>n.checkVisibility?n.checkVisibility():n.offsetParent!==null;
const onScreen=n=>{if(!visible(n))return false;const r=n.getBoundingClientRect();return r.bottom>0&&r.right>0&&r.top<root.innerHeight&&r.left<root.innerWidth&&r.width>0};
const live=()=>{for(const m of mounts)if(m.on())return true;return false};
const shown=()=>{const d=root.document;return !!d&&!d.hidden&&d.visibilityState!=='hidden'&&live()};
function paintStale(){for(const m of mounts)m.stale(failed)}
// An abort signal that fires after ms (AbortSignal.timeout where there is one) and a cleanup for the fallback's timer.
function deadline(ms){
 if(typeof AbortSignal!=='undefined'&&AbortSignal.timeout)return{signal:AbortSignal.timeout(ms),done(){}};
 if(typeof AbortController==='undefined')return{signal:undefined,done(){}};
 const a=new AbortController(),t=setTimeout(()=>a.abort(),ms);return{signal:a.signal,done(){clearTimeout(t)}};
}
async function poll(){
 if(busy)return;const wait=lastAt+MIN_GAP-Date.now();
 if(wait>0){if(!later)later=setTimeout(()=>{later=0;if(shown())poll()},wait);return}
 busy=true;lastAt=Date.now();const dl=deadline(WAIT);
 try{
  const r=await fetch('/api/world',{cache:'no-cache',credentials:'same-origin',signal:dl.signal});if(!r.ok)throw 0;
  const w=await r.json();if(!w||w.schema!==1)throw 0;
  failed=false;setWorld(w);
 }catch{failed=true}
 dl.done();busy=false;paintStale();
}
function sync(){const a=shown();if(a&&!was)poll();was=a}
function onVis(){sync()}
function start(){if(timer)return;timer=setInterval(()=>{if(shown())poll()},10000);root.document.addEventListener('visibilitychange',onVis)}
function stop(){clearInterval(timer);clearTimeout(later);timer=later=0;was=false;root.document.removeEventListener('visibilitychange',onVis)}
function stats(){const T=root.LocalAIStreetTraffic,N=root.LocalAIStreetNight;return{frames:st.frames,avgMs:Math.round(st.avg*1000)/1000,stills:st.stills,night:!!N&&N.isNight(),...(T?T.stats():{cars:0,beacons:0,stalled:0,beaconAt:[]})}}

// What a building's chip opens: its def's item for the state (null for a def with none, or one that throws).
function itemOf(d){try{return d.item&&d.item(states.get(d.id)||{})||null}catch(e){warnOnce(d.id,'item',e);return null}}
function animates(d,s){try{return d.animates?!!d.animates(s):typeof d.drawLive==='function'}catch(e){warnOnce(d.id,'animates',e);return true}}
function mount(el,opts){
 opts=opts||{};const A=root.LocalAIStreetArt,N=root.LocalAIStreetNight,doc=el.ownerDocument;
 const box=doc.createElement('div'),cv=doc.createElement('canvas'),chipsEl=doc.createElement('div');
 box.className='street';box.setAttribute('role','region');box.setAttribute('aria-label','Agent World street');cv.className='street__canvas';cv.setAttribute('aria-hidden','true');chipsEl.className='street__chips';box.hidden=true;box.append(cv,chipsEl);el.append(box);
 const c=cv.getContext('2d'),mq=root.matchMedia?root.matchMedia('(prefers-reduced-motion: reduce)'):null,reduce=()=>!!(mq&&mq.matches);
 // moving: some building drawn in the last frame animates (true until a frame says otherwise).
 let list=[],xs=new Map(),zoom=1,dpr=1,streetW=0,inView=false,raf=0,last=0,userAt=-Infinity,dead=false,drag=null,sig='',moving=true,nt=!!N&&N.now();
 const t0=performance.now(),stills=new Map(),chips=new Map(),T=root.LocalAIStreetTraffic?.make(),at=()=>list.map(d=>({d,s:states.get(d.id)||{},x:xs.get(d.id)/zoom}));
 const fits=()=>streetW<=box.clientWidth+1;
 // Buildings left to right, each centred in a slot at least SLOT CSS px wide so its chip has room; when the street
 // fits, the spare width goes into the gaps so it fills the strip. xs holds each building's left edge in CSS px from
 // the street's start; the chips' layer is as wide as the street (or the box, when it fits).
 // The buildings standing now: a state with hidden:true leaves the street (its still stays cached). shape() names the
 // set, so a building hiding or showing re-flows the layout.
 const stand=()=>defs().filter(d=>!(states.get(d.id)||{}).hidden),shape=()=>ver+':'+stand().map(d=>d.id);
 function layout(){
  list=stand();sig=shape();xs=new Map();
  const vw=box.clientWidth,pad=PAD*zoom,gap=GAP*zoom,n=list.length,slot=d=>Math.max(d.width*zoom,SLOT);
  const need=2*pad+list.reduce((a,d)=>a+slot(d),0)+gap*Math.max(0,n-1),spare=Math.max(0,vw-need);
  let x=n>1?pad:pad+spare/2;
  for(const d of list){xs.set(d.id,x+(slot(d)-d.width*zoom)/2);x+=slot(d)+gap+(n>1?spare/(n-1):0)}
  streetW=need;chipsEl.style.width=Math.max(vw,need)+'px';
  for(const [id,b] of chips)if(!byId.has(id)||!xs.has(id)){b.remove();chips.delete(id)}
  for(const d of list){
   let b=chips.get(d.id);
   if(!b){b=doc.createElement('button');b.type='button';b.append(doc.createElement('span'),doc.createElement('span'));b.addEventListener('click',()=>opts.onOpen&&opts.onOpen(d.id,itemOf(d)));chips.set(d.id,b)}
   chipsEl.append(b);// keeps DOM order = street order
   b.style.left=xs.get(d.id)+d.width*zoom/2+'px';
  }
 }
 function paintChips(){
  for(const d of list){
   const b=chips.get(d.id);let ch;try{ch=d.chip(states.get(d.id)||{})}catch(e){warnOnce(d.id,'chip',e);continue}
   const title=String(ch.title||d.id),detail=String(ch.detail||''),[a,z]=b.children;
   if(a.textContent!==title)a.textContent=title;if(z.textContent!==detail)z.textContent=detail;
   const hint=itemOf(d)?'Opens this run':'Opens Agent World';if(b.title!==hint){b.title=hint;b.setAttribute('aria-description',hint)}
   b.setAttribute('aria-label',title+': '+detail);b.className='street-chip street-chip--'+(ch.tone||'quiet');
   // On the roof line, but never above the strip's top (a long detail wraps to a second line).
   const base=(H-(d.roof||120))*zoom+4;b.style.bottom=base+'px';const over=2-b.offsetTop;if(over>0)b.style.bottom=base-over+'px';
  }
 }
 // A building's still: rebuilt only when its key changes (a new picture, zoom, DPR or night).
 function still(d){
  const s=states.get(d.id)||{},key=[d.id,zoom,dpr,nt,stillKey(d,s),stamp(d,s)].join('|'),o=stills.get(d.id);
  if(o&&o.key===key)return o.cv;
  const sc=(o&&o.cv)||doc.createElement('canvas');sc.width=Math.ceil(d.width*zoom*dpr);sc.height=Math.round(H*zoom*dpr);
  const g=sc.getContext('2d');g.setTransform(zoom*dpr,0,0,zoom*dpr,0,0);
  try{d.drawStill(g,s,env())}catch(e){warnOnce(d.id,'drawStill',e)}
  let lit=null;if(nt)try{lit=N.layer(doc,d,s,zoom,dpr,o&&o.lit&&o.lit.cv)}catch(e){warnOnce(d.id,'lights',e)}
  stills.set(d.id,{key,cv:sc,lit});st.stills++;return sc;
 }
 const env=()=>({night:nt,reduced:reduce(),zoom,dpr});
 // A new size or DPR (a ResizeObserver call with neither changed is ignored): canvas, layout, chips, stills, a frame.
 let sized='';
 function resize(){
  if(dead||box.hidden)return;dpr=root.devicePixelRatio||1;
  const w=Math.round(box.clientWidth*dpr),h=Math.round(cv.clientHeight*dpr),now=[w,h,dpr].join();if(now===sized)return;sized=now;
  if(cv.width!==w)cv.width=w;if(cv.height!==h)cv.height=h;
  zoom=(cv.clientHeight||160)/H;layout();paintChips();for(const d of list)still(d);redraw();
 }
 function draw(t){
  if(dead||box.hidden||!cv.width)return;if((root.devicePixelRatio||1)!==dpr)return resize();
  if(shape()!==sig){layout();paintChips()}
  const a=performance.now(),S=zoom*dpr,vw=cv.width/S,x0=box.scrollLeft/zoom,e=env();
  c.setTransform(S,0,0,S,0,0);
  if(A){if(nt)N.sky(c,x0,vw);else{const P=A.palette,g=c.createLinearGradient(0,0,0,300);g.addColorStop(0,P.sky0);g.addColorStop(.6,P.sky1);g.addColorStop(1,P.sky2);
   c.fillStyle=g;c.fillRect(0,0,vw,300)}
   c.globalAlpha=nt?.3:1;for(const [k,L] of [[.5,0],[.25,1]]){c.save();c.translate(-x0*(1-k),0);A.skyline(c,x0*(1-k),vw,L);c.restore()}c.globalAlpha=1;
   c.save();c.translate(-x0,0);A.sidewalk(c,x0,vw);A.road(c,x0,vw);c.restore()}
  let mv=false;
  for(const d of list){
   const dx=Math.round((xs.get(d.id)-box.scrollLeft)*dpr),sc=still(d);
   if(dx>cv.width||dx+sc.width<0)continue;
   if(!mv&&animates(d,states.get(d.id)||{}))mv=true;
   c.setTransform(1,0,0,1,0,0);c.drawImage(sc,dx,0);c.save();c.setTransform(S,0,0,S,dx,0);
   try{d.drawLive(c,states.get(d.id)||{},t,e)}catch(err){warnOnce(d.id,'drawLive',err)}
   c.restore();
  }
  if(T){c.setTransform(S,0,0,S,-x0*S,0);if(T.draw(c,at(),x0,vw,Math.max(streetW,box.clientWidth)/zoom,reduce()))mv=true}
  if(nt){c.setTransform(S,0,0,S,0,0);N.dim(c,vw);c.globalCompositeOperation='lighter';c.setTransform(1,0,0,1,0,0);
   for(const d of list){const l=stills.get(d.id)?.lit,dx=Math.round((xs.get(d.id)-box.scrollLeft)*dpr)-(l?l.off:0);if(l&&dx<cv.width&&dx+l.cv.width>0)c.drawImage(l.cv,dx,0)}
   if(T){c.setTransform(S,0,0,S,-x0*S,0);N.glows(c,T.lit())}c.globalCompositeOperation='source-over'}
  moving=mv;st.frames++;const ms=performance.now()-a;st.avg=st.frames>1?st.avg*.9+ms*.1:ms;
 }
 const running=()=>!dead&&!box.hidden&&inView&&doc.visibilityState!=='hidden'&&!reduce()&&moving;
 function tick(now){raf=0;if(!running())return;raf=root.requestAnimationFrame(tick);if(now-last<FRAME)return;last=now;draw(now-t0)}
 // Something may have changed: run at least one more frame, which decides whether the loop keeps going.
 const go=()=>{if(running()&&!raf)raf=root.requestAnimationFrame(tick)};
 function kick(){moving=true;go()}
 function redraw(){if(reduce())draw(0);else kick()}
 // A new world: unhide on the first (on screen if it is rendered at all; the observer takes over), redraw the chips, and bring a changed building into view unless the person
 // scrolled lately.
 // The first world: a street wider than the strip opens on the first building that needs you, else the first busy one.
 function firstLook(){
  if(fits())return;const tone=t=>list.find(d=>chips.get(d.id)?.classList.contains('street-chip--'+t)),d=tone('attention')||tone('busy');if(!d)return;
  const l=xs.get(d.id),r=l+d.width*zoom,vw=box.clientWidth;if(r>vw)box.scrollTo({left:Math.max(0,(l+r-vw)/2),behavior:'instant'});
 }
 function onWorld(changed,w){
  if(dead)return;if(box.hidden){box.hidden=false;inView=onScreen(box);resize();firstLook()}else{if(shape()!==sig)layout();paintChips();for(const d of list)still(d);redraw()}
  T&&T.world(w,at(),onScreen(box)&&doc.visibilityState!=='hidden',reduce());
  const id=changed.find(i=>xs.has(i));if(!id||fits()||Date.now()-userAt<QUIET)return;
  const d=byId.get(id),l=xs.get(id),r=l+d.width*zoom,vw=box.clientWidth;
  if(l>=box.scrollLeft&&r<=box.scrollLeft+vw)return;
  box.scrollTo({left:Math.max(0,(l+r-vw)/2),behavior:reduce()?'auto':'smooth'});
 }
 const touched=()=>{userAt=Date.now()};
 // A plain vertical wheel scrolls the page (never prevented); a trackpad's sideways swipe scrolls the street natively;
 // shift+wheel turns a vertical wheel sideways.
 function onWheel(e){
  if(fits())return;const side=Math.abs(e.deltaX)>Math.abs(e.deltaY);if(!side&&!e.shiftKey)return;touched();if(side)return;
  const k=e.deltaMode===1?16:e.deltaMode===2?box.clientWidth:1,to=Math.max(0,Math.min(box.scrollWidth-box.clientWidth,box.scrollLeft+e.deltaY*k));
  if(to!==box.scrollLeft){e.preventDefault();box.scrollLeft=to}
 }
 function onDown(e){drag=null;if(e.pointerType!=='mouse'||e.button!==0||fits())return;touched();drag={x:e.clientX,left:box.scrollLeft,moved:false};root.addEventListener('pointermove',onMove);root.addEventListener('pointerup',onUp)}
 function onMove(e){if(!drag)return;const dx=e.clientX-drag.x;if(Math.abs(dx)>4)drag.moved=true;if(drag.moved){touched();box.scrollLeft=drag.left-dx}}
 function onUp(){root.removeEventListener('pointermove',onMove);root.removeEventListener('pointerup',onUp);}
 // The click that ends a drag is eaten (a later press starts a new drag; a keyboard click has detail 0 and goes through).
 function onClick(e){if(drag&&drag.moved&&e.detail){e.preventDefault();e.stopPropagation()}drag=null}
 // Scrolling repaints at once so the canvas keeps up with the chips; the loop then waits a frame.
 function onScroll(){if(box.hidden)return;last=performance.now();draw(reduce()?0:last-t0);go()}// go: the loop resumes if a moving building scrolled into view
 const onVis=()=>kick(),onMotion=()=>redraw();
 box.addEventListener('wheel',onWheel,{passive:false});box.addEventListener('pointerdown',onDown);box.addEventListener('click',onClick,true);
 box.addEventListener('touchstart',touched,{passive:true});box.addEventListener('keydown',touched);box.addEventListener('scroll',onScroll,{passive:true});
 doc.addEventListener('visibilitychange',onVis);if(mq)mq.addEventListener('change',onMotion);
 const ro=root.ResizeObserver?new ResizeObserver(()=>{if(!dead&&!box.hidden&&!cv.width&&box.clientWidth)inView=onScreen(box);// first rendered (its page just showed); the observer corrects
  resize();sync()}):null;if(ro)ro.observe(box);
 const io=root.IntersectionObserver?new IntersectionObserver(es=>{inView=es[es.length-1].isIntersecting;kick();sync()}):null;if(io)io.observe(box);else inView=true;
 // The stale chip is one extra chip, first in the layer, that sticks to the left edge of the view.
 let sc=null;
 function onStale(f){
  if(dead)return;box.classList.toggle('is-stale',f);
  if(f&&!sc){sc=doc.createElement('div');sc.className='street-chip street-chip--stale';sc.setAttribute('role','status');sc.textContent="Can't reach LocalAI, retrying";chipsEl.prepend(sc)}
  else if(!f&&sc){sc.remove();sc=null}
 }
 const inst={world:onWorld,stale:onStale,on:()=>!dead&&(box.hidden?visible(el):inView)};mounts.add(inst);
 const unwatch=N&&N.watch(v=>{if(dead)return;nt=v;if(!box.hidden){for(const d of list)still(d);redraw()}});
 if(seen)onWorld([],lastW);onStale(failed);start();sync();
 return{destroy(){
  if(dead)return;dead=true;mounts.delete(inst);if(!mounts.size)stop();if(raf)root.cancelAnimationFrame(raf);raf=0;onUp();
  if(ro)ro.disconnect();if(io)io.disconnect();unwatch&&unwatch();T&&T.destroy();doc.removeEventListener('visibilitychange',onVis);if(mq)mq.removeEventListener('change',onMotion);box.remove();
 }};
}
// Home's strip: mounted once into #homeStreetMount (repeat calls do nothing); a building opens its run, else the old Agent World.
let home=null;
function mountHome(){const el=root.document.getElementById('homeStreetMount');if(!el||home&&home.el===el)return;home={el,m:mount(el,{mode:'strip',onOpen:(id,item)=>item&&root.LocalAIRuns&&root.LocalAIRuns.show?root.LocalAIRuns.show(item.id):root.LocalAIRouter.go('#agents')})}}
const api=root.LocalAIStreet=Object.assign(root.LocalAIStreet||{},{register,ORDER,defs,mount,mountHome,setWorld,stats});
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
