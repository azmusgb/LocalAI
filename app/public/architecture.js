// Local AI System Atlas native web integration.
(function(root){
'use strict';

const exported = {};
const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
// The scanner's bands (quick_arch.py risk_level).
const riskLevel=r=>(r=Number(r)||0)>=70?'critical':r>=48?'high':r>=28?'medium':'low';
const productionNodes=graph=>(graph?.nodes||[]).filter(n=>n&&n.id&&n.domain!=='Tests');

function domainSummary(graph) {
  const nodes = productionNodes(graph);
  const byId = new Map(nodes.map(n => [n.id,n]));
  const domains = new Map();
  for (const node of nodes) {
    const d = String(node.domain || 'Other');
    const cur = domains.get(d) || {id:d,count:0,risk:0,changed:0};
    cur.count += 1;
    cur.risk = Math.max(cur.risk, Number(node.risk)||0);
    if (node.changed) cur.changed += 1;
    domains.set(d,cur);
  }
  const links = new Map();
  for (const edge of graph?.edges || []) {
    const a = byId.get(edge.source), b = byId.get(edge.target);
    if (!a || !b || a.domain === b.domain) continue;
    const key = `${a.domain}\u0000${b.domain}`;
    links.set(key,(links.get(key)||0)+1);
  }
  return {
    domains:[...domains.values()].sort((a,b)=>b.risk-a.risk || b.count-a.count || a.id.localeCompare(b.id)),
    links:[...links].map(([key,count])=>{const [source,target]=key.split('\u0000');return{source,target,count};})
  };
}

// Callers before what they depend on: domains ordered by how much more they use than they are used.
function orderDomains(domains,links){
  const flow=new Map(domains.map(d=>[d.id,{out:0,in:0}]));
  for(const l of links){
    if(flow.has(l.source))flow.get(l.source).out+=l.count;
    if(flow.has(l.target))flow.get(l.target).in+=l.count;
  }
  const score=d=>{const f=flow.get(d.id);return (f.out-f.in)/((f.out+f.in)||1);};
  const linked=d=>{const f=flow.get(d.id);return f.out+f.in>0?0:1;};  // domains with no links go last
  return [...domains].sort((a,b)=>linked(a)-linked(b)||score(b)-score(a)||b.count-a.count||a.id.localeCompare(b.id));
}

// The graph as the page uses it: production modules with what they use and what uses them (imports), the browser's
// HTTP calls kept apart, and the tests that import each module counted rather than drawn. A version 1 snapshot has no
// link kinds and no reach; a link from a test is still a test, and reach is worked out here.
function buildModel(graph){
  const all=new Map((graph?.nodes||[]).filter(n=>n&&n.id).map(n=>[n.id,n]));
  const nodes=new Map();
  for(const n of productionNodes(graph))nodes.set(n.id,{...n,domain:String(n.domain||'Other'),uses:new Set(),usedBy:new Set(),
    httpTo:new Set(),httpFrom:new Set(),tests:[]});
  const links=[],linked=new Set();
  for(const e of graph?.edges||[]){
    if(!e)continue;
    const kind=e.kind||(all.get(e.source)?.domain==='Tests'?'test':'import');
    if(kind==='test'){if(nodes.has(e.target)&&!nodes.get(e.target).tests.includes(e.source))nodes.get(e.target).tests.push(e.source);continue;}
    const a=nodes.get(e.source),b=nodes.get(e.target);
    if(!a||!b||a===b)continue;
    const key=`${kind==='http'?'http':'import'}\u0000${a.id}\u0000${b.id}`;
    if(linked.has(key))continue;  // a link listed twice counts once
    linked.add(key);
    if(kind==='http'){a.httpTo.add(b.id);b.httpFrom.add(a.id);}else{a.uses.add(b.id);b.usedBy.add(a.id);}
    links.push({source:a.id,target:b.id,kind:kind==='http'?'http':'import',paths:e.paths||[]});
  }
  for(const n of nodes.values()){
    if(Number.isFinite(Number(n.reach))&&n.reach!==null&&n.reach!==undefined){n.reach=Number(n.reach);continue;}
    const seen=new Set(),todo=[n.id];
    while(todo.length)for(const u of nodes.get(todo.pop()).usedBy)if(u!==n.id&&!seen.has(u)){seen.add(u);todo.push(u);}
    n.reach=seen.size;
  }
  const version=Number(graph?.schemaVersion)||1;
  return {nodes,links,version,dangling:version>=2&&Array.isArray(graph?.danglingHttp)?graph.danglingHttp.filter(d=>d&&d.source):null,graph};
}
const testCount=n=>Math.max(Number(n?.testRefs)||0,n?.tests?.length||0);

// Columns run from callers to what they use. Local AI's, Pi Hub's and Print lab's come from their domains (Atlas
// redesign spec, PRs 3 and 5); another repository's domains go in caller-first order, at most six columns. A domain no
// rule names joins Shared, and an empty column is left out.
const LOCALAI_COLUMNS=[
  {title:'Browser',sub:'What you see',domains:['UI']},
  {title:'Entry',sub:'Starts everything',domains:['Platform','Runtime','Host','Root','Tooling','Docs']},
  {title:'Server',sub:'HTTP routes and bridges',domains:['API','Claude','GridCraft']},
  {title:'Capabilities',sub:'AI, workshop, media',domains:['AI','Workshop','Media']},
  {title:'Shared',sub:'Used across features',domains:['Core']},
  {title:'Data',sub:'Where state lives',domains:['Data']},
];
const REPO_COLUMNS={
  localai:LOCALAI_COLUMNS,
  'pi-hub':[
    {title:'Browser',sub:'What you see',domains:['UI']},
    {title:'Entry',sub:'The app and its jobs',domains:['Platform','Runtime','Host','Root','Tooling','Docs']},
    {title:'Server',sub:'HTTP routes',domains:['API']},
    {title:'Capabilities',sub:'Workshop and media',domains:['Workshop','Media','AI']},
    {title:'Shared',sub:'Used across features',domains:['Core']},
    {title:'Data',sub:'Where state lives',domains:['Data']},
  ],
  'print-lab':[
    {title:'Browser',sub:'The lab page',domains:['UI']},
    {title:'Entry',sub:'Commands',domains:['Platform','Runtime','Host','Root','Tooling','Docs']},
    {title:'Server',sub:'HTTP routes',domains:['API']},
    {title:'Capabilities',sub:'Print loop and printer',domains:['Workshop','AI','Media']},
    {title:'Shared',sub:'Checks and geometry',domains:['Core']},
    {title:'Data',sub:'Records and history',domains:['Data']},
  ],
};
function columnsFor(model,repo){
  const present=new Set([...model.nodes.values()].map(n=>n.domain));
  const rules=Object.hasOwn(REPO_COLUMNS,repo)?REPO_COLUMNS[repo]:null;
  if(rules){
    const cols=rules.map(c=>({...c,domains:c.domains.filter(d=>present.has(d))}));
    const named=new Set(rules.flatMap(c=>c.domains));
    cols.find(c=>c.title==='Shared').domains.push(...[...present].filter(d=>!named.has(d)).sort());
    return cols.filter(c=>c.domains.length);
  }
  const {domains,links}=domainSummary({nodes:[...model.nodes.values()],edges:model.links});
  const ordered=orderDomains(domains,links).map(d=>d.id);
  const per=Math.max(1,Math.ceil(ordered.length/6)),cols=[];
  for(let i=0;i<ordered.length;i+=per){const ds=ordered.slice(i,i+per);cols.push({title:ds.join(' · '),sub:'',domains:ds});}
  return cols;
}

// Every module is one named row in its column, grouped by domain, riskiest first. Past 400 modules each domain is one
// row with a count until it is opened.
const ROW=20,COLW=152,ROWW=144,PADX=10,TOP=52;
function mapLayout(model,cols,{open=new Set(),row:ROWH=ROW}={}){
  const collapse=model.nodes.size>400;
  const rows=[],heads=[];
  let maxY=TOP;
  cols.forEach((col,ci)=>{
    const x=PADX+ci*COLW;
    let y=TOP;
    heads.push({kind:'column',x,y:18,text:col.title},{kind:'sub',x,y:34,text:col.sub});
    for(const d of col.domains){
      const list=[...model.nodes.values()].filter(n=>n.domain===d).sort((a,b)=>(Number(b.risk)||0)-(Number(a.risk)||0)||a.id.localeCompare(b.id));
      if(!list.length)continue;
      heads.push({kind:'domain',x,y:y+11,text:`${d.toUpperCase()} · ${list.length}`});
      y+=16;
      if(collapse&&!open.has(d)){rows.push({id:`domain:${d}`,domain:d,collapsed:true,count:list.length,x,y,col:ci,risk:Math.max(...list.map(n=>Number(n.risk)||0))});y+=ROWH;}
      else for(const n of list){rows.push({id:n.id,domain:d,x,y,col:ci});y+=ROWH;}
      y+=10;
    }
    maxY=Math.max(maxY,y);
  });
  return {width:PADX*2+Math.max(1,cols.length)*COLW-(COLW-ROWW),height:maxY+8,rowHeight:ROWH,colWidth:ROWW,rows,heads};
}

const short=id=>String(id).split('/').pop();
// Look here first: at most six findings, each a sentence with its reason in plain words.
function lookHereFirst(model, contractsData = null){
  const all=[...model.nodes.values()],items=[],seen=new Set();
  const add=(node,level,title,detail)=>{if(!seen.has(node)&&items.length<6){seen.add(node);items.push({node,level,title,detail});}};

  // Broken cross-system contract edges rank above any single-repo findings
  if (contractsData && Array.isArray(contractsData.contracts)) {
    for (const c of contractsData.contracts) {
      if (c.state === 'broken') {
        const title = c.provider.state === 'provider_missing'
          ? `${c.label || c.contract || c.id}: ${c.provider.repo} does not serve ${c.provider.path}`
          : `${c.label || c.contract || c.id}: consumer call missing`;
        const detail = c.provider.state === 'provider_missing'
          ? (c.provider.detail || 'Provider endpoint missing at live commit.')
          : (c.consumers.find(con => con.state === 'consumer_missing')?.detail || 'Consumer missing call at live commit.');
        const targetNode = (c.provider.repo === (state?.repo || 'localai'))
          ? c.provider.module
          : (c.consumers.find(con => con.repo === (state?.repo || 'localai'))?.module || c.provider.module);
        if (model.nodes.has(targetNode)) {
          add(targetNode, 'critical', title, detail);
        }
      }
    }
  }

  const bySource=new Map();
  for(const d of model.dangling||[])if(model.nodes.has(d.source))(bySource.get(d.source)||bySource.set(d.source,[]).get(d.source)).push(d);
  for(const [source,calls] of [...bySource].slice(0,2)){
    const more=calls.length>1?` and ${plural(calls.length-1,'other path')}`:'';
    add(source,'high',`${short(source)} calls ${calls[0].path}${more}, which nothing serves`,
      `Line ${calls[0].line||'?'} of ${source}. The call fails at run time; add the route or remove the call.`);
  }
  const hub=all.reduce((a,b)=>(!a||b.uses.size>a.uses.size?b:a),null);
  if(hub&&hub.uses.size>=10&&!testCount(hub))add(hub.id,'critical',`${short(hub.id)} wires up ${hub.uses.size} modules and no test imports it`,
    'This is where they are wired together. A smoke test that loads it would catch a broken import before deploy.');
  for(const n of all.filter(n=>n.reach>=5).sort((a,b)=>b.reach-a.reach).slice(0,2))
    add(n.id,riskLevel(n.risk),`${plural(n.reach,'module')} depend on ${short(n.id)}`,
      `A change here can reach all of them. ${testCount(n)?`${plural(testCount(n),'test')} import it.`:'No test imports it.'}`);
  for(const n of all.filter(n=>!testCount(n)&&n.usedBy.size>=2).sort((a,b)=>b.usedBy.size-a.usedBy.size).slice(0,2))
    add(n.id,'high',`${short(n.id)} is shared by ${plural(n.usedBy.size,'module')} and no test imports it`,`In ${n.domain}. Add a test before the next change to it.`);
  for(const n of all.filter(n=>(Number(n.risk)||0)>=40).sort((a,b)=>b.risk-a.risk))
    add(n.id,riskLevel(n.risk),`${short(n.id)} is ${riskLevel(n.risk)} risk (${Number(n.risk)||0} of 100)`,whyRanks(n)[0]||'');
  const calls=model.links.filter(l=>l.kind==='http').reduce((t,l)=>t+(l.paths.length||1),0);
  const note=model.version<2?'Older snapshot: rescan for HTTP links and for calls nothing serves.':
    model.dangling&&!model.dangling.length&&calls?`Every browser call to /api has a route (${plural(calls,'path')} checked).`:'';
  return {items,note};
}

// Why a module ranks where it does: the scanner's risk parts in plain words, or its counts for an older snapshot.
function whyRanks(n){
  const p=n.riskParts,out=[],pts=v=>v?` (${v>0?'+':''}${v})`:'',t=testCount(n);
  if(n.reach)out.push(`${plural(n.reach,'module')} depend on it, directly or not${pts(p?.reach)}.`);
  if(n.uses.size)out.push(`It imports ${plural(n.uses.size,'module')}${pts(p?.out)}.`);
  if(n.usedBy.size)out.push(`${plural(n.usedBy.size,'module')} import it directly${pts(p?.in)}.`);
  if(n.httpFrom.size)out.push(`${plural(n.httpFrom.size,'browser script')} call it over HTTP.`);
  out.push(t?`${plural(t,'test')} import it${pts(p?.tested)}.`:'No test imports it.');
  if(n.changed)out.push('It changed since the previous snapshot.');
  if(!p)out.push('Older snapshot: rescan to see how its score is made up.');
  return out;
}

// What each lens paints a row by. The changed lens also draws a dot, so colour is never the only signal.
function lensBand(n,lens){
  if(lens==='tests'){const t=testCount(n);return t===0?'critical':t<3?'medium':'low';}
  if(lens==='reach'){const r=n.reach||0;return r>=20?'critical':r>=8?'high':r>=2?'medium':'low';}
  if(lens==='changed')return n.changed?'changed':'quiet';
  return riskLevel(n.risk);
}

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// One line: the snapshot's date and age, and whether it is the release now running (Local AI only).
function freshnessLine(graph,release,now=Date.now()){
  const t=Date.parse(graph?.generatedAt||'');
  if(!Number.isFinite(t))return {text:'Snapshot time unknown',stale:true};
  const d=new Date(t),days=Math.max(0,Math.floor((now-t)/86400000));
  const parts=[`Snapshot ${d.getDate()} ${MONTHS[d.getMonth()]}`,days===0?'today':`${plural(days,'day')} old`];
  if(!release?.commit)return {text:parts.join(' · '),stale:false};
  const mine=String(graph.snapshot?.commit||''),live=String(release.commit);
  const same=mine?mine.startsWith(live)||live.startsWith(mine):t>=Date.parse(release.deployedAt||'');
  if(same){if(mine)parts.push('the running release');return {text:parts.join(' · '),stale:false};}
  const older=t<Date.parse(release.deployedAt||'');
  parts.push(`${older?'older than':'not'} the running release ${live.slice(0,7)}`);
  return {text:parts.join(' · '),stale:true};
}

// The repository and commit picker (plan PR 3). Commit "" is Local AI's latest scan: the one graph the intelligence
// service reads. Every other choice is a kept snapshot, at most five per repository, newest first as the server sends.
const repoNames={localai:'Local AI','pi-hub':'Pi Hub','print-lab':'Print lab'};
const repoLabel=repo=>repoNames[repo]||String(repo);

function snapshotChoices(list){
  const repos=['localai',...(Array.isArray(list?.repos)?list.repos.map(String).filter(r=>r!=='localai'):[])];
  const byRepo=new Map(repos.map(r=>[r,[]]));
  for(const row of Array.isArray(list?.snapshots)?list.snapshots:[]){
    if(byRepo.has(row?.repo)&&/^[0-9a-f]{40}$/.test(String(row.commit)))byRepo.get(row.repo).push(row);
  }
  return byRepo;
}

function ago(iso,now=Date.now()){
  const t=Date.parse(iso||'');
  if(!Number.isFinite(t))return '';
  const minutes=Math.max(0,Math.round((now-t)/60000));
  if(minutes<1)return 'just now';
  if(minutes<60)return `${minutes} min ago`;
  const hours=Math.round(minutes/60);
  return hours<48?`${hours} h ago`:`${Math.round(hours/24)} days ago`;
}

function commitLabel(row,newest,now=Date.now()){
  const when=ago(row.committedAt,now);
  return `${row.commit.slice(0,7)}${when?` · ${when}`:''}${newest?' (newest)':''}`;
}

// What the chosen snapshot is, and whether a newer one of the same repository exists.
function snapshotNote(row,rows,now=Date.now()){
  if(!row)return {text:'',stale:false};
  const when=ago(row.committedAt,now);
  const newest=rows[0];
  const stale=!!newest&&newest.commit!==row.commit;
  const parts=[`Commit ${row.commit.slice(0,7)}`,when?`committed ${when}`:'commit time unknown'];
  if(stale)parts.push(`a newer snapshot exists (${newest.commit.slice(0,7)})`);
  return {text:parts.join(' · '),stale};
}

// "Snapshot now" (plan PR 4): one line for a job the PC is running or has finished.
function snapshotStateText(job){
  if(!job)return '';
  const name=repoLabel(job.repo);
  if(job.state==='queued')return `A snapshot of ${name} is queued…`;
  if(job.state==='running')return `Taking a snapshot of ${name} at ${job.ref}…`;
  if(job.state==='done')return `The snapshot of ${name} at ${String(job.commit||'').slice(0,7)} is ready.`;
  return `The snapshot of ${name} failed: ${job.error||'no reason given'}`;
}

Object.assign(exported,{plural,riskLevel,domainSummary,orderDomains,buildModel,columnsFor,mapLayout,lookHereFirst,whyRanks,
  lensBand,freshnessLine,snapshotStateText,snapshotChoices,commitLabel,snapshotNote});
if(typeof module==='object'&&module.exports){module.exports=exported;return;}

const page=document.getElementById('architecture');
if(!page)return;
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reduceMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
// A row is a 44 px tap target on a touch screen or a phone, and a 20 px line where a pointer is precise.
const rowHeight=()=>matchMedia('(pointer: coarse), (max-width: 700px)').matches?44:ROW;
const state={
  active:false,summary:null,graph:null,model:null,layout:null,selected:null,details:null,
  lens:'risk',ollamaModel:localStorage.getItem('localai.atlas.model')||'',request:null,
  repo:'localai',commit:'',snapshots:null,seq:0,releases:null,open:new Set(),
  contracts:null,contractsOpen:false
};
// Intelligence about the chosen snapshot (plan PR 5); with neither, the latest scan.
const live=()=>state.repo==='localai'&&!state.commit;
const scope=()=>live()?{}:{repo:state.repo,commit:state.commit};
const scoped=url=>live()?url:`${url}${url.includes('?')?'&':'?'}repo=${encodeURIComponent(state.repo)}&commit=${encodeURIComponent(state.commit)}`;

function status(text,tone='neutral'){
  const el=$('atlasWebStatus');
  el.textContent=text;
  el.dataset.tone=tone;
}

async function getJson(url,options={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),options.timeout||12000);
  try{
    const response=await fetch(url,{...options,signal:controller.signal,cache:'no-store',headers:{Accept:'application/json',...(options.headers||{})}});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload?.error?.message||payload?.error||`HTTP ${response.status}`);
    return payload;
  }finally{clearTimeout(timer);}
}

