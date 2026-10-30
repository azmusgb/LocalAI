// Agent World landmarks (docs/superpowers/specs/2026-10-24-agent-world-round-2-design.md › Landmarks): the city shows
// the house. GET /api/world, polled every 10 s while the city is on screen (one request at a time; the ETag makes an
// unchanged answer a 304), lights four places:
//   Model Foundry       the loaded model's name on its roof; a crate on the roof per queued mission turn (up to 4);
//   Workshop garage     door up with the printer inside and a progress bar while printing, a red beacon on an error;
//   Spreadsheets office windows lit while GridCraft works, dim with "Bridge down" when the bridge doesn't answer;
//   Display billboard   the Workshop display: online and its firmware, or offline.
// Something down or not set up is a dark building with a plain sign, never a made-up state. A tap (or its City services
// row) opens the page that deals with it. Buildings live in the cached ground layer (repainted only when what they
// show changes); the frame overlay is the Foundry's tag and crates and the garage's beacon.
(function(){'use strict';
const W=window.LocalAIAgentWorld,K=window.LocalAIAWKit;if(!W?.addLayer||!K)return;
const T=32,POLL=10000,clean=K.clean;
// Tile boxes from the free blocks of the 40 x 23 grid: east of the avenue beside Repair Bay, and the top strip above
// Documentation Studio. Not Command Center's front yard (its workers stand there) and not the top-left corner (the
// minimap covers it).
const GARAGE={x:27,y:10,w:4,h:3},OFFICE={x:27,y:1,w:4,h:2},BOARD={x:32,y:1,w:3,h:2},FOUNDRY={x:16,y:19,w:8,h:4};
const px=b=>({x:b.x*T,y:b.y*T,w:b.w*T,h:b.h*T});
let world=null,busy=false,timer=0,layer=null;

function pct(n){return Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n))):null}
function printerSay(p){
 if(!p?.setUp)return['Not set up','Add the Workshop display in Services'];
 if(p.access==='stale')return['Reading expired','Waiting for a fresh printer reading from Pi Hub'];
 if(!p.state||p.access&&p.access!=='ok')return['Not answering','The printer isn’t reporting right now'];
 if(p.needsPlateClear===true)return[p.state==='error'?'Print stopped':'Print finished','Check and clear the plate'];
 if(p.state==='error')return['Needs attention',p.errorCode?'Error '+clean(p.errorCode,24):'Check the printer’s screen'];
 if(p.state==='printing'||p.state==='paused'){const n=pct(p.progress),m=p.minutesLeft;return[p.state==='paused'?'Paused':'Printing',(n!=null?n+'%':'')+(Number.isFinite(m)?' · '+m+' min left':'')]}
 return['Idle','Ready for the next print'];
}
function modelSay(m){
 const l=m?.loaded;if(!Array.isArray(l))return['Not answering','The model server didn’t answer'];
 const q=m.queue?.waiting||0;if(!l.length)return['Cold',q?q+' waiting':'No model loaded'];
 return['Working',clean(l[0].name,32)+(l.length>1?' +'+(l.length-1):'')+(q?' · '+q+' waiting':'')];
}
function sheetSay(s){
 if(s?.bridge==null)return['Not answering','The GridCraft bridge didn’t answer'];
 if(!s.bridge)return['Bridge down','Spreadsheets can’t run right now'];
 return s.inFlight?['Working',s.inFlight+' request'+(s.inFlight>1?'s':'')+' running']:['Open',s.excel===false?'Excel isn’t running':'Ready'];
}
function kioskSay(k){
 if(!k?.setUp)return['Not set up','Pair it in Services'];
 if(k.online==null)return['Not answering','No answer yet'];
 return k.online?['Online',k.firmware?'Firmware '+clean(k.firmware,24):'']:['Offline','The display isn’t answering'];
}

