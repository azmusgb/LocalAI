// Main Street building: Spreadsheets Office. state/chip/stillKey are pure; the draw functions arrive with the art.
(function(root){'use strict';
const cut=s=>s.length>60?s.slice(0,59)+'…':s;
const tri=v=>typeof v==='boolean'?v:null;
function state(world){
 const w=world&&world.sheets,bridge=w?tri(w.bridge):null,excel=w?tri(w.excel):null;
 const run=((world&&world.street&&world.street.sheets&&world.street.sheets.running)||[]).length;
 return{working:((w&&w.inFlight)||0)>0||run>0,bridge,excel,down:bridge===null};
}
function stillKey(s){return s.down?'down':s.working?'lit':'unlit'}
function chip(s){
 const title='Spreadsheets Office';
 if(s.down)return{title,detail:'Not answering',tone:'down'};
 if(s.working)return{title,detail:'Working',tone:'busy'};
 if(s.bridge===true&&s.excel===false)return{title,detail:cut('Excel not open'),tone:'quiet'};
 return{title,detail:'Ready',tone:'quiet'};
}
const def={id:'sheets',width:220,state,stillKey,chip,drawStill(){},drawLive(){}};
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