function setBusy(value){
  page.setAttribute('aria-busy',String(!!value));
  $('atlasRefresh').disabled=!!value;
}

function providerBadge(){
  const p=state.summary?.providers||{};
  const ollama=p.ollama||{};
  const goose=p.goose||{};
  $('atlasOllamaState').textContent=ollama.available?`Ollama · ${ollama.defaultModel||'ready'}`:'Ollama unavailable';
  $('atlasOllamaState').dataset.ready=ollama.available?'1':'0';
  $('atlasGooseState').textContent=goose.available?'Goose · ready':'Goose · optional';
  $('atlasGooseState').dataset.ready=goose.available?'1':'0';
  const select=$('atlasModel');
  const models=Array.isArray(ollama.models)?ollama.models:[];
  const chosen=state.ollamaModel&&models.includes(state.ollamaModel)?state.ollamaModel:'';
  select.innerHTML=`<option value="">Auto${ollama.defaultModel?` — ${esc(ollama.defaultModel)}`:''}</option>`+
    models.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('');
  select.value=chosen;
}

function setMapState(kind,text){
  const wrap=$('atlasMap').closest('.atlas-map-wrap');
  wrap.dataset.state=kind;
  $('atlasMapState').textContent=text;
  $('atlasMapState').hidden=!text;
}

