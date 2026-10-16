// Hash router: #<page>[?query] opens a page, #run/<id> opens a run (handler registered with onRun).
// The router drives window.showView; showView calls from other code update the hash with replace semantics
// (replaceState fires no hashchange, so the two cannot loop and Back only follows go() / open() navigation).
// Anything the person does (a link, a button, a row) navigates with open(id) so Back returns; showView is for code.
(function(root){'use strict';
const INTENTS={ask:{mode:'ask'},create:{mode:'create'},agents:{kind:'missions'}};
const REG=()=>root.LocalAIViews,runHandlers=[];
let ready=false,applying=false,runOpen=null;
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
function go(path,{replace=false}={}){
 const h=String(path).startsWith('#')?String(path):'#'+path;
 if(replace||sheetOnTop()){put(h);apply()}else if(h===location.hash)apply();else location.hash=h; // hashchange then applies it
}
// A person opened page `id` (a link, a row, ⌘K): push it so Back returns. A hidden page (Agent World, Chat…) is pushed with its own
// state, which is how apply() tells it from the alias a typed URL means. Opening one while a run is open closes the run first (apply does).
function open(id){
 const V=REG(),h='#'+id;
 if(V?.view(id)?.domain==='hidden'&&document.getElementById(id)){
  if(location.hash!==h||history.state?.localaiPage!==id)history[sheetOnTop()?'replaceState':'pushState']({localaiPage:id},'',location.pathname+location.search+h);
  apply();
 }else go(h);
}
// Called by showView after it shows a page: keep the hash honest without adding history entries.
function shown(id){
 if(!ready||applying)return;
 const V=REG(),p=parse().page,hidden=V?.view(id)?.domain==='hidden';
 if(hidden?p!==id:p!==id&&V?.resolve(p)!==V?.resolve(id))put('#'+id,hidden?{localaiPage:id}:null);
}
// app.js calls start() right after it publishes window.showView (which waits on the release config).
function start(){
 if(ready||typeof root.showView!=='function')return;
 ready=true;
 if(!location.hash)put('#home'); // otherwise honour the hash as it is now: a load-time one, or a tab tapped while the app was starting
 root.addEventListener('hashchange',apply);
 apply();
}
root.LocalAIRouter={go,open,shown,start,intentFor,
 current:()=>parse(),
 onRun(fn){runHandlers.push(fn);if(ready&&runOpen)Promise.resolve().then(()=>fn(runOpen))}};
})(window);
