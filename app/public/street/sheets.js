// Main Street building: Spreadsheets Office, drawn in the art bar's language (docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html):
// a two-storey cream office with a ribbon window ruled into cells like a sheet, a glass entrance under a canopy and a
// rooftop air unit. state/chip/stillKey are pure.
// Busy: the office is lit, cells light one after another like a sheet filling in (the cursor cell brightest), and a
// clerk at the desk types at a bright screen. Excel not open (bridge up, Excel closed; its own still, 'dim'): the clerk
// sits in a lit office at a dim screen, nothing moves. Quiet: dark and empty. Down: windows and door boarded, no light.
// drawStill draws what doesn't move (the clerk included); drawLive (t in ms) draws the cells, the typing arm and the rows.
(function(root){'use strict';
const cut=s=>s.length>60?s.slice(0,59)+'…':s;
const tri=v=>typeof v==='boolean'?v:null;
const dimLit=s=>!s.down&&!s.working&&s.bridge===true&&s.excel===false;
function state(world){
 const w=world&&world.sheets,bridge=w?tri(w.bridge):null,excel=w?tri(w.excel):null;
 const run=((world&&world.street&&world.street.sheets&&world.street.sheets.running)||[]).length;
 return{working:((w&&w.inFlight)||0)>0||run>0,bridge,excel,down:bridge===null};
}
// 'dim': the bridge is up but Excel is shut, so the office is lit and the clerk sits at a dim screen.
function stillKey(s){return s.down?'down':s.working?'lit':dimLit(s)?'dim':'unlit'}
function chip(s){
 const title='Spreadsheets Office';
 if(s.down)return{title,detail:'Not answering',tone:'down'};
 if(s.working)return{title,detail:'Working',tone:'busy'};
 if(s.bridge===true&&s.excel===false)return{title,detail:cut('Excel not open'),tone:'quiet'};
 return{title,detail:'Ready',tone:'quiet'};
}
const K=()=>root.LocalAIStreetArt,TAU=Math.PI*2;
const RX=22,RY=122,RW=160,RH=66,CC=6,CR=3,GX=22,GY=214,GW=98,GH=74,WALL='#e6d6b8';
// The ribbon window's rules and glass, laid by the still and again over the lit cells.
function grid(c){const A=K();c.strokeStyle=A.palette.frame;c.lineWidth=2;c.beginPath();
 for(let i=1;i<CC;i++){c.moveTo(RX+i*RW/CC,RY);c.lineTo(RX+i*RW/CC,RY+RH)}for(let j=1;j<CR;j++){c.moveTo(RX,RY+j*RH/CR);c.lineTo(RX+RW,RY+j*RH/CR)}c.stroke();A.glass(c,RX,RY,RW,RH)}
function drawStill(c,s){
 const A=K();if(!A)return;const P=A.palette,on=s.working,dim=dimLit(s),room=on||dim,dn=s.down;c.save();
 A.softShadow(c,104,302,98,8);
 // Roof: the top seen from just above, the air unit with its fan and a low rail.
 A.poly(c,[[6,106],[198,106],[214,97],[22,97]]);c.fillStyle=A.grad(c,0,97,0,106,'#6d6a72','#4d4a55');c.fill();
 A.box(c,30,82,40,20,A.grad(c,30,0,70,0,'#c8ced8','#7d8796'),2);c.fillStyle=P.steel3;c.beginPath();c.arc(50,92,7,0,TAU);c.fill();
 c.strokeStyle=P.steel1;c.lineWidth=1;c.beginPath();c.moveTo(43,92);c.lineTo(57,92);c.moveTo(50,85);c.lineTo(50,99);c.stroke();
 c.strokeStyle=P.steel2;c.lineWidth=1.4;c.beginPath();c.moveTo(130,98);c.lineTo(130,86);c.lineTo(190,86);c.lineTo(190,98);for(const x of [150,170]){c.moveTo(x,86);c.lineTo(x,98)}c.stroke();
 // The side wall in shade, the cream front with its light, rusticated ground floor, stone band and steel cornice.
 A.poly(c,[[194,106],[214,97],[214,294],[194,300]]);c.fillStyle=A.grad(c,194,0,214,0,'#b5a283','#8c7a5e');c.fill();
 c.fillStyle=WALL;c.fillRect(10,106,184,194);c.fillStyle=A.grad(c,10,106,194,300,'rgba(255,255,255,.18)','rgba(0,0,0,.16)');c.fillRect(10,106,184,194);
 c.fillStyle='rgba(120,96,60,.28)';for(let y=212;y<300;y+=11)c.fillRect(10,y,184,1.2);
 for(const x of [10,187])c.fillStyle=A.grad(c,x,0,x+7,0,'#efe2c8','#c3ae88'),c.fillRect(x,106,7,194);
 A.steel(c,6,101,192,7);A.box(c,10,196,184,6,'#c9b997');A.box(c,10,293,184,7,'#a8977a');
 // The ribbon window: frame, the room's dark cells (the header row and column pale green when busy), its sill.
 A.box(c,RX-4,RY-4,RW+8,RH+8,P.frame,2);c.fillStyle=dn?'#1d1a1e':A.grad(c,0,RY,0,RY+RH,'#2c3542','#1e242c');c.fillRect(RX,RY,RW,RH);
 if(on){c.fillStyle='#cfe8d4';c.fillRect(RX,RY,RW,RH/CR);c.fillRect(RX,RY,RW/CC,RH)}
 grid(c);A.steel(c,RX-6,RY+RH+3,RW+12,4);
 // The ground floor window: the office, a chair, a desk and the monitor's stand.
 A.box(c,GX-4,GY-4,GW+8,GH+8,P.frame,2);
 c.save();c.beginPath();c.rect(GX,GY,GW,GH);c.clip();c.fillStyle=A.grad(c,0,GY,0,GY+GH,room?'#f2e2c2':'#2c2a30',room?'#c9a678':'#18171b');if(dn)c.fillStyle='#1b171c';c.fillRect(GX,GY,GW,GH);
 if(room)A.glow(c,70,250,60,40,P.spill,on?.35:.25);
 c.fillStyle=room?'#8fa7b8':'#34383f';c.fillRect(GX+60,GY+10,30,18);c.fillStyle=room?'#6f8a5a':'#2c302a';c.beginPath();c.ellipse(GX+12,GY+GH-20,6,9,0,0,TAU);c.fill();
 c.fillStyle=P.dark;c.fillRect(38,250,6,30);A.box(c,82,266,6,10,P.steel2);
 // In a lit office the clerk sits behind the desk at the monitor: bright while working, dim when Excel is shut.
 if(room){A.person(c,54,300,{vest:'#3a7bd5',hat:null,skin:'#e9b88f',scale:.55});c.fillStyle=P.frame;c.fillRect(34,276,80,4);c.fillStyle='#6f4a2a';c.fillRect(36,280,76,12);
  A.box(c,70,244,32,24,P.frame,2);c.fillStyle=on?'#d8f2dc':'#2c4a3a';c.fillRect(72,246,28,20);if(dim)arm(c,0)}
 c.restore();A.glass(c,GX,GY,GW,GH);A.steel(c,GX-6,GY+GH+3,GW+12,5);
 // The entrance: a canopy with a downlight over glass doors, and a lamp beside them.
 A.box(c,132,220,46,80,P.frame,2);c.fillStyle=room?A.grad(c,0,224,0,300,'#ffe6b0','#d8a466'):dn?'#1b171c':'#2a2c33';c.fillRect(136,224,38,76);
 c.fillStyle=P.frame;c.fillRect(154,224,2,76);A.glass(c,136,224,38,76);A.box(c,149,256,3,10,P.steel1,1);A.box(c,159,256,3,10,P.steel1,1);
 A.steel(c,126,212,58,6);if(room)A.glow(c,155,300,26,4,P.spill,.3);
 A.lamp(c,126,232,!dn);
 if(dn){A.boards(c,RX,RY,RW,RH);A.boards(c,GX,GY,GW,GH);A.boards(c,136,224,38,76)}
 c.restore();
}
// The clerk's forearm on the keyboard, dy up or down a little as they type.
function arm(c,dy){c.strokeStyle='#e9b88f';c.lineWidth=3.5;c.lineCap='round';c.beginPath();c.moveTo(64,270);c.lineTo(74,275+dy);c.stroke()}
// Working only: the sheet's cells, the typing forearm and the rows on the screen. Everything else is in the still.
function drawLive(c,s,t){
 const A=K();if(!A||s.down||!s.working)return;t=t||0;c.save();
 // The sheet fills: cells after the header light one by one in reading order, the cursor cell brightest, then clear.
 const tick=Math.floor(t/350),n=(CC-1)*(CR-1),k=tick%(n+4),cw=RW/CC,ch=RH/CR;
 for(let i=0;i<Math.min(k,n);i++){const x=RX+cw*(1+i%(CC-1)),y=RY+ch*(1+Math.floor(i/(CC-1)));c.fillStyle=i===k-1?'#fff7d6':'#ffd98a';c.fillRect(x,y,cw,ch)}
 grid(c);arm(c,1.2*Math.sin(t/90));
 c.fillStyle='#4f8a55';for(let r=0;r<4;r++)c.fillRect(74,249+r*4.4,6+((r*7+tick)%5)*4,2);A.glow(c,86,256,22,16,'#bff0c8',.35);
 c.restore();
}
const def={id:'sheets',width:220,state,stillKey,chip,drawStill,drawLive};
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