const query=()=>$('atlasNodeSearch').value.trim().toLowerCase();
const matches=(n,q)=>`${n.id} ${n.domain||''}`.toLowerCase().includes(q);
const fit=(text,room)=>text.length>room?`${text.slice(0,room-1)}…`:text;
const LEVEL={critical:'Critical',high:'High',medium:'Medium',low:'Low'};

// The map: columns of named rows, links drawn as curves under them (HTTP calls dashed).
function drawMap(){
  const svg=$('atlasMap'),m=state.model;
  if(!m||!m.nodes.size){svg.innerHTML='';state.layout=null;setMapState(m?'empty':'loading',m?'No production modules in this snapshot.':'Reading the graph…');return;}
  const lay=state.layout=mapLayout(m,columnsFor(m,state.repo),{open:state.open,row:rowHeight()});
  const H=lay.rowHeight,mid=H/2;
  const rowOf=new Map();
  for(const r of lay.rows){if(r.collapsed){for(const n of m.nodes.values())if(n.domain===r.domain)rowOf.set(n.id,r);}else rowOf.set(r.id,r);}
  const sel=state.selected&&m.nodes.get(state.selected);
  const near=sel?new Set([sel.id,...sel.uses,...sel.usedBy,...sel.httpTo,...sel.httpFrom]):null;
  const q=query();
  const heads=lay.heads.map(h=>`<text class="atlas-${h.kind}" x="${h.x}" y="${h.y}">${esc(fit(h.text,h.kind==='column'?20:24))}</text>`).join('');
  const drawn=new Set(),edges=[];
  for(const l of m.links){
    const a=rowOf.get(l.source),b=rowOf.get(l.target);
    if(!a||!b||a===b)continue;
    const key=`${a.id}\u0000${b.id}\u0000${l.kind}`;if(drawn.has(key))continue;drawn.add(key);
    let cls=`atlas-edge${l.kind==='http'?' atlas-edge--http':''}`;
    if(sel)cls+=l.source===sel.id?' is-out':l.target===sel.id?' is-in':' is-dim';
    const y1=a.y+mid-1,y2=b.y+mid-1;
    let d;
    if(b.col>a.col){const x1=a.x+ROWW-6,x2=b.x-4,mx=(x1+x2)/2;d=`M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;}
    else{const lx=Math.min(a.x,b.x)-12;d=`M${a.x-4} ${y1}C${lx} ${y1} ${lx} ${y2} ${b.x-4} ${y2}`;}
    edges.push(`<path class="${cls}" d="${d}"></path>`);
  }
  const rows=lay.rows.map(r=>{
    if(r.collapsed)return `<g class="atlas-row atlas-row--domain" data-atlas-domain="${esc(r.domain)}" tabindex="0" role="button" aria-label="${esc(r.domain)}: ${plural(r.count,'module')}, highest risk ${r.risk}. Opens the domain.">
      <rect class="atlas-hit" x="${r.x-4}" y="${r.y}" width="${ROWW}" height="${H}" rx="3"></rect>
      <text x="${r.x+4}" y="${r.y+mid+3}">${esc(plural(r.count,'module'))} · open</text></g>`;
    const n=m.nodes.get(r.id),t=testCount(n);
    const cls=['atlas-row'];
    if(sel&&n.id===sel.id)cls.push('is-sel');else if(near&&!near.has(n.id))cls.push('is-dim');
    if(q&&matches(n,q))cls.push('is-match');else if(q&&!sel)cls.push('is-dim');
    const bar=Math.max(3,Math.min(24,3+(n.uses.size+n.usedBy.size+n.httpFrom.size)*1.2));
    return `<g class="${cls.join(' ')}" data-atlas-node="${esc(n.id)}" data-band="${lensBand(n,state.lens)}" tabindex="0" role="button" aria-pressed="${!!(sel&&n.id===sel.id)}" aria-label="${esc(n.id)}: ${LEVEL[riskLevel(n.risk)]} risk ${Number(n.risk)||0}, ${plural(n.reach,'module')} depend on it, ${plural(t,'test')}${n.changed?', changed':''}">
      <rect class="atlas-hit" x="${r.x-4}" y="${r.y}" width="${ROWW}" height="${H}" rx="3"></rect>
      <rect class="atlas-bar" x="${r.x}" y="${r.y+mid-5}" width="${bar.toFixed(1)}" height="8" rx="2"></rect>
      <text x="${r.x+30}" y="${r.y+mid+3}">${esc(fit(short(n.id),17))}</text>${n.changed?`<circle class="atlas-dot" cx="${r.x+ROWW-12}" cy="${r.y+mid-1}" r="3"></circle>`:''}</g>`;
  }).join('');
  svg.setAttribute('width',lay.width);svg.setAttribute('height',lay.height);svg.setAttribute('viewBox',`0 0 ${lay.width} ${lay.height}`);
  svg.dataset.lens=state.lens;
  svg.toggleAttribute('data-focus',!!sel);
  svg.innerHTML=`<g class="atlas-heads">${heads}</g><g class="atlas-edges">${edges.join('')}</g><g class="atlas-rows">${rows}</g>`;
  setMapState('','');
}

function renderHeader(){
  const m=state.model,sel=state.selected&&m?.nodes.get(state.selected);
  $('atlasMapTitle').textContent=`${repoLabel(state.repo)} · how modules depend on each other`;
  const http=m?m.links.filter(l=>l.kind==='http').length:0;
  $('atlasMapHint').textContent=!m?'':sel?`${short(sel.id)} uses ${plural(sel.uses.size,'module')} and ${plural(sel.usedBy.size,'module')} use it.`:
    `${plural(m.nodes.size,'module')} · ${plural(m.links.length-http,'import')}${m.version>=2?` · ${plural(http,'HTTP link')}`:''}. Callers on the left, what they use on the right.`;
  $('atlasMapBack').hidden=!sel;
  $('atlasMapBack').textContent='Clear selection';
}

const key=(band,text)=>`<span class="atlas-key"><span class="atlas-swatch" data-band="${band}"></span>${esc(text)}</span>`;
function renderLegend(){
  const el=$('atlasLegend');
  if(!state.model)return void(el.innerHTML='');
  const since=state.graph?.snapshot?.changedSince;
  const parts={
    risk:[key('critical','Critical'),key('high','High'),key('medium','Medium'),key('low','Low risk')],
    tests:[key('critical','No test imports it'),key('medium','1–2 tests'),key('low','3 or more')],
    reach:[key('critical','20+ depend on it'),key('high','8–19'),key('medium','2–7'),key('low','0–1')],
    changed:[key('changed',since?`Changed since ${String(since).slice(0,7)} (with a dot)`:'Changed (with a dot)'),key('quiet','Unchanged')],
  }[state.lens];
  parts.push('<span class="atlas-key"><span class="atlas-line"></span>imports</span>','<span class="atlas-key"><span class="atlas-line atlas-line--http"></span>HTTP calls</span>');
  if(state.selected)parts.push('<span class="atlas-key"><span class="atlas-line atlas-line--out"></span>uses</span>','<span class="atlas-key"><span class="atlas-line atlas-line--in"></span>used by</span>');
  if(state.lens==='changed'&&live()&&![...state.model.nodes.values()].some(n=>n.changed))
    parts.push('<span class="atlas-key">The latest scan reads the deploy checkout, which has no edits: choose a snapshot to see what changed.</span>');
  el.innerHTML=parts.join('');
}

function renderFindings(){
  const box=$('atlasFindingList');
  if(!state.model){box.innerHTML='<p class="atlas-empty">Findings appear once the map has loaded.</p>';$('atlasFindingNote').textContent='';return;}
  const {items,note}=lookHereFirst(state.model, state.contracts);
  box.innerHTML=items.map(f=>`<button type="button" class="atlas-finding" data-level="${f.level}" data-atlas-node="${esc(f.node)}">
    <span class="atlas-finding-level">${LEVEL[f.level]} · ${esc(state.model.nodes.get(f.node)?.domain||'')}</span><strong>${esc(f.title)}</strong><span>${esc(f.detail)}</span></button>`).join('')||
    '<p class="atlas-empty">Nothing stands out: no module is both widely used and untested.</p>';
  $('atlasFindingNote').textContent=note;
}

const listOf=(ids,empty,attr='data-atlas-node')=>(ids=[...ids]).length?`<ul>${ids.map(id=>state.model.nodes.get(id)).filter(Boolean)
  .sort((a,b)=>(Number(b.risk)||0)-(Number(a.risk)||0)||a.id.localeCompare(b.id)).map(n=>
  `<li><button type="button" ${attr}="${esc(n.id)}" data-band="${lensBand(n,state.lens)}"><span>${esc(n.id)}</span><small>${esc(n.domain)} · risk ${Number(n.risk)||0}</small></button></li>`).join('')}</ul>`:
  `<p class="atlas-muted">${esc(empty)}</p>`;
const figs=pairs=>pairs.map(([k,v])=>`<div><strong>${esc(v)}</strong><span>${esc(k)}</span></div>`).join('');

function renderInspector(){
  const m=state.model,n=state.selected&&m?.nodes.get(state.selected);
  $('atlasSelectedEmpty').hidden=!!n;
  $('atlasSelectedBody').hidden=!n;
  renderAskControls();
  if(!n){
    const all=m?[...m.nodes.values()]:[];
    $('atlasNodeStats').innerHTML=m?figs([['modules',all.length],['imports',m.links.filter(l=>l.kind==='import').length],
      ['HTTP links',m.version>=2?m.links.filter(l=>l.kind==='http').length:'—'],['untested',all.filter(x=>!testCount(x)).length]]):'';
    for(const id of ['atlasWhy','atlasNodeLinks'])$(id).innerHTML='';
    $('atlasEvidenceList').innerHTML='';
    page.querySelector('.atlas-why-head').hidden=page.querySelector('.atlas-tests-head').hidden=true;
    return;
  }
  page.querySelector('.atlas-why-head').hidden=page.querySelector('.atlas-tests-head').hidden=false;
  const level=riskLevel(n.risk);
  $('atlasSelectedPath').textContent=short(n.id);
  $('atlasSelectedMeta').innerHTML=`<code>${esc(n.id)}</code><span>${esc(n.domain)}</span><span class="atlas-chip" data-band="${level}">${LEVEL[level]} risk · ${Number(n.risk)||0}/100</span>${n.changed?'<span class="atlas-chip">Changed</span>':''}`;
  $('atlasNodeStats').innerHTML=figs([['uses',n.uses.size],['used by',n.usedBy.size],['affected',n.reach],['tests',testCount(n)]]);
  $('atlasWhy').innerHTML=whyRanks(n).map(s=>`<li>${esc(s)}</li>`).join('');
  const groups=[['Uses',n.uses,'It imports nothing in this repository.','uses'],['Used by',n.usedBy,'Nothing imports it: an entry point, or loaded by the browser.','usedby']];
  if(n.httpTo.size)groups.push(['Calls over HTTP',n.httpTo,'','http']);
  if(n.httpFrom.size)groups.push(['Called over HTTP by',n.httpFrom,'','http']);
  $('atlasNodeLinks').innerHTML=groups.map(([title,ids,empty,kind])=>`<div class="atlas-links-group atlas-links--${kind}"><h3 class="atlas-section-label">${title} <span>${ids.size}</span></h3>${listOf(ids,empty)}</div>`).join('');

  // Cross-system contract links in inspector (Atlas across repos, PR 4)
  if (state.contracts && Array.isArray(state.contracts.contracts)) {
    const curRepo = state.repo || 'localai';
    const provided = state.contracts.contracts.filter(c => c.provider.repo === curRepo && c.provider.module === n.id);
    const consumed = state.contracts.contracts.filter(c => (c.consumers || []).some(con => con.repo === curRepo && con.module === n.id));

    if (provided.length) {
      const consumersList = provided.flatMap(c => (c.consumers || []).map(con => ({
        contract: c.label || c.contract || c.id,
        repo: con.repo,
        module: con.module,
        state: con.state
      })));
      const crossHtml = `<div class="atlas-links-group atlas-links--cross"><h3 class="atlas-section-label">Other systems that call this <span>${consumersList.length}</span></h3><ul>${
        consumersList.map(c => `<li><button type="button" class="atlas-host-repo" data-atlas-cross-repo="${esc(c.repo)}" data-atlas-cross-module="${esc(c.module)}"><span>${esc(c.repo)} · ${esc(c.module)}</span><small>${esc(c.contract)} · ${esc(c.state.replace(/_/g, ' '))}</small></button></li>`).join('')
      }</ul></div>`;
      $('atlasNodeLinks').insertAdjacentHTML('beforeend', crossHtml);
    }

    if (consumed.length) {
      const crossHtml = `<div class="atlas-links-group atlas-links--cross"><h3 class="atlas-section-label">Calls to other systems <span>${consumed.length}</span></h3><ul>${
        consumed.map(c => `<li><button type="button" class="atlas-host-repo" data-atlas-cross-repo="${esc(c.provider.repo)}" data-atlas-cross-module="${esc(c.provider.module)}"><span>${esc(c.provider.repo)} · ${esc(c.provider.module)}</span><small>${esc(c.label || c.contract || c.id)} (${esc(c.provider.method)} ${esc(c.provider.path)})</small></button></li>`).join('')
      }</ul></div>`;
      $('atlasNodeLinks').insertAdjacentHTML('beforeend', crossHtml);
    }
  }
  const evidence=(Array.isArray(state.details?.node?.testEvidence)?state.details.node.testEvidence:[]).map(e=>e.test||e.path).filter(t=>t&&!n.tests.includes(t));
  $('atlasEvidenceList').innerHTML=[...n.tests.map(t=>`<li><code>${esc(t)}</code><span>imports it</span></li>`),
    ...evidence.slice(0,8).map(t=>`<li><code>${esc(t)}</code><span>runs it</span></li>`)].join('')||'<li class="atlas-muted">None.</li>';
}

// Ask, Goose and the model need a graph; the quick questions are about a module, so they also need one.
function renderAskControls(){
  const off=!state.graph||state.asking;
  for(const el of [$('atlasAsk'),$('atlasGoose'),$('atlasModel'),$('atlasQuestion')])el.disabled=off;
  for(const el of page.querySelectorAll('[data-atlas-question]'))el.disabled=off||!state.selected;
}

// Crossing the phone width (or rotating a tablet) changes the row height: draw the map again.
let resizeTimer=null;
root.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{
  if(state.active&&state.layout&&state.layout.rowHeight!==(rowHeight()))drawMap();
},200);});

function renderContracts(){
  const summaryEl = $('atlasContractsSummary');
  const bodyEl = $('atlasContractsBody');
  const toggleEl = $('atlasContractsToggle');
  const listEl = $('atlasContractsList');
  if (!summaryEl || !bodyEl || !toggleEl || !listEl) return;

  toggleEl.setAttribute('aria-expanded', String(state.contractsOpen));
  bodyEl.hidden = !state.contractsOpen;

  if (!state.contracts) {
    summaryEl.textContent = 'Checking contracts…';
    summaryEl.dataset.tone = '';
    listEl.innerHTML = '<p class="atlas-muted">Reading contract declarations…</p>';
    return;
  }

  const { contracts = [], brokenCount = 0, commits = {} } = state.contracts;
  const commitParts = Object.entries(commits).map(([repo, c]) => `${repoNames[repo] || repo} ${short(c)}`);
  const headerCommits = commitParts.length ? ` · ${commitParts.join(' · ')}, the live releases` : '';

  if (brokenCount > 0) {
    summaryEl.textContent = `${plural(brokenCount, 'broken contract edge')} at the live commits${headerCommits}`;
    summaryEl.dataset.tone = 'error';
  } else {
    const total = contracts.length;
    summaryEl.textContent = `All ${total} contracts checked at the live commits${headerCommits}`;
    summaryEl.dataset.tone = 'ok';
  }

  listEl.innerHTML = contracts.map(c => {
    const name = c.label || c.contract || c.id;
    const p = c.provider;
    const pRepoName = repoNames[p.repo] || p.repo;
    const pChip = `<button type="button" class="atlas-contract-chip" data-atlas-cross-repo="${esc(p.repo)}" data-atlas-cross-module="${esc(p.module)}" aria-label="Open ${esc(pRepoName)} map at ${esc(p.module)}"><span>${esc(pRepoName)}</span><code>${esc(p.module)}</code><span>${esc(p.method)} ${esc(p.path)}</span></button>`;

    const consumersHtml = (c.consumers || []).map(con => {
      const cRepoName = repoNames[con.repo] || con.repo;
      const isMapped = ['localai', 'pi-hub', 'print-lab'].includes(con.repo);
      return isMapped
        ? `<button type="button" class="atlas-contract-chip" data-atlas-cross-repo="${esc(con.repo)}" data-atlas-cross-module="${esc(con.module)}" aria-label="Open ${esc(cRepoName)} map at ${esc(con.module)}"><span>${esc(cRepoName)}</span><code>${esc(con.module)}</code></button>`
        : `<span class="atlas-contract-chip"><span>${esc(cRepoName)}</span><code>${esc(con.module)}</code></span>`;
    }).join(' ');

    let statusText = 'Checked at live commits';
    let statusState = c.state;
    if (c.state === 'broken') {
      statusText = p.state === 'provider_missing' ? p.detail : (c.consumers.find(con => con.state === 'consumer_missing')?.detail || 'Broken edge');
    } else if (c.state === 'partially_checked') {
      const unmapped = c.consumers.find(con => con.state === 'not_checked');
      statusText = unmapped ? `Not checked (${unmapped.detail})` : 'Partially checked';
    }

    return `<div class="atlas-contract-row" data-contract-id="${esc(c.id)}">
      <div class="atlas-contract-name">${esc(name)}</div>
      <div class="atlas-contract-provider">${pChip}</div>
      <div class="atlas-contract-consumers">${consumersHtml}</div>
      <div><span class="atlas-contract-status" data-state="${esc(statusState)}">${esc(statusText)}</span></div>
    </div>`;
  }).join('');
}

async function loadContracts(){
  try {
    const data = await getJson('/api/atlas/contracts', { timeout: 12000 });
    state.contracts = data;
  } catch (err) {
    state.contracts = { error: err.message, contracts: [], brokenCount: 0 };
  }
  renderContracts();
  renderFindings();
  if (state.selected) renderInspector();
}

function render(){drawMap();renderHeader();renderLegend();renderFindings();renderInspector();renderSearchResults();renderContracts();}

// The chosen row, scrolled into the middle of the map's frame.
function revealRow(id){
  const r=state.layout?.rows.find(x=>x.id===id);if(!r)return;
  const wrap=$('atlasMap').closest('.atlas-map-wrap');
  wrap.scrollTo({left:Math.max(0,r.x-120),top:Math.max(0,r.y-wrap.clientHeight/2),behavior:reduceMotion()?'auto':'smooth'});
}

// On one column the inspector sits below the map: bring it into view when someone picks a module there.
function revealInspector(){
  if(!matchMedia('(max-width: 1100px)').matches)return;
  page.querySelector('.atlas-inspector').scrollIntoView({block:'start',behavior:reduceMotion()?'auto':'smooth'});
  $('atlasSelectedPath').focus({preventScroll:true});
}

async function selectNode(id,{scroll=false,reveal=false}={}){
  const n=state.model?.nodes.get(id);
  if(!n)return;
  state.selected=id;state.details=null;
  state.open.add(n.domain);
  render();
  if(scroll)revealRow(id);
  if(reveal)revealInspector();
  const seq=state.seq;
  let details=null;
  try{details=await getJson(scoped(`/api/atlas/node?path=${encodeURIComponent(id)}`),{timeout:live()?12000:62000});}catch{}
  // Another module or snapshot chosen meanwhile: these details are not its.
  if(seq!==state.seq||state.selected!==id)return;
  state.details=details;
  renderInspector();
}

function clearSelection(){state.selected=null;state.details=null;render();}
function focusRow(id){($('atlasMap').querySelector(id?`[data-atlas-node="${CSS.escape(id)}"]`:'.atlas-row')||$('atlasMapTitle')).focus();}
// Escape leaves the selection; when focus was in the inspector (now hidden) it returns to that module's row.
function leaveSelection(){const id=state.selected;const inside=page.querySelector('.atlas-inspector')?.contains(document.activeElement);clearSelection();if(inside||document.activeElement===document.body)focusRow(id);}

function renderSearchResults(){
  const q=query(),box=$('atlasSearchResults');
  const rows=q&&state.model?[...state.model.nodes.values()].filter(n=>matches(n,q)).slice(0,12):[];
  box.hidden=!rows.length||state.resultsClosed;
  box.innerHTML=rows.map(n=>`<button type="button" data-atlas-node="${esc(n.id)}"><span>${esc(n.id)}</span><small>${esc(n.domain)} · risk ${Number(n.risk)||0}</small></button>`).join('');
}

function renderLenses(){
  for(const b of page.querySelectorAll('[data-atlas-lens]'))b.setAttribute('aria-pressed',String(b.dataset.atlasLens===state.lens));
}

function renderPicker(){
  const repos=[...state.snapshots.keys()];
  const rows=state.snapshots.get(state.repo)||[];
  $('atlasRepo').innerHTML=repos.map(r=>`<option value="${esc(r)}">${esc(repoLabel(r))}</option>`).join('');
  $('atlasRepo').value=state.repo;
  const options=rows.map((r,i)=>`<option value="${esc(r.commit)}">${esc(commitLabel(r,i===0))}</option>`);
  if(state.repo==='localai')options.unshift('<option value="">Latest scan</option>');
  const commit=$('atlasCommit');
  commit.innerHTML=options.join('')||'<option value="">No snapshots yet</option>';
  commit.disabled=!options.length;
  commit.value=state.commit;
  const note=state.commit?snapshotNote(rows.find(r=>r.commit===state.commit),rows):
    {text:state.repo==='localai'?'The deploy checkout, as last scanned.':'',stale:false};
  $('atlasSourceNote').textContent=note.text;
  $('atlasSourceNote').dataset.tone=note.stale?'warn':'';
  renderAskControls();
}

function clearGraph(title,hint,kind='loading'){
  state.graph=null;state.model=null;state.layout=null;state.summary=null;state.selected=null;state.details=null;state.open=new Set();
  $('atlasMap').innerHTML='';
  setMapState(kind,kind==='loading'?'Reading the graph…':hint);
  $('atlasNodeSearch').value='';
  providerBadge();renderHeader();renderLegend();renderFindings();renderInspector();renderSearchResults();
  $('atlasMapTitle').textContent=title;
  $('atlasAnswer').hidden=true;
}

async function refresh(){
  // A newer refresh (another repository or commit chosen meanwhile) supersedes this one: its results are dropped.
  const seq=++state.seq;
  page.dispatchEvent(new CustomEvent('atlas:source',{detail:{repo:state.repo,commit:state.commit}}));
  setBusy(true);status(`Loading ${repoLabel(state.repo)}…`);
  try{
    const listed=await getJson('/api/atlas/snapshots',{timeout:12000}).catch(error=>({_error:error.message}));
    if(seq!==state.seq||!state.active)return;
    if(!listed._error||!state.snapshots)state.snapshots=snapshotChoices(listed._error?null:listed);
    let unknown=null;
    if(!state.snapshots.has(state.repo)){if(state.repo!=='localai')unknown=state.repo;state.repo='localai';state.commit='';}
    // Only the newest five per repository are kept: a commit retired since it was chosen falls back to the newest.
    const rows=state.snapshots.get(state.repo);
    let retired=false;
    // A link may name an abbreviated commit (Pi Hub's Versions): it means the one snapshot it starts.
    if(state.commit&&state.commit.length<40){const m=rows.filter(r=>r.commit.startsWith(state.commit));if(m.length===1)state.commit=m[0].commit;}
    if(state.commit&&!rows.some(r=>r.commit===state.commit)){state.commit=rows[0]?.commit||'';retired=true;}
    // A repository chosen before its list arrived (or while the list was unavailable) gets its newest snapshot now.
    if(state.repo!=='localai'&&!state.commit)state.commit=rows[0]?.commit||'';
    renderPicker();
    if(state.repo!=='localai'&&!state.commit){
      clearGraph(`No snapshots of ${repoLabel(state.repo)} yet`,`Nothing to draw yet. Snapshot now maps ${repoLabel(state.repo)}'s main in a few minutes.`,'empty');
      status(listed._error?`The snapshot list is unavailable: ${listed._error}`:`No snapshots of ${repoLabel(state.repo)} yet.`,listed._error?'error':'neutral');
      return;
    }
    const url=live()?'/api/atlas/graph':`/api/atlas/graph?repo=${encodeURIComponent(state.repo)}&commit=${encodeURIComponent(state.commit)}`;
    const [graph,summary,releases]=await Promise.all([
      getJson(url,{timeout:12000}),
      getJson(scoped('/api/atlas/summary'),{timeout:live()?12000:62000}).catch(error=>({providers:{},_error:error.message})),
      state.repo==='localai'?getJson('/api/releases',{timeout:8000}).catch(()=>null):null
    ]);
    if(seq!==state.seq||!state.active)return;
    state.graph=graph;state.summary=summary;state.model=buildModel(graph);
    if(state.selected&&!state.model.nodes.has(state.selected))state.selected=null;
    providerBadge();render();
    if(state.selected)await selectNode(state.selected);
    if(seq!==state.seq)return;
    // Say plainly when the map is old, partial or missing its change data, rather than looking complete.
    const caveats=[];
    if(unknown)caveats.push(`no snapshots of ${unknown} are kept, so this is Local AI`);
    if(retired)caveats.push('the chosen commit is no longer kept, so this is the newest snapshot');
    if(listed._error)caveats.push(`the snapshot list is unavailable: ${listed._error}`);
    if(graph.stale)caveats.push('showing the last good graph; the newest copy could not be read');
    if(graph.stats?.truncated)caveats.push(`only the first ${graph.stats.maxFiles} files were scanned`);
    if(graph.stats?.gitError)caveats.push('changed files are unknown (git failed)');
    if(state.model.version<2)caveats.push('older snapshot: rescan for HTTP links');
    if(summary?._error)caveats.push(`Ask and Goose are offline: ${summary._error}`);
    const fresh=freshnessLine(graph,state.repo==='localai'?releases?.current:null);
    status(`${fresh.text}.${caveats.length?` Also: ${caveats.map(c=>c.replace(/\.+$/,'')).join('; ')}.`:''}`,fresh.stale||caveats.length?'warn':'ok');
  }catch(error){
    if(seq!==state.seq||!state.active)return;
    if(!state.graph)clearGraph(`${repoLabel(state.repo)} could not be loaded`,'The graph could not be read. Try Refresh, or choose another commit.','error');
    status(error.name==='AbortError'?'Loading the map timed out.':error.message,'error');
  }finally{if(seq===state.seq)setBusy(false);}
}

