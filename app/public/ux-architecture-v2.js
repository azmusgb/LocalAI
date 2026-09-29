(()=>{'use strict';
const DOMAINS=[
 {id:'home',label:'Home',symbol:'⌂',defaultView:'home',views:['home','inbox']},
 {id:'work',label:'Work',symbol:'W',defaultView:'ask',views:['ask','create','engineering','automationStudio','actions','workbench','repoTools']},
 {id:'agents',label:'Agents',symbol:'A',defaultView:'agents',views:['agents','automations']},
 {id:'projects',label:'Projects',symbol:'P',defaultView:'projects',views:['projects','library','knowledge','memory']},
 {id:'system',label:'System',symbol:'S',defaultView:'status',views:['status','operations','activity','changes','approvals','quality','issues','powershell']}
];
const LABELS={automationStudio:'Studio',repoTools:'Repo Tools',powershell:'PowerShell'};
const q=(s,r=document)=>r.querySelector(s),qa=(s,r=document)=>[...r.querySelectorAll(s)];
let currentDomain='home',sheetOpen=false;

function viewButton(view){return q('.navbtn[data-view="'+view+'"]')}
function domainForView(view){return DOMAINS.find(d=>d.views.includes(view))||DOMAINS[0]}
function labelForView(view){const b=viewButton(view);return LABELS[view]||b?.textContent?.trim()||view}
function activeView(){return q('.view.active')?.id||q('.navbtn.active')?.dataset.view||'home'}
function navigate(view){const b=viewButton(view);if(b){b.click();setTimeout(()=>sync(view),0)}}
function buildDesktopNav(){
 const nav=q('.app>aside nav');if(!nav)return;
 const buttons=qa('.navbtn[data-view]',nav);
 const byView=new Map(buttons.map(b=>[b.dataset.view,b]));
 nav.innerHTML='';
 DOMAINS.forEach(d=>{
   const group=document.createElement('section');group.className='ux-domain-group';group.dataset.domain=d.id;
   const head=document.createElement('button');head.type='button';head.className='ux-domain-head';head.innerHTML='<span class="ux-domain-symbol">'+d.symbol+'</span><span>'+d.label+'</span><span class="ux-domain-caret">›</span>';
   const items=document.createElement('div');items.className='ux-domain-items';
   d.views.forEach(v=>{const b=byView.get(v);if(b)items.appendChild(b)});
   head.addEventListener('click',()=>{const isOpen=group.dataset.open==='true';qa('.ux-domain-group',nav).forEach(g=>g.dataset.open='false');group.dataset.open=String(!isOpen);if(!isOpen&&domainForView(activeView()).id!==d.id)navigate(d.defaultView)});
   group.append(head,items);nav.appendChild(group);
 });
}
function buildContext(){
 const main=q('main');if(!main||q('#uxContextBar'))return;
 const bar=document.createElement('header');bar.id='uxContextBar';bar.className='ux-context-bar';
 bar.innerHTML='<div class="ux-context-left"><span class="ux-context-domain" id="uxContextDomain">Home</span><span class="ux-context-sep">/</span><span class="ux-context-view" id="uxContextView">Home</span></div><div class="ux-context-actions"><span class="ux-keyhint">⌘ K&nbsp; Command</span><button class="ux-context-menu" id="uxContextMenu" type="button" aria-expanded="false">Sections</button></div>';
 main.prepend(bar);q('#uxContextMenu')?.addEventListener('click',()=>toggleSheet());
}
function buildMobile(){
 if(q('#uxMobileNav'))return;
 const nav=document.createElement('nav');nav.id='uxMobileNav';nav.className='ux-mobile-nav';nav.setAttribute('aria-label','Primary');
 DOMAINS.forEach(d=>{const b=document.createElement('button');b.type='button';b.dataset.domain=d.id;b.innerHTML='<b>'+d.symbol+'</b><span>'+d.label+'</span>';b.addEventListener('click',()=>{if(currentDomain===d.id)toggleSheet();else{sheetOpen=false;navigate(d.defaultView)}});nav.appendChild(b)});
 const sheet=document.createElement('div');sheet.id='uxMobileSheet';sheet.className='ux-mobile-sheet';sheet.dataset.open='false';sheet.innerHTML='<div class="ux-mobile-sheet-title" id="uxMobileSheetTitle"></div><div class="ux-mobile-sheet-items" id="uxMobileSheetItems"></div>';
 document.body.append(sheet,nav);
 document.addEventListener('click',e=>{if(sheetOpen&&!sheet.contains(e.target)&&!nav.contains(e.target)&&e.target.id!=='uxContextMenu')toggleSheet(false)});
}
function renderSheet(){
 const d=DOMAINS.find(x=>x.id===currentDomain)||DOMAINS[0],holder=q('#uxMobileSheetItems');if(!holder)return;
 q('#uxMobileSheetTitle').textContent=d.label;
 holder.innerHTML='';
 d.views.forEach(v=>{const original=viewButton(v);if(!original)return;const b=document.createElement('button');b.type='button';b.textContent=labelForView(v);b.className=v===activeView()?'active':'';b.addEventListener('click',()=>{navigate(v);toggleSheet(false)});holder.appendChild(b)});
}
function toggleSheet(force){sheetOpen=typeof force==='boolean'?force:!sheetOpen;const s=q('#uxMobileSheet');if(s)s.dataset.open=String(sheetOpen);const b=q('#uxContextMenu');if(b)b.setAttribute('aria-expanded',String(sheetOpen));if(sheetOpen)renderSheet()}
function sync(forced){
 const view=forced||activeView(),d=domainForView(view);currentDomain=d.id;
 document.body.dataset.domain=d.id;document.body.dataset.view=view;
 const main=q('main');if(main)main.dataset.domain=d.id;
 const cd=q('#uxContextDomain'),cv=q('#uxContextView');if(cd)cd.textContent=d.label;if(cv)cv.textContent=labelForView(view);
 qa('.ux-domain-group').forEach(g=>{const active=g.dataset.domain===d.id;g.dataset.active=String(active);g.dataset.open=String(active)});
 qa('#uxMobileNav [data-domain]').forEach(b=>b.dataset.active=String(b.dataset.domain===d.id));
 if(sheetOpen)renderSheet();
}
function observeViews(){
 const views=qa('.view');if(!views.length)return;
 const mo=new MutationObserver(()=>sync());views.forEach(v=>mo.observe(v,{attributes:true,attributeFilter:['class']}));
 document.addEventListener('click',e=>{const b=e.target.closest?.('.navbtn[data-view]');if(b)setTimeout(()=>sync(b.dataset.view),0)});
}
function polishAgentWorld(){
 const apply=()=>{const root=q('#agentWorldGameV6');if(!root)return false;const sub=q('.awg6__sub',root);if(sub)sub.textContent='Live agent execution and engineering operations';return true};
 if(apply())return;const mo=new MutationObserver(()=>{if(apply())mo.disconnect()});mo.observe(document.body,{childList:true,subtree:true});
}
function init(){
 document.body.classList.add('ux-v2');
 buildDesktopNav();buildContext();buildMobile();observeViews();polishAgentWorld();sync();
}
if(document.readyState==='complete')init();else window.addEventListener('load',init,{once:true});
})();