// Single source of truth for navigation: every view's label, description, domain and section.
// The desktop rail, mobile sheet, breadcrumb, command palette and page headings all read from here.
// `aka` keeps old names searchable in the command palette after a rename.
// A view with `parent` is a tab of that page: it has no nav entry of its own and shows the parent's heading.
// `tab` is the label a page uses in its parent's tab strip (the parent's own tab included).
// A domain's `icon` and a view's `svg` name symbols in the index.html sprite; every menu draws them from here.
(function(root){'use strict';
const DOMAINS=[
 {id:'home',label:'Home',symbol:'⌂',icon:'home',tagline:'What needs you',defaultView:'home'},
 {id:'work',label:'Work',symbol:'≡',icon:'work',tagline:'Everything running and done',defaultView:'work'},
 {id:'projects',label:'Projects',symbol:'▣',icon:'projects',tagline:'Make and keep things',defaultView:'projects'},
 {id:'improve',label:'Improve',symbol:'Δ',icon:'improve',tagline:'Change Local AI itself',defaultView:'backlog'},
 {id:'system',label:'System',symbol:'◉',icon:'system',tagline:'Health and history',defaultView:'status'}
];
const VIEWS=[
 {id:'home',svg:'home',domain:'home',section:'Overview',icon:'⌂',label:'Home',description:'Start something, or pick up where you left off.',aka:['overview']},
 {id:'inbox',svg:'inbox',domain:'home',section:'Overview',icon:'!',label:'Inbox',tab:'Alerts',description:'Alerts and anything waiting on you.',aka:['notifications','alerts']},
 {id:'approvals',svg:'approve',domain:'home',section:'Overview',parent:'inbox',tab:'Approvals',icon:'✓',label:'Approvals',description:'Actions held until you approve them.'},
 {id:'work',svg:'work',domain:'work',section:'Work',icon:'≡',label:'Work',description:'Everything running and done, in one place.',aka:['runs','missions','agents']},
 {id:'ask',svg:'compose',domain:'hidden',section:'Make',icon:'✦',label:'Chat',description:'Private conversation with your local models.',aka:['ask','ask ai']},
 {id:'create',svg:'image',domain:'hidden',section:'Make',icon:'◇',label:'Images',description:'Generate images with your local models.',aka:['create','create image']},
 {id:'projects',svg:'projects',domain:'projects',section:'Keep',icon:'▣',label:'Projects',tab:'Projects',description:'Group related work with its own sources and memory.'},
 {id:'knowledge',svg:'sources',domain:'projects',section:'Keep',parent:'projects',tab:'Sources',icon:'◫',label:'Sources',description:'Files and notes the assistant can search.',aka:['knowledge']},
 {id:'memory',svg:'memory',domain:'projects',section:'Keep',parent:'projects',tab:'Memory',icon:'M',label:'Memory',description:'Facts the assistant keeps about each project.',aka:['project memory']},
 // Library is the last tab of Projects: what you kept, as opposed to Work (everything you did). Old #library links open it.
 {id:'library',svg:'library',domain:'projects',section:'Keep',parent:'projects',tab:'Everything you kept',icon:'▦',label:'Library',description:'Everything you kept: chats, research and images.',aka:['everything you kept','kept']},
 {id:'agents',svg:'target',domain:'hidden',section:'Agents',icon:'◎',label:'Missions',description:'Give a goal; specialist agents work it live.',aka:['agents','agent operations']},
 {id:'status',svg:'health',domain:'system',section:'Health',icon:'●',label:'Health',description:'Core services and optional companions.',aka:['status','system status']},
 {id:'models',svg:'model',domain:'system',section:'Health',icon:'M',label:'Models',description:"Installed models and what's loaded now."},
 {id:'integrations',svg:'plug',domain:'system',section:'Health',icon:'↔',label:'Integrations',description:'Local tools, host bridges and cloud fallbacks.'},
 {id:'automationStudio',svg:'clock',domain:'system',section:'Automations',icon:'⌘',label:'Automations',description:'Scheduled prompts, research and health checks.',aka:['studio','automation studio']},
 {id:'automations',svg:'flow',short:'n8n',domain:'system',section:'Automations',icon:'↗',label:'n8n workflows',description:'Build advanced workflows in n8n.',aka:['workflows']},
 {id:'actions',svg:'globe',short:'Browser',domain:'system',section:'Automations',icon:'↗',label:'Browser & computer',description:'Fetch pages and run approved local actions.',aka:['actions','computer actions']},
 {id:'operations',svg:'eye',domain:'system',section:'Automations',icon:'◉',label:'Monitors',description:'Recurring health checks and the morning brief.',aka:['operations','morning brief']},
 {id:'backlog',svg:'improve',domain:'improve',section:'Pipeline',icon:'Δ',label:'Backlog',description:'One ranked list of what could change in Local AI.',aka:['improve','ideas','priorities']},
 {id:'inProgress',svg:'build',domain:'improve',section:'Pipeline',icon:'▶',label:'In progress',description:'Changes being planned, tested or waiting for your OK.',aka:['running changes']},
 {id:'shipped',svg:'check',domain:'improve',section:'Pipeline',icon:'✓',label:'Shipped',description:'What changed, release by release.',aka:['done','released']},
 {id:'signals',svg:'alert',domain:'improve',section:'Pipeline',icon:'!',label:'Signals',description:'Problems Local AI noticed; serious ones join the Backlog.',aka:['detections']},
 {id:'changes',svg:'build',short:'Changes',domain:'hidden',section:'Changes',icon:'Δ',label:'Change requests',description:"Describe a change; it's planned, tested and held for approval.",aka:['changes','change intelligence','engineer','engineering agent']},
 {id:'issues',svg:'alert',domain:'hidden',section:'Changes',icon:'!',label:'Issues',tab:'Issues',description:'Problems found in Local AI, deduplicated.'},
 {id:'quality',svg:'gauge',domain:'hidden',section:'Changes',parent:'issues',tab:'Quality signals',icon:'Q',label:'Quality signals',description:'Static checks, browser errors and regressions.',aka:['quality','quality intelligence']},
 {id:'claude',svg:'sparkle',domain:'system',section:'Tools',icon:'✳',label:'Claude Code',description:'Chat with your Claude Code sessions and watch them work.',aka:['claude']},
 {id:'workbench',svg:'folder',domain:'system',section:'Tools',icon:'W',label:'Files',description:'Browse, search and safely edit mounted folders.',aka:['workbench','engineering workbench']},
 {id:'repoTools',svg:'branch',domain:'system',section:'Tools',icon:'R',label:'Repository',description:'Inspect repos and run allow-listed commands.',aka:['repo tools','repository tools']},
 {id:'powershell',svg:'terminal',domain:'system',section:'Tools',icon:'PS',label:'PowerShell',description:'Approval-gated scripts on the Windows host.',aka:['powershell workbench']},
 {id:'activity',svg:'history',domain:'system',section:'History',icon:'◷',label:'Audit log',description:'What happened on the appliance, and when.',aka:['activity']},
 {id:'runs',svg:'work',domain:'hidden',section:'History',icon:'▶',label:'Runs',description:'Every execution, live, with cancel and retry.'}
];
// Issues, Quality signals and Change requests are hidden: Improve's stages show the same things (see ALIASES).
// Retired view ids and the page that replaced them.
// `runs`, `agents`, `ask` and `create` keep their own hidden pages for code and ⌘K; a URL resolves them to the page that now owns them.
// Improve's four stages replaced Change requests, Issues and Quality signals: old links land on the stage that shows them.
// The pages stay (hidden) so in-app links and their element ids keep working.
const ALIASES={engineering:'inProgress',changes:'inProgress',issues:'signals',quality:'signals',runs:'work',agents:'work',ask:'home',create:'home'};
const byId=new Map(VIEWS.map(v=>[v.id,v]));
function resolve(id){return ALIASES[id]||id}
// A view that still has its own page (hidden ones) wins over its alias.
function view(id){return byId.get(id)||byId.get(resolve(id))||null}
// The page a view lives on: itself, or its parent when it is a tab.
function page(id){const v=view(id);return v?.parent?view(v.parent):v}
function tabs(id){const p=page(id);if(!p)return [];const kids=VIEWS.filter(v=>v.parent===p.id);return kids.length?[p,...kids]:[]}
function sections(domainId){
 const out=[];
 for(const v of VIEWS){if(v.domain!==domainId||v.parent)continue;let s=out.find(x=>x.label===v.section);if(!s){s={label:v.section,views:[]};out.push(s)}s.views.push(v.id)}
 return out;
}
const api={DOMAINS,VIEWS,ALIASES,resolve,view,page,tabs,sections,label:id=>byId.get(id)?.label||id,description:id=>byId.get(id)?.description||''};
if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalAIViews=api;
})(typeof window!=='undefined'?window:globalThis);