const snapshotRun={job:null,timer:null};
const inFlight=job=>!!job&&(job.state==='queued'||job.state==='running');

function showSnapshotState(job,text,tone){
  const el=$('atlasSnapshotState');
  el.textContent=text??snapshotStateText(job);
  el.hidden=!el.textContent;
  el.dataset.tone=tone??(job?.state==='failed'?'error':job?.state==='done'?'ok':'');
  $('atlasSnapshotNow').disabled=inFlight(job);
}

// Ask the PC to fetch the chosen repository's main and scan it. Signed-in only; one run at a time on the PC.
async function snapshotNow(){
  $('atlasSnapshotNow').disabled=true;
  try{
    const {job}=await getJson('/api/atlas/snapshot',{method:'POST',timeout:15000,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({repo:state.repo,ref:'main'})});
    snapshotRun.job=job;snapshotRun.from={repo:state.repo,commit:state.commit};showSnapshotState(job);pollSnapshot();
  }catch(error){
    const signIn=/\b401\b|sign.?in/i.test(error.message);
    showSnapshotState(null,signIn?'Sign in to take a snapshot.':`The snapshot could not start: ${error.message}`,'error');
  }
}

function pollSnapshot(){
  clearTimeout(snapshotRun.timer);
  if(!inFlight(snapshotRun.job))return;
  snapshotRun.timer=setTimeout(async()=>{
    if(!state.active)return;
    let status;
    try{status=await getJson('/api/atlas/snapshot',{timeout:8000});}catch{return pollSnapshot();}
    const id=snapshotRun.job?.id;
    const job=[status.running,...(status.queued||[]),...(status.recent||[])].find(j=>j&&j.id===id);
    if(!job){
      snapshotRun.job=null;
      return showSnapshotState(null,'The snapshot service restarted before this snapshot finished; try again.','warn');
    }
    snapshotRun.job=job;showSnapshotState(job);
    if(inFlight(job))return pollSnapshot();
    // Done: the list gains the new commit; on the same repository, show it.
    // Done: show it, unless another commit was chosen while it ran.
    const from=snapshotRun.from;
    if(job.state==='done'&&job.repo===state.repo&&(!from||(from.repo===state.repo&&from.commit===state.commit)))state.commit=job.commit;
    if(job.state==='done')void refresh();
  },3000);
}

