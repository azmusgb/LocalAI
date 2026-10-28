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
function runsBuilding({id,key,title,width,roof}){
 const lit=s=>s.running+s.more>0||s.needsYou>0;
 function state(world){
  const top=world&&world.street;if(!top)return{running:0,more:0,needsYou:0,failed:0,first:null,firstRun:null,down:true};
  const s=top[key]||{},a=asks(s),run=s.running||[];
  return{running:Math.min(3,run.length),more:count(s.waiting),needsYou:a.needsYou,failed:a.failed,first:a.first,firstRun:run[0]||null,down:false};
 }
 const stillKey=s=>s.down?'down':lit(s)?'lit':'unlit';
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
 const animates=s=>!s.down&&lit(s);
 return{id,width,roof,state,stillKey,chip,animates,item};
}
const api={cut,count,asks,runsBuilding};
if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalAIStreetCommon=api;
})(typeof window!=='undefined'?window:globalThis);
