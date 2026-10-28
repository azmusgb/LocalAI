// Main Street building: Model Foundry. state/chip/stillKey are pure; the draw functions arrive with the art.
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
const def={id:'foundry',width:320,state,stillKey,chip,drawStill(){},drawLive(){}};
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
