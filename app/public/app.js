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
function ago(iso){const d=Date.now()-new Date(iso).getTime();if(!Number.isFinite(d))return '';const s=Math.max(0,Math.floor(d/1000));if(s<60)return 'now';if(s<3600)return `${Math.floor(s/60)}m`;if(s<86400)return `${Math.floor(s/3600)}h`;return `${Math.floor(s/86400)}d`;}
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._hide);t._hide=setTimeout(()=>t.classList.remove('show'),2200);}
function setPhase(phase,detail=''){
  state.chatPhase=phase;
  if($('chatState')) $('chatState').textContent=detail||phaseLabels[phase]||phase;
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
  
  // Only show full agent map when in active execution phase
  if (phase === 'idle') {
    $('agentMap').innerHTML = '<div class="agent-node inactive"><span class="agent-pulse"></span><div class="kicker">Idle</div><strong>Waiting for command</strong></div>';
    return;
  }
  
  $('agentMap').innerHTML = steps.map((s, i) => {
    const cls = phase === 'error' && i === active ? 'error' : i < active ? 'done' : i === active ? 'active' : '';
    return `<div class="agent-node ${cls}"><span class="agent-pulse"></span><div class="kicker">${esc(s[0])}</div><strong>${esc(s[1])}</strong><span>${esc(s[2])}</span></div>`;
  }).join('');
}
function activityHtml(item){return `<div class="activity-item"><div class="activity-icon">${icons[item.type]||'·'}</div><div><div class="activity-title">${esc(item.title)}</div><div class="activity-detail">${esc(item.detail||'')}</div></div><div class="activity-time">${ago(item.at)}</div></div>`;}
function artifactRow(item){return `<div class="activity-item"><div class="activity-icon">${icons[item.kind]||'□'}</div><div><div class="activity-title">${esc(item.title)}</div><div class="activity-detail">${esc(item.summary||'')}</div></div><div class="activity-time">${ago(item.createdAt)}</div></div>`;}

function showView(id){
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

}
qsa('[data-view]').forEach(el=>el.addEventListener('click',()=>showView(el.dataset.view)));
qsa('[data-quick]').forEach(el=>el.addEventListener('click',()=>{const k=el.dataset.quick;if(k==='ask'||k==='research'){openAsk(k==='research')}else if(k==='create')openCreate();else if(k==='engineering'){showView('engineering');if($('engineeringRequest')&&!$('engineeringRequest').value.trim())$('engineeringRequest').value='Improve Local AI based on the current user experience. Preserve existing behavior, validate all changes, and stop for approval.';setTimeout(()=>$('engineeringRequest')?.focus(),20)}else showView('automations');}));

