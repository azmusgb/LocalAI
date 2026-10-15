(()=>{'use strict';
const DOMAINS=[
 {id:'home',label:'Home',symbol:'⌂',tagline:'Overview and attention',defaultView:'home',groups:[{label:'Overview',views:['home','inbox']}]},
 {id:'work',label:'Work',symbol:'✦',tagline:'Ask, create and automate',defaultView:'ask',groups:[{label:'AI workspace',views:['ask','create']},{label:'Automation',views:['automations','automationStudio','actions']}]},
 {id:'agents',label:'Agents',symbol:'◎',tagline:'Missions and controlled change',defaultView:'agents',groups:[{label:'Orchestration',views:['agents']},{label:'Engineering',views:['engineering','changes','approvals']}]},
 {id:'projects',label:'Projects',symbol:'▣',tagline:'Files, knowledge and memory',defaultView:'projects',groups:[{label:'Workspace',views:['projects','library']},{label:'Context',views:['knowledge','memory']}]},
 {id:'system',label:'System',symbol:'◉',tagline:'Health, history and developer tools',defaultView:'status',groups:[{label:'Operations',views:['status','operations','runs','activity','quality','issues']},{label:'Connections',views:['models','integrations']},{label:'Developer tools',views:['workbench','repoTools','powershell']}]}
];
const LABELS={home:'Overview',ask:'Ask AI',create:'Create',automations:'Automations',automationStudio:'Automation Studio',actions:'Computer Actions',agents:'Agent Operations',engineering:'Engineering Agent',changes:'Changes',approvals:'Approvals',projects:'Projects',library:'Library',knowledge:'Knowledge',memory:'Memory',status:'System Status',operations:'Operations',runs:'Runs',models:'Models',activity:'Activity',quality:'Quality',issues:'Issues',integrations:'Integrations',workbench:'Workbench',repoTools:'Repository Tools',powershell:'PowerShell',inbox:'Inbox'};
const DESCRIPTIONS={runs:'Execution history, live progress, cancel and retry.',models:'Installed and loaded local models.',home:'System overview, recent work and shortcuts.',ask:'Chat with your local models.',create:'Generate images and creative artifacts.',automations:'Review and run automations.',automationStudio:'Build appliance-native workflows.',actions:'Permissioned browser and computer actions.',agents:'Route missions and watch specialists work.',engineering:'Plan and validate bounded code changes.',changes:'Inspect staged changes and deployment state.',approvals:'Review human-gated actions.',projects:'Organize active project work.',library:'Browse generated and saved artifacts.',knowledge:'Index and search project source.',memory:'Inspect durable project context.',status:'Service health and appliance state.',operations:'Monitoring and operational briefs.',activity:'Audit what the appliance has been doing.',quality:'Static and runtime quality signals.',issues:'Actionable quality findings.',integrations:'Local-first tools, optional bridges, and cloud fallbacks.',workbench:'Inspect and edit mounted workspaces.',repoTools:'Repository inspection and commands.',powershell:'Approval-gated Windows execution.',inbox:'Notifications, approvals and alerts.'};
const q=(s,r=document)=>r.querySelector(s),qa=(s,r=document)=>[...r.querySelectorAll(s)];
let currentDomain='home',sheetOpen=false,allButtons=new Map(),integrationStatusLoaded=false;

const INTEGRATIONS=[
 {id:'n8n',name:'n8n',tier:'native',decision:'Keep native',source:'n8n',summary:'Primary workflow automation engine. It already fits Local AI better than Bardeen or Coze because it is self-hostable and already present in the appliance.',action:{type:'view',view:'automations',label:'Open automations'}},
 {id:'comfyui',name:'ComfyUI',tier:'native',decision:'Keep native',source:'comfy',summary:'Primary local generative-media backend. Use it as the host for image and video workflows instead of adding separate cloud generators.',action:{type:'view',view:'create',label:'Open Create'}},
 {id:'svd',name:'Stable Video Diffusion',tier:'extend',decision:'Add through ComfyUI',summary:'Useful for local image-to-video. Treat SVD as a ComfyUI workflow/model capability rather than a separate product integration.',action:{type:'view',view:'create',label:'Use Create'}},
 {id:'sadtalker',name:'SadTalker',tier:'extend',decision:'Add through ComfyUI',summary:'Useful only if talking-head/avatar output becomes a real workflow. Keep it modular and route it through the existing media backend.',action:{type:'view',view:'create',label:'Use Create'}},
 {id:'penpot',name:'Penpot',tier:'bridge',decision:'Recommended bridge',summary:'Best fit from the design tools shown: open-source UI/UX design, inspectable assets, and a cleaner handoff target for Local AI-generated interface work.',action:{type:'url',url:'https://penpot.app/',label:'Open Penpot'}},
 {id:'obsidian',name:'Obsidian',tier:'bridge',decision:'Recommended bridge',summary:'Strong local-first knowledge workspace. The useful integration is vault/folder ingestion into Projects and Knowledge—not replacing Local AI memory.',action:{type:'url',url:'https://obsidian.md/',label:'Open Obsidian'}},
 {id:'huggingface',name:'Hugging Face',tier:'bridge',decision:'Use as model source',summary:'Useful for model discovery and acquisition. Do not add Hugging Chat as another primary chat surface; Local AI already owns that experience.',action:{type:'url',url:'https://huggingface.co/models',label:'Browse models'}},
 {id:'photopea',name:'Photopea',tier:'utility',decision:'Useful external editor',summary:'Practical zero-install image editor for manual touch-up after local generation. Keep it as an external utility rather than a hard dependency.',action:{type:'url',url:'https://www.photopea.com/',label:'Open Photopea'}},
 {id:'languagetool',name:'LanguageTool',tier:'utility',decision:'Optional QA service',summary:'Worth adding only when deterministic grammar/style checking matters. Local models already cover ordinary writing assistance, so this stays optional.',action:{type:'url',url:'https://languagetool.org/',label:'Open LanguageTool'}}
];

const REVIEWED_ALTERNATIVES=[
 ['Gemini / Nano Banana / ImageFX / Google Flow','Cloud creative stack','Skip as core','Duplicates local model and ComfyUI capabilities and weakens the local-first boundary. Add a cloud adapter only for a concrete quality gap.'],
 ['DALL·E 3','Cloud image generation','Skip as core','Same reason: keep ComfyUI as the default media backend and expose cloud providers only as explicit opt-in fallbacks.'],
 ['Hugging Chat / Hugging Face Chat','Cloud chat frontend','Skip','Local AI already provides the chat/orchestration layer. Hugging Face is more valuable here as a model registry.'],
 ['Meta AI / You.com','Cloud assistants/search','Skip','They duplicate Ask/Research and would fragment history, routing, privacy, and capability state.'],
 ['LMArena / Chatbot Arena','Model comparison','Reference only','Useful for external model evaluation, but not an appliance runtime dependency.'],
 ['Coze / Bardeen','Cloud automation/agents','Skip','n8n plus Local AI agents already cover this space with better control and local deployment.'],
 ['Pixlr X / Lovart','Design/image tools','Skip','Photopea plus Penpot provides a simpler editor/design pair with less overlap.'],
 ['Laxis','Meeting notes','Skip for now','Meeting capture is outside the current Local AI core and would add a narrow cloud workflow.'],
 ['Google Slides','Presentations','Defer','Prefer a future artifact/export capability rather than coupling the appliance to one office suite.'],
 ['10Web','Website builder','Skip','Local AI engineering/workbench features are a better fit for code-backed site work.'],
 ['Icons8','Asset library','Reference only','Useful content source, not an integration. Keep it outside the runtime dependency graph.']
];

function viewButton(view){return allButtons.get(view)||q('.navbtn[data-view="'+view+'"]')}
function domainForView(view){return DOMAINS.find(d=>d.groups.some(g=>g.views.includes(view)))||DOMAINS[0]}
function labelForView(view){return LABELS[view]||viewButton(view)?.textContent?.trim()||view}
function activeView(){return q('.view.active')?.id||q('.navbtn.active')?.dataset.view||'home'}
function activateSyntheticView(view){
 const target=q('#'+view);if(!target)return false;
 qa('.view').forEach(v=>v.classList.toggle('active',v===target));
 qa('.navbtn[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
 if(view==='integrations')loadIntegrationStatus();
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

function integrationBadge(tier){
 const labels={native:'Native',extend:'Local extension',bridge:'Bridge',utility:'Utility'};
 return '<span class="ux-int-tier '+tier+'">'+(labels[tier]||tier)+'</span>';
}
function renderIntegrationCards(){
 const holder=q('#uxIntegrationCards');if(!holder)return;
 holder.innerHTML=INTEGRATIONS.map(item=>{
   const action=item.action.type==='url'
    ? '<a class="btn ux-int-action" href="'+item.action.url+'" target="_blank" rel="noopener noreferrer">'+item.action.label+' ↗</a>'
    : '<button class="btn ux-int-action" type="button" data-integration-view="'+item.action.view+'">'+item.action.label+'</button>';
   const live=item.source?'<span class="ux-int-live" data-integration-source="'+item.source+'"><span class="dot"></span> Checking</span>':'';
   return '<article class="ux-int-card" data-tier="'+item.tier+'"><div class="ux-int-card-head"><div><div class="ux-int-name">'+item.name+'</div><div class="ux-int-decision">'+item.decision+'</div></div>'+integrationBadge(item.tier)+'</div><p>'+item.summary+'</p><div class="ux-int-card-foot">'+live+action+'</div></article>';
 }).join('');
 qa('[data-integration-view]',holder).forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.integrationView)));
}
function renderReviewedAlternatives(){
 const holder=q('#uxIntegrationAlternatives');if(!holder)return;
 holder.innerHTML=REVIEWED_ALTERNATIVES.map(([name,type,decision,reason])=>
  '<div class="ux-int-row"><div><strong>'+name+'</strong><span>'+type+'</span></div><div class="ux-int-row-decision">'+decision+'</div><p>'+reason+'</p></div>'
 ).join('');
}
function updateIntegrationService(source,service){
 const el=q('[data-integration-source="'+source+'"]');if(!el)return;
 const state=service?.state||'UNKNOWN';
 const optional=service?.displayState==='OPTIONAL_OFFLINE';
 el.className='ux-int-live '+String(state).toLowerCase();
 el.innerHTML='<span class="dot '+(optional?'':state)+'"></span> '+(optional?'Optional offline':state==='HEALTHY'?'Healthy':state==='DOWN'?'Down':state==='DEGRADED'?'Degraded':'Unknown');
}
async function loadIntegrationStatus(force=false){
 if(integrationStatusLoaded&&!force)return;
 const summary=q('#uxIntegrationStatusSummary');
 if(summary)summary.textContent='Checking local services…';
 try{
   const responses=await Promise.allSettled([fetch('/api/status',{cache:'no-store'}),fetch('/api/capabilities',{cache:'no-store'})]);
   let status=null,capabilities=null;
   if(responses[0].status==='fulfilled'&&responses[0].value.ok)status=await responses[0].value.json();
   if(responses[1].status==='fulfilled'&&responses[1].value.ok)capabilities=await responses[1].value.json();
   const services=Array.isArray(status?.services)?status.services:[];
   updateIntegrationService('n8n',services.find(s=>s.name==='n8n'));
   updateIntegrationService('comfy',services.find(s=>s.name==='comfy'));
   const healthy=services.filter(s=>['n8n','comfy'].includes(s.name)&&s.state==='HEALTHY').length;
   const imageReady=capabilities?.images?.available===true;
   if(q('#uxIntegrationNativeCount'))q('#uxIntegrationNativeCount').textContent=healthy+'/2';
   if(q('#uxIntegrationMediaState'))q('#uxIntegrationMediaState').textContent=imageReady?'Ready':'Check models';
   if(summary)summary.textContent=healthy===2?'Core local integrations are healthy.':'One or more core local integrations needs attention.';
   integrationStatusLoaded=true;
 }catch(err){
   if(summary)summary.textContent='Could not read live integration status.';
 }
}
function buildIntegrationsView(){
 const main=q('main'),nav=q('.app>aside nav');if(!main||!nav)return;
 if(!q('#integrations')){
   const section=document.createElement('section');
   section.id='integrations';section.className='view';section.dataset.uxSynthetic='true';
   section.innerHTML=
   '<div class="topbar"><div><h1>Integrations</h1><p class="sub">A local-first integration policy for the tools reviewed from your screenshots. Keep the appliance coherent: native services first, explicit bridges second, cloud fallbacks only when they solve a measured gap.</p></div><button class="btn" type="button" id="uxIntegrationRefresh">Refresh status</button></div>'+ 
   '<div class="ux-int-hero"><div><span class="eyebrow">Recommended architecture</span><h2>Extend what Local AI already owns instead of collecting parallel AI apps.</h2><p id="uxIntegrationStatusSummary">Checking local services…</p></div><div class="ux-int-metrics"><div><b id="uxIntegrationNativeCount">—</b><span>native services healthy</span></div><div><b id="uxIntegrationMediaState">—</b><span>local media capability</span></div><div><b>Local-first</b><span>default trust boundary</span></div></div></div>'+ 
   '<div class="section-head ux-int-section-head"><div><h2>Implement / keep</h2><p>These are the tools that materially improve this repository without turning it into a portal of duplicate services.</p></div></div><div id="uxIntegrationCards" class="ux-int-grid"></div>'+ 
   '<div class="card ux-int-policy"><div><div class="eyebrow">Integration rules</div><h2>What gets into the core</h2></div><div class="ux-int-policy-grid"><div><strong>1. Native before cloud</strong><span>Ollama, n8n and ComfyUI remain the default execution path.</span></div><div><strong>2. One owner per capability</strong><span>Do not add another primary chat, automation, or image surface that fragments state.</span></div><div><strong>3. Bridges must earn persistence</strong><span>Penpot, Obsidian and similar tools should exchange durable artifacts, not just open another tab.</span></div><div><strong>4. Cloud is an explicit fallback</strong><span>Only add provider credentials after a concrete quality or capability gap is documented.</span></div></div></div>'+ 
   '<div class="section-head ux-int-section-head"><div><h2>Reviewed, not integrated</h2><p>These can still be useful independently, but they do not belong in the core Local AI dependency graph today.</p></div></div><div id="uxIntegrationAlternatives" class="ux-int-table"></div>';
   main.appendChild(section);
   q('#uxIntegrationRefresh')?.addEventListener('click',()=>{integrationStatusLoaded=false;loadIntegrationStatus(true)});
 }
 if(!q('.navbtn[data-view="integrations"]',nav)){
   const b=document.createElement('button');b.type='button';b.className='navbtn';b.dataset.view='integrations';b.dataset.uxSynthetic='true';b.innerHTML='<span class="navicon">↔</span>Integrations';
   b.addEventListener('click',e=>{e.preventDefault();activateSyntheticView('integrations')});
   nav.appendChild(b);
 }
 renderIntegrationCards();
 renderReviewedAlternatives();
}

function buildDesktopNav(){
 const aside=q('.app>aside'),nav=q('.app>aside nav');if(!aside||!nav)return;
 const originals=qa('.navbtn[data-view]',nav);allButtons=new Map(originals.map(b=>[b.dataset.view,b]));
 const registry=document.createElement('div');registry.id='uxNavRegistry';registry.hidden=true;originals.forEach(b=>registry.appendChild(b));aside.appendChild(registry);
 const shell=document.createElement('div');shell.className='ux-nav-shell';
 const rail=document.createElement('div');rail.className='ux-primary-rail';rail.setAttribute('aria-label','Primary navigation');
 const secondary=document.createElement('div');secondary.className='ux-secondary-nav';
 const secondaryHead=document.createElement('div');secondaryHead.className='ux-secondary-head';secondaryHead.innerHTML='<div><span class="ux-secondary-kicker">Workspace</span><strong id="uxSecondaryTitle">Home</strong><small id="uxSecondaryTagline"></small></div>';
 const groups=document.createElement('div');groups.className='ux-secondary-groups';groups.id='uxSecondaryGroups';
 secondary.append(secondaryHead,groups);
 DOMAINS.forEach(d=>{
   const b=document.createElement('button');b.type='button';b.className='ux-primary-item';b.dataset.domain=d.id;b.title=d.label;b.innerHTML='<span class="ux-primary-symbol">'+d.symbol+'</span><span>'+d.label+'</span>';
   b.addEventListener('click',()=>{const view=activeView(),activeDomain=domainForView(view).id;if(activeDomain===d.id)navigate(d.defaultView);else navigate(d.defaultView)});
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
 q('#uxContextDomain').textContent=d.label;q('#uxContextView').textContent=labelForView(view);
 qa('.ux-primary-item').forEach(b=>b.dataset.active=String(b.dataset.domain===d.id));
 qa('#uxMobileNav [data-domain]').forEach(b=>b.dataset.active=String(b.dataset.domain===d.id));
 if(q('#uxSecondaryTitle')?.textContent!==d.label)renderSecondary(d.id);
 qa('.ux-secondary-link').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
 if(sheetOpen)renderSheet();
}
function observeViews(){const views=qa('.view');if(!views.length)return;const mo=new MutationObserver(()=>sync());views.forEach(v=>mo.observe(v,{attributes:true,attributeFilter:['class']}));document.addEventListener('click',e=>{const b=e.target.closest?.('.navbtn[data-view]');if(b)requestAnimationFrame(()=>sync(b.dataset.view))})}
function polishAgentWorld(){const apply=()=>{const root=q('#agentWorldGameV6');if(!root)return false;const sub=q('.awg6__sub',root);if(sub)sub.textContent='Live agent execution and engineering operations';return true};if(apply())return;const mo=new MutationObserver(()=>{if(apply())mo.disconnect()});mo.observe(document.body,{childList:true,subtree:true})}
function init(){document.body.classList.add('ux-v3');buildIntegrationsView();buildDesktopNav();buildContext();buildMobile();observeViews();polishAgentWorld();sync()}
if(document.readyState==='complete')init();else window.addEventListener('load',init,{once:true});
})();