// The platform map on Atlas (platform capture spec, design item 4; layout approved 15 Nov): the four systems plus
// home-mcp and netmon as nodes, one link per consumer system and provider, each with a mark in words as well as colour
// (Confirmed, Missing, Not checked) from GET /api/atlas/contracts. Choosing a link shows its routes, provider and
// consumers. The table lists every declared edge and is the complete fallback; on a narrow container the graph becomes
// a list of systems with their links beneath. Calls the scanner found with no declared edge are one grouped list,
// never drawn. architecture.js calls renderPlatformGraph once the systems list and the contracts have loaded.
(function(root){
'use strict';

// The nodes, in order. Smart display's firmware is opaque to the scanner; netmon writes files to Pi Hub and makes no
// HTTP call, so it has no link; home-mcp is a declared consumer Atlas doesn't map. A repository the contracts name that
// is not here joins the end.
const PLATFORM=[
  {id:'pi-hub',label:'Pi Hub'},
  {id:'localai',label:'Local AI'},
  {id:'print-lab',label:'Print lab'},
  {id:'bambuhelper-smart-display',label:'Smart display',note:'Firmware source, not parsed'},
  {id:'home-mcp',label:'home-mcp',note:'Declared consumer, not mapped'},
  {id:'netmon',label:'netmon',note:'Writes files, no HTTP link'},
];
const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
const labelFor=(repo,labels)=>labels?.get?.(repo)||PLATFORM.find(p=>p.id===repo)?.label||String(repo);

const MARKS={
  confirmed:{key:'confirmed',text:'Confirmed',tone:'ok',rank:0,means:'the route is served and called at the live commits'},
  missing:{key:'missing',text:'Missing',tone:'bad',rank:2,means:'the route or the call is not in the code'},
  unchecked:{key:'not-checked',text:'Not checked',tone:'unknown',rank:1,means:"no snapshot, or the source isn't parsed"},
};
// The contracts endpoint's check, in the three marks: either side missing is Missing; anything not checked is never
// called confirmed.
function markFor(check){
  const m=check==='confirmed'?MARKS.confirmed:check==='provider missing'||check==='consumer missing'?MARKS.missing:MARKS.unchecked;
  return {key:m.key,text:m.text,tone:m.tone};
}
const rank=mark=>Object.values(MARKS).find(m=>m.key===mark.key).rank;
const worst=marks=>marks.reduce((a,b)=>rank(b)>rank(a)?b:a,markFor('confirmed'));

// One consumer's check against its provider: the edge as a whole may be "no snapshot" because another consumer is not
// mapped while this one is confirmed.
function consumerCheck(consumer,provider){
  if(provider?.state==='provider_missing')return 'provider missing';
  if(consumer?.state==='consumer_missing')return 'consumer missing';
  if(consumer?.state==='checked'&&provider?.state==='checked')return 'confirmed';
  if(consumer?.state==='not_checked'||provider?.state==='not_checked')return 'no snapshot';
  return consumer?.check||'no snapshot';
}
function edgeCheck(c){
  if(typeof c.check==='string')return c.check;
  const list=Array.isArray(c.consumers)?c.consumers:[];
  if(c.provider?.state==='provider_missing')return 'provider missing';
  if(list.some(x=>x?.state==='consumer_missing'))return 'consumer missing';
  if(c.provider?.state!=='checked'||list.some(x=>x?.state!=='checked'))return 'no snapshot';
  return 'confirmed';
}

// A system's map freshness in the Systems strip's words (atlas-systems.js), when Pi Hub's list has the repository.
function nodeLine(row){
  if(!row)return '';
  if(!row.snapshot)return 'Not mapped yet';
  // eslint-disable-next-line no-undef -- the tests' CommonJS require; the browser has root.LocalAIAtlasSystems
  const systems=root.LocalAIAtlasSystems||(typeof require==='function'?require('./atlas-systems.js'):null);
  // An older copy of the list has no freshness: the same commit is current, any other is a different one (as the strip).
  const f=row.freshness||{state:!row.liveCommit?'no release':row.snapshot.commit===row.liveCommit?'current':'behind'};
  return systems?.freshSentence?systems.freshSentence(f):'';
}

// Why an edge is not confirmed, in the check's own words (the provider's reason, else the first consumer's); empty when
// it is confirmed.
function edgeNote(c,check){
  if(check==='confirmed')return '';
  const list=Array.isArray(c.consumers)?c.consumers:[];
  if(check==='provider missing')return String(c.provider?.detail||'');
  const state=check==='consumer missing'?'consumer_missing':'not_checked';
  return String(list.find(x=>x?.state===state&&x.detail)?.detail||'');
}

// Whether a module can be opened on its repository's map (architecture.js handles the click). A side the check found in
// a snapshot can; anything else cannot, and says why in a few words taken from the check's own reason.
function showReason(detail,missing){
  const d=String(detail||'');
  if(/firmware/i.test(d))return 'firmware source, not parsed';
  if(/powershell|not scanned/i.test(d))return 'source not scanned';
  return missing?'module not in this map':'no snapshot';
}
function showOn(module,state,detail,label){
  const m=String(module||''),found=state==='checked'&&!!m;
  return {enabled:found,label:`Show on map: ${m||'module'} in ${label}`,reason:found?'':showReason(detail,state==='provider_missing'||state==='consumer_missing')};
}

function errorText(error){
  if(!error)return '';
  if(typeof error==='string')return error;
  return String(error.message||error.code||'no reason given');
}

// Everything the section draws, from the two payloads. State: loading (no contracts yet), error, empty (no declared
// edges) or ready.
function platformModel(systems,contracts){
  const rows=new Map();
  for(const h of Array.isArray(systems?.hosts)?systems.hosts:[])for(const r of Array.isArray(h?.repos)?h.repos:[])if(r&&r.repo&&!rows.has(r.repo))rows.set(r.repo,r);
  const list=(Array.isArray(contracts?.contracts)?contracts.contracts:[]).filter(c=>c&&c.provider&&c.provider.repo);
  const ids=PLATFORM.map(p=>p.id);
  for(const c of list)for(const repo of [c.provider.repo,...(Array.isArray(c.consumers)?c.consumers:[]).map(x=>x?.repo)])
    if(typeof repo==='string'&&repo&&!ids.includes(repo))ids.push(repo);
  // A repository Pi Hub's list keeps that neither the list above nor a contract names is still a system.
  for(const repo of rows.keys())if(!ids.includes(repo))ids.push(repo);
  const nodes=ids.map(id=>{
    const p=PLATFORM.find(x=>x.id===id)||{id,label:id};
    const row=rows.get(id);
    return {id,label:String(row?.label||p.label),note:p.note||'',line:nodeLine(row)};
  });
  const labels=new Map(nodes.map(n=>[n.id,n.label]));
  const edges=list.map(c=>{
    const p=c.provider;
    const consumers=(Array.isArray(c.consumers)?c.consumers:[]).filter(x=>x&&x.repo).map(x=>{
      const check=consumerCheck(x,p);
      return {repo:x.repo,module:String(x.module||''),text:`${labelFor(x.repo,labels)} · ${x.module||'?'}`,check,mark:markFor(check),detail:String(x.detail||''),
        show:showOn(x.module,x.state,x.detail,labelFor(x.repo,labels))};
    });
    const check=edgeCheck(c);
    return {id:String(c.id||`${p.method||''} ${p.path||''}`),name:String(c.label||c.contract||c.id||''),
      route:[p.method,p.path].filter(Boolean).join(' '),
      provider:{repo:p.repo,module:String(p.module||''),text:`${labelFor(p.repo,labels)} · ${p.module||'?'}`,detail:String(p.detail||''),
        show:showOn(p.module,p.state,p.detail,labelFor(p.repo,labels))},
      consumers,check,mark:markFor(check),note:edgeNote(c,check)};
  });
  const links=new Map();
  for(const e of edges)for(const c of e.consumers){
    if(c.repo===e.provider.repo)continue;
    const id=`${c.repo}>${e.provider.repo}`;
    if(!links.has(id))links.set(id,{id,from:c.repo,to:e.provider.repo,routes:[]});
    // Two consumers of one edge in the same repository: the route reads the worse of the two.
    const routes=links.get(id).routes,have=routes.find(r=>r.edge===e);
    if(have)have.mark=worst([have.mark,c.mark]);else routes.push({edge:e,mark:c.mark});
  }
  for(const l of links.values())l.mark=worst(l.routes.map(r=>r.mark));
  let state='ready',message='';
  if(!contracts)state='loading';
  else if(contracts.error){state='error';message=errorText(contracts.error);}
  else if(!edges.length)state='empty';
  // The live release each repository was checked at, in the nodes' order.
  const live=contracts?.commits&&typeof contracts.commits==='object'?contracts.commits:{};
  const commits=nodes.filter(n=>typeof live[n.id]==='string'&&live[n.id]).map(n=>({repo:n.id,label:n.label,commit:live[n.id].slice(0,7)}));
  return {state,message,commits,nodes,links:[...links.values()],edges,undeclared:groupUndeclared(contracts?.undeclared,labels),
    hasUndeclared:Array.isArray(contracts?.undeclared)};
}

// The table: one row per declared edge, in the order the contracts file declares them.
function tableRows(model){
  return (model?.edges||[]).map(e=>({id:e.id,name:e.name,route:e.route,provider:e.provider.text,providerRef:{repo:e.provider.repo,module:e.provider.module,show:e.provider.show},consumers:e.consumers,mark:e.mark,note:e.note}));
}

// Calls with no declared edge, by calling repository and then by calling module (a client module talks to one host,
// so Bambuddy's or Ollama's calls stay in one group each), the biggest first.
function groupUndeclared(list,labels){
  const repos=new Map();
  for(const u of Array.isArray(list)?list:[]){
    if(!u||typeof u.path!=='string')continue;
    const repo=String(u.repo||'unknown'),module=String(u.module||'unknown');
    if(!repos.has(repo))repos.set(repo,new Map());
    const mods=repos.get(repo);
    if(!mods.has(module))mods.set(module,[]);
    mods.get(module).push({method:u.method||null,path:u.path,line:Number.isFinite(Number(u.line))&&u.line!==null?Number(u.line):null});
  }
  return [...repos].map(([repo,mods])=>{
    const modules=[...mods].map(([module,calls])=>({module,calls})).sort((a,b)=>b.calls.length-a.calls.length||a.module.localeCompare(b.module));
    return {repo,label:labelFor(repo,labels),count:modules.reduce((t,m)=>t+m.calls.length,0),modules};
  }).sort((a,b)=>b.count-a.count||a.repo.localeCompare(b.repo));
}

// Providers on the top row, everyone else below, spread evenly. A link leaves its provider, curves down to its
// consumer's column and drops straight into it; its mark sits on that drop, so marks are as far apart as the
// consumers. Units: a 1000-wide frame, HEIGHT tall (the page draws it 24rem high, so the rows never squeeze).
const WIDTH=1000,HEIGHT=380,TOP_Y=60,BOTTOM_Y=320,BEND_Y=200,NODE_EDGE=28;
// A mark is a chip over a count (about 140 by 56 px); marks keep MARK_GAP apart, and a node's marks stack by MARK_STEP.
// The graph is drawn from FRAME_MIN_PX (the container query's 48rem) wide, CANVAS_PX tall (24rem).
const MARK={MARK_W:140,MARK_H:56,MARK_GAP:8,FRAME_MIN_PX:768,CANVAS_PX:384};
const MARK_STEP=MARK.MARK_H+MARK.MARK_GAP;
function platformLayout(nodes,links){
  const list=Array.isArray(nodes)?nodes:[],all=Array.isArray(links)?links:[];
  const providers=new Set(all.map(l=>l.to));
  let top=list.filter(n=>providers.has(n.id));
  if(!top.length&&list.length)top=[list[0]];
  const bottom=list.filter(n=>!top.includes(n));
  const place=(row,y)=>row.map((n,i)=>({id:n.id,x:Math.round((i+0.5)*WIDTH/row.length),y,slot:WIDTH/row.length,row:y===TOP_Y?'top':'bottom'}));
  const pos=[...place(top,TOP_Y),...place(bottom,BOTTOM_Y)];
  const at=new Map(pos.map(p=>[p.id,p]));
  const seen=new Map(),paths=[];
  for(const l of all){
    const a=at.get(l.from),b=at.get(l.to);
    if(!a||!b)continue;
    const k=seen.get(a.id)||0;seen.set(a.id,k+1);
    const down=a.y>b.y,bend=down?BEND_Y:a.y+BEND_Y-TOP_Y,mid=(b.y+bend)/2;
    // A mark sits clear of its node's box (MARK_GAP above it) when the link comes up from below, then stacks upward.
    const my=(down?a.y-NODE_EDGE-MARK.MARK_GAP-MARK.MARK_H/2:(bend+a.y)/2)-k*MARK_STEP;
    paths.push({id:l.id,d:`M${b.x} ${b.y} C${b.x} ${mid} ${a.x} ${mid} ${a.x} ${bend} L${a.x} ${a.y}`,mx:a.x,my});
  }
  return {width:WIDTH,height:HEIGHT,nodes:pos,paths};
}

const exported={PLATFORM,MARK,markFor,platformModel,platformLayout,tableRows,groupUndeclared};
if(typeof module==='object'&&module.exports){module.exports=exported;return;}

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=(v,of)=>`${(v/of*100).toFixed(2)}%`;
const chip=mark=>`<span class="ui-chip ui-chip--${mark.tone}">${esc(mark.text)}</span>`;
const views=new WeakMap();

// A break is allowed after each slash.
const path=v=>esc(v).replace(/\//g,'/<wbr>');
// Opens a module on its repository's map through architecture.js's data-atlas-cross-* handler. One that cannot stays
// focusable (aria-disabled), carries no data that handler reads, and is described by a muted reason line.
let showId=0;
function showButton(repo,module,show){
  const id=`atlasPlatformWhy-${++showId}`,on=show.enabled;
  return `<span class="atlas-platform-showbox"><button type="button" class="ui-btn ui-btn--ghost atlas-platform-show" ${on?`data-atlas-cross-repo="${esc(repo)}" data-atlas-cross-module="${esc(module)}"`:`aria-disabled="true" aria-describedby="${id}"`} aria-label="${esc(show.label)}">Show on map</button>${on?'':`<small id="${id}">Not on the map: ${esc(show.reason)}</small>`}</span>`;
}

function summary(model){
  const counts={confirmed:0,missing:0,'not-checked':0};
  for(const e of model.edges)counts[e.mark.key]++;
  const parts=[`${counts.confirmed} confirmed`];
  if(counts.missing)parts.push(`${counts.missing} missing`);
  if(counts['not-checked'])parts.push(`${counts['not-checked']} not checked`);
  const live=model.commits.length?` Live releases: ${model.commits.map(c=>`${c.label} ${c.commit}`).join(', ')}.`:'';
  return {text:`${plural(model.edges.length,'declared edge')} at the live commits: ${parts.join(', ')}.${live}`,tone:counts.missing?'error':''};
}

function legend(){
  return `<ul class="atlas-platform-legend" aria-label="What the marks mean">${Object.values(MARKS).map(m=>
    `<li>${chip(m)}<span>${esc(m.means)}</span></li>`).join('')}</ul>`;
}

const nodeText=(n,model)=>{
  const serves=model.edges.filter(e=>e.provider.repo===n.id).length;
  const lines=[n.line,n.note,serves?`Serves ${plural(serves,'declared route')}`:''].filter(Boolean);
  return `<span class="atlas-platform-name" title="${esc(n.label)}">${esc(n.label)}</span>${lines.map(t=>`<small>${esc(t)}</small>`).join('')}`;
};

function linkButton(l,model,sel,inner,where){
  const from=model.nodes.find(n=>n.id===l.from)?.label||l.from,to=model.nodes.find(n=>n.id===l.to)?.label||l.to;
  return `<button type="button" class="atlas-platform-link" data-platform-link="${esc(l.id)}" data-mark="${l.mark.key}" aria-pressed="${sel===l.id}"${sel===l.id?` aria-controls="atlasPlatformDetail-${where}"`:''}>${inner}${chip(l.mark)}<small>${esc(plural(l.routes.length,'route'))}</small><span class="visually-hidden"> from ${esc(from)} to ${esc(to)}</span></button>`;
}

function canvas(model,sel){
  const lay=platformLayout(model.nodes,model.links);
  const paths=lay.paths.map(p=>{const l=model.links.find(x=>x.id===p.id);
    return `<path class="atlas-platform-edge" data-mark="${l.mark.key}" data-link="${esc(l.id)}"${sel===l.id?' data-selected=""':''} d="${p.d}"></path>`;}).join('');
  const nodes=lay.nodes.map(p=>{const n=model.nodes.find(x=>x.id===p.id);
    // A box grows away from the links: the top row's upward from its lower edge, the bottom row's downward from its top.
    const edge=p.row==='top'?p.y+NODE_EDGE:p.y-NODE_EDGE;
    return `<div class="atlas-platform-node" data-node="${esc(n.id)}" data-row="${p.row}" style="left:${pct(p.x,lay.width)};top:${pct(edge,lay.height)};width:${pct(p.slot*0.92,lay.width)}">${nodeText(n,model)}</div>`;}).join('');
  const marks=lay.paths.map(p=>{const l=model.links.find(x=>x.id===p.id);
    return `<div class="atlas-platform-mark" style="left:${pct(p.mx,lay.width)};top:${pct(p.my,lay.height)}">${linkButton(l,model,sel,'','graph')}</div>`;}).join('');
  return `<div class="atlas-platform-canvas"><svg viewBox="0 0 ${lay.width} ${lay.height}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${paths}</svg>${nodes}${marks}</div>`;
}

function phoneList(model,sel){
  return `<ul class="atlas-platform-list">${model.nodes.map(n=>{
    const out=model.links.filter(l=>l.from===n.id);
    const to=l=>model.nodes.find(x=>x.id===l.to)?.label||l.to;
    return `<li data-node="${esc(n.id)}"><div class="atlas-platform-list-head">${nodeText(n,model)}</div>${out.length?
      `<ul>${out.map(l=>`<li>${linkButton(l,model,sel,`<span class="atlas-platform-to">To ${esc(to(l))}</span>`,'list')}</li>`).join('')}</ul>`:''}${out.some(l=>l.id===sel)?detail(model,sel,'list'):''}</li>`;
  }).join('')}</ul>`;
}

// The chosen link's routes. In the graph it sits under the drawing; in the list, under the chosen system (where='list').
function detail(model,sel,where){
  const l=model.links.find(x=>x.id===sel);
  if(!l)return '';
  const from=model.nodes.find(n=>n.id===l.from)?.label||l.from,to=model.nodes.find(n=>n.id===l.to)?.label||l.to;
  const bad=l.routes.filter(r=>r.mark.key==='missing').length,open=l.routes.filter(r=>r.mark.key==='not-checked').length;
  const said=[bad?`${bad} missing`:'',open?`${open} not checked`:''].filter(Boolean).join(', ');
  return `<div id="atlasPlatformDetail-${where}" class="atlas-platform-detail atlas-platform-detail--${where}" aria-labelledby="atlasPlatformDetailTitle-${where}">
    <h3 id="atlasPlatformDetailTitle-${where}">${esc(from)} → ${esc(to)}</h3>
    <p class="atlas-platform-detail-sum">${esc(plural(l.routes.length,'route'))}${said?`: ${esc(said)}`:', all confirmed'}.</p>
    <ul class="atlas-platform-routes">${l.routes.map(({edge:e,mark})=>`<li data-edge="${esc(e.id)}">
      <p class="atlas-platform-route"><code title="${esc(e.route)}">${esc(e.route)}</code><span class="atlas-platform-verdict">${chip(mark)} for ${esc(from)}</span><span class="atlas-platform-verdict">Whole contract: ${chip(e.mark)}</span>${e.name&&e.name!==e.id?`<small>${esc(e.name)}</small>`:''}</p>
      <dl>
        <div><dt>Provider</dt><dd>${path(e.provider.text)}${e.provider.detail?`<small>${esc(e.provider.detail)}</small>`:''}${showButton(e.provider.repo,e.provider.module,e.provider.show)}</dd></div>
        <div><dt>Consumers</dt><dd><ul>${e.consumers.map(c=>`<li>${path(c.text)} ${chip(c.mark)}${c.detail&&c.mark.key!=='confirmed'?`<small>${esc(c.detail)}</small>`:''}${showButton(c.repo,c.module,c.show)}</li>`).join('')}</ul></dd></div>
      </dl></li>`).join('')}</ul>
    <p class="atlas-platform-detail-note">Tests that call these routes are not part of the contract check yet.</p>
  </div>`;
}

function table(model){
  const rows=tableRows(model);
  return `<table class="ui-table ui-table--stack atlas-platform-table" role="table">
    <caption>${esc(plural(rows.length,'declared edge'))}, in the order atlas/contracts.json declares them</caption>
    <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Route</th><th scope="col" role="columnheader">Provider</th><th scope="col" role="columnheader">Consumers</th><th scope="col" role="columnheader">Check</th></tr></thead>
    <tbody role="rowgroup">${rows.map(r=>`<tr role="row" data-edge="${esc(r.id)}">
      <td role="cell" data-label="Route"><span><code>${esc(r.route)}</code>${r.name&&r.name!==r.id?`<small>${esc(r.name)}</small>`:''}</span></td>
      <td role="cell" data-label="Provider"><span>${path(r.provider)}${showButton(r.providerRef.repo,r.providerRef.module,r.providerRef.show)}</span></td>
      <td role="cell" data-label="Consumers"><ul>${r.consumers.map(c=>`<li>${path(c.text)} <span class="atlas-platform-consumer-mark">(${esc(c.mark.text.toLowerCase())})</span>${showButton(c.repo,c.module,c.show)}</li>`).join('')}</ul></td>
      <td role="cell" data-label="Check">${chip(r.mark)}${r.note?`<small>${esc(r.note)}</small>`:''}</td></tr>`).join('')}</tbody></table>`;
}

function undeclared(model){
  if(!model.hasUndeclared)return '';
  const total=model.undeclared.reduce((t,g)=>t+g.count,0);
  if(!total)return '<p class="atlas-platform-undeclared-none">Every call to another system found in code has a declared edge.</p>';
  return `<details class="atlas-platform-undeclared"><summary>${esc(plural(total,'call'))} with no declared edge</summary>
    <p class="atlas-platform-undeclared-why">Found in code, named by no contract: information, not an error. Most are third-party services (Bambuddy, Ollama) or a system's own scripts. Grouped by the module that makes them.</p>
    ${model.undeclared.map(g=>`<div class="atlas-platform-undeclared-repo"><h3>${esc(g.label)} · ${esc(plural(g.count,'call'))}</h3>
      ${g.modules.map(m=>`<details><summary><code>${esc(m.module)}</code> · ${esc(plural(m.calls.length,'call'))}</summary><ul>${m.calls.map(c=>
        `<li><code>${esc([c.method,c.path].filter(Boolean).join(' '))}</code>${c.line!==null?` <small>line ${c.line}</small>`:''}</li>`).join('')}</ul></details>`).join('')}</div>`).join('')}
  </details>`;
}

function body(model,v){
  if(model.state==='loading')return `<p class="atlas-platform-state">Checking the links between systems…</p><span class="ui-skeleton atlas-platform-skeleton" aria-hidden="true"></span>`;
  if(model.state==='error')return `<p class="ui-notice ui-notice--bad">The links between systems could not be checked: ${esc(model.message)}. Refresh tries again.</p>`;
  if(model.state==='empty')return `<p class="ui-empty">No links between systems are declared yet. They are declared in atlas/contracts.json.</p>
    <div class="atlas-platform-panel ui-cq">${canvas(model,null)}${phoneList(model,null)}</div>${undeclared(model)}`;
  const tab=(id,label)=>`<button type="button" role="tab" id="atlasPlatformTab-${id}" data-view="${id}" aria-controls="atlasPlatform-${id}" aria-selected="${v.view===id}" tabindex="${v.view===id?0:-1}">${label}</button>`;
  return `<div class="ui-tabs atlas-platform-views" role="tablist" aria-label="Show the platform map as">${tab('graph','Graph')}${tab('table','Table')}</div>
    ${legend()}
    <div id="atlasPlatform-graph" class="atlas-platform-panel ui-cq" role="tabpanel" aria-labelledby="atlasPlatformTab-graph"${v.view==='graph'?'':' hidden'}>${canvas(model,v.selected)}${detail(model,v.selected,'graph')}${phoneList(model,v.selected)}</div>
    <div id="atlasPlatform-table" class="atlas-platform-panel ui-cq" role="tabpanel" aria-labelledby="atlasPlatformTab-table"${v.view==='table'?'':' hidden'}>${table(model)}</div>
    ${undeclared(model)}`;
}

// What had focus inside the section, so a redraw (a choice, Refresh) puts it back.
function focusKey(el){
  const a=document.activeElement;
  if(!a||!el.contains(a))return null;
  if(a.dataset.platformLink)return `[data-platform-link="${CSS.escape(a.dataset.platformLink)}"]`+(a.closest('.atlas-platform-list')?'@list':'@canvas');
  if(a.dataset.view)return `[role="tab"][data-view="${CSS.escape(a.dataset.view)}"]`;
  return null;
}
function restoreFocus(el,key){
  if(!key)return;
  const [sel,where]=key.split('@');
  const scope=where?el.querySelector(where==='list'?'.atlas-platform-list':'.atlas-platform-canvas'):el;
  scope?.querySelector(sel)?.focus({preventScroll:true});
}

function draw(el){
  const v=views.get(el);
  showId=0;
  const model=platformModel(v.systems,v.contracts);
  if(v.selected&&!model.links.some(l=>l.id===v.selected))v.selected=null;
  const key=focusKey(el);
  const s=model.state==='ready'?summary(model):{text:model.state==='empty'?'Nothing declared yet.':'',tone:''};
  el.dataset.state=model.state;
  el.setAttribute('aria-busy',String(model.state==='loading'));
  el.innerHTML=`<div class="atlas-platform-head"><h2 id="atlasPlatformTitle">Platform map</h2>${s.text?`<p class="atlas-platform-summary" data-tone="${s.tone}">${esc(s.text)}</p>`:''}</div>${body(model,v)}`;
  el.append(v.live);
  restoreFocus(el,key);
}

// A link chosen in the list (phone, narrow section): its detail opens under that system; bring its heading into view
// and say it politely, focus staying on the link.
function revealListDetail(el){
  const v=views.get(el),box=el.querySelector('.atlas-platform-list .atlas-platform-detail');
  if(!box)return;
  v.live.textContent=`Showing ${box.querySelector('h3').textContent}. ${box.querySelector('.atlas-platform-detail-sum').textContent}`;
  box.querySelector('h3').scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
}

function bind(el){
  el.addEventListener('click',e=>{
    const v=views.get(el);
    const link=e.target.closest('[data-platform-link]');
    if(link){
      const inList=!!link.closest('.atlas-platform-list');
      v.selected=link.dataset.platformLink;v.live.textContent='';draw(el);
      if(inList)revealListDetail(el);
      return;
    }
    const tab=e.target.closest('[role="tab"][data-view]');
    if(tab&&tab.dataset.view!==v.view){v.view=tab.dataset.view;draw(el);}
  });
  // Arrow keys, Home and End move between Graph and Table (the kit's tabs pattern), choosing as they go.
  el.addEventListener('keydown',e=>{
    const tab=e.target.closest('[role="tab"][data-view]');
    if(!tab)return;
    const tabs=[...el.querySelectorAll('[role="tab"][data-view]')],i=tabs.indexOf(tab);
    const next={ArrowRight:i+1,ArrowDown:i+1,ArrowLeft:i-1,ArrowUp:i-1,Home:0,End:tabs.length-1}[e.key];
    if(next===undefined)return;
    e.preventDefault();
    const to=tabs[(next+tabs.length)%tabs.length];
    views.get(el).view=to.dataset.view;draw(el);
    el.querySelector(`[role="tab"][data-view="${CSS.escape(to.dataset.view)}"]`)?.focus();
  });
}

// systems: GET /api/atlas/systems's body (or null); contracts: GET /api/atlas/contracts's body, null while it loads, or
// { error } when it failed. Keeps the chosen view and link across calls.
function renderPlatformGraph(el,systems,contracts){
  if(!el)return;
  if(!views.has(el)){
    const live=document.createElement('p');
    live.className='visually-hidden';live.setAttribute('role','status');live.setAttribute('aria-live','polite');
    views.set(el,{view:'graph',selected:null,live});bind(el);
  }
  Object.assign(views.get(el),{systems:systems||null,contracts:contracts||null});
  draw(el);
}

root.LocalAIAtlasPlatform={...exported,renderPlatformGraph};
})(typeof window==='undefined'?globalThis:window);
