// Main Street's drawing kit: window.LocalAIStreetArt. Every building draws with these, so the street looks like one
// place at the art bar (docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html); the palette and shapes are
// lifted from that file's SVG. Each helper only draws: it takes (ctx, ...) in scene units, keeps no state, and leaves
// the context as it found it (save/restore). The scene is 360 units tall and the ground line is y = 300; a building
// draws in its own box. Everything is vector at full resolution: never pixelated, never smoothing turned off.
// Budget: tests/budgets.test.cjs (street/*.js 48 KB in all, 8 KB each, gzipped), so keep helpers generic and add
// parameters rather than per-building code.
(function(root){'use strict';
const P=Object.freeze({
 sky0:'#5f9bd8',sky1:'#a9cdee',sky2:'#f3dcc0',haze:'#e9d6c4',far0:'#7f97b4',far1:'#93a9c2',cloud:'#ffffff',
 mortar:'#8f3a46',brick:'#b4505e',brickHi:'#d77b88',sideMortar:'#5e222c',side:'#76303b',
 roof:'#59657a',corr:'#6f7c8e',corrMid:'#9aa7b8',corrHi:'#c8d2de',
 steel0:'#4a5260',steel1:'#a5afbd',steel2:'#7d8796',steel3:'#3c434f',frame:'#2d3138',dark:'#2a2d33',
 interior0:'#2a1418',interior1:'#4a1f1a',furnace0:'#fff7d6',furnace1:'#ffc24d',furnace2:'#f0682a',furnace3:'#8a2a14',
 spill:'#ffb04a',molten0:'#fff2b0',molten1:'#ff8a2a',pour:'#ffcf6a',ray:'#ffd38a',lamp:'#fff4cc',
 crate0:'#e2ad6e',crate1:'#a5723e',crateLine:'#7a5228',belt:'#2b2f36',
 walk0:'#c4c9d1',walk1:'#9aa1ac',joint:'#8a919c',curb:'#e3e6ea',road0:'#4a5361',road1:'#363d48',lane:'#f2d67a',
 pants:'#2f3a52',vest:'#ff7e46',stripe:'#f3e45a',skin:'#e9b88f',hat:'#ffc640',brim:'#e3a51b',paper:'#d9e1ea',ink:'#7a8696',
 smoke0:'#f1f3f6',smoke1:'#d3d8df',bush0:'#4f8a55',bush1:'#5f9e64',bush2:'#6aaa6e',pole:'#3a404a'});
// Brick tones: [mortar, long brick, short brick, second short, second long, highlight]. red and side are the art bar's.
const TONES={red:['#8f3a46','#b4505e','#a44654','#a94a58','#bb5866','#d77b88'],side:['#5e222c','#76303b','#6c2b35','#702e38','#7a333e','#8c4450'],
 sand:['#a0825e','#cfae84','#c19f76','#c6a47b','#d6b68c','#ead2ae'],slate:['#4c5868','#6d7a8c','#64717f','#687586','#748294','#97a5b6']};
const ROAD=327,CURB=322,GROUND=300;
function rgba(hex,a){const n=parseInt(hex.slice(1),16);return `rgba(${n>>16},${n>>8&255},${n&255},${a})`}
function rr(c,x,y,w,h,r){if(c.roundRect)c.roundRect(x,y,w,h,r);else c.rect(x,y,w,h)}
function lin(c,x0,y0,x1,y1,stops){const g=c.createLinearGradient(x0,y0,x1,y1);for(const [o,col] of stops)g.addColorStop(o,col);return g}
function box(c,x,y,w,h,fill,r){c.fillStyle=fill;c.beginPath();rr(c,x,y,w,h,r||0);c.fill()}
function poly(c,pts){c.beginPath();pts.forEach(([px,py],i)=>i?c.lineTo(px,py):c.moveTo(px,py));c.closePath()}
// The light falling across a wall, top left to bottom right (the art bar's wallLight).
function wallLight(c,x,y,w,h){c.fillStyle=lin(c,x,y,x+w,y+h,[[0,'rgba(255,255,255,.16)'],[.55,'rgba(255,255,255,0)'],[1,'rgba(0,0,0,.22)']]);c.fillRect(x,y,w,h)}

// Bricks: rounded, two courses per 14 units, each colour drawn as one path, a highlight on some, and the wall light.
function bricks(c,x,y,w,h,t,light){
 c.save();c.beginPath();c.rect(x,y,w,h);c.clip();c.fillStyle=t[0];c.fillRect(x,y,w,h);
 const x0=x-((x%28)+28)%28,y0=y-((y%14)+14)%14,shapes=[[.6,.6,18.8,1],[20.6,.6,6.8,2],[.6,7.6,6.8,3],[8.6,7.6,18.8,4]];
 for(const [bx,by,bw,k] of shapes){c.fillStyle=t[k];c.beginPath();for(let yy=y0;yy<y+h;yy+=14)for(let xx=x0;xx<x+w;xx+=28)rr(c,xx+bx,yy+by,bw,5.8,1.2);c.fill()}
 c.fillStyle=rgba(t[5],.5);c.beginPath();for(let yy=y0;yy<y+h;yy+=14)for(let xx=x0;xx<x+w;xx+=28){rr(c,xx+2,yy+1.4,9,1.2,.6);rr(c,xx+11,yy+8.4,8,1.2,.6)}c.fill();
 if(light)wallLight(c,x,y,w,h);c.restore();
}
function brick(c,x,y,w,h,o){const tone=(o&&o.tone)||'red';if(tone==='side')return brickSide(c,x,y,w,h);bricks(c,x,y,w,h,TONES[tone]||TONES.red,true)}
// A side wall in shade. With {skew} its far edge rises (a wall turning away), as the art bar's Foundry side wall does.
function brickSide(c,x,y,w,h,o){
 const s=(o&&o.skew)||0;c.save();poly(c,[[x,y],[x+w,y-s],[x+w,y+h-s*.6],[x,y+h]]);c.clip();
 bricks(c,x,y-s,w,h+s,TONES.side,false);c.fillStyle='rgba(0,0,0,.12)';c.fillRect(x,y-s,w,h+s);c.restore();
}
// Corrugated metal: 10-unit ribs with a lit crest, and a bright edge along the top.
function corrugated(c,x,y,w,h){
 c.save();c.beginPath();c.rect(x,y,w,h);c.clip();c.fillStyle=P.corr;c.fillRect(x,y,w,h);
 for(const [dx,dw,col] of [[0,4,P.corrMid],[4,1.5,P.corrHi]]){c.fillStyle=col;c.beginPath();for(let xx=x;xx<x+w;xx+=10)c.rect(xx+dx,y,dw,h);c.fill()}
 c.fillStyle=lin(c,0,y,0,y+h,[[0,'rgba(255,255,255,.18)'],[.3,'rgba(255,255,255,0)'],[1,'rgba(0,0,0,.18)']]);c.fillRect(x,y,w,h);c.restore();
}
// Brushed steel: the art bar's left-to-right sheen, rounded a little.
function steel(c,x,y,w,h){c.save();box(c,x,y,w,h,lin(c,x,0,x+w,0,[[0,P.steel0],[.4,P.steel1],[.6,P.steel2],[1,P.steel3]]),Math.min(3,h/3,w/3));c.restore()}
// Glass over whatever was drawn behind it: two diagonal reflections.
function glass(c,x,y,w,h){c.save();c.fillStyle=lin(c,x,y,x+w,y+h,[[0,'rgba(255,255,255,.35)'],[.25,'rgba(255,255,255,0)'],[.55,'rgba(255,255,255,.12)'],[.62,'rgba(255,255,255,0)']]);c.fillRect(x,y,w,h);c.restore()}
// A soft elliptical glow (the furnace's spill), colour at the centre fading to nothing.
function glow(c,cx,cy,rx,ry,color,alpha){
 if(!(rx>0&&ry>0))return;c.save();c.translate(cx,cy);c.scale(1,ry/rx);const g=c.createRadialGradient(0,0,0,0,0,rx);
 g.addColorStop(0,rgba(color,alpha??.55));g.addColorStop(1,rgba(color,0));c.fillStyle=g;c.beginPath();c.arc(0,0,rx,0,Math.PI*2);c.fill();c.restore();
}
// Light rays: one polygon [[x,y],…] or several, fading from colour at the top to nothing at the bottom.
function rays(c,polys,color,alpha){
 const list=Array.isArray(polys[0]?.[0])?polys:[polys];c.save();
 for(const p of list){if(p.length<3)continue;const ys=p.map(q=>q[1]),y0=Math.min(...ys),y1=Math.max(...ys);
  c.fillStyle=lin(c,0,y0,0,y1===y0?y0+1:y1,[[0,rgba(color||P.ray,alpha??.35)],[1,rgba(color||P.ray,0)]]);poly(c,p);c.fill()}
 c.restore();
}
// A soft contact shadow on the ground: a dark core blurred out with shadowBlur, sized for the current zoom.
function softShadow(c,cx,cy,rx,ry){
 c.save();const m=c.getTransform?c.getTransform():null,k=m?Math.hypot(m.a,m.b)||1:1;
 c.shadowColor='rgba(0,0,0,.35)';c.shadowBlur=Math.max(2,ry*1.6*k);c.fillStyle='rgba(0,0,0,.22)';
 c.beginPath();c.ellipse(cx,cy,rx*.85,ry*.6,0,0,Math.PI*2);c.fill();c.restore();
}

// A worker, feet at (x, y), drawn from the art bar's figure (95 units tall there; o.scale 0.55 by default). pose 0..1
// is the walk cycle: legs and the free arm swing. The prop is held in the raised right hand.
const PROPS={
 clipboard(c){box(c,-6,-14,18,24,P.paper,3);c.fillStyle=P.ink;c.fillRect(-3,-10,12,2);c.fillRect(-3,-5,9,2);c.fillRect(-3,0,11,2);c.fillStyle=P.steel2;c.fillRect(-1,-16,8,3)},
 wrench(c){c.save();c.rotate(-.7);c.fillStyle=lin(c,0,-4,0,4,[[0,P.steel1],[1,P.steel3]]);c.beginPath();rr(c,-2,-2.5,26,5,2.5);c.fill();
  c.beginPath();c.arc(26,0,6,0,Math.PI*2);c.fill();c.fillStyle=P.dark;c.beginPath();c.rect(26,-2.2,8,4.4);c.fill();c.restore()},
 tablet(c){box(c,-8,-16,22,30,P.frame,3);box(c,-5.5,-13.5,17,25,lin(c,0,-13,0,12,[[0,'#7fd3ff'],[1,'#3a7bd5']]),1.5);c.fillStyle='rgba(255,255,255,.35)';c.fillRect(-3,-10,10,2);c.fillRect(-3,-5,7,2)},
 hammer(c){c.save();c.rotate(-.5);box(c,-2,-2,30,4.5,lin(c,0,-2,0,3,[[0,'#b07a46'],[1,'#7a5228']]),2);box(c,24,-9,9,18,lin(c,24,0,33,0,[[0,P.steel1],[1,P.steel3]]),2);c.restore()}
};
function person(c,x,y,o){
 o=o||{};const s=o.scale||.55,sw=Math.sin((o.pose||0)*Math.PI*2),prop=PROPS[o.prop],skin=o.skin||P.skin,hat=o.hat===undefined?P.hat:o.hat;
 softShadow(c,x,y+1,26*s,5*s);c.save();c.translate(x,y);c.scale(s,s);
 c.fillStyle=P.pants;c.beginPath();const l=sw*4;poly(c,[[-12-l,0],[-10,-34],[-2,-34],[-1-l,0]]);c.fill();poly(c,[[2+l,0],[3,-34],[11,-34],[12+l,0]]);c.fill();
 c.fillStyle='#1e2638';c.fillRect(-13-l,-3,12,3);c.fillRect(1+l,-3,12,3);
 c.fillStyle=o.vest||P.vest;c.beginPath();c.moveTo(-16,-32);c.quadraticCurveTo(-16,-72,0,-72);c.lineTo(4,-72);c.quadraticCurveTo(20,-72,20,-32);c.closePath();c.fill();
 c.fillStyle=lin(c,-16,0,20,0,[[0,'rgba(255,255,255,.14)'],[.5,'rgba(255,255,255,0)'],[1,'rgba(0,0,0,.18)']]);c.fill();
 c.fillStyle=rgba(P.stripe,.9);c.fillRect(-14,-60,32,5);
 c.strokeStyle=skin;c.lineWidth=7;c.lineCap='round';c.beginPath();c.moveTo(-12,-56);c.lineTo(-16+sw*5,-36);c.stroke();
 c.beginPath();c.moveTo(18,-54);if(prop)c.lineTo(38,-64);else c.lineTo(22-sw*5,-36);c.stroke();
 c.fillStyle=skin;c.beginPath();c.arc(2,-82,12,0,Math.PI*2);c.fill();c.fillStyle='rgba(0,0,0,.12)';c.beginPath();c.arc(5,-80,10,-.6,1.9);c.fill();
 if(hat){c.fillStyle=hat;c.beginPath();c.moveTo(-12,-84);c.quadraticCurveTo(2,-104,16,-84);c.closePath();c.fill();box(c,-15,-86,34,5,hat,2.5);c.fillStyle='rgba(0,0,0,.14)';c.fillRect(-15,-83,34,2)}
 else{c.fillStyle='#3b2a22';c.beginPath();c.arc(2,-86,11,Math.PI,0);c.fill()}
 if(prop){c.translate(38,-64);prop(c)}
 c.restore();
}
// A crate s units wide: the art bar's warm wood gradient and its cross battens.
function crate(c,x,y,s){
 c.save();const h=s*.93,k=s/30;box(c,x,y,s,h,lin(c,0,y,0,y+h,[[0,P.crate0],[1,P.crate1]]),3*k);
 c.strokeStyle=P.crateLine;c.lineWidth=2*k;c.beginPath();c.moveTo(x,y+h/2);c.lineTo(x+s,y+h/2);c.moveTo(x+s/2,y);c.lineTo(x+s/2,y+h);c.stroke();
 c.fillStyle='rgba(255,255,255,.25)';c.fillRect(x+2*k,y+1.5*k,s-4*k,1.5*k);c.restore();
}
// Smoke rising from (x, y) at time t (seconds): three soft puffs on a 4.2 s cycle that drift, grow and fade.
function smoke(c,x,y,t){
 c.save();const cols=[P.smoke0,P.smoke1,'#e6e9ee'];
 for(let i=0;i<3;i++){const p=(((t||0)/4.2+i/3)%1+1)%1,r=11*(.5+1.6*p),px=x+16*p,py=y-60*p,g=c.createRadialGradient(px,py,0,px,py,r);
  g.addColorStop(0,rgba(cols[i],.75*(1-p)));g.addColorStop(1,rgba(cols[i],0));c.fillStyle=g;c.beginPath();c.arc(px,py,r,0,Math.PI*2);c.fill()}
 c.restore();
}
// Fire in a box (a furnace mouth, a forge): the art bar's furnace gradient, flickering, with flame tongues on top.
function fire(c,x,y,w,h,t){
 t=t||0;const f=.9+.1*Math.sin(t*7.3)*Math.sin(t*3.1);c.save();c.beginPath();c.rect(x,y,w,h);c.clip();
 const g=c.createRadialGradient(x+w/2,y+h*.6,0,x+w/2,y+h*.6,Math.max(w,h)*.65);
 [[0,P.furnace0],[.35,P.furnace1],[.75,P.furnace2],[1,P.furnace3]].forEach(([o,col])=>g.addColorStop(o,col));
 c.globalAlpha=f;c.fillStyle=g;c.fillRect(x,y,w,h);c.fillStyle=lin(c,0,y,0,y+h,[[0,P.molten0],[1,P.molten1]]);c.globalAlpha=.85;
 const n=Math.max(2,Math.round(w/14)),b=y+h;c.beginPath();c.moveTo(x,b);
 for(let i=0;i<n;i++){const cx=x+(i+.5)*w/n,tip=b-h*(.45+.25*Math.sin(t*5+i*1.9)),hw=w/n/2;c.quadraticCurveTo(cx-hw,b-h*.2,cx,tip);c.quadraticCurveTo(cx+hw,b-h*.2,cx+hw,b)}
 c.closePath();c.fill();c.restore();
}
// The sidewalk from the ground line to the curb, with joints on a fixed 60-unit grid so pieces line up, then the curb.
function sidewalk(c,x,w){
 c.save();c.fillStyle=lin(c,0,GROUND,0,CURB,[[0,P.walk0],[1,P.walk1]]);c.fillRect(x,GROUND,w,CURB-GROUND);
 c.strokeStyle=P.joint;c.lineWidth=.8;c.beginPath();for(let jx=Math.ceil(x/60)*60;jx<x+w+6;jx+=60){c.moveTo(jx,GROUND);c.lineTo(jx-6,CURB)}c.stroke();
 c.fillStyle=P.curb;c.fillRect(x,CURB,w,ROAD-CURB);c.fillStyle='rgba(0,0,0,.12)';c.fillRect(x,ROAD-1,w,1);c.restore();
}
// The road below the curb to the bottom of the scene, with lane dashes every 100 units.
function road(c,x,w){
 c.save();c.fillStyle=lin(c,0,ROAD,0,360,[[0,P.road0],[1,P.road1]]);c.fillRect(x,ROAD,w,360-ROAD);
 c.fillStyle=P.lane;c.beginPath();for(let dx=Math.floor(x/100)*100;dx<x+w;dx+=100)rr(c,dx+20,343,38,3,1.5);c.fill();c.restore();
}
// The far city behind the street: blocks whose heights come from their position (so any slice matches its neighbours).
// Layer 0 is the farthest and tallest; layer 1 is nearer, lower and paler, under the haze that fades into the ground.
function skyline(c,x,w,layer){
 const L=layer?1:0,step=L?70:56,col=L?P.far1:P.far0;c.save();c.fillStyle=col;c.beginPath();
 for(let i=Math.floor(x/step)-1;i*step<x+w;i++){const r=Math.abs(Math.sin(i*12.9898+L*78.233)*43758.5453)%1,bw=step*(.62+.3*r),top=L?212+r*40:150+r*70;
  c.rect(i*step+(step-bw)*r,top,bw,GROUND-top)}
 c.fill();if(L){c.fillStyle=lin(c,0,140,0,GROUND,[[0,rgba('#9fbfdf',0)],[1,rgba(P.haze,.85)]]);c.fillRect(x,140,w,GROUND-140)}c.restore();
}
const api={palette:P,brick,brickSide,corrugated,steel,glass,glow,rays,softShadow,person,crate,smoke,fire,sidewalk,road,skyline};
root.LocalAIStreetArt=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
