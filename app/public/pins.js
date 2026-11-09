// Pinned pages (navigation depth, D2): up to four pages the owner keeps one click from Home, Home's "Pinned" row and
// the ⌘K palette's first group. The server holds the list (GET/PUT /api/nav/pins, app/server/nav-pins.js), so every
// device shows the same pins; nothing is cached in the browser. This file is also required by the server, which applies
// the same rules (known pages only, no repeats, at most four).
(function(root){'use strict';
const MAX=4;
// eslint-disable-next-line no-undef -- the server's CommonJS require; the browser has root.LocalAIViews
const views=()=>root.LocalAIViews||(typeof require==='function'?require('./view-registry'):null);
// A page can be pinned when it has a menu entry or an owner area (the pages ⌘K lists), and is not Home.
function pinnable(id){const v=views()?.VIEWS.find(x=>x.id===id);return !!v&&v.id!=='home'&&(v.domain!=='hidden'||!!v.owner)}
// Known ids in order, repeats dropped. `tooMany` says the cleaned list is longer than MAX (the caller refuses it).
function clean(list){
 const ids=[];for(const id of Array.isArray(list)?list:[])if(typeof id==='string'&&!ids.includes(id)&&pinnable(id))ids.push(id);
 return{ids:ids.slice(0,MAX),tooMany:ids.length>MAX};
}
const api={MAX,pinnable,clean};
if(typeof module==='object'&&module.exports){module.exports=api;return}
if(!root.document)return;

// ---- browser: one shared list ----
let ids=[],loading=null;const subs=new Set();
const emit=()=>subs.forEach(fn=>{try{fn(ids)}catch(e){console.error(e)}});
async function call(options){
 const r=await fetch('/api/nav/pins',{cache:'no-store',...options});
 const j=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(j.error||`The pins were not saved (${r.status}).`);
 return clean(j.ids).ids;
}
// Reads the list from the server (on start, and when the tab comes back: another device may have changed it).
function load(){
 if(!loading)loading=call().then(next=>{ids=next;emit();return ids}).catch(()=>ids).finally(()=>{loading=null});
 return loading;
}
// Saves `next` and shows it only once the server has it; a failure leaves the old list and throws the reason.
async function save(next){ids=await call({method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:next})});emit();return ids}
async function toggle(id){
 if(ids.includes(id))return save(ids.filter(x=>x!==id));
 if(ids.length>=MAX)throw Object.assign(new Error(`${MAX} pages are pinned. Unpin one to make room.`),{limit:true});
 return save([...ids,id]);
}
root.LocalAIPins={MAX,pinnable,list:()=>ids.slice(),has:id=>ids.includes(id),load,toggle,subscribe(fn){subs.add(fn);return()=>subs.delete(fn)}};

// ---- the Pin button in every page heading ----
// One control that follows the open page: it goes in the heading's tool slot (.ui-page__tool, made if the heading has
// none), beside any tool already there, and its message sits under the heading.
let busy=false,note='';
const openId=()=>document.body.dataset.view||'';
function headOf(id){return document.querySelector(`#${CSS.escape(id)}.view.active>:is(.ui-page__head,.topbar)`)}
function paintHead(){
 for(const b of document.querySelectorAll('[data-pin-toggle]'))if(b.dataset.pinToggle!==openId()||!pinnable(openId())){const slot=b.closest('.pin-tool');b.remove();if(slot&&!slot.children.length)slot.remove()}
 document.querySelectorAll('[data-pin-note]').forEach(n=>{if(n.dataset.pinNote!==openId())n.remove()});
 const id=openId(),head=pinnable(id)?headOf(id):null;if(!head)return;
 let b=head.querySelector('[data-pin-toggle]');
 if(!b){
  let slot=head.querySelector('.ui-page__tool');
  if(!slot){
   // An older heading (.topbar) keeps its tool as the last child; the slot takes that tool in, so the two sit together.
   slot=document.createElement('div');slot.className='ui-page__tool pin-tool';
   const tool=head.children.length>1?head.lastElementChild:null;
   if(tool){tool.replaceWith(slot);slot.append(tool)}else head.append(slot);
  }
  b=document.createElement('button');b.type='button';b.className='btn-outline pin-toggle';b.dataset.pinToggle=id;
  b.innerHTML='<svg class="icon" aria-hidden="true"><use href="#i-pin"/></svg><span>Pin</span>';
  b.addEventListener('click',press);slot.prepend(b);
 }
 const on=root.LocalAIPins.has(id);
 b.setAttribute('aria-pressed',String(on));b.title=on?'Unpin from Home':'Pin to Home';
 b.setAttribute('aria-disabled',String(busy));
 let n=head.parentElement.querySelector('[data-pin-note]');
 if(note){if(!n){n=document.createElement('p');n.dataset.pinNote=id;n.className='pin-note';n.setAttribute('role','status');head.after(n)}n.textContent=note}
 else n?.remove();
}
async function press(e){
 const id=e.currentTarget.dataset.pinToggle;if(busy)return;
 busy=true;note='';paintHead();
 try{await root.LocalAIPins.toggle(id)}
 catch(err){note=err.limit?err.message:`Couldn't save your pins. ${err.message||'Try again.'}`}
 finally{busy=false;paintHead()}
}
function start(){
 subs.add(paintHead);
 new MutationObserver(()=>{note='';paintHead()}).observe(document.body,{attributes:true,attributeFilter:['data-view']});
 // A heading drawn after the page opened (Connections draws its own) still gets the button.
 let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;const id=openId();if(pinnable(id)&&headOf(id)&&!headOf(id).querySelector('[data-pin-toggle]'))paintHead()})}).observe(document.querySelector('main')||document.body,{childList:true,subtree:true});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});
 paintHead();load();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})(typeof window!=='undefined'?window:globalThis);