function chooseSource(repo,commit){
  state.repo=repo;state.commit=commit;
  clearGraph('Loading…','');
  void refresh();
}

// One question at a time, about the snapshot on screen: an answer that arrives after another snapshot was chosen is
// dropped, and it names the module that was asked about, not whatever is selected by then.
async function askWith(loading,send,show){
  if(state.asking||!state.graph)return;
  const seq=state.seq,node=state.selected;
  state.asking=true;renderAskControls();
  const box=$('atlasAnswer');box.hidden=false;box.dataset.tone='loading';box.textContent=loading;
  try{
    const payload=await send(node);
    if(seq!==state.seq)return;
    box.dataset.tone='ok';box.textContent=show(payload,node);
  }catch(error){
    if(seq!==state.seq)return;
    box.dataset.tone='error';box.textContent=error.name==='AbortError'?'The request timed out in the browser.':error.message;
  }finally{state.asking=false;renderAskControls();}
}

function askAtlas(question){
  const q=String(question||$('atlasQuestion').value).trim();
  if(!q)return $('atlasQuestion').focus();
  $('atlasQuestion').value=q;
  return askWith('Analyzing bounded Atlas evidence…',
    node=>getJson('/api/atlas/ask',{method:'POST',timeout:310000,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...scope(),question:q,node:node||undefined,model:state.ollamaModel||undefined})}),
    (payload,node)=>`${payload.answer||'No answer returned.'}\n\nModel: ${payload.model||'unknown'}${node?`\nNode: ${node}`:''}`
      +(Array.isArray(payload.leftOut)?`\nLeft out to fit: ${payload.leftOut.length?payload.leftOut.join('; '):'nothing'}`:''));
}

