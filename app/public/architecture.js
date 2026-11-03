// Local AI System Atlas native web integration.
(function(root){
'use strict';

const exported = {};
const severityRank = {critical:0,high:1,medium:2,low:3,info:4};

function aggregateFindings(findings) {
  const groups = new Map();
  for (const item of Array.isArray(findings) ? findings : []) {
    const node = String(item?.node || '').trim();
    if (!node) continue;
    let group = groups.get(node);
    if (!group) {
      group = {node,domain:item.domain||'',severity:item.severity||'info',signals:[],confidence:0};
      groups.set(node, group);
    }
    group.signals.push(item);
    if ((severityRank[item.severity] ?? 99) < (severityRank[group.severity] ?? 99)) group.severity = item.severity;
    group.confidence = Math.max(group.confidence, Number(item.confidence)||0);
  }
  return [...groups.values()].sort((a,b)=>
    (severityRank[a.severity]??99)-(severityRank[b.severity]??99) ||
    b.signals.length-a.signals.length ||
    a.node.localeCompare(b.node)
  );
}

function productionNodes(graph) {
  return (graph?.nodes || []).filter(n => n && n.domain !== 'Tests');
}

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

const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;

// Callers above what they depend on: domains ordered by how much more they use than they are used (an edge's source
// uses its target), so most arrows point down the page.
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

// How old the latest scan is, and whether it predates the release now running (then it may describe other code).
function scanFreshness(generatedAt,deployedAt,now=Date.now()){
  const scanned=Date.parse(generatedAt||'');
  if(!Number.isFinite(scanned))return {text:'Scan time unknown.',stale:true};
  const deployed=Date.parse(deployedAt||'');
  if(Number.isFinite(deployed)&&scanned<deployed){
    return {text:`Scanned ${ago(generatedAt,now)}, before the release deployed ${ago(deployedAt,now)}, so it may not match the running code.`,stale:true};
  }
  return {text:`Scanned ${ago(generatedAt,now)}.`,stale:false};
}

// What a finding group is about, in the rules' own words.
function findingReason(group){
  const titles=[...new Set((group?.signals||[]).map(s=>String(s?.title||s?.rule||'').trim()).filter(Boolean))];
  return titles.join(' · ')||'No detail returned';
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

// The plate (2 Nov 2026): every production module is one square and each domain a block of them, packed in shelves
// across a sheet of fixed width, in the order given (callers' domains first). Squares never move between lenses; a
// lens only repaints them. Each block is at least wide enough for its name; a shelf's last block takes up the slack.
function plateLayout(groups,width=1000){
  const total=groups.reduce((t,g)=>t+g.nodes.length,0);
  const gap=12,pad=10,head=32,cg=4;
  const pitch=Math.max(16,Math.min(36,Math.floor(Math.sqrt(0.3*width*width/Math.max(1,total)))));
  const minCols=Math.max(2,Math.ceil(110/pitch));
  const maxRows=Math.max(2,Math.round(Math.sqrt(total)/3));  // flat shelves: a tall one leaves small blocks empty
  const avail=k=>Math.max(minCols,Math.floor((width-(k-1)*gap-k*(2*pad-cg))/pitch));
  const need=(shelf,r)=>shelf.reduce((t,g)=>t+Math.max(minCols,Math.ceil(g.nodes.length/r)),0);
  const rowsFor=shelf=>{for(let r=1;r<=maxRows;r++)if(need(shelf,r)<=avail(shelf.length))return r;return 0;};
  const shelves=[];
  for(const g of groups){
    const last=shelves[shelves.length-1];
    // A domain small enough for one row joins an earlier shelf it fits without making it taller, rather than a
    // shelf of its own.
    const room=g.nodes.length<=minCols&&shelves.find(sh=>{const r=rowsFor([...sh,g]);return r&&r<=rowsFor(sh);});
    if(room)room.push(g);
    else if(last&&rowsFor([...last,g]))last.push(g);else shelves.push([g]);
  }
  // The sheet never ends on a lone block: one moves down from the shelf above, keeping the order.
  const end=shelves.length-1;
  if(end>0&&shelves[end].length===1&&shelves[end-1].length>2){
    shelves[end].unshift(shelves[end-1].pop());
    if(!rowsFor(shelves[end]))shelves[end-1].push(shelves[end].shift());
  }
  const blocks=[],cells=[];
  let y=0;
  for(const shelf of shelves){
    const k=shelf.length,cols=avail(k);
    const rows=rowsFor(shelf)||Math.ceil(shelf[0].nodes.length/cols);
    const c=shelf.map(g=>Math.min(cols,Math.max(minCols,Math.ceil(g.nodes.length/rows))));
    // Each spare column goes to the tallest block, so the shelf spans the sheet and is as short as it can be.
    const tall=i=>Math.ceil(shelf[i].nodes.length/c[i]);
    for(let spare=cols-c.reduce((a,b)=>a+b,0);spare>0;spare--){
      let t=0;for(let i=1;i<k;i++)if(tall(i)>tall(t)||(tall(i)===tall(t)&&c[i]<c[t]))t=i;  // ties: the narrowest, so slack spreads evenly
      c[t]++;
    }
    const h=head+Math.max(1,...shelf.map((g,i)=>tall(i)))*pitch-cg+pad;
    let x=0;
    shelf.forEach((g,i)=>{
      const w=i===k-1?width-x:2*pad+c[i]*pitch-cg;
      blocks.push({id:g.id,x,y,w,h});
      g.nodes.forEach((n,j)=>cells.push({id:n.id,x:x+pad+(j%c[i])*pitch,y:y+head+Math.floor(j/c[i])*pitch}));
      x+=w+gap;
    });
    y+=h+gap;
  }
  return {width,height:Math.max(0,y-gap),size:pitch-cg,blocks,cells};
}

exported.plateLayout = plateLayout;
exported.aggregateFindings = aggregateFindings;
exported.snapshotStateText = snapshotStateText;
exported.plural = plural;
exported.orderDomains = orderDomains;
exported.scanFreshness = scanFreshness;
exported.findingReason = findingReason;
exported.domainSummary = domainSummary;
exported.snapshotChoices = snapshotChoices;
exported.commitLabel = commitLabel;
exported.snapshotNote = snapshotNote;
if(typeof module==='object'&&module.exports){module.exports=exported;return;}

const page=document.getElementById('architecture');
if(!page)return;
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={
  active:false,summary:null,graph:null,selected:null,details:null,
  mode:'architecture',model:localStorage.getItem('localai.atlas.model')||'',request:null,
  repo:'localai',commit:'',snapshots:null,seq:0,domain:null,releases:null,view:'plate',places:null,links:null
};
// Only Local AI's latest scan has findings, Ask and Goose (until plan PR 5); a snapshot shows its graph alone.
const live=()=>state.repo==='localai'&&!state.commit;
// Intelligence about the chosen snapshot (plan PR 5); with neither, the latest scan.
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
  const chosen=state.model && models.includes(state.model) ? state.model : '';
  select.innerHTML=`<option value="">Auto${ollama.defaultModel?` — ${esc(ollama.defaultModel)}`:''}</option>`+
    models.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('');
  select.value=chosen;
}

function renderKpis(){
  const stats=state.graph?.stats||state.summary?.stats||{};
  const groups=aggregateFindings(state.summary?.findings||[]);
  $('atlasKpiFiles').textContent=stats.productionFiles??stats.files??'—';
  $('atlasKpiRelations').textContent=stats.relationships??state.graph?.edges?.length??'—';
  // Production modules, as the Modules count and the plate are (the scan's own count includes tests).
  $('atlasKpiChanged').textContent=state.graph?productionNodes(state.graph).filter(n=>n.changed).length:stats.changed??'—';
  $('atlasKpiFindings').textContent=state.summary&&!state.summary._error?String(groups.length):'—';
}

function riskText(node){
  const risk=Number(node?.risk)||0;
  return risk>=70?'Critical':risk>=48?'High':risk>=28?'Medium':'Low';
}

const matches=(n,q)=>`${n.id} ${n.label||''} ${n.domain||''}`.toLowerCase().includes(q);

function filteredNodes(){
  let nodes=productionNodes(state.graph);
  if(state.domain)nodes=nodes.filter(n=>n.domain===state.domain);
  if(state.mode==='changes')nodes=nodes.filter(n=>n.changed);
  if(state.mode==='risk')nodes=nodes.filter(n=>(Number(n.risk)||0)>=28).sort((a,b)=>(Number(b.risk)||0)-(Number(a.risk)||0));
  const q=$('atlasNodeSearch').value.trim().toLowerCase();
  if(q)nodes=nodes.filter(n=>matches(n,q));
  return nodes.slice(0,80);
}

function renderSearchResults(){
  const q=$('atlasNodeSearch').value.trim();
  const rows=filteredNodes().slice(0,12);
  const box=$('atlasSearchResults');
  box.hidden=!q || !rows.length;
  box.innerHTML=rows.map(n=>`<button type="button" data-atlas-node="${esc(n.id)}"><span>${esc(n.label||n.id)}</span><small>${esc(n.domain||'')} · risk ${Number(n.risk)||0}</small></button>`).join('');
  // The map answers too: what matches stays lit, the rest dims.
  const hits=new Set(q?productionNodes(state.graph).filter(n=>matches(n,q.toLowerCase())).map(n=>n.id):[]);
  const svg=$('atlasMap');
  svg.toggleAttribute('data-search',!!q);
  for(const el of svg.querySelectorAll('[data-atlas-node]'))el.classList.toggle('is-match',hits.has(el.dataset.atlasNode));
}

const byRisk=(a,b)=>(Number(b.risk)||0)-(Number(a.risk)||0)||a.id.localeCompare(b.id);
// What a lens paints a square by: risk band, changed, imported by a test. The squares stay put; CSS repaints them.
const cellData=n=>`data-band="${riskText(n).toLowerCase()}"${n.changed?' data-changed=""':''}${Number(n.testRefs)>0?' data-tested=""':''}`;
const fit=(text,room)=>text.length>room?`${text.slice(0,Math.max(1,room-1))}…`:text;

function setMapState(kind,text){
  const wrap=$('atlasMap').closest('.atlas-map-wrap');
  wrap.dataset.state=kind;
  $('atlasMapState').textContent=text;
  $('atlasMapState').hidden=!text;
}

const PLATE_HINT='Each square is a module, riskiest first. Domains that call others come first. Select a domain to name its modules, or a square to trace it.';

// The whole system on one plate: a block per domain, a square per module, callers' domains first.
function renderDomainMap(){
  const svg=$('atlasMap');
  const {domains,links}=domainSummary(state.graph);
  const nodes=productionNodes(state.graph);
  const groups=orderDomains(domains,links).map(d=>({...d,nodes:nodes.filter(n=>String(n.domain||'Other')===d.id).sort(byRisk)}));
  // Laid out at the sheet's own width (at most 1000), so its text is drawn at true size on a phone too.
  const wrap=svg.closest('.atlas-map-wrap'),room=wrap.clientWidth-parseFloat(getComputedStyle(wrap).paddingLeft)*2;
  const plate=plateLayout(groups,room>0?Math.round(Math.max(320,Math.min(1000,room))):1000);
  state.plateWidth=plate.width;
  const s=plate.size;
  state.view='plate';state.links=links;
  state.places=new Map(plate.cells.map(c=>[c.id,{x:c.x,y:c.y,w:s,h:s}]));
  const byDomain=new Map(groups.map(g=>[g.id,g]));
  const blockHtml=plate.blocks.map(b=>{
    const d=byDomain.get(b.id);
    return `<g class="atlas-block" data-atlas-domain="${esc(d.id)}" tabindex="0" role="button" aria-label="${esc(d.id)}, ${plural(d.count,'module')}, maximum risk ${d.risk}${d.changed?`, ${d.changed} changed`:''}">
      <rect class="atlas-block-frame" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8"></rect>
      <text class="atlas-block-name" x="${b.x+10}" y="${b.y+20}">${esc(fit(d.id,Math.floor((b.w-44)/8)))}</text>
      <text class="atlas-block-count" x="${b.x+b.w-10}" y="${b.y+20}" text-anchor="end">${d.count}</text>
    </g>`;
  }).join('');
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const cellHtml=plate.cells.map(c=>{
    const n=byId.get(c.id);
    return `<rect class="atlas-cell" data-atlas-node="${esc(c.id)}" x="${c.x}" y="${c.y}" width="${s}" height="${s}" rx="3" ${cellData(n)}><title>${esc(c.id)} · risk ${Number(n.risk)||0}${n.changed?' · changed':''}</title></rect>`;
  }).join('');
  const height=Math.max(plate.height,120);
  svg.setAttribute('viewBox',`-1 -1 ${plate.width+2} ${height+2}`);
  svg.innerHTML=`<g class="atlas-blocks">${blockHtml}</g><g class="atlas-cells">${cellHtml}</g><g class="atlas-arcs"></g><g class="atlas-pins"></g>`;
  mapList(groups.map(d=>({attr:'data-atlas-domain',id:d.id,label:d.id,meta:`${plural(d.count,'module')} · risk ${d.risk}${d.changed?` · ${d.changed} changed`:''}`})),'System domains');
  $('atlasMapTitle').textContent='System domains';
  $('atlasMapHint').textContent=groups.length?PLATE_HINT:'';
  setMapState(groups.length?'':'empty',groups.length?'':'No production modules in this graph.');
}

// Hovering or focusing a domain block lights what it uses and what uses it. Focus also says so in the hint; hover
// doesn't, because a re-wrapped hint would move the plate under the pointer.
function showDomainLinks(id,{say=false}={}){
  const svg=$('atlasMap');
  if(state.view!=='plate'||state.selected)return;
  const links=state.links||[];
  const uses=new Map(links.filter(l=>l.source===id).map(l=>[l.target,l.count]));
  const usedBy=new Map(links.filter(l=>l.target===id).map(l=>[l.source,l.count]));
  for(const b of svg.querySelectorAll('[data-atlas-domain]')){
    const d=b.dataset.atlasDomain;
    b.dataset.rel=!id?'':d===id?'self':uses.has(d)?'uses':usedBy.has(d)?'usedby':'none';
  }
  svg.toggleAttribute('data-relating',!!id);
  if(!say)return;
  if(!id)return void($('atlasMapHint').textContent=PLATE_HINT);
  const list=m=>[...m].sort((a,b)=>b[1]-a[1]).map(([d,c])=>`${d} (${c})`).join(', ')||'no other domain';
  $('atlasMapHint').textContent=`${id} uses ${list(uses)} · used by ${list(usedBy)}.`;
}

// One domain: its modules named, riskiest first, each with its square from the plate.
function renderDomainFocus(){
  const svg=$('atlasMap'),id=state.domain;
  const {links}=domainSummary(state.graph);
  const modules=productionNodes(state.graph).filter(n=>n.domain===id).sort(byRisk);
  if(!modules.length){state.domain=null;renderDomainMap();return;}
  const shown=modules.slice(0,60);
  const cols=3,nodeW=316,nodeH=52,gap=12,width=1000;
  const rows=Math.ceil(shown.length/cols);
  const height=rows*nodeH+(rows-1)*gap;
  state.view='domain';
  state.places=new Map();
  const nodeHtml=shown.map((n,i)=>{
    const x=(i%cols)*(nodeW+gap),y=Math.floor(i/cols)*(nodeH+gap);
    state.places.set(n.id,{x,y,w:nodeW,h:nodeH});
    return `<g class="atlas-tile" data-atlas-node="${esc(n.id)}" transform="translate(${x} ${y})" tabindex="0" role="button" aria-label="${esc(n.id)}, risk ${Number(n.risk)||0}${n.changed?', changed':''}">
      <rect class="atlas-tile-frame" width="${nodeW}" height="${nodeH}" rx="8"></rect>
      <rect class="atlas-cell" x="12" y="14" width="24" height="24" rx="3" ${cellData(n)}></rect>
      <text x="48" y="23" class="atlas-file-title">${esc(fit(n.label||n.id,32))}</text>
      <text x="48" y="41" class="atlas-file-meta">${esc(fit(n.id,40))} · risk ${Number(n.risk)||0}${n.changed?' · changed':''}</text>
    </g>`;
  }).join('');
  svg.setAttribute('viewBox',`-1 -1 ${width+2} ${height+2}`);
  svg.innerHTML=`<g>${nodeHtml}</g><g class="atlas-arcs"></g><g class="atlas-pins"></g>`;
  mapList(shown.map(n=>({attr:'data-atlas-node',id:n.id,label:n.label||n.id,meta:`risk ${Number(n.risk)||0}${n.changed?' · changed':''}`})),`${id} modules`);
  const byCount=(a,b)=>b.count-a.count;
  const usedBy=links.filter(l=>l.target===id).sort(byCount).map(l=>`${l.source} (${l.count})`);
  const uses=links.filter(l=>l.source===id).sort(byCount).map(l=>`${l.target} (${l.count})`);
  $('atlasMapTitle').textContent=`${id} · ${plural(modules.length,'module')}`;
  $('atlasMapHint').textContent=[
    `Used by ${usedBy.join(', ')||'no other domain'}`,`uses ${uses.join(', ')||'no other domain'}`,
    modules.length>shown.length?`the ${shown.length} riskiest shown`:''
  ].filter(Boolean).join(' · ')+'.';
  setMapState('','');
}

// The phone's version of the map: one 44 px button per block or module (the drawing is too small to tap there).
function mapList(items,label){
  let list=$('atlasDomainList');
  if(!list){
    list=document.createElement('ul');list.id='atlasDomainList';list.className='atlas-domain-list';
    $('atlasMap').closest('.atlas-map-wrap').after(list);
    list.addEventListener('click',e=>{
      const n=e.target.closest('[data-atlas-node]');if(n)return void selectNode(n.dataset.atlasNode,{reveal:true});
      const d=e.target.closest('[data-atlas-domain]');if(d)openDomain(d.dataset.atlasDomain);
    });
  }
  list.setAttribute('aria-label',label);
  $('atlasMap').closest('.atlas-map-wrap').dataset.view=state.view;
  list.innerHTML=items.map(i=>`<li><button type="button" ${i.attr}="${esc(i.id)}">${esc(i.label)} <span>${esc(i.meta)}</span></button></li>`).join('');
}

// What a module uses and what uses it, production modules only, each once.
function neighbors(id){
  const nodes=new Map(productionNodes(state.graph).map(n=>[n.id,n]));
  const uses=new Map(),usedBy=new Map();
  for(const e of state.graph?.edges||[]){
    if(e.source===id&&nodes.has(e.target)&&e.target!==id)uses.set(e.target,nodes.get(e.target));
    if(e.target===id&&nodes.has(e.source)&&e.source!==id)usedBy.set(e.source,nodes.get(e.source));
  }
  return {uses:[...uses.values()].sort(byRisk),usedBy:[...usedBy.values()].sort(byRisk)};
}

// The chosen module on the map: it and its neighbours stay lit, the rest dims, and a line runs to each neighbour
// that is drawn here (solid: it uses; faint: uses it).
function paintSelection(){
  const svg=$('atlasMap'),id=state.selected;
  const arcs=svg.querySelector('.atlas-arcs');
  const node=id&&productionNodes(state.graph).find(n=>n.id===id);
  svg.toggleAttribute('data-focus',!!node);
  const {uses,usedBy}=node?neighbors(id):{uses:[],usedBy:[]};
  const u=new Set(uses.map(n=>n.id)),b=new Set(usedBy.map(n=>n.id));
  for(const el of svg.querySelectorAll('[data-atlas-node]')){
    const n=el.dataset.atlasNode;
    el.classList.toggle('is-selected',n===id);
    el.classList.toggle('is-uses',u.has(n));
    el.classList.toggle('is-usedby',b.has(n)&&!u.has(n));
  }
  if(!arcs)return;
  const from=node&&state.places?.get(id);
  if(!from)return void(arcs.innerHTML='');
  const mid=p=>[p.x+p.w/2,p.y+p.h/2];
  const [x1,y1]=mid(from);
  const line=(n,kind)=>{
    const to=state.places.get(n.id);if(!to)return '';
    const [x2,y2]=mid(to),dx=x2-x1,dy=y2-y1,bow=.18;
    return `<path class="atlas-arc atlas-arc--${kind}" pathLength="1" d="M${x1} ${y1}Q${(x1+x2)/2-dy*bow} ${(y1+y2)/2+dx*bow} ${x2} ${y2}"></path>`;
  };
  arcs.innerHTML=usedBy.filter(n=>!u.has(n.id)).map(n=>line(n,'usedby')).join('')+uses.map(n=>line(n,'uses')).join('');
}

// A resize that changes the sheet's width by much lays the plate out again.
let resizeTimer=null;
root.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{
  if(!state.active||!state.graph||state.view!=='plate')return;
  const wrap=$('atlasMap').closest('.atlas-map-wrap');
  if(Math.abs(Math.min(1000,wrap.clientWidth)-(state.plateWidth||0))>48)renderMap();
},200);});

