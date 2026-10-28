// Main Street traffic: window.LocalAIStreetTraffic, a layer the engine (street.js) draws over the buildings of each mount.
// - A beacon (art.js beacon, an amber warning light on a wall bracket) hangs on the façade of a building whose state needs
//   you (needsYou > 0), at def.beacon {x, y} in building coordinates, else {x: width - 22, y: 200}: below the roof line,
//   where the strip's chips (which sit on the roof line) never cover it.
// - A stalled car (art.js car) with its hazards on is parked at the kerb in front of a building with a failure (failed > 0).
//   At most one of each per building; a hidden building is off the street and gets neither.
// - The beacon pulses for 60 s from the first time this mount saw the building's first needs-you id, the hazards for 60 s
//   from its first failure id (street[key].needsYou[0] / failedUnseen[0], else state.first), each then steady; ids that
//   leave are forgotten. Under reduced motion they are steady from the start.
// - A run that was in street[key].running and is now in street[key].recent as completed sends a car out of its building
//   and off the right end of the street over 4 s, at most 3 at once (more finishing together are dropped on purpose: a
//   burst stays readable). Only between two worlds this mount got while it was
//   on screen (a world while hidden or off screen resets the baseline: no burst of cars on return), never under reduced motion.
// make() -> {world(w, list, on, reduced), draw(c, list, x0, vw, end, reduced) -> moving, lit(), destroy()}, one per mount: list is
// the standing buildings as {d: def, s: state, x: left edge in scene units}; c is in scene units with the street's start at
// x = 0, [x0, x0 + vw] the view and end the street's right end. Moving: a pulse or a car driving (the engine's idle rule).
// lit() is the last draw's lights for night.js glows ({x, y, r, color, a} in the same units): beacons, hazards, car lamps.
// stats() -> {cars driving in every mount; beacons, stalled cars and where the beacons stood (beaconAt [[id, x, y]],
// building coordinates) in the last frame any mount drew: global, for tests}.
(function(root){'use strict';
const PULSE=60000,DRIVE=4000,MAX=3,AMBER='#ffb02e',KERB=318,LANE=336,COLS=['#3a7bd5','#c0392b','#2e8b57','#e0a030','#7d5ba6','#e9ecef'];
const all=new Set();let beacons=0,stalled=0,beaconAt=[];
const now=()=>performance.now();
const hue=id=>{let h=0;for(const ch of String(id))h=h*31+ch.charCodeAt(0)|0;return COLS[Math.abs(h)%COLS.length]};
const id0=(a,s)=>a&&a[0]&&a[0].id||s.first&&s.first.id;
function make(){
 const seen=new Map(),keys=new Map();let prev=null,cars=[],lit=[];
 const self={cars:()=>(cars=cars.filter(k=>now()-k.t<DRIVE)).length};all.add(self);
 // A world: remember when each ask was first seen, and send a car for each run that finished since the last world on screen.
 function world(w,list,on,reduced){
  const t=now(),ids=new Set(),st=w&&w.street,next=new Map();keys.clear();
  for(const d of list){const s=d.s,r=st&&st[d.d.id]||{},id=d.d.id,k=[id+':b:'+id0(r.needsYou,s),id+':h:'+id0(r.failedUnseen,s)];keys.set(id,k);
   for(const [i,on] of [[0,s.needsYou>0],[1,s.failed>0]])if(on){ids.add(k[i]);if(!seen.has(k[i]))seen.set(k[i],t)}}
  for(const k of seen.keys())if(!ids.has(k))seen.delete(k);
  if(st&&on)for(const d of list){const r=st[d.d.id];if(!r)continue;next.set(d.d.id,new Set((r.running||[]).map(i=>i&&i.id)));
   const was=prev&&prev.get(d.d.id);if(!was||reduced)continue;
   for(const i of r.recent||[])if(i&&i.status==='completed'&&was.has(i.id)&&self.cars()<MAX)cars.push({x:d.x+d.d.width/2,t,id:i.id,c:hue(i.id)})}
  prev=st&&on?next:null;
 }
 // 0..1: a pulse while the ask is under 60 s old (and motion is allowed), else 1 (steady; an ask never seen by world() too).
 const level=(k,t,reduced)=>{const a=t-(seen.get(k)??-Infinity);return reduced||a>=PULSE?1:.5+.5*Math.sin(a/1200*Math.PI*2)};
 function draw(c,list,x0,vw,end,reduced){
  const A=root.LocalAIStreetArt;if(!A)return false;const t=now();let mv=false;beacons=stalled=0;beaconAt=[];lit=[];
  for(const d of list){const s=d.s,x=d.x,w=d.d.width;if(x>x0+vw||x+w<x0||!(s.needsYou>0||s.failed>0))continue;
   const [kb,kh]=keys.get(d.d.id)||[],b=d.d.beacon||{x:w-22,y:200};
   for(const k of [s.needsYou>0&&kb,s.failed>0&&kh])if(k&&!reduced&&t-(seen.get(k)??-Infinity)<PULSE)mv=true;
   if(s.failed>0){const h=level(kh,t,reduced);A.car(c,x+w/2,KERB,{color:'#8a8f98',hazard:h});stalled++;for(const k of [-1,1])lit.push({x:x+w/2+k*34.5,y:KERB+.5,r:18,color:AMBER,a:.55*h})}
   if(s.needsYou>0){const g=level(kb,t,reduced);A.beacon(c,x+b.x,b.y,{glow:g,color:AMBER});beacons++;beaconAt.push([d.d.id,b.x,b.y]);lit.push({x:x+b.x,y:b.y-22,r:48,color:AMBER,a:.5*g})}}
  // Departing cars: out of the kerb into the lane in the first second, speeding up to the end of the street.
  if(self.cars())mv=true;
  for(const k of cars){const p=(t-k.t)/DRIVE,e=p*p,x=k.x+(end+60-k.x)*e;
   const y=KERB+(LANE-KERB)*Math.min(1,p*4);A.car(c,x,y,{color:k.c,wheel:(x-k.x)/7});lit.push({x:x+40,y:y+1.5,r:26,color:'#ffe9a8',a:.6},{x:x-35,y:y+1,r:10,color:'#ff3b30',a:.5})}
  return mv;
 }
 return{world,draw,lit:()=>lit,destroy(){all.delete(self)}};
}
function stats(){let cars=0;for(const m of all)cars+=m.cars();return{cars,beacons,stalled,beaconAt}}
const api={make,stats};
if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalAIStreetTraffic=api;
})(typeof window!=='undefined'?window:globalThis);