function rows(){
 if(!world)return[];
 const r=(id,label,[s,d])=>({id,label,detail:d?s+' · '+d:s});
 return[r('models','Model Foundry',modelSay(world.models)),r('printer','Workshop garage',printerSay(world.printer)),r('sheets','Spreadsheets office',sheetSay(world.sheets)),r('kiosk','Display billboard',kioskSay(world.kiosk))];
}
const OPEN={models:'models',printer:'integrations',sheets:'spreadsheets',kiosk:'integrations'};
function open(it){const v=OPEN[it?.id];if(v&&typeof window.showView==='function')window.showView(v)}
function hit(x,y){
 const inB=b=>{const q=px(b);return x>=q.x&&x<q.x+q.w&&y>=q.y&&y<q.y+q.h};
 const id=inB(GARAGE)?'printer':inB(OFFICE)?'sheets':inB(BOARD)?'kiosk':null;
 return id?rows().find(r=>r.id===id)||null:null;
}

// ---- drawing ----
function box(ctx,c,x,y,w,h){ctx.fillStyle=c;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h))}
function label(ctx,text,x,y,c){ctx.font='bold 9px ui-monospace,Menlo,Consolas,monospace';ctx.textBaseline='middle';const w=Math.ceil(ctx.measureText(text).width)+10;box(ctx,'rgba(10,17,28,.86)',x,y-7,w,14);ctx.fillStyle=c;ctx.fillText(text,x+5,y);return w}
// The city's look: a soft shadow down and right, a lighter roof slab, a front wall and a darker side face.
function block(ctx,q,roof,wall,side,roofH){
 box(ctx,'rgba(0,0,0,.18)',q.x+10,q.y+10,q.w,q.h);box(ctx,side,q.x+q.w,q.y+4,6,q.h-4);
 box(ctx,wall,q.x,q.y+roofH,q.w,q.h-roofH);box(ctx,roof,q.x,q.y,q.w,roofH);box(ctx,'rgba(255,255,255,.14)',q.x,q.y,q.w,2);box(ctx,'rgba(0,0,0,.25)',q.x,q.y+roofH,q.w,2);
 box(ctx,'rgba(0,0,0,.3)',q.x-2,q.y+q.h-4,q.w+10,4);
}
function garage(ctx,e){
 const q=px(GARAGE),p=world?.printer,[s]=printerSay(p),on=s==='Printing'||s==='Paused',dark=s==='Not set up'||s==='Not answering'||s==='Reading expired';
 block(ctx,q,dark?'#343b45':'#5d6b7d',dark?'#20262e':'#353f4c',dark?'#1a1f26':'#262e38',30);
 for(let i=0;i<4;i++)box(ctx,dark?'#2b323b':'#6f7e91',q.x+8+i*30,q.y+8,20,14);
 const dx=q.x+20,dw=q.w-40,dy=q.y+44,dh=q.h-48;
 if(on){box(ctx,'#0a0e13',dx,dy,dw,dh);box(ctx,'rgba(255,190,110,.16)',dx,dy,dw,dh);box(ctx,'#cfd6df',dx+22,dy+8,dw-44,dh-10);box(ctx,'#0f151c',dx+26,dy+12,dw-52,dh-18);
  box(ctx,'#ff9d4d',dx+dw/2-3,dy+16,6,3);box(ctx,'#8ab4ff',dx+30,dy+dh-10,dw-60,3);
  const n=(pct(p.progress)||0)/100;box(ctx,'#121a24',dx,dy-7,dw,5);box(ctx,s==='Paused'?'#ffc640':'#3ed598',dx,dy-7,Math.round(dw*n),5)}
 else{box(ctx,dark?'#2b323c':'#8a97a7',dx,dy,dw,dh);for(let i=dy+4;i<dy+dh;i+=5)box(ctx,dark?'#232931':'#738092',dx,i,dw,2)}
 if(e.night&&on)box(ctx,'rgba(255,200,120,.14)',dx-8,q.y+q.h,dw+16,12);
 label(ctx,'Workshop',q.x+2,q.y-6,s==='Needs attention'?'#ffb0b0':'#e6edf5');
}
function office(ctx,e){
 const q=px(OFFICE),sh=world?.sheets,[s]=sheetSay(sh),lit=s==='Working'||(e.night&&s==='Open'),dark=s==='Not answering'||s==='Bridge down';
 block(ctx,q,dark?'#2c3a35':'#3f7c69',dark?'#1c2723':'#2b5547',dark?'#17201d':'#22463b',16);
 for(let c=0;c<6;c++)for(let r=0;r<2;r++)box(ctx,lit?(c*2+r)%5?'#ffe9a8':'#bff0d4':dark?'#18221e':'#1f3a31',q.x+8+c*19,q.y+22+r*16,12,9);
 label(ctx,s==='Bridge down'?'Bridge down':'Spreadsheets',q.x+2,q.y-6,dark?'#ffb0b0':'#7fe0b6');
}
function billboard(ctx){
 const q=px(BOARD),k=world?.kiosk,[s,d]=kioskSay(k),ok=s==='Online';
 box(ctx,'#2a3038',q.x+20,q.y+40,4,q.h-40);box(ctx,'#2a3038',q.x+q.w-24,q.y+40,4,q.h-40);
 box(ctx,'rgba(0,0,0,.25)',q.x+12,q.y+12,q.w-16,34);box(ctx,'#121a24',q.x+8,q.y+8,q.w-16,34);box(ctx,ok?'#1f3a4f':'#2a2f36',q.x+10,q.y+10,q.w-20,30);
 ctx.font='bold 8px ui-monospace,Menlo,Consolas,monospace';ctx.textBaseline='middle';ctx.fillStyle=ok?'#9fd2ff':'#8a96a5';ctx.fillText('DISPLAY',q.x+16,q.y+19);
 box(ctx,ok?'#3ed598':s==='Offline'?'#ff6b6b':'#6b7684',q.x+16,q.y+28,6,6);ctx.fillStyle=ok?'#e6edf5':'#8a96a5';ctx.fillText(clean(ok&&d?d.replace('Firmware ',''):s,14),q.x+26,q.y+31);
}
function ground(ctx,e){if(!world)return;garage(ctx,e);office(ctx,e);billboard(ctx)}
function crates(ctx){
 const n=Math.min(4,world?.models?.queue?.waiting||0),q=px(FOUNDRY);
 for(let i=0;i<n;i++){const x=q.x+14+i*14,y=q.y+4;box(ctx,'#9a6b3a',x,y,11,9);box(ctx,'#c08a4e',x,y,11,3)}
}
function sig(){if(!world)return'none';const p=world.printer||{};return[modelSay(world.models)[0],world.models?.queue?.waiting||0,p.state,p.access,p.needsPlateClear,pct(p.progress),sheetSay(world.sheets)[0],kioskSay(world.kiosk).join()].join('|')}

