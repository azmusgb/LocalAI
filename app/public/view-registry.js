// Single source of truth for navigation: every view's label, description, domain and section.
// The desktop rail, mobile sheet, breadcrumb, command palette and page headings all read from here.
// `aka` keeps old names searchable in the command palette after a rename.
// A view with `parent` is a tab of that page: it has no nav entry of its own and shows the parent's heading.
// `tab` is the label a page uses in its parent's tab strip (the parent's own tab included).
// A domain's `icon` and a view's `svg` name symbols in the index.html sprite; every menu draws them from here.
// `dev` marks a developer page: the rail, page strip, phone sheet and ⌘K leave it out while Developer tools (Health) is off.
// Its address still opens it, as Improve's pages do.
(function(root){'use strict';
const DOMAINS=[
 {id:'home',label:'Home',icon:'home',tagline:'What needs you',defaultView:'home'},
 {id:'work',label:'Work',icon:'work',tagline:'Everything running and done',defaultView:'work'},
 {id:'projects',label:'Projects',icon:'projects',tagline:'Make and keep things',defaultView:'projects'},
 {id:'improve',label:'Improve',icon:'improve',tagline:'Change Local AI itself',defaultView:'backlog'},
 {id:'system',label:'System',icon:'system',tagline:'Health and history',defaultView:'status'}
];
const VIEWS=[
 {id:'home',svg:'home',domain:'home',section:'Overview',label:'Home',description:'Start something, or pick up where you left off.',aka:['overview']},
 // One queue (D8): you decide approvals in Home › Needs you; the Inbox is the history (alerts and decisions). Old #approvals links open it.
 {id:'inbox',svg:'inbox',domain:'home',section:'Overview',label:'Inbox',description:'Alerts, approvals and what was decided.',aka:['notifications','alerts','approvals']},
 {id:'work',svg:'work',domain:'work',section:'Work',label:'Work',description:'Everything running and done, in one place.',aka:['runs','missions','agents']},
 {id:'ask',svg:'compose',domain:'hidden',section:'Make',label:'Chat',description:'Private conversation with your local models.',aka:['ask','ask ai']},
 {id:'create',svg:'image',domain:'hidden',section:'Make',label:'Images',description:'Generate images with your local models.',aka:['create','create image']},
 {id:'projects',svg:'projects',domain:'projects',section:'Keep',label:'Projects',tab:'Projects',description:'Group related work with its own sources and memory.'},
 {id:'knowledge',svg:'sources',domain:'projects',section:'Keep',parent:'projects',tab:'Sources',label:'Sources',description:'Files and notes the assistant can search.',aka:['knowledge']},
 {id:'memory',svg:'memory',domain:'projects',section:'Keep',parent:'projects',tab:'Memory',label:'Memory',description:'Facts the assistant keeps about each project.',aka:['project memory']},
 // Library is the last tab of Projects: what you kept, as opposed to Work (everything you did). Old #library links open it.
 {id:'library',svg:'library',domain:'projects',section:'Keep',parent:'projects',tab:'Everything you kept',label:'Library',description:'Everything you kept: chats, research and images.',aka:['everything you kept','kept']},
 {id:'agents',svg:'target',domain:'hidden',section:'Agents',label:'Missions',description:'Give a goal; specialist agents work it live.',aka:['agents','agent operations']},
 {id:'status',svg:'health',domain:'system',section:'Health',label:'Health',description:'Whether Local AI is working, and which optional services are up.',aka:['status','system status']},
 {id:'models',svg:'model',domain:'system',section:'Health',label:'Models',description:"Installed models and what's loaded now."},
 {id:'integrations',svg:'plug',domain:'system',section:'Health',label:'Services',description:'What Local AI connects to, and whether each one is ready.',aka:['integrations','bridges','tools']},
 {id:'automationStudio',svg:'clock',domain:'system',section:'Automations',label:'Automations',description:'Scheduled prompts and research, health checks and the morning brief.',aka:['studio','automation studio','monitors','morning brief','health check']},
 {id:'automations',svg:'flow',short:'n8n',domain:'system',section:'Automations',dev:true,label:'n8n workflows',description:'Build advanced workflows in n8n.',aka:['workflows']},
 {id:'actions',svg:'globe',short:'Browser',domain:'system',section:'Automations',dev:true,label:'Browser & computer',description:'Fetch pages and run approved local actions.',aka:['actions','computer actions']},
 {id:'backlog',svg:'improve',domain:'improve',section:'Pipeline',label:'Backlog',description:'One ranked list of what could change in Local AI.',aka:['improve','ideas','priorities']},
 {id:'inProgress',svg:'build',domain:'improve',section:'Pipeline',label:'In progress',description:'Changes being planned, tested or waiting for your OK.',aka:['running changes','change requests','changes','engineer']},
 {id:'shipped',svg:'check',domain:'improve',section:'Pipeline',label:'Shipped',description:'What changed, release by release.',aka:['done','released']},
 {id:'signals',svg:'alert',domain:'improve',section:'Pipeline',label:'Signals',description:'Problems Local AI noticed; serious ones join the Backlog.',aka:['detections','issues','quality signals']},
 // GridCraft on the Windows computer, through the appliance (spreadsheets.js). The old /gridcraft.html page sends you here.
 {id:'spreadsheets',svg:'file',domain:'system',section:'Tools',label:'Spreadsheets',description:'Ask for a spreadsheet on the Windows computer to be checked or changed.',aka:['gridcraft','excel','workbook']},
 {id:'claude',svg:'sparkle',domain:'system',section:'Tools',dev:true,label:'Claude Code',description:'Chat with your Claude Code sessions and watch them work.',aka:['claude']},
 {id:'workbench',svg:'folder',domain:'system',section:'Tools',dev:true,label:'Files',description:'Browse, search and safely edit mounted folders.',aka:['workbench','engineering workbench']},
 {id:'repoTools',svg:'branch',domain:'system',section:'Tools',dev:true,label:'Repository',description:'Inspect repos and run allow-listed commands.',aka:['repo tools','repository tools']},
 {id:'powershell',svg:'terminal',domain:'system',section:'Tools',dev:true,label:'PowerShell',description:'Approval-gated scripts on the Windows host.',aka:['powershell workbench']},
 {id:'activity',svg:'history',domain:'system',section:'History',label:'Audit log',description:'What happened on the appliance, and when.',aka:['activity']},
 {id:'runs',svg:'work',domain:'hidden',section:'History',label:'Runs',description:'Every run, live, with cancel and retry.'}
];
// Change requests, Issues and Quality signals are retired: Improve's stages show the same things (see ALIASES).
// Retired view ids and the page that replaced them.
// `runs`, `agents`, `ask` and `create` keep their own hidden pages for code and ⌘K; a URL resolves them to the page that now owns them.
// Improve's four stages replaced Change requests, Issues and Quality signals: old links land on the stage that shows them.
// Monitors folded into Automations as its Health check and Morning brief kinds (D9).
const ALIASES={approvals:'inbox',operations:'automationStudio',engineering:'inProgress',changes:'inProgress',issues:'signals',quality:'signals',runs:'work',agents:'work',ask:'home',create:'home'};
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
// The browser tab's title for a page (E8): "Work · Local AI"; a tab of a page by its tab label ("Everything you kept · Local AI").
function title(id){const v=view(id);if(!v||v.id==='home')return 'Local AI';return `${v.parent?(v.tab||v.label):v.label} · Local AI`}
const api={DOMAINS,VIEWS,ALIASES,resolve,view,page,tabs,sections,title,label:id=>byId.get(id)?.label||id,description:id=>byId.get(id)?.description||''};
if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalAIViews=api;
})(typeof window!=='undefined'?window:globalThis);