function renderMessages(follow=true){
  const box=$('messages');
  if(!state.messages.length){box.innerHTML='<div class="empty">Start a private conversation. Clear self-modification requests can route directly to the Engineering Agent.</div>';return;}
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
$('newChatBtn').addEventListener('click',newChat);
function openAsk(web=false){$('webSearch').checked=web;showView('ask');setTimeout(()=>$('chatInput').focus(),20);}
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








/* === Agent World Chromatic v6 START === */
const AgentWorldGame = (() => {
  const TILE = 36;
  const COLS = 24;
  const ROWS = 14;
  const WORLD_W = COLS * TILE;
  const WORLD_H = ROWS * TILE;

  const ZONES = {
    planning:   { x:3,  y:3,  label:'Planning Lab',    icon:'P', c1:'#59A7FF', c2:'#245BA0', glow:'rgba(89,167,255,.45)' },
    validation: { x:9,  y:2,  label:'Validation Lab',  icon:'V', c1:'#41E6FF', c2:'#147A8A', glow:'rgba(65,230,255,.42)' },
    approval:   { x:15, y:3,  label:'Approval HQ',     icon:'A', c1:'#B07CFF', c2:'#6841A4', glow:'rgba(176,124,255,.42)' },
    deployment: { x:20, y:2,  label:'Deployment Bay',  icon:'D', c1:'#FFB347', c2:'#A76416', glow:'rgba(255,179,71,.42)' },
    operations: { x:20, y:10, label:'Operations',      icon:'O', c1:'#57E389', c2:'#24804B', glow:'rgba(87,227,137,.42)' },
    attention:  { x:9,  y:11, label:'Repair Bay',      icon:'!', c1:'#FF5D73', c2:'#9D2C3E', glow:'rgba(255,93,115,.42)' }
  };

  const ROLE_COLORS = {
    engineer:'#59A7FF',
    validator:'#41E6FF',
    reviewer:'#B07CFF',
    deployer:'#FFB347',
    operator:'#57E389'
  };

  const DEMO = [
    {status:'running',zone:'planning',title:'Mission accepted',detail:'Engineer analyzes the request and creates a bounded implementation plan.',event:'Engineer entered Planning Lab'},
    {status:'running',zone:'validation',title:'Validation sequence',detail:'Syntax, contract, DOM, smoke, and runtime checks are running.',event:'Validator opened the quality gates'},
    {status:'awaiting_approval',zone:'approval',title:'Human approval required',detail:'Validated Change is waiting for human review. Deployment remains locked.',event:'Change reached Approval HQ'},
    {status:'approved',zone:'deployment',title:'Deployment cleared',detail:'Reviewer approved the Change and released it into the deployment queue.',event:'Reviewer cleared the deployment gate'},
    {status:'apply_requested',zone:'deployment',title:'Release in progress',detail:'Deployer is applying the approved Change and verifying runtime health.',event:'Deployer launched the release sequence'},
    {status:'applied',zone:'operations',title:'Mission complete',detail:'Deployment completed successfully and Operations confirmed a healthy appliance.',event:'Operator confirmed healthy runtime'}
  ];

  const AGENTS = [
    {id:'engineer',name:'Engineer',glyph:'E',role:'Engineering'},
    {id:'validator',name:'Validator',glyph:'V',role:'Quality'},
    {id:'reviewer',name:'Reviewer',glyph:'R',role:'Human Gate'},
    {id:'deployer',name:'Deployer',glyph:'D',role:'Deployment'},
    {id:'operator',name:'Operator',glyph:'O',role:'Operations'}
  ];

  let root=null, canvas=null, ctx=null, raf=null, lastTs=0;
  let mode='live', paused=false, speed=1, demoIndex=0, demoWaitUntil=0, focus=false;
  let lastLiveRun=null, selectedZone=null, pulse=0;
  const map=Array.from({length:ROWS},()=>Array(COLS).fill(0));
  const agents=new Map();
  let particles=[], trails=[], sparks=[];
  const events=[];

  function css(){return `
    .awg6{
      --text:#F5F8FF;--muted:#8F9DB4;--line:rgba(255,255,255,.10);--card:#101827;--card2:#141F31;
      margin-top:16px;border:1px solid var(--line);border-radius:26px;overflow:hidden;color:var(--text);
      background:
        radial-gradient(circle at 10% -6%,rgba(89,167,255,.20),transparent 28%),
        radial-gradient(circle at 86% -8%,rgba(176,124,255,.17),transparent 25%),
        radial-gradient(circle at 58% 110%,rgba(87,227,137,.08),transparent 30%),
        linear-gradient(180deg,#111827,#090F18 72%);
      box-shadow:0 30px 90px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.035)
    }
    .awg6__bar{
      position:relative;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:15px 17px;
      border-bottom:1px solid var(--line);background:
      linear-gradient(90deg,rgba(89,167,255,.075),rgba(176,124,255,.055) 48%,rgba(255,179,71,.045));
      backdrop-filter:blur(16px)
    }
    .awg6__bar:after{
      content:'';position:absolute;left:0;right:0;bottom:-1px;height:1px;
      background:linear-gradient(90deg,transparent,#59A7FF 18%,#41E6FF 35%,#B07CFF 52%,#FFB347 70%,#57E389 86%,transparent);
      opacity:.48
    }
    .awg6__brand{display:flex;align-items:center;gap:12px;min-width:0}
    .awg6__mark{
      width:44px;height:44px;border-radius:15px;display:grid;place-items:center;font-weight:950;color:#06101E;
      background:linear-gradient(145deg,#E5F0FF,#69B6FF 40%,#9D82FF 100%);
      box-shadow:0 10px 30px rgba(89,167,255,.28),inset 0 1px 0 rgba(255,255,255,.65)
    }
    .awg6__title{font-size:16px;font-weight:920;letter-spacing:-.02em}
    .awg6__sub{font-size:10px;color:var(--muted);margin-top:2px}
    .awg6__controls{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end}
    .awg6__badge,.awg6__btn{
      min-height:37px;border:1px solid rgba(255,255,255,.10);border-radius:11px;
      background:linear-gradient(180deg,#18253A,#111B2A);color:var(--text);padding:0 11px;font-size:10px;font-weight:850
    }
    .awg6__badge{display:inline-flex;align-items:center;gap:8px;border-radius:999px;letter-spacing:.08em}
    .awg6__dot{width:7px;height:7px;border-radius:50%;background:#57E389;box-shadow:0 0 14px rgba(87,227,137,.75)}
    .awg6[data-mode="demo"] .awg6__dot{background:#FFB347;box-shadow:0 0 14px rgba(255,179,71,.75)}
    .awg6__btn:hover{border-color:rgba(255,255,255,.22);transform:translateY(-1px)}
    .awg6__btnPrimary{
      background:linear-gradient(135deg,rgba(89,167,255,.28),rgba(176,124,255,.24));
      border-color:rgba(122,154,255,.45)
    }
    .awg6__layout{display:grid;grid-template-columns:minmax(0,1.85fr) minmax(290px,.58fr);gap:13px;padding:13px}
    .awg6__gameShell{
      min-width:0;border:1px solid var(--line);border-radius:20px;overflow:hidden;background:#06101B;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.025)
    }
    .awg6__gameTop{
      display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 13px;
      background:linear-gradient(180deg,#101B2B,#0B1420);border-bottom:1px solid var(--line)
    }
    .awg6__objectiveLabel{font-size:8px;letter-spacing:.13em;text-transform:uppercase;color:#6D7D95;font-weight:900}
    .awg6__objectiveText{font-size:12px;font-weight:900;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .awg6__phase{display:flex;gap:5px}
    .awg6__phaseDot{width:26px;height:6px;border-radius:99px;background:#223149;transition:.25s}
    .awg6__phaseDot.is-done:nth-child(1){background:#59A7FF}
    .awg6__phaseDot.is-done:nth-child(2){background:#41E6FF}
    .awg6__phaseDot.is-done:nth-child(3){background:#B07CFF}
    .awg6__phaseDot.is-done:nth-child(4){background:#FFB347}
    .awg6__phaseDot.is-done:nth-child(5){background:#FFB347}
    .awg6__phaseDot.is-done:nth-child(6){background:#57E389}
    .awg6__phaseDot.is-active{box-shadow:0 0 12px currentColor;filter:brightness(1.3)}
    .awg6__viewport{position:relative;overflow:auto;background:#07111C}
    .awg6__canvas{display:block;width:100%;height:auto;min-width:780px;aspect-ratio:24/14}
    .awg6__scan{
      position:absolute;left:0;right:0;height:90px;top:-100px;pointer-events:none;
      background:linear-gradient(180deg,transparent,rgba(73,191,255,.04),rgba(73,191,255,.11),transparent);
      animation:awg6-scan 8s linear infinite
    }
    @keyframes awg6-scan{to{transform:translateY(700px)}}
    .awg6__hud{position:absolute;left:13px;bottom:13px;display:flex;gap:7px;pointer-events:none}
    .awg6__chip{
      padding:7px 10px;border-radius:10px;background:rgba(5,11,19,.86);border:1px solid rgba(255,255,255,.09);
      color:#E8F0FF;font-size:9px;backdrop-filter:blur(10px)
    }
    .awg6__side{
      min-width:0;display:flex;flex-direction:column;gap:11px;border:1px solid var(--line);border-radius:20px;
      padding:14px;background:
      radial-gradient(circle at 85% 0%,rgba(176,124,255,.09),transparent 28%),
      linear-gradient(180deg,#121C2B,#0D1521)
    }
    .awg6__eyebrow{font-size:8px;letter-spacing:.13em;text-transform:uppercase;color:#738198;font-weight:900}
    .awg6__missionTitle{
      font-size:19px;line-height:1.13;font-weight:930;margin-top:5px;letter-spacing:-.025em;
      background:linear-gradient(90deg,#FFFFFF,#BAD8FF 50%,#D4C4FF);-webkit-background-clip:text;background-clip:text;color:transparent
    }
    .awg6__missionText{font-size:11px;line-height:1.6;color:#A4B1C4}
    .awg6__progress{height:6px;border-radius:99px;background:#1A273A;overflow:hidden}
    .awg6__progressBar{height:100%;width:0;background:linear-gradient(90deg,#59A7FF,#41E6FF,#B07CFF,#FFB347,#57E389);transition:width .35s ease}
    .awg6__stats{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .awg6__stat{
      position:relative;overflow:hidden;padding:10px;border-radius:12px;background:#141E2D;border:1px solid rgba(255,255,255,.045)
    }
    .awg6__stat:before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--stat,#59A7FF)}
    .awg6__stat:nth-child(1){--stat:#59A7FF}.awg6__stat:nth-child(2){--stat:#41E6FF}.awg6__stat:nth-child(3){--stat:#B07CFF}.awg6__stat:nth-child(4){--stat:#57E389}
    .awg6__statLabel{font-size:8px;text-transform:uppercase;letter-spacing:.09em;color:#68778D}
    .awg6__statValue{font-size:10px;font-weight:850;margin-top:4px;overflow-wrap:anywhere}
    .awg6__tabs{display:flex;gap:6px}
    .awg6__tab{
      flex:1;min-height:33px;border:1px solid var(--line);border-radius:9px;background:#111B29;color:#8090A6;
      font-size:9px;font-weight:850
    }
    .awg6__tab.is-active{color:#F7FAFF;border-color:rgba(89,167,255,.32);background:linear-gradient(180deg,#1A2A43,#152238)}
    .awg6__panel{display:none}.awg6__panel.is-active{display:block}
    .awg6__roster,.awg6__events{display:grid;gap:7px}
    .awg6__agentRow{
      --role:#59A7FF;display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:8px;align-items:center;
      padding:8px;border-radius:11px;background:#121C2A;border:1px solid rgba(255,255,255,.04);transition:.2s
    }
    .awg6__agentRow.is-active{
      background:linear-gradient(90deg,color-mix(in srgb,var(--role) 15%,#121C2A),#121C2A);
      border-color:color-mix(in srgb,var(--role) 38%,transparent);
      box-shadow:0 0 18px color-mix(in srgb,var(--role) 14%,transparent)
    }
    .awg6__avatar{
      width:32px;height:32px;border-radius:10px;display:grid;place-items:center;font-size:10px;font-weight:950;
      color:#08111E;background:linear-gradient(145deg,#EDF5FF,var(--role));box-shadow:0 5px 16px color-mix(in srgb,var(--role) 22%,transparent)
    }
    .awg6__agentName{font-size:10px;font-weight:880}.awg6__agentRole{font-size:8px;color:#718096;margin-top:1px}
    .awg6__agentState{font-size:8px;color:#8B9AAF}
    .awg6__event{
      --event:#59A7FF;display:grid;grid-template-columns:9px minmax(0,1fr);gap:9px;align-items:start;
      padding:8px;border-radius:9px;background:linear-gradient(90deg,color-mix(in srgb,var(--event) 7%,transparent),transparent);
      color:#99A7BA;font-size:9px
    }
    .awg6__event:first-child{color:#EEF4FF}
    .awg6__eventDot{width:8px;height:8px;border-radius:50%;background:var(--event);margin-top:2px;box-shadow:0 0 10px color-mix(in srgb,var(--event) 55%,transparent)}
    .awg6__zoneDetails{font-size:10px;line-height:1.55;color:#A0ADC0}
    .awg6__zoneSwatch{height:7px;border-radius:99px;margin:8px 0;background:linear-gradient(90deg,var(--z1),var(--z2))}
    .awg6__demoNote{
      display:none;margin:0 13px 13px;padding:9px 11px;border-radius:12px;
      border:1px solid rgba(255,179,71,.30);background:linear-gradient(90deg,rgba(255,179,71,.08),rgba(176,124,255,.05));
      color:#E8C582;font-size:9px
    }
    .awg6[data-mode="demo"] .awg6__demoNote{display:block}
    @media(max-width:1000px){.awg6__layout{grid-template-columns:1fr}.awg6__side{min-height:0}}
    @media(max-width:670px){
      .awg6__bar{align-items:flex-start;flex-direction:column}.awg6__controls{width:100%;justify-content:flex-start}
      .awg6__layout{padding:8px}.awg6__canvas{min-width:740px}.awg6__missionTitle{font-size:17px}
    }
    @media(prefers-reduced-motion:reduce){.awg6__scan{animation:none}.awg6__progressBar{transition:none}}
  `}

  function ensureStyles(){
    if(document.getElementById('awg6-styles'))return;
    const s=document.createElement('style');s.id='awg6-styles';s.textContent=css();document.head.appendChild(s)
  }

  function ensureRoot(){
    if(root&&root.isConnected)return root;
    ensureStyles();
    for(const id of ['agentWorldV2','agentWorldV3','agentWorldGame','agentWorldGameV5']){const old=document.getElementById(id);if(old)old.remove()}
    root=document.createElement('section');root.id='agentWorldGameV6';root.className='awg6';root.dataset.mode=mode;
    root.innerHTML=`
      <div class="awg6__bar">
        <div class="awg6__brand"><div class="awg6__mark">AW</div><div><div class="awg6__title">Agent World</div><div class="awg6__sub">Chromatic Tactical Engineering Command Center</div></div></div>
        <div class="awg6__controls">
          <span class="awg6__badge"><span class="awg6__dot"></span><span id="awg6Mode">LIVE</span></span>
          <button id="awg6Demo" class="awg6__btn awg6__btnPrimary" type="button">▶ Demo mission</button>
          <button id="awg6Pause" class="awg6__btn" type="button" hidden>Pause</button>
          <button id="awg6Speed" class="awg6__btn" type="button" hidden>1×</button>
          <button id="awg6Replay" class="awg6__btn" type="button" hidden>Replay</button>
          <button id="awg6Live" class="awg6__btn" type="button" hidden>Return live</button>
        </div>
      </div>
      <div class="awg6__layout">
        <div class="awg6__gameShell">
          <div class="awg6__gameTop">
            <div><div class="awg6__objectiveLabel">Current objective</div><div class="awg6__objectiveText" id="awg6Objective">Waiting for Engineering activity</div></div>
            <div class="awg6__phase">${DEMO.map((_,i)=>`<span class="awg6__phaseDot" data-phase="${i}"></span>`).join('')}</div>
          </div>
          <div class="awg6__viewport">
            <canvas id="awg6Canvas" class="awg6__canvas" width="${WORLD_W}" height="${WORLD_H}" aria-label="Agent World tactical lifecycle map"></canvas>
            <div class="awg6__scan"></div>
            <div class="awg6__hud"><span class="awg6__chip" id="awg6ZoneChip">Zone: —</span><span class="awg6__chip" id="awg6StatusChip">Status: idle</span></div>
          </div>
        </div>
        <aside class="awg6__side">
          <div><div class="awg6__eyebrow">Mission control</div><div class="awg6__missionTitle" id="awg6MissionTitle">No active mission</div></div>
          <div class="awg6__missionText" id="awg6MissionText">Start an Engineering run, or play the demo mission to see the full-color tactical world.</div>
          <div class="awg6__progress"><div class="awg6__progressBar" id="awg6Progress"></div></div>
          <div class="awg6__stats">
            <div class="awg6__stat"><div class="awg6__statLabel">Run</div><div class="awg6__statValue" id="awg6Run">—</div></div>
            <div class="awg6__stat"><div class="awg6__statLabel">Attempt</div><div class="awg6__statValue" id="awg6Attempt">—</div></div>
            <div class="awg6__stat"><div class="awg6__statLabel">Change</div><div class="awg6__statValue" id="awg6Change">—</div></div>
            <div class="awg6__stat"><div class="awg6__statLabel">Location</div><div class="awg6__statValue" id="awg6Location">—</div></div>
          </div>
          <div class="awg6__tabs">
            <button class="awg6__tab is-active" type="button" data-tab="agents">Agents</button>
            <button class="awg6__tab" type="button" data-tab="events">Events</button>
            <button class="awg6__tab" type="button" data-tab="zone">Zone</button>
          </div>
          <div class="awg6__panel is-active" data-panel="agents"><div class="awg6__roster" id="awg6Roster"></div></div>
          <div class="awg6__panel" data-panel="events"><div class="awg6__events" id="awg6Events"></div></div>
          <div class="awg6__panel" data-panel="zone"><div class="awg6__zoneDetails" id="awg6ZoneDetails">Select a building on the map to inspect its lifecycle zone.</div></div>
        </aside>
      </div>
      <div class="awg6__demoNote">DEMO MODE — local visual simulation only. No Engineering run, Change, approval, or deployment is created.</div>
    `;
    const anchor=document.getElementById('engineeringStatus')||document.getElementById('engineeringState');
    if(anchor&&anchor.parentElement)anchor.insertAdjacentElement('afterend',root);else document.body.appendChild(root);
    canvas=root.querySelector('#awg6Canvas');ctx=canvas.getContext('2d');

    root.querySelector('#awg6Demo').addEventListener('click',startDemo);
    root.querySelector('#awg6Pause').addEventListener('click',togglePause);
    root.querySelector('#awg6Speed').addEventListener('click',cycleSpeed);
    root.querySelector('#awg6Replay').addEventListener('click',()=>{demoIndex=0;demoWaitUntil=0;paused=false;runDemoStage(true)});
    root.querySelector('#awg6Live').addEventListener('click',returnLive);
    root.querySelectorAll('.awg6__tab').forEach(btn=>btn.addEventListener('click',()=>switchTab(btn.dataset.tab)));

    canvas.addEventListener('click',e=>{
      const r=canvas.getBoundingClientRect(),sx=canvas.width/r.width,sy=canvas.height/r.height;
      const x=e.offsetX*sx,y=e.offsetY*sy;let found=null;
      for(const [id,loc] of Object.entries(ZONES)){
        const px=loc.x*TILE+TILE/2,py=loc.y*TILE+TILE/2;
        if(Math.hypot(px-x,py-y)<65){found=id;break}
      }
      selectedZone=found;updateZonePanel()
    });

    buildMap();initAgents();startLoop();return root
  }

  function buildMap(){
    for(let y=0;y<ROWS;y++)for(let x=0;x<COLS;x++)map[y][x]=0;
    for(let x=0;x<COLS;x++){map[0][x]=1;map[ROWS-1][x]=1}
    for(let y=0;y<ROWS;y++){map[y][0]=1;map[y][COLS-1]=1}
    const blocks=[[2,2,4,3],[8,1,4,3],[14,2,4,3],[19,1,4,3],[19,9,4,3],[8,10,4,3]];
    for(const [bx,by,bw,bh] of blocks)for(let y=by;y<by+bh;y++)for(let x=bx;x<bx+bw;x++)if(x<COLS&&y<ROWS)map[y][x]=2;
    const roadY=7;for(let x=1;x<COLS-1;x++)map[roadY][x]=0;
    for(const loc of Object.values(ZONES)){
      map[loc.y][loc.x]=0;
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]])if(map[loc.y+dy]?.[loc.x+dx]!=null)map[loc.y+dy][loc.x+dx]=0;
      const minY=Math.min(loc.y,roadY),maxY=Math.max(loc.y,roadY);
      for(let y=minY;y<=maxY;y++)map[y][loc.x]=0
    }
  }

  function switchTab(name){
    root.querySelectorAll('.awg6__tab').forEach(x=>x.classList.toggle('is-active',x.dataset.tab===name));
    root.querySelectorAll('.awg6__panel').forEach(x=>x.classList.toggle('is-active',x.dataset.panel===name))
  }

  function initAgents(){
    if(agents.size)return;
    const starts={engineer:'planning',validator:'validation',reviewer:'approval',deployer:'deployment',operator:'operations'};
    for(const def of AGENTS){
      const loc=ZONES[starts[def.id]];
      agents.set(def.id,{...def,x:loc.x+.5,y:loc.y+.5,path:[],pathIndex:0,state:'idle',zone:starts[def.id]})
    }
    renderRoster()
  }

  function neighbors(x,y){
    return [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>[x+dx,y+dy]).filter(([nx,ny])=>nx>=0&&nx<COLS&&ny>=0&&ny<ROWS&&map[ny][nx]!==1&&map[ny][nx]!==2)
  }

  function findPath(sx,sy,gx,gy){
    sx=Math.floor(sx);sy=Math.floor(sy);gx=Math.floor(gx);gy=Math.floor(gy);
    const key=(x,y)=>`${x},${y}`,open=[{x:sx,y:sy,g:0,f:0}],came=new Map(),cost=new Map([[key(sx,sy),0]]),seen=new Set();
    while(open.length){
      open.sort((a,b)=>a.f-b.f);const cur=open.shift(),ck=key(cur.x,cur.y);if(seen.has(ck))continue;seen.add(ck);
      if(cur.x===gx&&cur.y===gy){
        const path=[];let k=ck;
        while(k!==key(sx,sy)){const [x,y]=k.split(',').map(Number);path.push({x:x+.5,y:y+.5});k=came.get(k);if(!k)break}
        return path.reverse()
      }
      for(const [nx,ny] of neighbors(cur.x,cur.y)){
        const nk=key(nx,ny),ng=cur.g+1;
        if(ng<(cost.get(nk)??Infinity)){cost.set(nk,ng);came.set(nk,ck);open.push({x:nx,y:ny,g:ng,f:ng+Math.abs(gx-nx)+Math.abs(gy-ny)})}
      }
    }
    return[]
  }

  function sendAgent(id,zone,state='moving'){
    const a=agents.get(id),loc=ZONES[zone];if(!a||!loc)return;
    a.path=findPath(a.x,a.y,loc.x,loc.y);a.pathIndex=0;a.state=state;a.zone=zone;
    emit(loc.x*TILE+TILE/2,loc.y*TILE+TILE/2,12,loc.c1);renderRoster()
  }

  function emit(x,y,count,color){
    for(let i=0;i<count;i++)particles.push({x,y,vx:(Math.random()-.5)*64,vy:(Math.random()-.5)*60-18,life:.9+Math.random()*.5,max:1.4,color})
  }

  function activeStep(run){
    const s=Array.isArray(run?.steps)?run.steps:[];
    return [...s].reverse().find(x=>x?.state==='running'||x?.state==='waiting')||s.at(-1)||null
  }

  function zoneFor(run){
    const status=String(run?.status||''),step=activeStep(run),text=`${step?.name||''} ${step?.detail||''}`.toLowerCase();
    if(status==='needs_attention')return'attention';if(status==='applied')return'operations';if(status==='approved'||status==='apply_requested')return'deployment';if(status==='awaiting_approval')return'approval';
    if(status==='running'){if(/validat|stage|syntax|contract|smoke|test/.test(text))return'validation';if(/deploy|apply/.test(text))return'deployment';if(/approv|review/.test(text))return'approval';return'planning'}
    return'planning'
  }

  function setAgentStates(zone,status){
    sendAgent('engineer',zone,status==='running'?'working':'moving');
    for(const id of ['validator','reviewer','deployer','operator'])agents.get(id).state='idle';
    if(zone==='validation')sendAgent('validator','validation','working');
    if(zone==='approval')sendAgent('reviewer','approval','working');
    if(zone==='deployment')sendAgent('deployer','deployment','working');
    if(zone==='operations')sendAgent('operator','operations','working');
    if(zone==='attention'){sendAgent('validator','attention','working');sendAgent('engineer','attention','working')}
    renderRoster()
  }

  function renderLive(run){
    ensureRoot();lastLiveRun=run||lastLiveRun;if(mode!=='live')return;
    if(!run){setMission('No active mission','Start an Engineering run, or use Demo to preview the full lifecycle.','idle',null);return}
    const zone=zoneFor(run),step=activeStep(run);setAgentStates(zone,run.status);
    setMission(step?.name||run.status,step?.detail||run.error||'',run.status,{id:run.id,attempt:run.attempt,maxAttempts:run.maxAttempts,change:run.finalChangeId,zone});
    addEvent(`Live state: ${run.status} · ${ZONES[zone].label}`,ZONES[zone].c1)
  }

  function setMission(title,text,status,meta){
    ensureRoot();
    root.querySelector('#awg6MissionTitle').textContent=title||'—';root.querySelector('#awg6MissionText').textContent=text||'';
    root.querySelector('#awg6Objective').textContent=title||'Waiting for Engineering activity';root.querySelector('#awg6StatusChip').textContent=`Status: ${status||'idle'}`;
    root.querySelector('#awg6Run').textContent=meta?.id||'—';root.querySelector('#awg6Attempt').textContent=meta?.attempt!=null&&meta?.maxAttempts!=null?`${meta.attempt}/${meta.maxAttempts}`:'—';
    root.querySelector('#awg6Change').textContent=meta?.change||'—';const z=meta?.zone?ZONES[meta.zone]:null;root.querySelector('#awg6Location').textContent=z?.label||'—';root.querySelector('#awg6ZoneChip').textContent=`Zone: ${z?.label||'—'}`;
    let pct=0;if(mode==='demo')pct=((demoIndex+1)/DEMO.length)*100;else pct={running:18,awaiting_approval:52,approved:66,apply_requested:82,applied:100,needs_attention:45}[status]||0;
    root.querySelector('#awg6Progress').style.width=`${pct}%`;updatePhase()
  }

  function updatePhase(){
    root.querySelectorAll('.awg6__phaseDot').forEach((el,i)=>{
      const current=mode==='demo'?demoIndex:Math.min(DEMO.length-1,Math.round((parseFloat(root.querySelector('#awg6Progress').style.width)||0)/100*(DEMO.length-1)));
      el.classList.toggle('is-done',i<=current);el.classList.toggle('is-active',i===current)
    })
  }

  function addEvent(text,color='#59A7FF'){
    if(!text||events[0]?.text===text)return;events.unshift({text,color});if(events.length>8)events.length=8;renderEvents()
  }

  function renderEvents(){
    if(!root)return;const wrap=root.querySelector('#awg6Events');wrap.replaceChildren();
    for(const item of events){
      const row=document.createElement('div');row.className='awg6__event';row.style.setProperty('--event',item.color);
      row.innerHTML=`<span class="awg6__eventDot"></span><span>${item.text}</span>`;wrap.appendChild(row)
    }
    if(!events.length){const row=document.createElement('div');row.className='awg6__event';row.innerHTML='<span class="awg6__eventDot"></span><span>No events yet.</span>';wrap.appendChild(row)}
  }

  function renderRoster(){
    if(!root)return;const wrap=root.querySelector('#awg6Roster');wrap.replaceChildren();
    for(const def of AGENTS){
      const a=agents.get(def.id),row=document.createElement('div');row.className='awg6__agentRow'+(a?.state==='working'||a?.state==='moving'?' is-active':'');
      row.style.setProperty('--role',ROLE_COLORS[def.id]);
      row.innerHTML=`<div class="awg6__avatar">${def.glyph}</div><div><div class="awg6__agentName">${def.name}</div><div class="awg6__agentRole">${def.role}</div></div><div class="awg6__agentState">${a?.state||'idle'}</div>`;wrap.appendChild(row)
    }
  }

  function updateZonePanel(){
    if(!root)return;const el=root.querySelector('#awg6ZoneDetails');
    if(!selectedZone||!ZONES[selectedZone]){el.textContent='Select a building on the map to inspect its lifecycle zone.';return}
    const z=ZONES[selectedZone];
    el.innerHTML=`<strong>${z.label}</strong><div class="awg6__zoneSwatch" style="--z1:${z.c1};--z2:${z.c2}"></div>Lifecycle zone: ${selectedZone}<br>Primary accent: ${z.c1}`
  }

  function setMode(next){
    mode=next;root.dataset.mode=mode;root.querySelector('#awg6Mode').textContent=mode==='demo'?'DEMO':'LIVE';
    root.querySelector('#awg6Demo').hidden=mode==='demo';root.querySelector('#awg6Pause').hidden=mode!=='demo';root.querySelector('#awg6Speed').hidden=mode!=='demo';root.querySelector('#awg6Replay').hidden=mode!=='demo';root.querySelector('#awg6Live').hidden=mode!=='demo'
  }

  function startDemo(){
    ensureRoot();setMode('demo');paused=false;speed=1;demoIndex=0;demoWaitUntil=0;events.length=0;
    root.querySelector('#awg6Pause').textContent='Pause';root.querySelector('#awg6Speed').textContent='1×';runDemoStage(true)
  }

  function runDemoStage(force=false){
    if(mode!=='demo')return;const s=DEMO[demoIndex],eng=agents.get('engineer');
    if(force||eng.zone!==s.zone||!eng.path.length)setAgentStates(s.zone,s.status);
    setMission(s.title,s.detail,s.status,{id:'demo-run-001',attempt:1,maxAttempts:3,change:demoIndex>=2?'demo-change-001':null,zone:s.zone});
    addEvent(s.event,ZONES[s.zone].c1)
  }

  function togglePause(){paused=!paused;root.querySelector('#awg6Pause').textContent=paused?'Resume':'Pause'}
  function cycleSpeed(){speed=speed===1?2:speed===2?4:1;root.querySelector('#awg6Speed').textContent=`${speed}×`}
  function returnLive(){paused=false;speed=1;setMode('live');if(lastLiveRun)renderLive(lastLiveRun);else bootstrap()}

  function update(dt,ts){
    if(paused)return;const scaled=dt*speed;
    for(const a of agents.values()){
      if(a.pathIndex<a.path.length){
        const t=a.path[a.pathIndex],dx=t.x-a.x,dy=t.y-a.y,dist=Math.hypot(dx,dy),move=3.1*scaled;
        trails.push({x:a.x*TILE,y:a.y*TILE,life:.34,max:.34,color:ROLE_COLORS[a.id]});
        if(dist<=move){a.x=t.x;a.y=t.y;a.pathIndex++;if(a.pathIndex>=a.path.length){a.state='working';emit(a.x*TILE,a.y*TILE,14,ZONES[a.zone]?.c1||ROLE_COLORS[a.id]);renderRoster()}}
        else{a.x+=dx/dist*move;a.y+=dy/dist*move}
      }
    }
    particles=particles.filter(p=>{p.life-=scaled;p.x+=p.vx*scaled;p.y+=p.vy*scaled;p.vy+=46*scaled;return p.life>0});
    trails=trails.filter(t=>{t.life-=scaled;return t.life>0});pulse+=scaled;
    if(mode==='demo'){
      const eng=agents.get('engineer'),arrived=eng.pathIndex>=eng.path.length;
      if(arrived){if(!demoWaitUntil)demoWaitUntil=ts+1500/speed;if(ts>=demoWaitUntil){demoWaitUntil=0;demoIndex++;if(demoIndex>=DEMO.length){demoIndex=DEMO.length-1;paused=true;root.querySelector('#awg6Pause').textContent='Resume'}else runDemoStage()}}else demoWaitUntil=0
    }
  }

  function roundRect(c,x,y,w,h,r,fill,stroke){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();if(fill)c.fill();if(stroke)c.stroke()}

  function draw(){
    if(!ctx)return;ctx.clearRect(0,0,WORLD_W,WORLD_H);
    const bg=ctx.createLinearGradient(0,0,WORLD_W,WORLD_H);bg.addColorStop(0,'#091420');bg.addColorStop(.55,'#0C1623');bg.addColorStop(1,'#071018');ctx.fillStyle=bg;ctx.fillRect(0,0,WORLD_W,WORLD_H);

    // subtle colored atmosphere
    for(const [id,z] of Object.entries(ZONES)){
      const g=ctx.createRadialGradient(z.x*TILE,z.y*TILE,4,z.x*TILE,z.y*TILE,150);
      g.addColorStop(0,z.glow);g.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=g;ctx.fillRect((z.x-4)*TILE,(z.y-4)*TILE,8*TILE,8*TILE)
    }

    // grid floor
    for(let y=0;y<ROWS;y++)for(let x=0;x<COLS;x++){
      const px=x*TILE,py=y*TILE;ctx.fillStyle=((x+y)%2===0)?'rgba(17,32,48,.66)':'rgba(13,27,42,.66)';ctx.fillRect(px,py,TILE,TILE);
      ctx.strokeStyle='rgba(255,255,255,.025)';ctx.strokeRect(px+.5,py+.5,TILE-1,TILE-1)
    }

    // roads
    const road=ctx.createLinearGradient(0,0,WORLD_W,0);road.addColorStop(0,'#1B2B3B');road.addColorStop(.5,'#22354A');road.addColorStop(1,'#1A2A3A');
    ctx.fillStyle=road;ctx.fillRect(TILE,7*TILE,(COLS-2)*TILE,TILE);
    for(const z of Object.values(ZONES)){const y1=Math.min(z.y,7)*TILE,h=(Math.abs(z.y-7)+1)*TILE;ctx.fillRect(z.x*TILE,y1,TILE,h)}
    ctx.strokeStyle='rgba(120,155,200,.26)';ctx.setLineDash([12,12]);ctx.beginPath();ctx.moveTo(TILE,7.5*TILE);ctx.lineTo((COLS-1)*TILE,7.5*TILE);ctx.stroke();ctx.setLineDash([]);

    const activeZone=mode==='demo'?DEMO[demoIndex]?.zone:(lastLiveRun?zoneFor(lastLiveRun):null);

    // buildings
    for(const [id,z] of Object.entries(ZONES)){
      const active=id===activeZone,bx=(z.x-1.58)*TILE,by=(z.y-1.18)*TILE,bw=3.16*TILE,bh=2.36*TILE;
      ctx.shadowColor=active?z.c1:'transparent';ctx.shadowBlur=active?28+5*Math.sin(pulse*3):0;
      const grad=ctx.createLinearGradient(bx,by,bx+bw,by+bh);grad.addColorStop(0,active?z.c2:'#17283B');grad.addColorStop(1,active?z.c1:'#102031');
      ctx.fillStyle=grad;roundRect(ctx,bx,by,bw,bh,14,true,false);ctx.shadowBlur=0;
      ctx.strokeStyle=active?z.c1:'rgba(255,255,255,.085)';ctx.lineWidth=active?2.1:1;roundRect(ctx,bx+.5,by+.5,bw-1,bh-1,14,false,true);

      // roof stripe
      ctx.fillStyle=active?z.c1:'rgba(255,255,255,.08)';roundRect(ctx,bx+10,by+9,bw-20,6,3,true,false);

      // windows
      for(let i=0;i<4;i++){
        ctx.fillStyle=active?`${z.c1}AA`:'rgba(102,132,170,.28)';
        roundRect(ctx,bx+14+i*22,by+26,14,10,3,true,false)
      }

      // beacon
      if(active){
        ctx.strokeStyle=z.c1;ctx.globalAlpha=.22+.1*Math.sin(pulse*5);ctx.lineWidth=2;ctx.beginPath();ctx.arc(z.x*TILE+TILE/2,z.y*TILE+TILE/2,24+5*Math.sin(pulse*3),0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1
      }

      ctx.fillStyle='#F4F8FF';ctx.font='850 12px system-ui';ctx.textAlign='center';ctx.fillText(z.label,z.x*TILE+TILE/2,by+bh-13);
      ctx.fillStyle=z.c1;ctx.beginPath();ctx.arc(z.x*TILE+TILE/2,z.y*TILE+TILE/2,14,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#07101A';ctx.font='950 11px system-ui';ctx.fillText(z.icon,z.x*TILE+TILE/2,z.y*TILE+TILE/2+4)
    }

    for(const t of trails){ctx.globalAlpha=Math.max(0,t.life/t.max)*.5;ctx.fillStyle=t.color;ctx.beginPath();ctx.arc(t.x,t.y,3.2,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=1;
    for(const p of particles){ctx.globalAlpha=Math.max(0,p.life/p.max);ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,2.4,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=1;

    for(const a of agents.values())drawAgent(a)
  }

  function drawAgent(a){
    const x=a.x*TILE,y=a.y*TILE,color=ROLE_COLORS[a.id],active=a.state==='working'||a.state==='moving';
    if(active){ctx.strokeStyle=color;ctx.globalAlpha=.24+.11*Math.sin(pulse*5);ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,18+3*Math.sin(pulse*4),0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1}
    const g=ctx.createRadialGradient(x-5,y-6,2,x,y,14);g.addColorStop(0,'#FFFFFF');g.addColorStop(.35,'#EEF4FF');g.addColorStop(1,color);
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,12,0,Math.PI*2);ctx.fill();ctx.strokeStyle='rgba(255,255,255,.55)';ctx.lineWidth=1.4;ctx.stroke();
    ctx.fillStyle='#07101A';ctx.font='950 9px system-ui';ctx.textAlign='center';ctx.fillText(a.glyph,x,y+3);
    ctx.fillStyle='rgba(5,10,17,.88)';roundRect(ctx,x-27,y+16,54,14,6,true,false);ctx.fillStyle='#EEF4FF';ctx.font='750 7px system-ui';ctx.fillText(a.name,x,y+26)
  }

  // Only animate while the canvas is on screen and the tab is visible; one rAF chain at most.
  let io=null,observed=null,onScreen=!('IntersectionObserver' in window);
  function canAnimate(){return !!(canvas&&canvas.isConnected&&onScreen&&!document.hidden)}
  function stopLoop(){if(raf){cancelAnimationFrame(raf);raf=null}lastTs=0}
  function loop(ts){raf=null;if(!canAnimate()){lastTs=0;return}if(!lastTs)lastTs=ts;const dt=Math.min(.05,(ts-lastTs)/1000);lastTs=ts;update(dt,ts);draw();raf=requestAnimationFrame(loop)}
  function startLoop(){
    if(canvas&&observed!==canvas&&'IntersectionObserver' in window){io?.disconnect();onScreen=false;observed=canvas;io=new IntersectionObserver(entries=>{onScreen=entries[entries.length-1].isIntersecting;onScreen?startLoop():stopLoop()});io.observe(canvas)}
    if(!raf&&canAnimate())raf=requestAnimationFrame(loop)
  }
  document.addEventListener('visibilitychange',()=>document.hidden?stopLoop():startLoop());

  async function bootstrap(){
    ensureRoot();try{const data=await evoApi('/api/engineering/runs');const items=Array.isArray(data?.items)?[...data.items]:[];items.sort((a,b)=>new Date(b.updatedAt||0)-new Date(a.updatedAt||0));lastLiveRun=items[0]||null;if(lastLiveRun)renderLive(lastLiveRun);else renderLive(null)}catch(_){renderLive(null)}
  }
  function updateRun(run){lastLiveRun=run||lastLiveRun;if(mode==='live')renderLive(run)}
  return{bootstrap,update:updateRun,startDemo,returnLive,zoneFor}
})();

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>AgentWorldGame.bootstrap(),{once:true});
else AgentWorldGame.bootstrap();
/* === Agent World Chromatic v6 END === */

async function pollEngineeringIntent(runId,msg=null){
  if(msg&&!state.messages.includes(msg))return;
  try{
    const data=await evoApi('/api/engineering/runs');
    const run=(data.items||[]).find(x=>x.id===runId);
    if(!run)return;
    try{AgentWorldGame.update(run)}catch{}
    if($('engineeringState'))$('engineeringState').textContent=run.status;
    if($('engineeringStatus'))$('engineeringStatus').textContent=engineeringRunText(run).split('\n').join(' ? ');

    if(msg&&state.messages.includes(msg)){
      const m=msg;
      m.content=engineeringRunText(run);
      m.streaming=run.status==='running';
      m.action=null;

      if(run.status==='awaiting_approval')
        m.action={view:'changes',changeId:run.finalChangeId,label:'Review validated change'};
      else if(run.status==='needs_attention')
        m.action={view:'engineering',runId:run.id,label:'Open Engineer'};

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
  if(navigate)showView('engineering');
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
  $('sendBtn').textContent='Stop';
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
    $('sendBtn').textContent='Send';
    if(state.chatPhase!=='error'&&state.chatPhase!=='done') setPhase('idle');
  }
}
$('sendBtn').addEventListener('click',()=>{ if(state.streamController) abortStream('Response stopped'); else sendChat(); });$('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();}});

qsa('.mode').forEach(b=>b.addEventListener('click',()=>{state.mode=b.dataset.mode;qsa('.mode').forEach(x=>x.classList.toggle('active',x===b));}));
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
    const request=engineeringRequestWithContext(text,route);showView('engineering');$('engineeringRequest').value=request;$('engineeringTarget').value='self';$('engineeringRoot').disabled=true;
    try{await submitEngineeringIntent(request,{navigate:true})}catch(e){$('engineeringStatus').textContent=`Error: ${e.message}`;setPhase('error','Engineering failed');toast(e.message)}
  }else if(route.intent==='create'){openCreate();$('imagePrompt').value=text;setPhase('idle');}
  else if(route.intent==='automate'){showView('automations');setPhase('done','Automation workspace');}
  else{openAsk(route.intent==='research');$('chatInput').value=text;setTimeout(sendChat,20);}
}
$('commandGo').addEventListener('click',runCommand);$('commandInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();runCommand();}});document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&!$('cmdk')){e.preventDefault();showView('home');setTimeout(()=>$('commandInput').focus(),20);}});

function familyLabel(v){return ({sd15:'SD 1.5',sdxl:'SDXL',flux:'FLUX',unknown:'Unknown'})[v]||v;}
function familySizes(f){return f==='sdxl'||f==='flux'?['1024x1024','1024x768','768x1024','512x512']:['512x512','768x512','512x768','1024x1024'];}
function setImageSizes(f){const cur=$('imageSize').value,opts=familySizes(f);$('imageSize').innerHTML=opts.map(v=>{const [w,h]=v.split('x');const shape=w===h?'Square':Number(w)>Number(h)?'Landscape':'Portrait';return `<option value="${v}">${shape} · ${w}×${h}</option>`}).join('');if(opts.includes(cur))$('imageSize').value=cur;}
function renderImageFamilyInfo(){const data=state.imageModels;if(!data){$('imageModelInfo').textContent='Discovering available image model families…';return;}const family=$('imageFamily').value;const families=(data.families||[]);const group=families.find(x=>x.family===family)||families[0];const selected=(data.models||[]).find(x=>x.checkpoint===$('checkpoint').value);let msg='';if(group){msg=`${familyLabel(group.family)} · ${group.models.length} model(s)`;if(group.supported===false)msg+=` · ${group.reason||'Requires a different workflow graph'}`;else if(group.family==='unknown')msg+=' · best-effort compatibility';}
if(selected&&selected.checkpoint){msg += ` · selected: ${selected.checkpoint}`; if(selected.supported===false && selected.reason) msg += ` · ${selected.reason}`;} $('imageModelInfo').textContent=msg||'No image models found.';const generateDisabled = !selected || !!(selected && selected.supported===false);$('generateBtn').disabled = generateDisabled;}
function updateImageModelOptions(){const data=state.imageModels||{families:[],models:[]};const family=$('imageFamily').value;const models=(data.models||[]).filter(x=>!family||x.family===family);$('checkpoint').innerHTML=models.length?models.map(x=>`<option value="${esc(x.checkpoint)}">${esc(x.checkpoint)}${x.supported===false?' · unsupported':''}</option>`).join(''):'<option>No compatible models found</option>';setImageSizes(family||'sd15');renderImageFamilyInfo();}
async function loadCheckpoints(){if(state.checkpointsLoaded)return;try{const r=await fetch('/api/images/models',{cache:'no-store'}),j=await r.json();if(!r.ok)throw new Error(j.error||'Unable to load image models');state.imageModels=j;const fams=(j.families||[]);$('imageFamily').innerHTML=fams.length?fams.map(x=>`<option value="${esc(x.family)}">${esc(familyLabel(x.family))}${x.supported===false?' · unsupported':''}</option>`).join(''):'<option value="">No model families found</option>';if(j.defaultFamily)$('imageFamily').value=j.defaultFamily;updateImageModelOptions();state.checkpointsLoaded=true;}catch(e){$('imageFamily').innerHTML=`<option value="">Unavailable</option>`;$('checkpoint').innerHTML=`<option>${esc(e.message)}</option>`;$('imageModelInfo').textContent=e.message;}}
async function generateImage(){
  const prompt=$('imagePrompt').value.trim();if(!prompt)return;const [width,height]=$('imageSize').value.split('x').map(Number);$('generateBtn').disabled=true;setPhase('generating','Generating image…');$('imageMeta').textContent='Queued locally…';$('imageResult').style.display='none';
  try{const r=await fetch('/api/images/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,negativePrompt:$('negativePrompt').value,family:$('imageFamily').value,checkpoint:$('checkpoint').value,width,height,steps:Number($('steps').value),cfg:Number($('cfg').value)})});const j=await r.json();if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);const src=cacheBust(j.imageUrl);if(!src)throw new Error('Image service returned an unsafe URL');$('generatedImage').src=src;$('imageResult').style.display='block';$('imageMeta').textContent=`Created in ${(j.elapsedMs/1000).toFixed(1)}s · ${j.width}×${j.height} · seed ${j.seed} · ${familyLabel(j.family||'unknown')}`;setPhase('done','Image ready');await Promise.all([loadActivity(),loadLibrary(),loadWorkspace()]);}catch(e){$('imageMeta').textContent=`Error: ${e.message}`;setPhase('error','Image failed');}finally{renderImageFamilyInfo();}}
$('imageFamily').addEventListener('change',updateImageModelOptions);$('checkpoint').addEventListener('change',renderImageFamilyInfo);$('generateBtn').addEventListener('click',generateImage);$('clearImageBtn').addEventListener('click',()=>{$('imagePrompt').value='';$('imageMeta').textContent='';$('imageResult').style.display='none';setPhase('idle');renderImageFamilyInfo();});

function renderActivity(){const user=state.activity;$('activityList').innerHTML=user.length?user.map(activityHtml).join(''):'<div class="empty">No activity yet.</div>';$('homeActivity').innerHTML=user.slice(0,5).map(activityHtml).join('')||'<div class="empty">No recent activity.</div>';}
async function loadActivity(){try{const r=await fetch('/api/activity',{cache:'no-store'}),j=await r.json();state.activity=j.items||[];renderActivity();}catch{}}
$('clearUserActivityBtn').addEventListener('click',async()=>{if(!confirm('Clear user activity? System and recovery audit events will be preserved.'))return;await fetch('/api/activity/clear',{method:'POST'});await Promise.all([loadActivity(),loadWorkspace()]);toast('User activity cleared');});

function artifactCard(item){
  const image=item.kind==='image'?safeUrl(item.meta?.imageUrl||item.data?.imageUrl,{image:true}):'';const symbol=icons[item.kind]||'□';
  return `<article class="artifact" data-artifact="${esc(item.id)}"><div class="artifact-preview">${image?`<img src="${esc(image)}" alt="">`:symbol}</div><div class="artifact-body"><div class="artifact-kind">${esc(item.kind||'artifact')}</div><div class="artifact-title" title="${esc(item.title)}">${esc(item.title)}</div><div class="artifact-summary">${esc(item.summary||'')}</div><div class="artifact-foot"><span class="meta">${ago(item.createdAt)}</span><span><button class="iconbtn pin-artifact" title="${item.pinned?'Unpin':'Pin'}">${item.pinned?'★':'☆'}</button><button class="iconbtn delete-artifact" title="Delete">×</button></span></div></div></article>`;
}
function renderLibrary(){
  let items=state.library;const query=state.librarySearch.toLowerCase();if(state.libraryKind==='pinned')items=items.filter(x=>x.pinned);else if(state.libraryKind!=='all')items=items.filter(x=>x.kind===state.libraryKind);if(query)items=items.filter(x=>`${x.title} ${x.summary} ${x.kind}`.toLowerCase().includes(query));
  $('libraryCount').textContent=`${items.length} item${items.length===1?'':'s'}`;const sig=items.map(x=>`${x.id}:${x.pinned}`).join('|');if(sig===state.lastLibrarySignature&&$('libraryGrid').children.length)return;state.lastLibrarySignature=sig;$('libraryGrid').innerHTML=items.length?items.map(artifactCard).join(''):'<div class="empty">No matching artifacts.</div>';
  qsa('.pin-artifact').forEach(b=>b.addEventListener('click',async e=>{const card=e.target.closest('[data-artifact]'),item=state.library.find(x=>x.id===card.dataset.artifact);if(!item)return;await fetch('/api/library/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id,pinned:!item.pinned})});state.lastLibrarySignature='';await Promise.all([loadLibrary(),loadWorkspace()]);}));
  qsa('.delete-artifact').forEach(b=>b.addEventListener('click',async e=>{const id=e.target.closest('[data-artifact]').dataset.artifact;if(!confirm('Delete this Library item?'))return;await fetch('/api/library/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});state.lastLibrarySignature='';await Promise.all([loadLibrary(),loadWorkspace(),loadActivity()]);}));
}
async function loadLibrary(){try{const r=await fetch('/api/library',{cache:'no-store'}),j=await r.json();state.library=j.items||[];renderLibrary();}catch{}}
$('librarySearch').addEventListener('input',e=>{state.librarySearch=e.target.value;state.lastLibrarySignature='';renderLibrary();});qsa('[data-kind]').forEach(b=>b.addEventListener('click',()=>{state.libraryKind=b.dataset.kind;qsa('[data-kind]').forEach(x=>x.classList.toggle('active',x===b));state.lastLibrarySignature='';renderLibrary();}));
async function loadWorkspace(){try{const r=await fetch('/api/workspace',{cache:'no-store'}),j=await r.json();state.workspace=j;$('homeRecent').innerHTML=(j.recent||[]).slice(0,5).map(artifactRow).join('')||'<div class="empty">No saved work yet.</div>';$('homePinned').innerHTML=(j.pinned||[]).slice(0,4).map(artifactRow).join('')||'<div class="empty">Pin Library items to keep them here.</div>';}catch{}}

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
async function loadHomeCapabilities(){
  const box=$('homeCapabilities');if(!box)return;
  try{const r=await fetch('/api/capabilities',{cache:'no-store'}),j=await r.json();if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);const imageNames=(j.images?.models||[]).filter(x=>x.supported).map(x=>x.familyLabel||x.family);const unique=[...new Set(imageNames)];box.innerHTML=`<div class="cap-tile"><b>${esc(j.version||'—')}</b><span>Local AI</span></div><div class="cap-tile"><b>${esc(j.overall||'—')}</b><span>System</span></div><div class="cap-tile"><b>${unique.length?esc(unique.join(', ')):'Unavailable'}</b><span>Images</span></div><div class="cap-tile"><b>${j.engineering?.active||0}</b><span>Engineering active</span></div><div class="cap-tile"><b>${j.changes?.pending||0}</b><span>Pending changes</span></div><div class="cap-tile"><b>${j.issues?.open||0}</b><span>Open issues</span></div><div class="cap-tile"><b>${j.powershell?.configured?'Ready':'Setup'}</b><span>PowerShell</span></div>`}catch(e){box.innerHTML=`<div class="empty">Capability snapshot unavailable: ${esc(e.message)}</div>`}
}
function schedulePolling(){clearInterval(state.statusTimer);clearInterval(state.activityTimer);if(!document.hidden){state.statusTimer=setInterval(refreshStatus,60000);state.activityTimer=setInterval(()=>{loadActivity();loadWorkspace();},60000);}}
document.addEventListener('visibilitychange',()=>{schedulePolling();if(!document.hidden){refreshStatus();loadActivity();loadWorkspace();}});

async function detectOfflineReady(){if(!('serviceWorker' in navigator)){ $('offlineHint').textContent='Local-first shell · service worker unavailable';return;}try{await navigator.serviceWorker.register('/sw.js');$('offlineHint').textContent='Local-first shell · offline shell ready';}catch(e){$('offlineHint').textContent='Local-first shell · offline cache unavailable';console.debug('Service worker registration failed',e);}}
async function init(){renderAgentMap();renderMessages();setPhase('idle');loadActivity();loadLibrary();loadWorkspace();refreshStatus();loadHomeCapabilities();schedulePolling();detectOfflineReady();try{const r=await fetch('/api/models',{cache:'no-store'}),j=await r.json();state.model=j.default||j.models?.[0]||null;}catch{} }
init();


// ===== cumulative release client ============================================
const releaseState={config:null,projects:[],knowledge:[],agents:[],automations:[],selectedProject:'',editorPath:'',editorOriginal:''};
const api=async(url,opt={})=>{const r=await fetch(url,opt);let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);return j};
const post=(url,body)=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
function featureLevel(){return Number(String(releaseState.config?.version||'1.2').split('.')[1]||2)}
function fillProjectSelects(){for(const id of ['knowledgeProject','agentProject']){const el=$(id);if(!el)continue;const old=el.value;el.innerHTML='<option value="">No project</option>'+releaseState.projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');if([...el.options].some(o=>o.value===old))el.value=old}}
async function loadReleaseConfig(){try{releaseState.config=await api('/api/config');const brand=document.querySelector('.brand-sub');if(brand)brand.textContent=`Private Intelligence Hub · v${releaseState.config.version}`;document.querySelectorAll('[class*="feature-v"]').forEach(el=>{const m=[...el.classList].map(x=>/^feature-v1(\d+)$/.exec(x)).find(Boolean);if(m&&featureLevel()<Number(m[1]))el.classList.add('feature-hidden')});document.querySelectorAll('[data-min-version]').forEach(el=>{if(featureLevel()<Number(el.dataset.minVersion))el.classList.add('feature-hidden')})}catch(e){console.warn(e)}}
function addReleaseNav(){const nav=document.querySelector('nav');if(!nav)return;const items=[['projects','▣','Projects',3],['knowledge','◫','Knowledge',3],['agents','◎','Agents',4],['automationStudio','⌘','Studio',4],['workbench','</>','Workbench',5],['actions','↗','Actions',6]];for(const [view,icon,label,min] of items){if(document.querySelector(`[data-view="${view}"]`))continue;const b=document.createElement('button');b.className='navbtn';b.dataset.view=view;b.dataset.minVersion=min;b.innerHTML=`<span class="navicon">${icon}</span>${label}`;b.addEventListener('click',()=>showView(view));nav.appendChild(b)}}
async function loadProjects(){if(featureLevel()<3)return;const j=await api('/api/projects');releaseState.projects=j.items||[];fillProjectSelects();const list=$('projectList');if(list)list.innerHTML=releaseState.projects.length?releaseState.projects.map(p=>`<button class="item-card" data-project="${esc(p.id)}"><strong>${esc(p.name)}</strong><small>${p.counts.conversations} conversations · ${p.counts.knowledge} sources · ${p.counts.artifacts} artifacts</small></button>`).join(''):'<div class="empty">Create your first project.</div>';const m=$('projectMetrics');if(m){const totals=releaseState.projects.reduce((a,p)=>{a.c+=p.counts.conversations;a.k+=p.counts.knowledge;a.a+=p.counts.artifacts;return a},{c:0,k:0,a:0});m.innerHTML=`<div class="metric"><b>${releaseState.projects.length}</b><span>Projects</span></div><div class="metric"><b>${totals.c}</b><span>Conversations</span></div><div class="metric"><b>${totals.k}</b><span>Knowledge sources</span></div><div class="metric"><b>${totals.a}</b><span>Artifacts</span></div>`}qsa('[data-project]').forEach(b=>b.onclick=()=>showProject(b.dataset.project))}
async function showProject(id){releaseState.selectedProject=id;const p=releaseState.projects.find(x=>x.id===id);if(!p)return;const [c,k]=await Promise.all([api('/api/conversations?projectId='+encodeURIComponent(id)),api('/api/knowledge?projectId='+encodeURIComponent(id))]);$('projectDetail').innerHTML=`<div class="section-head"><div><h2>${esc(p.name)}</h2><p>${esc(p.description||'Project workspace')}</p></div><span class="badge">${p.pinned?'Pinned':'Workspace'}</span></div><div class="two"><div><h3>Conversations</h3><div class="stack" style="margin-top:8px">${(c.items||[]).slice(0,8).map(x=>`<div class="item-card"><strong>${esc(x.title)}</strong><small>${ago(x.updatedAt)}</small></div>`).join('')||'<div class="empty">No conversations.</div>'}</div></div><div><h3>Knowledge</h3><div class="stack" style="margin-top:8px">${(k.items||[]).slice(0,8).map(x=>`<div class="item-card"><strong>${esc(x.name)}</strong><small>${Math.round((x.size||0)/1024)} KB</small></div>`).join('')||'<div class="empty">No sources.</div>'}</div></div></div>`}
async function newProject(){const name=prompt('Project name');if(!name)return;await post('/api/projects/create',{name});await loadProjects();toast('Project created')}
async function loadKnowledge(){if(featureLevel()<3)return;const j=await api('/api/knowledge');releaseState.knowledge=j.items||[];const el=$('knowledgeList');if(el)el.innerHTML=releaseState.knowledge.length?releaseState.knowledge.map(x=>`<div class="item-card"><strong>${esc(x.name)}</strong><small>${esc(releaseState.projects.find(p=>p.id===x.projectId)?.name||'Unassigned')} · ${Math.round((x.size||0)/1024)} KB</small></div>`).join(''):'<div class="empty">No knowledge indexed.</div>'}
async function importKnowledge(name,content,mime='text/plain'){await post('/api/knowledge/import',{name,content,mimeType:mime,projectId:$('knowledgeProject')?.value||''});await Promise.all([loadKnowledge(),loadProjects()]);toast('Knowledge indexed')}
async function searchKnowledge(){const q=$('knowledgeQuery').value.trim();if(!q)return;const j=await post('/api/knowledge/search',{query:q,projectId:$('knowledgeProject')?.value||''});$('knowledgeResults').innerHTML=(j.hits||[]).map(h=>`<div class="item-card"><strong>${esc(h.name)}</strong><small>score ${h.score}</small><div class="muted" style="margin-top:6px">${esc(h.text.slice(0,500))}</div></div>`).join('')||'<div class="empty">No matches.</div>'}
async function loadAgents(){if(featureLevel()<4)return;const j=await api('/api/agents');releaseState.agents=j.items||[];$('agentRuns').innerHTML=releaseState.agents.length?releaseState.agents.map(r=>`<button class="item-card" data-agent-id="${esc(r.id)}"><strong>${esc(r.goal)}</strong><small>${esc(r.status)} · ${ago(r.updatedAt||r.createdAt)}</small></button>`).join(''):'<div class="empty">No agent runs.</div>';qsa('[data-agent-id]').forEach(b=>b.onclick=()=>renderAgent(releaseState.agents.find(x=>x.id===b.dataset.agentId)))}
function renderAgent(r){if(!r)return;$('agentExecution').innerHTML=(r.plan||[]).map((s,i)=>`<div class="flow-step"><div class="flow-index">${i+1}</div><div><strong>${esc(s.name)}</strong>${s.error?`<small class="muted">${esc(s.error)}</small>`:''}</div><span class="statuschip ${esc(s.state||'pending')}">${esc(s.state||'pending')}</span></div>`).join('')+(r.answer?`<div class="preview-pane"><strong>Result</strong><div style="white-space:pre-wrap;margin-top:8px">${esc(r.answer)}</div></div>`:'')}
async function runAgent(){const goal=$('agentGoal').value.trim();if(!goal)return;const btn=$('agentRunBtn');btn.disabled=true;$('agentExecution').innerHTML='<div class="empty">Agent running…</div>';try{const j=await post('/api/agents/run',{goal,projectId:$('agentProject').value});renderAgent(j.run);await loadAgents();toast('Agent completed')}catch(e){toast(e.message)}finally{btn.disabled=false}}
async function loadAutomations(){if(featureLevel()<4)return;const j=await api('/api/automations');releaseState.automations=j.items||[];$('automationList').innerHTML=releaseState.automations.length?releaseState.automations.map(a=>`<div class="item-card"><div class="statusline"><strong style="flex:1">${esc(a.name)}</strong><span class="statuschip">${esc(a.schedule)}</span></div><small>${esc(a.kind)}${a.nextRunAt?' · next '+ago(a.nextRunAt):''}</small><div class="actions" style="margin-top:8px"><button class="btn" data-auto-run="${esc(a.id)}">Run now</button><button class="btn" data-auto-toggle="${esc(a.id)}">${a.enabled?'Disable':'Enable'}</button></div></div>`).join(''):'<div class="empty">No automations.</div>';$('automationRuns').innerHTML=(j.runs||[]).slice(0,12).map(r=>`<div class="item-card"><strong>${esc(r.name)}</strong><small>${esc(r.status)} · ${ago(r.finishedAt||r.startedAt)}</small>${r.output?`<div class="muted" style="margin-top:6px">${esc(r.output.slice(0,500))}</div>`:''}</div>`).join('')||'<div class="empty">No runs yet.</div>';qsa('[data-auto-run]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await post('/api/automations/run',{id:b.dataset.autoRun});await loadAutomations()}finally{b.disabled=false}});qsa('[data-auto-toggle]').forEach(b=>b.onclick=async()=>{const a=releaseState.automations.find(x=>x.id===b.dataset.autoToggle);await post('/api/automations/update',{id:a.id,enabled:!a.enabled});await loadAutomations()})}
async function createAutomation(){await post('/api/automations/create',{name:$('autoName').value,kind:$('autoKind').value,schedule:$('autoSchedule').value,prompt:$('autoPrompt').value});$('autoName').value='';$('autoPrompt').value='';await loadAutomations();toast('Automation created')}
function renderTree(items){return (items||[]).map(i=>i.type==='directory'?`<div class="item-card"><strong>▸ ${esc(i.name)}</strong><small>${esc(i.path)}</small>${i.children?.length?`<div style="padding-left:10px;margin-top:6px">${renderTree(i.children)}</div>`:''}</div>`:`<button class="item-card" data-file-path="${esc(i.path)}"><strong>${esc(i.name)}</strong><small>${esc(i.path)}</small></button>`).join('')}
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
async function initReleaseFeatures(){addReleaseNav();await loadReleaseConfig();bindReleaseEvents();if(featureLevel()>=3)await Promise.all([loadProjects(),loadKnowledge()]);if(featureLevel()>=4)await Promise.all([loadAgents(),loadAutomations()]);if(featureLevel()>=5)await loadWorkbench()}
window.addEventListener('DOMContentLoaded',()=>initReleaseFeatures().catch(e=>console.warn('release features',e)));
// ===== end cumulative release client ========================================


// ===== product evolution client (v1.7+) =====================================
const evo={notifications:[],memory:[],approvals:[],monitors:[],changes:[],selectedChange:'',quality:null,issues:[],engineeringRuns:[],selectedEngineeringRun:'',powerShellJobs:[],selectedPowerShellJob:''};
function groupNavigation(){
  const nav=document.querySelector('nav');if(!nav||nav.dataset.grouped==='1')return;
  const buttons=[...nav.querySelectorAll('.navbtn')];const byView=new Map(buttons.map(b=>[b.dataset.view,b]));
  const groups=[
    ['HOME',['home']],
    ['ASSISTANT',['ask','create']],
    ['WORKSPACE',['projects','library','knowledge','memory']],
    ['AUTOMATION',['agents','automations','automationStudio','actions']],
    ['ENGINEERING',['workbench','repoTools','engineering','powershell']],
    ['OPERATIONS',['changes','approvals','quality','issues','status','operations','inbox']],
    ['HISTORY',['activity']]
  ];
  nav.replaceChildren();
  for(const [label,views] of groups){const present=views.map(v=>byView.get(v)).filter(Boolean);if(!present.length)continue;const section=document.createElement('div');section.className='nav-group';const title=document.createElement('div');title.className='nav-group-title';title.textContent=label;section.appendChild(title);present.forEach(b=>section.appendChild(b));nav.appendChild(section)}
  const known=new Set(groups.flatMap(x=>x[1]));const extra=buttons.filter(b=>!known.has(b.dataset.view));if(extra.length){const section=document.createElement('div');section.className='nav-group';section.innerHTML='<div class="nav-group-title">MORE</div>';extra.forEach(b=>section.appendChild(b));nav.appendChild(section)}
  nav.dataset.grouped='1';
}

function evoNav(){
  const nav=document.querySelector('nav'); if(!nav)return;
  const items=[
    [7,'inbox','Inbox','!'],[8,'memory','Memory','M'],[9,'approvals','Approvals','✓'],[10,'repoTools','Repo tools','⌘'],[11,'operations','Operations','◉'],[13,'changes','Changes','Δ'],[14,'quality','Quality','Q'],[15,'issues','Issues','!'],[16,'engineering','Engineer','E'],[17,'powershell','PowerShell','PS']
  ];
  for(const [lvl,id,label,icon] of items){if(featureLevel()<lvl||document.querySelector(`[data-view="${id}"]`))continue;const b=document.createElement('button');b.className='navbtn';b.dataset.view=id;b.innerHTML=`<span class="navicon">${icon}</span>${label}`;b.onclick=()=>showView(id);nav.appendChild(b)}
}
async function evoApi(url,opts){const r=await fetch(url,opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);return j}
async function evoPost(url,body){return evoApi(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
async function loadInbox(){if(featureLevel()<7)return;const j=await evoApi('/api/notifications');evo.notifications=j.items||[];$('inboxUnread').textContent=`${j.unread||0} unread`;$('inboxList').innerHTML=evo.notifications.length?evo.notifications.map(n=>`<div class="item-card"><div class="statusline"><strong style="flex:1">${esc(n.title)}</strong><span class="statuschip">${n.resolved?'resolved':n.read?'read':'new'}</span></div><small>${esc(n.kind)} · ${ago(n.createdAt)}</small><div class="muted" style="margin-top:6px">${esc(n.detail||'')}</div><div class="actions" style="margin-top:8px">${!n.read?`<button class="btn" data-note-read="${esc(n.id)}">Mark read</button>`:''}${!n.resolved?`<button class="btn" data-note-resolve="${esc(n.id)}">Resolve</button>`:''}</div></div>`).join(''):'<div class="empty">Inbox is clear.</div>';qsa('[data-note-read]').forEach(b=>b.onclick=async()=>{await evoPost('/api/notifications/update',{id:b.dataset.noteRead,read:true});loadInbox()});qsa('[data-note-resolve]').forEach(b=>b.onclick=async()=>{await evoPost('/api/notifications/update',{id:b.dataset.noteResolve,resolved:true,read:true});loadInbox()})}
async function syncMemoryProjects(){if(featureLevel()<8)return;const p=releaseState.projects?.length?releaseState.projects:(await evoApi('/api/projects')).items||[];const sel=$('memoryProject');if(sel)sel.innerHTML=p.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');}
async function loadMemory(){if(featureLevel()<8)return;await syncMemoryProjects();const pid=$('memoryProject')?.value||'';const j=await evoApi('/api/memory?projectId='+encodeURIComponent(pid));evo.memory=j.items||[];$('memoryList').innerHTML=evo.memory.length?evo.memory.map(m=>`<div class="memory-card"><strong>${esc(m.category)}</strong><div style="margin-top:5px">${esc(m.text)}</div><div class="actions" style="margin-top:8px"><button class="btn" data-mem-pin="${esc(m.id)}">${m.pinned?'Unpin':'Pin'}</button><button class="btn danger" data-mem-del="${esc(m.id)}">Delete</button></div></div>`).join(''):'<div class="empty">No project memory yet.</div>';if(pid){try{const intel=await evoApi('/api/projects/intelligence?projectId='+encodeURIComponent(pid));$('projectIntel').innerHTML=`<div class="home-insight"><div class="card"><b>${intel.summary.knowledge}</b><span>knowledge sources</span></div><div class="card"><b>${intel.summary.conversations}</b><span>conversations</span></div><div class="card"><b>${intel.summary.pinnedMemory}</b><span>pinned memories</span></div></div>`}catch{}}qsa('[data-mem-pin]').forEach(b=>b.onclick=async()=>{const m=evo.memory.find(x=>x.id===b.dataset.memPin);await evoPost('/api/memory/update',{id:m.id,pinned:!m.pinned});loadMemory()});qsa('[data-mem-del]').forEach(b=>b.onclick=async()=>{await evoPost('/api/memory/delete',{id:b.dataset.memDel});loadMemory()})}
async function addMemory(){const text=$('memoryText').value.trim();if(!text)return;await evoPost('/api/memory/add',{projectId:$('memoryProject').value,category:$('memoryCategory').value,text});$('memoryText').value='';await loadMemory();toast('Memory saved')}
async function loadApprovals(){if(featureLevel()<9)return;const j=await evoApi('/api/approvals');evo.approvals=j.items||[];const pending=evo.approvals.filter(x=>x.status==='pending').length;$('approvalCount').textContent=`${pending} pending`;$('approvalList').innerHTML=evo.approvals.length?evo.approvals.map(a=>`<div class="approval-card ${esc(a.status)}"><div class="statusline"><strong style="flex:1">${esc(a.title)}</strong><span class="statuschip">${esc(a.risk)} · ${esc(a.status)}</span></div><div class="muted" style="margin-top:6px">${esc(a.detail)}</div>${a.status==='pending'?`<div class="actions" style="margin-top:8px"><button class="btn primary" data-app-ok="${esc(a.id)}">Approve</button><button class="btn danger" data-app-no="${esc(a.id)}">Reject</button></div>`:''}</div>`).join(''):'<div class="empty">No approvals.</div>';qsa('[data-app-ok]').forEach(b=>b.onclick=()=>decideApproval(b.dataset.appOk,'approved'));qsa('[data-app-no]').forEach(b=>b.onclick=()=>decideApproval(b.dataset.appNo,'rejected'))}
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
async function planChange(){const request=$('changeRequest').value.trim();if(!request)return;const target=$('changeTarget').value,root=$('changeRoot').value.trim();const btn=$('changePlanBtn');btn.disabled=true;$('changePlannerStatus').textContent='Analyzing source and generating a constrained patch plan…';try{const j=await evoPost('/api/changes/plan',{request,target,root});$('changePlannerStatus').textContent=j.item.files?.length?`Plan created: ${j.item.files.length} file(s).`:`Plan needs more context: ${j.item.notes||'No patch operations produced.'}`;await loadChanges(j.item.id);toast('Change plan created')}catch(e){$('changePlannerStatus').textContent=`Error: ${e.message}`;toast(e.message)}finally{btn.disabled=false}}
async function stageChange(id){$('changePlannerStatus').textContent='Staging and validating change…';try{const j=await evoPost('/api/changes/stage',{id});$('changePlannerStatus').textContent=j.item.validation?.passed?'Staging validation passed. Approval required.':'Validation failed; inspect the checks and revise.';await Promise.all([loadChanges(id),loadApprovals(),loadInbox()])}catch(e){$('changePlannerStatus').textContent=`Error: ${e.message}`;toast(e.message)}}
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


function renderEngineeringRun(run){if(!run){$('engineeringExecution').innerHTML='<div class="empty">No run selected.</div>';return}$('engineeringState').textContent=run.status;$('engineeringExecution').innerHTML=(run.steps||[]).map(x=>`<div class="item-card"><div class="statusline"><strong style="flex:1">${esc(x.name)}</strong><span class="statuschip">${esc(x.state)}</span></div>${x.detail?`<div class="meta" style="margin-top:6px;white-space:pre-wrap">${esc(x.detail)}</div>`:''}</div>`).join('')||'<div class="empty">No steps recorded.</div>';if(run.finalChangeId)$('engineeringExecution').innerHTML+=`<div class="actions" style="margin-top:10px"><button class="btn primary" data-eng-change="${esc(run.finalChangeId)}">Review validated change</button></div>`;qsa('[data-eng-change]').forEach(b=>b.onclick=async()=>{showView('changes');await loadChanges(b.dataset.engChange)})}
async function loadEngineeringRuns(selectId=''){if(featureLevel()<16)return;const j=await evoApi('/api/engineering/runs');evo.engineeringRuns=j.items||[];$('engineeringRuns').innerHTML=evo.engineeringRuns.length?evo.engineeringRuns.map(r=>`<button class="item-card" data-eng-run="${esc(r.id)}"><div class="statusline"><strong style="flex:1">${esc(r.request)}</strong><span class="statuschip">${esc(r.status)}</span></div><small>${esc(r.target)} · attempt ${r.attempt||0}/${r.maxAttempts||0} · ${ago(r.updatedAt||r.createdAt)}</small></button>`).join(''):'<div class="empty">No engineering runs yet.</div>';qsa('[data-eng-run]').forEach(b=>b.onclick=()=>{evo.selectedEngineeringRun=b.dataset.engRun;renderEngineeringRun(evo.engineeringRuns.find(x=>x.id===b.dataset.engRun))});const id=selectId||evo.selectedEngineeringRun;if(id)renderEngineeringRun(evo.engineeringRuns.find(x=>x.id===id));else if(evo.engineeringRuns[0])renderEngineeringRun(evo.engineeringRuns[0])}
async function runEngineeringAgent(){const request=$('engineeringRequest').value.trim();if(!request)return;const btn=$('engineeringRunBtn');btn.disabled=true;$('engineeringState').textContent='running';$('engineeringStatus').textContent='Planning, staging, validating, and repairing within the configured bound…';try{const j=await evoPost('/api/engineering/run',{request,target:$('engineeringTarget').value,root:$('engineeringRoot').value.trim(),maxAttempts:Number($('engineeringAttempts').value)});$('engineeringStatus').textContent=j.run.status==='awaiting_approval'?`Validated after ${j.run.attempt} attempt(s). Human approval required.`:j.run.error||j.run.status;await Promise.all([loadEngineeringRuns(j.run.id),loadChanges(j.run.finalChangeId||''),loadApprovals(),loadInbox()]);toast(j.run.status==='awaiting_approval'?'Engineering patch ready for approval':'Engineering run needs attention')}catch(e){$('engineeringStatus').textContent=`Error: ${e.message}`;toast(e.message)}finally{btn.disabled=false}}


function powerShellUiToken(){return sessionStorage.getItem('localAiPowerShellUiToken')||''}
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
  }catch(e){$('powershellBridge').textContent='localhost only';$('powershellStatus').textContent=`PowerShell Workbench unavailable: ${e.message}`}
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
async function signPowerShellJob(job){if(!window.crypto?.subtle)throw new Error('Signing needs a secure context; open the Workbench at http://localhost:3080');let key=sessionStorage.getItem('localAiPowerShellApprovalKey')||'';if(!key){key=(prompt('Approval key (C:\\LocalAI\\powershell-bridge\\approval-key.txt):')||'').trim();if(!key)throw new Error('Approval key is required to queue a job');sessionStorage.setItem('localAiPowerShellApprovalKey',key)}const enc=new TextEncoder();const k=await crypto.subtle.importKey('raw',enc.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);const msg=`localai-ps-v1\n${job.id}\n${job.cwd}\n${job.timeoutSec}\n${job.script}`;const sig=await crypto.subtle.sign('HMAC',k,enc.encode(msg));return [...new Uint8Array(sig)].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function queuePowerShellJob(id){const confirmation=prompt('Type RUN to queue this approved PowerShell script on the Windows host.');if(confirmation!=='RUN')return;try{const job=(evo.powerShellJobs||[]).find(x=>x.id===id);if(!job)throw new Error('PowerShell job not found; refresh and try again');const signature=await signPowerShellJob(job);await powerShellPost('/api/powershell/request-run',{id,confirmation,signature});await loadPowerShellJobs(id);$('powershellStatus').textContent='Queued. The local Windows host bridge normally claims the job within one minute.';toast('PowerShell job queued')}catch(e){toast(e.message)}}
async function cancelPowerShellJob(id){try{await powerShellPost('/api/powershell/cancel',{id});await loadPowerShellJobs(id);toast('PowerShell job cancelled')}catch(e){toast(e.message)}}

function commandPalette(){
  const el=$('cmdk');if(!el)return;
  const actions=[['Home','home'],['Ask','ask'],['Create','create'],['Projects','projects'],['Library','library'],['Knowledge','knowledge'],['Memory','memory'],['Agents','agents'],['Automations','automations'],['Studio','automationStudio'],['Actions','actions'],['Workbench','workbench'],['Repo tools','repoTools'],['Engineer','engineering'],['PowerShell','powershell'],['Changes','changes'],['Approvals','approvals'],['Quality','quality'],['Issues','issues'],['Status','status'],['Models','models'],['Operations','operations'],['Runs','runs'],['Activity','activity'],['Inbox','inbox']];
  const render=()=>{const q=$('cmdkInput').value.toLowerCase();$('cmdkList').innerHTML=actions.filter(([label,id])=>$(id)&&label.toLowerCase().includes(q)).map(([label,id])=>`<button class="cmdk-item" data-cmd-view="${id}">${label}</button>`).join('');qsa('[data-cmd-view]').forEach(b=>b.onclick=()=>{el.classList.remove('show');showView(b.dataset.cmdView)})};
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();el.classList.add('show');$('cmdkInput').value='';render();$('cmdkInput').focus()}if(e.key==='Escape')el.classList.remove('show')});$('cmdkInput').addEventListener('input',render);el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('show')});render();
}
async function bindEvo(){
  if(!releaseState.config) await loadReleaseConfig();
  evoNav();groupNavigation();commandPalette();
  $('memoryAddBtn')?.addEventListener('click',addMemory);$('memoryProject')?.addEventListener('change',loadMemory);
  $('repoInspectBtn')?.addEventListener('click',inspectRepo);$('commandRunBtn')?.addEventListener('click',runWorkbenchCommand);
  $('monitorCreateBtn')?.addEventListener('click',createMonitor);$('briefBtn')?.addEventListener('click',generateBrief);
  $('changeTarget')?.addEventListener('change',()=>{$('changeRoot').disabled=$('changeTarget').value==='self'});$('changePlanBtn')?.addEventListener('click',planChange);$('changeRefreshBtn')?.addEventListener('click',()=>loadChanges());$('qualityScanBtn')?.addEventListener('click',runQualityScanClient);$('issueScanBtn')?.addEventListener('click',scanIssues);$('engineeringTarget')?.addEventListener('change',()=>{$('engineeringRoot').disabled=$('engineeringTarget').value==='self'});$('engineeringRunBtn')?.addEventListener('click',runEngineeringAgent);$('powershellUnlockBtn')?.addEventListener('click',unlockPowerShell);$('powershellCreateBtn')?.addEventListener('click',createPowerShellJob);$('powershellRefreshBtn')?.addEventListener('click',()=>loadPowerShellJobs());
  const oldShow=showView;window.showView=showView;
  document.querySelectorAll('.navbtn').forEach(b=>{if(['inbox','memory','approvals','repoTools','operations','changes','quality','issues','engineering','powershell'].includes(b.dataset.view))b.onclick=()=>{oldShow(b.dataset.view);if(b.dataset.view==='inbox')loadInbox();if(b.dataset.view==='memory')loadMemory();if(b.dataset.view==='approvals')loadApprovals();if(b.dataset.view==='operations')loadMonitors();if(b.dataset.view==='changes')loadChanges();if(b.dataset.view==='quality')loadQuality();if(b.dataset.view==='issues')loadIssues();if(b.dataset.view==='engineering')loadEngineeringRuns();if(b.dataset.view==='powershell')loadPowerShellJobs();}});
  if(featureLevel()>=7)loadInbox().catch(()=>{});if(featureLevel()>=13)loadChanges().catch(()=>{});if(featureLevel()>=14)loadQuality().catch(()=>{});if(featureLevel()>=15)loadIssues().catch(()=>{});if(featureLevel()>=16)loadEngineeringRuns().catch(()=>{});if(featureLevel()>=17)loadPowerShellJobs().catch(()=>{});
}
window.addEventListener('DOMContentLoaded',()=>bindEvo().catch(e=>console.warn('evolution features',e)));
// ===== end product evolution client ==========================================

$('statusRetryBtn')?.addEventListener('click',()=>refreshStatus(true));