function draw(ctx,ts,e){
 if(!world)return;
 const l=world.models?.loaded;
 if(Array.isArray(l)&&l.length){const q=px(FOUNDRY),t=clean(l[0].name.split('/').pop(),22);ctx.font='bold 9px ui-monospace,Menlo,Consolas,monospace';label(ctx,t,q.x+q.w-Math.ceil(ctx.measureText(t).width)-12,q.y-6,'#ffb3bd')}
 crates(ctx);
 if(world.printer?.state==='error'){const q=px(GARAGE),on=e.reduced||Math.floor(ts/500)%2===0;box(ctx,on?'#ff4d5e':'#5a1f27',q.x+q.w-16,q.y-2,8,8)}
}

// ---- polling, only while the city is on screen ----
function visible(){const c=document.getElementById('awcCanvas');return!!(c&&c.isConnected&&c.offsetParent&&!document.hidden)}
async function poll(){
 if(busy||!visible())return;busy=true;
 try{const r=await fetch('/api/world',{cache:'no-cache',credentials:'same-origin'});if(r.ok){const j=await r.json();if(j&&j.schema===1){const before=sig(),had=rows().map(x=>x.detail).join();world=j;if(sig()!==before||rows().map(x=>x.detail).join()!==had)layer.refresh()}}}catch{}
 busy=false;
}
layer=W.addLayer({reserve:[GARAGE,OFFICE,BOARD],ground:{sig,paint:ground},draw,hit,rows,open});
poll();timer=setInterval(poll,POLL);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll()});
window.LocalAIAWLandmarks={poll,state:()=>world,stop(){clearInterval(timer);layer.remove()}};
})();
