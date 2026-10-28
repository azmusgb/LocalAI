// Main Street building: Model Foundry, drawn at the art bar (docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html).
// state/chip/stillKey are pure. The drawing keeps the art bar's own SVG numbers: X/Y map them into this 320-unit box
// (its ground line 452 lands on 300) and art() applies the same map for paths. Textures, people and crates are drawn in
// scene units (bricks and ribs at half size, as dense as the art bar's) so the Foundry matches its neighbours.
// Busy: the furnace burns, the crucible sways and pours, one crate per queued job (up to 4) waits on the belt, light
// falls through the hall, smoke leaves the chimney and the worker stands in the lit door. Quiet: all of it cold and still, the worker
// standing still in the door (animates is false).
// Down: windows and door boarded, no light. drawStill draws what doesn't move; drawLive (t in ms) draws the rest.
(function(root){'use strict';
const cut=s=>s.length>60?s.slice(0,59)+'…':s;
function state(world){
 const m=world&&world.models,list=m&&Array.isArray(m.loaded)?m.loaded:null;
 if(!list)return{model:null,loaded:0,queued:(m&&m.queue&&m.queue.waiting)||0,down:true};
 return{model:(list[0]&&list[0].name)||null,loaded:list.length,queued:(m.queue&&m.queue.waiting)||0,down:false};
}
function stillKey(s){return s.down?'down':s.loaded>0?'lit':'unlit'}
function chip(s){
 const title='Model Foundry';
 if(s.down)return{title,detail:'Not answering',tone:'down'};
 if(s.loaded<=0)return{title,detail:'No model loaded',tone:'quiet'};
 const name=s.model||'Model';
 return{title,detail:cut(name+' loaded'+(s.queued>0?' · '+s.queued+' waiting':'')),tone:'busy'};
}

const KX=.463,KY=.56,X=a=>(a-136)*KX+4,Y=a=>300-(452-a)*KY,TAU=Math.PI*2;
const K=()=>root.LocalAIStreetArt,busy=s=>!s.down&&s.loaded>0;
function art(c){c.transform(KX,0,0,KY,4-136*KX,300-452*KY)}
// Rect and polygon in art-bar units, filled.
function R(c,x,y,w,h,fill,r){c.fillStyle=fill;c.beginPath();if(r&&c.roundRect)c.roundRect(X(x),Y(y),w*KX,h*KY,r);else c.rect(X(x),Y(y),w*KX,h*KY);c.fill()}
function G(c,pts,fill){c.beginPath();for(const [x,y] of pts)c.lineTo(X(x),Y(y));c.closePath();if(fill){c.fillStyle=fill;c.fill()}}
function S(c,x,y,w,h){K().steel(c,X(x),Y(y),w*KX,h*KY)}
// A texture in an art-bar rect, at half scale.
function T(c,fn,x,y,w,h,o){c.save();c.scale(.5,.5);fn(c,X(x)*2,Y(y)*2,w*KX*2,h*KY*2,o);c.restore()}
function lin(c,x0,y0,x1,y1,a,b){const g=c.createLinearGradient(x0,y0,x1,y1);g.addColorStop(0,a);g.addColorStop(1,b);return g}
let PS;
function paths(){return PS||(PS={body:new Path2D('M236 426V320Q236 280 290 280Q344 280 344 320V426Z'),
 mouth:new Path2D('M252 426V330Q252 300 290 300Q328 300 328 330V426Z'),cru:new Path2D('M372 300h46l-6 34h-34z')})}
const flick=t=>.9+.1*Math.sin(t*.0037)*Math.sin(t*.0061+1);
// A board nailed across from (x0,y0) to (x1,y1), in scene units.
function plank(c,x0,y0,x1,y1,w){
 const len=Math.hypot(x1-x0,y1-y0);c.save();c.translate(x0,y0);c.rotate(Math.atan2(y1-y0,x1-x0));
 c.shadowColor='rgba(0,0,0,.4)';c.shadowBlur=2;c.shadowOffsetY=1;c.fillStyle=lin(c,0,-w/2,0,w/2,'#b48858','#6f4a2a');
 c.beginPath();if(c.roundRect)c.roundRect(-2,-w/2,len+4,w,1);else c.rect(-2,-w/2,len+4,w);c.fill();c.shadowColor='transparent';
 c.fillStyle='rgba(60,36,18,.45)';c.fillRect(-2,-.4,len+4,.8);c.fillStyle='#3c434f';
 for(const nx of [2,len-2]){c.beginPath();c.arc(nx,-w/4,.9,0,TAU);c.arc(nx,w/4,.9,0,TAU);c.fill()}c.restore();
}

const WIN=[X(204),Y(246),364*KX,180*KY];
function clipWin(c){c.beginPath();c.rect(...WIN);c.clip()}
// The mullions and the glass sheen: the still draws them, and a busy frame lays them again over what moves behind.
function panes(c){const A=K();c.save();art(c);c.strokeStyle=A.palette.frame;c.lineWidth=7;c.beginPath();c.moveTo(331,246);c.lineTo(331,426);c.moveTo(450,246);c.lineTo(450,426);c.moveTo(204,336);c.lineTo(568,336);c.stroke();
 A.glass(c,204,246,364,180);c.restore()}
// The crucible, in art-bar units: it swings about the bottom of its spout while it pours, and is cold and still otherwise.
function crucible(c,on,t){
 const A=K(),P=A.palette;c.save();if(on){c.translate(395,334);c.rotate(-.105*(.5-.5*Math.cos(TAU*t/1200)));c.translate(-395,-334)}
 c.fillStyle=lin(c,372,0,418,0,'#6c727e','#454a54');c.fill(paths().cru);A.steel(c,368,296,54,7);
 c.fillStyle=on?lin(c,0,296,0,304,P.molten0,P.molten1):'#2a2d33';c.beginPath();c.ellipse(395,300,22,4,0,0,TAU);c.fill();c.restore();
}
// The hall behind the big window, still parts: the room, the furnace's brick body and steel hood, the mould, the belt
// and its rollers, and (when not busy) the cold furnace mouth and crucible. Busy, the spill sits here at its mean strength.
function hallStill(c,s){
 const A=K(),P=A.palette,on=busy(s),ps=paths(),[x0,y0,w,h]=WIN;
 c.save();clipWin(c);c.fillStyle=lin(c,0,y0,0,y0+h,P.interior0,s.down?'#24161a':P.interior1);c.fillRect(x0,y0,w,h);c.restore();
 if(on)A.glow(c,X(300),Y(350),140*KX,90*KY,P.spill,.5);
 c.save();clipWin(c);art(c);c.fillStyle='#3b2a2a';c.fill(ps.body);
 if(!on){c.save();c.clip(ps.mouth);c.fillStyle=lin(c,0,300,0,426,'#191213','#2c1d1a');c.fillRect(252,300,76,126);c.fillStyle='rgba(0,0,0,.35)';c.fillRect(252,414,76,12);c.restore();crucible(c,false,0)}
 A.steel(c,236,276,108,10);
 c.fillStyle='#3a3f48';c.beginPath();if(c.roundRect)c.roundRect(368,384,52,20,3);else c.rect(368,384,52,20);c.fill();
 if(!on){c.fillStyle='#25282e';c.beginPath();c.ellipse(394,386,22,4,0,0,TAU);c.fill()}
 c.fillStyle=P.belt;c.beginPath();if(c.roundRect)c.roundRect(436,398,132,8,4);else c.rect(436,398,132,8);c.fill();
 c.fillStyle='#555c68';c.beginPath();for(const rx of [446,476,506,536,560]){c.moveTo(rx+4,408);c.ellipse(rx,408,4,4,0,0,TAU)}c.fill();
 c.restore();
 if(on){c.save();clipWin(c);c.beginPath();art(c);c.lineWidth=7;c.strokeStyle=P.frame;c.moveTo(331,246);c.lineTo(331,426);c.moveTo(450,246);c.lineTo(450,426);c.moveTo(204,336);c.lineTo(568,336);c.stroke();c.restore()}
 else panes(c);
}
// The hall's moving parts, busy only: the spill's flicker, the fire, the swaying, pouring crucible, the mould's molten
// top, tread marks on the belt, a crate per queued job (up to 4, first in line nearest the furnace) and the rays; then
// the mullions and glass again so all of it sits behind the window.
function hallLive(c,s,t){
 const A=K(),P=A.palette,f=flick(t),ps=paths();
 c.save();clipWin(c);A.glow(c,X(300),Y(350),140*KX,90*KY,P.spill,Math.max(0,.55*(f-.88)));
 c.save();art(c);c.save();c.clip(ps.mouth);
 c.save();c.translate(290,375.6);c.scale(1,1.67);const g=c.createRadialGradient(0,0,0,0,0,49);
 [[0,P.furnace0],[.35,P.furnace1],[.75,P.furnace2],[1,P.furnace3]].forEach(([o,k])=>g.addColorStop(o,k));c.globalAlpha=f;c.fillStyle=g;c.fillRect(-40,-46,80,77);c.restore();
 // Heat shimmer: soft tongues licking up from the coals.
 for(let i=0;i<3;i++){const p=(t/1400+i/3)%1;A.glow(c,268+i*22+4*Math.sin(t*.002+i),420-60*p,12,22,P.furnace0,.45*(1-p)*f)}
 c.restore();crucible(c,true,t);
 A.glow(c,392,360,16,34,P.pour,.4*f);c.strokeStyle=P.pour;c.lineWidth=5;c.lineCap='round';c.setLineDash([6,4]);c.lineDashOffset=-(t*40/600)%40;
 c.beginPath();c.moveTo(392,334);c.lineTo(392,382);c.stroke();c.setLineDash([]);
 c.globalAlpha=f;c.fillStyle=lin(c,0,382,0,390,P.molten0,P.molten1);c.beginPath();c.ellipse(394,386,22,4,0,0,TAU);c.fill();c.globalAlpha=1;
 c.fillStyle='rgba(255,255,255,.16)';c.beginPath();for(let i=0;i<8;i++)c.rect(438+((i*16-t*.02)%128+128)%128,400,3,2);c.fill();
 c.restore();
 for(let i=0,n=Math.min(4,Math.max(0,s.queued|0));i<n;i++)A.crate(c,X(438)+i*14.5,Y(398)-12.3+.4*Math.sin(t*.008+i*1.7),13);
 c.save();art(c);A.rays(c,[[[300,250],[340,250],[420,426],[330,426]],[[420,250],[446,250],[520,426],[460,426]]],P.ray,.18*(1-.45*(.5-.5*Math.cos(TAU*t/3000))));c.restore();
 panes(c);c.restore();
}

function drawStill(c,s){
 const A=K();if(!A)return;const P=A.palette,on=busy(s);c.save();
 // The chimney stands behind the roof.
 T(c,A.brick,620,96,50,190);T(c,A.brickSide,670,104,14,182);S(c,612,86,74,14);
 A.softShadow(c,X(476),302,170,10);
 // The side wall turns away; the roof is corrugated metal with a steel trim.
 T(c,A.brickSide,760,196,52,256,{skew:20*KY*2});
 G(c,[[150,200],[480,124],[812,176],[760,200]],P.roof);
 c.save();G(c,[[140,204],[470,128],[770,204]]);c.clip();T(c,A.corrugated,140,128,630,76);c.restore();
 G(c,[[140,204],[470,128],[470,136],[160,204]],'rgba(255,255,255,.18)');
 c.fillStyle='rgba(0,0,0,.2)';c.fillRect(X(140),Y(208),636*KX,2);S(c,134,200,642,9);
 // The brick front, its steel lintel and pilasters.
 T(c,A.brick,160,208,600,244);S(c,160,208,600,14);S(c,160,208,14,244);S(c,746,208,14,244);
 R(c,196,238,380,196,P.frame,2);hallStill(c,s);S(c,196,434,380,8);
 // The door and the lamp beside it.
 R(c,610,300,112,152,P.dark,2);
 if(s.down){R(c,618,308,96,144,'#3a2a24');c.fillStyle='rgba(0,0,0,.25)';for(let i=0;i<4;i++)c.fillRect(X(618+i*24),Y(308),.8,144*KY)}
 else{R(c,618,308,96,144,'#5a2a1e');c.save();c.beginPath();c.rect(X(618),Y(308),96*KX,144*KY);c.clip();A.glow(c,X(666),Y(380),38,52,P.spill,on?.25:.38);c.restore()}
 c.globalAlpha=.9;R(c,618,308,96,6,'#3a3f48');R(c,618,324,96,3,'#3a3f48');c.globalAlpha=1;
 R(c,588,262,4,22,P.frame);G(c,[[580,262],[600,262],[596,252],[584,252]],P.frame);
 c.fillStyle=s.down?'#5b6170':P.lamp;c.beginPath();c.ellipse(X(590),Y(262),7*KX,2*KY,0,0,TAU);c.fill();
 if(!s.down)A.glow(c,X(590),Y(266),9,6,P.lamp,.45);
 if(s.down){
  const x0=X(196),x1=X(576),y0=Y(238),y1=Y(434);
  plank(c,x0-2,y0+16,x1+2,y0+10,8);plank(c,x0-2,y0+36,x1+2,y0+40,8);plank(c,x0-2,y1-18,x1+2,y1-22,8);plank(c,x0+8,y1-4,x0+70,y0+4,7);plank(c,x1-70,y1-4,x1-8,y0+4,7);
  const d0=X(612),d1=X(720),e0=Y(304),e1=Y(452);plank(c,d0,e0+8,d1,e1-12,7);plank(c,d0,e1-12,d1,e0+8,7);plank(c,d0-2,(e0+e1)/2,d1+2,(e0+e1)/2-2,7);
 }
 c.restore();
}

function drawLive(c,s,t){
 const A=K();if(!A||s.down)return;const P=A.palette,on=busy(s);t=t||0;c.save();
 if(on){
  const f=flick(t);hallLive(c,s,t);
  c.save();c.beginPath();c.rect(X(618),Y(308),96*KX,144*KY);c.clip();A.glow(c,X(666),Y(380),40,56,P.spill,.42*f);c.restore();
  A.glow(c,X(666),303,30,5,P.spill,.35*f);A.glow(c,X(330),303,70,6,P.spill,.22*f);
  A.smoke(c,X(645),Y(76),t/1000);A.smoke(c,X(642),Y(78),t/1000+2.1);
 }
 A.person(c,X(664),300,{prop:'clipboard',scale:.56,pose:on?.04*Math.sin(t/700):0});// a quiet worker stands still
 c.restore();
}
const def={id:'foundry',width:320,state,stillKey,chip,drawStill,drawLive,animates:busy};
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