function gooseBrief(){
  const q=$('atlasQuestion').value.trim()||`Investigate the highest-priority architecture evidence${state.selected?` for ${state.selected}`:''}.`;
  return askWith('Preparing read-only Goose investigation brief…',
    node=>getJson('/api/atlas/goose',{method:'POST',timeout:live()?15000:62000,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...scope(),question:q,node:node||undefined})}),
    payload=>`Read-only investigation brief created:\n${payload.briefPath||'Atlas investigation directory'}\n\n${payload.goose?.available?'Goose CLI detected.':'Goose is not on PATH; the brief is still ready for later investigation.'}`);
}

// #architecture?repo=<r>&commit=<sha>, as Pi Hub's Versions links each row ("Architecture at this commit"): that
// snapshot. Returns true when the hash named one (the refresh then loads it).
function fromHash(){
  const raw=String(location.hash||''),i=raw.indexOf('?');
  if(!/^#\/?architecture\?/.test(raw)||i<0)return false;
  const q=new URLSearchParams(raw.slice(i+1)),repo=(q.get('repo')||'').toLowerCase(),commit=(q.get('commit')||'').toLowerCase();
  if(!/^[a-z0-9-]{1,40}$/.test(repo)||!/^[0-9a-f]{7,40}$/.test(commit))return false;
  if(repo===state.repo&&(state.commit===commit||state.commit.startsWith(commit)))return false;
  chooseSource(repo,commit);
  return true;
}
function activate(){
  if(state.active)return;
  state.active=true;
  if(!fromHash()&&!state.graph)void refresh();
  void loadContracts();
  pollSnapshot();
}
root.addEventListener('hashchange',()=>{if(state.active)fromHash();});
function deactivate(){state.active=false;state.request?.abort?.();state.request=null;clearTimeout(snapshotRun.timer);}

const pick=(e,opts)=>{
  const n=e.target.closest('[data-atlas-node]');if(n){void selectNode(n.dataset.atlasNode,opts);return true;}
  const d=e.target.closest('[data-atlas-domain]');if(d){state.open.add(d.dataset.atlasDomain);render();return true;}
  return false;
};
$('atlasRefresh').addEventListener('click',()=>{void refresh();void loadContracts();});

$('atlasContractsToggle')?.addEventListener('click',()=>{
  state.contractsOpen = !state.contractsOpen;
  renderContracts();
});

page.addEventListener('click',e=>{
  const b = e.target.closest('[data-atlas-cross-repo]');
  if (!b) return;
  const targetRepo = b.dataset.atlasCrossRepo;
  const targetModule = b.dataset.atlasCrossModule;
  if (!['localai', 'pi-hub', 'print-lab'].includes(targetRepo)) return;
  chooseSource(targetRepo, targetRepo === 'localai' ? '' : (state.snapshots?.get(targetRepo)?.[0]?.commit || ''));
  if (targetModule) {
    setTimeout(() => { void selectNode(targetModule, { scroll: true, reveal: true }); }, 300);
  }
});
// The Systems strip (atlas-systems.js) chooses a repository: its map loads here.
page.addEventListener('atlas:choose',e=>{const {repo,commit}=e.detail||{};if(typeof repo==='string'&&repo){chooseSource(repo,String(commit||''));$('atlasMapTitle').focus({preventScroll:true});}});
$('atlasRepo').addEventListener('change',e=>{
  const repo=e.target.value;
  chooseSource(repo,repo==='localai'?'':(state.snapshots?.get(repo)?.[0]?.commit||''));
});
$('atlasCommit').addEventListener('change',e=>chooseSource(state.repo,e.target.value));
$('atlasSnapshotNow').addEventListener('click',()=>void snapshotNow());
$('atlasNodeSearch').addEventListener('input',()=>{state.resultsClosed=false;drawMap();renderSearchResults();});
// Enter picks the first match; Escape clears the search, then the selection.
$('atlasNodeSearch').addEventListener('keydown',e=>{
  if(e.key==='Enter'){const first=$('atlasSearchResults').querySelector('[data-atlas-node]');if(first){e.preventDefault();state.resultsClosed=true;void selectNode(first.dataset.atlasNode,{scroll:true});}}
  if(e.key==='Escape'){e.preventDefault();if(e.target.value){e.target.value='';drawMap();renderSearchResults();}else if(state.selected)leaveSelection();}
});
$('atlasSearchResults').addEventListener('click',e=>{state.resultsClosed=true;if(!pick(e,{scroll:true,reveal:true}))state.resultsClosed=false;renderSearchResults();});
// A finding or a link is redrawn when it is chosen: focus moves to the module it named, in the inspector.
const pickAndFocus=e=>{if(pick(e,{scroll:true}))$('atlasSelectedPath').focus({preventScroll:true});};
$('atlasFindingList').addEventListener('click',pickAndFocus);
$('atlasNodeLinks').addEventListener('click',pickAndFocus);
$('atlasMapBack').addEventListener('click',()=>{clearSelection();$('atlasMapTitle').focus();});
$('atlasMap').addEventListener('click',e=>pick(e,{reveal:true}));
$('atlasMap').addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ')return;
  e.preventDefault();
  const id=e.target.closest('[data-atlas-node]')?.dataset.atlasNode,domain=e.target.closest('[data-atlas-domain]')?.dataset.atlasDomain;
  pick(e,{});
  // The map was redrawn around the choice: focus returns to the same row, or to the first module of an opened domain.
  const target=id||state.layout?.rows.find(r=>r.id&&state.model.nodes.get(r.id)?.domain===domain)?.id;
  focusRow(target);
});
for(const b of page.querySelectorAll('[data-atlas-lens]'))b.addEventListener('click',()=>{state.lens=b.dataset.atlasLens;renderLenses();render();});
// "/" finds a module; Escape leaves the selection. Both only while Architecture is open and nothing else is typed in.
document.addEventListener('keydown',e=>{
  if(!state.active||e.defaultPrevented||e.ctrlKey||e.metaKey||e.altKey)return;
  const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||'')||document.activeElement?.isContentEditable;
  if(e.key==='/'&&!typing){e.preventDefault();$('atlasNodeSearch').focus();}
  else if(e.key==='Escape'&&!typing&&state.selected)leaveSelection();
});
$('atlasModel').addEventListener('change',e=>{state.ollamaModel=e.target.value;localStorage.setItem('localai.atlas.model',state.ollamaModel);});
$('atlasAsk').addEventListener('click',()=>void askAtlas());
$('atlasGoose').addEventListener('click',()=>void gooseBrief());
$('atlasQuestion').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();void askAtlas();}});
for(const b of page.querySelectorAll('[data-atlas-question]'))b.addEventListener('click',()=>void askAtlas(b.dataset.atlasQuestion));

const observer=new MutationObserver(()=>{
  const now=page.classList.contains('active');
  if(now&&!state.active)activate();
  else if(!now&&state.active)deactivate();
});
observer.observe(page,{attributes:true,attributeFilter:['class']});
if(page.classList.contains('active'))activate();

root.LocalAIArchitecture={activate,deactivate,refresh,selectNode};
})(typeof window==='undefined'?globalThis:window);
