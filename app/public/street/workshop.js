// Main Street building: Workshop Garage. state/chip/stillKey are pure; the draw functions arrive with the art.
(function(root){'use strict';
const cut=s=>s.length>60?s.slice(0,59)+'…':s;
function state(world){
 const p=world&&world.printer;
 if(!p)return{setUp:false,state:null,progress:null,minutesLeft:null,error:false,down:true};
 const setUp=!!p.setUp;
 return{setUp,state:p.state||null,progress:p.progress??null,minutesLeft:p.minutesLeft??null,error:p.state==='error',down:setUp&&p.access!=='ok'};
}
// The still shows the door (up while printing), lit or unlit, and down. Never the progress.
function stillKey(s){return s.down?'down':s.state==='printing'?'up':s.setUp?'unlit':'off'}
function chip(s){
 const title='Workshop Garage';
 if(s.down)return{title,detail:'Not answering',tone:'down'};
 if(!s.setUp)return{title,detail:'Not set up',tone:'quiet'};
 if(s.error)return{title,detail:'Error',tone:'attention'};
 if(s.state==='printing'){
  const d=['Printing'];if(s.progress!=null)d.push(s.progress+'%');if(s.minutesLeft!=null)d.push(s.minutesLeft+' min left');
  return{title,detail:cut(d.join(' · ')),tone:'busy'};
 }
 return{title,detail:'Idle',tone:'quiet'};
}
const def={id:'workshop',width:260,state,stillKey,chip,drawStill(){},drawLive(){}};
if(typeof module==='object'&&module.exports)module.exports=def;else root.LocalAIStreet?.register(def);
})(typeof window!=='undefined'?window:globalThis);
