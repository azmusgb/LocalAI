// Main Street building: Workshop Garage, drawn in the art bar's language (docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html):
// a wide garage of teal-painted corrugated steel under a stepped false front with a printer sign, a big roll-up door, a
// small window over an oil drum and a beacon on the parapet. state/chip/stillKey are pure.
// Printing: the door is rolled up, the work light is on, the print head runs along its gantry over a part that grows with
// progress, the bar on the door's housing fills to state.progress, and a mechanic stands in the opening. Paused: door up,
// printer visible, head parked, the bar still, no work light. Error: door shut, the red beacon flashes. Idle: shut and
// dark. Not set up: shut, padlocked, lamp off. Down: door and window boarded, no light.
// drawStill draws what doesn't move (it never shows progress); drawLive (t in ms) draws the rest.
(function(root){'use strict';
const cut=s=>s.length>60?s.slice(0,59)+'…':s;
function state(world){
 const p=world&&world.printer;
 if(!p)return{setUp:false,state:null,progress:null,minutesLeft:null,error:false,down:true};
 const setUp=!!p.setUp;
 return{setUp,state:p.state||null,progress:p.progress??null,minutesLeft:p.minutesLeft??null,error:p.state==='error',down:setUp&&p.access!=='ok'};
}
// The still shows the door (up while printing), lit or unlit, and down. Never the progress.
function stillKey(s){return s.down?'down':s.state==='printing'||s.state==='paused'?'up':s.setUp?'unlit':'off'}
function chip(s){
 const title='Workshop Garage';
 if(s.down)return{title,detail:'Not answering',tone:'down'};
 if(!s.setUp)return{title,detail:'Not set up',tone:'quiet'};
 if(s.error)return{title,detail:'Error',tone:'attention'};
 if(s.state==='printing'){
  const d=['Printing'];if(s.progress!=null)d.push(s.progress+'%');if(s.minutesLeft!=null)d.push(s.minutesLeft+' min left');
  return{title,detail:cut(d.join(' · ')),tone:'busy'};
 }
 if(s.state==='paused')return{title,detail:'Paused'+(s.progress!=null?' · '+s.progress+'%':''),tone:'quiet'};
 return{title,detail:'Idle',tone:'quiet'};
}
const K=()=>root.LocalAIStreetArt,TAU=Math.PI*2;
const DX=30,DY=192,DW=140,DH=108,BED=254,BX=40,BW=120;
const up=s=>!s.down&&(s.state==='printing'||s.state==='paused');
const pct=s=>Math.max(0,Math.min(100,+s.progress||0))/100;
function drawStill(c,s){
 const A=K();if(!A)return;const P=A.palette,o=up(s),dn=s.down;c.save();
 A.softShadow(c,124,302,118,8);
 // The side wall turning away and the front, both corrugated steel painted teal; the stepped false front with coping.
 c.save();A.poly(c,[[230,154],[252,145],[252,294],[230,300]]);c.clip();A.tex(c,A.corrugated,230,140,22,160);c.fillStyle='rgba(20,60,64,.6)';c.fillRect(230,140,22,160);c.restore();
 const top=[[10,154],[10,150],[70,150],[70,140],[96,140],[96,128],[154,128],[154,140],[180,140],[180,150],[230,150],[230,154]];
 c.save();A.poly(c,[...top,[230,300],[10,300]]);c.clip();A.tex(c,A.corrugated,10,128,220,172);c.fillStyle='rgba(44,128,124,.42)';c.fillRect(10,128,220,172);c.restore();
 c.strokeStyle=P.steel2;c.lineWidth=3;c.lineJoin='round';c.beginPath();top.slice(1,-1).forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.stroke();
 A.box(c,8,292,224,8,'#6e7480');
 // The sign: a cream board with a red rim and a printer drawn on it.
 A.box(c,102,132,46,20,'#b8432f',2);A.box(c,104,134,42,16,dn?'#a8a294':'#f4ead6',1.5);c.fillStyle=dn?'#6e6a62':'#3c434f';
 c.fillRect(113,137,2,11);c.fillRect(135,137,2,11);c.fillRect(113,137,24,2);c.fillRect(111,147,28,2);c.fillRect(122,139,6,3);c.fillStyle=dn?'#8a7a66':'#ff8a2a';c.fillRect(121,143,8,4);
 // The beacon's dome on the parapet (it lights only on an error).
 A.box(c,193,143,14,4,P.steel3,1);c.fillStyle=dn?'#5a3a3a':'#8a2a2a';c.beginPath();c.arc(200,143,6,Math.PI,0);c.fill();
 // The door: its housing, the progress track when it is up, then the room behind or the shut slats.
 A.box(c,DX-6,DY-14,DW+12,14,A.grad(c,0,DY-14,0,DY,P.steel1,P.steel3),3);
 A.box(c,DX-4,DY,4,DH,P.steel3);A.box(c,DX+DW,DY,4,DH,P.steel3);
 if(o){
  A.box(c,DX+10,DY-9,DW-20,5,'#1e2228',2.5);
  c.fillStyle=A.grad(c,0,DY,0,DY+DH,'#4a4c55','#2b2c31');c.fillRect(DX,DY,DW,DH);c.fillStyle='#262629';c.fillRect(DX,DY+DH-14,DW,14);
  A.box(c,DX+8,DY+10,40,26,'#7a5f40',1);c.strokeStyle='#c9ced6';c.lineWidth=1.4;c.beginPath();for(let i=0;i<4;i++){c.moveTo(DX+13+i*9,DY+14);c.lineTo(DX+13+i*9,DY+30)}c.stroke();
  A.steel(c,BX,BED+8,BW,5);c.fillStyle=P.steel3;c.fillRect(BX+4,BED+13,4,33);c.fillRect(BX+BW-8,BED+13,4,33);
  c.fillStyle=P.frame;c.fillRect(74,206,4,48);c.fillRect(122,206,4,48);A.steel(c,70,202,60,5);A.box(c,72,BED,56,8,'#3a3f48',1);A.steel(c,76,BED-2,48,3);
  A.crate(c,DX+DW-28,BED-12,20);A.box(c,DX,DY,DW,4,P.steel2,1);
 }else{
  c.fillStyle=dn?A.grad(c,0,DY,0,DY+DH,'#7d828c','#5b606a'):A.grad(c,DX,0,DX+DW,0,'#b9c2cf','#8a95a5');c.fillRect(DX,DY,DW,DH);
  c.fillStyle='rgba(40,48,60,.35)';for(let y=DY+7;y<DY+DH;y+=7)c.fillRect(DX,y,DW,1.3);c.fillStyle='rgba(255,255,255,.3)';for(let y=DY+8.3;y<DY+DH;y+=7)c.fillRect(DX,y,DW,.8);
  A.box(c,DX+DW/2-10,DY+DH-10,20,4,P.steel3,2);
  if(!s.setUp&&!dn){c.strokeStyle=P.steel2;c.lineWidth=2;c.beginPath();c.arc(DX+DW/2,DY+DH-14,4,Math.PI,0);c.stroke();A.box(c,DX+DW/2-5,DY+DH-14,10,8,'#c9a227',1.5)}
 }
 // The window over the oil drum, and the lamp over the door's corner.
 A.box(c,184,200,38,34,P.frame,2);c.fillStyle=o&&!dn?'#5a4f45':'#23262c';c.fillRect(187,203,32,28);c.fillStyle=P.frame;c.fillRect(202,203,2,28);c.fillRect(187,216,32,2);A.glass(c,187,203,32,28);
 A.box(c,192,268,22,32,A.grad(c,192,0,214,0,'#c2493c','#7e2a22'),3);c.fillStyle='rgba(0,0,0,.25)';c.fillRect(192,276,22,1.5);c.fillRect(192,290,22,1.5);
 A.lamp(c,184,192,!dn&&s.setUp);
 if(dn){A.boards(c,DX,DY,DW,DH);A.boards(c,187,203,32,28)}
 c.restore();
}
function drawLive(c,s,t){
 const A=K();if(!A||s.down||!(up(s)||s.error))return;t=t||0;const P=A.palette;c.save();
 if(s.error&&!up(s)){const b=.5+.5*Math.sin(t/160);c.fillStyle='#ff3b30';c.globalAlpha=.55+.45*b;c.beginPath();c.arc(200,143,6,Math.PI,0);c.fill();c.globalAlpha=1;
  A.glow(c,200,140,34,16,'#ff3b30',.7*b);A.glow(c,200,140,9,7,'#ffd0c8',.7*b)}
 if(up(s)){
  const run=s.state==='printing',f=pct(s),h=4+30*f,hx=run?84+32*(.5-.5*Math.cos(t/380)):80;
  if(run){A.glow(c,100,226,90,50,P.spill,.32);A.glow(c,100,DY+4,40,8,P.lamp,.6)}
  // The part grows with progress, the gantry rides on top of it, the head runs along the gantry.
  c.fillStyle='#ff8a2a';c.fillRect(88,BED-2-h,24,h);c.fillStyle='rgba(120,40,0,.3)';for(let y=BED-4;y>BED-2-h;y-=3)c.fillRect(88,y,24,1);
  const gy=BED-6-h;A.steel(c,76,gy-3,48,4);A.box(c,hx,gy-6,10,9,P.dark,1.5);A.box(c,hx+3,gy+3,4,3,'#c9ced6',.5);
  if(run)A.glow(c,hx+5,gy+5,6,4,P.molten1,.6+.3*Math.sin(t/60));
  // The bar on the door's housing: filled to the progress; while printing a highlight runs along it.
  c.fillStyle=run?'#5bd37a':'#e3a51b';c.fillRect(DX+11,DY-8,(DW-22)*f,3);
  if(run&&f>0){const sx=DX+11+((t/12)%((DW-22)*f+1));c.fillStyle='rgba(255,255,255,.55)';c.fillRect(Math.min(sx,DX+11+(DW-22)*f-3),DY-8,3,3)}
  if(run){A.person(c,54,300,{prop:'wrench',scale:.55,vest:P.vest,pose:.04*Math.sin(t/700)});A.glow(c,100,302,70,6,P.spill,.25)}
 }
 c.restore();
}
const def={id:'workshop',width:260,state,stillKey,chip,drawStill,drawLive};
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
