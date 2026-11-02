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
  repo:'localai',commit:'',snapshots:null,seq:0,domain:null,releases:null
};
// Only Local AI's latest scan has findings, Ask and Goose (until plan PR 5); a snapshot shows its graph alone.
const live=()=>state.repo==='localai'&&!state.commit;

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
  $('atlasKpiChanged').textContent=stats.changed??productionNodes(state.graph).filter(n=>n.changed).length??'—';
  $('atlasKpiFindings').textContent=state.summary?(groups.length||'0'):'—';
}

function riskText(node){
  const risk=Number(node?.risk)||0;
  return risk>=70?'Critical':risk>=48?'High':risk>=28?'Medium':'Low';
}

function filteredNodes(){
  let nodes=productionNodes(state.graph);
  if(state.domain)nodes=nodes.filter(n=>n.domain===state.domain);
  if(state.mode==='changes')nodes=nodes.filter(n=>n.changed);
  if(state.mode==='risk')nodes=nodes.filter(n=>(Number(n.risk)||0)>=28).sort((a,b)=>(Number(b.risk)||0)-(Number(a.risk)||0));
  const q=$('atlasNodeSearch').value.trim().toLowerCase();
  if(q)nodes=nodes.filter(n=>`${n.id} ${n.label||''} ${n.domain||''}`.toLowerCase().includes(q));
  return nodes.slice(0,80);
}

function renderSearchResults(){
  const rows=filteredNodes().slice(0,12);
  const box=$('atlasSearchResults');
  box.hidden=!$('atlasNodeSearch').value.trim() || !rows.length;
  box.innerHTML=rows.map(n=>`<button type="button" data-atlas-node="${esc(n.id)}"><span>${esc(n.label||n.id)}</span><small>${esc(n.domain||'')} · risk ${Number(n.risk)||0}</small></button>`).join('');
}

function renderDomainMap(){
  const svg=$('atlasMap');
  const {domains,links}=domainSummary(state.graph);
  const shown=orderDomains(domains,links).slice(0,16);
  const cols=4,cardW=206,cardH=64,xGap=44,yGap=64,startX=13,startY=24,width=980;
  const rows=Math.max(1,Math.ceil(shown.length/cols));
  const height=startY*2+rows*cardH+(rows-1)*yGap;
  const pos=new Map();
  shown.forEach((d,i)=>pos.set(d.id,{x:startX+(i%cols)*(cardW+xGap),y:startY+Math.floor(i/cols)*(cardH+yGap)}));
  const drawn=links.filter(l=>pos.has(l.source)&&pos.has(l.target)).sort((a,b)=>b.count-a.count).slice(0,40);
  const most=Math.max(1,...drawn.map(l=>l.count));
  const lineHtml=drawn.map(l=>{
    const a=pos.get(l.source),b=pos.get(l.target);
    // Leave from the side facing the target; same row: from the side, otherwise from the bottom (or top) edge.
    let x1=a.x+cardW/2,y1=a.y+cardH,x2=b.x+cardW/2,y2=b.y;
    if(b.y<a.y){y1=a.y;y2=b.y+cardH;}
    else if(b.y===a.y){y1=y2=a.y+cardH/2;x1=b.x>a.x?a.x+cardW:a.x;x2=b.x>a.x?b.x:b.x+cardW;}
    const bend=b.y===a.y?0:(y2-y1)/2;
    const w=(1+3*l.count/most).toFixed(1);
    return `<path class="atlas-edge" d="M${x1} ${y1} C${x1} ${y1+bend} ${x2} ${y2-bend} ${x2} ${y2}" style="stroke-width:${w}px" marker-end="url(#atlasArrow)"><title>${esc(l.source)} uses ${esc(l.target)} · ${plural(l.count,'import')}</title></path>`;
  }).join('');
  const nodeHtml=shown.map(d=>{
    const p=pos.get(d.id);
    return `<g class="atlas-domain-node" data-atlas-domain="${esc(d.id)}" transform="translate(${p.x} ${p.y})" tabindex="0" role="button" aria-label="${esc(d.id)}, ${plural(d.count,'module')}, maximum risk ${d.risk}${d.changed?`, ${d.changed} changed`:''}">
      <rect width="${cardW}" height="${cardH}" rx="10"></rect>
      <text x="14" y="27" class="atlas-domain-title">${esc(d.id)}${d.changed?` · ${d.changed} changed`:''}</text>
      <text x="14" y="49" class="atlas-domain-meta">${plural(d.count,'module')} · risk ${d.risk}</text>
    </g>`;
  }).join('');
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  svg.innerHTML=`<defs><marker id="atlasArrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="atlas-arrow"></path></marker></defs><g class="atlas-edges">${lineHtml}</g><g>${nodeHtml}</g>`;
  mapList(shown.map(d=>({attr:'data-atlas-domain',id:d.id,label:d.id,meta:`${plural(d.count,'module')} · risk ${d.risk}${d.changed?` · ${d.changed} changed`:''}`})),'System domains');
  $('atlasMapTitle').textContent='System domains';
  $('atlasMapHint').textContent=shown.length?'Callers sit above what they use; thicker arrows carry more imports. Select a domain to see its modules.':'No modules in this graph.';
  $('atlasMapBack').hidden=true;
}

