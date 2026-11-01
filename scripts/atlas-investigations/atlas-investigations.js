// atlas-investigations-v1
(() => {
  'use strict';
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const API_LIST = '/api/atlas/investigations?limit=50';
  const API_READ = '/api/atlas/investigation?id=';
  const API_GOOSE = '/api/atlas/goose';
  const API_PROJECTS = '/api/projects';
  const API_KNOWLEDGE = '/api/knowledge/import';
  const state = { items: [], current: null, content: '', busy: false, opener: null };

  function safeStatus(value) {
    const status = String(value || 'unknown').toLowerCase();
    return ['completed','failed','prepared','running','legacy'].includes(status) ? status : 'unknown';
  }
  function humanStatus(value) {
    return {completed:'Completed',failed:'Failed',prepared:'Prepared',running:'Running',legacy:'Legacy prompt',unknown:'Unknown'}[safeStatus(value)];
  }
  function formatTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date);
  }
  function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '';
    if (value < 1000) return `${Math.round(value)} ms`;
    if (value < 60000) return `${(value/1000).toFixed(value<10000?1:0)} s`;
    const minutes = Math.floor(value/60000), seconds = Math.round((value%60000)/1000);
    return `${minutes}m ${seconds}s`;
  }
  async function jsonFetch(url, options={}) {
    const response = await fetch(url,{cache:'no-store',...options,headers:{Accept:'application/json',...(options.headers||{})}});
    let payload={}; try{payload=await response.json()}catch{payload={}}
    if(!response.ok){const detail=payload?.error?.message||payload?.message||`HTTP ${response.status}`;throw new Error(String(detail))}
    return payload;
  }
  function setInlineStatus(message,stateName='') {
    const answer=$('atlasAnswer'); if(!answer)return; answer.hidden=false; answer.dataset.state=stateName; answer.textContent=message;
  }
  function selectedNode(){const body=$('atlasSelectedBody');if(body?.hidden)return '';return String($('atlasSelectedPath')?.textContent||'').trim()}
  function requestedQuestion(){return String($('atlasQuestion')?.value||'').trim()||'Investigate the highest-priority Atlas architecture findings and identify the most actionable engineering gap.'}

  function buildDialog(){
    if($('atlasInvestigationDialog'))return $('atlasInvestigationDialog');
    const dialog=document.createElement('dialog'); dialog.id='atlasInvestigationDialog'; dialog.className='atlas-investigation-dialog'; dialog.setAttribute('aria-labelledby','atlasInvestigationTitle');
    dialog.innerHTML=`
      <div class="atlas-investigation-shell">
        <header class="atlas-investigation-header"><div><div class="atlas-investigation-eyebrow">Atlas · Goose</div><h2 id="atlasInvestigationTitle">Investigations</h2><p id="atlasInvestigationSubtitle">Read-only architecture investigations, newest first.</p></div><button id="atlasInvestigationClose" class="btn-outline atlas-investigation-close" type="button" aria-label="Close investigations">Close</button></header>
        <div id="atlasInvestigationStatus" class="atlas-investigation-status" role="status" aria-live="polite"></div>
        <div class="atlas-investigation-layout">
          <aside class="atlas-investigation-history" aria-label="Investigation history"><div class="atlas-investigation-history-head"><strong>Recent</strong><button id="atlasInvestigationRefresh" class="btn-outline" type="button">Refresh</button></div><div id="atlasInvestigationList" class="atlas-investigation-list"></div></aside>
          <article class="atlas-investigation-report" aria-label="Investigation report"><div id="atlasInvestigationEmpty" class="atlas-investigation-empty">Choose an investigation to read it.</div><div id="atlasInvestigationReport" hidden><div class="atlas-investigation-report-head"><div class="atlas-investigation-meta-line"><span id="atlasInvestigationBadge" class="atlas-investigation-badge"></span><span id="atlasInvestigationWhen"></span><span id="atlasInvestigationDuration"></span></div><h3 id="atlasInvestigationObjective"></h3><code id="atlasInvestigationNode" hidden></code></div><div id="atlasInvestigationBody" class="atlas-investigation-body"></div></div></article>
        </div>
        <footer class="atlas-investigation-actions"><button id="atlasInvestigationCopy" class="btn-outline" type="button" disabled>Copy report</button><button id="atlasInvestigationDownload" class="btn-outline" type="button" disabled>Download .md</button><button id="atlasInvestigationPromote" class="btn-outline" type="button" disabled>Add to project knowledge</button><div id="atlasInvestigationKnowledge" class="atlas-investigation-knowledge" hidden><label for="atlasInvestigationProject">Project</label><select id="atlasInvestigationProject"></select><button id="atlasInvestigationKnowledgeSave" class="btn-primary" type="button">Add source</button></div></footer>
      </div>`;
    document.body.appendChild(dialog);
    $('atlasInvestigationClose').addEventListener('click',()=>dialog.close());
    $('atlasInvestigationRefresh').addEventListener('click',()=>loadHistory(true));
    $('atlasInvestigationCopy').addEventListener('click',copyCurrent);
    $('atlasInvestigationDownload').addEventListener('click',downloadCurrent);
    $('atlasInvestigationPromote').addEventListener('click',prepareKnowledgePromotion);
    $('atlasInvestigationKnowledgeSave').addEventListener('click',promoteToKnowledge);
    dialog.addEventListener('close',()=>{
      const panel=$('atlasInvestigationKnowledge');if(panel)panel.hidden=true;
      const opener=state.opener;state.opener=null;
      if(opener instanceof HTMLElement&&opener.isConnected&&!opener.disabled)opener.focus({preventScroll:true});
    });
    return dialog;
  }
  function clearNode(el){while(el?.firstChild)el.removeChild(el.firstChild)}
  function appendParagraph(parent,lines){if(!lines.length)return;const p=document.createElement('p');p.textContent=lines.join(' ').trim();if(p.textContent)parent.appendChild(p);lines.length=0}
  function renderMarkdownSafe(text,parent){
    clearNode(parent);let lines=String(text||'').replace(/\r\n/g,'\n').split('\n');
    const structured=Boolean(lines[0]?.startsWith('<!-- atlas-investigation-meta '));
    if(structured){
      lines.shift();
      const firstReportSection=lines.findIndex(line=>/^##\s+(Executive result|Error|Execution diagnostics|Evidence snapshot)\s*$/i.test(line.trim()));
      if(firstReportSection>=0)lines=lines.slice(firstReportSection);
    }
    let paragraph=[],code=null,list=null;
    const flush=()=>{appendParagraph(parent,paragraph);if(list){parent.appendChild(list);list=null}};
    for(const line of lines){
      if(line.startsWith('```')){flush();if(code){parent.appendChild(code);code=null}else{code=document.createElement('pre');code.className='atlas-investigation-code';code.appendChild(document.createElement('code'))}continue}
      if(code){code.firstChild.textContent+=`${line}\n`;continue}
      const heading=/^(#{1,4})\s+(.+)$/.exec(line);if(heading){flush();const h=document.createElement(`h${Math.min(4,heading[1].length+1)}`);h.textContent=heading[2];parent.appendChild(h);continue}
      const bullet=/^\s*[-*]\s+(.+)$/.exec(line);if(bullet){appendParagraph(parent,paragraph);if(!list||list.tagName!=='UL'){if(list)parent.appendChild(list);list=document.createElement('ul')}const li=document.createElement('li');li.textContent=bullet[1];list.appendChild(li);continue}
      const ordered=/^\s*\d+\.\s+(.+)$/.exec(line);if(ordered){appendParagraph(parent,paragraph);if(!list||list.tagName!=='OL'){if(list)parent.appendChild(list);list=document.createElement('ol')}const li=document.createElement('li');li.textContent=ordered[1];list.appendChild(li);continue}
      if(!line.trim()){flush();continue}paragraph.push(line.trim())
    }
    flush();if(code)parent.appendChild(code);
    const evidenceHeading=[...parent.querySelectorAll('h3,h4')].find(el=>/^Evidence snapshot$/i.test(el.textContent||''));
    if(evidenceHeading){const details=document.createElement('details');details.className='atlas-investigation-details';const summary=document.createElement('summary');summary.textContent='Evidence & execution details';details.appendChild(summary);let node=evidenceHeading;while(node){const next=node.nextSibling;details.appendChild(node);node=next}parent.appendChild(details)}
  }
  function historyButton(item){
    const button=document.createElement('button');button.type='button';button.className='atlas-investigation-history-item';button.dataset.investigationId=item.id;button.setAttribute('aria-pressed','false');
    const top=document.createElement('span');top.className='atlas-investigation-history-top';const badge=document.createElement('span');badge.className=`atlas-investigation-mini-badge is-${safeStatus(item.status)}`;badge.textContent=humanStatus(item.status);const when=document.createElement('time');when.textContent=formatTime(item.createdAt);if(item.createdAt)when.dateTime=item.createdAt;top.append(badge,when);
    const objective=document.createElement('strong');objective.textContent=item.objective||'Atlas investigation';const node=document.createElement('small');node.textContent=item.node||'Repository-wide';button.append(top,objective,node);button.addEventListener('click',()=>openInvestigation(item.id));return button;
  }
  function renderHistory(){const list=$('atlasInvestigationList');if(!list)return;clearNode(list);if(!state.items.length){const empty=document.createElement('div');empty.className='atlas-investigation-empty';empty.textContent='No investigations yet. Run Goose from Architecture to create one.';list.appendChild(empty);return}state.items.forEach(item=>list.appendChild(historyButton(item)))}
  async function loadHistory(force=false){
    const list=$('atlasInvestigationList');if(list&&(force||!state.items.length))list.innerHTML='<div class="atlas-investigation-empty">Loading investigations…</div>';
    try{const payload=await jsonFetch(API_LIST);state.items=Array.isArray(payload.items)?payload.items:[];renderHistory();return state.items}catch(error){if(list){clearNode(list);const box=document.createElement('div');box.className='atlas-investigation-error';box.textContent=`Could not load investigations: ${error.message}`;const retry=document.createElement('button');retry.type='button';retry.className='btn-outline';retry.textContent='Retry';retry.addEventListener('click',()=>loadHistory(true));box.appendChild(retry);list.appendChild(box)}return[]}
  }
  function renderCurrent(){
    const item=state.current;if(!item)return;$('atlasInvestigationEmpty').hidden=true;$('atlasInvestigationReport').hidden=false;const badge=$('atlasInvestigationBadge');badge.className=`atlas-investigation-badge is-${safeStatus(item.status)}`;badge.textContent=humanStatus(item.status);$('atlasInvestigationWhen').textContent=formatTime(item.createdAt);$('atlasInvestigationDuration').textContent=formatDuration(item.durationMs);$('atlasInvestigationObjective').textContent=item.objective||'Atlas investigation';const node=$('atlasInvestigationNode');node.hidden=!item.node;node.textContent=item.node||'';renderMarkdownSafe(state.content,$('atlasInvestigationBody'));for(const id of['atlasInvestigationCopy','atlasInvestigationDownload','atlasInvestigationPromote'])$(id).disabled=!state.content;
  }
  async function openInvestigation(id){
    const report=$('atlasInvestigationReport'),empty=$('atlasInvestigationEmpty');if(report)report.hidden=true;if(empty){empty.hidden=false;empty.textContent='Opening investigation…'}
    try{const payload=await jsonFetch(API_READ+encodeURIComponent(id));state.current=payload.investigation||null;state.content=String(payload.content||'');renderCurrent();document.querySelectorAll('.atlas-investigation-history-item').forEach(button=>{const active=button.dataset.investigationId===id;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))});const scroller=document.querySelector('.atlas-investigation-report');if(scroller)scroller.scrollTop=0}catch(error){if(empty)empty.textContent=`Could not open investigation: ${error.message}`}
  }
  async function openViewer(preferredId='',opener=null){
    const dialog=buildDialog();if(!dialog.open){state.opener=opener instanceof HTMLElement?opener:document.activeElement;dialog.showModal()}$('atlasInvestigationStatus').textContent='';await loadHistory(true);const target=preferredId||state.items[0]?.id||'';if(target)await openInvestigation(target);else{$('atlasInvestigationEmpty').hidden=false;$('atlasInvestigationEmpty').textContent='No investigations yet. Run Goose from Architecture to create one.';$('atlasInvestigationReport').hidden=true}$('atlasInvestigationClose')?.focus({preventScroll:true});
  }
  async function runGoose(event){
    event?.preventDefault?.();event?.stopImmediatePropagation?.();if(state.busy)return;const button=$('atlasGoose');state.busy=true;if(button){button.disabled=true;button.dataset.originalLabel=button.textContent;button.textContent='Investigating…';button.setAttribute('aria-busy','true')}setInlineStatus('Goose investigation started. This is read-only and may take a few minutes.','loading');
    try{const node=selectedNode();const payload=await jsonFetch(API_GOOSE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:requestedQuestion(),...(node?{node}:{})})});const status=safeStatus(payload.status);if(status==='completed')setInlineStatus('Goose investigation completed. Opening the report.','success');else if(status==='prepared')setInlineStatus('Goose was unavailable, so Atlas saved a prepared investigation prompt.','warning');else setInlineStatus(payload.error||'Goose investigation failed. The report contains diagnostics.','error');await openViewer(payload.investigationId||'',button)}catch(error){setInlineStatus(`Goose request failed: ${error.message}. Open Investigations to check whether a report was still saved.`,'error')}finally{state.busy=false;if(button){button.disabled=false;button.removeAttribute('aria-busy');button.textContent=button.dataset.originalLabel||'Goose brief'}}
  }
  async function copyCurrent(){if(!state.content)return;try{await navigator.clipboard.writeText(state.content);$('atlasInvestigationStatus').textContent='Report copied.'}catch{$('atlasInvestigationStatus').textContent='Could not copy the report.'}}
  function downloadCurrent(){if(!state.content||!state.current)return;const blob=new Blob([state.content],{type:'text/markdown;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${state.current.id||'atlas-investigation'}.md`;a.click();setTimeout(()=>URL.revokeObjectURL(url),0)}
  async function prepareKnowledgePromotion(){
    const panel=$('atlasInvestigationKnowledge'),select=$('atlasInvestigationProject');if(!panel||!select)return;panel.hidden=false;select.disabled=true;select.replaceChildren(new Option('Loading projects…',''));
    try{const payload=await jsonFetch(API_PROJECTS),items=Array.isArray(payload.items)?payload.items:[];select.replaceChildren();if(!items.length){select.append(new Option('Create a project first',''));$('atlasInvestigationKnowledgeSave').disabled=true;return}items.forEach(project=>select.append(new Option(project.name||project.id,project.id)));select.disabled=false;$('atlasInvestigationKnowledgeSave').disabled=false;select.focus()}catch(error){select.replaceChildren(new Option('Projects unavailable',''));$('atlasInvestigationKnowledgeSave').disabled=true;$('atlasInvestigationStatus').textContent=`Could not load projects: ${error.message}`}
  }
  async function promoteToKnowledge(){
    if(!state.content||!state.current)return;const projectId=$('atlasInvestigationProject')?.value||'';if(!projectId)return;const button=$('atlasInvestigationKnowledgeSave');button.disabled=true;
    try{await jsonFetch(API_KNOWLEDGE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:`${state.current.id}.md`,content:state.content,mimeType:'text/markdown',projectId})});$('atlasInvestigationStatus').textContent='Investigation added to project knowledge.';$('atlasInvestigationKnowledge').hidden=true}catch(error){$('atlasInvestigationStatus').textContent=`Could not add to knowledge: ${error.message}`}finally{button.disabled=false}
  }
  function boot(){
    const goose=$('atlasGoose'),architecture=$('architecture');if(!goose||!architecture)return;buildDialog();
    // Capture phase intentionally replaces the legacy prompt-only Goose handler.
    goose.addEventListener('click',runGoose,{capture:true});
    if(!$('atlasInvestigationsOpen')){const button=document.createElement('button');button.id='atlasInvestigationsOpen';button.className='btn-outline';button.type='button';button.textContent='Investigations';button.addEventListener('click',()=>openViewer('',button));goose.insertAdjacentElement('afterend',button)}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
