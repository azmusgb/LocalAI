(()=>{'use strict';
const W=1280,H=760,T=32,COLS=Math.floor(W/T),ROWS=Math.floor(H/T);
const $=(s,r=document)=>r.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n)),key=(x,y)=>x+','+y,now=()=>performance.now();

const DISTRICTS={
 command:{name:'Command Center',short:'Command',x:17,y:9,w:6,h:5,accent:'#71b7ff',roof:'#315f94',icon:'⌂',kind:'hq'},
 ux:{name:'UX Lab',short:'UX',x:4,y:4,w:6,h:4,accent:'#59e2ed',roof:'#197d8b',icon:'UX',kind:'lab'},
 docs:{name:'Documentation Studio',short:'Docs',x:29,y:4,w:6,h:4,accent:'#c498ff',roof:'#73509b',icon:'D',kind:'studio'},
 engineering:{name:'Engineering Bay',short:'Build',x:4,y:17,w:7,h:5,accent:'#ffb86a',roof:'#975c24',icon:'E',kind:'bay'},
 validation:{name:'Validation Lab',short:'Validate',x:29,y:17,w:6,h:5,accent:'#75dfa2',roof:'#347650',icon:'V',kind:'lab'},
 models:{name:'Model Foundry',short:'Models',x:16,y:19,w:8,h:4,accent:'#ff8494',roof:'#8e3747',icon:'M',kind:'foundry'},
 projects:{name:'Projects Quarter',short:'Projects',x:15,y:2,w:10,h:4,accent:'#8db7ff',roof:'#405f95',icon:'P',kind:'archive'},
 repair:{name:'Repair Bay',short:'Repair',x:32,y:10,w:5,h:4,accent:'#ff7383',roof:'#8c3542',icon:'!',kind:'repair'}
};
const ROLE_ZONE={router:'command',mission_router:'command',ux_analyst:'ux',documentation:'docs',synthesis:'command',coordinator:'command',engineer:'engineering',validator:'validation',reviewer:'command',deployer:'engineering',operator:'validation',code_analyst:'engineering',test_engineer:'validation',research_agent:'projects',security_reviewer:'validation',performance_analyst:'models'};
const ROLE_COLOR={router:'#71b7ff',mission_router:'#71b7ff',ux_analyst:'#59e2ed',documentation:'#c498ff',synthesis:'#a8b5ff',coordinator:'#a8b5ff',engineer:'#ffb86a',validator:'#75dfa2',reviewer:'#c498ff',deployer:'#ffb86a',operator:'#75dfa2',code_analyst:'#ffb86a',test_engineer:'#75dfa2',research_agent:'#8db7ff',security_reviewer:'#ff8494',performance_analyst:'#ff8494'};
const ROLE_STYLE={
 router:{skin:'#d9a77f',hair:'#2a211e',shirt:'#d9792c',vest:'#ff9d33',pants:'#6b4a2f',accent:'#71b7ff',tool:'headset',hat:'#f2bf3e',badge:'R'},
 mission_router:{skin:'#d9a77f',hair:'#2a211e',shirt:'#d9792c',vest:'#ff9d33',pants:'#6b4a2f',accent:'#71b7ff',tool:'headset',hat:'#f2bf3e',badge:'R'},
 ux_analyst:{skin:'#e6b98d',hair:'#6c3f35',shirt:'#d87e30',vest:'#ffa43b',pants:'#6e4d32',accent:'#59e2ed',tool:'tablet',hat:'#f6c548',badge:'UX'},
 documentation:{skin:'#c99572',hair:'#332522',shirt:'#c9712c',vest:'#ff9d33',pants:'#60452f',accent:'#c498ff',tool:'clipboard',hat:'#f3bd3d',badge:'D'},
 synthesis:{skin:'#e1b58f',hair:'#3d3340',shirt:'#db7d2d',vest:'#ffa43b',pants:'#655039',accent:'#a8b5ff',tool:'holo',hat:'#f4c64a',badge:'C'},
 coordinator:{skin:'#e1b58f',hair:'#3d3340',shirt:'#db7d2d',vest:'#ffa43b',pants:'#655039',accent:'#a8b5ff',tool:'holo',hat:'#f4c64a',badge:'C'},
 engineer:{skin:'#d7a07a',hair:'#402d23',shirt:'#cf6e24',vest:'#ff942b',pants:'#60452e',accent:'#ffb86a',tool:'wrench',hat:'#ffc640',badge:'E'},
 validator:{skin:'#ebc09b',hair:'#302925',shirt:'#d87b2e',vest:'#ffa43b',pants:'#66513a',accent:'#75dfa2',tool:'scanner',hat:'#f5c64b',badge:'V'},
 reviewer:{skin:'#bd8968',hair:'#262329',shirt:'#c96f2b',vest:'#ff9b31',pants:'#594331',accent:'#c498ff',tool:'clipboard',hat:'#efb93c',badge:'RV'},
 deployer:{skin:'#dba47e',hair:'#3a2a21',shirt:'#cf7026',vest:'#ff962c',pants:'#60472f',accent:'#ffb86a',tool:'crate',hat:'#ffc640',badge:'DP'},
 operator:{skin:'#d0a47f',hair:'#242b2f',shirt:'#d4782a',vest:'#ffa036',pants:'#63503b',accent:'#75dfa2',tool:'radio',hat:'#f4c448',badge:'OP'}
,
 code_analyst:{skin:'#d8aa83',hair:'#2b2422',shirt:'#c96e2b',vest:'#ff9a31',pants:'#594632',accent:'#ffb86a',tool:'tablet',hat:'#f2bd3d',badge:'CA'},
 test_engineer:{skin:'#e4b58b',hair:'#342923',shirt:'#cf762d',vest:'#ffa43b',pants:'#5e4b35',accent:'#75dfa2',tool:'scanner',hat:'#f5c64b',badge:'TE'},
 research_agent:{skin:'#c99673',hair:'#392a27',shirt:'#d1782c',vest:'#ff9d33',pants:'#5e4933',accent:'#8db7ff',tool:'clipboard',hat:'#f0bd42',badge:'RS'},
 security_reviewer:{skin:'#d9a67f',hair:'#28242b',shirt:'#c86c2c',vest:'#ff9632',pants:'#594331',accent:'#ff8494',tool:'scanner',hat:'#efb93c',badge:'SC'},
 performance_analyst:{skin:'#e0b38c',hair:'#342b2a',shirt:'#d2762d',vest:'#ffa23a',pants:'#604b36',accent:'#ff8494',tool:'holo',hat:'#f3c247',badge:'PF'}
}
const DEMO_STAGES=[
 {label:'Router planning',detail:'Matching capabilities, dependencies and models',states:{router:'running',ux_analyst:'pending',documentation:'pending',synthesis:'pending'}},
 {label:'UX analysis',detail:'UX Analyst is working in the Interface Lab',states:{router:'complete',ux_analyst:'running',documentation:'pending',synthesis:'pending'}},
 {label:'Documentation',detail:'Grounded findings are handed to Documentation',states:{router:'complete',ux_analyst:'complete',documentation:'running',synthesis:'pending'}},
 {label:'Synthesis',detail:'Coordinator is assembling the final mission result',states:{router:'complete',ux_analyst:'complete',documentation:'complete',synthesis:'running'}},
 {label:'Complete',detail:'Mission artifacts are ready',states:{router:'complete',ux_analyst:'complete',documentation:'complete',synthesis:'complete'}}
];

let root,canvas,ctx,current=null,liveSnapshot=null,sourceType='idle',selected=null,hovered=null,raf=0,last=0;
let roads=new Set(),agents=new Map(),artifacts=[],packets=[],traffic=[],sparks=[],dust=[],events=[],clouds=[];
let view={zoom:1,panX:0,panY:0,targetZoom:1,targetPanX:0,targetPanY:0};
let drag=null,pointers=new Map(),pinch=null,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
let display={labels:true,flows:true,night:false,crew:true,follow:false};
let demo={active:false,running:false,paused:false,stage:0,speed:1,lastAdvance:0,scenario:'success'};
const REPLAY_KEY='localai.agentworld.replay.v1';
let replay={frames:[],active:false,index:0,playing:false,lastStep:0};