// One domain: its modules, riskiest first, and which domains use it and which it uses.
function renderDomainFocus(){
  const svg=$('atlasMap'),id=state.domain;
  const {links}=domainSummary(state.graph);
  const modules=productionNodes(state.graph).filter(n=>n.domain===id).sort((a,b)=>(Number(b.risk)||0)-(Number(a.risk)||0));
  if(!modules.length){state.domain=null;renderDomainMap();return;}
  const shown=modules.slice(0,24);
  const cols=3,nodeW=300,nodeH=46,xGap=27,yGap=14,startX=13,startY=16,width=980;
  const rows=Math.ceil(shown.length/cols);
  const height=startY*2+rows*nodeH+(rows-1)*yGap;
  const nodeHtml=shown.map((n,i)=>{
    const x=startX+(i%cols)*(nodeW+xGap),y=startY+Math.floor(i/cols)*(nodeH+yGap);
    return `<g class="atlas-file-node" data-atlas-node="${esc(n.id)}" transform="translate(${x} ${y})" tabindex="0" role="button" aria-label="${esc(n.id)}, risk ${Number(n.risk)||0}">
      <rect width="${nodeW}" height="${nodeH}" rx="8"></rect>
      <text x="12" y="20" class="atlas-file-title">${esc((n.label||n.id).slice(0,38))}</text>
      <text x="12" y="37" class="atlas-file-meta">risk ${Number(n.risk)||0}${n.changed?' · changed':''}</text>
    </g>`;
  }).join('');
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  svg.innerHTML=`<g>${nodeHtml}</g>`;
  mapList(shown.map(n=>({attr:'data-atlas-node',id:n.id,label:n.label||n.id,meta:`risk ${Number(n.risk)||0}${n.changed?' · changed':''}`})),`${id} modules`);
  const byCount=(a,b)=>b.count-a.count;
  const usedBy=links.filter(l=>l.target===id).sort(byCount).map(l=>`${l.source} (${l.count})`);
  const uses=links.filter(l=>l.source===id).sort(byCount).map(l=>`${l.target} (${l.count})`);
  $('atlasMapTitle').textContent=`${id} · ${plural(modules.length,'module')}`;
  $('atlasMapHint').textContent=[
    `Used by ${usedBy.join(', ')||'no other domain'}`,`uses ${uses.join(', ')||'no other domain'}`,
    modules.length>shown.length?`the ${shown.length} riskiest shown`:''
  ].filter(Boolean).join(' · ')+'.';
  $('atlasMapBack').hidden=false;
  $('atlasMapBack').textContent='All domains';
}

// The phone's version of the map: one 44 px button per box (the diagram's boxes would be too small to tap).
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
  $('atlasMap').closest('.atlas-map-wrap').classList.toggle('atlas-has-list',items.length>0);
  list.innerHTML=items.map(i=>`<li><button type="button" ${i.attr}="${esc(i.id)}">${esc(i.label)} <span>${esc(i.meta)}</span></button></li>`).join('');
}

