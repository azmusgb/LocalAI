// Projects › Print lab: the page updates itself after each `lab` command. Every `lab` command pushes to Local AI in the
// background; watch() asks for the sync fingerprint every 3 s while the page is on screen and applies a new one once,
// never while a sheet or field is in use (it waits, then applies). snapshot()/restore() keep the scroll position, the
// open <details> and focus across a quiet re-render. Loaded before print-lab.js (ui.js), which wires it in init().
(function(root){'use strict';
const EVERY=3000;
// check() → the current fingerprint (the first one is the baseline); apply() → re-render; onFailures(n) after each
// failed check with the count in a row, and onFailures(0) on the first success after failures.
function watch({check,apply,isActive,isBusy,onFailures=()=>{},every=EVERY,timers=root}){
 let base=null,pending=null,fails=0,timer=null,running=false,again=false,stopped=false;
 const schedule=ms=>{if(stopped)return;timers.clearTimeout(timer);timer=timers.setTimeout(run,ms)};
 async function run(){
  timer=null;
  if(stopped)return;
  if(running){again=true;return}
  running=true;
  try{
   if(isActive()){
    try{
     const fp=await check();
     if(fails){fails=0;onFailures(0)}
     if(base===null)base=fp;else if(fp!==base)pending=fp;
    }catch{fails++;onFailures(fails)}
    if(pending!==null&&!isBusy()){const fp=pending;try{await apply();base=fp;pending=null}catch{}}
   }
  }finally{running=false}
  if(again){again=false;schedule(0)}else schedule(every);
 }
 schedule(0);
 return {stop(){stopped=true;timers.clearTimeout(timer);timer=null},poke(){schedule(0)}};
}
const sel=id=>'#'+String(id).replace(/([^\w-])/g,'\\$1');
function snapshot(container){
 const doc=container.ownerDocument,a=doc.activeElement;
 return {scrollY:doc.defaultView.scrollY,open:[...container.querySelectorAll('details[open]')].map(d=>d.id).filter(Boolean),focusId:(a&&a.id)||null};
}
function restore(container,snap){
 for(const id of snap.open){const d=container.querySelector(sel(id));if(d)d.open=true}
 const f=snap.focusId&&container.querySelector(sel(snap.focusId));
 if(f&&f.focus)f.focus({preventScroll:true});
 container.ownerDocument.defaultView.scrollTo(0,snap.scrollY);
}
root.LocalAIPrintLabRefresh={watch,snapshot,restore,EVERY};
})(window);
