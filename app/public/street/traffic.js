// Main Street traffic: window.LocalAIStreetTraffic, a layer the engine (street.js) draws over the buildings of each mount.
// - A beacon (art.js beacon, amber) stands on the roof centre of a building whose state needs you (needsYou > 0).
// - A stalled car (art.js car) with its hazards on is parked at the kerb in front of a building with a failure (failed > 0).
//   At most one of each per building; a hidden building is off the street and gets neither.
// - Each beacon and hazard pulses for 60 s from the first time this mount saw its ask (state.first.id), then stays steady;
//   ids that leave are forgotten. Under reduced motion they are steady from the start.
// - A run that was in street[key].running and is now in street[key].recent as completed sends a car out of its building
//   and off the right end of the street over 4 s, at most 3 at once. Only between two worlds this mount got while it was
//   on screen (a world while hidden or off screen resets the baseline: no burst of cars on return), never under reduced motion.
// make() -> {world(w, list, on, reduced), draw(c, list, x0, vw, end, reduced) -> moving, destroy()}, one per mount: list is
// the standing buildings as {d: def, s: state, x: left edge in scene units}; c is in scene units with the street's start at
// x = 0, [x0, x0 + vw] the view and end the street's right end. Moving: a pulse or a car driving (the engine's idle rule).
// stats() -> {cars driving, beacons and stalled cars drawn in the last frame}.
(function(root){'use strict';
const PULSE=60000,DRIVE=4000,MAX=3,AMBER='#ffb02e',KERB=318,LANE=336,COLS=['#3a7bd5','#c0392b','#2e8b57','#e0a030','#7d5ba6','#e9ecef'];
const all=new Set();let beacons=0,stalled=0;
const now=()=>performance.now();
const hue=id=>{let h=0;for(const ch of String(id))h=h*31+ch.charCodeAt(0)|0;return COLS[Math.abs(h)%COLS.length]};
function make(){
 const seen=new Map();let prev=null,cars=[];
 const self={cars:()=>(cars=cars.filter(k=>now()-k.t<DRIVE)).length};all.add(self);
 // A world: remember when each ask was first seen, and send a car for each run that finished since the last world on screen.
 function world(w,list,on,reduced){
  const t=now(),ids=new Set();
  for(const d of list){const s=d.s;if(s.needsYou>0||s.failed>0){const k=d.d.id+':'+(s.first&&s.first.id);ids.add(k);if(!seen.has(k))seen.set(k,t)}}
  for(const k of seen.keys())if(!ids.has(k))seen.delete(k);
  const st=w&&w.street,next=new Map();
  if(st&&on)for(const d of list){const r=st[d.d.id];if(!r)continue;next.set(d.d.id,new Set((r.running||[]).map(i=>i&&i.id)));
   const was=prev&&prev.get(d.d.id);if(!was||reduced)continue;
   for(const i of r.recent||[])if(i&&i.status==='completed'&&was.has(i.id)&&self.cars()<MAX)cars.push({x:d.x+d.d.width/2,t,id:i.id,c:hue(i.id)})}
  prev=st&&on?next:null;
 }
 // 0..1: a pulse while the ask is under 60 s old (and motion is allowed), else 1 (steady; an ask never seen by world() too).
 const level=(k,t,reduced)=>{const a=t-(seen.get(k)??-Infinity);return reduced||a>=PULSE?1:.5+.5*Math.sin(a/1200*Math.PI*2)};
 function draw(c,list,x0,vw,end,reduced){
  const A=root.LocalAIStreetArt;if(!A)return false;const t=now();let mv=false;beacons=stalled=0;
  for(const d of list){const s=d.s,x=d.x,w=d.d.width;if(x>x0+vw||x+w<x0||!(s.needsYou>0||s.failed>0))continue;
   const k=d.d.id+':'+(s.first&&s.first.id),g=level(k,t,reduced);if(!reduced&&t-(seen.get(k)??-Infinity)<PULSE)mv=true;
   if(s.failed>0){A.car(c,x+w/2,KERB,{color:'#8a8f98',hazard:g});stalled++}
   if(s.needsYou>0){A.beacon(c,x+w/2,d.d.roof||120,{glow:g,color:AMBER});beacons++}}
  // Departing cars: out of the kerb into the lane in the first second, speeding up to the end of the street.
  if(self.cars())mv=true;
  for(const k of cars){const p=(t-k.t)/DRIVE,e=p*p,x=k.x+(end+60-k.x)*e;
   A.car(c,x,KERB+(LANE-KERB)*Math.min(1,p*4),{color:k.c,wheel:(x-k.x)/7})}
  return mv;
 }
 return{world,draw,destroy(){all.delete(self)}};
}
function stats(){let cars=0;for(const m of all)cars+=m.cars();return{cars,beacons,stalled}}
root.LocalAIStreetTraffic={make,stats};
})(typeof window!=='undefined'?window:globalThis);
