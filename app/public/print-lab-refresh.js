// Projects › Print lab: the page updates itself after each `lab` command. Every `lab` command pushes to Local AI in the
// background; watch() asks for the sync fingerprint every 3 s while the page is on screen and applies a new one once,
// never while a sheet or field is in use (it waits, then applies). snapshot()/restore() keep the scroll position, the
// open <details> and focus across a quiet re-render. Loaded before print-lab.js (ui.js), which wires it in init().
(function(root){'use strict';
const EVERY=3000;
// check() → the current fingerprint, or null with no project yet (the first answer is the baseline, so the first
// project to arrive after "no data yet" is applied); apply() → re-render; onFailures(n) after each
// failed check with the count in a row, and onFailures(0) on the first success after failures.
function watch({check,apply,isActive,isBusy,onFailures=()=>{},every=EVERY,timers=root}){
 let base,pending=null,fails=0,timer=null,running=false,again=false,stopped=false;
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
     if(base===undefined)base=fp;else if(fp!==base)pending=fp;
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
const q=v=>String(v).replace(/["\\]/g,'\\$&');
// A control without an id is found again by its tag, classes and data-* attributes inside its nearest ancestor with an
// id (a card, a <details>), and its position among the matches there.
function focusKey(container,a){
 if(!a||!a.closest||!container.contains||!container.contains(a)||a===container)return null;
 if(a.id)return {id:a.id};
 const within=a.parentElement&&a.parentElement.closest('[id]');
 const scope=within&&container.contains(within)?within:container;
 const css=a.tagName.toLowerCase()+[...a.classList].map(c=>'.'+c.replace(/([^\w-])/g,'\\$1')).join('')
  +[...a.attributes].filter(x=>x.name.startsWith('data-')).map(x=>`[${x.name}="${q(x.value)}"]`).join('');
 return {within:scope===container?null:scope.id,css,i:[...scope.querySelectorAll(css)].indexOf(a)};
}
function snapshot(container){
 const doc=container.ownerDocument,a=doc.activeElement,key=focusKey(container,a);
 // The card being read: the first one still on screen, and where its top is, so a change above it doesn't move it.
 const card=[...container.querySelectorAll('.lab-exp')].find(c=>c.getBoundingClientRect().bottom>0);
 return {scrollY:doc.defaultView.scrollY,open:[...container.querySelectorAll('details[open]')].map(d=>d.id).filter(Boolean),
  focusId:key&&key.id||(a&&a.id)||null,focus:key&&!key.id?key:null,anchor:card&&card.id?{id:card.id,top:card.getBoundingClientRect().top}:null};
}
function restore(container,snap){
 const win=container.ownerDocument.defaultView;
 for(const id of snap.open){const d=container.querySelector(sel(id));if(d)d.open=true}
 let f=snap.focusId&&container.querySelector(sel(snap.focusId));
 if(!f&&snap.focus){const scope=snap.focus.within?container.querySelector(sel(snap.focus.within)):container;f=scope&&scope.querySelectorAll(snap.focus.css)[snap.focus.i]}
 if(f&&f.focus)f.focus({preventScroll:true});
 const card=snap.anchor&&container.querySelector(sel(snap.anchor.id));
 if(card)win.scrollBy(0,card.getBoundingClientRect().top-snap.anchor.top);else win.scrollTo(0,snap.scrollY);
}
root.LocalAIPrintLabRefresh={watch,snapshot,restore,EVERY};
})(window);