function humanState(s){return({needs_attention:'Needs attention',running:'Running',complete:'Complete',blocked:'Blocked',error:'Needs attention',pending:'Waiting',awaiting_approval:'Awaiting approval',applied:'Applied'})[s]||String(s||'Idle').replaceAll('_',' ')}
function zoneForWorker(w){if(['error','blocked'].includes(w.state))return'repair';return ROLE_ZONE[w.id]||ROLE_ZONE[w.agentId]||(/doc/i.test(w.name||'')?'docs':/ux/i.test(w.name||'')?'ux':/model/i.test(w.name||'')?'models':'command')}
function districtCenter(id){const d=DISTRICTS[id]||DISTRICTS.command;return{x:(d.x+d.w/2)*T,y:(d.y+d.h+.8)*T}}
function workerTarget(w,zone){
 const base=districtCenter(zone),workers=(current?.workers||[]).filter(q=>zoneForWorker(q)===zone),id=w.id||w.agentId||w.name,idx=Math.max(0,workers.findIndex(q=>(q.id||q.agentId||q.name)===id));
 const slots=[[-34,-2],[34,-2],[-62,22],[62,22],[0,30],[-30,48],[30,48]],slot=slots[idx%slots.length];
 return{x:base.x+slot[0],y:base.y+slot[1]}
}
function routeToTarget(from,target){const path=astar(from,target);if(!path.length||Math.hypot(path[path.length-1].x-target.x,path[path.length-1].y-target.y)>3)path.push({x:target.x,y:target.y});return path}
function road(x,y){roads.add(key(x,y))}
function buildRoads(){
 roads.clear();
 for(let x=2;x<COLS-2;x++){road(x,13);road(x,14)}
 for(let y=2;y<ROWS-1;y++){road(13,y);road(14,y);road(25,y);road(26,y)}
 for(let x=3;x<37;x++){road(x,9);road(x,23)}
 for(let y=4;y<23;y++){road(3,y);road(36,y)}
 for(let x=14;x<=25;x++){road(x,17);road(x,18)}
}
function blocked(x,y){
 if(x<1||y<1||x>=COLS-1||y>=ROWS-1)return true;
 for(const d of Object.values(DISTRICTS))if(x>=d.x-1&&x<d.x+d.w+1&&y>=d.y-1&&y<d.y+d.h+1)return true;
 return!roads.has(key(x,y))
}
function nearestRoad(pt){let best={x:14,y:14},bd=Infinity;for(const k of roads){const[x,y]=k.split(',').map(Number),px=(x+.5)*T,py=(y+.5)*T,d=(px-pt.x)**2+(py-pt.y)**2;if(d<bd){bd=d;best={x,y}}}return best}
function astar(a,b){
 const start=nearestRoad(a),goal=nearestRoad(b),open=[start],came=new Map(),g=new Map([[key(start.x,start.y),0]]),f=new Map([[key(start.x,start.y),Math.abs(start.x-goal.x)+Math.abs(start.y-goal.y)]]);
 while(open.length){open.sort((u,v)=>(f.get(key(u.x,u.y))??1e9)-(f.get(key(v.x,v.y))??1e9));const cur=open.shift();
  if(cur.x===goal.x&&cur.y===goal.y){const path=[];let p=cur,k=key(p.x,p.y);while(p){path.unshift({x:(p.x+.5)*T,y:(p.y+.5)*T});const prev=came.get(k);p=prev;k=prev?key(prev.x,prev.y):''}return path}
  for(const n of[{x:cur.x+1,y:cur.y},{x:cur.x-1,y:cur.y},{x:cur.x,y:cur.y+1},{x:cur.x,y:cur.y-1}]){if(blocked(n.x,n.y)&&!(n.x===goal.x&&n.y===goal.y))continue;const nk=key(n.x,n.y),tent=(g.get(key(cur.x,cur.y))||0)+1;if(tent<(g.get(nk)??1e9)){came.set(nk,cur);g.set(nk,tent);f.set(nk,tent+Math.abs(n.x-goal.x)+Math.abs(n.y-goal.y));if(!open.some(o=>o.x===n.x&&o.y===n.y))open.push(n)}}}
 return[]
}
function normalizeMission(m){return{type:'mission',id:m.id,status:m.status,goal:m.goal||'Mission',updatedAt:m.updatedAt||m.createdAt,workers:(m.workers||[]).map(w=>({...w,id:w.id||w.agentId})),error:m.error||'',raw:m}}
function ensureAgent(w){
 const id=w.id||w.agentId||w.name;if(!id)return;
 let a=agents.get(id),zone=zoneForWorker(w),target=workerTarget(w,zone);
 if(!a){const p=districtCenter('command'),style=ROLE_STYLE[id]||ROLE_STYLE[(w.agentId||'')]||ROLE_STYLE.synthesis;a={id,name:w.name||id,glyph:(w.name||id).trim()[0]?.toUpperCase()||'A',x:p.x,y:p.y,tx:p.x,ty:p.y,path:[],pathI:0,state:'pending',zone:'command',targetZone:zone,color:ROLE_COLOR[id]||'#8fb5e8',model:w.model||'',dir:1,bob:Math.random()*Math.PI*2,step:Math.random()*Math.PI*2,style,activitySeed:Math.random()*10};agents.set(id,a)}
 const old=a.state;a.name=w.name||a.name;a.model=w.model||a.model;a.state=w.state||a.state;a.targetZone=zone;a.color=ROLE_COLOR[id]||a.color;
 if(a.zone!==zone||Math.hypot(a.tx-target.x,a.ty-target.y)>2){a.tx=target.x;a.ty=target.y;a.path=routeToTarget({x:a.x,y:a.y},target);a.pathI=0;a.zone=zone}
 if(old!==a.state){
  addEvent(a.name+' → '+humanState(a.state));
  if(a.state==='running'){spawnPacket('models',zone,a.color,'MODEL');spawnSpark(target.x,target.y,a.color,18)}
  if(a.state==='complete'){
   spawnArtifact(a);spawnSpark(target.x,target.y,'#75dfa2',26);
   for(const next of current?.workers||[])if((next.dependsOn||[]).includes(id))spawnPacket(zone,zoneForWorker(next),a.color,'HANDOFF')
  }
  if(['error','blocked'].includes(a.state))spawnSpark(target.x,target.y,'#ff7383',36)
 }
}
function spawnArtifact(a){if(artifacts.some(x=>x.workerId===a.id))return;const p=districtCenter(a.zone),kind=['engineer','code_analyst','deployer'].includes(a.id)?'build':['validator','test_engineer','security_reviewer'].includes(a.id)?'certificate':['documentation','research_agent','ux_analyst'].includes(a.id)?'document':'node';artifacts.push({workerId:a.id,label:a.name,kind,x:p.x+26,y:p.y-14,color:a.color,created:now()})}
function spawnPacket(from,to,color,label='EVIDENCE'){const p=astar(districtCenter(from),districtCenter(to));if(p.length)packets.push({path:p,i:0,x:p[0].x,y:p[0].y,color,label,done:false,created:now()})}
function spawnSpark(x,y,color,n=12){for(let i=0;i<n;i++)sparks.push({x,y,vx:(Math.random()-.5)*80,vy:-20-Math.random()*80,life:.7+Math.random()*.7,color,size:1+Math.random()*2})}
function addEvent(text){events.unshift({text,at:new Date()});events=events.slice(0,12);syncEventFeed()}
function loadReplay(){try{const saved=JSON.parse(localStorage.getItem(REPLAY_KEY)||'[]');if(Array.isArray(saved)){replay.frames=saved.slice(-80);replay.index=Math.max(0,replay.frames.length-1)}}catch{}}
function persistReplay(){try{localStorage.setItem(REPLAY_KEY,JSON.stringify(replay.frames.slice(-80)))}catch{}}
function recordReplayFrame(reason){
 if(replay.active||!current)return;const sig=(current.workers||[]).map(w=>w.id+':'+w.state).join('|');const last=replay.frames.at(-1);if(last?.sig===sig)return;
 replay.frames.push({at:Date.now(),reason,sig,mission:JSON.parse(JSON.stringify(current))});replay.frames=replay.frames.slice(-80);replay.index=replay.frames.length-1;persistReplay();syncReplay()
}
function syncReplay(){
 if(!root)return;const range=$('#awcReplayRange',root),label=$('#awcReplayLabel',root);if(range){range.max=Math.max(0,replay.frames.length-1);range.value=replay.index;range.disabled=replay.frames.length<2}
 if(label)label.textContent=replay.active?'Replay '+(replay.index+1)+' / '+replay.frames.length:replay.frames.length+' checkpoint'+(replay.frames.length===1?'':'s');
 $('#awcReplayPlay',root).textContent=replay.playing?'Pause replay':'Replay';$('#awcReplayLive',root).hidden=!replay.active
}
function applyReplayFrame(i){
 if(!replay.frames.length)return;replay.active=true;replay.playing=false;replay.index=clamp(Number(i)||0,0,replay.frames.length-1);const frame=replay.frames[replay.index];agents.clear();artifacts=[];packets=[];current=JSON.parse(JSON.stringify(frame.mission));sourceType='replay';current.workers.forEach(ensureAgent);syncHud();syncReplay()
}
function toggleReplay(){if(replay.frames.length<2)return;if(!replay.active)applyReplayFrame(0);replay.playing=!replay.playing;replay.lastStep=now();syncReplay()}
function returnReplayLive(){replay.active=false;replay.playing=false;if(liveSnapshot){agents.clear();current=liveSnapshot;sourceType='mission';current.workers.forEach(ensureAgent)}syncHud();syncReplay()}
function applyMission(m){
 if(!m||demo.active)return;const prev=current,next=normalizeMission(m);if(!prev||prev.id!==next.id){agents.clear();artifacts=[];packets=[];sparks=[]}current=next;liveSnapshot=next;sourceType='mission';current.workers.forEach(ensureAgent);if(!prev||prev.id!==current.id)addEvent('Mission entered Agent World');recordReplayFrame('mission');syncHud()
}
function engWorkers(run){const s=run.status||'idle';return[{id:'engineer',name:'Engineer',state:s==='running'?'running':s==='needs_attention'?'error':s==='applied'?'complete':'pending'},{id:'validator',name:'Validator',state:s==='running'?'running':s==='awaiting_approval'?'complete':'pending'},{id:'reviewer',name:'Reviewer',state:s==='awaiting_approval'?'running':['approved','apply_requested','applied'].includes(s)?'complete':'pending'},{id:'deployer',name:'Deployer',state:['approved','apply_requested'].includes(s)?'running':s==='applied'?'complete':'pending'},{id:'operator',name:'Operator',state:s==='applied'?'complete':'pending'}]}
function applyEngineering(run){if(!run||demo.active||(sourceType==='mission'&&current?.status==='running'))return;current={type:'engineering',id:run.id,status:run.status,goal:run.request||'Engineering run',workers:engWorkers(run),raw:run};sourceType='engineering';current.workers.forEach(ensureAgent);syncHud()}
function demoMission(){
 const states=DEMO_STAGES[demo.stage].states,workers=[{id:'router',name:'Mission Router',model:'deterministic dispatcher'},{id:'ux_analyst',name:'UX Analyst',model:'qwen3:4b-instruct-32k'},{id:'documentation',name:'Documentation Agent',model:'qwen3:4b-instruct-32k'},{id:'synthesis',name:'Coordinator',model:'qwen3:4b-instruct-32k'}].map(w=>({...w,state:states[w.id]||'pending',dependsOn:w.id==='ux_analyst'?['router']:w.id==='documentation'?['ux_analyst']:w.id==='synthesis'?['documentation']:[]}));
 if(demo.scenario==='failure'&&demo.stage>=2){workers.find(w=>w.id==='documentation').state='error';workers.find(w=>w.id==='synthesis').state='blocked'}
 return{type:'mission',id:'demo-city-mission',status:demo.scenario==='failure'&&demo.stage>=2?'needs_attention':demo.stage===4?'complete':'running',goal:demo.scenario==='failure'?'Demo: recover a failed documentation handoff':'Demo: audit and improve Local AI mobile UX',workers,error:demo.scenario==='failure'&&demo.stage>=2?'Documentation Agent needs attention':''}
}
function applyDemo(){const next=demoMission();if(!demo.active||current?.id!==next.id){agents.clear();artifacts=[];packets=[];sparks=[]}current=next;sourceType='demo';current.workers.forEach(ensureAgent);syncHud();addEvent('Demo: '+DEMO_STAGES[demo.stage].label);recordReplayFrame('demo-stage-'+demo.stage)}
function startDemo(){demo.active=true;demo.running=true;demo.paused=false;demo.stage=0;demo.lastAdvance=now();applyDemo();fitWorld();syncDemoControls()}
function stepDemo(){if(!demo.active)startDemo();else{demo.stage=Math.min(DEMO_STAGES.length-1,demo.stage+1);demo.lastAdvance=now();applyDemo();if(demo.stage===DEMO_STAGES.length-1)demo.running=false}syncDemoControls()}
function resetDemo(){demo.stage=0;demo.running=false;demo.paused=false;applyDemo();syncDemoControls()}
function returnLive(){replay.active=false;replay.playing=false;demo.active=false;demo.running=false;demo.paused=false;agents.clear();artifacts=[];packets=[];sparks=[];dust=[];if(liveSnapshot){current=liveSnapshot;sourceType='mission';current.workers.forEach(ensureAgent)}else{current=null;sourceType='idle'}syncHud();syncDemoControls();syncReplay();fitWorld()}
function toggleDemoPlay(){if(!demo.active){startDemo();return}demo.running=true;demo.paused=!demo.paused;demo.lastAdvance=now();syncDemoControls()}
function cycleSpeed(){demo.speed=demo.speed===1?2:demo.speed===2?4:1;syncDemoControls()}
function syncDemoControls(){if(!root)return;$('#awcDemoPlay',root).textContent=demo.active&&demo.running&&!demo.paused?'Pause':'Play';$('#awcDemoSpeed',root).textContent=demo.speed+'×';$('#awcLiveBtn',root).hidden=!demo.active;$('#awcDemoScenario',root).value=demo.scenario}
function activeStage(){
 if(demo.active)return DEMO_STAGES[demo.stage];
 const w=current?.workers||[],running=w.find(x=>x.state==='running'),bad=w.find(x=>['error','blocked'].includes(x.state));
 if(bad)return{label:'Needs attention',detail:(bad.name||bad.id)+' requires intervention'};
 if(running)return{label:running.name||running.id,detail:'Worker active in '+(DISTRICTS[zoneForWorker(running)]?.name||'Agent World')};
 if(current?.status==='complete')return{label:'Complete',detail:'Mission finished'};
 return{label:'Standing by',detail:'Waiting for mission activity'}
}
function syncHud(){
 if(!root)return;const stage=activeStage(),workers=current?.workers||[],done=workers.filter(w=>w.state==='complete').length,running=workers.filter(w=>w.state==='running').length,bad=workers.filter(w=>['error','blocked'].includes(w.state)).length;
 $('#awcSource',root).textContent=sourceType.toUpperCase();$('#awcObjective',root).textContent=current?.goal||'No active mission';$('#awcStage',root).textContent=stage.label;$('#awcStageDetail',root).textContent=stage.detail;$('#awcStatus',root).textContent=current?humanState(current.status):'Idle';$('#awcProgressText',root).textContent=workers.length?done+'/'+workers.length+' complete':'No workers';$('#awcProgress',root).style.width=(workers.length?Math.round(done/workers.length*100):0)+'%';$('#awcStatRun',root).textContent=running;$('#awcStatDone',root).textContent=done;$('#awcStatAlert',root).textContent=bad;$('#awcAttention',root).hidden=!bad;syncRoster()
}
function syncRoster(){
 const h=$('#awcRoster',root);if(!h)return;const workers=current?.workers||[];h.innerHTML=workers.length?workers.map(w=>{const s=ROLE_STYLE[w.id]||ROLE_STYLE[w.agentId]||ROLE_STYLE.synthesis;return `<button class="awc__rosterItem ${esc(w.state)}" data-awc-roster="${esc(w.id)}"><span class="awc__rosterGlyph" style="--worker:${esc(s.accent)}">${esc((s.badge||w.name||w.id||'?').slice(0,2))}</span><span><strong>${esc(w.name||w.id)}</strong><small>${esc(DISTRICTS[zoneForWorker(w)]?.short||zoneForWorker(w))} · ${esc(s.tool)}</small></span><em>${esc(humanState(w.state))}</em></button>`}).join(''):'<div class="awc__empty">No workers active.</div>';h.querySelectorAll('[data-awc-roster]').forEach(b=>b.onclick=()=>focusWorker(b.dataset.awcRoster))
}
function syncEventFeed(){if(!root)return;const h=$('#awcEventFeed',root);if(h)h.innerHTML=events.length?events.slice(0,4).map(e=>`<div><span>${esc(e.text)}</span><time>${e.at.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></div>`).join(''):'<div><span>Waiting for activity</span></div>'}
function syncSelection(){
 if(!root)return;const h=$('#awcSelection',root);if(!selected){h.innerHTML='<span>Select a worker or building</span><small>Inspect district state and focus the camera.</small>';return}
 if(selected.type==='agent'){const a=agents.get(selected.id);if(!a)return;h.innerHTML=`<strong>${esc(a.name)}</strong><small>${esc(humanState(a.state))} · ${esc(DISTRICTS[a.zone]?.name||a.zone)} · ${esc(a.model||'automatic model')}</small>`;window.dispatchEvent(new CustomEvent('localai:agentworld-select',{detail:{workerId:a.id}}))}
 else{const d=DISTRICTS[selected.id],workers=[...agents.values()].filter(a=>a.zone===selected.id);h.innerHTML=`<strong>${esc(d.name)}</strong><small>${workers.length?workers.map(a=>esc(a.name)).join(', '):'No workers in district'}</small>`}
}
function fitWorld(){view.targetZoom=1;view.targetPanX=0;view.targetPanY=0;syncZoomLabel()}
function focusPoint(x,y,z=1.8){view.targetZoom=clamp(z,1,3);view.targetPanX=W/2-x*view.targetZoom;view.targetPanY=H/2-y*view.targetZoom;limitTargetPan();syncZoomLabel()}
function focusActive(){const a=[...agents.values()].find(x=>x.state==='running')||[...agents.values()][0];if(a){selected={type:'agent',id:a.id};syncSelection();focusPoint(a.x,a.y,2)}}
function focusWorker(id){const a=agents.get(id);if(a){selected={type:'agent',id};syncSelection();focusPoint(a.x,a.y,2)}}
function zoomAt(factor,cx=W/2,cy=H/2){const old=view.targetZoom,nz=clamp(old*factor,1,3),wx=(cx-view.targetPanX)/old,wy=(cy-view.targetPanY)/old;view.targetZoom=nz;view.targetPanX=cx-wx*nz;view.targetPanY=cy-wy*nz;limitTargetPan();syncZoomLabel()}
function limitTargetPan(){if(view.targetZoom<=1){view.targetPanX=0;view.targetPanY=0;return}view.targetPanX=clamp(view.targetPanX,W-W*view.targetZoom,0);view.targetPanY=clamp(view.targetPanY,H-H*view.targetZoom,0)}
function syncZoomLabel(){if(root)$('#awcZoomLabel',root).textContent=Math.round(view.targetZoom*100)+'%'}
function screenPoint(e){const r=canvas.getBoundingClientRect(),sx=W/r.width,sy=H/r.height,px=(e.clientX-r.left)*sx,py=(e.clientY-r.top)*sy;return{px,py,x:(px-view.panX)/view.zoom,y:(py-view.panY)/view.zoom}}
function hitAt(x,y){
 for(const a of agents.values())if(Math.hypot(x-a.x,y-a.y)<27)return{type:'agent',id:a.id};
 for(const[id,d]of Object.entries(DISTRICTS))if(x>=d.x*T&&x<=(d.x+d.w)*T&&y>=d.y*T&&y<=(d.y+d.h)*T)return{type:'district',id};
 return null
}
function selectAt(e){const p=screenPoint(e);selected=hitAt(p.x,p.y);syncSelection();if(selected?.type==='district'){const d=DISTRICTS[selected.id];focusPoint((d.x+d.w/2)*T,(d.y+d.h/2)*T,1.65)}}
function updateHover(e){
 if(drag||pointers.size>1)return;const p=screenPoint(e),hit=hitAt(p.x,p.y);hovered=hit;const tip=$('#awcTooltip',root);if(!tip)return;
 if(!hit||hit.type!=='agent'){tip.hidden=true;return}
 const a=agents.get(hit.id);tip.innerHTML='<strong>'+esc(a.name)+'</strong><span>'+esc(humanState(a.state))+' · '+esc(DISTRICTS[a.zone]?.name||a.zone)+'</span>';tip.hidden=false;
 tip.style.left=clamp(e.offsetX+12,8,canvas.clientWidth-176)+'px';tip.style.top=clamp(e.offsetY-54,8,canvas.clientHeight-54)+'px'
}
function toggleDisplay(k){display[k]=!display[k];root?.querySelector('[data-awc-display="'+k+'"]')?.setAttribute('aria-pressed',String(display[k]));if(k==='night')root?.classList.toggle('is-night',display.night)}
function toggleCrew(){display.crew=!display.crew;root?.classList.toggle('crew-hidden',!display.crew);$('#awcCrewToggle',root)?.setAttribute('aria-pressed',String(display.crew))}
function toggleFollow(){display.follow=!display.follow;$('#awcFollow',root)?.setAttribute('aria-pressed',String(display.follow));if(display.follow)focusActive()}
function toggleExpanded(){const on=!root.classList.contains('is-expanded');root.classList.toggle('is-expanded',on);document.body.classList.toggle('awc-stage-expanded',on);$('#awcExpand',root).textContent=on?'Exit theater':'Theater';setTimeout(()=>{if(on)focusActive();else fitWorld()},40)}
function exitExpanded(){if(!root?.classList.contains('is-expanded'))return;root.classList.remove('is-expanded');document.body.classList.remove('awc-stage-expanded');$('#awcExpand',root).textContent='Theater';fitWorld()}

