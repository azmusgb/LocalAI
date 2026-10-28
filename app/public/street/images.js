// Main Street building: Image Studio, drawn in the art bar's language (docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html):
// a tall slate-brick studio under a saw-tooth skylight roof, a tall arched window with an easel in it, a plum door under
// a round window. state/chip/stillKey are pure.
// Busy: the room and the skylights glow, the canvas fills with colour bands on a 6 s cycle while the painter's arm
// strokes it, and light falls from the skylights. Quiet: dark, the canvas under a dust sheet, no painter. Down: window
// and door boarded, no light. drawStill draws what doesn't move; drawLive (t in ms) draws the painting, painter and light.
(function(root){'use strict';
const cut=s=>s.length>60?s.slice(0,59)+'…':s;
const n=v=>Number.isFinite(v)&&v>0?Math.floor(v):0;
function state(world){
 const src=world&&world.street;if(!src)return{running:0,more:0,needsYou:0,failed:0,down:true};
 const s=src.images||{};
 return{running:Math.min(3,(s.running||[]).length),more:n(s.waiting),needsYou:(s.needsYou||[]).length,failed:(s.failedUnseen||[]).length,down:false};
}
const lit=s=>s.running+s.more>0||s.needsYou>0;
function stillKey(s){return(s.down?'down':lit(s)?'lit':'unlit')}
function chip(s){
 const title='Image Studio';
 if(s.down)return{title,detail:'Not answering',tone:'down'};
 if(!lit(s))return{title,detail:'Quiet',tone:'quiet'};
 const total=s.running+s.more;
 let d=total>0?total+' running':'';
 if(s.needsYou>0)d+=(d?' · ':'')+s.needsYou+' need you';
 return{title,detail:cut(d),tone:s.needsYou>0?'attention':'busy'};
}
const TAU=Math.PI*2,K=()=>root.LocalAIStreetArt;
const WX=30,WY=140,WW=100,WH=150,CX=64,CY=206,CW=44,CH=42;
const BANDS=['#7fc4f0','#f6d27a','#e98a5a','#6aaa6e','#3f7a4c'];
let PS;
// The arched window's opening, as a cached path.
function paths(){return PS||(PS={win:new Path2D('M30 290V190A50 50 0 0 1 130 190V290Z')})}
function clipWin(c){c.save();c.clip(paths().win)}
// The arch's bars and the glass: the still lays them, and a busy frame lays them again over the painter.
function panes(c){const A=K(),P=A.palette;clipWin(c);c.strokeStyle=P.frame;c.lineWidth=2.5;c.beginPath();c.moveTo(80,140);c.lineTo(80,290);
 c.moveTo(30,190);c.lineTo(130,190);c.moveTo(80,190);c.lineTo(45,155);c.moveTo(80,190);c.lineTo(115,155);c.moveTo(30,240);c.lineTo(130,240);c.stroke();
 A.glass(c,WX,WY,WW,WH);c.restore()}
function drawStill(c,s){
 const A=K();if(!A)return;const P=A.palette,on=lit(s),dn=s.down;c.save();
 A.softShadow(c,112,302,104,8);
 // The saw-tooth roof: three glazed teeth, lit from inside when busy; the side of the last tooth and the side wall.
 A.poly(c,[[196,60],[222,50],[222,86],[196,98]]);c.fillStyle=A.grad(c,196,0,222,0,P.roof,'#3c4250');c.fill();
 A.tex(c,A.brickSide,196,98,26,202,{skew:12,tone:'slate'});
 for(let i=0;i<3;i++){const x0=12+i*61.3,x1=x0+61.3;A.poly(c,[[x0,98],[x1,98],[x1,60]]);
  c.fillStyle=on?A.grad(c,x0,98,x1,60,'#ffe2a8','#f2a65a'):dn?'#2c3038':A.grad(c,x0,98,x1,60,'#5d7896','#a9c6e2');c.fill();
  c.save();c.clip();c.strokeStyle='rgba(45,49,56,.7)';c.lineWidth=1.4;c.beginPath();for(let k=1;k<4;k++){c.moveTo(x0+k*15.3,98);c.lineTo(x0+k*15.3,60)}c.stroke();if(!dn)A.glass(c,x0,60,61,38);c.restore();
  c.strokeStyle=P.steel2;c.lineWidth=2.4;c.beginPath();c.moveTo(x0,98);c.lineTo(x1,60);c.lineTo(x1,98);c.stroke();
  if(on)A.glow(c,x1-18,84,30,12,P.spill,.35)}
 // The slate front, a stone band and plinth, the steel cornice.
 A.tex(c,A.brick,12,98,184,202,{tone:'slate'});A.steel(c,8,96,192,6);
 A.box(c,12,124,184,5,'#c9bfae');A.box(c,12,292,184,8,'#9e9585');
 // The room behind the arched window: walls, floor, two finished paintings, the easel and its canvas.
 c.fillStyle=P.frame;c.beginPath();c.arc(80,190,54,Math.PI,0);c.lineTo(134,292);c.lineTo(26,292);c.closePath();c.fill();
 clipWin(c);c.fillStyle=A.grad(c,0,WY,0,WY+WH,on?'#f3e6cf':'#3a3740',on?'#cdb894':'#1d1b21');if(dn)c.fillStyle='#1b171c';c.fillRect(WX,WY,WW,WH);
 c.fillStyle=on?'#a98e6a':'#2a272c';c.fillRect(WX,268,WW,22);
 if(on)A.glow(c,80,230,70,60,'#fff1d6',.45);
 for(const [x,y,w,h,a,b] of [[108,166,18,14,'#e98a5a','#7fc4f0'],[38,170,14,18,'#6aaa6e','#f6d27a']]){A.box(c,x-1.5,y-1.5,w+3,h+3,'#7a5228');
  c.fillStyle=on?A.grad(c,x,y,x,y+h,b,a):'#4a4650';c.fillRect(x,y,w,h)}
 c.strokeStyle='#8a5e34';c.lineWidth=3;c.lineCap='round';c.beginPath();c.moveTo(72,290);c.lineTo(86,196);c.moveTo(100,290);c.lineTo(86,196);c.moveTo(86,200);c.lineTo(88,290);c.stroke();
 A.box(c,CX-3,CY+CH,CW+6,3,'#6f4a2a');A.box(c,CX,CY,CW,CH,on?'#fbf8f2':dn?'#2a282e':'#5e5a54',1);
 if(!on){c.fillStyle=dn?'#3c3a3e':'#8d8678';c.beginPath();c.moveTo(CX-3,CY+CH+2);c.lineTo(CX-3,CY-1);c.quadraticCurveTo(CX+4,CY-8,CX+22,CY-6);c.quadraticCurveTo(CX+42,CY-8,CX+CW+3,CY-1);c.lineTo(CX+CW+3,CY+CH+2);
  for(let i=4;i>=0;i--)c.lineTo(CX+i*CW/4,CY+CH+(i%2?5:1));c.fill()}
 c.restore();panes(c);A.steel(c,24,290,112,5);
 // The plum door under a round window, and the lamp between them and the arch.
 c.fillStyle=P.frame;c.beginPath();c.arc(164,176,13,0,TAU);c.fill();c.fillStyle=on?A.grad(c,0,164,0,188,'#fff1d6','#e9b07a'):dn?'#1b171c':'#2f3038';c.beginPath();c.arc(164,176,10,0,TAU);c.fill();
 c.strokeStyle=P.frame;c.lineWidth=1.6;c.beginPath();c.moveTo(154,176);c.lineTo(174,176);c.moveTo(164,166);c.lineTo(164,186);c.stroke();
 A.box(c,145,206,38,88,P.frame,2);A.box(c,149,211,30,83,'#6b3a5a',1);
 c.fillStyle='rgba(0,0,0,.18)';for(const y of [216,252])c.fillRect(153,y,22,30);A.box(c,173,250,3,9,P.steel1,1);
 if(on)A.glow(c,164,176,18,18,P.lamp,.4);
 A.lamp(c,138,214,!dn);
 if(dn){A.boards(c,WX,WY+10,WW,WH-10);A.boards(c,149,211,30,83)}
 c.restore();
}
function drawLive(c,s,t){
 const A=K();if(!A||s.down||!lit(s))return;t=t||0;const P=A.palette;c.save();clipWin(c);
 // The canvas fills band by band over 6 s, holds a moment, and starts again.
 const p=(t%6000)/6000*1.2,h=CH/BANDS.length;
 BANDS.forEach((col,i)=>{const f=Math.max(0,Math.min(1,p*BANDS.length-i));if(f>0){c.fillStyle=col;c.fillRect(CX,CY+i*h,CW*f,h+.3)}});
 if(p>.4){c.fillStyle='#fff3c4';c.globalAlpha=Math.min(1,(p-.4)*4);c.beginPath();c.arc(CX+31,CY+h*1.4,4.5,0,TAU);c.fill();c.globalAlpha=1}
 const k=Math.min(BANDS.length-1,Math.floor(p*BANDS.length)),sw=Math.sin(t/260);
 A.person(c,50,300,{vest:'#3aa0a8',hat:null,skin:'#c68a5e',scale:.6,prop:'brush',tip:BANDS[k],reach:[-10+6*sw,-50+10*Math.cos(t/520)]});
 A.rays(c,[[[100,140],[124,140],[96,290],[60,290]],[[60,140],[76,140],[50,290],[30,290]]],P.ray,.16*(1-.4*(.5-.5*Math.cos(TAU*t/3000))));
 c.restore();panes(c);c.restore();
}
const def={id:'images',width:240,state,stillKey,chip,drawStill,drawLive};
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
