// Main Street building: Claude Yard, drawn in the art bar's language (docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html):
// a fenced work yard under a striped canopy in Claude orange and cream with the spark on its gable, a timber fence at
// the back, pickets at the front corners, a string of festoon bulbs and three trestle tables with laptops. Not a work
// building: state counts the Claude sessions on the board (world.crews, at most 6; null when it can't be read, which
// reads as "No sessions", never boarded). Up to 3 sessions sit at the tables (working ones are picked first; seats go by
// session id, so a session keeps its seat as it switches between working and waiting), each a worker in
// Claude orange at an open laptop; a '+' badge on the post when there are more. A working session types (its forearms
// and the line on its screen move); a waiting one sits still. No sessions: an empty yard, the laptops shut, the bulbs
// off. Hidden while the developer tools are off (body.dev-tools-off). A tap always opens Agent World (no per-session link).
// drawStill draws what doesn't move (the workers and their laptops too: stamp names who sits where, so a change redraws
// the still without moving the camera); drawLive (t in ms) draws only the typing forearms and their screens' lines.
(function(root){'use strict';
const C=typeof module==='object'&&module.exports?require('./common.js'):root.LocalAIStreetCommon;
const TAU=Math.PI*2,K=()=>root.LocalAIStreetArt,TITLE='Claude Yard';
const ORANGE='#d97757',CREAM='#f6eee3',UNDER='#6e3a2a',BOARD=['#b89c74','#a88c66','#c2a77f'],RAIL='#8a6f4c',PLY='#d9b98c',LEG='#7a5228',
 BADGE='#b5513a',SCREEN='#1f1b19',TEXT='#f0dcc8',CARET='#f4a582',PICKET='#efe9df';
const XS=[40,118,196],TOP=276,SKIN=['#e9b88f','#c68a5e','#f1c9a5'];
function state(world){
 const hidden=!!root.document?.body?.classList.contains('dev-tools-off');
 const k=Array.isArray(world&&world.crews)?world.crews.filter(x=>x&&typeof x==='object'):[];
 const on=k.filter(x=>x.state!=='waiting'),all=on.concat(k.filter(x=>x.state==='waiting'));
 return{hidden,working:on.length,waiting:all.length-on.length,
  sessions:all.slice(0,3).map(x=>({id:String(x.id??''),title:String(x.title??''),state:x.state==='waiting'?'waiting':'working'})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),more:Math.max(0,all.length-3),down:false};
}
// Counts only: a session's title never reaches the chip.
function chip(s){
 const d=[];if(s.working>0)d.push(s.working+' working');if(s.waiting>0)d.push(s.waiting+' waiting');
 return{title:TITLE,detail:C.cut(d.join(' · ')||'No sessions'),tone:s.working>0?'busy':'quiet'};
}
const stillKey=s=>s.hidden?'hidden':s.sessions.length?'busy':'idle';
// A worker's skin follows their session, not the seat.
const skin=id=>{let h=0;for(let i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))>>>0;return h%SKIN.length};
// Who sits where (k working, q waiting, with their skin) and the badge: part of the still's cache key, never a change by itself.
const stamp=s=>s.hidden?'':s.sessions.map(x=>(x.state==='working'?'k':'q')+skin(x.id)).join('')+(s.more>0?'+':'');
const animates=s=>!s.hidden&&s.working>0;
// The back fence: dog-eared timber boards in three weathered tones, their gaps and two rails.
function fence(c){
 const A=K();
 for(let k=0;k<3;k++){c.fillStyle=BOARD[k];c.beginPath();for(let x=6+k*9;x<254;x+=27){c.moveTo(x,300);c.lineTo(x,228);c.lineTo(x+4.5,224);c.lineTo(x+9,228);c.lineTo(x+9,300);c.closePath()}c.fill()}
 c.fillStyle='rgba(60,40,24,.4)';for(let x=6;x<=254;x+=9)c.fillRect(x-.4,228,.8,72);
 A.box(c,6,240,248,4,RAIL,1);A.box(c,6,282,248,4,RAIL,1);c.fillStyle='rgba(255,255,255,.18)';c.fillRect(6,240,248,1);c.fillRect(6,282,248,1);
}
// The canopy: a low gable of radiating stripes, shaded on the right, a scalloped valance and the spark on a cream disc.
function canopy(c){
 const A=K(),n=16,w=256/n;c.save();A.poly(c,[[2,210],[130,180],[258,210]]);c.clip();
 for(let k=0;k<2;k++){c.fillStyle=k?CREAM:ORANGE;c.beginPath();for(let i=k;i<n;i+=2){c.moveTo(130,180);c.lineTo(2+i*w,210);c.lineTo(2+(i+1)*w,210);c.closePath()}c.fill()}
 c.fillStyle=A.grad(c,2,0,258,0,'rgba(255,255,255,.16)','rgba(40,16,8,.3)');c.fillRect(2,180,256,30);c.restore();
 c.strokeStyle='rgba(80,30,16,.5)';c.lineWidth=1;c.beginPath();c.moveTo(2,210);c.lineTo(130,180);c.lineTo(258,210);c.stroke();
 for(let k=0;k<2;k++){c.fillStyle=k?CREAM:ORANGE;c.beginPath();for(let i=k;i<n;i+=2){const x=2+i*w;c.rect(x,210,w,5);c.moveTo(x+w,215);c.arc(x+w/2,215,w/2,0,Math.PI)}c.fill()}
 c.fillStyle='rgba(80,30,16,.28)';c.fillRect(2,214,256,1);c.fillStyle='rgba(255,255,255,.25)';c.fillRect(2,210,256,1);
 c.fillStyle=CREAM;c.beginPath();c.arc(130,198,8,0,TAU);c.fill();c.strokeStyle=ORANGE;c.lineWidth=1.2;c.stroke();
 c.lineWidth=1.8;c.lineCap='round';c.beginPath();for(let i=0;i<8;i++){const a=TAU*i/8+.2,r=i&1?4.2:5.6;c.moveTo(130+Math.cos(a)*1.2,198+Math.sin(a)*1.2);c.lineTo(130+Math.cos(a)*r,198+Math.sin(a)*r)}c.stroke();
}
// A string of bulbs sagging between the posts, warm while anyone is in the yard.
function bulbs(c,on){
 const A=K(),B=(u,a,b,m)=>(1-u)*(1-u)*a+2*u*(1-u)*m+u*u*b;c.strokeStyle='#3a3530';c.lineWidth=.8;c.beginPath();c.moveTo(12,220);c.quadraticCurveTo(130,238,248,220);c.stroke();
 for(let i=1;i<14;i++){const u=i/14,x=B(u,12,248,130),y=B(u,220,220,238)+2.4;if(on)A.glow(c,x,y,6,5,A.palette.lamp,.35);c.fillStyle=on?'#ffe7a8':'#8a8f9a';c.beginPath();c.ellipse(x,y,1.5,2,0,0,TAU);c.fill()}
}
// A trestle table: its top, a ply front panel that hides the legs behind it, and splayed legs at both ends.
function table(c,x0){
 const A=K();c.strokeStyle=LEG;c.lineWidth=2;c.beginPath();for(const lx of [x0-12,x0+38]){c.moveTo(lx,TOP+3);c.lineTo(lx-4,300);c.moveTo(lx,TOP+3);c.lineTo(lx+4,300)}c.stroke();
 A.box(c,x0-15,TOP+4,56,15,PLY,1);c.fillStyle='rgba(122,82,40,.25)';c.fillRect(x0-13,TOP+8,52,.7);c.fillRect(x0-13,TOP+13,40,.7);
 A.box(c,x0-18,TOP,62,4,A.grad(c,0,TOP,0,TOP+4,'#c08a52',LEG),1);c.fillStyle='rgba(255,255,255,.3)';c.fillRect(x0-18,TOP,62,.8);
 A.box(c,x0+40,TOP-6,4,6,CREAM,1);c.strokeStyle=CREAM;c.lineWidth=1;c.beginPath();c.arc(x0+44.5,TOP-3,1.6,-1.4,1.4);c.stroke();
}
// A laptop on the table to the worker's right: open (lit screen, a few lines of text) or shut.
function laptop(c,x0,open){
 const A=K();c.fillStyle='#c9ced6';A.poly(c,[[x0+6,TOP],[x0+38,TOP],[x0+35,TOP-3],[x0+9,TOP-3]]);c.fill();
 if(!open){c.fillStyle='#aeb4bd';A.poly(c,[[x0+7,TOP-3],[x0+37,TOP-3],[x0+35,TOP-5],[x0+9,TOP-5]]);c.fill();c.fillStyle=ORANGE;c.fillRect(x0+21,TOP-4.6,2,1.2);return}
 c.fillStyle='#2a2d33';c.fillRect(x0+12,TOP-2.6,20,1.2);A.glow(c,x0+24,TOP-12,20,13,'#ffd9c2',.22);
 A.box(c,x0+12,TOP-22,24,19.4,'#3a3f48',1.5);c.fillStyle=SCREEN;c.fillRect(x0+13.5,TOP-20.5,21,15.5);
 c.fillStyle=ORANGE;c.fillRect(x0+15,TOP-18.5,2,1.4);c.fillStyle=TEXT;c.fillRect(x0+18,TOP-18.5,12,1.4);c.fillRect(x0+15,TOP-15.5,16,1.4);c.fillRect(x0+15,TOP-12.5,9,1.4);
}
// Both forearms on the keyboard; each hand lifts a little as it types (dy, dz).
function arms(c,x0,skin,dy,dz){
 c.strokeStyle=skin;c.lineWidth=3.2;c.lineCap='round';
 c.beginPath();c.moveTo(x0-8,TOP-1);c.lineTo(x0+14,TOP-3-dz);c.stroke();c.beginPath();c.moveTo(x0+10,TOP-1);c.lineTo(x0+21,TOP-3-dy);c.stroke();
}
function drawStill(c,s){
 const A=K();if(!A||s.hidden)return;const P=A.palette,on=s.sessions.length>0;c.save();
 A.softShadow(c,130,302,126,7);
 // The canopy's dark underside and the back fence in its shade, the yard's gravel, the posts.
 c.fillStyle=A.grad(c,0,206,0,232,UNDER,'#4a2618');c.fillRect(4,206,252,26);
 fence(c);c.fillStyle=A.grad(c,0,214,0,300,'rgba(40,20,14,.45)','rgba(40,20,14,.06)');c.fillRect(4,214,252,86);
 A.box(c,4,292,252,8,'#cbbd9c');c.fillStyle='#a8997a';c.beginPath();for(let x=8;x<254;x+=7)c.rect(x+(x*13%5),294+(x*7%4),1.2,1);c.fill();
 A.steel(c,8,206,5,94);A.steel(c,247,206,5,94);
 bulbs(c,on);canopy(c);
 // The tables: a worker (waiting ones with their hands resting on the keys) behind each laptop in use, the rest shut.
 XS.forEach((x0,i)=>{const w=s.sessions[i];const k=w?SKIN[skin(w.id)]:'';if(w)A.person(c,x0,300,{vest:ORANGE,hat:null,skin:k,scale:.55});table(c,x0);laptop(c,x0,!!w);if(w&&w.state==='waiting')arms(c,x0,k,0,0)});
 if(on)A.glow(c,130,301,110,6,P.spill,.18);
 // Pickets at the front corners, and the '+' badge on the right post when more sessions wait their turn.
 for(const x0 of [0,244]){c.fillStyle=PICKET;c.beginPath();for(let x=x0+1;x<x0+16;x+=5){c.moveTo(x,300);c.lineTo(x,270);c.lineTo(x+1.75,267);c.lineTo(x+3.5,270);c.lineTo(x+3.5,300);c.closePath()}c.fill();
  c.fillStyle='#cfc6b8';c.fillRect(x0,276,16,2);c.fillRect(x0,291,16,2)}
 if(s.more>0){c.fillStyle=BADGE;c.beginPath();c.arc(249.5,250,6,0,TAU);c.fill();c.fillStyle='#fff7ef';c.fillRect(246.5,249.2,6,1.6);c.fillRect(248.7,247,1.6,6)}
 c.restore();
}
// Working sessions only: the forearms typing (the hands take turns) and the line on the screen growing to its caret.
function drawLive(c,s,t){
 if(!animates(s))return;const A=K();if(!A)return;t=t||0;c.save();
 XS.forEach((x0,i)=>{const w=s.sessions[i];if(!w||w.state!=='working')return;const p=t/85+i*1.7;
  arms(c,x0,SKIN[skin(w.id)],2.2*Math.max(0,Math.sin(p)),2.2*Math.max(0,-Math.sin(p)));
  const n=((t/90+i*5)%28)|0,len=Math.min(n,16);c.fillStyle=TEXT;c.fillRect(x0+15,TOP-9.5,len,1.4);if((t/400|0)%2===0){c.fillStyle=CARET;c.fillRect(x0+15.6+len,TOP-10.2,1.6,2.8)}});
 c.restore();
}
// At night: four bulbs on the string; each laptop in use.
function lights(s){
 if(s.hidden||s.down)return[];const Q=(u,a,b,m)=>(1-u)*(1-u)*a+2*u*(1-u)*m+u*u*b;
 return[...[2,5,9,12].map(i=>C.lamp(Q(i/14,12,248,130),Q(i/14,220,220,238)+2.4)),...XS.filter((x,i)=>s.sessions[i]).map(x=>C.light('window','#ffd9c2',[x+12,TOP-22,24,19.4]))];
}
const def={id:'yard',width:260,roof:180,state,chip,stillKey,stamp,animates,item:()=>null,drawStill,drawLive,lights};
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
