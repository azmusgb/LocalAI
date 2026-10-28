// Main Street building: Repair Garage, drawn in the art bar's language (docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html):
// a clay-brick garage with two bays under steel roll-door housings, a green sign with a car and a wrench standing on its
// parapet, a wall lamp on the pier between the bays and a stack of tyres. state/chip/stillKey are pure (common.js).
// Busy: the left bay is rolled up and lit, a blue car stands on a raised two-post lift, a mechanic works under it with a
// wrench and sparks fly now and then; an amber "!" over the car when a job needs you. Needs you only: the same bay, lit
// and still, the mechanic standing under the "!". Quiet: both bays shut and dark. Down: both bays boarded, no light.
// drawStill draws what doesn't move; drawLive (t in ms) draws the mechanic, the sparks and the cue.
(function(root){'use strict';
const C=typeof module==='object'&&module.exports?require('./common.js'):root.LocalAIStreetCommon;
const B=C.runsBuilding({id:'garage',key:'garage',title:'Repair Garage',width:240,roof:160});
const lit=s=>s.running+s.more>0||s.needsYou>0;
const TAU=Math.PI*2,K=()=>root.LocalAIStreetArt;
const CAR='#3f7fc4',HAZ='#e05a2a',SIGN='#2d3a2a',SPARK='#fff3b0',BY=196,BH=104,BAYS=[18,120],BW=90,MX=56,MK=.48;
// A roll door shut over a bay: steel slats, a row of small windows (warm when lit) and a handle.
function door(c,x,on,dn){
 const A=K();c.fillStyle=A.grad(c,0,BY,0,BY+BH,dn?'#7d838c':'#a3acb7',dn?'#4f545c':'#6c7480');c.fillRect(x,BY,BW,BH);
 c.fillStyle='rgba(30,34,40,.35)';for(let y=BY+6;y<BY+BH;y+=6)c.fillRect(x,y,BW,1);c.fillStyle='rgba(255,255,255,.18)';for(let y=BY+7;y<BY+BH;y+=6)c.fillRect(x,y,BW,.8);
 for(let i=0;i<4;i++)A.box(c,x+7+i*20.5,BY+30,15,8,on?A.grad(c,0,BY+30,0,BY+38,'#ffe2a8','#e0a050'):'#262a31',1);
 A.box(c,x+BW/2-8,BY+BH-10,16,3,A.palette.steel3,1);
}
// The open bay: the room, a pegboard of tools, the work light and its light, the lift's posts and arms, the car on it.
function bay(c){
 const A=K(),P=A.palette,[x]=BAYS;c.save();c.beginPath();c.rect(x,BY,BW,BH);c.clip();
 c.fillStyle=A.grad(c,0,BY,0,BY+BH,'#5c5e66','#2f3036');c.fillRect(x,BY,BW,BH);c.fillStyle='#26272b';c.fillRect(x,BY+BH-10,BW,10);
 A.box(c,x+8,BY+12,40,20,'#7a6a4a',1);c.fillStyle='rgba(30,24,16,.5)';for(let i=0;i<7;i++)for(let j=0;j<3;j++)c.fillRect(x+11+i*5.4,BY+15+j*6,1,1);
 c.strokeStyle='#d0d6de';c.lineWidth=1.3;c.beginPath();c.moveTo(x+13,BY+16);c.lineTo(x+13,BY+28);c.moveTo(x+20,BY+16);c.lineTo(x+22,BY+27);c.moveTo(x+30,BY+18);c.arc(x+30,BY+18,2.5,0,TAU);c.moveTo(x+30,BY+20.5);c.lineTo(x+30,BY+28);c.stroke();
 c.fillStyle=HAZ;c.fillRect(x+38,BY+16,6,9);c.fillStyle=P.dark;c.fillRect(x+38,BY+16,6,2);
 A.box(c,x+60,BY+14,22,16,'#4a3a2e',1);A.box(c,x+62,BY+16,18,5,'#c0392b',1);A.box(c,x+62,BY+22,18,5,'#c0392b',1);
 A.glow(c,x+45,BY+6,40,16,P.lamp,.45);A.rays(c,[[x+33,BY+5],[x+57,BY+5],[x+80,BY+BH],[x+10,BY+BH]],P.ray,.2);
 c.fillStyle=P.frame;c.fillRect(x+44,BY,2,4);A.box(c,x+34,BY+3,22,3,P.lamp,1.5);
 // The lift: two posts with hazard stripes, arms under the car's sills.
 for(const px of [x+6,x+BW-12]){A.steel(c,px,BY+36,6,BH-36);c.fillStyle=HAZ;for(let y=BY+44;y<BY+BH-6;y+=12)c.fillRect(px,y,6,4)}
 A.steel(c,x+8,BY+51,74,3);
 // The car, nose right: body, cabin and its glass, lamps, wheels in the air.
 c.fillStyle=CAR;A.poly(c,[[x+10,BY+48],[x+10,BY+38],[x+22,BY+35],[x+30,BY+22],[x+58,BY+22],[x+68,BY+35],[x+81,BY+37],[x+82,BY+48]]);c.fill();
 c.fillStyle=A.grad(c,0,BY+22,0,BY+48,'rgba(255,255,255,.3)','rgba(0,0,0,.25)');c.fill();
 c.fillStyle='rgba(205,230,245,.85)';A.poly(c,[[x+32,BY+25],[x+43,BY+25],[x+43,BY+34],[x+25,BY+34]]);c.fill();A.poly(c,[[x+46,BY+25],[x+57,BY+25],[x+64,BY+34],[x+46,BY+34]]);c.fill();
 c.fillStyle='#ffe9a8';c.fillRect(x+78,BY+39,4,3);c.fillStyle=HAZ;c.fillRect(x+10,BY+39,3,3);c.fillStyle='#1d2a3c';c.fillRect(x+44,BY+35,1,12);
 for(const wx of [x+24,x+68]){c.fillStyle='#1e2024';c.beginPath();c.arc(wx,BY+49,7,0,TAU);c.fill();c.fillStyle=P.steel1;c.beginPath();c.arc(wx,BY+49,3,0,TAU);c.fill()}
 c.restore();
}
function drawStill(c,s){
 const A=K();if(!A)return;const P=A.palette,on=lit(s),dn=s.down;c.save();
 A.softShadow(c,116,302,110,8);
 // The flat roof seen from just above, the sign standing on the parapet behind its coping, the side wall turning away.
 A.poly(c,[[4,160],[222,160],[238,151],[20,151]]);c.fillStyle=A.grad(c,0,151,0,160,'#6d6a72','#4d4a55');c.fill();
 c.fillStyle=P.steel3;c.fillRect(82,146,3,14);c.fillRect(143,146,3,14);
 A.box(c,66,124,96,26,dn?'#8a8170':'#d9b45a',3);A.box(c,68,126,92,22,SIGN,2);
 c.fillStyle=dn?'#7a7468':'#f4ead6';A.poly(c,[[78,142],[78,137],[84,136],[88,131],[102,131],[106,136],[114,137],[114,142]]);c.fill();
 c.fillStyle=SIGN;for(const wx of [85,107]){c.beginPath();c.arc(wx,142,3,0,TAU);c.fill()}c.fillStyle=dn?'#7a7468':'#f4ead6';for(const wx of [85,107]){c.beginPath();c.arc(wx,142,1.6,0,TAU);c.fill()}
 c.save();c.translate(136,137);c.rotate(-.8);c.fillStyle=dn?'#8a8170':'#ffc24d';c.fillRect(-9,-1.6,15,3.2);c.beginPath();c.arc(8,0,4.2,0,TAU);c.fill();c.fillStyle=SIGN;c.fillRect(8,-1.4,5,2.8);c.restore();
 A.tex(c,A.brickSide,220,162,18,138,{skew:8,tone:'clay'});A.tex(c,A.brick,8,162,212,138,{tone:'clay'});A.steel(c,4,157,220,6);
 // A soldier course over the bays: the housings and steel lintels, then the bays (left open while there's work).
 for(const x of BAYS){A.box(c,x-6,BY-16,BW+12,6,'#8a4a2e',1);A.box(c,x-2,BY-11,BW+4,11,A.grad(c,0,BY-11,0,BY,P.steel1,P.steel3),2);A.box(c,x-4,BY,4,BH,P.steel3);A.box(c,x+BW,BY,4,BH,P.steel3)}
 if(on){bay(c);c.fillStyle=A.grad(c,0,BY,0,BY+5,'#a3acb7','#6c7480');c.fillRect(BAYS[0],BY,BW,5);A.glow(c,BAYS[0]+45,301,46,5,P.spill,.3)}else door(c,BAYS[0],false,dn);
 door(c,BAYS[1],on,dn);
 // The pier lamp, a tyre stack against the right bay and a yellow bollard at the left.
 A.lamp(c,114,214,!dn);
 for(let i=0;i<3;i++){const y=296-i*7;c.fillStyle='#24252a';c.beginPath();c.ellipse(198,y,13,4.5,0,0,TAU);c.fill();c.fillStyle='#3a3b41';c.beginPath();c.ellipse(198,y-1.5,8,2.4,0,0,TAU);c.fill()}
 A.box(c,8,280,6,20,'#e3b41b',2);c.fillStyle=P.dark;c.fillRect(8,286,6,3);c.fillRect(8,293,6,3);
 if(dn){A.boards(c,BAYS[0],BY,BW,BH);A.boards(c,BAYS[1],BY,BW,BH)}
 if(B.stillKey(s)==='ask')mechanic(c,s,0);
 c.restore();
}
// The mechanic under the car, the wrench working at t (still at t = 0), the cue over the car when a job needs you.
function mechanic(c,s,t){
 const A=K(),dx=t?3*Math.sin(t/160):0,dy=t?2*Math.sin(t/230):0;
 c.save();c.beginPath();c.rect(BAYS[0],BY,BW,BH);c.clip();
 A.person(c,MX,300,{prop:'wrench',vest:'#2f5f9e',hat:'#c43c32',scale:MK,reach:[-12+dx,-24+dy]});c.restore();
 if(s.needsYou>0)A.cue(c,BAYS[0]+44,BY+12,.9);
 return[MX+(38-12+dx)*MK+19*MK,300+(-64-24+dy)*MK-16*MK];
}
function drawLive(c,s,t){
 if(!B.animates(s))return;const A=K();if(!A)return;t=t||0;c.save();
 const [sx,sy]=mechanic(c,s,t),p=(t%2600)/450;
 // Sparks: a short burst every 2.6 s from the wrench's head, falling away and fading.
 if(p<1){A.glow(c,sx,sy,8,8,'#ffcf6a',.6*(1-p));c.strokeStyle=SPARK;c.lineWidth=.9;c.lineCap='round';c.globalAlpha=1-p;c.beginPath();
  for(let i=0;i<7;i++){const a=.4+i*.38,r0=2+10*p,r1=r0+3;c.moveTo(sx+Math.cos(a)*r0,sy+Math.sin(a)*r0+6*p*p);c.lineTo(sx+Math.cos(a)*r1,sy+Math.sin(a)*r1+6*p*p)}c.stroke()}
 c.restore();
}
const def=Object.assign(B,{drawStill,drawLive,lights:()=>[]});
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
