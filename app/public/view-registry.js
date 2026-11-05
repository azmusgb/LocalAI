// Single source of truth for navigation: every view's label, description, domain and section.
// The desktop rail, mobile sheet, breadcrumb, command palette and page headings all read from here.
// `aka` keeps old names searchable in the command palette after a rename.
// A view with `parent` is a tab of that page: it has no nav entry of its own and shows the parent's heading.
// `tab` is the label a page uses in its parent's tab strip (the parent's own tab included).
// A domain's `icon` and a view's `svg` name symbols in the index.html sprite; every menu draws them from here.
// `short` is a page's label in a page strip when its full one would push the strip past a phone's width.
// `tool` puts a card for the page on System › Tools (navigation update, 2 Nov: always shown, no switch). A System tool has
// no strip tab of its own: while it is open, the strip lights Tools. Architecture is also Improve's Atlas tab.
// `owner` is the area a hidden page lights while open, when its address must keep opening the page itself (no alias).
(function(root){'use strict';
const DOMAINS=[
 {id:'home',label:'Home',icon:'home',tagline:'What needs you',defaultView:'home'},
 {id:'work',label:'Work',icon:'work',tagline:'Everything running and done',defaultView:'work'},
 {id:'projects',label:'Projects',icon:'projects',tagline:'Make and keep things',defaultView:'projects'},
 {id:'improve',label:'Improve',icon:'improve',tagline:'Change the assistant itself',defaultView:'backlog'},
 {id:'system',label:'System',icon:'system',tagline:'Status and history',defaultView:'status'}
];
const VIEWS=[
 {id:'home',svg:'home',domain:'home',section:'Overview',label:'Home',description:'Start something, or pick up where you left off.',aka:['overview']},
 // One queue (D8): you decide approvals in Home › Needs you; the Inbox is the history (alerts and decisions). Old #approvals links open it.
 {id:'inbox',svg:'inbox',domain:'home',section:'Overview',label:'Inbox',description:'Alerts, approvals and what was decided.',aka:['notifications','alerts','approvals']},
 {id:'work',svg:'work',domain:'work',section:'Work',label:'Work',tab:'Work',description:'Everything running and done, in one place.',aka:['runs']},
 {id:'ask',svg:'compose',domain:'hidden',section:'Make',label:'Chat',description:'Private conversation with your local models.',aka:['ask','ask ai']},
 {id:'create',svg:'image',domain:'hidden',section:'Make',label:'Images',description:'Generate images with your local models.',aka:['create','create image']},
 {id:'projects',svg:'projects',domain:'projects',section:'Keep',label:'Projects',tab:'Projects',description:'Group related work with its own sources and memory.'},
 {id:'knowledge',svg:'sources',domain:'projects',section:'Keep',parent:'projects',tab:'Sources',label:'Sources',description:'Files and notes the assistant can search.',aka:['knowledge']},
 {id:'memory',svg:'memory',domain:'projects',section:'Keep',parent:'projects',tab:'Memory',label:'Memory',description:'Facts the assistant keeps about each project.',aka:['project memory']},
 // Library is a tab of Projects: what you kept, as opposed to Work (everything you did). Old #library links open it.
// Automations is a tab of Work (scheduled work): navigation spec, step 3. Projects holds only what you keep (2 Nov, D4).
 {id:'library',svg:'library',domain:'projects',section:'Keep',parent:'projects',tab:'Library',label:'Library',description:'What you kept: chats, research and images.',aka:['kept']},
 
 {id:'status',svg:'health',short:'Status',domain:'system',section:'Status',label:'Assistant status',description:'Whether Local AI is working, and which optional services are up.',aka:['status','assistant status','health']},
 {id:'models',svg:'model',domain:'system',section:'Status',label:'Models',description:"Installed models and what's loaded now."},
 {id:'integrations',svg:'plug',domain:'system',section:'Status',label:'Connections',description:'What Local AI connects to, and whether each one is ready.',aka:['integrations','services','bridges','tools']},
 // Agent World is a tab of Work (Pi Hub A7 plan, decision 9): Work · Agent World · Assistant automations. It has its own
 // address again (no alias), and titles itself Agent World: the mission is its faceplate, not its heading.
 {id:'agents',svg:'target',domain:'work',section:'Work',parent:'work',tab:'Agent World',label:'Agent World',description:'Give the team a goal; watch them work it.',aka:['agents','missions','mission','agent operations']},
 {id:'automationStudio',svg:'clock',domain:'work',section:'Work',parent:'work',tab:'Assistant automations',label:'Assistant automations',description:'Scheduled prompts and research, health checks and the morning brief.',aka:['studio','automation studio','monitors','morning brief','health check','assistant automations']},
 {id:'backlog',svg:'improve',domain:'improve',section:'Pipeline',label:'Backlog',description:'One ranked list of what could change in Local AI.',aka:['improve','ideas','priorities']},
 {id:'inProgress',svg:'build',short:'Doing',domain:'improve',section:'Pipeline',label:'In progress',description:'Changes being planned, tested or waiting for your OK.',aka:['running changes','change requests','changes','engineer']},
 {id:'shipped',svg:'check',domain:'improve',section:'Pipeline',label:'Shipped',description:'What changed, release by release.',aka:['done','released']},
 {id:'signals',svg:'alert',domain:'improve',section:'Pipeline',label:'Signals',description:'Problems Local AI noticed; serious ones join the Backlog.',aka:['detections','issues','quality signals']},
 // GridCraft on the Windows computer, through the appliance (spreadsheets.js). The old /gridcraft.html page sends you here.
 // A Work kind since 2 Nov (D4): the Spreadsheets chip in Work and the Spreadsheet mode on Home lead here.
 {id:'spreadsheets',svg:'file',domain:'hidden',owner:'work',section:'Make',label:'Spreadsheets',description:'Ask for a spreadsheet on the Windows computer to be checked or changed.',aka:['gridcraft','excel','workbook']},
 {id:'claude',svg:'sparkle',short:'Claude',domain:'improve',section:'Pipeline',label:'Claude Code',description:'Chat with your Claude Code sessions and watch them work.',aka:['claude']},
 {id:'architecture',svg:'flow',short:'Atlas',domain:'improve',section:'Pipeline',tool:true,label:'Architecture',description:'System Atlas: topology, changes, risk, evidence and local architecture intelligence.',aka:['atlas','system atlas','dependencies','architecture atlas']},
 {id:'workbench',svg:'folder',domain:'system',section:'Tools',tool:true,label:'Files',description:'Browse, search and safely edit mounted folders.',aka:['workbench','engineering workbench']},
 {id:'repoTools',svg:'branch',domain:'system',section:'Tools',tool:true,label:'Repository',description:'Inspect repos and run allow-listed commands.',aka:['repo tools','repository tools']},
 {id:'powershell',svg:'terminal',domain:'system',section:'Tools',tool:true,label:'PowerShell',description:'Approval-gated scripts on the Windows host.',aka:['powershell workbench']},
 {id:'actions',svg:'globe',domain:'system',section:'Tools',tool:true,label:'Browser & computer',description:'Fetch pages and run approved local actions.',aka:['actions','computer actions']},
 {id:'automations',svg:'flow',domain:'system',section:'Tools',tool:true,label:'n8n workflows',description:'Build advanced workflows in n8n.',aka:['workflows']},
 // Settings left Health (navigation update, 2 Nov): Health is only whether things work.
 {id:'tools',svg:'terminal',domain:'system',section:'Tools',label:'Tools',description:'Files, Repository, PowerShell, Browser & computer, n8n and the System Atlas.',aka:['developer tools','advanced','workbench']},
 {id:'settings',svg:'settings',domain:'system',section:'Settings',label:'Settings',description:'Notifications, sign-in and home location.',aka:['preferences','notifications','home location','sign-in']},
 {id:'activity',svg:'history',domain:'system',section:'History',label:'Audit log',description:'What happened on the appliance, and when.',aka:['activity']},
 {id:'runs',svg:'work',domain:'hidden',section:'History',label:'Runs',description:'Every run, live, with cancel and retry.'}
];
// Change requests, Issues and Quality signals are retired: Improve's stages show the same things (see ALIASES).
// Retired view ids and the page that replaced them.
// `runs`, `ask` and `create` keep their own hidden pages for code and ⌘K; a URL resolves them to the page that now owns them.
// Improve's four stages replaced Change requests, Issues and Quality signals: old links land on the stage that shows them.
// Monitors folded into Automations as its Health check and Morning brief kinds (D9).
// Deployments merged into Shipped (2 Nov): its Running now card is the release evidence.
const ALIASES={deployments:'shipped',approvals:'inbox',operations:'automationStudio',engineering:'inProgress',changes:'inProgress',issues:'signals',quality:'signals',runs:'work',ask:'home',create:'home'};
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
// The browser tab's title for a page (E8): "Work · Local AI"; a tab of a page by its tab label ("Library · Local AI").
function title(id){const v=view(id);if(!v||v.id==='home')return 'Local AI';return `${v.parent?(v.tab||v.label):v.label} · Local AI`}
// The pages System › Tools has a card for, in menu order: the System ones, then Architecture.
function tools(){return [...VIEWS.filter(v=>v.tool&&v.domain==='system'),...VIEWS.filter(v=>v.tool&&v.domain!=='system')]}
const api={DOMAINS,VIEWS,ALIASES,tools,resolve,view,page,tabs,sections,title,label:id=>byId.get(id)?.label||id,description:id=>byId.get(id)?.description||''};
if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalAIViews=api;
})(typeof window!=='undefined'?window:globalThis);

