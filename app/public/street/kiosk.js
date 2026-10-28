// Main Street building: Kiosk Billboard, drawn in the art bar's language (docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html):
// a screen in a steel frame on braced I-beam legs, with two flood lamps on top and a control cabinet at its foot.
// state/chip/stillKey are pure. Online: the screen shows the weather and glows softly (a slow breath and a sheen that
// runs down it), the lamps are lit and the cabinet's light blinks green. Not set up: the screen dark, lamps off, still.
// Down: the screen dark and boarded, no light. drawStill draws what doesn't move; drawLive (t in ms) the glow.
(function(root){'use strict';
const C=typeof module==='object'&&module.exports?require('./common.js'):root.LocalAIStreetCommon;
const cut=C.cut;
function state(world){
 const k=world&&world.kiosk;
 if(!k)return{setUp:false,online:null,firmware:null,down:true};
 const setUp=!!k.setUp;
 return{setUp,online:k.online??null,firmware:k.firmware||null,down:setUp&&k.online!==true};
}
function stillKey(s){return s.down?'down':s.setUp?'lit':'off'}
function chip(s){
 const title='Kiosk Billboard';
 if(s.down)return{title,detail:'Not answering',tone:'down'};
 if(!s.setUp)return{title,detail:'Not set up',tone:'quiet'};
 return{title,detail:cut(s.firmware?'Online · '+s.firmware:'Online'),tone:'quiet'};
}
const K=()=>root.LocalAIStreetArt,TAU=Math.PI*2;
const SX=16,SY=138,SW=108,SH=80;
const on=s=>!s.down&&s.setUp;
function drawStill(c,s){
 const A=K();if(!A)return;const P=A.palette,lit=on(s),dn=s.down;c.save();
 A.softShadow(c,70,302,62,6);
 // The legs: two steel I-beams, their bracing and footings; the cabinet at the foot of the left one.
 c.strokeStyle=P.steel3;c.lineWidth=2.5;c.beginPath();c.moveTo(38,246);c.lineTo(102,292);c.moveTo(102,246);c.lineTo(38,292);c.stroke();
 for(const x of [30,102]){A.steel(c,x,226,9,74);c.fillStyle='rgba(0,0,0,.25)';c.fillRect(x+3.5,228,2,72);A.box(c,x-4,294,17,6,'#9aa1ac',1)}
 A.box(c,6,268,20,32,A.grad(c,6,0,26,0,'#7d8796','#4a5260'),2);c.fillStyle=P.frame;c.fillRect(9,272,14,1.4);c.fillRect(9,290,14,1.4);
 // The catwalk under the board, the board's depth and frame, the screen.
 A.steel(c,4,224,132,6);
 A.poly(c,[[130,128],[138,124],[138,222],[130,224]]);c.fillStyle='#3c434f';c.fill();
 A.box(c,8,128,124,98,A.grad(c,8,128,132,226,'#5a6270','#2d3138'),4);A.box(c,12,132,116,90,P.frame,2);
 if(lit){
  // The weather: a sky, the sun behind a cloud, and three bars for the days ahead.
  c.fillStyle=A.grad(c,0,SY,0,SY+SH,'#3a7bd5','#7fd3ff');c.fillRect(SX,SY,SW,SH);
  A.glow(c,48,166,26,26,'#fff1a8',.7);c.fillStyle='#ffd34a';c.beginPath();c.arc(48,166,12,0,TAU);c.fill();
  c.fillStyle='#ffffff';c.beginPath();for(const [x,y,r] of [[58,180,10],[72,174,12],[86,180,9],[66,184,8],[80,185,8]]){c.moveTo(x+r,y);c.arc(x,y,r,0,TAU)}c.fill();
  for(let i=0;i<3;i++){A.box(c,96+i*9,200-[18,26,14][i],6,[18,26,14][i],['#ffc640','#ff8a2a','#ffc640'][i],1.5)}
  c.fillStyle='rgba(255,255,255,.75)';c.fillRect(SX+8,SY+SH-12,40,3);c.fillRect(SX+8,SY+SH-6,26,2);
 }else{c.fillStyle=A.grad(c,0,SY,0,SY+SH,'#1d2128','#111419');c.fillRect(SX,SY,SW,SH)}
 A.glass(c,SX,SY,SW,SH);
 // The flood lamps on their arms.
 for(const x of [40,100]){c.strokeStyle=P.steel3;c.lineWidth=2.5;c.beginPath();c.moveTo(x,128);c.lineTo(x,112);c.lineTo(x-8,108);c.stroke();
  c.save();c.translate(x-10,108);c.rotate(.5);A.box(c,-7,-4,14,8,P.steel2,2);c.fillStyle=lit?P.lamp:'#5b6170';c.fillRect(-6,3,12,2);c.restore()}
 if(lit)A.rays(c,[[[24,112],[36,112],[52,226],[10,226]],[[84,112],[96,112],[116,226],[72,226]]],P.ray,.16);
 if(dn)A.boards(c,SX-2,SY-2,SW+4,SH+4);
 c.restore();
}
function drawLive(c,s,t){
 const A=K();if(!A||!on(s))return;t=t||0;const b=.5-.5*Math.cos(TAU*t/4000);c.save();
 A.glow(c,70,178,78,60,'#7fd3ff',.1+.1*b);
 c.beginPath();c.rect(SX,SY,SW,SH);c.clip();const y=SY+((t/40)%(SH+30))-15;
 c.fillStyle=A.grad(c,0,y-10,0,y+10,'rgba(255,255,255,0)','rgba(255,255,255,.16)');c.fillRect(SX,y-10,SW,20);c.restore();
 c.fillStyle=Math.floor(t/800)%2?'#5bd37a':'#2a5a3a';c.beginPath();c.arc(20,280,1.8,0,TAU);c.fill();
}
// Online breathes (a slow glow, a sheen, the blinking cabinet light), so it animates; dark or down is still.
const def={id:'kiosk',width:140,state,stillKey,chip,drawStill,drawLive,animates:on};
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
