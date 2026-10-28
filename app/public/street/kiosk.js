// Main Street building: Kiosk Billboard. state/chip/stillKey are pure; the draw functions arrive with the art.
(function(root){'use strict';
const cut=s=>s.length>60?s.slice(0,59)+'…':s;
function state(world){
 const k=world&&world.kiosk;
 if(!k)return{setUp:false,online:null,firmware:null,down:true};
 const setUp=!!k.setUp;
 return{setUp,online:k.online??null,firmware:k.firmware||null,down:setUp&&k.online!==true};
}
function stillKey(s){return s.down?'down':s.setUp?'lit':'off'}
function chip(s){
 const title='Kiosk Billboard';
 if(s.down)return{title,detail:'Not answering',tone:'down'};
 if(!s.setUp)return{title,detail:'Not set up',tone:'quiet'};
 return{title,detail:cut(s.firmware?'Online · '+s.firmware:'Online'),tone:'quiet'};
}
const def={id:'kiosk',width:140,state,stillKey,chip,drawStill(){},drawLive(){}};
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
