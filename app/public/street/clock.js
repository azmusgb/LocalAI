// Main Street building: Clock Tower, drawn in the art bar's language (docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html):
// a narrow tower of honey ashlar with quoined corners, a verdigris spire with a gilt weathervane, an open belfry with its
// bronze bell, a big gilt-ringed clock face low enough to read under the strip's chip, an arched oak door between two
// lamps, and buttresses at its foot. state/chip/stillKey are pure (common.js). The hands read the real local time
// (now(), a test seam). Busy: the face glows, the minute hand sweeps a full turn back to the real minute every few seconds and the
// bell swings and rings; an amber "!" by the bell when an automation needs you. Needs you only: lit and still, the
// hands and the cue in the still. Quiet: the face by daylight, still hands at the time the still was drawn (it may be up
// to an hour stale: a quiet tower never wakes the loop; stamp, the hour, rebuilds its still on the next world or redraw). Down: a boarded belfry and a dark face, no hands.
// drawStill draws what doesn't move; drawLive (t in ms) draws the hands, the bell and the cue.
(function(root){'use strict';
const C=typeof module==='object'&&module.exports?require('./common.js'):root.LocalAIStreetCommon;
const B=C.runsBuilding({id:'clock',key:'clock',title:'Clock Tower',width:140,roof:60});
const lit=s=>s.running+s.more>0||s.needsYou>0;
const TAU=Math.PI*2,K=()=>root.LocalAIStreetArt;
const ST=['#d8c8a6','#cfbd98','#e0d1b2','#c8b48e'],MORTAR='#a8977a',QUOIN='#ece0c4',COPPER='#3f8f7c',GILT='#d9b45a',BRONZE='#c08a3e',FACE='#f6eed6',INK='#262a31';
let now=()=>new Date();
const FX=68,FY=190,FR=25,PX=68,PY=112,OP=[48,104,40,42],SWEEP=1200,CYCLE=3600;
// Ashlar: courses 8 units tall, blocks 18 wide, half-bond, four tones by position, a lit top edge, the wall light.
function ashlar(c,x,y,w,h,shade){
 c.save();c.beginPath();c.rect(x,y,w,h);c.clip();c.fillStyle=MORTAR;c.fillRect(x,y,w,h);
 const x0=x-((x%18)+18)%18-18,y0=y-((y%8)+8)%8,each=f=>{for(let yy=y0;yy<y+h;yy+=8){const r=Math.round(yy/8),o=(r&1)*9;for(let xx=x0+o;xx<x+w;xx+=18)f(xx,yy,(((r*7+Math.round(xx/9)*5)%4)+4)%4)}};
 for(let k=0;k<4;k++){c.fillStyle=ST[k];c.beginPath();each((xx,yy,q)=>{if(q===k)c.rect(xx+.6,yy+.6,16.8,6.8)});c.fill()}
 c.fillStyle='rgba(255,255,255,.3)';c.beginPath();each((xx,yy)=>c.rect(xx+1,yy+.8,15,.9));c.fill();
 const A=K();c.fillStyle=A.grad(c,x,y,x+w,y+h,'rgba(255,255,255,.1)','rgba(0,0,0,.16)');c.fillRect(x,y,w,h);
 if(shade){c.fillStyle='rgba(30,16,20,.38)';c.fillRect(x,y,w,h)}c.restore();
}
// A side face turning away: its far edge rises by s.
function side(c,x,y,w,h,s){c.save();K().poly(c,[[x,y],[x+w,y-s],[x+w,y+h-s*.6],[x,y+h]]);c.clip();ashlar(c,x,y-s,w,h+s,true);c.restore()}
// Quoins: long and short blocks up a corner, paler than the wall.
function quoins(c,x,y0,y1,right){c.fillStyle=QUOIN;c.beginPath();for(let y=y0,i=0;y<y1;y+=8,i++){const w=i&1?6:10;c.rect(right?x-w:x,y+.6,w,6.8)}c.fill()}
function arch(c,x,y,w,h){c.beginPath();c.moveTo(x,y+h);c.lineTo(x,y+w/2);c.arc(x+w/2,y+w/2,w/2,Math.PI,0);c.lineTo(x+w,y+h);c.closePath()}
// The hands from the face's centre: angle 0 is twelve o'clock.
function hand(c,a,len,w){c.save();c.translate(FX,FY);c.rotate(a);K().poly(c,[[-w/2,4],[-w/3,-len*.7],[0,-len],[w/3,-len*.7],[w/2,4]]);c.fill();c.restore()}
function hands(c,d,extra){
 const h=d.getHours()%12,m=d.getMinutes()+d.getSeconds()/60;c.save();c.fillStyle=INK;
 hand(c,TAU*(h+m/60)/12,14,3.4);hand(c,TAU*m/60+(extra||0),21,2.2);c.fillStyle=GILT;c.beginPath();c.arc(FX,FY,2.2,0,TAU);c.fill();c.restore();
}
// The bell, swung a radians about its pivot under the belfry's beam, its clapper lagging behind.
function bell(c,a){
 c.save();c.translate(PX,PY);c.rotate(a);const g=c.createLinearGradient(-12,0,12,0);
 for(const [o,k] of [[0,'#6e4a1e'],[.35,BRONZE],[.55,'#f0c878'],[1,'#6e4a1e']])g.addColorStop(o,k);
 c.fillStyle='#4a3424';c.fillRect(-3,-1,6,4);c.fillStyle=g;c.beginPath();c.moveTo(-6,3);c.quadraticCurveTo(-7,14,-12,20);c.lineTo(12,20);c.quadraticCurveTo(7,14,6,3);c.closePath();c.fill();
 c.fillStyle='rgba(60,36,14,.55)';c.fillRect(-11,17,22,1.2);c.fillStyle='#3a2a1a';c.beginPath();c.ellipse(0,20,12,2,0,0,TAU);c.fill();
 c.save();c.translate(0,6);c.rotate(-a*.6);c.fillStyle='#2a2d33';c.fillRect(-.8,0,1.6,13);c.beginPath();c.arc(0,15,2.4,0,TAU);c.fill();c.restore();
 c.restore();
}
function drawStill(c,s){
 const A=K();if(!A)return;const P=A.palette,on=lit(s),dn=s.down,quiet=!B.animates(s);c.save();
 A.softShadow(c,72,302,62,7);
 // The spire seen from just in front, its shaded right face, standing seams, the gilt finial and the weathervane.
 c.strokeStyle=GILT;c.lineWidth=1.2;c.beginPath();c.moveTo(68,62);c.lineTo(68,44);c.moveTo(61,49);c.lineTo(76,49);c.stroke();
 c.fillStyle=GILT;A.poly(c,[[76,49],[72,46.5],[72,51.5]]);c.fill();A.poly(c,[[60,47],[64,49],[60,51],[62,49]]);c.fill();
 A.poly(c,[[110,96],[121,91],[68,62]]);c.fillStyle='#2f6b5e';c.fill();
 A.poly(c,[[26,96],[110,96],[68,62]]);c.fillStyle=A.grad(c,26,62,110,96,'#5fae98',COPPER);c.fill();
 c.strokeStyle='rgba(20,60,50,.45)';c.lineWidth=.8;c.beginPath();for(const x of [36,47,58,78,89,100]){c.moveTo(68,62);c.lineTo(x,96)}c.stroke();
 c.fillStyle=GILT;c.beginPath();c.arc(68,60,2.6,0,TAU);c.fill();
 // The tower: side faces in shade, the ashlar front, quoins, and the cornices that divide it.
 side(c,104,100,10,146,5);side(c,110,246,10,54,4);
 ashlar(c,32,96,72,150);ashlar(c,26,246,84,54);
 quoins(c,32,104,246,false);quoins(c,104,104,246,true);quoins(c,26,252,300,false);quoins(c,110,252,300,true);
 for(const [x,y,w,h] of [[26,94,88,5],[28,146,82,6],[30,228,78,3],[22,244,94,6]]){A.box(c,x,y,w,h,QUOIN,1);c.fillStyle='rgba(0,0,0,.2)';c.fillRect(x,y+h-1,w,1)}
 // The belfry: a moulded arch opening onto a dark room (warm when lit), the beam the bell hangs from, a balustrade.
 const [ox,oy,ow,oh]=OP;c.save();arch(c,ox,oy,ow,oh);c.clip();
 c.fillStyle=A.grad(c,0,oy,0,oy+oh,on?'#6a4428':dn?'#141214':'#2a2422',on?'#2a1a12':dn?'#0c0b0c':'#141112');c.fillRect(ox,oy,ow,oh);
 if(on)A.glow(c,PX,PY+14,22,18,P.lamp,.35);
 A.box(c,ox,PY-6,ow,4,'#4a3424');c.fillStyle='rgba(255,255,255,.15)';c.fillRect(ox,PY-6,ow,1);
 if(!dn&&quiet)bell(c,0);
 c.restore();
 c.strokeStyle=QUOIN;c.lineWidth=2.4;arch(c,ox-1.2,oy-1.2,ow+2.4,oh+1.2);c.stroke();
 A.box(c,ox,138,ow,2,QUOIN);c.fillStyle=QUOIN;c.beginPath();for(let x=ox+3;x<ox+ow;x+=5.6)c.rect(x,140,2.4,6);c.fill();
 // The clock face: a pale stone surround, the gilt ring, the dial (glowing when lit, dark when down) and its marks.
 A.box(c,36,158,64,64,QUOIN,2);c.fillStyle='rgba(0,0,0,.14)';c.fillRect(36,220,64,2);
 for(const [x,y] of [[40,162],[96,162],[40,218],[96,218]]){c.fillStyle=GILT;c.beginPath();c.arc(x,y,1.6,0,TAU);c.fill()}
 if(on)A.glow(c,FX,FY,40,40,P.lamp,.5);
 c.fillStyle=dn?'#55504a':A.grad(c,FX-28,FY-28,FX+28,FY+28,'#f4d98a','#a8822e');c.beginPath();c.arc(FX,FY,FR+3,0,TAU);c.fill();
 c.fillStyle=dn?A.grad(c,0,FY-FR,0,FY+FR,'#34363c','#1e2024'):A.grad(c,0,FY-FR,0,FY+FR,FACE,on?'#ffe6a6':'#ddcfae');c.beginPath();c.arc(FX,FY,FR,0,TAU);c.fill();
 c.strokeStyle=dn?'#45474d':INK;c.lineCap='round';
 for(let i=0;i<12;i++){const a=TAU*i/12,q=i%3===0,r0=q?17:19.5;c.lineWidth=q?2.2:1.2;c.beginPath();c.moveTo(FX+Math.sin(a)*r0,FY-Math.cos(a)*r0);c.lineTo(FX+Math.sin(a)*23,FY-Math.cos(a)*23);c.stroke()}
 c.fillStyle=dn?'#45474d':INK;c.beginPath();for(let i=0;i<60;i++)if(i%5){const a=TAU*i/60;c.rect(FX+Math.sin(a)*23-.4,FY-Math.cos(a)*23-.4,.8,.8)}c.fill();
 if(!dn){c.fillStyle='rgba(255,255,255,.22)';c.beginPath();c.ellipse(FX-8,FY-11,12,5,-.5,0,TAU);c.fill()}
 if(!dn&&quiet)hands(c,now(),0);
 // A slit window under the face, the door between two lamps, its step, and the buttresses at the tower's foot.
 A.box(c,65,232,6,10,on?'#ffd38a':'#2a2624',3);
 A.box(c,53,256,30,44,QUOIN,1);arch(c,56,258,24,42);c.fillStyle=A.grad(c,0,258,0,300,'#7a4a2a','#4a2a18');c.fill();
 c.save();c.clip();c.fillStyle=on?'#ffd38a':dn?'#1a1614':'#2a2624';c.beginPath();c.arc(68,270,9,Math.PI,0);c.fill();
 c.fillStyle='rgba(30,18,10,.6)';c.fillRect(56,270,24,1.6);c.fillRect(67.2,270,1.6,30);c.fillRect(56,284,24,1.2);c.restore();
 c.fillStyle='#2a2d33';for(const y of [276,292])for(const x of [60,64,72,76]){c.beginPath();c.arc(x,y,.8,0,TAU);c.fill()}
 A.box(c,48,296,40,4,'#b9ad96',1);A.lamp(c,44,268,!dn);A.lamp(c,92,268,!dn);
 for(const pts of [[[8,300],[8,280],[26,266],[26,300]],[[120,300],[120,266],[134,280],[134,300]]]){c.save();A.poly(c,pts);c.clip();ashlar(c,6,264,130,36,pts[0][0]>100);c.restore()}
 c.fillStyle=QUOIN;A.poly(c,[[7,281],[26,265.5],[26,268.5],[8,283]]);c.fill();A.poly(c,[[120,265.5],[135,279.5],[134,282],[120,268.5]]);c.fill();
 // Ivy up the left corner of the base, and two pigeons on the belfry's ledge.
 for(const [x,y,r,k] of [[28,298,7,0],[33,290,6,1],[27,284,5,2],[31,276,4.5,0],[27,269,4,1],[30,262,3.5,2],[35,282,3.5,2]]){c.fillStyle=[P.bush0,P.bush1,P.bush2][k];c.beginPath();c.ellipse(x,y,r,r*.8,0,0,TAU);c.fill()}
 for(const [x,f] of [[38,1],[99,-1]]){c.fillStyle='#8a8f9a';c.beginPath();c.ellipse(x,143,3.6,2.4,0,0,TAU);c.fill();c.beginPath();c.arc(x+2.6*f,140.6,1.6,0,TAU);c.fill();
  c.fillStyle='#5a6070';A.poly(c,[[x-3*f,142],[x-6.5*f,141],[x-3*f,144.5]]);c.fill();c.fillStyle='#e0a050';c.fillRect(x+(f>0?3.8:-5.2),140.4,1.4,.8)}
 if(on)A.glow(c,68,301,20,4,P.spill,.25);
 if(dn)A.boards(c,ox,oy+4,ow,oh-4);
 if(B.stillKey(s)==='ask')A.cue(c,90,122,.9);
 c.restore();
}
// Busy: the bell swings (and rings at the top of each swing), the minute hand sweeps a full turn back to the real minute
// once every CYCLE ms and then rests on it, and the cue sits by the bell when an automation needs you.
function drawLive(c,s,t){
 if(!B.animates(s))return;const A=K();if(!A)return;t=t||0;c.save();
 const w=Math.sin(TAU*t/1500),[ox,oy,ow,oh]=OP;
 c.save();arch(c,ox,oy,ow,oh);c.clip();bell(c,.42*w);c.restore();
 const ring=(Math.abs(w)-.82)/.18;
 if(ring>0){const d=Math.sign(w);c.strokeStyle='rgba(255,236,190,.9)';c.lineWidth=1.2;c.lineCap='round';c.globalAlpha=ring;c.beginPath();
  for(const r of [5,9]){const cx=PX+d*(ow/2+4),a0=d>0?-.7:Math.PI-.7;c.moveTo(cx+Math.cos(a0)*r,PY+14+Math.sin(a0)*r);c.arc(cx,PY+14,r,a0,a0+1.4)}c.stroke();c.globalAlpha=1}
 const p=(t%CYCLE)/SWEEP,e=p<1?(p<.5?2*p*p:1-(2-2*p)**2/2):0;
 hands(c,now(),TAU*e);
 if(s.needsYou>0)A.cue(c,90,122,.9);
 c.restore();
}
// The still's stamp: a quiet tower's hour and 5-minute step, so its hands are redrawn every 5 minutes without a still-key change.
// The needs-you beacon (street traffic) hangs on the shaft's edge beside the clock face (the default would float off the tower).
// At night: the two lamps at the door; lit, the clock face and the belfry.
const lights=s=>s.down||s.hidden?[]:[C.lamp(44,268),C.lamp(92,268),...lit(s)?[C.light('window','#fff4cc',[FX-FR,FY-FR,2*FR,2*FR]),C.light('window','#ffd38a',OP)]:[]];
const def=Object.assign(B,{drawStill,drawLive,lights,beacon:{x:108,y:205},stamp:s=>B.animates(s)||s.down?'':`${now().getHours()}:${Math.floor(now().getMinutes()/5)}`});
if(typeof module==='object'&&module.exports)module.exports=Object.assign(def,{setNow:f=>{now=f||(()=>new Date())}});else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