function renderMap(){
  state.domain&&!state.selected?renderDomainFocus():renderDomainMap();
  $('atlasMap').dataset.lens=state.mode;
  $('atlasMapBack').hidden=!state.domain&&!state.selected;
  $('atlasMapBack').textContent=state.selected&&state.domain?`Back to ${state.domain}`:state.selected?'Clear selection':'All domains';
  const picked=state.selected&&productionNodes(state.graph).find(n=>n.id===state.selected);
  if(picked){
    const {uses,usedBy}=neighbors(picked.id);
    $('atlasMapTitle').textContent=picked.label||picked.id;
    $('atlasMapHint').textContent=`${picked.domain||'Other'} · uses ${plural(uses.length,'module')} · used by ${plural(usedBy.length,'module')}.`;
  }
  paintSelection();renderSearchResults();renderFindings();renderLegend();
}

const key=(cls,text)=>`<span class="atlas-key"><span class="atlas-swatch ${cls}"></span>${esc(text)}</span>`;
function renderLegend(){
  const el=$('atlasLegend');
  if(!state.graph)return void(el.innerHTML='');
  const since=state.graph.snapshot?.changedSince;
  const parts={
    architecture:[key('','A module'),key('atlas-swatch--pin','A finding, numbered as listed below')],
    risk:[key('atlas-band-low','Low'),key('atlas-band-medium','Medium'),key('atlas-band-high','High'),key('atlas-band-critical','Critical risk')],
    changes:[key('atlas-swatch--changed',since?`Changed since ${String(since).slice(0,7)}`:'Changed'),key('atlas-swatch--dim','Unchanged')],
    evidence:[key('atlas-swatch--tested','Imported by a test'),key('atlas-swatch--untested','No test imports it')],
  }[state.mode]||[];
  if(state.selected)parts.push(key('atlas-swatch--uses','Uses'),key('atlas-swatch--usedby','Used by'));
  el.innerHTML=parts.join('');
}

