// Main Street at night: window.LocalAIStreetNight, loaded with the street (home.js STREET_MODS). Night is 19:00 to 07:00
// local time: now() reads it (each mount asks once), and watch(fn) -> unwatch calls fn(night) when it changes, from one
// shared timer that checks once a minute while anyone watches. The engine (street.js) draws a night frame as: sky() (a
// dark sky with stars and a moon) under the far city, the buildings and cars as by day, then dim() (a blue-black wash
// over the whole canvas), then, added on top ('lighter'), each building's light layer and glows() for the traffic's
// beacons and lamps. layer() paints a building's lights (def.lights(state) -> [{x, y, w, h, color, kind}] in building
// coordinates; kind 'window' a lit room, 'lamp' a bulb, 'glow' a sign or a fire) into its own canvas, cached by the
// engine with the building's still, so a quiet street at night still draws nothing per frame. Each light also falls on
// the wet road: a reflection mirrored (squashed) below the ground line, 0.35 at its top and fading downward.
(function(root){'use strict';
const GROUND=300,H=360,PAD=40,TAU=Math.PI*2,subs=new Set();let cur=null,timer=0;
const isNight=d=>{const h=(d||new Date()).getHours();return h>=19||h<7};
function check(){const n=isNight();if(n===cur)return;const was=cur;cur=n;if(was!==null)for(const f of [...subs])f(n)}
function now(){check();return cur}
function watch(f){subs.add(f);if(!timer)timer=setInterval(check,60000);return()=>{subs.delete(f);if(!subs.size&&timer){clearInterval(timer);timer=0}}}
function rgba(hex,a){const n=parseInt(hex.slice(1),16);return `rgba(${n>>16},${n>>8&255},${n&255},${a})`}
// A soft elliptical halo: colour at the centre, half at 40%, nothing at the edge.
function halo(c,cx,cy,rx,ry,col,a){
 if(!(rx>0&&ry>0&&a>0))return;c.save();c.translate(cx,cy);c.scale(1,ry/rx);const g=c.createRadialGradient(0,0,0,0,0,rx);
 g.addColorStop(0,rgba(col,a));g.addColorStop(.4,rgba(col,a*.4));g.addColorStop(1,rgba(col,0));c.fillStyle=g;c.beginPath();c.arc(0,0,rx,0,TAU);c.fill();c.restore();
}
// A light from y to y + h over [x, x + w] seen in the wet road: below the ground line, as far down as the light is up
// (squashed), 0.35 (times k) at the top fading downward, with brighter ripples across it.
function reflect(c,x,w,y,h,col,k){
 const y0=GROUND+Math.max(2,(GROUND-y-h)*.22),y1=GROUND+(GROUND-y)*.9+30;if(y0>=H||w<=0)return;
 const cx=x+w/2,rx=w*.6,ry=y1-y0,g=c.createRadialGradient(0,0,0,0,0,rx);c.save();c.beginPath();c.rect(x-w,y0,w*3,H-y0);c.clip();c.translate(cx,y0);c.scale(1,ry/rx);
 g.addColorStop(0,rgba(col,.35*k));g.addColorStop(.55,rgba(col,.2*k));g.addColorStop(1,rgba(col,0));c.fillStyle=g;c.beginPath();c.arc(0,0,rx,0,TAU);c.fill();c.restore();
 c.fillStyle=rgba(col,.1*k);c.beginPath();for(let yy=y0+2,i=0;yy<Math.min(H,y1);yy+=4,i++){const ww=w*(.35+(i*7%5)*.1)*(1-(yy-y0)/ry);c.rect(x+(w-ww)/2+(i%3-1)*w*.06,yy,ww,1.2)}c.fill();
}
function paint(c,l){
 const {x,y,w,h,color:col}=l,cx=x+w/2,cy=y+h/2;
 if(l.kind==='window'){c.fillStyle=rgba(col,.2);c.fillRect(x,y,w,h);halo(c,cx,cy,w*.8+22,h*.8+22,col,.26);halo(c,cx,GROUND+4,w*.7+16,9,col,.36);reflect(c,x+2,w-4,y,h,col,1)}
 else if(l.kind==='lamp'){halo(c,cx,cy,4+w/2,4+w/2,'#ffffff',.85);halo(c,cx,cy+5,30,24,col,.38);halo(c,cx,GROUND+4,24,6,col,.3);reflect(c,cx-5,10,y,h,col,.6)}
 else{halo(c,cx,cy,w*.6+18,h*.6+18,col,.42);reflect(c,x+w*.15,w*.7,y,h,col,.9)}
}
// A building's lights in a canvas PAD units wider each side (a halo spills past the walls); off is that pad in device
// pixels, so the engine draws it at its still's x - off. null when it has none.
function layer(doc,d,s,zoom,dpr,old){
 const L=d.lights?d.lights(s)||[]:[];if(!L.length)return null;
 const cv=old||doc.createElement('canvas'),off=Math.round(PAD*zoom*dpr);cv.width=Math.ceil(d.width*zoom*dpr)+2*off;cv.height=Math.round(H*zoom*dpr);
 const g=cv.getContext('2d');g.setTransform(zoom*dpr,0,0,zoom*dpr,off,0);g.globalCompositeOperation='lighter';for(const l of L)paint(g,l);
 return{cv,off};
}
// The traffic's lights this frame ({x, y, r, color, a} in the street's units).
function glows(c,list){for(const l of list||[]){halo(c,l.x,l.y,l.r,l.r*.75,l.color,l.a);reflect(c,l.x-l.r*.15,l.r*.3,l.y-2,4,l.color,l.a*1.6)}}
// The night wash over everything, a little more on the sidewalk (the lit road stays wet and bright), and the moon high
// in the view's top right, above the roofs.
function dim(c,vw){
 c.fillStyle='rgba(6, 10, 24, 0.5)';c.fillRect(0,0,vw,H);c.fillStyle='rgba(6, 10, 24, 0.3)';c.fillRect(0,GROUND,vw,27);
 const mx=vw-60,my=22;halo(c,mx,my,34,34,'#cfd8ff',.25);c.fillStyle='#f4efd8';c.beginPath();c.arc(mx,my,9,0,TAU);c.fill();c.fillStyle='rgba(20,30,70,.15)';c.beginPath();c.arc(mx+2.5,my-2,2.5,0,TAU);c.arc(mx-3,my+3,1.8,0,TAU);c.fill();
}
const hash=i=>Math.abs(Math.sin(i*91.345+7.13)*43758.5453)%1;
// The night sky in the view [x0, x0 + vw]: deep blue to a city-lit violet at the horizon, stars fixed far off (a tenth
// of the street's scroll). The moon is dim()'s, over the wash.
function sky(c,x0,vw){
 const g=c.createLinearGradient(0,0,0,GROUND);g.addColorStop(0,'#060b1f');g.addColorStop(.55,'#14204a');g.addColorStop(1,'#4a3560');c.fillStyle=g;c.fillRect(0,0,vw,GROUND);
 const s=x0*.1;c.fillStyle='#ffffff';c.beginPath();
 for(let i=Math.floor(s/18);i*18<s+vw;i++){const r=hash(i),q=hash(i+.37),z=r>.85?2.2:1.3;if(q<.25)continue;c.rect(i*18+r*18-s,4+q*q*170,z,z)}c.fill();
}
const api={isNight,now,watch,layer,glows,dim,sky};
root.LocalAIStreetNight=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
