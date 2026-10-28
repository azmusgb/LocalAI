// Main Street building: Chat Café, drawn in the art bar's language (docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html):
// a low sand-brick café with a cup on its parapet, a striped awning and a big green-framed window. state/chip/stillKey are pure.
// Busy: the room is warm and lit, a figure per running chat (up to 3) stands at the counter with a speech bubble whose
// dots type, an amber "!" bubble when a chat needs you, and a round "+" badge on the door when more are waiting (the
// number is on the chip). Quiet: the room is dark and empty. Down: window and door boarded, the awning faded, no light.
// drawStill draws what doesn't move; drawLive (t in ms) draws the people, bubbles and badge, then the glass over them.
(function(root){'use strict';
const C=typeof module==='object'&&module.exports?require('./common.js'):root.LocalAIStreetCommon;
const B=C.runsBuilding({id:'chat',key:'chat',title:'Chat Café',width:240});
const lit=s=>s.running+s.more>0||s.needsYou>0;
const TAU=Math.PI*2,K=()=>root.LocalAIStreetArt;
const TRIM='#2f5a48',WX=20,WY=206,WW=120,WH=84;
let PS;
// The awning's scalloped outline and the parapet's rounded top, as cached paths.
function paths(){if(PS)return PS;let d='M14 180H208L214 198';for(let x=214;x>8;x-=11.5)d+='a5.75 6 0 0 1 -11.5 0';
 return PS={awn:new Path2D(d+'Z'),par:new Path2D('M74 152V134Q74 122 111 117Q148 122 148 134V152Z')}}
function clipWin(c){c.beginPath();c.rect(WX,WY,WW,WH);c.clip()}
// The mullion, transom and sheen: the still lays them, and a busy frame lays them again over the people.
function panes(c){const A=K();c.fillStyle=TRIM;c.fillRect(WX,WY+10,WW,2.5);c.fillRect(WX+WW/2-1.2,WY,2.4,WH);A.glass(c,WX,WY,WW,WH)}
function drawStill(c,s){
 const A=K();if(!A)return;const P=A.palette,on=lit(s),ps=paths(),dn=s.down;c.save();
 A.softShadow(c,118,302,112,8);
 // Flat roof seen from just above, the side wall turning away, the sand front and its parapet with the café's cup.
 A.poly(c,[[4,150],[218,150],[234,141],[22,141]]);c.fillStyle=A.grad(c,0,141,0,150,'#6d6a72','#4d4a55');c.fill();
 A.tex(c,A.brickSide,214,152,20,148,{skew:9,tone:'sand'});
 c.save();c.clip(ps.par);A.tex(c,A.brick,74,116,74,38,{tone:'sand'});c.restore();
 c.strokeStyle=P.steel2;c.lineWidth=3;c.beginPath();c.moveTo(74,134);c.quadraticCurveTo(74,122,111,117);c.quadraticCurveTo(148,122,148,134);c.stroke();
 A.tex(c,A.brick,8,152,206,148,{tone:'sand'});A.steel(c,4,147,216,7);
 c.fillStyle=dn?'#c9c2b4':'#f6efe2';c.beginPath();c.arc(111,137,10,0,TAU);c.fill();
 c.fillStyle=dn?'#6b625a':'#6d4128';A.poly(c,[[104,133],[118,133],[116,143],[106,143]]);c.fill();
 c.strokeStyle=c.fillStyle;c.lineWidth=1.6;c.beginPath();c.arc(118.5,137,2.6,-1.3,1.3);c.stroke();
 if(!dn){c.strokeStyle='rgba(109,65,40,.6)';c.lineWidth=1.1;c.beginPath();c.moveTo(109,131);c.quadraticCurveTo(107,128,109,125);c.moveTo(113,131);c.quadraticCurveTo(111,128,113,125);c.stroke()}
 // The window: frame, the room behind it, shelves of cups, the coffee machine on the back counter, pendant lamps.
 A.box(c,WX-4,WY-4,WW+8,WH+8,TRIM,2);
 c.save();clipWin(c);c.fillStyle=A.grad(c,0,WY,0,WY+WH,on?'#6a3d26':'#2c2422',on?'#3a1f14':'#171213');c.fillRect(WX,WY,WW,WH);
 if(on)A.glow(c,80,262,70,34,P.spill,.42);
 c.fillStyle=on?'#8a5a3a':'#3a2e2a';for(const y of [230,242])c.fillRect(WX+4,y,WW-8,2);
 c.fillStyle=on?'#efe4d2':'#5d5652';c.beginPath();for(let i=0;i<9;i++){c.rect(WX+8+i*12,225,5,5);c.rect(WX+12+i*12,237,4,5)}c.fill();
 c.fillStyle=A.grad(c,0,256,0,290,on?'#9a6a44':'#3e302a',on?'#5d3b24':'#231a17');c.fillRect(WX,256,WW,34);
 c.fillStyle=on?'#c08a5a':'#4a3a32';c.fillRect(WX,255,WW,3);A.steel(c,104,238,20,17);c.fillStyle=P.frame;c.fillRect(108,249,12,3);
 for(const x of [44,80,116]){c.fillStyle=P.frame;c.fillRect(x-.5,WY,1,14);c.fillStyle=on?P.lamp:'#4c4f57';A.poly(c,[[x-5,WY+18],[x+5,WY+18],[x+2,WY+13],[x-2,WY+13]]);c.fill();
  if(on)A.glow(c,x,WY+21,14,9,P.lamp,.5)}
 if(on)A.rays(c,[[[38,WY+18],[50,WY+18],[64,WY+WH],[24,WY+WH]],[[110,WY+18],[122,WY+18],[136,WY+WH],[96,WY+WH]]],P.ray,.12);
 c.restore();panes(c);A.steel(c,WX-6,WY+WH+3,WW+12,5);
 // A flower box under the window.
 A.box(c,WX,WY+WH+8,WW,6,'#7a5228',1.5);
 for(let i=0;i<14;i++){const x=WX+5+i*8.4;c.fillStyle=dn?'#7c6a4a':i%2?P.bush1:P.bush0;c.beginPath();c.ellipse(x,WY+WH+8,5.5,3.6,0,0,TAU);c.fill();
  if(!dn){c.fillStyle=i%3?'#f2a0b4':'#ffe08a';c.beginPath();c.arc(x+1,WY+WH+6.5,1.3,0,TAU);c.fill()}}
 // The door: green frame, warm glass when lit, the wall lamp beside it.
 A.box(c,152,204,46,96,TRIM,2);A.box(c,157,210,36,90,'#3c6b57',1);
 c.fillStyle=on?A.grad(c,0,214,0,256,'#ffcf8a','#c77a3e'):dn?'#1b1416':'#2a2422';c.fillRect(161,214,28,42);A.glass(c,161,214,28,42);
 c.fillStyle='rgba(0,0,0,.18)';c.fillRect(161,268,28,1.4);A.box(c,184,262,3,9,P.steel1,1);
 if(on){A.glow(c,175,300,20,4,P.spill,.3)}
 A.lamp(c,206,220,!dn);
 // A green fascia board with a gilt edge above the awning.
 A.box(c,28,158,166,15,TRIM,2);c.strokeStyle=dn?'#8a8170':'#d9b45a';c.lineWidth=1;c.strokeRect(31,160.5,160,10);
 // The awning: red and cream stripes, shaded under its fold, a soft shadow on the wall below it.
 c.fillStyle='rgba(40,20,10,.28)';c.fillRect(10,199,206,9);
 c.save();c.clip(ps.awn);for(let i=0;i<18;i++){c.fillStyle=i%2?(dn?'#cfc6b6':'#f4e9d6'):(dn?'#8f7c76':'#c9473e');c.fillRect(8+i*11.5,176,11.5,32)}
 c.fillStyle=A.grad(c,0,180,0,206,'rgba(255,255,255,.22)','rgba(0,0,0,.25)');c.fillRect(8,176,206,32);c.restore();
 A.steel(c,12,177,198,4);
 if(dn){A.boards(c,WX,WY,WW,WH);A.boards(c,157,210,36,90)}
 if(B.stillKey(s)==='ask')people(c,s,0);
 c.restore();
}
// A speech bubble over (x, y): white with three typing dots, or amber with an "!" when a chat needs you.
function bubble(c,x,y,t,i,ask){
 const A=K(),k=ask?1+.08*Math.sin(t/180):1;c.save();c.translate(x,y);c.scale(k,k);
 c.shadowColor='rgba(0,0,0,.3)';c.shadowBlur=2;A.box(c,-11,-8,22,13,ask?'#ffc640':'#ffffff',6);
 A.poly(c,[[-6,4],[-1,4],[-8,10]]);c.fill();c.shadowColor='transparent';c.fillStyle=ask?'#7a3a10':'#5a6474';
 if(ask){c.fillRect(-1.3,-5.5,2.6,5.5);c.beginPath();c.arc(0,2.2,1.4,0,TAU);c.fill()}
 else for(let d=0;d<3;d++){const p=((t/1200-d*.18-i*.3)%1+1)%1,u=p<.4?Math.sin(p/.4*Math.PI):0;c.globalAlpha=.45+.55*u;c.beginPath();c.arc(-5+d*5,-1.5-u*1.6,1.6,0,TAU);c.fill()}
 c.restore();
}
const FOLK=[['#3aa0a8','#e9b88f'],['#8e5bb5','#8d5a3b'],['#e3a51b','#c68a5e']];
function drawLive(c,s,t){
 if(!B.animates(s))return;const A=K();if(!A)return;people(c,s,t||0);
 if(s.more>0){c.save();c.translate(190,214);const k=1+.06*Math.sin(t/400);c.scale(k,k);c.shadowColor='rgba(0,0,0,.35)';c.shadowBlur=2;
  A.box(c,-7,-7,14,14,'#ffc640',7);c.shadowColor='transparent';c.fillStyle='#7a3a10';c.fillRect(-4,-1.1,8,2.2);c.fillRect(-1.1,-4,2.2,8);c.restore()}
}
// The people and their bubbles in the window: live while chats run, and in the still (t = 0) when a chat only needs you.
function people(c,s,t){
 const A=K(),n=Math.min(3,Math.max(s.running,s.needsYou>0?1:0));c.save();
 c.save();clipWin(c);
 for(let i=0;i<n;i++){const x=40+i*34,[v,sk]=FOLK[i];A.person(c,x,300,{vest:v,skin:sk,hat:null,scale:.5,pose:.03*Math.sin(t/900+i*2)})}
 for(let i=0;i<n;i++)bubble(c,54+i*34,WY+31+1.2*Math.sin(t/700+i),t,i,s.needsYou>0&&i===n-1);
 panes(c);c.restore();
 c.restore();
}
// The live layer moves only while chats run; a chat that only needs you is still (its amber bubble is in the still).
// The needs-you beacon (street traffic) hangs on the side wall beside the door, clear of the awning and the wall lamp.
// At night: the wall lamp; lit, the window, the door's glass and the cup on the parapet in pink neon.
const lights=s=>s.down||s.hidden?[]:[C.lamp(206,220),...lit(s)?[C.light('window','#ffb04a',[WX,WY,WW,WH]),C.light('window','#ffcf8a',[161,214,28,42]),C.light('glow','#ff6fa8',[99,125,24,24])]:[]];
const def=Object.assign(B,{drawStill,drawLive,lights,beacon:{x:219,y:258}});
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
