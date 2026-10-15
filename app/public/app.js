const $ = id => document.getElementById(id);
const qsa = sel => [...document.querySelectorAll(sel)];
const state = {
  view: 'home', mode: 'auto', model: null,
  messages: JSON.parse(localStorage.getItem('localAiMessages') || '[]'),
  activity: [], library: [], workspace: { recent: [], pinned: [], activity: [], totals: {} },
  libraryKind: 'all', librarySearch: '', chatPhase: 'idle', streamController: null,
  statusTimer: null, activityTimer: null, checkpointsLoaded: false, imageModels: null, lastLibrarySignature: ''
};
const icons = {chat:'✦',research:'⌕',image:'◇',system:'●',recovery:'↻',conversation:'✦',artifact:'□'};
const phaseLabels = {idle:'Idle',routing:'Routing',sending:'Preparing',streaming:'Responding',searching:'Researching',generating:'Generating',done:'Complete',error:'Needs attention'};

function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function safeUrl(value,{image=false}={}){
  try{
    const raw=String(value||'').trim();
    if(!raw)return '';
    if(raw.startsWith('/')) return raw;
    const u=new URL(raw,location.origin);
    const allowed=image?['http:','https:','blob:']:['http:','https:'];
    return allowed.includes(u.protocol)?u.href:'';
  }catch{return '';}
}
function cacheBust(value){
  const safe=safeUrl(value,{image:true}); if(!safe)return '';
  const u=new URL(safe,location.origin); u.searchParams.set('_t',String(Date.now()));
  return u.origin===location.origin?u.pathname+u.search+u.hash:u.href;
}
function ago(iso){const d=Date.now()-new Date(iso).getTime();if(!Number.isFinite(d))return '';const future=d<0,s=Math.floor(Math.abs(d)/1000);if(s<60)return future?'in under a minute':'just now';const v=s<3600?`${Math.floor(s/60)}m`:s<86400?`${Math.floor(s/3600)}h`:`${Math.floor(s/86400)}d`;return future?`in ${v}`:`${v} ago`;}
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._hide);t._hide=setTimeout(()=>t.classList.remove('show'),2200);}
function setPhase(phase,detail=''){
  state.chatPhase=phase;
  if($('chatState')){$('chatState').textContent=detail||phaseLabels[phase]||phase;$('chatState').dataset.phase=phase;}
  if($('executionLabel')) $('executionLabel').textContent=detail||phaseLabels[phase]||phase;
  renderAgentMap(phase);
}
function renderAgentMap(phase = 'idle') {
  const steps = [
    ['route', 'Route', 'Interpret command'],
    ['work', 'Work', 'Use the selected capability'],
    ['compose', 'Compose', 'Build the result'],
    ['complete', 'Finish', 'Save activity and artifacts']
  ];
  
  const rank = { idle: -1, routing: 0, sending: 1, searching: 1, generating: 1, streaming: 2, done: 3, error: 1 };
  const active = rank[phase] ?? -1;
  
  // Only show full agent map when in active execution phase; on Home the card is hidden while idle.
  const card = $('homeExecutionCard');
  if (card) card.hidden = phase === 'idle';
  if (phase === 'idle') {
    $('agentMap').innerHTML = '<div class="agent-node inactive"><span class="agent-pulse"></span><div class="kicker">Idle</div><strong>Waiting for command</strong></div>';
    return;
  }
  
  $('agentMap').innerHTML = steps.map((s, i) => {
    const cls = phase === 'error' && i === active ? 'error' : i < active ? 'done' : i === active ? 'active' : '';
    return `<div class="agent-node ${cls}"><span class="agent-pulse"></span><div class="kicker">${esc(s[0])}</div><strong>${esc(s[1])}</strong><span>${esc(s[2])}</span></div>`;
  }).join('');
}
function activityHtml(item){const run=item.meta?.runId?`<button class="btn activity-run" type="button" data-open-run="${esc(item.meta.runId)}">Open run</button>`:'';return `<div class="activity-item"><div class="activity-icon">${icons[item.type]||'·'}</div><div><div class="activity-title">${esc(item.title)}</div><div class="activity-detail">${esc(item.detail||'')}</div>${run}</div><div class="activity-time">${ago(item.at)}</div></div>`;}
function artifactRow(item){const image=item.kind==='image'?safeUrl(item.meta?.imageUrl||item.data?.imageUrl,{image:true}):'';return `<div class="activity-item${image?' activity-item--thumb':''}"><div class="activity-icon">${image?`<img src="${esc(image)}" alt="" loading="lazy">`:icons[item.kind]||'□'}</div><div><div class="activity-title">${esc(item.title)}</div><div class="activity-detail">${esc(item.summary||'')}</div></div><div class="activity-time">${ago(item.createdAt)}</div></div>`;}

// Data loaders for pages whose content is fetched on open. Every route (rail, tabs, mobile sheet, ⌘K) goes through showView.
const VIEW_LOADERS={inbox:()=>loadInbox(),approvals:()=>loadApprovals(),memory:()=>loadMemory(),operations:()=>loadMonitors(),changes:()=>Promise.all([loadChanges(),loadEngineeringRuns()]),quality:()=>loadQuality(),issues:()=>loadIssues(),powershell:()=>loadPowerShellJobs()};
function showView(id){
  id=window.LocalAIViews?.resolve(id)||id;
  if(!$(id))return;
  if(state.view==='ask' && id!=='ask' && state.chatPhase==='streaming') abortStream('Stream stopped when leaving Ask');
  state.view=id;qsa('.view').forEach(x=>x.classList.toggle('active',x.id===id));qsa('.navbtn').forEach(x=>x.classList.toggle('active',x.dataset.view===id));
  if(id==='library')loadLibrary(); if(id==='activity')loadActivity(); if(id==='create')loadCheckpoints();
  window.scrollTo({top:0,behavior:'instant'});

  if(id==='projects') loadProjects?.().catch(()=>{});
  if(id==='knowledge') loadKnowledge?.().catch(()=>{});
  if(id==='agents') loadAgents?.().catch(()=>{});
  if(id==='automationStudio') loadAutomations?.().catch(()=>{});
  if(id==='workbench') loadWorkbench?.().catch(()=>{});
  // Sources and Memory are tabs of Projects: open them on the project you were looking at.
  if(releaseState.selectedProject)for(const [view,sel] of [['knowledge','knowledgeProject'],['memory','memoryProject']])if(id===view&&$(sel))$(sel).value=releaseState.selectedProject;
  if(VIEW_LOADERS[id])Promise.resolve().then(VIEW_LOADERS[id]).catch(()=>{});

}
qsa('[data-view]').forEach(el=>el.addEventListener('click',()=>showView(el.dataset.view)));

const CHAT_SUGGESTIONS=['Explain this error message to me','Draft a reply to a tricky email','Summarize a long document'];
function renderMessages(follow=true){
  const box=$('messages');
  if(!state.messages.length){box.innerHTML=`<div id="chatEmpty" class="empty-state chat-empty"><div class="chat-empty-mark" aria-hidden="true"><svg class="icon" aria-hidden="true"><use href="#i-workspace"/></svg></div><div class="empty-state__title">Private chat</div><p>Runs on your own hardware. Nothing you type leaves this network unless you turn on web research. Requests to change Local AI become change requests that wait for your approval.</p><div class="chat-suggest">${CHAT_SUGGESTIONS.map(t=>`<button type="button" class="chat-suggest-btn" data-chat-suggest>${esc(t)}</button>`).join('')}</div></div>`;qsa('[data-chat-suggest]').forEach(b=>b.onclick=()=>{const i=$('chatInput');i.value=b.textContent;i.focus();});return;}
  box.innerHTML=state.messages.map((m,i)=>{
    const action=m.action?.view?`<div class="actions" style="margin-top:9px"><button class="btn" data-msg-action="${i}">${esc(m.action.label||'Open')}</button></div>`:'';
    return `<div class="msg ${m.role} ${m.streaming?'streaming':''}" data-msg="${i}">${esc(m.content||'')}${action}</div>`;
  }).join('');
  qsa('[data-msg-action]').forEach(b=>b.onclick=()=>{const m=state.messages[Number(b.dataset.msgAction)];if(!m?.action?.view)return;showView(m.action.view);if(m.action.changeId)loadChanges?.(m.action.changeId);if(m.action.runId)loadEngineeringRuns?.(m.action.runId)});
  if(follow)box.scrollTop=box.scrollHeight;
}
function chatNearBottom(box=$('messages')){return !box||box.scrollHeight-box.scrollTop-box.clientHeight<80;}
// While streaming, repaint only the streaming bubble (text only, so output stays escaped) once per frame.
let streamPaintFrame=0;
function paintStreamingMessage(idx){
  if(streamPaintFrame)return;
  streamPaintFrame=requestAnimationFrame(()=>{
    streamPaintFrame=0;
    const m=state.messages[idx],box=$('messages');if(!m?.streaming||!box)return;
    const el=box.querySelector(`[data-msg="${idx}"]`);
    if(!el||m.action){renderMessages(chatNearBottom(box));return;}
    const follow=chatNearBottom(box);el.textContent=m.content||'';if(follow)box.scrollTop=box.scrollHeight;
  });
}
function persistMessages(){localStorage.setItem('localAiMessages',JSON.stringify(state.messages.slice(-20).map(({role,content})=>({role,content}))));}
function abortStream(reason='Cancelled'){
  if(state.streamController){state.streamController.abort();state.streamController=null;}
  state.messages.forEach(m=>m.streaming=false);renderMessages();setPhase('idle');if(reason)toast(reason);
}
function newChat(){
  if(state.messages.length && !window.confirm('Start a new conversation? The current completed turns remain available in Library, but this browser draft will be cleared.'))return;
  abortStream('');state.messages=[];localStorage.removeItem('localAiMessages');renderMessages();$('chatMeta').textContent='';setPhase('idle');toast('New conversation');
}
$('newChatBtn').addEventListener('click',newChat);$('chatModelChip').addEventListener('click',()=>showView('models'));
// Phone composer: a globe button drives the web research checkbox and mirrors whether it is on or unavailable.
function syncWebToggle(){const c=$('webSearch'),b=$('chatWebToggle');if(!c||!b)return;b.setAttribute('aria-pressed',String(c.checked));b.disabled=c.disabled;b.title=c.title||'Web research';}
$('chatWebToggle')?.addEventListener('click',()=>{const c=$('webSearch');if(c.disabled)return;c.checked=!c.checked;c.dispatchEvent(new Event('change',{bubbles:true}));syncWebToggle();});
$('webSearch')?.addEventListener('change',syncWebToggle);
new MutationObserver(syncWebToggle).observe($('webSearch'),{attributes:true,attributeFilter:['disabled','title']});
function openAsk(web=false){$('webSearch').checked=web;syncWebToggle();showView('ask');setTimeout(()=>$('chatInput').focus(),20);}
function openCreate(){showView('create');setTimeout(()=>$('imagePrompt').focus(),20);}

