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

exported.aggregateFindings = aggregateFindings;
exported.domainSummary = domainSummary;
if(typeof module==='object'&&module.exports){module.exports=exported;return;}

const page=document.getElementById('architecture');
if(!page)return;
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={
  active:false,loading:false,summary:null,graph:null,selected:null,details:null,
  mode:'architecture',model:localStorage.getItem('localai.atlas.model')||'',request:null
};

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
  $('atlasKpiFindings').textContent=groups.length||'0';
}

function riskText(node){
  const risk=Number(node?.risk)||0;
  return risk>=70?'Critical':risk>=48?'High':risk>=28?'Medium':'Low';
}

function filteredNodes(){
  let nodes=productionNodes(state.graph);
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
  const width=980,height=500,cols=4,cardW=185,cardH=74,xGap=48,yGap=55,startX=55,startY=50;
  const pos=new Map();
  domains.slice(0,16).forEach((d,i)=>{
    const col=i%cols,row=Math.floor(i/cols);
    pos.set(d.id,{x:startX+col*(cardW+xGap),y:startY+row*(cardH+yGap)});
  });
  const lineHtml=links.filter(l=>pos.has(l.source)&&pos.has(l.target)).slice(0,60).map(l=>{
    const a=pos.get(l.source),b=pos.get(l.target);
    return `<line class="atlas-edge" x1="${a.x+cardW/2}" y1="${a.y+cardH/2}" x2="${b.x+cardW/2}" y2="${b.y+cardH/2}"><title>${esc(l.source)} → ${esc(l.target)} · ${l.count}</title></line>`;
  }).join('');
  const nodeHtml=domains.slice(0,16).map(d=>{
    const p=pos.get(d.id);
    return `<g class="atlas-domain-node" data-atlas-domain="${esc(d.id)}" transform="translate(${p.x} ${p.y})" tabindex="0" role="button" aria-label="${esc(d.id)}, ${d.count} modules, maximum risk ${d.risk}">
      <rect width="${cardW}" height="${cardH}" rx="10"></rect>
      <text x="14" y="25" class="atlas-domain-title">${esc(d.id)}</text>
      <text x="14" y="47" class="atlas-domain-meta">${d.count} modules · risk ${d.risk}${d.changed?` · ${d.changed} changed`:''}</text>
    </g>`;
  }).join('');
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  svg.innerHTML=`<g class="atlas-edges">${lineHtml}</g><g>${nodeHtml}</g>`;
  $('atlasMapTitle').textContent='System domains';
  $('atlasMapHint').textContent='Select a domain or search for a module to focus the dependency map.';
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
  $('atlasMapTitle').textContent=center.label||center.id;
  $('atlasMapHint').textContent=`${left.length} visible dependents · ${right.length} visible dependencies`;
}

function renderMap(){state.selected?renderFocusedMap():renderDomainMap();}

function renderFindings(){
  const groups=aggregateFindings(state.summary?.findings||[]);
  let shown=groups;
  if(state.mode==='changes'){
    const changed=new Set(productionNodes(state.graph).filter(n=>n.changed).map(n=>n.id));
    shown=groups.filter(g=>changed.has(g.node));
  }else if(state.mode==='risk')shown=groups.filter(g=>['critical','high'].includes(g.severity));
  else if(state.mode==='evidence')shown=groups.filter(g=>g.signals.some(s=>String(s.rule||'').includes('test')));
  $('atlasFindingCount').textContent=`${shown.length} modules`;
  $('atlasFindingList').innerHTML=shown.slice(0,20).map(g=>`
    <button type="button" class="atlas-finding atlas-sev-${esc(g.severity)}" data-atlas-node="${esc(g.node)}">
      <span class="atlas-finding-sev">${esc(g.severity)}</span>
      <span class="atlas-finding-copy"><strong>${esc(g.node)}</strong><small>${g.signals.length} signal${g.signals.length===1?'':'s'} · ${Math.round(g.confidence*100)}% max confidence</small></span>
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

async function selectNode(id){
  state.selected=id;
  renderMap();
  try{
    state.details=await getJson(`/api/atlas/node?path=${encodeURIComponent(id)}`,{timeout:12000});
  }catch(error){
    state.details=productionNodes(state.graph).find(n=>n.id===id)||null;
    status(`Node loaded from static graph; intelligence detail unavailable: ${error.message}`,'warn');
  }
  renderInspector();
}

function renderModes(){
  for(const b of page.querySelectorAll('[data-atlas-mode]')){
    const on=b.dataset.atlasMode===state.mode;
    b.classList.toggle('active',on);
    b.setAttribute('aria-selected',String(on));
  }
  renderFindings();renderSearchResults();
}

async function refresh(){
  if(state.loading)return;
  state.loading=true;setBusy(true);status('Refreshing deterministic architecture evidence…');
  try{
    const [graph,summary]=await Promise.all([
      getJson('/api/atlas/graph',{timeout:12000}),
      getJson('/api/atlas/summary',{timeout:12000}).catch(error=>({providers:{},findings:[],_error:error.message}))
    ]);
    if(!state.active)return;
    state.graph=graph;state.summary=summary;
    renderKpis();providerBadge();renderMap();renderFindings();renderSearchResults();
    if(state.selected)await selectNode(state.selected);
    // Say plainly when the diagram is old, partial or missing its change data, rather than looking complete.
    const caveats=[];
    if(graph.stale)caveats.push('showing the last good graph; the newest copy could not be read');
    if(graph.stats?.truncated)caveats.push(`only the first ${graph.stats.maxFiles} files were scanned`);
    if(graph.stats?.gitError)caveats.push('changed files are unknown (git failed)');
    if(summary._error)caveats.push(`intelligence service is offline: ${summary._error}`);
    status(caveats.length?`Atlas: ${caveats.join('; ')}.`:'Atlas evidence is current.',caveats.length?'warn':'ok');
  }catch(error){
    if(state.active)status(error.name==='AbortError'?'Architecture refresh timed out.':error.message,'error');
  }finally{state.loading=false;setBusy(false);}
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
}
function deactivate(){state.active=false;state.request?.abort?.();state.request=null;}

$('atlasRefresh').addEventListener('click',()=>void refresh());
$('atlasNodeSearch').addEventListener('input',renderSearchResults);
$('atlasSearchResults').addEventListener('click',e=>{const b=e.target.closest('[data-atlas-node]');if(b){$('atlasSearchResults').hidden=true;void selectNode(b.dataset.atlasNode);}});
$('atlasFindingList').addEventListener('click',e=>{const b=e.target.closest('[data-atlas-node]');if(b)void selectNode(b.dataset.atlasNode);});
function openDomain(d){$('atlasNodeSearch').value=d.dataset.atlasDomain;renderSearchResults();$('atlasNodeSearch').focus();}
$('atlasMap').addEventListener('click',e=>{
  const n=e.target.closest('[data-atlas-node]');if(n)return void selectNode(n.dataset.atlasNode);
  const d=e.target.closest('[data-atlas-domain]');if(d)openDomain(d);
});
// Domain boxes and file nodes are both role="button": Enter and Space open them, as a click does.
$('atlasMap').addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ')return;
  const n=e.target.closest('[data-atlas-node]');if(n){e.preventDefault();return void selectNode(n.dataset.atlasNode);}
  const d=e.target.closest('[data-atlas-domain]');if(d){e.preventDefault();openDomain(d);}
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
