// Hash router: #<page>[?query] opens a page, #run/<id> opens a run (handler registered with onRun).
// The router drives window.showView; showView calls from other code update the hash with replace semantics
// (replaceState fires no hashchange, so the two cannot loop and Back only follows go() / open() navigation).
// Anything the person does (a link, a button, a row) navigates with open(id) so Back returns; showView is for code.
(function(root){'use strict';
// An old id's intent on the page that replaced it. Agent World (agents) is its own page again (Pi Hub A7 plan, decision 9).
const INTENTS={ask:{mode:'ask'},create:{mode:'create'}};
const REG=()=>root.LocalAIViews,runHandlers=[];
let ready=false,applying=false,runOpen=null,lastShown=null;
// A closing sheet pops its own history entry with history.back(), which lands a few ms later (LocalAIUI.afterSheetPop).
// Every history move here waits for that: one made in the gap is undone when the back() lands on the page under the sheet,
// and its hashchange reopens that page (Escape on Agent World's start sheet, then Home, showed Agent World again).
const afterPop=fn=>{const w=root.LocalAIUI?.afterSheetPop;if(typeof w==='function')w(fn);else fn()};
function parse(hash=location.hash){
 const raw=String(hash||'').replace(/^#\/?/,''),i=raw.indexOf('?'),path=i<0?raw:raw.slice(0,i),query=new URLSearchParams(i<0?'':raw.slice(i+1)),m=/^run\/(.+)$/.exec(path);
 if(m)return{page:'run',runId:decodeURIComponent(m[1]),query};
 return{page:path||'home',runId:null,query};
}
const intentFor=id=>({...(INTENTS[id]||{})});
// Replacing one run with another (Another version, a version tap) keeps the entry's in-app mark, so Close still goes Back.
const put=(h,state=null)=>{if(location.hash===h)return;if(state===null&&history.state?.localaiRun&&parse().runId&&parse(h).runId)state={localaiRun:true};history.replaceState(state,'',location.pathname+location.search+h)};
function notifyRun(id){if(id===runOpen)return;runOpen=id;runHandlers.forEach(fn=>{try{fn(id)}catch(e){console.error(e)}})}
// Show whatever the hash names.
function apply(){
 const cur=parse();
 if(cur.runId){notifyRun(cur.runId);return}
 notifyRun(null);
 // The Print lab lives on Pi Hub; an old #printLab address (a bookmark, a link) goes there with its p, e and do.
 if(cur.page==='printLab'&&root.LocalAIAskContext){root.location.replace(root.LocalAIAskContext.labUrl(location.hostname,location.hash));return}
 const V=REG();if(!V||typeof root.showView!=='function')return;
 if(!V.view(cur.page)){const d=V.DOMAINS.find(x=>x.id===cur.page),t=d?d.defaultView:'home';put('#'+t);cur.page=t} // a domain id (#improve, #system) opens its first page
 // A hidden page (Runs, Missions…) that showView put in history keeps its own page when Back returns to it; a typed #runs still means Work.
 if(history.state?.localaiPage===cur.page&&V.view(cur.page).domain==='hidden'&&document.getElementById(cur.page)){applying=true;try{root.showView(cur.page)}finally{applying=false}return}
 const target=V.resolve(cur.page),intent=INTENTS[cur.page];
 if(target!==cur.page||intent){ // an old id: rewrite the hash to the page that owns it, keeping what it meant
  const q=new URLSearchParams(cur.query);for(const [k,v] of Object.entries(intent||{}))if(!q.has(k))q.set(k,v);
  put('#'+target+(q.toString()?'?'+q:''));
 }
 applying=true;try{root.showView(target)}finally{applying=false}
}
// A sheet (LocalAIUI.sheetHistory) has an entry on top of the page's: a link tapped inside it takes that entry over instead of stacking on it.
// Only a live sheet's entry counts: one left over from before a reload (or reached by Forward) belongs to no sheet.
const sheetOnTop=()=>{const s=history.state&&history.state.localaiSheet;return !!s&&!!root.LocalAIUI?.sheetLive?.(s)};
// Framed by Pi Hub (framed.js, A4 requirement 7), every move replaces this entry: Pi Hub's Back leaves the Assistant in
// one step instead of walking back through its pages. previous() is the page before, for a Close that would go Back.
const framed=()=>!!root.LocalAIFramed?.active();
let previous='';
function go(path,{replace=false}={}){
 const h=String(path).startsWith('#')?String(path):'#'+path;
 if(framed()){replace=true;if(h!==location.hash)previous=location.hash}
 afterPop(()=>{if(replace||sheetOnTop()){put(h);apply()}else if(h===location.hash)apply();else location.hash=h}); // hashchange then applies it
}
// A person opened page `id` (a link, a row, ⌘K): push it so Back returns. A hidden page (Agent World, Chat…) is pushed with its own
// state, which is how apply() tells it from the alias a typed URL means. Opening one while a run is open closes the run first (apply does).
function open(id){
 const V=REG(),h='#'+id;
 if(V?.view(id)?.domain==='hidden'&&document.getElementById(id))afterPop(()=>{
  if(framed()&&location.hash!==h)previous=location.hash;
  if(location.hash!==h||history.state?.localaiPage!==id)history[sheetOnTop()||framed()?'replaceState':'pushState']({localaiPage:id},'',location.pathname+location.search+h);
  apply();
 });
 else go(h);
}
// Called by showView after it shows a page: keep the hash honest without adding history entries.
// Written after a closing sheet's back() lands, and only if no other page was shown meanwhile.
function shown(id){
 lastShown=id;
 if(!ready||applying)return;
 afterPop(()=>{
  if(lastShown!==id)return;
  const V=REG(),p=parse().page,hidden=V?.view(id)?.domain==='hidden';
  if(hidden?p!==id:p!==id&&V?.resolve(p)!==V?.resolve(id))put('#'+id,hidden?{localaiPage:id}:null);
 });
}
// app.js calls start() right after it publishes window.showView (which waits on the release config).
function start(){
 if(ready||typeof root.showView!=='function')return;
 ready=true;
 if(!location.hash)put('#home'); // otherwise honour the hash as it is now: a load-time one, or a tab tapped while the app was starting
 root.addEventListener('hashchange',apply);
 apply();
}
root.LocalAIRouter={go,open,shown,start,intentFor,previous:()=>previous,
 current:()=>parse(),
 onRun(fn){runHandlers.push(fn);if(ready&&runOpen)Promise.resolve().then(()=>fn(runOpen))}};
})(window);