function renderSources(meta,sources=[]){
  meta.replaceChildren();
  if(!sources.length)return;
  const wrap=document.createElement('div');wrap.className='sources';
  sources.forEach((s,i)=>{const url=safeUrl(s.url);const line=document.createElement('div');line.append(`${i+1}. `);if(url){const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=s.title||s.url;line.appendChild(a);}else line.append(document.createTextNode(s.title||'Source'));wrap.appendChild(line);});
  meta.appendChild(wrap);
}
function recentConversationContext(){return state.messages.slice(-4).map(m=>`${m.role.toUpperCase()}: ${String(m.content||'').slice(0,5000)}`).join('\n\n')}
async function resolveIntentRequest(text,mode='auto'){
  try{const r=await fetch('/api/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,mode,messages:state.messages.slice(-12).map(({role,content})=>({role,content}))})});const j=await r.json();if(r.ok)return j}catch{}
  return localRoute(text,mode);
}
function engineeringRequestWithContext(text,route){
  if(route?.reason!=='engineering-continuation')return route?.effectiveRequest||text;
  const context=recentConversationContext();
  const prior=route?.effectiveRequest&&route.effectiveRequest!==text?route.effectiveRequest:'the most recent Local AI self-change';
  return `Continue and implement this Local AI self-change: ${prior}\n\nThe user's continuation command is: ${text}\n\nRECENT CONVERSATION CONTEXT:\n${context}`;
}
function engineeringRunText(run) {
  const active = [...(run.steps || [])].reverse().find(x => x.state === 'running' || x.state === 'waiting') || (run.steps || []).at(-1);
  const attempt = `${run.attempt || 0}/${run.maxAttempts}`;
  const change = run.finalChangeId ? `\nChange: ${run.finalChangeId}` : '';

  if (run.status === 'running')
    return `Engineering Agent is working…\nRun: ${run.id}\nAttempt: ${attempt}\n${active ? `${active.name}: ${active.state}\n${active.detail || ''}` : 'Planning will begin shortly.'}`;

  if (run.status === 'awaiting_approval')
    return `Validated change ready for review.\nRun: ${run.id}\nAttempt: ${attempt}${change}\nCurrent step: ${active?.name || 'N/A'}\nDetail: ${active?.detail || 'No detail available'}`;

  if (run.status === 'approved')
    return `Engineering change approved.\nRun: ${run.id}\nAttempt: ${attempt}${change}\nThe validated change has been approved.`;

  if (run.status === 'apply_requested')
    return `Engineering deployment queued.\nRun: ${run.id}\nAttempt: ${attempt}${change}\nThe approved change is queued for deployment.`;

  if (run.status === 'applied')
    return `Engineering change applied successfully.\nRun: ${run.id}\nAttempt: ${attempt}${change}\nDeployment is complete.`;

  if (run.status === 'needs_attention')
    return `Engineering run needs attention.\nRun: ${run.id}\nAttempt: ${attempt}${change}\n${run.error || active?.detail || 'No validated patch was produced.'}`;

  return `Engineering status: ${run.status || 'unknown'}\nRun: ${run.id}\nAttempt: ${attempt}${change}`;
}









async function pollEngineeringIntent(runId,msg=null){
  if(msg&&!state.messages.includes(msg))return;
  try{
    const data=await evoApi('/api/engineering/runs');
    const run=(data.items||[]).find(x=>x.id===runId);
    if(!run)return;
    
    if($('engineeringState'))$('engineeringState').textContent=String(run.status||'').replace(/_/g,' ');
    if($('engineeringStatus'))$('engineeringStatus').textContent=engineeringRunText(run).split('\n').join(' ? ');

    if(msg&&state.messages.includes(msg)){
      const m=msg;
      m.content=engineeringRunText(run);
      m.streaming=run.status==='running';
      m.action=null;

      if(run.status==='awaiting_approval')
        m.action={view:'changes',changeId:run.finalChangeId,label:'Review validated change'};
      else if(run.status==='needs_attention')
        m.action={view:'changes',runId:run.id,label:'Open change requests'};

      renderMessages();
    }

    try{await loadEngineeringRuns(run.id)}catch{}

    if(run.status==='running'){
      setTimeout(()=>pollEngineeringIntent(runId,msg),2000);
      return;
    }

    if(msg){if(!state.messages.includes(msg))return;persistMessages();}

    try{
      await Promise.all([
        loadChanges(run.finalChangeId||''),
        loadApprovals(),
        loadInbox(),
        loadActivity(),
        loadWorkspace(),
        loadHomeCapabilities()
      ]);
    }catch{}

    const labels={
      awaiting_approval:'Awaiting approval',
      approved:'Approved',
      apply_requested:'Deployment queued',
      applied:'Applied',
      needs_attention:'Engineering needs attention'
    };

    const notices={
      awaiting_approval:'Validated engineering change ready for approval',
      approved:'Engineering change approved',
      apply_requested:'Engineering deployment queued',
      applied:'Engineering change applied successfully',
      needs_attention:'Engineering run needs attention'
    };

    if(run.status==='needs_attention'){
      setPhase('error',labels[run.status]);
      toast(notices[run.status]);
      return;
    }

    setPhase('done',labels[run.status]||'Engineering updated');
    toast(notices[run.status]||'Engineering status updated');
  }catch(e){
    setTimeout(()=>pollEngineeringIntent(runId,msg),3000);
  }
}
async function submitEngineeringIntent(request,{assistantIndex=null,navigate=false}={}){
  if(navigate)showView('changes');
  if($('engineeringRequest'))$('engineeringRequest').value=request;if($('engineeringTarget'))$('engineeringTarget').value='self';if($('engineeringRoot'))$('engineeringRoot').disabled=true;
  if($('engineeringState'))$('engineeringState').textContent='running';if($('engineeringStatus'))$('engineeringStatus').textContent='Intent routed to Engineering. Starting bounded plan → stage → validate → repair…';
  const msg=assistantIndex!==null?state.messages[assistantIndex]||null:null;setPhase('sending','Starting Engineering Agent…');if(msg){msg.content='Engineering request accepted. Starting the real Engineering Agent…';renderMessages()}
  const r=await fetch('/api/engineering/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request,target:'self',root:'app',maxAttempts:3})});const data=await r.json();if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);const run=data.run;
  if(msg&&state.messages.includes(msg)){msg.content=engineeringRunText(run);msg.streaming=true;renderMessages()}
  pollEngineeringIntent(run.id,msg);return run;
}
async function sendChat(){
  if(['routing','sending','streaming','searching'].includes(state.chatPhase)) return;
  const input=$('chatInput');
  const prompt=input.value.trim();
  if(!prompt) return;
  const web=$('webSearch').checked;
  setPhase('routing','Understanding intent…');
  const route=web?{intent:'research',confidence:1,reason:'web-search-enabled'}:await resolveIntentRequest(prompt,'auto');
  input.value='';

  if(route.intent==='engineering'&&route.confidence>=0.9){
    const request=engineeringRequestWithContext(prompt,route);
    state.messages.push({role:'user',content:prompt});
    const assistant={role:'assistant',content:'Engineering request accepted…',streaming:true};
    state.messages.push(assistant);persistMessages();renderMessages();
    const idx=state.messages.length-1;
    try{await submitEngineeringIntent(request,{assistantIndex:idx,navigate:false});await Promise.all([loadActivity(),loadLibrary(),loadWorkspace()])}
    catch(e){if(!state.messages.includes(assistant))return;assistant.streaming=false;assistant.content=`Engineering action failed safely: ${e.message}`;persistMessages();renderMessages();setPhase('error','Engineering failed')}
    return;
  }

  state.messages.push({role:'user',content:prompt});
  persistMessages();
  renderMessages();

  const assistant={role:'assistant',content:'',streaming:true};
  state.messages.push(assistant);
  renderMessages();
  const idx=state.messages.length-1;
  setPhase(web?'searching':'sending',web?'Searching local metasearch…':'Preparing response…');

  const controller=new AbortController();
  state.streamController=controller;
  $('sendBtn').disabled=false;
  $('sendLabel').textContent='Stop';$('sendBtn').dataset.state='stop';
  let sources=[];

  try{
    const payload={
      messages:state.messages.slice(0,-1).slice(-16).map(({role,content})=>({role,content})),
      webSearch:web,
      model:state.model
    };
    const r=await fetch('/api/chat/stream',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
      signal:controller.signal
    });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    setPhase('streaming','Responding…');
    const reader=r.body.getReader();
    const decoder=new TextDecoder();
    let buf='';

    while(true){
      const packet=await reader.read();
      if(packet.done) break;
      buf+=decoder.decode(packet.value,{stream:true});
      while(true){
        const sep=buf.indexOf('\n\n');
        if(sep<0) break;
        const block=buf.slice(0,sep);
        buf=buf.slice(sep+2);
        const eventMatch=/^event:\s*(.+)$/m.exec(block);
        const dataMatch=/^data:\s*(.+)$/m.exec(block);
        if(!dataMatch) continue;
        let data;
        try{ data=JSON.parse(dataMatch[1]); }catch{ continue; }
        const event=eventMatch?.[1];
        if(event==='token'){
          state.messages[idx].content+=data.text||'';
          paintStreamingMessage(idx);
        }else if(event==='meta'){
          sources=data.sources||[];
        }else if(event==='done'){
          $('chatMeta').textContent=`${data.model} · ${data.elapsedMs} ms${sources.length?` · ${sources.length} sources`:''}`;
          renderSources($('chatMeta'),sources);
          setPhase('done','Complete');
        }else if(event==='error'){
          throw new Error(data.error||'Streaming failed');
        }
      }
    }
    state.messages[idx].streaming=false;
    persistMessages();
    renderMessages(chatNearBottom());
    await Promise.all([loadActivity(),loadLibrary(),loadWorkspace()]);
  }catch(e){
    if(e.name!=='AbortError'){
      state.messages[idx].streaming=false;
      state.messages[idx].content=`Error: ${e.message}`;
      renderMessages();
      setPhase('error','Needs attention');
    }
  }finally{
    state.streamController=null;
    $('sendBtn').disabled=false;
    $('sendLabel').textContent='Send';delete $('sendBtn').dataset.state;
    if(state.chatPhase!=='error'&&state.chatPhase!=='done') setPhase('idle');
  }
}
$('sendBtn').addEventListener('click',()=>{ if(state.streamController) abortStream('Response stopped'); else sendChat(); });$('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();}});

qsa('.mode').forEach(b=>b.addEventListener('click',()=>{state.mode=b.dataset.mode;qsa('.mode').forEach(x=>x.classList.toggle('active',x===b));syncModeSelect();}));
// Phones get one compact select instead of six wrapped mode buttons; it mirrors the buttons (hidden and gated modes included).
function syncModeSelect(){const sel=$('commandModeSelect');if(!sel)return;const opts=qsa('.mode').filter(b=>getComputedStyle(b).display!=='none');const html=opts.map(b=>`<option value="${esc(b.dataset.mode)}"${b.disabled?' disabled':''}>${esc(b.textContent)}</option>`).join('');if(sel.dataset.html!==html){sel.innerHTML=html;sel.dataset.html=html;}sel.value=state.mode||'auto';}
$('commandModeSelect')?.addEventListener('change',e=>qsa('.mode').find(b=>b.dataset.mode===e.target.value)?.click());
$('commandModeSelect')?.addEventListener('focus',syncModeSelect);
// Home quick starts (phones): pick the mode and put the cursor in the command box.
qsa('[data-quick-mode]').forEach(b=>b.addEventListener('click',()=>{const m=qsa('.mode').find(x=>x.dataset.mode===b.dataset.quickMode);if(m&&!m.disabled)m.click();$('commandInput').focus();}));
new MutationObserver(syncModeSelect).observe(document.querySelector('.modes'),{subtree:true,attributes:true,attributeFilter:['disabled','class']});
new MutationObserver(syncModeSelect).observe(document.body,{attributes:true,attributeFilter:['class']});
function localRoute(text,mode='auto'){
  const t=String(text||'').toLowerCase();
  if(mode==='engineering')return {intent:'engineering',target:'self',confidence:1,reason:'explicit-mode'};
  const continuation=/^(do it|implement it|apply that|apply it|make those changes|make the changes|go ahead|use your recommendation|proceed|ship it)[.! ]*$/i.test(String(text||''));
  const engineeringVerb=/\b(improve|fix|update|refactor|patch|implement|apply|modify|change|upgrade|rewrite|enhance|adjust|add|remove|rename|rework|rethink|polish|repair|build|redesign|reorganize|evolve)\b/.test(t);
  const softwareTarget=/\b(local ai|this site|the site|your site|this app|the app|application|navigation|sidebar|menu|create page|home page|ask page|ui|interface|dashboard|workbench|engineer|engineering agent|powershell workbench|html|css|javascript|server\.js|app\.js|endpoint|api route|web page)\b/.test(t);
  const informational=/^(how|what|why|which|where|when|explain|describe|tell me|show me how|can you explain|could you explain)\b/.test(t);
  if(continuation)return {intent:'engineering',target:'self',confidence:.96,reason:'engineering-continuation'};
  if(engineeringVerb&&softwareTarget&&!informational)return {intent:'engineering',target:'self',confidence:.97,reason:'self-modification-language'};
  if(/\b(generate|create)\b/.test(t)&&/\b(html|css|javascript|code|component|page|dashboard|endpoint)\b/.test(t)&&!informational)return {intent:'engineering',target:'self',confidence:.94,reason:'software-creation-language'};
  if(['ask','create','research','automate'].includes(mode))return {intent:mode,confidence:1,reason:'explicit-mode'};
  if(/\b(generate|create|render|draw|illustrate)\b/.test(t)&&/\b(image|picture|photo|artwork|portrait|scene|illustration|logo|poster)\b/.test(t))return {intent:'create',confidence:.96,reason:'visual-generation-language'};
  if(/\b(workflow|automation|automate|n8n|trigger|webhook|schedule|data table)\b/.test(t))return {intent:'automate',confidence:.9,reason:'automation-language'};
  if(/\b(latest|today|current|news|search the web|web search|research online|look up)\b/.test(t))return {intent:'research',confidence:.86,reason:'fresh-information-language'};
  return {intent:'ask',confidence:.7,reason:'default'};
}
async function runCommand(){
  const input=$('commandInput'),text=input.value.trim();if(!text)return;setPhase('routing','Understanding intent…');const route=await resolveIntentRequest(text,state.mode);toast(`Routed to ${route.intent}`);input.value='';
  if(route.intent==='engineering'){
    const request=engineeringRequestWithContext(text,route);showView('changes');$('engineeringRequest').value=request;$('engineeringTarget').value='self';$('engineeringRoot').disabled=true;
    try{await submitEngineeringIntent(request,{navigate:true})}catch(e){$('engineeringStatus').textContent=`Error: ${e.message}`;setPhase('error','Engineering failed');toast(e.message)}
  }else if(route.intent==='create'){openCreate();$('imagePrompt').value=text;setPhase('idle');}
  else if(route.intent==='automate'){showView('automations');setPhase('done','Automation workspace');}
  else{openAsk(route.intent==='research');$('chatInput').value=text;setTimeout(sendChat,20);}
}
$('commandGo').addEventListener('click',runCommand);$('commandInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();runCommand();}});document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&!$('cmdk')){e.preventDefault();showView('home');setTimeout(()=>$('commandInput').focus(),20);}});

// ---- Images: engines (Fast / Quality / Best), shape, prompt help, upscale ----
const imageUi={engine:null,aspect:'square',style:'none',count:1,lastBody:null,timer:null,edit:null,last:null};
function imageEngineList(){return state.imageModels?.engines||[]}
function fmtSec(s){return s>=90?`${Math.round(s/60)} min`:`${Math.round(s)} s`}
function renderImageControls(){
  const data=state.imageModels||{},engines=imageEngineList();
  if(!imageUi.engine||!engines.some(e=>e.id===imageUi.engine))imageUi.engine=data.defaultEngine||engines[0]?.id||null;
  $('imageEngines').innerHTML=engines.length?engines.map(e=>`<button type="button" role="radio" aria-checked="${e.id===imageUi.engine}" class="img-engine${e.id===imageUi.engine?' active':''}" data-engine="${esc(e.id)}"><b>${esc(e.label)}</b><span>${esc(e.blurb)}</span><small>${e.estimateSec?`About ${fmtSec(e.estimateSec)} here`:esc(IMAGE_TYPICAL[e.id]||'')}</small></button>`).join(''):'<div class="meta">No image models found. Check Health for Image generation.</div>';
  const eng=engines.find(e=>e.id===imageUi.engine),base=(eng?.base||512)>=1024?1024:512;
  $('imageAspects').innerHTML=(data.aspects||[]).map(a=>{const [w,h]=a.sizes[base];return `<button type="button" role="radio" aria-checked="${a.id===imageUi.aspect}" class="img-aspect${a.id===imageUi.aspect?' active':''}" data-aspect="${esc(a.id)}"><i style="aspect-ratio:${w}/${h}"></i><span>${esc(a.label)}</span><small>${w}×${h}</small></button>`}).join('');
  $('imageStyles').innerHTML=(data.styles||[]).map(st=>`<button type="button" role="radio" aria-checked="${st.id===imageUi.style}" class="img-style${st.id===imageUi.style?' active':''}" data-style="${esc(st.id)}">${esc(st.label)}</button>`).join('');
  qsa('#imageCount [data-count]').forEach(b=>{const on=Number(b.dataset.count)===imageUi.count;b.classList.toggle('active',on);b.setAttribute('aria-checked',String(on))});
  const editing=!!imageUi.edit;$('imageEditPanel').hidden=!editing;$('imageShapeGroup').hidden=editing;$('imagePromptLabel').textContent=editing?'Describe the change, or the whole new picture':'Describe the image';$('generateBtn').textContent=editing?'Apply edit':imageUi.count>1?`Create ${imageUi.count} images`:'Create image';
  $('imageUpscaleRow').hidden=!data.upscale;
  const custom=[...(data.custom||[])];$('checkpoint').innerHTML='<option value="">Engine\'s model</option>'+custom.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('imageModelInfo').textContent=eng?`${eng.label} uses ${eng.family==='flux'?'FLUX.1 schnell':eng.family==='sdxl'?'SDXL Lightning':'Stable Diffusion 1.5'}.`:'';
  $('generateBtn').disabled=!engines.length&&!custom.length;
}
// Typical times on a 6 GB GTX 1660 SUPER, until this machine has measured its own.
const IMAGE_TYPICAL={fast:'About 15 s',quality:'About 1 min',best:'About 3 min'};
async function loadCheckpoints(force){if(state.checkpointsLoaded&&!force)return;try{const r=await fetch('/api/images/models',{cache:'no-store'}),j=await r.json();if(!r.ok)throw new Error(j.error||'Unable to load image models');state.imageModels=j;state.checkpointsLoaded=true;renderImageControls();renderImageRecent()}catch(e){$('imageEngines').innerHTML=`<div class="meta">${esc(e.message)}</div>`;$('generateBtn').disabled=true}}
function renderImageRecent(){const items=(state.library||[]).filter(x=>x.kind==='image'&&x.meta?.imageUrl).slice(0,8);$('imageRecent').innerHTML=items.length?items.map(x=>`<button type="button" class="img-thumb" data-recent="${esc(x.id)}" title="${esc(x.title||'')}"><img loading="lazy" alt="${esc(x.title||'Image')}" src="${esc(cacheBust(x.meta.imageUrl)||'')}"></button>`).join(''):'<div class="meta">Images you make are kept here and in the Library.</div>'}
function showBatch(images){const box=$('imageBatch');if(!images||images.length<2){box.hidden=true;box.innerHTML='';return}box.hidden=false;box.innerHTML=images.map((im,i)=>`<button type="button" class="img-thumb${i===0?' active':''}" data-batch="${i}" aria-label="Image ${i+1} of ${images.length}, seed ${im.seed}"><img alt="" src="${esc(cacheBust(im.imageUrl)||'')}"></button>`).join('');box.onclick=e=>{const b=e.target.closest('[data-batch]');if(!b)return;const im=images[Number(b.dataset.batch)];qsa('#imageBatch .img-thumb').forEach(x=>x.classList.toggle('active',x===b));const src=cacheBust(im.imageUrl);$('generatedImage').src=src;$('imageOpen').href=src;imageUi.last={...imageUi.last,imageUrl:im.imageUrl,seed:im.seed};$('imageMeta').textContent=$('imageMeta').textContent.replace(/seed \d+/,`seed ${im.seed}`)}}
function showImage(url,metaText,usedPrompt,original){imageUi.last={imageUrl:url};const src=cacheBust(url);if(!src)return;$('imageStage').innerHTML='';$('generatedImage').src=src;$('imageResult').style.display='block';$('imageMeta').textContent=metaText||'';$('imageOpen').href=src;$('imageActions').hidden=false;const showUsed=usedPrompt&&usedPrompt!==original;$('imageUsedPromptBox').hidden=!showUsed;$('imageUsedPrompt').textContent=showUsed?usedPrompt:''}
function imageRequestBody(){const engine=imageUi.engine,ckpt=$('checkpoint').value,num=id=>{const v=$(id).value.trim();return v===''?undefined:Number(v)};const edit=imageEditPayload();return {...edit,style:imageUi.style,count:imageUi.count,prompt:$('imagePrompt').value.trim(),engine:ckpt?undefined:engine,checkpoint:ckpt||undefined,aspect:imageUi.aspect,upscale:!$('imageUpscaleRow').hidden&&$('imageUpscale').checked,enhance:$('imageEnhance').checked,steps:num('steps'),cfg:num('cfg'),seed:num('imageSeed'),negativePrompt:$('negativePrompt').value.trim()||undefined}}
async function generateImage(bodyOverride){
  const body=bodyOverride||imageRequestBody();if(!body.prompt){$('imagePrompt').focus();return}
  imageUi.lastBody={...body,seed:undefined};$('generateBtn').disabled=true;$('imageAgain').disabled=true;setPhase('generating','Generating image…');$('imageResult').style.display='none';$('imageActions').hidden=true;$('imageMeta').textContent='';
  const eng=imageEngineList().find(e=>e.id===body.engine),started=Date.now(),est=eng?.estimateSec?eng.estimateSec*(body.count||1):null;showBatch(null);
  const tick=()=>{const s=(Date.now()-started)/1000;$('imageStage').innerHTML=`<div class="img-working"><div class="img-spinner" aria-hidden="true"></div><b>${body.enhance&&s<8?'Improving your prompt…':body.source?'Editing…':body.count>1?`Drawing ${body.count} images…`:'Drawing…'}</b><span>${fmtSec(s)}${est?` of about ${fmtSec(est)}`:''}</span></div>`};
  tick();clearInterval(imageUi.timer);imageUi.timer=setInterval(tick,1000);
  try{const r=await fetch('/api/images/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);
    showImage(j.imageUrl,`${j.engineLabel||'Image'}${j.edited?' edit':''} · ${j.width}×${j.height} · ${fmtSec(j.elapsedMs/1000)}${(j.images||[]).length>1?` for ${j.images.length}`:''} · seed ${j.seed}${j.upscaled?' · upscaled':''}`,j.usedPrompt,j.prompt);showBatch(j.images);
    setPhase('done','Image ready');await Promise.all([loadActivity(),loadLibrary(),loadWorkspace()]);renderImageRecent();loadCheckpoints(true);
  }catch(e){$('imageStage').innerHTML=`<div class="img-error"><b>That didn't work</b><span>${esc(e.message)}</span></div>`;setPhase('error','Image failed')}
  finally{clearInterval(imageUi.timer);$('generateBtn').disabled=false;$('imageAgain').disabled=false}}
$('imageEngines').addEventListener('click',e=>{const b=e.target.closest('[data-engine]');if(b){imageUi.engine=b.dataset.engine;$('checkpoint').value='';renderImageControls()}});
$('imageAspects').addEventListener('click',e=>{const b=e.target.closest('[data-aspect]');if(b){imageUi.aspect=b.dataset.aspect;renderImageControls()}});
$('imageRecent').addEventListener('click',e=>{const b=e.target.closest('[data-recent]');const x=b&&(state.library||[]).find(i=>i.id===b.dataset.recent);if(x)showImage(x.meta.imageUrl,`${x.summary||''}${x.meta.seed!=null?` · seed ${x.meta.seed}`:''}`,x.data?.usedPrompt,x.data?.prompt)});
$('generateBtn').addEventListener('click',()=>generateImage());$('imageAgain').addEventListener('click',()=>imageUi.lastBody&&generateImage(imageUi.lastBody));
$('imagePrompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();generateImage()}});
$('imageStyles').addEventListener('click',e=>{const b=e.target.closest('[data-style]');if(b){imageUi.style=b.dataset.style;renderImageControls()}});
$('imageCount').addEventListener('click',e=>{const b=e.target.closest('[data-count]');if(b){imageUi.count=Number(b.dataset.count);renderImageControls()}});
// ---- Editing: the source picture on one canvas, the painted mask on another laid over it ----
const EDIT_MAX=1024;
function startImageEdit(src){const img=new Image();img.onload=()=>{const k=Math.min(1,EDIT_MAX/Math.max(img.naturalWidth,img.naturalHeight));const w=Math.max(64,Math.round(img.naturalWidth*k/8)*8),h=Math.max(64,Math.round(img.naturalHeight*k/8)*8);
  for(const c of [$('imageEditCanvas'),$('imageMaskCanvas')]){c.width=w;c.height=h}
  $('imageEditCanvas').getContext('2d').drawImage(img,0,0,w,h);$('imageMaskCanvas').getContext('2d').clearRect(0,0,w,h);
  imageUi.edit={w,h,marked:false};renderImageControls();$('imageEditPanel').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});$('imagePrompt').focus()};
  img.onerror=()=>{$('imageModelInfo').textContent='That image could not be opened for editing.'};img.src=src}
function stopImageEdit(){imageUi.edit=null;$('imageUpload').value='';renderImageControls()}
function imageEditPayload(){if(!imageUi.edit)return {};const {w,h,marked}=imageUi.edit,out={source:$('imageEditCanvas').toDataURL('image/png'),sourceWidth:w,sourceHeight:h,strength:Number($('imageStrength').value)/100};
  if(marked){const m=document.createElement('canvas');m.width=w;m.height=h;const mc=m.getContext('2d'),src=$('imageMaskCanvas').getContext('2d').getImageData(0,0,w,h),dst=mc.createImageData(w,h);
    for(let i=0;i<src.data.length;i+=4){const v=src.data[i+3]>0?255:0;dst.data[i]=dst.data[i+1]=dst.data[i+2]=v;dst.data[i+3]=255}mc.putImageData(dst,0,0);out.mask=m.toDataURL('image/png')}
  return out}
(()=>{const c=$('imageMaskCanvas');let drawing=false,lastPt=null;
  const pt=e=>{const r=c.getBoundingClientRect();return [(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height]};
  const paint=p=>{const ctx=c.getContext('2d'),size=Number($('imageBrush').value)*c.width/Math.max(1,c.getBoundingClientRect().width);ctx.strokeStyle=ctx.fillStyle='rgba(92,184,255,.55)';ctx.lineWidth=size;ctx.lineCap='round';ctx.globalCompositeOperation='source-over';
    ctx.beginPath();if(lastPt){ctx.moveTo(...lastPt);ctx.lineTo(...p);ctx.stroke()}else{ctx.arc(p[0],p[1],size/2,0,Math.PI*2);ctx.fill()}lastPt=p;if(imageUi.edit&&!imageUi.edit.marked){imageUi.edit.marked=true;$('imageEditHint').textContent='Only the painted area will change. Keep painting, or Clear marks to redraw everything.'}};
  c.addEventListener('pointerdown',e=>{if(!imageUi.edit)return;drawing=true;lastPt=null;c.setPointerCapture(e.pointerId);paint(pt(e));e.preventDefault()});
  c.addEventListener('pointermove',e=>{if(drawing)paint(pt(e))});
  const end=()=>{drawing=false;lastPt=null};c.addEventListener('pointerup',end);c.addEventListener('pointercancel',end);})();
$('imageMaskClear').addEventListener('click',()=>{const c=$('imageMaskCanvas');c.getContext('2d').clearRect(0,0,c.width,c.height);if(imageUi.edit)imageUi.edit.marked=false;$('imageEditHint').textContent='Paint over the part to change. Leave it unmarked to redraw the whole image.'});
$('imageStrength').addEventListener('input',()=>{$('imageStrengthOut').textContent=`${$('imageStrength').value}%`});
$('imageEditCancel').addEventListener('click',stopImageEdit);
$('imageEditThis').addEventListener('click',()=>{if(imageUi.last?.imageUrl)startImageEdit(cacheBust(imageUi.last.imageUrl))});
$('imageUpload').addEventListener('change',()=>{const f=$('imageUpload').files?.[0];if(!f)return;if(f.size>20*1024*1024){$('imageModelInfo').textContent='Choose an image under 20 MB.';return}const rd=new FileReader();rd.onload=()=>startImageEdit(rd.result);rd.readAsDataURL(f)});
$('clearImageBtn').addEventListener('click',()=>{stopImageEdit();showBatch(null);$('imagePrompt').value='';$('imageMeta').textContent='';$('imageResult').style.display='none';$('imageActions').hidden=true;$('imageUsedPromptBox').hidden=true;$('imageStage').innerHTML='<div class="img-placeholder">Your image appears here.</div>';setPhase('idle')});

function renderActivity(){const user=state.activity;$('activityList').innerHTML=user.length?user.map(activityHtml).join(''):'<div class="empty">No activity yet.</div>';$('homeActivity').innerHTML=user.slice(0,5).map(activityHtml).join('')||'<div class="empty">No recent activity.</div>';qsa('[data-open-run]').forEach(b=>b.onclick=async()=>{if(!await window.LocalAIRuns?.open(b.dataset.openRun))toast('That run is no longer in the execution history')});}
async function loadActivity(){try{const r=await fetch('/api/activity',{cache:'no-store'}),j=await r.json();state.activity=j.items||[];renderActivity();}catch{}}
$('clearUserActivityBtn').addEventListener('click',async()=>{if(!confirm('Clear user activity? System and recovery audit events will be preserved.'))return;await fetch('/api/activity/clear',{method:'POST'});await Promise.all([loadActivity(),loadWorkspace()]);toast('User activity cleared');});

function artifactCard(item){
  const image=item.kind==='image'?safeUrl(item.meta?.imageUrl||item.data?.imageUrl,{image:true}):'';const symbol=icons[item.kind]||'□';
  return `<article class="artifact${image?' artifact--image':''}" data-artifact="${esc(item.id)}"><div class="artifact-preview">${image?`<img src="${esc(image)}" alt="">`:symbol}</div><div class="artifact-body"><div class="artifact-kind">${esc(item.kind||'artifact')}</div><div class="artifact-title" title="${esc(item.title)}">${esc(item.title)}</div><div class="artifact-summary">${esc(item.summary||'')}</div><div class="artifact-foot"><span class="meta">${ago(item.createdAt)}</span><span><button class="iconbtn pin-artifact" title="${item.pinned?'Unpin':'Pin'}" aria-label="${item.pinned?'Unpin':'Pin'} ${esc(item.title)}">${item.pinned?'★':'☆'}</button><button class="iconbtn delete-artifact" title="Delete" aria-label="Delete ${esc(item.title)}">×</button></span></div></div></article>`;
}
function renderLibrary(){
  let items=state.library;const query=state.librarySearch.toLowerCase();if(state.libraryKind==='pinned')items=items.filter(x=>x.pinned);else if(state.libraryKind!=='all')items=items.filter(x=>x.kind===state.libraryKind);if(query)items=items.filter(x=>`${x.title} ${x.summary} ${x.kind}`.toLowerCase().includes(query));
  $('libraryCount').textContent=`${items.length} item${items.length===1?'':'s'}`;const sig=items.map(x=>`${x.id}:${x.pinned}`).join('|');if(sig===state.lastLibrarySignature&&$('libraryGrid').children.length)return;state.lastLibrarySignature=sig;$('libraryGrid').innerHTML=items.length?items.map(artifactCard).join(''):`<div class="empty">${state.library.length?'Nothing matches that search or filter.':'Nothing saved yet. Chats, research and images you make are saved here.'}</div>`;
  qsa('.pin-artifact').forEach(b=>b.addEventListener('click',async e=>{const card=e.target.closest('[data-artifact]'),item=state.library.find(x=>x.id===card.dataset.artifact);if(!item)return;await fetch('/api/library/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id,pinned:!item.pinned})});state.lastLibrarySignature='';await Promise.all([loadLibrary(),loadWorkspace()]);}));
  qsa('.delete-artifact').forEach(b=>b.addEventListener('click',async e=>{const id=e.target.closest('[data-artifact]').dataset.artifact;if(!confirm('Delete this Library item?'))return;await fetch('/api/library/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});state.lastLibrarySignature='';await Promise.all([loadLibrary(),loadWorkspace(),loadActivity()]);}));
}
async function loadLibrary(){try{const r=await fetch('/api/library',{cache:'no-store'}),j=await r.json();state.library=j.items||[];renderLibrary();}catch{}}
$('librarySearch').addEventListener('input',e=>{state.librarySearch=e.target.value;state.lastLibrarySignature='';renderLibrary();});qsa('[data-kind]').forEach(b=>b.addEventListener('click',()=>{state.libraryKind=b.dataset.kind;qsa('[data-kind]').forEach(x=>x.classList.toggle('active',x===b));state.lastLibrarySignature='';renderLibrary();}));
async function loadWorkspace(){try{const r=await fetch('/api/workspace',{cache:'no-store'}),j=await r.json();state.workspace=j;$('homeRecent').innerHTML=(j.recent||[]).slice(0,6).map(artifactRow).join('')||'<div class="empty">No saved work yet.</div>';const pinned=(j.pinned||[]).slice(0,4);$('homePinned').innerHTML=pinned.map(artifactRow).join('');$('homePinnedCard').hidden=!pinned.length;}catch{}}

function normalizedState(v){return ['HEALTHY','DEGRADED','DOWN','OPTIONAL_OFFLINE'].includes(v)?v:'DEGRADED';}
function serviceDisplayState(s){return s.displayState||(s.required===false&&s.state!=='HEALTHY'?'OPTIONAL_OFFLINE':normalizedState(s.state));}
function serviceStateLabel(s){const v=serviceDisplayState(s);return v==='OPTIONAL_OFFLINE'?'Optional · Offline':v==='HEALTHY'?'Healthy':v==='DEGRADED'?'Degraded':'Down';}
function serviceDescription(s){
  if(s.required===false&&s.state!=='HEALTHY')return 'Optional companion is not reachable. Core Local AI remains available.';
  if(s.state==='HEALTHY')return s.required===false?'Optional companion is reachable.':'Core capability is ready.';
  return s.state==='DEGRADED'?'Capability responded but needs attention.':'Core capability is unavailable.';
}
let statusRefreshing=false;
async function refreshStatus(force=false){
  if(document.hidden&&!force)return;
  if(statusRefreshing)return;
  statusRefreshing=true;
  const retry=$('statusRetryBtn');if(retry){retry.disabled=true;retry.textContent='Checking…';}
  try{
    const r=await fetch('/api/status',{cache:'no-store'}),j=await r.json(),overall=normalizedState(j.overall);
    for(const id of ['homeDot','sideDot'])$(id).className=`dot ${overall}`;
    const coreBad=(j.services||[]).filter(s=>s.required!==false&&s.state!=='HEALTHY');
    const optionalBad=(j.services||[]).filter(s=>s.required===false&&s.state!=='HEALTHY');
    const friendly=overall==='HEALTHY'?'Healthy':'Attention needed';
    $('homeState').textContent=friendly;$('sideState').textContent=overall==='HEALTHY'?'Healthy':'Attention';
    $('statusSummary').innerHTML=`<span class="dot ${overall}"></span> ${coreBad.length?`${coreBad.length} core capability issue${coreBad.length===1?'':'s'}`:optionalBad.length?`Core ready · ${optionalBad.length} optional companion${optionalBad.length===1?'':'s'} offline`:'Everything is ready'}`;
    const checked=$('statusCheckedAt');if(checked)checked.textContent=j.checkedAt?`Checked ${new Date(j.checkedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'})}`:'';
    $('serviceList').innerHTML=(j.services||[]).map(s=>{const st=serviceDisplayState(s);return `<div class="service service-card ${st}"><div class="service-copy"><strong>${esc(s.label)}</strong><small>${esc(serviceDescription(s))}</small></div><span class="state ${st}">${esc(serviceStateLabel(s))}</span><span class="meta">${Number.isFinite(s.latencyMs)?s.latencyMs+' ms':'—'}</span></div>`}).join('');
    $('technicalStatus').innerHTML=(j.services||[]).map(s=>{const st=serviceDisplayState(s);const err=s.error?` · ${esc(s.error)}`:'';return `<div class="service"><span>${esc(s.name)} · ${s.required===false?'optional companion':'core'}<small class="service-tech-note">${esc(s.impact||'')}${err}</small></span><span class="state ${st}">${esc(serviceStateLabel(s))}</span><span class="meta">HTTP ${s.statusCode??'—'}</span></div>`}).join('');
    const c=j.certification||{};$('certBox').textContent=c.available?`System certified · ${c.result}${c.modifiedAt?` · ${new Date(c.modifiedAt).toLocaleString()}`:''}`:'Certification unavailable';
  }catch(e){
    for(const id of ['homeDot','sideDot'])$(id).className='dot DOWN';$('homeState').textContent='Unavailable';$('sideState').textContent='Offline';
    $('statusSummary').innerHTML='<span class="dot DOWN"></span> Status check unavailable';
    if($('serviceList'))$('serviceList').innerHTML=`<div class="status-error">Could not refresh status. <button class="btn" type="button" data-status-retry>Retry</button></div>`;
  }finally{
    statusRefreshing=false;if(retry){retry.disabled=false;retry.textContent='Check again';}
    document.querySelectorAll('[data-status-retry]').forEach(b=>b.onclick=()=>refreshStatus(true));
  }
}
// One line of tappable status chips at the foot of Home. Anything needing action (pending changes, open issues,
// unconfigured bridges) is raised by the Attention card instead, so only steady-state facts appear here.
// ui.js appends #truthModelCapabilityTile to this strip; keep it across re-renders.
function renderCapabilityStrip(box,html){const tile=$('truthModelCapabilityTile');box.innerHTML=html;if(tile)box.appendChild(tile);qsa('#homeCapabilities [data-chip-view]').forEach(b=>b.addEventListener('click',()=>window.showView?.(b.dataset.chipView)));}
function capChip(view,value,label,title=''){return `<button type="button" class="cap-tile cap-chip" data-chip-view="${esc(view)}"${title?` title="${esc(title)}"`:''}><b>${esc(value)}</b><span>${esc(label)}</span></button>`;}
async function loadHomeCapabilities(){
  const box=$('homeCapabilities');if(!box)return;
  try{const r=await fetch('/api/capabilities',{cache:'no-store'}),j=await r.json();if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);const imageNames=(j.images?.models||[]).filter(x=>x.supported).map(x=>x.familyLabel||x.family);const unique=[...new Set(imageNames)];const active=Number(j.engineering?.active||0);
    renderCapabilityStrip(box,[active?capChip('changes',active,active===1?'change running':'changes running'):'',capChip('create',unique.length?unique.join(', '):'None','images'),capChip('status',`v${j.version||'—'}`,'Local AI',`Local AI ${j.version||''}`)].join(''));}
  catch(e){renderCapabilityStrip(box,`<div class="empty">Status summary unavailable: ${esc(e.message)}</div>`)}
}
function schedulePolling(){clearInterval(state.statusTimer);clearInterval(state.activityTimer);if(!document.hidden){state.statusTimer=setInterval(refreshStatus,60000);state.activityTimer=setInterval(()=>{loadActivity();loadWorkspace();},60000);}}
document.addEventListener('visibilitychange',()=>{schedulePolling();if(!document.hidden){refreshStatus();loadActivity();loadWorkspace();}});

// Only a positive result is worth showing; without a service worker (plain-HTTP LAN access) the hint stays hidden.
async function detectOfflineReady(){const hint=$('offlineHint');if(!('serviceWorker' in navigator))return;try{await navigator.serviceWorker.register('/sw.js');hint.textContent='Works offline · the app shell is cached on this device';hint.hidden=false;}catch(e){console.debug('Service worker registration failed',e);}}
async function init(){syncModeSelect();syncWebToggle();renderAgentMap();renderMessages();setPhase('idle');loadActivity();loadLibrary();loadWorkspace();refreshStatus();loadHomeCapabilities();schedulePolling();detectOfflineReady();try{const r=await fetch('/api/models',{cache:'no-store'}),j=await r.json();state.model=j.default||j.models?.[0]||null;const name=typeof state.model==='string'?state.model:state.model?.name;if(name){$('chatModelName').textContent=name;$('chatModelChip').title=`Chat model: ${name}`;$('chatModelChip').hidden=false;}}catch{} }
init();


// ===== cumulative release client ============================================
const releaseState={config:null,projects:[],knowledge:[],agents:[],automations:[],selectedProject:'',editorPath:'',editorOriginal:''};
const api=async(url,opt={})=>{const r=await fetch(url,opt);let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);return j};
const post=(url,body)=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
// Same rule as the server: gated by the 1.x minor version; 2.x and later include every 1.x feature.
function featureLevelFor(version){const [major,minor]=String(version||'1.2').split('.');return Number(major)>=2?99:(parseInt(minor,10)||2)}
function featureLevel(){return featureLevelFor(releaseState.config?.version)}
function fillProjectSelects(){for(const id of ['knowledgeProject','agentProject']){const el=$(id);if(!el)continue;const old=el.value;el.innerHTML='<option value="">No project</option>'+releaseState.projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');if([...el.options].some(o=>o.value===old))el.value=old}}
async function loadReleaseConfig(){try{releaseState.config=await api('/api/config');const brand=document.querySelector('.brand-sub');if(brand)brand.textContent=`Private AI on your machine · v${releaseState.config.version}`;document.querySelectorAll('[class*="feature-v"]').forEach(el=>{const m=[...el.classList].map(x=>/^feature-v1(\d+)$/.exec(x)).find(Boolean);if(m&&featureLevel()<Number(m[1]))el.classList.add('feature-hidden')});document.querySelectorAll('[data-min-version]').forEach(el=>{if(featureLevel()<Number(el.dataset.minVersion))el.classList.add('feature-hidden')})}catch(e){console.warn(e)}}
async function loadProjects(){if(featureLevel()<3)return;const j=await api('/api/projects');releaseState.projects=j.items||[];fillProjectSelects();const list=$('projectList');if(list)list.innerHTML=releaseState.projects.length?releaseState.projects.map(p=>`<button class="item-card" data-project="${esc(p.id)}"><strong>${esc(p.name)}</strong><small>${p.counts.conversations} conversations · ${p.counts.knowledge} sources · ${p.counts.artifacts} artifacts</small></button>`).join(''):'<div class="empty">Create your first project.</div>';const m=$('projectMetrics');if(m){const totals=releaseState.projects.reduce((a,p)=>{a.c+=p.counts.conversations;a.k+=p.counts.knowledge;a.a+=p.counts.artifacts;return a},{c:0,k:0,a:0});m.innerHTML=`<div class="metric"><b>${releaseState.projects.length}</b><span>Projects</span></div><div class="metric"><b>${totals.c}</b><span>Conversations</span></div><div class="metric"><b>${totals.k}</b><span>Knowledge sources</span></div><div class="metric"><b>${totals.a}</b><span>Artifacts</span></div>`}qsa('[data-project]').forEach(b=>b.onclick=()=>showProject(b.dataset.project))}
async function showProject(id){releaseState.selectedProject=id;const p=releaseState.projects.find(x=>x.id===id);if(!p)return;const [c,k]=await Promise.all([api('/api/conversations?projectId='+encodeURIComponent(id)),api('/api/knowledge?projectId='+encodeURIComponent(id))]);$('projectDetail').innerHTML=`<div class="section-head"><div><h2>${esc(p.name)}</h2><p>${esc(p.description||'Project workspace')}</p></div><span class="badge">${p.pinned?'Pinned':'Workspace'}</span></div><div class="two"><div><h3>Conversations</h3><div class="stack" style="margin-top:8px">${(c.items||[]).slice(0,8).map(x=>`<div class="item-card"><strong>${esc(x.title)}</strong><small>${ago(x.updatedAt)}</small></div>`).join('')||'<div class="empty">No conversations.</div>'}</div></div><div><h3>Knowledge</h3><div class="stack" style="margin-top:8px">${(k.items||[]).slice(0,8).map(x=>`<div class="item-card"><strong>${esc(x.name)}</strong><small>${Math.round((x.size||0)/1024)} KB</small></div>`).join('')||'<div class="empty">No sources.</div>'}</div></div></div>`}
async function newProject(){const name=prompt('Project name');if(!name)return;await post('/api/projects/create',{name});await loadProjects();toast('Project created')}
async function loadKnowledge(){if(featureLevel()<3)return;const j=await api('/api/knowledge');releaseState.knowledge=j.items||[];const el=$('knowledgeList');if(el)el.innerHTML=releaseState.knowledge.length?releaseState.knowledge.map(x=>`<div class="item-card"><strong>${esc(x.name)}</strong><small>${esc(releaseState.projects.find(p=>p.id===x.projectId)?.name||'Unassigned')} · ${Math.round((x.size||0)/1024)} KB</small></div>`).join(''):'<div class="empty">Nothing indexed yet. Add a source above, and Chat can answer from it.</div>'}
async function importKnowledge(name,content,mime='text/plain'){await post('/api/knowledge/import',{name,content,mimeType:mime,projectId:$('knowledgeProject')?.value||''});await Promise.all([loadKnowledge(),loadProjects()]);toast('Knowledge indexed')}
async function searchKnowledge(){const q=$('knowledgeQuery').value.trim();if(!q)return;const j=await post('/api/knowledge/search',{query:q,projectId:$('knowledgeProject')?.value||''});$('knowledgeResults').innerHTML=(j.hits||[]).map(h=>`<div class="item-card"><strong>${esc(h.name)}</strong><small>score ${h.score}</small><div class="muted" style="margin-top:6px">${esc(h.text.slice(0,500))}</div></div>`).join('')||'<div class="empty">No matches.</div>'}
async function loadAgents(){if(featureLevel()<4)return;const j=await api('/api/agents');releaseState.agents=j.items||[];$('agentRuns').innerHTML=releaseState.agents.length?releaseState.agents.map(r=>`<button class="item-card" data-agent-id="${esc(r.id)}"><strong>${esc(r.goal)}</strong><small>${esc(r.status)} · ${ago(r.updatedAt||r.createdAt)}</small></button>`).join(''):'<div class="empty">No agent runs.</div>';qsa('[data-agent-id]').forEach(b=>b.onclick=()=>renderAgent(releaseState.agents.find(x=>x.id===b.dataset.agentId)))}
function renderAgent(r){if(!r)return;$('agentExecution').innerHTML=(r.plan||[]).map((s,i)=>`<div class="flow-step"><div class="flow-index">${i+1}</div><div><strong>${esc(s.name)}</strong>${s.error?`<small class="muted">${esc(s.error)}</small>`:''}</div><span class="statuschip ${esc(s.state||'pending')}">${esc(s.state||'pending')}</span></div>`).join('')+(r.answer?`<div class="preview-pane"><strong>Result</strong><div style="white-space:pre-wrap;margin-top:8px">${esc(r.answer)}</div></div>`:'')}
async function runAgent(){const goal=$('agentGoal').value.trim();if(!goal)return;const btn=$('agentRunBtn');btn.disabled=true;$('agentExecution').innerHTML='<div class="empty">Agent running…</div>';try{const j=await post('/api/agents/run',{goal,projectId:$('agentProject').value});renderAgent(j.run);await loadAgents();toast('Agent completed')}catch(e){toast(e.message)}finally{btn.disabled=false}}
async function loadAutomations(){if(featureLevel()<4)return;const j=await api('/api/automations');releaseState.automations=j.items||[];$('automationList').innerHTML=releaseState.automations.length?releaseState.automations.map(a=>`<div class="item-card"><div class="statusline"><strong style="flex:1">${esc(a.name)}</strong><span class="statuschip">${esc(a.schedule)}</span></div><small>${esc(a.kind)}${a.nextRunAt?' · next '+ago(a.nextRunAt):''}</small><div class="actions" style="margin-top:8px"><button class="btn" data-auto-run="${esc(a.id)}">Run now</button><button class="btn" data-auto-toggle="${esc(a.id)}">${a.enabled?'Disable':'Enable'}</button></div></div>`).join(''):'<div class="empty">No automations.</div>';$('automationRuns').innerHTML=(j.runs||[]).slice(0,12).map(r=>`<div class="item-card"><strong>${esc(r.name)}</strong><small>${esc(r.status)} · ${ago(r.finishedAt||r.startedAt)}</small>${r.output?`<div class="muted" style="margin-top:6px">${esc(r.output.slice(0,500))}</div>`:''}</div>`).join('')||'<div class="empty">No runs yet.</div>';qsa('[data-auto-run]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await post('/api/automations/run',{id:b.dataset.autoRun});await loadAutomations()}finally{b.disabled=false}});qsa('[data-auto-toggle]').forEach(b=>b.onclick=async()=>{const a=releaseState.automations.find(x=>x.id===b.dataset.autoToggle);await post('/api/automations/update',{id:a.id,enabled:!a.enabled});await loadAutomations()})}
async function createAutomation(){await post('/api/automations/create',{name:$('autoName').value,kind:$('autoKind').value,schedule:$('autoSchedule').value,prompt:$('autoPrompt').value});$('autoName').value='';$('autoPrompt').value='';await loadAutomations();toast('Automation created')}
// Folders are collapsible and only the top level starts open; a fully expanded tree ran to tens of thousands of pixels.
function renderTree(items,depth=0){return (items||[]).map(i=>i.type==='directory'?`<details class="item-card tree-dir"${depth===0?' open':''}><summary><strong>${esc(i.name)}/</strong><small>${esc(i.path)}</small></summary>${i.children?.length?`<div class="tree-children">${renderTree(i.children,depth+1)}</div>`:''}</details>`:`<button class="item-card" data-file-path="${esc(i.path)}"><strong>${esc(i.name)}</strong><small>${esc(i.path)}</small></button>`).join('')}
async function loadWorkbench(){if(featureLevel()<5)return;try{const j=await api('/api/workbench/tree?path='+encodeURIComponent($('workbenchPath').value));$('workbenchTree').innerHTML=renderTree(j.items)||'<div class="empty">Workspace is empty or not mounted.</div>';qsa('[data-file-path]').forEach(b=>b.onclick=()=>openWorkbenchFile(b.dataset.filePath))}catch(e){$('workbenchTree').innerHTML=`<div class="empty">${esc(e.message)}</div>`}}
async function openWorkbenchFile(p){const j=await api('/api/workbench/read?path='+encodeURIComponent(p));releaseState.editorPath=p;releaseState.editorOriginal=j.content;$('editorPath').textContent=p;$('workbenchEditor').value=j.content;$('workbenchEditor').disabled=false;$('workbenchDiffBtn').disabled=false;$('workbenchSaveBtn').disabled=false;$('workbenchDiff').style.display='none'}
async function previewWorkbenchDiff(){const j=await post('/api/workbench/diff',{path:releaseState.editorPath,content:$('workbenchEditor').value});$('workbenchDiff').textContent=j.changed?j.diff:'No changes';$('workbenchDiff').style.display='block'}
async function saveWorkbench(){if(!releaseState.editorPath)return;if(!confirm(`Write ${releaseState.editorPath}? A timestamped backup will be created first.`))return;const j=await post('/api/workbench/write',{path:releaseState.editorPath,content:$('workbenchEditor').value,approved:true});releaseState.editorOriginal=$('workbenchEditor').value;toast(j.backup?`Saved · backup ${j.backup}`:'Saved')}
async function searchWorkbench(){const j=await post('/api/workbench/search',{query:$('workbenchSearch').value,path:$('workbenchPath').value});$('workbenchTree').innerHTML=(j.results||[]).map(x=>`<button class="item-card" data-file-path="${esc(x.path)}"><strong>${esc(x.path)}</strong><small>${esc(x.match)}${x.snippet?' · '+esc(x.snippet):''}</small></button>`).join('')||'<div class="empty">No matches.</div>';qsa('[data-file-path]').forEach(b=>b.onclick=()=>openWorkbenchFile(b.dataset.filePath))}
async function browserFetch(){const url=$('browserUrl').value.trim();if(!url)return;try{const j=await post('/api/browser/fetch',{url});$('browserResult').innerHTML=`<div class="statusline"><strong style="flex:1">${esc(j.title)}</strong><span class="statuschip">HTTP ${j.status}</span></div><div class="muted" style="margin-top:6px">${esc(j.url)}</div><div style="white-space:pre-wrap;margin-top:12px">${esc(j.text)}</div>`}catch(e){$('browserResult').innerHTML=`<div class="empty">${esc(e.message)}</div>`}}
async function httpCheck(){try{const j=await post('/api/actions/http-check',{url:$('browserUrl').value});$('browserResult').innerHTML=`<div class="metric"><b>${j.status}</b><span>HTTP status</span></div><div class="muted" style="margin-top:10px">${esc(j.url)} · ${j.latencyMs} ms · ${esc(j.contentType)}</div>`}catch(e){toast(e.message)}}
async function runComputerBatch(){let ops;try{ops=JSON.parse($('computerBatch').value)}catch{return toast('Batch JSON is invalid')}if(!Array.isArray(ops))return toast('Batch must be a JSON array');if(!confirm(`Run ${ops.length} workspace operation(s)? Writes are restricted to mounted workspace paths.`))return;try{const j=await post('/api/computer/batch',{operations:ops,approved:true});$('computerResult').textContent=JSON.stringify(j.results,null,2);$('computerResult').style.display='block'}catch(e){toast(e.message)}}
function bindReleaseEvents(){
  $('newProjectBtn')?.addEventListener('click',newProject);$('knowledgeImportBtn')?.addEventListener('click',()=>importKnowledge($('knowledgeName').value,$('knowledgeContent').value));$('knowledgeFileBtn')?.addEventListener('click',()=>$('knowledgeFileInput').click());$('knowledgeFileInput')?.addEventListener('change',async e=>{for(const f of [...e.target.files]){if(f.size>5*1024*1024){toast(`${f.name} is too large`);continue}await importKnowledge(f.name,await f.text(),f.type||'text/plain')}e.target.value=''});$('knowledgeSearchBtn')?.addEventListener('click',searchKnowledge);$('agentRunBtn')?.addEventListener('click',runAgent);$('autoCreateBtn')?.addEventListener('click',createAutomation);$('workbenchLoadBtn')?.addEventListener('click',loadWorkbench);$('workbenchDiffBtn')?.addEventListener('click',previewWorkbenchDiff);$('workbenchSaveBtn')?.addEventListener('click',saveWorkbench);$('workbenchSearchBtn')?.addEventListener('click',searchWorkbench);$('browserFetchBtn')?.addEventListener('click',browserFetch);$('httpCheckBtn')?.addEventListener('click',httpCheck);$('computerRunBtn')?.addEventListener('click',runComputerBatch);
}
async function initReleaseFeatures(){await loadReleaseConfig();bindReleaseEvents();if(featureLevel()>=3)await Promise.all([loadProjects(),loadKnowledge()]);if(featureLevel()>=4)await Promise.all([loadAgents(),loadAutomations()]);if(featureLevel()>=5)await loadWorkbench()}
window.addEventListener('DOMContentLoaded',()=>initReleaseFeatures().catch(e=>console.warn('release features',e)));
// ===== end cumulative release client ========================================


// ===== product evolution client (v1.7+) =====================================
const evo={notifications:[],memory:[],approvals:[],monitors:[],changes:[],selectedChange:'',quality:null,issues:[],engineeringRuns:[],selectedEngineeringRun:'',powerShellJobs:[],selectedPowerShellJob:''};
async function evoApi(url,opts){const r=await fetch(url,opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);return j}
async function evoPost(url,body){return evoApi(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
async function loadInbox(){if(featureLevel()<7)return;const j=await evoApi('/api/notifications');evo.notifications=j.items||[];evo.unread=j.unread||0;announceInboxCount();$('inboxUnread').textContent=`${j.unread||0} unread`;const inboxCard=n=>`<div class="item-card"><div class="statusline"><strong style="flex:1">${esc(n.title)}</strong><span class="statuschip">${n.resolved?'resolved':n.read?'read':'new'}</span></div><small>${esc(n.kind)} · ${ago(n.createdAt)}</small><div class="muted" style="margin-top:6px">${esc(n.detail||'')}</div><div class="actions" style="margin-top:8px">${!n.read?`<button class="btn" data-note-read="${esc(n.id)}">Mark read</button>`:''}${!n.resolved?`<button class="btn" data-note-resolve="${esc(n.id)}">Resolve</button>`:''}</div></div>`;
  // What still needs you comes first; resolved notices (updates, recoveries) fold away under Resolved.
  const open=evo.notifications.filter(n=>!n.resolved),done=evo.notifications.filter(n=>n.resolved);
  $('inboxList').innerHTML=(open.length?open.map(inboxCard).join(''):'<div class="empty">Nothing needs you right now.</div>')+(done.length?`<details class="inbox-resolved"><summary>Resolved (${done.length})</summary>${done.slice(0,40).map(inboxCard).join('')}</details>`:'');qsa('[data-note-read]').forEach(b=>b.onclick=async()=>{await evoPost('/api/notifications/update',{id:b.dataset.noteRead,read:true});loadInbox()});qsa('[data-note-resolve]').forEach(b=>b.onclick=async()=>{await evoPost('/api/notifications/update',{id:b.dataset.noteResolve,resolved:true,read:true});loadInbox()})}
async function syncMemoryProjects(){if(featureLevel()<8)return;const p=releaseState.projects?.length?releaseState.projects:(await evoApi('/api/projects')).items||[];const sel=$('memoryProject');if(!sel)return;const keep=sel.value||releaseState.selectedProject;sel.innerHTML=p.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');if([...sel.options].some(o=>o.value===keep))sel.value=keep;}
async function loadMemory(){if(featureLevel()<8)return;await syncMemoryProjects();const pid=$('memoryProject')?.value||'';const j=await evoApi('/api/memory?projectId='+encodeURIComponent(pid));evo.memory=j.items||[];$('memoryList').innerHTML=evo.memory.length?evo.memory.map(m=>`<div class="memory-card"><strong>${esc(m.category)}</strong><div style="margin-top:5px">${esc(m.text)}</div><div class="actions" style="margin-top:8px"><button class="btn" data-mem-pin="${esc(m.id)}">${m.pinned?'Unpin':'Pin'}</button><button class="btn danger" data-mem-del="${esc(m.id)}">Delete</button></div></div>`).join(''):'<div class="empty">No project memory yet. Save a goal, decision or convention above, and Local AI keeps it in mind for this project.</div>';if(pid){try{const intel=await evoApi('/api/projects/intelligence?projectId='+encodeURIComponent(pid));$('projectIntel').innerHTML=`<div class="home-insight"><div class="card"><b>${intel.summary.knowledge}</b><span>knowledge sources</span></div><div class="card"><b>${intel.summary.conversations}</b><span>conversations</span></div><div class="card"><b>${intel.summary.pinnedMemory}</b><span>pinned memories</span></div></div>`}catch{}}qsa('[data-mem-pin]').forEach(b=>b.onclick=async()=>{const m=evo.memory.find(x=>x.id===b.dataset.memPin);await evoPost('/api/memory/update',{id:m.id,pinned:!m.pinned});loadMemory()});qsa('[data-mem-del]').forEach(b=>b.onclick=async()=>{await evoPost('/api/memory/delete',{id:b.dataset.memDel});loadMemory()})}
async function addMemory(){const text=$('memoryText').value.trim();if(!text)return;await evoPost('/api/memory/add',{projectId:$('memoryProject').value,category:$('memoryCategory').value,text});$('memoryText').value='';await loadMemory();toast('Memory saved')}
// The top bar shows one Inbox count: unread alerts plus approvals waiting on you.
function announceInboxCount(){window.dispatchEvent(new CustomEvent('localai:inbox-count',{detail:{unread:evo.unread||0,pending:evo.pendingApprovals||0}}))}
async function loadApprovals(){if(featureLevel()<9)return;const j=await evoApi('/api/approvals');evo.approvals=j.items||[];const pending=evo.approvals.filter(x=>x.status==='pending').length;evo.pendingApprovals=pending;announceInboxCount();$('approvalCount').textContent=`${pending} pending`;$('approvalList').innerHTML=evo.approvals.length?evo.approvals.map(a=>`<div class="approval-card ${esc(a.status)}"><div class="statusline"><strong style="flex:1">${esc(a.title)}</strong><span class="statuschip">${esc(a.risk)} · ${esc(a.status)}</span></div><div class="muted" style="margin-top:6px">${esc(a.detail)}</div>${a.status==='pending'?`<div class="actions" style="margin-top:8px"><button class="btn primary" data-app-ok="${esc(a.id)}">Approve</button><button class="btn danger" data-app-no="${esc(a.id)}">Reject</button></div>`:''}</div>`).join(''):'<div class="empty">No approvals.</div>';qsa('[data-app-ok]').forEach(b=>b.onclick=()=>decideApproval(b.dataset.appOk,'approved'));qsa('[data-app-no]').forEach(b=>b.onclick=()=>decideApproval(b.dataset.appNo,'rejected'))}
async function decideApproval(id,decision){await evoPost('/api/approvals/decide',{id,decision});await Promise.all([loadApprovals(),loadInbox()]);toast(`Approval ${decision}`)}
async function inspectRepo(){try{const j=await evoApi('/api/repo/inspect?path='+encodeURIComponent($('repoPath').value));$('repoInfo').innerHTML=j.isRepo?`<div class="metric"><b>${esc(j.branch)}</b><span>branch</span></div><div class="muted" style="margin-top:8px">${esc(j.path)} · ${esc(j.commit||'unknown commit')}</div>`:'<div class="empty">No .git repository found from that path.</div>'}catch(e){toast(e.message)}}
async function runWorkbenchCommand(){const cmd=$('commandName').value,args=$('commandArgs').value.trim().split(/\s+/).filter(Boolean),cwd=$('commandCwd').value;if(!confirm(`Run allow-listed command "${cmd} ${args.join(' ')}" in ${cwd}?`))return;$('commandOutput').textContent='Running…';try{const j=await evoPost('/api/workbench/command',{command:cmd,args,cwd,approved:true});$('commandOutput').textContent=`exit ${j.code}\n\n${j.stdout||''}${j.stderr?'\nSTDERR:\n'+j.stderr:''}`}catch(e){$('commandOutput').textContent=e.message}}
async function loadMonitors(){if(featureLevel()<11)return;const j=await evoApi('/api/monitors');evo.monitors=j.items||[];$('monitorList').innerHTML=evo.monitors.length?evo.monitors.map(m=>`<div class="monitor-card"><div class="statusline"><strong style="flex:1">${esc(m.name)}</strong><span class="statuschip">${esc(m.lastState||'unknown')}</span></div><small>${m.lastRunAt?'last '+ago(m.lastRunAt):'never run'}</small><div class="actions" style="margin-top:8px"><button class="btn" data-monitor-run="${esc(m.id)}">Run now</button></div></div>`).join(''):'<div class="empty">No monitors configured.</div>';qsa('[data-monitor-run]').forEach(b=>b.onclick=async()=>{await evoPost('/api/monitors/run',{id:b.dataset.monitorRun});await Promise.all([loadMonitors(),loadInbox()])})}
async function createMonitor(){const name=$('monitorName').value.trim()||'Local AI health';await evoPost('/api/monitors/create',{name,kind:'health'});$('monitorName').value='';loadMonitors()}
async function generateBrief(){const j=await evoApi('/api/brief');$('briefBox').innerHTML=`<div class="metric"><b>${esc(j.health)}</b><span>system health</span></div><h3 style="margin-top:14px">Needs attention</h3>${j.notifications.length?j.notifications.map(n=>`<div class="item-card"><strong>${esc(n.title)}</strong><small>${esc(n.detail||'')}</small></div>`).join(''):'<div class="muted">Nothing unresolved.</div>'}<h3 style="margin-top:14px">Recent activity</h3>${j.activity.slice(0,5).map(a=>`<div class="item-card"><strong>${esc(a.title)}</strong><small>${ago(a.at)}</small></div>`).join('')}`}
async function loadChanges(selectId=''){
  if(featureLevel()<13)return;const j=await evoApi('/api/changes');evo.changes=j.items||[];$('changePending').textContent=`${j.pending||0} pending`;
  $('changeList').innerHTML=evo.changes.length?evo.changes.map(c=>`<button class="item-card" data-change-id="${esc(c.id)}"><div class="statusline"><strong style="flex:1">${esc(c.summary||c.request)}</strong><span class="statuschip">${esc(c.status)}</span></div><small>${esc(c.target)} · ${ago(c.updatedAt||c.createdAt)} · ${(c.files||[]).length} file(s)</small></button>`).join(''):'<div class="empty">No change requests yet.</div>';
  qsa('[data-change-id]').forEach(b=>b.onclick=()=>selectChange(b.dataset.changeId));
  const id=selectId||evo.selectedChange;if(id&&evo.changes.some(x=>x.id===id))selectChange(id);else if(evo.changes.length&&!evo.selectedChange)selectChange(evo.changes[0].id);
}
function changeValidationHtml(c){const checks=c.validation?.checks||[];if(!checks.length)return '<div class="muted">Not validated yet.</div>';return checks.map(x=>`<div class="service"><span>${esc(x.name)}</span><span class="state ${x.result==='PASS'?'HEALTHY':x.result==='WARN'?'DEGRADED':'DOWN'}">${esc(x.result)}</span><span class="meta">${esc(x.detail||'')}</span></div>`).join('')}
function changeDiffHtml(c){const diffs=c.diffs||[];if(!diffs.length)return '<div class="muted">No staged diff yet.</div>';return diffs.map(d=>`<details style="margin-top:8px"><summary><strong>${esc(d.path)}</strong></summary><pre class="codebox" style="white-space:pre-wrap;margin-top:8px">${esc(d.diff||'')}</pre></details>`).join('')}
function selectChange(id){evo.selectedChange=id;const c=evo.changes.find(x=>x.id===id);if(!c)return;const actions=[];if(['planned','validation_failed'].includes(c.status))actions.push(`<button class="btn primary" data-change-stage="${esc(c.id)}">Stage & validate</button>`);if(c.status==='awaiting_approval'){actions.push(`<button class="btn primary" data-change-approve="${esc(c.id)}">Approve</button><button class="btn danger" data-change-reject="${esc(c.id)}">Reject</button>`)}if(c.status==='approved')actions.push(`<button class="btn primary" data-change-apply="${esc(c.id)}">${c.target==='self'?'Queue self-update':'Apply to workspace'}</button>`);$('changeDetail').innerHTML=`<div class="statusline"><strong style="flex:1">${esc(c.summary||c.request)}</strong><span class="statuschip">${esc(c.status)}</span></div><div class="muted" style="margin-top:7px">${esc(c.request)}</div>${c.notes?`<div class="meta" style="margin-top:7px">${esc(c.notes)}</div>`:''}<div class="actions" style="margin-top:10px">${actions.join('')}</div><h3 style="margin-top:16px">Files</h3>${(c.files||[]).map(f=>`<div class="item-card"><strong>${esc(f.path)}</strong><small>${(f.operations||[]).length} operation(s)</small></div>`).join('')||'<div class="muted">No patch operations were produced. Refine the request or workspace context.</div>'}<h3 style="margin-top:16px">Validation</h3>${changeValidationHtml(c)}<h3 style="margin-top:16px">Diff</h3>${changeDiffHtml(c)}${c.target==='self'&&c.status==='apply_requested'?'<div class="item-card" style="margin-top:12px"><strong>Host deployment requested</strong><small>The Windows self-update helper will apply this staged build, restart Local AI, verify health, and roll back automatically if needed.</small></div>':''}`;
  qsa('[data-change-stage]').forEach(b=>b.onclick=()=>stageChange(b.dataset.changeStage));qsa('[data-change-approve]').forEach(b=>b.onclick=()=>approveChange(b.dataset.changeApprove,'approved'));qsa('[data-change-reject]').forEach(b=>b.onclick=()=>approveChange(b.dataset.changeReject,'rejected'));qsa('[data-change-apply]').forEach(b=>b.onclick=()=>applyChange(b.dataset.changeApply));
}
async function planChange(){const request=$('engineeringRequest').value.trim();if(!request)return;const target=$('engineeringTarget').value,root=$('engineeringRoot').value.trim();const btn=$('engineeringRunBtn');btn.disabled=true;$('engineeringStatus').textContent='Analyzing source and generating a constrained patch plan…';try{const j=await evoPost('/api/changes/plan',{request,target,root});$('engineeringStatus').textContent=j.item.files?.length?`Plan created: ${j.item.files.length} file(s).`:`Plan needs more context: ${j.item.notes||'No patch operations produced.'}`;await loadChanges(j.item.id);toast('Change plan created')}catch(e){$('engineeringStatus').textContent=`Error: ${e.message}`;toast(e.message)}finally{btn.disabled=false}}
async function stageChange(id){$('engineeringStatus').textContent='Staging and validating change…';try{const j=await evoPost('/api/changes/stage',{id});$('engineeringStatus').textContent=j.item.validation?.passed?'Staging validation passed. Approval required.':'Validation failed; inspect the checks and revise.';await Promise.all([loadChanges(id),loadApprovals(),loadInbox()])}catch(e){$('engineeringStatus').textContent=`Error: ${e.message}`;toast(e.message)}}
async function approveChange(id,decision){try{await evoPost('/api/changes/approve',{id,decision});await Promise.all([loadChanges(id),loadApprovals(),loadInbox()]);toast(`Change ${decision}`)}catch(e){toast(e.message)}}
async function applyChange(id){const c=evo.changes.find(x=>x.id===id);if(!c)return;if(!confirm(c.target==='self'?'Queue this validated self-update? The host helper will back up, restart, verify, and roll back on failure.':'Apply this validated patch to the mounted workspace with backups?'))return;try{const j=await evoPost('/api/changes/request-apply',{id});await Promise.all([loadChanges(id),loadInbox()]);toast(j.hostUpdaterRequired?'Self-update queued':'Workspace patch applied')}catch(e){toast(e.message)}}


async function loadQuality(){if(featureLevel()<14)return;const j=await evoApi('/api/quality');evo.quality=j;const s=j.latest?.summary||{pass:0,warn:0,fail:0,events24h:0,high24h:0};$('qualityMetrics').innerHTML=`<div class="metric"><b>${s.pass}</b><span>checks passed</span></div><div class="metric"><b>${s.warn||0}</b><span>warnings</span></div><div class="metric"><b>${s.fail}</b><span>checks failed</span></div><div class="metric"><b>${s.high24h}</b><span>high severity</span></div>`;$('qualityChecks').innerHTML=j.latest?.checks?.length?j.latest.checks.map(x=>`<div class="service"><span>${esc(x.name)}</span><span class="state ${x.result==='PASS'?'HEALTHY':x.result==='WARN'?'DEGRADED':'DOWN'}">${esc(x.result)}</span><span class="meta">${esc(x.detail||'')}</span></div>`).join(''):'<div class="empty">Run a quality scan to establish the current baseline.</div>';$('qualityEvents').innerHTML=j.events?.length?j.events.slice(0,30).map(x=>`<div class="item-card"><div class="statusline"><strong style="flex:1">${esc(x.message)}</strong><span class="statuschip">${esc(x.severity)}</span></div><small>${esc(x.type)} · ${ago(x.createdAt)}</small>${x.source?`<div class="meta" style="margin-top:5px">${esc(x.source)}${x.line?`:${x.line}`:''}</div>`:''}</div>`).join(''):'<div class="empty">No browser/runtime events captured.</div>'}
async function runQualityScanClient(){const b=$('qualityScanBtn');if(b)b.disabled=true;try{await evoPost('/api/quality/scan',{});await loadQuality();toast('Quality scan complete')}catch(e){toast(e.message)}finally{if(b)b.disabled=false}}
let qualityLastSent='';async function reportQualityEvent(payload){if(featureLevel()<14)return;const key=`${payload.type}|${payload.message}|${payload.source}|${payload.line}`;if(key===qualityLastSent)return;qualityLastSent=key;try{await fetch('/api/quality/client-event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),keepalive:true})}catch{}}
window.addEventListener('error',e=>reportQualityEvent({type:'error',message:e.message||'Browser error',source:e.filename||location.pathname,line:e.lineno,column:e.colno,stack:e.error?.stack||'',url:location.href}));
window.addEventListener('unhandledrejection',e=>reportQualityEvent({type:'rejection',message:String(e.reason?.message||e.reason||'Unhandled promise rejection'),source:location.pathname,stack:e.reason?.stack||'',url:location.href}));


async function loadIssues(){if(featureLevel()<15)return;const j=await evoApi('/api/issues');evo.issues=j.items||[];$('issueOpen').textContent=`${j.open||0} open`;$('issueList').innerHTML=evo.issues.length?evo.issues.map(x=>`<div class="item-card"><div class="statusline"><strong style="flex:1">${esc(x.name)}</strong><span class="statuschip">${esc(x.severity)} · ${esc(x.status)}</span></div><small>${esc(x.kind)} · seen ${ago(x.lastSeenAt||x.updatedAt)} · ${x.occurrences||1} occurrence(s)</small><div class="muted" style="margin-top:6px;white-space:pre-wrap">${esc(x.detail||'')}</div><div class="actions" style="margin-top:8px">${x.status==='open'?`<button class="btn primary" data-issue-fix="${esc(x.id)}">Prepare fix</button><button class="btn" data-issue-resolve="${esc(x.id)}">Resolve</button><button class="btn danger" data-issue-ignore="${esc(x.id)}">Ignore</button>`:''}${x.changeId?`<button class="btn" data-issue-change="${esc(x.changeId)}">Open change</button>`:''}</div></div>`).join(''):'<div class="empty">No issues detected.</div>';qsa('[data-issue-fix]').forEach(b=>b.onclick=()=>prepareIssueFix(b.dataset.issueFix));qsa('[data-issue-resolve]').forEach(b=>b.onclick=()=>updateIssue(b.dataset.issueResolve,'resolved'));qsa('[data-issue-ignore]').forEach(b=>b.onclick=()=>updateIssue(b.dataset.issueIgnore,'ignored'));qsa('[data-issue-change]').forEach(b=>b.onclick=async()=>{showView('changes');await loadChanges(b.dataset.issueChange)})}
async function scanIssues(){const b=$('issueScanBtn');if(b)b.disabled=true;try{await evoPost('/api/issues/scan',{});await Promise.all([loadIssues(),loadQuality(),loadInbox()]);toast('Issue scan complete')}catch(e){toast(e.message)}finally{if(b)b.disabled=false}}
async function updateIssue(id,status){await evoPost('/api/issues/update',{id,status});await loadIssues();toast(`Issue ${status}`)}
async function prepareIssueFix(id){try{const j=await evoPost('/api/issues/prepare-change',{id});await Promise.all([loadIssues(),loadChanges(j.item.id)]);showView('changes');toast(j.item.files?.length?'Fix plan prepared':'Fix needs more context')}catch(e){toast(e.message)}}


function renderEngineeringRun(run){if(!run){$('engineeringExecution').innerHTML='<div class="empty">No run selected.</div>';return}$('engineeringState').textContent=String(run.status||'').replace(/_/g,' ');$('engineeringExecution').innerHTML=(run.steps||[]).map(x=>`<div class="item-card"><div class="statusline"><strong style="flex:1">${esc(x.name)}</strong><span class="statuschip">${esc(x.state)}</span></div>${x.detail?`<div class="meta" style="margin-top:6px;white-space:pre-wrap">${esc(x.detail)}</div>`:''}</div>`).join('')||'<div class="empty">No steps recorded.</div>';if(run.finalChangeId)$('engineeringExecution').innerHTML+=`<div class="actions" style="margin-top:10px"><button class="btn primary" data-eng-change="${esc(run.finalChangeId)}">Review validated change</button></div>`;qsa('[data-eng-change]').forEach(b=>b.onclick=async()=>{showView('changes');await loadChanges(b.dataset.engChange)})}
async function loadEngineeringRuns(selectId=''){if(featureLevel()<16)return;const j=await evoApi('/api/engineering/runs');evo.engineeringRuns=j.items||[];$('engineeringRuns').innerHTML=evo.engineeringRuns.length?evo.engineeringRuns.map(r=>`<button class="item-card" data-eng-run="${esc(r.id)}"><div class="statusline"><strong style="flex:1">${esc(r.request)}</strong><span class="statuschip">${esc(r.status)}</span></div><small>${esc(r.target)} · attempt ${r.attempt||0}/${r.maxAttempts||0} · ${ago(r.updatedAt||r.createdAt)}</small></button>`).join(''):'<div class="empty">No engineering runs yet.</div>';qsa('[data-eng-run]').forEach(b=>b.onclick=()=>{evo.selectedEngineeringRun=b.dataset.engRun;renderEngineeringRun(evo.engineeringRuns.find(x=>x.id===b.dataset.engRun))});const id=selectId||evo.selectedEngineeringRun;if(id)renderEngineeringRun(evo.engineeringRuns.find(x=>x.id===id));else if(evo.engineeringRuns[0])renderEngineeringRun(evo.engineeringRuns[0])}
async function runEngineeringAgent(){const request=$('engineeringRequest').value.trim();if(!request)return;if(Number($('engineeringAttempts').value)===0)return planChange();const btn=$('engineeringRunBtn');btn.disabled=true;$('engineeringState').textContent='running';$('engineeringStatus').textContent='Planning, staging, validating, and repairing within the configured bound…';try{const j=await evoPost('/api/engineering/run',{request,target:$('engineeringTarget').value,root:$('engineeringRoot').value.trim(),maxAttempts:Number($('engineeringAttempts').value)});$('engineeringStatus').textContent=j.run.status==='awaiting_approval'?`Validated after ${j.run.attempt} attempt(s). Human approval required.`:j.run.error||j.run.status;await Promise.all([loadEngineeringRuns(j.run.id),loadChanges(j.run.finalChangeId||''),loadApprovals(),loadInbox()]);toast(j.run.status==='awaiting_approval'?'Engineering patch ready for approval':'Engineering run needs attention')}catch(e){$('engineeringStatus').textContent=`Error: ${e.message}`;toast(e.message)}finally{btn.disabled=false}}


function powerShellUiToken(){return sessionStorage.getItem('localAiPowerShellUiToken')||''}
function powerShellLocalPort(){return releaseState.config?.localUiPort||location.port||3080}
async function powerShellApi(url,opt={}){const token=powerShellUiToken();if(!token)throw new Error('PowerShell Workbench is locked');const headers={...(opt.headers||{}),'X-LocalAI-PowerShell-Token':token};const r=await fetch(url,{...opt,headers});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);return j}
async function powerShellPost(url,body){return powerShellApi(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
async function unlockPowerShell(){const token=$('powershellToken').value.trim();if(!token)return;sessionStorage.setItem('localAiPowerShellUiToken',token);$('powershellToken').value='';await loadPowerShellJobs();}
async function loadPowerShellJobs(selectId=''){
  if(featureLevel()<17)return;
  try{
    if(!powerShellUiToken()){$('powershellBridge').textContent='locked';$('powershellStatus').textContent='Enter the local PowerShell UI token to unlock this console.';return}const j=await powerShellApi('/api/powershell/jobs');evo.powerShellJobs=j.items||[];
    $('powershellBridge').textContent=j.bridgeConfigured?'host bridge ready':'host bridge not configured';
    $('powershellJobs').innerHTML=evo.powerShellJobs.length?evo.powerShellJobs.map(x=>`<button class="item-card" data-ps-job="${esc(x.id)}"><div class="statusline"><strong style="flex:1">${esc((x.script||'').split(/\r?\n/)[0]||'PowerShell script')}</strong><span class="statuschip">${esc(x.status)}</span></div><small>${esc(x.cwd)} · ${esc(x.risk)} risk · ${ago(x.updatedAt||x.createdAt)}</small></button>`).join(''):'<div class="empty">No PowerShell jobs yet.</div>';
    qsa('[data-ps-job]').forEach(b=>b.onclick=()=>renderPowerShellJob(evo.powerShellJobs.find(x=>x.id===b.dataset.psJob)));
    const id=selectId||evo.selectedPowerShellJob;if(id){evo.selectedPowerShellJob=id;renderPowerShellJob(evo.powerShellJobs.find(x=>x.id===id))}
  }catch(e){$('powershellBridge').textContent=`localhost:${powerShellLocalPort()} only`;$('powershellStatus').textContent=`PowerShell Workbench unavailable: ${e.message}`}
}
function renderPowerShellJob(job){
  if(!job){$('powershellDetail').innerHTML='<div class="empty">Select a job.</div>';return}evo.selectedPowerShellJob=job.id;
  const actions=[];
  if(job.status==='pending_approval'){actions.push(`<button class="btn primary" data-ps-approve="${esc(job.id)}">Approve</button><button class="btn danger" data-ps-reject="${esc(job.id)}">Reject</button>`)}
  if(job.status==='approved'){actions.push(`<button class="btn primary" data-ps-run="${esc(job.id)}">Queue run</button><button class="btn danger" data-ps-cancel="${esc(job.id)}">Cancel</button>`)}
  if(job.status==='run_requested'){actions.push(`<button class="btn danger" data-ps-cancel="${esc(job.id)}">Cancel queued job</button>`)}
  $('powershellDetail').innerHTML=`<div class="statusline"><strong style="flex:1">${esc(job.id)}</strong><span class="statuschip">${esc(job.status)}</span></div><div class="meta" style="margin-top:6px">${esc(job.cwd)} · timeout ${job.timeoutSec}s · ${esc(job.risk)} risk${job.exitCode!==null&&job.exitCode!==undefined?` · exit ${job.exitCode}`:''}</div><h3 style="margin-top:14px">Script</h3><pre class="codebox">${esc(job.script||'')}</pre>${job.stdout?`<h3 style="margin-top:14px">stdout</h3><pre class="command-output">${esc(job.stdout)}</pre>`:''}${job.stderr?`<h3 style="margin-top:14px">stderr</h3><pre class="command-output">${esc(job.stderr)}</pre>`:''}<div class="actions" style="margin-top:10px">${actions.join('')}</div>`;
  qsa('[data-ps-approve]').forEach(b=>b.onclick=()=>approvePowerShellJob(b.dataset.psApprove,'approved'));
  qsa('[data-ps-reject]').forEach(b=>b.onclick=()=>approvePowerShellJob(b.dataset.psReject,'rejected'));
  qsa('[data-ps-run]').forEach(b=>b.onclick=()=>queuePowerShellJob(b.dataset.psRun));
  qsa('[data-ps-cancel]').forEach(b=>b.onclick=()=>cancelPowerShellJob(b.dataset.psCancel));
}
async function createPowerShellJob(){const script=$('powershellScript').value;if(!script.trim())return;const btn=$('powershellCreateBtn');btn.disabled=true;try{const j=await powerShellPost('/api/powershell/create',{script,cwd:$('powershellCwd').value,timeoutSec:Number($('powershellTimeout').value)});$('powershellStatus').textContent=`Prepared ${j.item.risk}-risk job ${j.item.id}. Review it before approval.`;await loadPowerShellJobs(j.item.id);toast('PowerShell job prepared')}catch(e){$('powershellStatus').textContent=`Error: ${e.message}`;toast(e.message)}finally{btn.disabled=false}}
async function approvePowerShellJob(id,decision){try{await powerShellPost('/api/powershell/approve',{id,decision});await loadPowerShellJobs(id);toast(`PowerShell job ${decision}`)}catch(e){toast(e.message)}}
// The Windows host runs a job only if this HMAC (keyed by approval-key.txt, which never reaches the appliance) matches the job it receives.
async function signPowerShellJob(job){if(!window.crypto?.subtle)throw new Error(`Signing needs a secure context; open the Workbench at http://localhost:${powerShellLocalPort()}`);let key=sessionStorage.getItem('localAiPowerShellApprovalKey')||'';if(!key){key=(prompt('Approval key (C:\\LocalAI\\powershell-bridge\\approval-key.txt):')||'').trim();if(!key)throw new Error('Approval key is required to queue a job');sessionStorage.setItem('localAiPowerShellApprovalKey',key)}const enc=new TextEncoder();const k=await crypto.subtle.importKey('raw',enc.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);const msg=`localai-ps-v1\n${job.id}\n${job.cwd}\n${job.timeoutSec}\n${job.script}`;const sig=await crypto.subtle.sign('HMAC',k,enc.encode(msg));return [...new Uint8Array(sig)].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function queuePowerShellJob(id){const confirmation=prompt('Type RUN to queue this approved PowerShell script on the Windows host.');if(confirmation!=='RUN')return;try{const job=(evo.powerShellJobs||[]).find(x=>x.id===id);if(!job)throw new Error('PowerShell job not found; refresh and try again');const signature=await signPowerShellJob(job);await powerShellPost('/api/powershell/request-run',{id,confirmation,signature});await loadPowerShellJobs(id);$('powershellStatus').textContent='Queued. The local Windows host bridge normally claims the job within one minute.';toast('PowerShell job queued')}catch(e){toast(e.message)}}
async function cancelPowerShellJob(id){try{await powerShellPost('/api/powershell/cancel',{id});await loadPowerShellJobs(id);toast('PowerShell job cancelled')}catch(e){toast(e.message)}}

function commandPalette(){
  const el=$('cmdk');if(!el)return;
  // Labels and old names (aka) come from view-registry.js so renamed pages stay findable.
  const actions=window.LocalAIViews.VIEWS.map(v=>[v.label,v.id,[v.label,...(v.aka||[])].join(' ').toLowerCase()]);
  const render=()=>{const q=$('cmdkInput').value.toLowerCase();$('cmdkList').innerHTML=actions.filter(([label,id,terms])=>$(id)&&terms.includes(q)).map(([label,id])=>`<button class="cmdk-item" data-cmd-view="${id}">${label}</button>`).join('');qsa('[data-cmd-view]').forEach(b=>b.onclick=()=>{el.classList.remove('show');showView(b.dataset.cmdView)})};
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();el.classList.add('show');$('cmdkInput').value='';render();$('cmdkInput').focus()}if(e.key==='Escape')el.classList.remove('show')});$('cmdkInput').addEventListener('input',render);el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('show')});render();
}
async function bindEvo(){
  if(!releaseState.config) await loadReleaseConfig();
  commandPalette();
  $('memoryAddBtn')?.addEventListener('click',addMemory);$('memoryProject')?.addEventListener('change',loadMemory);
  $('repoInspectBtn')?.addEventListener('click',inspectRepo);$('commandRunBtn')?.addEventListener('click',runWorkbenchCommand);
  $('monitorCreateBtn')?.addEventListener('click',createMonitor);$('briefBtn')?.addEventListener('click',generateBrief);
  $('changeRefreshBtn')?.addEventListener('click',()=>loadChanges());$('qualityScanBtn')?.addEventListener('click',runQualityScanClient);$('issueScanBtn')?.addEventListener('click',scanIssues);$('engineeringTarget')?.addEventListener('change',()=>{$('engineeringRoot').disabled=$('engineeringTarget').value==='self'});$('engineeringRunBtn')?.addEventListener('click',runEngineeringAgent);$('powershellUnlockForm')?.addEventListener('submit',e=>{e.preventDefault();unlockPowerShell();});$('powershellCreateBtn')?.addEventListener('click',createPowerShellJob);$('powershellRefreshBtn')?.addEventListener('click',()=>loadPowerShellJobs());
  window.showView=showView;
  if(featureLevel()>=7){loadInbox().catch(()=>{});setInterval(()=>{if(!document.hidden)loadInbox().catch(()=>{})},60000)}if(featureLevel()>=9)loadApprovals().catch(()=>{});if(featureLevel()>=13)loadChanges().catch(()=>{});if(featureLevel()>=14)loadQuality().catch(()=>{});if(featureLevel()>=15)loadIssues().catch(()=>{});if(featureLevel()>=16)loadEngineeringRuns().catch(()=>{});if(featureLevel()>=17)loadPowerShellJobs().catch(()=>{});
}
window.addEventListener('DOMContentLoaded',()=>bindEvo().catch(e=>console.warn('evolution features',e)));
// ===== end product evolution client ==========================================

$('statusRetryBtn')?.addEventListener('click',()=>refreshStatus(true));