// The findings ledger, numbered as the pins on the map. A snapshot's Changes lens lists what changed since the
// snapshot before it instead.
function ledger(){
  if(!state.graph)return {items:[],total:0,empty:'Findings appear once the graph has loaded.'};
  const changedNodes=productionNodes(state.graph).filter(n=>n.changed);
  if(!live()&&state.mode==='changes'){
    const since=state.graph.snapshot?.changedSince;
    return {title:since?`Changed since ${String(since).slice(0,7)}`:'Changed',items:changedNodes.slice(0,40).map(n=>({node:n.id,severity:'changed',reason:`${n.domain||''} · risk ${Number(n.risk)||0}`})),total:changedNodes.length,
      empty:since?`Nothing changed since ${String(since).slice(0,7)}.`:'This is the first snapshot of this repository, so there is nothing earlier to compare with.'};
  }
  // The latest scan reads the deploy checkout, which has no edits: "changed" only means something for a snapshot.
  if(state.mode==='changes'&&!changedNodes.length)return {items:[],total:0,empty:'No change data for the latest scan: it reads the deploy checkout, which has no edits. Choose a snapshot to see what changed since the one before it.'};
  if(state.summary?._error)return {items:[],total:0,empty:'Findings come from Atlas Intelligence, which isn\'t answering; the map above is the graph alone.'};
  const groups=aggregateFindings(state.summary?.findings||[]);
  let shown=groups;
  if(state.mode==='changes'){
    const changed=new Set(changedNodes.map(n=>n.id));
    shown=groups.filter(g=>changed.has(g.node));
  }else if(state.mode==='risk')shown=groups.filter(g=>['critical','high'].includes(g.severity));
  else if(state.mode==='evidence')shown=groups.filter(g=>g.signals.some(s=>String(s.rule||'').includes('test')));
  return {items:shown.slice(0,20).map(g=>({node:g.node,severity:g.severity,reason:findingReason(g)})),total:shown.length,empty:'No findings match this lens.'};
}

