// Hash router: #<page>[?query] opens a page, #run/<id> opens a run (handler registered with onRun).
// The router drives window.showView; showView calls from other code update the hash with replace semantics
// (replaceState fires no hashchange, so the two cannot loop and Back only follows go() navigation).
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
const put=(h,state=null)=>{if(location.hash!==h)history.replaceState(state,'',location.pathname+location.search+h)};
function notifyRun(id){if(id===runOpen)return;runOpen=id;runHandlers.forEach(fn=>{try{fn(id)}catch(e){console.error(e)}})}
// Show whatever the hash names.
function apply(){
 const cur=parse();
 if(cur.runId){notifyRun(cur.runId);return}
 notifyRun(null);
 const V=REG();if(!V||typeof root.showView!=='function')return;
 if(!V.view(cur.page)){put('#home');cur.page='home'}
 // A hidden page (Runs, Missions…) that showView put in history keeps its own page when Back returns to it; a typed #runs still means Work.
 if(history.state?.localaiPage===cur.page&&V.view(cur.page).domain==='hidden'&&document.getElementById(cur.page)){applying=true;try{root.showView(cur.page)}finally{applying=false}return}
 const target=V.resolve(cur.page),intent=INTENTS[cur.page];
 if(target!==cur.page||intent){ // an old id: rewrite the hash to the page that owns it, keeping what it meant
  const q=new URLSearchParams(cur.query);for(const [k,v] of Object.entries(intent||{}))if(!q.has(k))q.set(k,v);
  put('#'+target+(q.toString()?'?'+q:''));
 }
 applying=true;try{root.showView(target)}finally{applying=false}
}
function go(path,{replace=false}={}){
 const h=String(path).startsWith('#')?String(path):'#'+path;
 if(replace){put(h);apply()}else if(h===location.hash)apply();else location.hash=h; // hashchange then applies it
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
root.LocalAIRouter={go,shown,start,intentFor,
 current:()=>parse(),
 onRun(fn){runHandlers.push(fn);if(ready&&runOpen)Promise.resolve().then(()=>fn(runOpen))}};
})(window);
