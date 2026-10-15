// Single source of truth for navigation: every view's label, description, domain and section.
// The desktop rail, mobile sheet, breadcrumb, command palette and page headings all read from here.
// `aka` keeps old names searchable in the command palette after a rename.
// A view with `parent` is a tab of that page: it has no nav entry of its own and shows the parent's heading.
// `tab` is the label a page uses in its parent's tab strip (the parent's own tab included).
// A domain's `icon` names its symbol in the index.html sprite; the phone tab bar reads it from here.
(function(root){'use strict';
const DOMAINS=[
 {id:'home',label:'Home',symbol:'⌂',icon:'home',tagline:'What needs you',defaultView:'home'},
 {id:'work',label:'Work',symbol:'≡',icon:'work',tagline:'Everything running and done',defaultView:'work'},
 {id:'projects',label:'Projects',symbol:'▣',icon:'projects',tagline:'Make and keep things',defaultView:'library'},
 {id:'improve',label:'Improve',symbol:'Δ',icon:'improve',tagline:'Change Local AI itself',defaultView:'changes'},
 {id:'system',label:'System',symbol:'◉',icon:'system',tagline:'Health and history',defaultView:'status'}
];
const VIEWS=[
 {id:'home',domain:'home',section:'Overview',icon:'⌂',label:'Home',description:'Start something, or pick up where you left off.',aka:['overview']},
 {id:'inbox',domain:'home',section:'Overview',icon:'!',label:'Inbox',tab:'Alerts',description:'Alerts and anything waiting on you.',aka:['notifications','alerts']},
 {id:'approvals',domain:'home',section:'Overview',parent:'inbox',tab:'Approvals',icon:'✓',label:'Approvals',description:'Actions held until you approve them.'},
 {id:'work',domain:'work',section:'Work',icon:'≡',label:'Work',description:'Everything running and done, in one place.',aka:['runs','missions','agents']},
 {id:'ask',domain:'hidden',section:'Make',icon:'✦',label:'Chat',description:'Private conversation with your local models.',aka:['ask','ask ai']},
 {id:'create',domain:'hidden',section:'Make',icon:'◇',label:'Images',description:'Generate images with your local models.',aka:['create','create image']},
 {id:'library',domain:'projects',section:'Keep',icon:'▦',label:'Library',description:"Everything you've made: chats, research and images."},
 {id:'projects',domain:'projects',section:'Keep',icon:'▣',label:'Projects',tab:'Projects',description:'Group related work with its own sources and memory.'},
 {id:'knowledge',domain:'projects',section:'Keep',parent:'projects',tab:'Sources',icon:'◫',label:'Sources',description:'Files and notes the assistant can search.',aka:['knowledge']},
 {id:'memory',domain:'projects',section:'Keep',parent:'projects',tab:'Memory',icon:'M',label:'Memory',description:'Facts the assistant keeps about each project.',aka:['project memory']},
 {id:'agents',domain:'hidden',section:'Agents',icon:'◎',label:'Missions',description:'Give a goal; specialist agents work it live.',aka:['agents','agent operations']},
 {id:'status',domain:'system',section:'Health',icon:'●',label:'Health',description:'Core services and optional companions.',aka:['status','system status']},
 {id:'models',domain:'system',section:'Health',icon:'M',label:'Models',description:"Installed models and what's loaded now."},
 {id:'integrations',domain:'system',section:'Health',icon:'↔',label:'Integrations',description:'Local tools, host bridges and cloud fallbacks.'},
 {id:'automationStudio',domain:'system',section:'Automations',icon:'⌘',label:'Automations',description:'Scheduled prompts, research and health checks.',aka:['studio','automation studio']},
 {id:'automations',short:'n8n',domain:'system',section:'Automations',icon:'↗',label:'n8n workflows',description:'Build advanced workflows in n8n.',aka:['workflows']},
 {id:'actions',short:'Browser',domain:'system',section:'Automations',icon:'↗',label:'Browser & computer',description:'Fetch pages and run approved local actions.',aka:['actions','computer actions']},
 {id:'operations',domain:'system',section:'Automations',icon:'◉',label:'Monitors',description:'Recurring health checks and the morning brief.',aka:['operations','morning brief']},
 {id:'changes',short:'Changes',domain:'improve',section:'Changes',icon:'Δ',label:'Change requests',description:"Describe a change; it's planned, tested and held for approval.",aka:['changes','change intelligence','engineer','engineering agent']},
 {id:'issues',domain:'improve',section:'Changes',icon:'!',label:'Issues',tab:'Issues',description:'Problems found in Local AI, deduplicated.'},
 {id:'quality',domain:'improve',section:'Changes',parent:'issues',tab:'Quality signals',icon:'Q',label:'Quality signals',description:'Static checks, browser errors and regressions.',aka:['quality','quality intelligence']},
 {id:'claude',domain:'improve',section:'Changes',icon:'✳',label:'Claude Code',description:'Live sessions and ranked recommendations.',aka:['claude']},
 {id:'workbench',domain:'system',section:'Tools',icon:'W',label:'Files',description:'Browse, search and safely edit mounted folders.',aka:['workbench','engineering workbench']},
 {id:'repoTools',domain:'system',section:'Tools',icon:'R',label:'Repository',description:'Inspect repos and run allow-listed commands.',aka:['repo tools','repository tools']},
 {id:'powershell',domain:'system',section:'Tools',icon:'PS',label:'PowerShell',description:'Approval-gated scripts on the Windows host.',aka:['powershell workbench']},
 {id:'activity',domain:'system',section:'History',icon:'◷',label:'Audit log',description:'What happened on the appliance, and when.',aka:['activity']},
 {id:'runs',domain:'hidden',section:'History',icon:'▶',label:'Runs',description:'Every execution, live, with cancel and retry.'}
];
// Retired view ids and the page that replaced them.
// `runs`, `agents`, `ask` and `create` keep their own hidden pages for code and ⌘K; a URL resolves them to the page that now owns them.
const ALIASES={engineering:'changes',runs:'work',agents:'work',ask:'home',create:'home'};
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
