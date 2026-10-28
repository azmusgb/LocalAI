// Main Street building: Missions HQ, drawn in the art bar's language (docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html):
// a three-storey stone office under a cornice, its top floor a blue command-centre band of glass (a world map, a radar and
// a console inside), offices on the floor below, a lobby storefront with a blue canopy and the HQ's badge, and on the roof
// a dish, a plant box and a lattice antenna. Storefront only, no cutaway. state/chip/stillKey are pure (common.js).
// Busy: every floor is lit, a figure per running mission (up to 3) walks its own floor from window to window, the radar
// sweeps and the antenna's light blinks; an amber "!" rides the top figure when a mission needs you. Needs you only: lit
// and still, one figure in the command band under the "!". Quiet: dark floors, antenna light off. Down: boarded, no light.
// drawStill draws what doesn't move; drawLive (t in ms) draws the people, the radar sweep and the antenna light.
(function(root){'use strict';
const C=typeof module==='object'&&module.exports?require('./common.js'):root.LocalAIStreetCommon;
const B=C.runsBuilding({id:'missions',key:'missions',title:'Missions HQ',width:260,roof:90});
const lit=s=>s.running+s.more>0||s.needsYou>0;
const TAU=Math.PI*2,K=()=>root.LocalAIStreetArt;
const BLUE='#1f4f8a',STRIPE='#2a5d9e',MULL='#173b66',CYAN='#5fd4ff',BEACON='#ff4d3d',RX=150,RY=124,AX=200,AY=31;
// The glass of each floor: the command band, the four office windows, the lobby's two windows and its door leaves.
const BAND=[[20,107,200,42]],OFF=[20,72,124,176].map(x=>[x,170,44,44]),LOBBY=[[18,242,78,50],[140,242,78,50],[106,244,12,52],[120,244,12,52]];
const FLOORS=[{r:BAND,y:149,x0:30,x1:210,k:.34},{r:OFF,y:213,x0:26,x1:214,k:.34},{r:LOBBY,y:292,x0:26,x1:210,k:.4}];
function clip(c,rs){c.beginPath();for(const [x,y,w,h] of rs)c.rect(x,y,w,h);c.clip()}
// Mullions and glass for floor f: the still lays them, and a busy frame lays them again over whoever walks behind.
function panes(c,f){
 const A=K(),P=A.palette;c.save();
 if(f===0){c.fillStyle=MULL;for(const x of [60,100,140,180])c.fillRect(x-1.2,107,2.4,42);c.fillRect(20,113,200,1.6)}
 else if(f===1){c.fillStyle=P.frame;for(const [x,y,w,h] of OFF){c.fillRect(x+w/2-1,y,2,h);c.fillRect(x,y+12,w,1.6)}}
 else{c.fillStyle=P.frame;for(const x of [44,70,166,192])c.fillRect(x-1,242,2,50);c.fillRect(18,252,78,1.6);c.fillRect(140,252,78,1.6)}
 for(const [x,y,w,h] of FLOORS[f].r)A.glass(c,x,y,w,h);c.restore();
}
function room(c,[x,y,w,h],on,dn,a,b){c.fillStyle=K().grad(c,0,y,0,y+h,on?a:dn?'#141518':'#1c1d24',on?b:dn?'#0e0f12':'#111218');c.fillRect(x,y,w,h)}
function drawStill(c,s){
 const A=K();if(!A)return;const P=A.palette,on=lit(s),dn=s.down;c.save();
 A.softShadow(c,124,302,118,8);
 // The roof seen from just above, then what stands on it: the dish, the plant box and the lattice antenna (its light dark).
 A.poly(c,[[6,90],[232,90],[250,81],[24,81]]);c.fillStyle=A.grad(c,0,81,0,90,'#6d6a72','#4d4a55');c.fill();
 A.box(c,49,76,4,12,P.steel3);c.save();c.translate(51,72);c.rotate(-.5);c.fillStyle=A.grad(c,-10,0,10,0,'#eef1f5','#a9b2bf');c.beginPath();c.ellipse(0,0,11,5,0,0,Math.PI);c.fill();
 c.strokeStyle=P.steel3;c.lineWidth=1;c.beginPath();c.moveTo(0,0);c.lineTo(0,-8);c.stroke();c.restore();
 A.steel(c,96,74,44,14);c.fillStyle='rgba(30,34,40,.55)';for(let i=0;i<5;i++)c.fillRect(101+i*7,77,4,8);
 c.strokeStyle=P.steel2;c.lineWidth=1.3;c.beginPath();c.moveTo(AX-7,88);c.lineTo(AX,AY+4);c.lineTo(AX+7,88);
 for(let y=80;y>AY+10;y-=10){const k=(88-y)/(88-AY-4)*7;c.moveTo(AX-7+k,y);c.lineTo(AX+7-k,y-5)}c.stroke();
 A.box(c,AX-3,AY-1,6,5,P.frame,1);c.fillStyle=dn?'#3a2a2a':'#5a2a2a';c.beginPath();c.arc(AX,AY-1,2.6,0,TAU);c.fill();
 // The side wall turning away, the stone front and its cornice.
 A.tex(c,A.brickSide,230,92,20,208,{skew:9,tone:'stone'});A.tex(c,A.brick,10,96,220,204,{tone:'stone'});
 A.steel(c,6,88,228,8);c.fillStyle='rgba(0,0,0,.18)';c.fillRect(10,96,220,2);
 // The command band: blue-framed glass; inside, the world map and the radar over the console.
 A.box(c,14,102,212,52,BLUE,3);c.save();clip(c,BAND);room(c,BAND[0],on,dn,'#12305a','#1d4f86');
 if(on)A.glow(c,120,128,96,24,CYAN,.22);
 A.box(c,30,112,86,24,on?'#0b2a44':'#151a22',2);A.box(c,128,112,80,24,on?'#0b2a44':'#151a22',2);
 if(on){c.fillStyle='rgba(95,212,255,.55)';for(const [x,y,rx,ry] of [[46,121,9,5],[58,130,4,4],[78,119,10,5],[94,126,7,6],[104,131,3,2]]){c.beginPath();c.ellipse(x,y,rx,ry,0,0,TAU);c.fill()}
  c.fillStyle='#ffd38a';for(const [x,y] of [[50,120],[80,118],[95,127]])c.fillRect(x-1,y-1,2,2);
  c.strokeStyle='rgba(95,212,255,.6)';c.lineWidth=.7;c.beginPath();c.arc(RX,RY,9,0,TAU);c.moveTo(RX+5,RY);c.arc(RX,RY,5,0,TAU);c.moveTo(RX-9,RY);c.lineTo(RX+9,RY);c.moveTo(RX,RY-9);c.lineTo(RX,RY+9);c.stroke();
  c.fillStyle='rgba(95,212,255,.7)';for(let i=0;i<6;i++){const h=4+((i*7)%5)*2.4;c.fillRect(170+i*6,133-h,4,h)}}
 A.box(c,24,140,192,9,on?'#0d1c30':'#101318',1);
 if(on){for(let i=0;i<16;i++){c.fillStyle=i%5===2?'#ffc24d':i%3?'#7fe0a8':CYAN;c.fillRect(30+i*11.6,143,3,1.6)}}
 c.restore();panes(c,0);
 // A blue stripe under the band, then the office floor: four windows on a stone sill.
 c.fillStyle=STRIPE;c.fillRect(10,157,220,3);
 OFF.forEach((r,i)=>{const [x,y,w,h]=r;A.box(c,x-2.5,y-2.5,w+5,h+5,P.frame,1.5);c.save();clip(c,[r]);room(c,r,on,dn,'#f4e2c2','#c99a62');
  if(on){c.fillStyle='#fff8e0';c.fillRect(x+6,y+3,w-12,2);A.glow(c,x+w/2,y+6,w/2,10,P.lamp,.4)}
  A.box(c,x+3,y+31,w-6,3,on?'#6d4a30':'#24201c');c.fillStyle=on?'#4a3a2e':'#1a1714';c.fillRect(x+6,y+34,2,10);c.fillRect(x+w-8,y+34,2,10);
  A.box(c,x+8+(i%2)*16,y+21,12,9,P.dark,1);c.fillStyle=on?'#7fd3ff':'#2c3440';c.fillRect(x+9+(i%2)*16,y+22,10,6);
  if(i===3){A.box(c,x+34,y+36,7,8,'#8a5a3a',1);c.fillStyle=on?P.bush1:'#2a3a2c';c.beginPath();c.ellipse(x+37.5,y+32,5,6,0,0,TAU);c.fill()}
  c.restore();A.box(c,x-4,y+h+2.5,w+8,3,'#ddd7cb',1)});
 panes(c,1);
 // The lobby: lintel, the badge over a blue canopy, two windows (a reception desk, a plant) and the glass doors.
 A.steel(c,10,232,216,6);
 c.fillStyle=BLUE;c.beginPath();c.arc(118,224,7.5,0,TAU);c.fill();c.strokeStyle=dn?'#8a8170':'#d9b45a';c.lineWidth=1.4;c.stroke();
 c.fillStyle=dn?'#8a8170':'#ffd56a';c.beginPath();for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,r=i%2?2:4.6;c.lineTo(118+r*Math.cos(a),224+r*Math.sin(a))}c.closePath();c.fill();
 for(const r of LOBBY.slice(0,2)){const [x,y,w,h]=r;A.box(c,x-3,y-3,w+6,h+6,P.frame,1.5);c.save();clip(c,[r]);room(c,r,on,dn,'#f4e2c2','#c99a62');if(on)A.glow(c,x+w/2,y+8,w/2,12,P.lamp,.35);c.restore()}
 c.save();clip(c,[LOBBY[0]]);A.box(c,26,270,46,22,'#7a5228',2);A.box(c,24,268,50,3,'#d9cdb8',1);c.fillStyle=STRIPE;c.fillRect(30,276,38,4);
 c.fillStyle=on?'#33405a':'#1a1d24';c.fillRect(80,246,12,16);c.restore();
 c.save();clip(c,[LOBBY[1]]);A.box(c,196,280,12,12,'#8a5a3a',2);c.fillStyle=on?P.bush0:'#24322a';c.beginPath();c.ellipse(202,272,9,11,0,0,TAU);c.fill();
 A.box(c,148,250,30,18,on?'#2a5d9e':'#1a2230',1);c.restore();
 if(!on){c.save();clip(c,LOBBY.slice(0,2));c.fillStyle='rgba(12,14,20,.6)';c.fillRect(18,242,200,50);c.restore()}
 panes(c,2);A.box(c,16,293,82,6,'#3a3f48',1);A.box(c,138,293,82,6,'#3a3f48',1);
 A.box(c,102,240,32,60,P.frame,1.5);c.save();clip(c,LOBBY.slice(2));room(c,[104,244,28,56],on,dn,'#f4e2c2','#c99a62');c.restore();
 A.glass(c,106,244,12,52);A.glass(c,120,244,12,52);c.fillStyle=P.steel1;c.fillRect(114,266,2,10);c.fillRect(122,266,2,10);
 A.box(c,98,234,40,6,BLUE,1);A.steel(c,98,239,40,2);
 if(on)A.glow(c,118,301,24,4,P.spill,.25);
 if(dn){A.boards(c,20,107,200,42);for(const [x,y,w,h] of OFF)A.boards(c,x,y,w,h);A.boards(c,18,242,78,50);A.boards(c,140,242,78,50);A.boards(c,104,242,28,58)}
 if(B.stillKey(s)==='ask')people(c,s,0);
 c.restore();
}
const FOLK=[['#2f6fb3','#e9b88f'],['#b5485b','#8d5a3b'],['#3f8f6a','#c68a5e']],PER=[9000,11500,13800];
// The people, one per running mission, each walking its own floor (top first): live while missions run, and in the
// still (t = 0) when a mission only needs you. Each floor's glass goes back over them.
function people(c,s,t){
 const A=K(),n=Math.min(3,Math.max(s.running,s.needsYou>0?1:0));let cue=null;
 for(let i=0;i<n;i++){const f=FLOORS[i],p=.5-.5*Math.cos(TAU*t/PER[i]+i*2.1),x=f.x0+(f.x1-f.x0)*p;
  c.save();clip(c,f.r);A.person(c,x,f.y,{vest:FOLK[i][0],skin:FOLK[i][1],hat:null,scale:f.k,pose:t?(t/650+i*.3)%1:0});c.restore();panes(c,i);
  if(i===0)cue=x}
 if(s.needsYou>0&&cue!=null)A.cue(c,cue+6,FLOORS[0].y-40,.8);
}
function drawLive(c,s,t){
 if(!B.animates(s))return;const A=K();if(!A)return;t=t||0;c.save();
 // The radar sweep behind the band's glass, then the people.
 c.save();c.beginPath();c.arc(RX,RY,9,0,TAU);c.clip();const a=TAU*t/2400;c.fillStyle='rgba(95,212,255,.45)';
 c.beginPath();c.moveTo(RX,RY);c.arc(RX,RY,9,a-.9,a);c.closePath();c.fill();c.restore();
 if(s.running===0)panes(c,0);
 people(c,s,t);
 if(t%1600<800){c.fillStyle=BEACON;c.beginPath();c.arc(AX,AY-1,2.6,0,TAU);c.fill();A.glow(c,AX,AY-1,12,12,BEACON,.55)}
 c.restore();
}
const def=Object.assign(B,{drawStill,drawLive,lights:()=>[]});
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