function mount(){
 const host=$('#agentWorldCityMount');if(!host)return;root=document.createElement('section');root.className='awc awc-v3';root.innerHTML=`
 <div class="awc__commandbar">
  <div class="awc__brand"><div class="awc__mark">AW</div><div><div class="awc__title">Agent World</div><div class="awc__sub">Mission construction crew</div></div></div>
  <div class="awc__topstats"><span class="awc__live"><i></i><b id="awcSource">IDLE</b></span><span>Running <b id="awcStatRun">0</b></span><span>Complete <b id="awcStatDone">0</b></span><span>Alerts <b id="awcStatAlert">0</b></span></div>
  <div class="awc__toolbar"><button id="awcExpand" data-game-primary="true" type="button">Theater</button><button id="awcCrewToggle" type="button" aria-pressed="true">Crew</button><button id="awcFollow" type="button" aria-pressed="false">Follow</button><button id="awcFit" type="button">Fit</button><button id="awcCenter" type="button">Active</button><button id="awcZoomOut" type="button" aria-label="Zoom out">−</button><span id="awcZoomLabel">100%</span><button id="awcZoomIn" type="button" aria-label="Zoom in">+</button><button type="button" data-awc-display="labels" aria-pressed="true">Labels</button><button type="button" data-awc-display="flows" aria-pressed="true">Flows</button><button type="button" data-awc-display="night" aria-pressed="false">Night</button></div>
 </div>
 <div class="awc__missionstrip"><div class="awc__missioncopy"><span class="awc__eyebrow">Mission objective</span><strong id="awcObjective">No active mission</strong></div><div class="awc__phase"><span class="awc__phaseDot"></span><span><strong id="awcStage">Standing by</strong><small id="awcStageDetail">Waiting for mission activity</small></span></div><div class="awc__missionstate"><b id="awcStatus">Idle</b><span id="awcProgressText">No workers</span><span class="awc__attention" id="awcAttention" hidden>Attention</span></div></div>
 <div class="awc__gameShell">
  <div class="awc__mapWrap">
   <canvas width="${W}" height="${H}" id="awcCanvas" tabindex="0" aria-label="Interactive Agent World simulation"></canvas>
   <div class="awc__scanlines"></div>
   <div class="awc__tooltip" id="awcTooltip" hidden></div>
   <div class="awc__mapHud">
    <div class="awc__selection" id="awcSelection"><span>Select a worker or building</span><small>Click to inspect</small></div>
    <div class="awc__minimap" id="awcMinimap" aria-hidden="true"></div>
   </div>
   <div class="awc__eventFeed" id="awcEventFeed"></div>
  </div>
  <aside class="awc__ops">
   <div class="awc__opsHead"><span class="awc__eyebrow">Live roster</span><strong>Mission team</strong></div>
   <div class="awc__roster" id="awcRoster"><div class="awc__empty">No workers active.</div></div>
   <div class="awc__districtLegend">${Object.entries(DISTRICTS).map(([id,d])=>`<button type="button" data-awc-district="${id}"><i style="--district:${d.accent}"></i><span>${d.short}</span></button>`).join('')}</div>
   <div class="awc__replayPanel"><div><span class="awc__eyebrow">Mission replay</span><strong id="awcReplayLabel">0 checkpoints</strong></div><input id="awcReplayRange" type="range" min="0" max="0" value="0" disabled aria-label="Mission replay position"><div class="awc__replayActions"><button id="awcReplayPlay" type="button">Replay</button><button id="awcReplayLive" type="button" hidden>Live</button></div></div>
   <div class="awc__demoPanel"><span class="awc__eyebrow">Simulation lab</span><select id="awcDemoScenario" aria-label="Demo scenario"><option value="success">Successful mission</option><option value="failure">Failure + repair</option></select><div class="awc__demoActions"><button id="awcDemoPlay" type="button">Play</button><button id="awcDemoStep" type="button">Step</button><button id="awcDemoReset" type="button">Reset</button><button id="awcDemoSpeed" type="button">1×</button></div><button id="awcLiveBtn" class="awc__liveBtn" type="button" hidden>Return to live mission</button></div>
  </aside>
 </div>
 <div class="awc__footer"><div class="awc__progress"><span id="awcProgress"></span></div><div class="awc__legend"><span><i class="run"></i>Running</span><span><i class="done"></i>Complete</span><span><i class="wait"></i>Waiting</span><span><i class="bad"></i>Attention</span></div><span class="awc__hint">Drag to pan · wheel or pinch to zoom · click a district or worker</span></div>`;
 host.appendChild(root);loadReplay();syncReplay();canvas=$('#awcCanvas',root);ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
 $('#awcReplayPlay',root).onclick=toggleReplay;$('#awcReplayLive',root).onclick=returnReplayLive;$('#awcReplayRange',root).oninput=e=>applyReplayFrame(e.target.value);$('#awcExpand',root).onclick=toggleExpanded;$('#awcCrewToggle',root).onclick=toggleCrew;$('#awcFollow',root).onclick=toggleFollow;$('#awcFit',root).onclick=fitWorld;$('#awcCenter',root).onclick=focusActive;$('#awcZoomIn',root).onclick=()=>zoomAt(1.2);$('#awcZoomOut',root).onclick=()=>zoomAt(.84);$('#awcDemoPlay',root).onclick=toggleDemoPlay;$('#awcDemoStep',root).onclick=stepDemo;$('#awcDemoReset',root).onclick=resetDemo;$('#awcDemoSpeed',root).onclick=cycleSpeed;$('#awcLiveBtn',root).onclick=returnLive;$('#awcDemoScenario',root).onchange=e=>{demo.scenario=e.target.value;if(demo.active)applyDemo()};
 root.querySelectorAll('[data-awc-display]').forEach(b=>b.onclick=()=>toggleDisplay(b.dataset.awcDisplay));root.querySelectorAll('[data-awc-district]').forEach(b=>b.onclick=()=>{selected={type:'district',id:b.dataset.awcDistrict};syncSelection();const d=DISTRICTS[b.dataset.awcDistrict];focusPoint((d.x+d.w/2)*T,(d.y+d.h/2)*T,1.7)});
 canvas.addEventListener('wheel',e=>{e.preventDefault();const p=screenPoint(e);zoomAt(e.deltaY<0?1.12:.89,p.px,p.py)},{passive:false});
 canvas.addEventListener('pointerdown',e=>{try{canvas.setPointerCapture(e.pointerId)}catch{}const p=screenPoint(e);pointers.set(e.pointerId,{x:p.px,y:p.py});if(pointers.size===1){drag={id:e.pointerId,startX:p.px,startY:p.py,panX:view.targetPanX,panY:view.targetPanY,moved:false};pinch=null}else if(pointers.size===2){const ps=[...pointers.values()],dx=ps[1].x-ps[0].x,dy=ps[1].y-ps[0].y;pinch={distance:Math.max(1,Math.hypot(dx,dy)),zoom:view.targetZoom,panX:view.targetPanX,panY:view.targetPanY,cx:(ps[0].x+ps[1].x)/2,cy:(ps[0].y+ps[1].y)/2};drag=null}});
 canvas.addEventListener('pointermove',e=>{updateHover(e);if(!pointers.has(e.pointerId))return;const r=canvas.getBoundingClientRect(),sx=W/r.width,sy=H/r.height,px=(e.clientX-r.left)*sx,py=(e.clientY-r.top)*sy;pointers.set(e.pointerId,{x:px,y:py});if(pointers.size===2&&pinch){const ps=[...pointers.values()],dx=ps[1].x-ps[0].x,dy=ps[1].y-ps[0].y,dist=Math.max(1,Math.hypot(dx,dy)),cx=(ps[0].x+ps[1].x)/2,cy=(ps[0].y+ps[1].y)/2,nz=clamp(pinch.zoom*(dist/pinch.distance),1,3),wx=(pinch.cx-pinch.panX)/pinch.zoom,wy=(pinch.cy-pinch.panY)/pinch.zoom;view.targetZoom=nz;view.targetPanX=cx-wx*nz;view.targetPanY=cy-wy*nz;limitTargetPan();syncZoomLabel();return}if(!drag||drag.id!==e.pointerId)return;const dx=px-drag.startX,dy=py-drag.startY;if(Math.abs(dx)+Math.abs(dy)>4)drag.moved=true;view.targetPanX=drag.panX+dx;view.targetPanY=drag.panY+dy;limitTargetPan()});
 canvas.addEventListener('pointerup',e=>{const wasSingle=pointers.size===1,moved=drag?.moved||false;pointers.delete(e.pointerId);if(wasSingle&&!moved)selectAt(e);if(pointers.size===1){const[id,p]=[...pointers.entries()][0];drag={id,startX:p.x,startY:p.y,panX:view.targetPanX,panY:view.targetPanY,moved:true}}else drag=null;if(pointers.size<2)pinch=null});
 canvas.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);drag=null;if(pointers.size<2)pinch=null});canvas.addEventListener('pointerleave',()=>{const t=$('#awcTooltip',root);if(t)t.hidden=true});
 canvas.addEventListener('keydown',e=>{if(e.key==='+'||e.key==='=')zoomAt(1.2);if(e.key==='-')zoomAt(.84);if(e.key==='0')fitWorld();if(e.key==='f')toggleFollow();if(e.key==='Enter'&&hovered){selected=hovered;syncSelection()}});document.addEventListener('keydown',e=>{if(e.key==='Escape')exitExpanded()});
 window.addEventListener('localai:agentworld-focus',e=>focusWorker(e.detail?.workerId));
 document.body.classList.add('agent-world-city-ready');buildRoads();seedAmbient();syncDemoControls();syncHud();syncEventFeed();start();bootstrap()
}
function seedAmbient(){traffic=[{x:2*T,y:13.5*T,v:28,axis:'x',dir:1,color:'#6aaeff'},{x:36*T,y:14.5*T,v:23,axis:'x',dir:-1,color:'#ffc56b'},{x:25.5*T,y:3*T,v:20,axis:'y',dir:1,color:'#c18cff'},{x:13.5*T,y:21*T,v:18,axis:'y',dir:-1,color:'#75dfa2'}];clouds=[{x:160,y:80,s:1.1},{x:880,y:130,s:.8},{x:560,y:40,s:.6}]}
function update(dt,ts){
 if(display.follow&&!drag&&!pointers.size){const a=[...agents.values()].find(q=>q.state==='running');if(a){view.targetZoom=Math.max(view.targetZoom,1.7);view.targetPanX=W/2-a.x*view.targetZoom;view.targetPanY=H/2-a.y*view.targetZoom;limitTargetPan()}}
 view.zoom+= (view.targetZoom-view.zoom)*Math.min(1,dt*10);view.panX+=(view.targetPanX-view.panX)*Math.min(1,dt*10);view.panY+=(view.targetPanY-view.panY)*Math.min(1,dt*10);
 for(const a of agents.values()){
  const moving=workerIsMoving(a),running=a.state==='running'&&moving;
  a.motion=running?'running':moving?'walking':a.state==='running'?'working':'idle';
  a.bob+=dt*(running?12:7);a.step+=dt*(running?19:10);
  if(!moving)continue;
  const p=a.path[a.pathI],dx=p.x-a.x,dy=p.y-a.y,d=Math.hypot(dx,dy);
  if(d<3){a.pathI++;if(a.pathI>=a.path.length){a.motion=a.state==='running'?'working':'idle';a.arrivedAt=ts;spawnSpark(a.x,a.y,'#f5c04f',5)}continue}
  a.dir=dx<0?-1:1;
  const base=running?150:64,arrival=a.pathI>=a.path.length-1?clamp(d/42,.45,1):1,speed=base*arrival;
  a.x+=dx/d*speed*dt;a.y+=dy/d*speed*dt;
  if(running)spawnRunDust(a,ts)
 }
 for(const p of packets){if(p.done||!p.path[p.i])continue;const t=p.path[p.i],dx=t.x-p.x,dy=t.y-p.y,d=Math.hypot(dx,dy);if(d<3){p.i++;if(p.i>=p.path.length)p.done=true;continue}p.x+=dx/d*150*dt;p.y+=dy/d*150*dt}packets=packets.filter(p=>!p.done);
 for(const s of sparks){s.x+=s.vx*dt;s.y+=s.vy*dt;s.vy+=90*dt;s.life-=dt}sparks=sparks.filter(s=>s.life>0);for(const d of dust){d.x+=d.vx*dt;d.y+=d.vy*dt;d.r+=dt*5;d.life-=dt}dust=dust.filter(d=>d.life>0);
 for(const c of traffic){if(c.axis==='x'){c.x+=c.v*c.dir*dt;if(c.x>38*T)c.x=2*T;if(c.x<2*T)c.x=38*T}else{c.y+=c.v*c.dir*dt;if(c.y>23*T)c.y=3*T;if(c.y<3*T)c.y=23*T}}
 if(demo.active&&demo.running&&!demo.paused&&!reduced&&ts-demo.lastAdvance>3200/demo.speed){if(demo.stage<DEMO_STAGES.length-1){demo.stage++;applyDemo();recordReplayFrame('demo');demo.lastAdvance=ts}else demo.running=false;syncDemoControls()}
 if(replay.active&&replay.playing&&ts-replay.lastStep>1200){if(replay.index<replay.frames.length-1){replay.index++;const f=replay.frames[replay.index];agents.clear();artifacts=[];packets=[];current=JSON.parse(JSON.stringify(f.mission));sourceType='replay';current.workers.forEach(ensureAgent);syncHud();replay.lastStep=ts}else replay.playing=false;syncReplay()}
}
function px(x,y,w,h,c){ctx.fillStyle=c;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h))}
function pathPoly(points,fill){ctx.fillStyle=fill;ctx.beginPath();ctx.moveTo(points[0][0],points[0][1]);for(let i=1;i<points.length;i++)ctx.lineTo(points[i][0],points[i][1]);ctx.closePath();ctx.fill()}
function txt(t,x,y,c='#d9e7f4',size=11,align='center'){ctx.fillStyle=c;ctx.font='800 '+size+'px ui-monospace,monospace';ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillText(t,x,y)}
function drawGround(ts){
 px(0,0,W,H,display.night?'#07121b':'#0d2220');
 for(let y=0;y<H;y+=T)for(let x=0;x<W;x+=T){const n=((x/T*13+y/T*7)%11);px(x,y,T,T,display.night?(n<4?'#0b211f':'#0e2822'):(n<3?'#17382b':n<7?'#1a422f':'#1d4933'));if(n===0){px(x+6,y+8,3,3,'#2d6548');px(x+22,y+20,2,2,'#2a5c43')}}
 // water / edge
 pathPoly([[0,0],[W,0],[W,56],[1010,74],[820,48],[620,65],[420,45],[180,70],[0,52]],display.night?'#071a27':'#143a4c');
 ctx.strokeStyle=display.night?'#0c3248':'#23627e';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(0,52);ctx.bezierCurveTo(260,78,420,37,640,60);ctx.bezierCurveTo(860,82,1020,45,W,58);ctx.stroke();
 // roads
 roads.forEach(k=>{const[x,y]=k.split(',').map(Number);px(x*T,y*T,T,T,display.night?'#1b2530':'#2b343f');px(x*T+2,y*T+2,T-4,T-4,display.night?'#232f3b':'#35414d')});
 for(let x=0;x<COLS;x++){if(roads.has(key(x,13)))px(x*T+8,13*T+15,16,2,'#d6ab52');if(roads.has(key(x,14)))px(x*T+8,14*T+15,16,2,'#d6ab52')}
 for(let y=0;y<ROWS;y++){if(roads.has(key(13,y)))px(13*T+15,y*T+8,2,16,'#d6ab52');if(roads.has(key(25,y)))px(25*T+15,y*T+8,2,16,'#d6ab52')}
 // crosswalks
 for(const [tx,ty,vert] of [[13,9,false],[25,9,false],[13,23,false],[25,23,false],[13,13,true],[25,13,true]])for(let i=0;i<5;i++)px(tx*T+(vert?8+i*4:5+i*5),ty*T+(vert?5+i*5:8),vert?2:3,vert?3:2,'#98a3ab');
 // plaza + paths
 px(16*T,11*T,9*T,5*T,display.night?'#3f443f':'#746f59');for(let i=0;i<18;i++)px(16*T+(i%6)*T/1.5+9,11*T+Math.floor(i/6)*T/1.5+10,4,4,display.night?'#545a54':'#999078');
 // trees
 for(const [x,y] of [[2,2],[3,3],[37,3],[38,4],[2,22],[38,22],[9,2],[30,2],[9,25],[30,25],[11,6],[28,6],[11,20],[28,20]])drawTree(x*T+T/2,y*T+T/2,ts);
}
function drawTree(x,y,ts){px(x-2,y+3,4,9,'#4d3522');const sway=Math.sin(ts/700+x*.02)*1.2;ctx.fillStyle=display.night?'#13402c':'#22663c';ctx.beginPath();ctx.arc(x+sway,y,9,0,Math.PI*2);ctx.fill();ctx.fillStyle=display.night?'#195037':'#2d8050';ctx.beginPath();ctx.arc(x-3+sway,y-3,6,0,Math.PI*2);ctx.fill()}
function districtWorkers(id){return current?.workers?.filter(q=>zoneForWorker(q)===id)||[]}
function drawBuilding(id,d,ts){
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,depth=14,workers=districtWorkers(id),active=workers.some(q=>q.state==='running'),bad=workers.some(q=>['error','blocked'].includes(q.state)),done=workers.length&&workers.every(q=>q.state==='complete'),selectedDistrict=selected?.type==='district'&&selected.id===id,pulse=(Math.sin(ts/240)+1)/2;
 ctx.save();
 ctx.shadowColor='rgba(0,0,0,.35)';ctx.shadowBlur=18;px(x+8,y+12,w-2,h-2,'rgba(0,0,0,.28)');ctx.shadowBlur=0;
 // side face
 pathPoly([[x+w,y+8],[x+w+depth,y],[x+w+depth,y+h-depth],[x+w,y+h]],display.night?'#152332':'#233749');
 // front
 px(x,y+8,w,h-8,display.night?'#172634':'#223646');
 // roof base and accent
 pathPoly([[x,y+8],[x+depth,y],[x+w+depth,y],[x+w,y+8]],d.roof);
 px(x+8,y+14,w-16,6,d.accent);
 // windows
 const win=active?(pulse>.35?'#ddfbff':'#70dce7'):done?'#7ce0a4':display.night?'#172d3e':'#24455a';
 for(let yy=y+28;yy<y+h-20;yy+=18)for(let xx=x+14;xx<x+w-14;xx+=22){px(xx,yy,10,7,win);px(xx+1,yy+1,8,1,'rgba(255,255,255,.18)')}
 // door + signage
 px(x+w/2-9,y+h-22,18,22,'#0d1720');px(x+w/2-5,y+h-17,4,4,d.accent);
 px(x+10,y+10,28,18,'rgba(6,12,18,.72)');txt(d.icon,x+24,y+19,d.accent,d.icon.length>1?9:13);
 if(display.labels){ctx.fillStyle='rgba(6,11,17,.88)';ctx.fillRect(x+4,y-21,Math.min(w-8,d.name.length*7+18),17);txt(d.name,x+10,y-12,active?'#fff':'#c6d4e1',9,'left')}
 if(active){ctx.strokeStyle=d.accent;ctx.globalAlpha=.55+.35*pulse;ctx.lineWidth=3;ctx.strokeRect(x-4,y-4,w+depth+8,h+10);ctx.globalAlpha=1}
 if(done){ctx.fillStyle='#75dfa2';ctx.beginPath();ctx.arc(x+w-8,y+18,5,0,Math.PI*2);ctx.fill()}
 if(bad){ctx.strokeStyle='#ff7383';ctx.lineWidth=4;ctx.globalAlpha=.6+.4*pulse;ctx.strokeRect(x-5,y-5,w+depth+10,h+11);ctx.globalAlpha=1;px(x+w-16,y+11,10,10,pulse>.5?'#ff7383':'#6f2632')}
 if(selectedDistrict){ctx.strokeStyle='#ffffff';ctx.lineWidth=2;ctx.setLineDash([6,4]);ctx.strokeRect(x-8,y-8,w+depth+16,h+17);ctx.setLineDash([])}
 ctx.restore()
}
function districtProgress(id){
 const w=districtWorkers(id);if(!w.length)return 0;return w.reduce((n,q)=>n+(q.state==='complete'?1:q.state==='running'?.55:q.state==='blocked'?.2:0),0)/w.length
}
function drawWorksite(id,d,ts){
 const workers=districtWorkers(id),active=workers.some(w=>w.state==='running'),bad=workers.some(w=>['error','blocked'].includes(w.state)),progress=districtProgress(id);if(!active&&!bad&&!progress)return;
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,pulse=(Math.sin(ts/220)+1)/2;
 if(active||bad){
  for(let i=0;i<3;i++){const cx=x+16+i*18,cy=y+h+10;pathPoly([[cx,cy],[cx+5,cy-10],[cx+10,cy]],bad?'#ff7383':'#f5a623');px(cx+2,cy-5,6,2,'#fff3b0')}
  ctx.strokeStyle=bad?'rgba(255,115,131,.65)':'rgba(245,180,62,.58)';ctx.lineWidth=2;ctx.strokeRect(x-9,y+10,9,h-18);ctx.strokeRect(x+w+4,y+10,9,h-18);
  for(let yy=y+18;yy<y+h-12;yy+=18){ctx.beginPath();ctx.moveTo(x-9,yy);ctx.lineTo(x,yy+8);ctx.moveTo(x+w+4,yy);ctx.lineTo(x+w+13,yy+8);ctx.stroke()}
  const mastX=x+w+18,top=y-6,hookY=y+14+Math.sin(ts/500)*8;px(mastX,top,3,44,bad?'#8f3b48':'#d79b2b');px(mastX-18,top,22,3,bad?'#8f3b48':'#e7b343');ctx.strokeStyle=bad?'#ff8f9c':'#f3c65d';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(mastX-15,top+3);ctx.lineTo(mastX-15,hookY);ctx.stroke();px(mastX-18,hookY,6,4,bad?'#ff7383':(pulse>.45?'#ffd26b':'#c9952d'))
 }
 if(workers.length){px(x,y+h+17,w,5,'rgba(5,10,16,.7)');px(x,y+h+17,w*progress,5,bad?'#ff7383':d.accent);txt(Math.round(progress*100)+'%',x+w/2,y+h+20,'#eaf5ff',7)}
}
function drawWorkingAction(a,ts){
 if(a.state!=='running'||workerIsMoving(a))return;const s=roleStyle(a),phase=Math.sin(ts/120+a.activitySeed),x=a.x,y=a.y;
 if(['engineer','code_analyst','deployer'].includes(a.id)){ctx.strokeStyle='#d7e0e8';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x+10,y-1);ctx.lineTo(x+17+phase*3,y-11);ctx.stroke()}
 else if(['validator','test_engineer','security_reviewer'].includes(a.id)){ctx.save();ctx.globalAlpha=.18+.12*Math.abs(phase);ctx.fillStyle=s.accent;ctx.beginPath();ctx.moveTo(x+10,y-6);ctx.lineTo(x+34,y-16);ctx.lineTo(x+34,y+5);ctx.closePath();ctx.fill();ctx.restore()}
 else if(['ux_analyst','documentation','research_agent'].includes(a.id)){px(x+10,y-7,13,9,'#111d29');px(x+12,y-5,9,5,s.accent);px(x+12+Math.floor((ts/180)%7),y+2,2,2,'#fff')}
 else{ctx.strokeStyle=s.accent;ctx.globalAlpha=.65;ctx.strokeRect(x+10,y-15,18,12);ctx.beginPath();ctx.moveTo(x+13,y-5);ctx.lineTo(x+18,y-10);ctx.lineTo(x+23,y-7);ctx.lineTo(x+26,y-13);ctx.stroke();ctx.globalAlpha=1}
}
function drawTraffic(){for(const c of traffic){ctx.save();ctx.translate(c.x,c.y);px(-7,-4,14,8,c.color);px(-4,-6,8,3,'#b8dbff');px(-5,4,3,2,'#0b0e12');px(2,4,3,2,'#0b0e12');ctx.restore()}}
function dependencyState(from,to){
 if(['error','blocked'].includes(from.state)||['error','blocked'].includes(to.state))return'blocked';
 if(from.state==='complete'&&to.state==='running')return'active';
 if(from.state==='complete')return'ready';
 return'waiting'
}
function drawFlows(ts){
 if(!display.flows||!current?.workers?.length)return;
 ctx.save();ctx.lineCap='round';
 for(const w of current.workers){for(const dep of w.dependsOn||[]){const a=current.workers.find(x=>x.id===dep);if(!a)continue;const p1=districtCenter(zoneForWorker(a)),p2=districtCenter(zoneForWorker(w)),state=dependencyState(a,w),pulse=(Math.sin(ts/180)+1)/2;
  ctx.setLineDash(state==='waiting'?[3,9]:state==='blocked'?[2,6]:[7,6]);ctx.lineDashOffset=-(ts/(state==='active'?45:90))%13;
  ctx.strokeStyle=state==='blocked'?'rgba(255,115,131,.82)':state==='active'?('rgba(89,226,237,'+(.55+.35*pulse)+')'):state==='ready'?'rgba(117,223,162,.55)':'rgba(120,145,170,.26)';
  ctx.lineWidth=state==='active'?3:2;ctx.shadowColor=state==='active'?'#59e2ed':'transparent';ctx.shadowBlur=state==='active'?10:0;ctx.beginPath();ctx.moveTo(p1.x,p1.y);ctx.lineTo(p2.x,p2.y);ctx.stroke();
  if(state==='active'){const t=((ts/900)%1),mx=p1.x+(p2.x-p1.x)*t,my=p1.y+(p2.y-p1.y)*t;ctx.fillStyle='#eaffff';ctx.beginPath();ctx.arc(mx,my,3,0,Math.PI*2);ctx.fill()}
 }}
 ctx.setLineDash([]);ctx.shadowBlur=0;ctx.restore()
}
function roleStyle(a){return a.style||ROLE_STYLE[a.id]||ROLE_STYLE.synthesis}
function workerIsMoving(a){return !!(a.path?.length&&a.pathI<a.path.length)}
function workerIsRunning(a){return a.state==='running'&&workerIsMoving(a)}
function spawnRunDust(a,ts){
 if(reduced||ts-(a.lastDust||0)<85)return;a.lastDust=ts;
 for(let i=0;i<2;i++)dust.push({x:a.x-a.dir*(7+Math.random()*5),y:a.y+16+Math.random()*3,vx:-a.dir*(10+Math.random()*16),vy:-4-Math.random()*8,r:2+Math.random()*2,life:.42})
}
function drawWorkerTool(a,x,y,bob,walk){
 const s=roleStyle(a),dir=a.dir||1,handX=x+dir*9,handY=y-3+bob,tool=s.tool;
 if(tool==='tablet'){px(handX+(dir>0?0:-8),handY-2,8,6,'#14212d');px(handX+(dir>0?1:-7),handY-1,6,4,s.accent)}
 else if(tool==='clipboard'){px(handX+(dir>0?0:-7),handY-2,7,8,'#e9e3ce');px(handX+(dir>0?2:-5),handY,3,1,'#556272');px(handX+(dir>0?2:-5),handY+3,3,1,'#556272')}
 else if(tool==='wrench'){ctx.strokeStyle='#d5dee8';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(handX,handY+5);ctx.lineTo(handX+dir*7,handY-3);ctx.stroke();ctx.beginPath();ctx.arc(handX+dir*8,handY-4,3,0,Math.PI*2);ctx.stroke()}
 else if(tool==='scanner'){px(handX+(dir>0?0:-6),handY-1,6,7,'#172531');px(handX+(dir>0?1:-5),handY,4,2,s.accent);ctx.globalAlpha=.25;ctx.fillStyle=s.accent;ctx.beginPath();ctx.moveTo(handX+dir*5,handY+1);ctx.lineTo(handX+dir*18,handY-4);ctx.lineTo(handX+dir*18,handY+7);ctx.closePath();ctx.fill();ctx.globalAlpha=1}
 else if(tool==='headset'){ctx.strokeStyle=s.accent;ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y-18+bob,7,Math.PI,Math.PI*2);ctx.stroke();px(x+dir*7,y-18+bob,2,6,s.accent);px(x+dir*8,y-13+bob,5,2,s.accent)}
 else if(tool==='holo'){ctx.strokeStyle=s.accent;ctx.globalAlpha=.7;ctx.lineWidth=1;ctx.strokeRect(handX+(dir>0?0:-10),handY-6,10,8);ctx.globalAlpha=.18;ctx.fillStyle=s.accent;ctx.fillRect(handX+(dir>0?0:-10),handY-6,10,8);ctx.globalAlpha=1}
 else if(tool==='crate'){px(handX+(dir>0?-1:-9),handY-2,10,9,'#8b643c');px(handX+(dir>0?1:-7),handY,6,1,'#d7aa61');px(handX+(dir>0?3:-5),handY-2,1,9,'#5b4028')}
 else if(tool==='radio'){px(handX+(dir>0?0:-5),handY-3,5,8,'#16222c');px(handX+(dir>0?1:-4),handY-1,3,2,s.accent);ctx.strokeStyle='#8797a8';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(handX+dir*2,handY-3);ctx.lineTo(handX+dir*4,handY-8);ctx.stroke()}
}
function drawWorkerHat(a,x,y,bob){
 const s=roleStyle(a),helmet=s.hat||'#f4c448';
 // oversized rounded hard hat with brim, closer to a chunky construction-game character
 ctx.fillStyle=helmet;ctx.beginPath();ctx.ellipse(x,y-27+bob,10,6,0,Math.PI,Math.PI*2);ctx.fill();
 px(x-9,y-27+bob,18,5,helmet);px(x-6,y-31+bob,12,5,helmet);px(x+(a.dir>0?4:-10),y-24+bob,10,3,'#d39a2d');
 // helmet role stripe
 px(x-2,y-31+bob,4,7,s.accent);
 // hair showing under helmet
 px(x-7,y-23+bob,4,4,s.hair);px(x+3,y-23+bob,4,3,s.hair)
}
function drawWorkerBubble(a,x,y,ts){
 if(a.state==='running'){const labels={router:'ROUTE',mission_router:'ROUTE',ux_analyst:'AUDIT',documentation:'WRITE',synthesis:'MERGE',coordinator:'MERGE',engineer:'BUILD',validator:'TEST',reviewer:'REVIEW',deployer:'SHIP',operator:'WATCH'},label=labels[a.id]||'WORK',pulse=(Math.sin(ts/350+a.activitySeed)+1)/2,w=Math.max(34,label.length*6+12);ctx.fillStyle='rgba(5,10,16,.88)';ctx.fillRect(x-w/2,y-46,w,14);px(x-2,y-32,4,4,'rgba(5,10,16,.88)');txt(label,x,y-39,pulse>.35?'#ffffff':roleStyle(a).accent,7)}
 else if(a.state==='complete'){ctx.fillStyle='rgba(5,10,16,.86)';ctx.fillRect(x-16,y-43,32,14);txt('DONE',x,y-36,'#75dfa2',7)}
 else if(['error','blocked'].includes(a.state)){ctx.fillStyle='rgba(70,18,27,.92)';ctx.fillRect(x-18,y-43,36,14);txt('!',x,y-36,'#ffd2d7',10)}
}
function drawRunningWorkerSprite(a,ts){
 const s=roleStyle(a),phase=Math.sin(a.step),kick=Math.cos(a.step),dir=a.dir||1,x=a.x,y=a.y-2+Math.abs(phase)*1.4,stateColor=s.accent;
 ctx.save();ctx.translate(x,y);ctx.rotate(dir*.07);
 // stretched moving shadow
 ctx.fillStyle='rgba(0,0,0,.28)';ctx.beginPath();ctx.ellipse(-dir*4,21,18,5,-dir*.08,0,Math.PI*2);ctx.fill();
 // speed streaks
 ctx.globalAlpha=.38;ctx.strokeStyle=s.accent;ctx.lineWidth=2;
 for(let i=0;i<3;i++){ctx.beginPath();ctx.moveTo(-dir*(20+i*6),-2+i*6);ctx.lineTo(-dir*(9+i*4),-2+i*6);ctx.stroke()}ctx.globalAlpha=1;
 // legs: long opposing running stride
 ctx.strokeStyle=s.pants;ctx.lineWidth=8;ctx.lineCap='round';
 ctx.beginPath();ctx.moveTo(-4,6);ctx.lineTo(-8-dir*phase*8,13);ctx.lineTo(-13-dir*phase*12,18);ctx.stroke();
 ctx.beginPath();ctx.moveTo(4,6);ctx.lineTo(8+dir*phase*8,12);ctx.lineTo(12+dir*phase*12,17);ctx.stroke();
 // boots
 ctx.strokeStyle='#2a211b';ctx.lineWidth=5;
 ctx.beginPath();ctx.moveTo(-13-dir*phase*12,18);ctx.lineTo(-18-dir*phase*12,18);ctx.stroke();
 ctx.beginPath();ctx.moveTo(12+dir*phase*12,17);ctx.lineTo(17+dir*phase*12,17);ctx.stroke();
 // torso leaned into the run
 ctx.fillStyle=s.shirt;ctx.beginPath();ctx.roundRect(-12,-10,24,20,6);ctx.fill();
 ctx.fillStyle=s.vest||'#ff9d33';ctx.beginPath();ctx.roundRect(-10,-9,20,15,4);ctx.fill();
 px(-2+x-x,-9+y-y,4,15,s.shirt); // local vest opening
 ctx.fillStyle='#ffe885';ctx.fillRect(-9,-3,18,2);ctx.fillRect(-9,2,18,2);
 ctx.fillStyle='#4d3828';ctx.fillRect(-11,6,22,4);
 // arms pump hard opposite the legs
 ctx.strokeStyle=s.skin;ctx.lineWidth=8;
 ctx.beginPath();ctx.moveTo(-10,-5);ctx.lineTo(-15+dir*phase*8,-1);ctx.lineTo(-10+dir*phase*13,5);ctx.stroke();
 ctx.beginPath();ctx.moveTo(10,-5);ctx.lineTo(15-dir*phase*8,-2);ctx.lineTo(10-dir*phase*13,-10);ctx.stroke();
 ctx.fillStyle='#f2b23d';ctx.beginPath();ctx.arc(-10+dir*phase*13,5,4,0,Math.PI*2);ctx.arc(10-dir*phase*13,-10,4,0,Math.PI*2);ctx.fill();
 // head and hard hat
 ctx.fillStyle=s.skin;ctx.beginPath();ctx.roundRect(-10,-27,20,15,6);ctx.fill();
 ctx.fillStyle=s.hair;ctx.fillRect(-7,-24,14,4);
 ctx.fillStyle='#18222b';ctx.fillRect(-5,-20,3,3);ctx.fillRect(2,-20,3,3);
 ctx.fillStyle=s.hat||'#f4c448';ctx.beginPath();ctx.ellipse(0,-29,10,6,0,Math.PI,Math.PI*2);ctx.fill();ctx.fillRect(-9,-29,18,5);ctx.fillRect(-6,-33,12,5);ctx.fillStyle=s.accent;ctx.fillRect(-2,-33,4,7);
 // role patch + backpack
 ctx.fillStyle=s.accent;ctx.beginPath();ctx.roundRect(4,-7,6,6,2);ctx.fill();ctx.fillStyle='#4a4036';ctx.fillRect(-dir*14,-5,4,11);
 ctx.restore();
 // tool stays readable while running
 drawWorkerTool(a,x+dir*2,y+1,0,phase*3);
 // running state beacon
 ctx.save();ctx.shadowColor=stateColor;ctx.shadowBlur=14;ctx.fillStyle=stateColor;ctx.beginPath();ctx.arc(x,y-40,3+(Math.sin(ts/150)+1),0,Math.PI*2);ctx.fill();ctx.restore()
}
function drawWorkerSprite(a,ts){
 const s=roleStyle(a),moving=workerIsMoving(a),running=workerIsRunning(a),walk=moving?Math.sin(a.step)*2.4:0,idle=!moving?Math.sin(ts/680+a.activitySeed)*.7:0,bob=(a.state==='running'?Math.sin(a.bob)*1.1:idle),x=a.x,y=a.y+bob,sel=selected?.type==='agent'&&selected.id===a.id,stateColor=['error','blocked'].includes(a.state)?'#ff7383':a.state==='complete'?'#75dfa2':a.state==='pending'?'#6d7985':s.accent;
 if(sel){ctx.save();ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.shadowColor=stateColor;ctx.shadowBlur=14;ctx.beginPath();ctx.ellipse(x,y+18,21,10,0,0,Math.PI*2);ctx.stroke();ctx.restore()}
 if(running){drawRunningWorkerSprite(a,ts)}
 else{
  ctx.fillStyle='rgba(0,0,0,.30)';ctx.beginPath();ctx.ellipse(x,y+20,14,6,0,0,Math.PI*2);ctx.fill();
  ctx.fillStyle=s.pants;ctx.beginPath();ctx.roundRect(x-10,y+4+walk,8,14,3);ctx.fill();ctx.beginPath();ctx.roundRect(x+2,y+4-walk,8,14,3);ctx.fill();
  ctx.fillStyle='#2a211b';ctx.beginPath();ctx.roundRect(x-11,y+15+walk,10,5,2);ctx.fill();ctx.beginPath();ctx.roundRect(x+1,y+15-walk,10,5,2);ctx.fill();
  ctx.fillStyle=a.state==='pending'?'#8a7563':s.shirt;ctx.beginPath();ctx.roundRect(x-12,y-10,24,20,6);ctx.fill();
  ctx.fillStyle=s.vest||'#ff9d33';ctx.beginPath();ctx.roundRect(x-10,y-9,20,15,4);ctx.fill();px(x-2,y-9,4,15,s.shirt);px(x-9,y-3,18,2,'#ffe885');px(x-9,y+2,18,2,'#ffe885');px(x-11,y+6,22,4,'#4d3828');px(x-2,y+6,5,4,'#d59a3d');
  ctx.fillStyle=s.skin;ctx.beginPath();ctx.ellipse(x-14,y-2-walk*.25,5,9,-.15,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.ellipse(x+14,y-2+walk*.25,5,9,.15,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#f2b23d';ctx.beginPath();ctx.arc(x-15,y+5-walk*.25,4,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(x+15,y+5+walk*.25,4,0,Math.PI*2);ctx.fill();
  px(x-4,y-14,8,5,s.skin);ctx.fillStyle=s.skin;ctx.beginPath();ctx.roundRect(x-10,y-27,20,15,6);ctx.fill();ctx.beginPath();ctx.arc(x-10,y-20,3,0,Math.PI*2);ctx.arc(x+10,y-20,3,0,Math.PI*2);ctx.fill();
  px(x-6,y-23,5,2,s.hair);px(x+1,y-23,5,2,s.hair);px(x-5,y-20,3,3,'#18222b');px(x+2,y-20,3,3,'#18222b');px(x-2,y-16,5,2,'#965b46');
  drawWorkerHat(a,x,y,bob);drawWorkerTool(a,x,y+2,bob,walk);
  ctx.fillStyle=s.accent;ctx.beginPath();ctx.roundRect(x+4,y-7,6,6,2);ctx.fill();ctx.fillStyle='#071019';ctx.font='900 5px ui-monospace,monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText((s.badge||a.glyph).slice(0,2),x+7,y-4);px(x+(a.dir>0?-14:10),y-5,4,11,'#4a4036');
  ctx.save();ctx.shadowColor=stateColor;ctx.shadowBlur=a.state==='running'?14:6;ctx.fillStyle=stateColor;ctx.beginPath();ctx.arc(x,y-38,3+(a.state==='running'?(Math.sin(ts/180)+1):0),0,Math.PI*2);ctx.fill();ctx.restore()
 }
 const isHover=hovered?.type==='agent'&&hovered.id===a.id;
 if(display.labels&&(sel||isHover)){const labelW=Math.min(110,Math.max(58,a.name.length*6+16));ctx.fillStyle='rgba(5,10,16,.92)';ctx.fillRect(x-labelW/2,y+25,labelW,17);txt(a.name,x,y+33,'#eef6ff',8)}
 if(sel||(a.state==='running'&&view.zoom>1.55))drawWorkerBubble(a,x,y-1,ts)
}
function drawAgents(ts){
 for(const d of dust){ctx.globalAlpha=clamp(d.life/.42,0,1)*.5;ctx.fillStyle=display.night?'#70808c':'#c5b99a';ctx.beginPath();ctx.arc(d.x,d.y,d.r,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=1;for(const a of agents.values()){drawWorkerSprite(a,ts);drawWorkingAction(a,ts)}
 for(const p of packets){ctx.save();ctx.shadowColor=p.color;ctx.shadowBlur=12;px(p.x-6,p.y-5,12,9,'#182431');px(p.x-5,p.y-4,10,7,p.color);px(p.x-2,p.y-2,4,2,'#fff');ctx.restore();if(view.zoom>1.35){ctx.fillStyle='rgba(5,10,16,.88)';ctx.fillRect(p.x-22,p.y-20,44,11);txt(p.label||'DATA',p.x,p.y-14,'#eaf5ff',6)}}
 for(const a of artifacts){
  ctx.save();ctx.shadowColor=a.color;ctx.shadowBlur=8;
  if(a.kind==='build'){px(a.x-10,a.y-8,20,14,'#263746');px(a.x-8,a.y-6,16,10,a.color);px(a.x-5,a.y-3,10,5,'#14202b')}
  else if(a.kind==='certificate'){px(a.x-9,a.y-8,18,15,'#edf6ef');px(a.x-6,a.y-5,12,2,a.color);ctx.fillStyle=a.color;ctx.beginPath();ctx.arc(a.x+4,a.y+2,3,0,Math.PI*2);ctx.fill()}
  else if(a.kind==='node'){ctx.fillStyle=a.color;ctx.beginPath();ctx.arc(a.x,a.y,8,0,Math.PI*2);ctx.fill();px(a.x-2,a.y-2,4,4,'#fff')}
  else{px(a.x-8,a.y-9,16,15,'#eef5ff');px(a.x-6,a.y-6,12,2,a.color);px(a.x-6,a.y-2,9,1,'#8093a5');px(a.x-6,a.y+1,7,1,'#8093a5')}
  ctx.restore()
 }
 for(const s of sparks){ctx.globalAlpha=clamp(s.life,0,1);px(s.x,s.y,s.size,s.size,s.color)}ctx.globalAlpha=1
}
function drawClouds(ts){if(display.night)return;ctx.save();ctx.globalAlpha=.08;for(const c of clouds){const x=(c.x+ts*.006*c.s)%W,y=c.y;ctx.fillStyle='#d8f0ff';ctx.beginPath();ctx.arc(x,y,26*c.s,0,Math.PI*2);ctx.arc(x+28*c.s,y+6,20*c.s,0,Math.PI*2);ctx.arc(x-25*c.s,y+8,17*c.s,0,Math.PI*2);ctx.fill()}ctx.restore()}
function drawMinimap(){
 const el=$('#awcMinimap',root);if(!el)return;
 const markers=Object.entries(DISTRICTS).map(([id,d])=>`<i style="left:${((d.x+d.w/2)*T/W)*100}%;top:${((d.y+d.h/2)*T/H)*100}%;--c:${d.accent}" title="${esc(d.name)}"></i>`).join('');
 el.innerHTML='<span></span>'+markers;
}
function draw(ts){
 ctx.clearRect(0,0,W,H);ctx.save();ctx.translate(view.panX,view.panY);ctx.scale(view.zoom,view.zoom);drawGround(ts);drawFlows(ts);drawTraffic();for(const[id,d]of Object.entries(DISTRICTS)){drawBuilding(id,d,ts);drawWorksite(id,d,ts)}drawAgents(ts);drawClouds(ts);if(display.night){ctx.fillStyle='rgba(3,7,14,.18)';ctx.fillRect(0,0,W,H)}ctx.restore()
}
function loop(ts){const dt=Math.min(.05,(ts-last)/1000||0);last=ts;update(dt,ts);draw(ts);raf=requestAnimationFrame(loop)}
function start(){if(!raf)raf=requestAnimationFrame(loop)}
async function bootstrap(){try{const r=await fetch('/api/agents/missions'),j=await r.json(),items=j.items||j.missions||[],active=items.find(m=>m.status==='running')||items[0];if(active){applyMission(active);connectSSE();return}}catch{}try{const r=await fetch('/api/engineering/runs'),j=await r.json(),runs=j.items||[],active=runs.find(x=>x.status==='running')||runs[0];if(active)applyEngineering(active)}catch{}connectSSE()}
function connectSSE(){try{const es=new EventSource('/api/agents/missions/events');es.onmessage=e=>{try{const m=JSON.parse(e.data);liveSnapshot=normalizeMission(m);applyMission(m)}catch{}}}catch{}}
document.addEventListener('localai:engineering-run',e=>applyEngineering(e.detail?.run||e.detail));
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{mount();drawMinimap()},{once:true});else{mount();drawMinimap()}
})();