function renderFocusedMap(){
  const svg=$('atlasMap'),id=state.selected;
  const graph=state.graph;
  const nodes=new Map((graph?.nodes||[]).map(n=>[n.id,n]));
  const center=nodes.get(id);
  if(!center){renderDomainMap();return;}
  const incoming=[],outgoing=[];
  for(const e of graph.edges||[]){
    if(e.target===id&&nodes.has(e.source)&&nodes.get(e.source).domain!=='Tests')incoming.push(nodes.get(e.source));
    if(e.source===id&&nodes.has(e.target)&&nodes.get(e.target).domain!=='Tests')outgoing.push(nodes.get(e.target));
  }
  const left=[...new Map(incoming.map(n=>[n.id,n])).values()].slice(0,8);
  const right=[...new Map(outgoing.map(n=>[n.id,n])).values()].slice(0,8);
  const width=980,height=Math.max(430,Math.max(left.length,right.length)*52+90),cx=490,cy=height/2;
  const nodeW=230,nodeH=42;
  const positions=new Map([[id,{x:cx-nodeW/2,y:cy-nodeH/2,side:'center'}]]);
  const place=(arr,x,side)=>arr.forEach((n,i)=>positions.set(n.id,{x,y:55+i*52,side}));
  place(left,60,'left');place(right,width-60-nodeW,'right');
  const edgeHtml=[...left.map(n=>({source:n.id,target:id})),...right.map(n=>({source:id,target:n.id}))].map(e=>{
    const a=positions.get(e.source),b=positions.get(e.target);
    return `<line class="atlas-edge atlas-edge-focus" x1="${a.x+(a.side==='left'?nodeW:a.side==='center'?nodeW:0)}" y1="${a.y+nodeH/2}" x2="${b.x+(b.side==='right'?0:b.side==='center'?0:nodeW)}" y2="${b.y+nodeH/2}"></line>`;
  }).join('');
  const all=[...left,center,...right];
  const nodeHtml=all.map(n=>{
    const p=positions.get(n.id),selected=n.id===id;
    return `<g class="atlas-file-node${selected?' selected':''}" data-atlas-node="${esc(n.id)}" transform="translate(${p.x} ${p.y})" tabindex="0" role="button" aria-label="${esc(n.id)}">
      <rect width="${nodeW}" height="${nodeH}" rx="8"></rect>
      <text x="12" y="18" class="atlas-file-title">${esc((n.label||n.id).slice(0,31))}</text>
      <text x="12" y="33" class="atlas-file-meta">${esc(n.domain||'')} · risk ${Number(n.risk)||0}</text>
    </g>`;
  }).join('');
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  svg.innerHTML=`<g>${edgeHtml}</g><g>${nodeHtml}</g>`;
  $('atlasMap').closest('.atlas-map-wrap').classList.remove('atlas-has-list');
  if($('atlasDomainList'))$('atlasDomainList').innerHTML='';
  $('atlasMapTitle').textContent=center.label||center.id;
  $('atlasMapHint').textContent=`Left: ${plural(left.length,'module')} that use it · right: ${plural(right.length,'module')} it uses.`;
  $('atlasMapBack').hidden=false;
  $('atlasMapBack').textContent=state.domain?`Back to ${state.domain}`:'All domains';
}

function renderMap(){state.selected?renderFocusedMap():state.domain?renderDomainFocus():renderDomainMap();}

function graphOnlyText(){
  return `Graph only for this ${state.repo==='localai'?'snapshot':'repository'}. Findings, Ask and Goose cover Local AI's latest scan for now.`;
}

