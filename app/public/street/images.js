// Main Street building: Image Studio. state/chip/stillKey are pure; the draw functions arrive with the art.
(function(root){'use strict';
const cut=s=>s.length>60?s.slice(0,59)+'…':s;
const n=v=>Number.isFinite(v)&&v>0?Math.floor(v):0;
function state(world){
 const src=world&&world.street;if(!src)return{running:0,more:0,needsYou:0,failed:0,down:true};
 const s=src.images||{};
 return{running:Math.min(3,(s.running||[]).length),more:n(s.waiting),needsYou:(s.needsYou||[]).length,failed:(s.failedUnseen||[]).length,down:false};
}
const lit=s=>s.running+s.more>0||s.needsYou>0;
function stillKey(s){return(s.down?'down':lit(s)?'lit':'unlit')}
function chip(s){
 const title='Image Studio';
 if(s.down)return{title,detail:'Not answering',tone:'down'};
 if(!lit(s))return{title,detail:'Quiet',tone:'quiet'};
 const total=s.running+s.more;
 let d=total>0?total+' running':'';
 if(s.needsYou>0)d+=(d?' · ':'')+s.needsYou+' need you';
 return{title,detail:cut(d),tone:s.needsYou>0?'attention':'busy'};
}
const def={id:'images',width:240,state,stillKey,chip,drawStill(){},drawLive(){}};
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