function renderFindings(){
  const {items,total,empty,title='Findings'}=ledger();
  $('atlasFindingsTitle').textContent=title;
  $('atlasFindingCount').textContent=plural(total,'module');
  $('atlasFindingList').innerHTML=items.map((f,i)=>`
    <button type="button" class="atlas-finding atlas-sev-${esc(f.severity)}" data-atlas-node="${esc(f.node)}">
      <span class="atlas-finding-n">${i+1}</span>
      <span class="atlas-finding-copy"><strong>${esc(f.node)}</strong><small><span class="atlas-finding-sev">${esc(f.severity)}</span> · ${esc(f.reason)}</small></span>
    </button>`).join('')||`<div class="atlas-empty">${esc(empty)}</div>`;
  const pins=$('atlasMap').querySelector('.atlas-pins');
  if(pins)pins.innerHTML=items.map((f,i)=>{
    const p=state.places?.get(f.node);if(!p)return '';
    return `<g class="atlas-pin atlas-sev-${esc(f.severity)}" transform="translate(${p.x+p.w-2} ${p.y+2})"><circle r="9"></circle><text y="3.5" text-anchor="middle">${i+1}</text></g>`;
  }).join('');
}

function nodeFromDetails(payload){
  if(payload?.node && typeof payload.node==='object')return payload.node;
  return payload && typeof payload==='object' && payload.id ? payload : null;
}

