// Main Street shared building helpers: text and count guards, a street[key] reader, and the logic half of a work building
// (running chats, images and the like). A building file adds its art: Object.assign(C.runsBuilding({...}), {drawStill, drawLive, lights}).
(function(root){'use strict';
const cut=(s,n=60)=>s.length>n?s.slice(0,n-1)+'…':s;
const count=v=>Number.isFinite(v)&&v>0?Math.floor(v):0;
// first: what the building shows a person: the first thing needing them, else the first failure they haven't seen.
function asks(src){
 const k=(src&&src.needsYou)||[],f=(src&&src.failedUnseen)||[];
 return{needsYou:k.length,failed:f.length,first:k[0]||f[0]||null};
}
// Panels (a def's panel(state, world)): the rows a building shows when tapped. Order: needs you, failed, running, recent; 6 at most, no repeated id.
const hm=v=>{const d=new Date(v);return v==null||isNaN(d)?'Finished':'Finished · '+d.getHours()+':'+String(d.getMinutes()).padStart(2,'0')};
const NOTE={completed:hm,failed:()=>'Failed',cancelled:()=>'Stopped'};
function runRows(src){
 src=src||{};const seen=new Set(),rows=[];
 const add=(a,f)=>(a||[]).forEach(x=>{if(!x||rows.length>=6||seen.has(x.id))return;seen.add(x.id);rows.push({id:x.id,title:cut(String(x.title??''),80),note:f(x)})});
 add(src.needsYou,()=>'Needs you');add(src.failedUnseen,()=>'Failed');add(src.running,()=>'Running');
 add(src.recent,x=>(NOTE[x.status]||(()=>'Finished'))(x.startedAt));
 return rows;
}
const panelOf=(c,rows,open,extra)=>Object.assign({title:c.title,status:c.detail,tone:c.tone,rows,open},extra);
const runsPanel=(key,open,extra)=>(c,world)=>panelOf(c,runRows(world&&world.street&&world.street[key]),open,extra);
function runsBuilding({id,key,title,width,roof,open,mission}){
 const lit=s=>s.running+s.more>0||s.needsYou>0;
 function state(world){
  const top=world&&world.street;if(!top)return{running:0,more:0,needsYou:0,failed:0,first:null,firstRun:null,down:true};
  const s=top[key]||{},a=asks(s),run=s.running||[];
  return{running:Math.min(3,run.length),more:count(s.waiting),needsYou:a.needsYou,failed:a.failed,first:a.first,firstRun:run[0]||null,down:false};
 }
 // 'ask' (needs you, nothing running) is its own still: it carries the cue, and the engine caches stills by this key.
 const stillKey=s=>s.down?'down':!s.down&&s.running+s.more===0&&s.needsYou>0?'ask':lit(s)?'lit':'unlit';
 function chip(s){
  if(s.down)return{title,detail:'Not answering',tone:'down'};
  if(!lit(s)&&!s.failed)return{title,detail:'Quiet',tone:'quiet'};
  const total=s.running+s.more,d=[];
  if(total>0)d.push(total+' running');
  if(s.needsYou>0)d.push(s.needsYou+' need you');
  if(s.failed>0)d.push(s.failed+' failed');
  return{title,detail:cut(d.join(' · ')),tone:s.needsYou>0||s.failed>0?'attention':'busy'};
 }
 const item=s=>s.first||s.firstRun||null;
 // A building that only needs you is still: its cue is in the still, and the beacon carries attention.
 const animates=s=>!s.down&&s.running+s.more>0;
 const panel=(s,world)=>runsPanel(key,open,mission?{mission:true}:undefined)(chip(s),world);
 return{id,width,roof,state,stillKey,chip,animates,item,panel};
}
// Night lights (night.js; a def's lights(state)): a wall lamp's bulb at (x, y) as art.js lamp hangs it, and any light
// over a rect [x, y, w, h] in building coordinates.
const lamp=(x,y)=>({x:x-4,y:y-2,w:8,h:4,color:'#fff4cc',kind:'lamp'});
const light=(kind,color,[x,y,w,h])=>({x,y,w,h,color,kind});
const api={cut,count,asks,runsBuilding,runRows,panelOf,runsPanel,lamp,light};
if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalAIStreetCommon=api;
})(typeof window!=='undefined'?window:globalThis);