function renderFindings(){
  const changedNodes=productionNodes(state.graph).filter(n=>n.changed);
  if(!live()){
    // A snapshot has no findings yet, but it does know what changed since the snapshot before it.
    if(state.mode==='changes'&&state.graph){
      const since=state.graph.snapshot?.changedSince;
      $('atlasFindingCount').textContent=plural(changedNodes.length,'module');
      $('atlasFindingList').innerHTML=changedNodes.length?changedNodes.slice(0,40).map(n=>`
        <button type="button" class="atlas-finding" data-atlas-node="${esc(n.id)}">
          <span class="atlas-finding-sev">changed</span>
          <span class="atlas-finding-copy"><strong>${esc(n.id)}</strong><small>${esc(n.domain||'')} · risk ${Number(n.risk)||0}</small></span>
        </button>`).join(''):
        `<div class="atlas-empty">${since?`Nothing changed since ${esc(String(since).slice(0,7))}.`:'This is the first snapshot of this repository, so there is nothing earlier to compare with.'}</div>`;
      return;
    }
    $('atlasFindingCount').textContent='';
    $('atlasFindingList').innerHTML=`<div class="atlas-empty">${esc(graphOnlyText())}</div>`;
    return;
  }
  const groups=aggregateFindings(state.summary?.findings||[]);
  let shown=groups;
  if(state.mode==='changes'){
    const changed=new Set(productionNodes(state.graph).filter(n=>n.changed).map(n=>n.id));
    shown=groups.filter(g=>changed.has(g.node));
  }else if(state.mode==='risk')shown=groups.filter(g=>['critical','high'].includes(g.severity));
  else if(state.mode==='evidence')shown=groups.filter(g=>g.signals.some(s=>String(s.rule||'').includes('test')));
  $('atlasFindingCount').textContent=plural(shown.length,'module');
  // The latest scan reads the deploy checkout, which has no edits: "changed" only means something for a snapshot.
  if(state.mode==='changes'&&!changedNodes.length){
    $('atlasFindingList').innerHTML='<div class="atlas-empty">No change data for the latest scan: it reads the deploy checkout, which has no edits. Choose a snapshot to see what changed since the one before it.</div>';
    return;
  }
  $('atlasFindingList').innerHTML=shown.slice(0,20).map(g=>`
    <button type="button" class="atlas-finding atlas-sev-${esc(g.severity)}" data-atlas-node="${esc(g.node)}">
      <span class="atlas-finding-sev">${esc(g.severity)}</span>
      <span class="atlas-finding-copy"><strong>${esc(g.node)}</strong><small>${esc(findingReason(g))}</small></span>
    </button>`).join('')||'<div class="atlas-empty">No findings match this lens.</div>';
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
  if(!node)return;
  $('atlasSelectedPath').textContent=node.id;
  $('atlasSelectedMeta').textContent=`${node.domain||'Unknown'} · ${riskText(node)} risk · score ${Number(node.risk)||0}`;
  const direct=Number(node.testRefs)||0;
  const effective=Number(node.effectiveTestSignal ?? state.details?.effectiveTestSignal ?? direct)||0;
  const evidence=Array.isArray(node.testEvidence)?node.testEvidence:(Array.isArray(state.details?.testEvidence)?state.details.testEvidence:[]);
  $('atlasNodeStats').innerHTML=[
    ['Inbound',Number(node.inbound)||0],['Outbound',Number(node.outbound)||0],
    ['Direct test imports',direct],['Effective test signal',effective],
    ['Changed',node.changed?'Yes':'No'],['Test evidence',evidence.length]
  ].map(([k,v])=>`<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
  $('atlasEvidenceList').innerHTML=evidence.slice(0,8).map(e=>`<li><code>${esc(e.test||e.path||'')}</code><span>${esc(e.kind||'evidence')}</span></li>`).join('')||
    '<li class="atlas-muted">No enhanced test evidence returned for this node.</li>';
}

// Ask, Goose and the model need Local AI's latest scan; the quick questions are about a module, so they also need one.
function renderAskControls(){
  const off=!live();
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
  renderMap();
  // The intelligence service knows only Local AI's latest scan: a snapshot's node comes from its own graph.
  if(!live()){state.details=productionNodes(state.graph).find(n=>n.id===id)||null;renderInspector();if(reveal)revealInspector();return;}
  const seq=state.seq;
  try{
    state.details=await getJson(`/api/atlas/node?path=${encodeURIComponent(id)}`,{timeout:12000});
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
  renderFindings();renderSearchResults();
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
  const off=!live();
  $('atlasGraphOnly').hidden=!off;
  $('atlasGraphOnly').textContent=off?graphOnlyText():'';
  renderAskControls();
}

function clearGraph(title,hint){
  state.graph=null;state.summary=null;state.selected=null;state.details=null;state.domain=null;
  $('atlasMapBack').hidden=true;
  $('atlasMap').innerHTML='';
  $('atlasMap').closest('.atlas-map-wrap').classList.remove('atlas-has-list');
  if($('atlasDomainList'))$('atlasDomainList').innerHTML='';
  $('atlasMapTitle').textContent=title;
  $('atlasMapHint').textContent=hint;
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
    if(state.commit&&!rows.some(r=>r.commit===state.commit)){state.commit=rows[0]?.commit||'';retired=true;}
    // A repository chosen before its list arrived (or while the list was unavailable) gets its newest snapshot now.
    if(state.repo!=='localai'&&!state.commit)state.commit=rows[0]?.commit||'';
    renderPicker();
    if(state.repo!=='localai'&&!state.commit){
      clearGraph(`No snapshots of ${repoLabel(state.repo)} yet`,'Use Snapshot now to take the first one.');
      status(listed._error?`The snapshot list is unavailable: ${listed._error}`:`No snapshots of ${repoLabel(state.repo)} yet.`,listed._error?'error':'neutral');
      return;
    }
    const url=live()?'/api/atlas/graph':`/api/atlas/graph?repo=${encodeURIComponent(state.repo)}&commit=${encodeURIComponent(state.commit)}`;
    const [graph,summary,releases]=await Promise.all([
      getJson(url,{timeout:12000}),
      live()?getJson('/api/atlas/summary',{timeout:12000}).catch(error=>({providers:{},findings:[],_error:error.message})):null,
      live()?getJson('/api/releases',{timeout:8000}).catch(()=>null):null
    ]);
    if(seq!==state.seq||!state.active)return;
    state.graph=graph;state.summary=summary;
    renderKpis();if(summary)providerBadge();renderMap();renderFindings();renderSearchResults();
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
    // Say how old the scan is; the latest scan is only re-run by hand, so it can predate the running release.
    const fresh=live()?scanFreshness(graph.generatedAt,releases?.current?.deployedAt):
      {text:`Snapshot scanned ${ago(graph.generatedAt)||'at an unknown time'}.`,stale:false};
    status(`${fresh.text}${caveats.length?` Also: ${caveats.join('; ')}.`:''}`,fresh.stale||caveats.length?'warn':'ok');
  }catch(error){
    if(seq!==state.seq||!state.active)return;
    if(!state.graph)clearGraph(`${repoLabel(state.repo)} could not be loaded`,'Try Refresh evidence, or choose another commit.');
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
      body:JSON.stringify({question:q,node:state.selected||undefined,model:state.model||undefined})
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
      method:'POST',timeout:15000,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({question:q,node:state.selected||undefined})
    });
    box.dataset.tone='ok';
    box.textContent=`Read-only investigation brief created:\n${payload.briefPath||'Atlas investigation directory'}\n\n${payload.goose?.available?'Goose CLI detected.':'Goose is not on PATH; the brief is still ready for later investigation.'}`;
  }catch(error){box.dataset.tone='error';box.textContent=error.message;}
}

function activate(){
  if(state.active)return;
  state.active=true;
  if(!state.graph)void refresh();
  pollSnapshot();
}
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
function openDomain(id){state.domain=id;state.selected=null;state.details=null;renderMap();renderInspector();renderSearchResults();}
$('atlasMapBack').addEventListener('click',()=>{
  if(state.selected){state.selected=null;state.details=null;}else state.domain=null;
  renderMap();renderInspector();renderSearchResults();
  $('atlasMapTitle').focus();
});
$('atlasMap').addEventListener('click',e=>{
  const n=e.target.closest('[data-atlas-node]');if(n)return void selectNode(n.dataset.atlasNode,{reveal:true});
  const d=e.target.closest('[data-atlas-domain]');if(d)openDomain(d.dataset.atlasDomain);
});
// Domain boxes and file nodes are both role="button": Enter and Space open them, as a click does.
$('atlasMap').addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ')return;
  const n=e.target.closest('[data-atlas-node]');if(n){e.preventDefault();return void selectNode(n.dataset.atlasNode,{reveal:true});}
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