function renderInspector(){
  const node=nodeFromDetails(state.details) || productionNodes(state.graph).find(n=>n.id===state.selected);
  $('atlasSelectedEmpty').hidden=!!node;
  $('atlasSelectedBody').hidden=!node;
  renderAskControls();
  if(!node){$('atlasNodeStats').innerHTML='';$('atlasNodeLinks').innerHTML='';
    $('atlasEvidenceList').innerHTML='<li class="atlas-muted">Select a module.</li>';return;}
  $('atlasSelectedPath').textContent=node.id;
  $('atlasSelectedMeta').textContent=`${node.domain||'Unknown'} · ${riskText(node)} risk · score ${Number(node.risk)||0}`;
  const direct=Number(node.testRefs)||0;
  const effective=Number(node.effectiveTestSignal ?? state.details?.effectiveTestSignal ?? direct)||0;
  const evidence=Array.isArray(node.testEvidence)?node.testEvidence:(Array.isArray(state.details?.testEvidence)?state.details.testEvidence:[]);
  $('atlasNodeStats').innerHTML=[
    ['Risk',Number(node.risk)||0],['Inbound',Number(node.inbound)||0],['Outbound',Number(node.outbound)||0],
    ['Test imports',direct],['Test signal',effective],['Changed',node.changed?'Yes':'No']
  ].map(([k,v])=>`<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
  const {uses,usedBy}=neighbors(node.id);
  $('atlasNodeLinks').innerHTML=[['Uses',uses,'uses'],['Used by',usedBy,'usedby']].map(([title,list,kind])=>`
    <div class="atlas-links-group atlas-links--${kind}"><h3 class="atlas-section-label">${title} <span>${list.length}</span></h3>${list.length?
      `<ul>${list.slice(0,12).map(n=>`<li><button type="button" data-atlas-node="${esc(n.id)}"><span>${esc(n.id)}</span><small>${esc(n.domain||'')} · risk ${Number(n.risk)||0}</small></button></li>`).join('')}</ul>${
      list.length>12?`<p class="atlas-muted">and ${list.length-12} more</p>`:''}`:'<p class="atlas-muted">None in this graph.</p>'}</div>`).join('');
  $('atlasEvidenceList').innerHTML=evidence.slice(0,8).map(e=>`<li><code>${esc(e.test||e.path||'')}</code><span>${esc(e.kind||'evidence')}</span></li>`).join('')||
    '<li class="atlas-muted">No enhanced test evidence returned for this node.</li>';
}

// Ask, Goose and the model need a graph; the quick questions are about a module, so they also need one.
function renderAskControls(){
  const off=!state.graph;
  for(const el of [$('atlasAsk'),$('atlasGoose'),$('atlasModel'),$('atlasQuestion')])el.disabled=off;
  for(const el of page.querySelectorAll('[data-atlas-question]'))el.disabled=off||!state.selected;
}

// On one column the inspector sits far below the map: bring it into view when someone picks a module.
function revealInspector(){
  if(!matchMedia('(max-width: 1100px)').matches)return;
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  page.querySelector('.atlas-inspector').scrollIntoView({block:'start',behavior:reduce?'auto':'smooth'});
  $('atlasSelectedPath').focus({preventScroll:true});
}

async function selectNode(id,{reveal=false}={}){
  state.selected=id;
  // A chosen module is traced on the whole plate; Back returns to the domain it was chosen from.
  renderMap();
  const seq=state.seq;
  try{
    state.details=await getJson(scoped(`/api/atlas/node?path=${encodeURIComponent(id)}`),{timeout:live()?12000:62000});
  }catch(error){
    state.details=productionNodes(state.graph).find(n=>n.id===id)||null;
    status(`Node loaded from static graph; intelligence detail unavailable: ${error.message}`,'warn');
  }
  if(seq!==state.seq)return;  // the page moved to another graph meanwhile
  renderInspector();
  if(reveal)revealInspector();
}

function renderModes(){
  for(const b of page.querySelectorAll('[data-atlas-mode]')){
    const on=b.dataset.atlasMode===state.mode;
    b.classList.toggle('active',on);
    b.setAttribute('aria-selected',String(on));
  }
  $('atlasMap').dataset.lens=state.mode;
  renderFindings();renderSearchResults();renderLegend();
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
  state.graph=null;state.summary=null;state.selected=null;state.details=null;state.domain=null;state.places=null;
  $('atlasMapBack').hidden=true;
  $('atlasMap').innerHTML='';
  if($('atlasDomainList'))$('atlasDomainList').innerHTML='';
  setMapState(kind,kind==='loading'?'Reading the graph…':hint);
  renderLegend();
  $('atlasMapTitle').textContent=title;
  $('atlasMapHint').textContent=kind==='loading'?hint:'';  // an empty or failed sheet says why on itself
  for(const id of ['atlasKpiFiles','atlasKpiRelations','atlasKpiChanged','atlasKpiFindings'])$(id).textContent='—';
  $('atlasNodeSearch').value='';renderSearchResults();
  $('atlasAnswer').hidden=true;
  renderInspector();renderFindings();
}

async function refresh(){
  // A newer refresh (another repository or commit chosen meanwhile) supersedes this one: its results are dropped.
  const seq=++state.seq;
  setBusy(true);status(`Loading ${repoLabel(state.repo)}…`);
  try{
    const listed=await getJson('/api/atlas/snapshots',{timeout:12000}).catch(error=>({_error:error.message}));
    if(seq!==state.seq||!state.active)return;
    if(!listed._error||!state.snapshots)state.snapshots=snapshotChoices(listed._error?null:listed);
    if(!state.snapshots.has(state.repo)){state.repo='localai';state.commit='';}
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
      getJson(scoped('/api/atlas/summary'),{timeout:live()?12000:62000}).catch(error=>({providers:{},findings:[],_error:error.message})),
      live()?getJson('/api/releases',{timeout:8000}).catch(()=>null):null
    ]);
    if(seq!==state.seq||!state.active)return;
    state.graph=graph;state.summary=summary;
    renderKpis();if(summary)providerBadge();renderMap();
    if(state.selected)await selectNode(state.selected);
    if(seq!==state.seq)return;
    // Say plainly when the diagram is old, partial or missing its change data, rather than looking complete.
    const caveats=[];
    if(retired)caveats.push('the chosen commit is no longer kept, so this is the newest snapshot');
    if(listed._error)caveats.push(`the snapshot list is unavailable: ${listed._error}`);
    if(graph.stale)caveats.push('showing the last good graph; the newest copy could not be read');
    if(graph.stats?.truncated)caveats.push(`only the first ${graph.stats.maxFiles} files were scanned`);
    if(graph.stats?.gitError)caveats.push('changed files are unknown (git failed)');
    if(summary?._error)caveats.push(`intelligence service is offline: ${summary._error}`);
    if(summary?.snapshot?.reason)caveats.push(`findings use the graph only, because ${summary.snapshot.reason}`);
    // Say how old the scan is; the latest scan is only re-run by hand, so it can predate the running release.
    const fresh=live()?scanFreshness(graph.generatedAt,releases?.current?.deployedAt):
      {text:`Snapshot scanned ${ago(graph.generatedAt)||'at an unknown time'}.`,stale:false};
    status(`${fresh.text}${caveats.length?` Also: ${caveats.map(c=>c.replace(/\.+$/,'')).join('; ')}.`:''}`,fresh.stale||caveats.length?'warn':'ok');
  }catch(error){
    if(seq!==state.seq||!state.active)return;
    if(!state.graph)clearGraph(`${repoLabel(state.repo)} could not be loaded`,'The graph could not be read. Try Refresh evidence, or choose another commit.','error');
    status(error.name==='AbortError'?'Architecture refresh timed out.':error.message,'error');
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
    snapshotRun.job=job;showSnapshotState(job);pollSnapshot();
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
    if(job.state==='done'&&job.repo===state.repo)state.commit=job.commit;
    if(job.state==='done')void refresh();
  },3000);
}

function chooseSource(repo,commit){
  state.repo=repo;state.commit=commit;
  clearGraph('Loading…','');
  void refresh();
}

async function askAtlas(question){
  const q=String(question||$('atlasQuestion').value).trim();
  if(!q)return $('atlasQuestion').focus();
  $('atlasQuestion').value=q;
  $('atlasAsk').disabled=true;$('atlasGoose').disabled=true;
  const box=$('atlasAnswer');box.hidden=false;box.dataset.tone='loading';box.textContent='Analyzing bounded Atlas evidence…';
  try{
    const payload=await getJson('/api/atlas/ask',{
      method:'POST',timeout:310000,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...scope(),question:q,node:state.selected||undefined,model:state.model||undefined})
    });
    box.dataset.tone='ok';
    box.textContent=`${payload.answer||'No answer returned.'}\n\nModel: ${payload.model||'unknown'}${state.selected?`\nNode: ${state.selected}`:''}`;
  }catch(error){
    box.dataset.tone='error';box.textContent=error.name==='AbortError'?'Atlas analysis exceeded the five-minute browser limit.':error.message;
  }finally{$('atlasAsk').disabled=false;$('atlasGoose').disabled=false;}
}

async function gooseBrief(){
  const q=$('atlasQuestion').value.trim()||`Investigate the highest-priority architecture evidence${state.selected?` for ${state.selected}`:''}.`;
  const box=$('atlasAnswer');box.hidden=false;box.dataset.tone='loading';box.textContent='Preparing read-only Goose investigation brief…';
  try{
    const payload=await getJson('/api/atlas/goose',{
      method:'POST',timeout:live()?15000:62000,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...scope(),question:q,node:state.selected||undefined})
    });
    box.dataset.tone='ok';
    box.textContent=`Read-only investigation brief created:\n${payload.briefPath||'Atlas investigation directory'}\n\n${payload.goose?.available?'Goose CLI detected.':'Goose is not on PATH; the brief is still ready for later investigation.'}`;
  }catch(error){box.dataset.tone='error';box.textContent=error.message;}
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
  pollSnapshot();
}
root.addEventListener('hashchange',()=>{if(state.active)fromHash();});
function deactivate(){state.active=false;state.request?.abort?.();state.request=null;clearTimeout(snapshotRun.timer);}

$('atlasRefresh').addEventListener('click',()=>void refresh());
$('atlasRepo').addEventListener('change',e=>{
  const repo=e.target.value;
  chooseSource(repo,repo==='localai'?'':(state.snapshots?.get(repo)?.[0]?.commit||''));
});
$('atlasCommit').addEventListener('change',e=>chooseSource(state.repo,e.target.value));
$('atlasSnapshotNow').addEventListener('click',()=>void snapshotNow());
$('atlasNodeSearch').addEventListener('input',renderSearchResults);
$('atlasSearchResults').addEventListener('click',e=>{const b=e.target.closest('[data-atlas-node]');if(b){$('atlasSearchResults').hidden=true;void selectNode(b.dataset.atlasNode,{reveal:true});}});
$('atlasFindingList').addEventListener('click',e=>{const b=e.target.closest('[data-atlas-node]');if(b)void selectNode(b.dataset.atlasNode,{reveal:true});});
// Uses and Used by: walk the graph from the inspector, one module to the next.
$('atlasNodeLinks').addEventListener('click',async e=>{const b=e.target.closest('[data-atlas-node]');if(!b)return;await selectNode(b.dataset.atlasNode);$('atlasSelectedPath').focus();});
function openDomain(id){state.domain=id;state.selected=null;state.details=null;renderMap();renderInspector();}
$('atlasMapBack').addEventListener('click',()=>{
  if(state.selected){state.selected=null;state.details=null;}else state.domain=null;
  renderMap();renderInspector();
  $('atlasMapTitle').focus();
});
$('atlasMap').addEventListener('pointerover',e=>{const d=e.target.closest('[data-atlas-domain]');showDomainLinks(d?d.dataset.atlasDomain:null);});
$('atlasMap').addEventListener('pointerleave',()=>showDomainLinks(null));
$('atlasMap').addEventListener('focusin',e=>{const d=e.target.closest('[data-atlas-domain]');showDomainLinks(d?d.dataset.atlasDomain:null,{say:true});});
$('atlasMap').addEventListener('focusout',e=>{if(!$('atlasMap').contains(e.relatedTarget))showDomainLinks(null,{say:true});});
$('atlasMap').addEventListener('click',e=>{
  const n=e.target.closest('[data-atlas-node]');if(n)return void selectNode(n.dataset.atlasNode,{reveal:true});
  const d=e.target.closest('[data-atlas-domain]');if(d)openDomain(d.dataset.atlasDomain);
});
// Domain boxes and file nodes are both role="button": Enter and Space open them, as a click does.
$('atlasMap').addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ')return;
  // The plate is redrawn around the choice, so focus moves to the inspector's heading for the module.
  const n=e.target.closest('[data-atlas-node]');if(n){e.preventDefault();return void selectNode(n.dataset.atlasNode,{reveal:true}).then(()=>$('atlasSelectedPath').focus());}
  const d=e.target.closest('[data-atlas-domain]');if(d){e.preventDefault();openDomain(d.dataset.atlasDomain);}
});
// The lens tabs: one tab stop, arrow keys (and Home/End) move between them, as a tablist should.
const modeTabs=[...page.querySelectorAll('[data-atlas-mode]')];
function chooseMode(b){state.mode=b.dataset.atlasMode;renderModes();for(const t of modeTabs)t.tabIndex=t===b?0:-1;}
for(const b of modeTabs){
  b.tabIndex=b.classList.contains('active')?0:-1;
  b.addEventListener('click',()=>chooseMode(b));
  b.addEventListener('keydown',e=>{
    const i=modeTabs.indexOf(b),last=modeTabs.length-1;
    const to={ArrowRight:i===last?0:i+1,ArrowLeft:i===0?last:i-1,Home:0,End:last}[e.key];
    if(to===undefined)return;
    e.preventDefault();chooseMode(modeTabs[to]);modeTabs[to].focus();
  });
}
$('atlasModel').addEventListener('change',e=>{state.model=e.target.value;localStorage.setItem('localai.atlas.model',state.model);});
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
