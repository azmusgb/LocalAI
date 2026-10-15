(()=>{'use strict';
// Domains, sections, labels and descriptions come from view-registry.js.
const REG=window.LocalAIViews;
const DOMAINS=REG.DOMAINS.map(d=>({...d,groups:REG.sections(d.id)}));
const DESCRIPTIONS=Object.fromEntries(REG.VIEWS.map(v=>[v.id,v.description]));
const q=(s,r=document)=>r.querySelector(s),qa=(s,r=document)=>[...r.querySelectorAll(s)];
let currentDomain='home',sheetOpen=false,allButtons=new Map();

function viewButton(view){return allButtons.get(view)||q('.navbtn[data-view="'+view+'"]')}
function domainForView(view){return DOMAINS.find(d=>d.groups.some(g=>g.views.includes(view)))||DOMAINS[0]}
function labelForView(view){return REG.view(view)?.label||viewButton(view)?.textContent?.trim()||view}
function activeView(){return q('.view.active')?.id||q('.navbtn.active')?.dataset.view||'home'}
function activateSyntheticView(view){
 const target=q('#'+view);if(!target)return false;
 qa('.view').forEach(v=>v.classList.toggle('active',v===target));
 qa('.navbtn[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
 window.scrollTo({top:0,behavior:'instant'});
 requestAnimationFrame(()=>sync(view));
 return true;
}
function navigate(view){
 const synthetic=viewButton(view)?.dataset.uxSynthetic==='true';
 if(synthetic&&activateSyntheticView(view))return;
 if(typeof window.showView==='function'){window.showView(view);requestAnimationFrame(()=>sync(view));return}
 const b=viewButton(view);if(b){b.click();requestAnimationFrame(()=>sync(view));return}
 if(activateSyntheticView(view))return;
 const target=q('#'+view);if(target){qa('.view').forEach(v=>v.classList.toggle('active',v===target));requestAnimationFrame(()=>sync(view))}
}

function buildIntegrationsView(){
 const main=q('main'),nav=q('.app>aside nav');if(!main||!nav)return;
 if(!q('#integrations')){
   const section=document.createElement('section');
   section.id='integrations';section.className='view';section.dataset.uxSynthetic='true';
   // Content and live status are owned by integration-hub-v2.js, which mounts into this section.
   main.appendChild(section);
 }
 if(!q('.navbtn[data-view="integrations"]',nav)){
   const b=document.createElement('button');b.type='button';b.className='navbtn';b.dataset.view='integrations';b.dataset.uxSynthetic='true';b.innerHTML='<span class="navicon">'+REG.view('integrations').icon+'</span>'+REG.label('integrations');
   b.addEventListener('click',e=>{e.preventDefault();activateSyntheticView('integrations')});
   nav.appendChild(b);
 }
}

function buildDesktopNav(){
 const aside=q('.app>aside'),nav=q('.app>aside nav');if(!aside||!nav)return;
 const originals=qa('.navbtn[data-view]',nav);allButtons=new Map(originals.map(b=>[b.dataset.view,b]));
 const registry=document.createElement('div');registry.id='uxNavRegistry';registry.hidden=true;originals.forEach(b=>registry.appendChild(b));aside.appendChild(registry);
 const shell=document.createElement('div');shell.className='ux-nav-shell';
 const rail=document.createElement('div');rail.className='ux-primary-rail';rail.setAttribute('aria-label','Primary navigation');
 const secondary=document.createElement('div');secondary.className='ux-secondary-nav';
 const secondaryHead=document.createElement('div');secondaryHead.className='ux-secondary-head';secondaryHead.innerHTML='<div><span class="ux-secondary-kicker">Navigate</span><strong id="uxSecondaryTitle">Home</strong><small id="uxSecondaryTagline"></small></div>';
 const groups=document.createElement('div');groups.className='ux-secondary-groups';groups.id='uxSecondaryGroups';
 secondary.append(secondaryHead,groups);
 DOMAINS.forEach(d=>{
   const b=document.createElement('button');b.type='button';b.className='ux-primary-item';b.dataset.domain=d.id;b.title=d.label;b.innerHTML='<span class="ux-primary-symbol">'+d.symbol+'</span><span>'+d.label+'</span>';
   b.addEventListener('click',()=>navigate(d.defaultView));
   rail.appendChild(b);
 });
 shell.append(rail,secondary);nav.replaceWith(shell);
 renderSecondary('home');
}
function renderSecondary(domainId){
 const d=DOMAINS.find(x=>x.id===domainId)||DOMAINS[0],holder=q('#uxSecondaryGroups'),registry=q('#uxNavRegistry');if(!holder)return;
 qa('.navbtn[data-view]',holder).forEach(b=>registry?.appendChild(b));
 q('#uxSecondaryTitle').textContent=d.label;q('#uxSecondaryTagline').textContent=d.tagline;
 holder.innerHTML='';
 d.groups.forEach(g=>{
   const section=document.createElement('section');section.className='ux-secondary-section';
   const h=document.createElement('div');h.className='ux-secondary-label';h.textContent=g.label;section.appendChild(h);
   g.views.forEach(v=>{const src=viewButton(v);if(!src)return;const b=src;b.classList.add('ux-secondary-link');b.innerHTML='<span class="ux-link-copy"><strong>'+labelForView(v)+'</strong><small>'+DESCRIPTIONS[v]+'</small></span><span class="ux-link-arrow">›</span>';section.appendChild(b)});
   holder.appendChild(section);
 });
}
function buildContext(){
 const main=q('main');if(!main||q('#uxContextBar'))return;
 const bar=document.createElement('header');bar.id='uxContextBar';bar.className='ux-context-bar';
 bar.innerHTML='<div class="ux-context-left"><button class="ux-breadcrumb-home" type="button" data-ux-go="home">Local AI</button><span class="ux-context-sep">/</span><span class="ux-context-domain" id="uxContextDomain">Home</span><span class="ux-context-sep">/</span><span class="ux-context-view" id="uxContextView">Overview</span></div><div class="ux-context-actions"><button class="ux-context-search" type="button" id="uxCommandBtn"><span>Search commands</span><kbd>⌘K</kbd></button><button class="ux-context-menu" id="uxContextMenu" type="button" aria-expanded="false">Menu</button></div>';
 main.prepend(bar);
 q('[data-ux-go="home"]')?.addEventListener('click',()=>navigate('home'));
 q('#uxCommandBtn')?.addEventListener('click',()=>{const cmd=q('#cmdk');if(cmd){cmd.classList.add('show');cmd.setAttribute('aria-hidden','false');q('#cmdkInput')?.focus()}});
 q('#uxContextMenu')?.addEventListener('click',()=>toggleSheet());
}
function buildMobile(){
 if(q('#uxMobileNav'))return;
 const nav=document.createElement('div');nav.id='uxMobileNav';nav.className='ux-mobile-nav';nav.setAttribute('role','navigation');nav.setAttribute('aria-label','Primary navigation');
 DOMAINS.forEach(d=>{const b=document.createElement('button');b.type='button';b.dataset.domain=d.id;b.innerHTML='<b>'+d.symbol+'</b><span>'+d.label+'</span>';b.addEventListener('click',()=>{toggleSheet(false);navigate(d.defaultView)});nav.appendChild(b)});
 const sheet=document.createElement('div');sheet.id='uxMobileSheet';sheet.className='ux-mobile-sheet';sheet.dataset.open='false';sheet.innerHTML='<div class="ux-mobile-sheet-handle"></div><div class="ux-mobile-sheet-head"><div><span class="ux-secondary-kicker">Navigate</span><strong id="uxMobileSheetTitle"></strong><small id="uxMobileSheetTagline"></small></div><button type="button" id="uxMobileSheetClose" aria-label="Close menu">×</button></div><div class="ux-mobile-sheet-items" id="uxMobileSheetItems"></div>';
 document.body.append(sheet,nav);q('#uxMobileSheetClose')?.addEventListener('click',()=>toggleSheet(false));
 document.addEventListener('click',e=>{if(sheetOpen&&!sheet.contains(e.target)&&!nav.contains(e.target)&&e.target.id!=='uxContextMenu')toggleSheet(false)});
}
function renderSheet(){
 const d=DOMAINS.find(x=>x.id===currentDomain)||DOMAINS[0],holder=q('#uxMobileSheetItems');if(!holder)return;
 q('#uxMobileSheetTitle').textContent=d.label;q('#uxMobileSheetTagline').textContent=d.tagline;holder.innerHTML='';
 d.groups.forEach(g=>{const section=document.createElement('section');section.className='ux-mobile-section';section.innerHTML='<div class="ux-mobile-section-label">'+g.label+'</div>';g.views.forEach(v=>{if(!viewButton(v))return;const b=document.createElement('button');b.type='button';b.className='ux-mobile-link '+(v===activeView()?'active':'');b.innerHTML='<span><strong>'+labelForView(v)+'</strong><small>'+DESCRIPTIONS[v]+'</small></span><span>›</span>';b.addEventListener('click',()=>{navigate(v);toggleSheet(false)});section.appendChild(b)});holder.appendChild(section)});
}
function toggleSheet(force){sheetOpen=typeof force==='boolean'?force:!sheetOpen;const s=q('#uxMobileSheet');if(s)s.dataset.open=String(sheetOpen);q('#uxContextMenu')?.setAttribute('aria-expanded',String(sheetOpen));document.body.classList.toggle('ux-sheet-open',sheetOpen);if(sheetOpen)renderSheet()}
function sync(forced){
 const view=forced||activeView(),d=domainForView(view);currentDomain=d.id;document.body.dataset.domain=d.id;document.body.dataset.view=view;
 const viewLabel=labelForView(view);q('#uxContextDomain').textContent=d.label;q('#uxContextView').textContent=viewLabel;q('#uxContextBar')?.classList.toggle('ux-context-same',viewLabel===d.label);
 qa('.ux-primary-item').forEach(b=>b.dataset.active=String(b.dataset.domain===d.id));
 qa('#uxMobileNav [data-domain]').forEach(b=>b.dataset.active=String(b.dataset.domain===d.id));
 if(q('#uxSecondaryTitle')?.textContent!==d.label)renderSecondary(d.id);
 qa('.ux-secondary-link').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
 if(sheetOpen)renderSheet();
}
function observeViews(){const views=qa('.view');if(!views.length)return;const mo=new MutationObserver(()=>sync());views.forEach(v=>mo.observe(v,{attributes:true,attributeFilter:['class']}));document.addEventListener('click',e=>{const b=e.target.closest?.('.navbtn[data-view]');if(b)requestAnimationFrame(()=>sync(b.dataset.view))})}
function init(){document.body.classList.add('ux-v3');buildIntegrationsView();buildDesktopNav();buildContext();buildMobile();observeViews();sync()}
if(document.readyState==='complete')init();else window.addEventListener('load',init,{once:true});
})();