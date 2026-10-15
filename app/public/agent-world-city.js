(()=>{'use strict';
const W=1280,H=760,T=32,COLS=Math.floor(W/T),ROWS=Math.floor(H/T);
const $=(s,r=document)=>r.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n)),key=(x,y)=>x+','+y,now=()=>performance.now();
// One shared mission EventSource per tab (agent-specialists.js and agent-world-city.js both subscribe; whichever loads first creates it).
const missionStream=window.LocalAIMissionStream||(window.LocalAIMissionStream=(()=>{const subs=new Set();let es=null;function open(){if(es)return;const s=new EventSource('/api/agents/missions/events');es=s;s.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}for(const x of[...subs])try{x.onMessage?.(m)}catch{}};s.onerror=e=>{for(const x of[...subs])try{x.onError?.(e)}catch{}}}return{subscribe(onMessage,onError){const sub={onMessage,onError};subs.add(sub);try{open()}catch(e){subs.delete(sub);throw e}return()=>subs.delete(sub)}}})());

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
const REPLAY_KEY='localai.agentworld.replay.v2';
let replay={frames:[],active:false,index:0,playing:false,lastStep:0,speed:1,sourceMissionId:''};
let celebrationUntil=0;

function humanState(s){return({needs_attention:'Needs attention',running:'Running',complete:'Complete',blocked:'Blocked',error:'Needs attention',pending:'Waiting',awaiting_approval:'Awaiting approval',applied:'Applied'})[s]||String(s||'Idle').replaceAll('_',' ')}
function zoneForWorker(w){if(['error','blocked'].includes(w.state))return'repair';return ROLE_ZONE[w.id]||ROLE_ZONE[w.agentId]||(/doc/i.test(w.name||'')?'docs':/ux/i.test(w.name||'')?'ux':/model/i.test(w.name||'')?'models':'command')}
function districtCenter(id){const d=DISTRICTS[id]||DISTRICTS.command;return{x:(d.x+d.w/2)*T,y:(d.y+d.h+.8)*T}}
function districtDoor(id){
 const d=DISTRICTS[id]||DISTRICTS.command,cx=(d.x+d.w/2)*T,front=(d.y+d.h)*T;
 return{outside:{x:cx,y:front+T*.48},inside:{x:cx,y:front-T*.42}}
}
function pointInsideDistrict(p,id){
 const d=DISTRICTS[id]||DISTRICTS.command;return p.x>d.x*T+6&&p.x<(d.x+d.w)*T-6&&p.y>d.y*T+18&&p.y<(d.y+d.h)*T-8
}
function workerTarget(w,zone){
 const d=DISTRICTS[zone]||DISTRICTS.command,workers=(current?.workers||[]).filter(q=>zoneForWorker(q)===zone),id=w.id||w.agentId||w.name,idx=Math.max(0,workers.findIndex(q=>(q.id||q.agentId||q.name)===id));
 const active=w.state==='running'||w.state==='error'||w.state==='blocked';
 if(active){
  const cols=Math.max(2,Math.min(3,Math.floor(d.w/2))),col=idx%cols,row=Math.floor(idx/cols)%2;
  return{x:(d.x+1.35+col*((d.w-2.7)/Math.max(1,cols-1)))*T,y:(d.y+1.65+row*1.15)*T,inside:true}
 }
 const base=districtCenter(zone),slots=[[-42,0],[42,0],[-72,24],[72,24],[0,34],[-34,54],[34,54]],slot=slots[idx%slots.length];
 return{x:base.x+slot[0],y:base.y+slot[1],inside:false}
}
function routeToTarget(agent,target,zone){
 const path=[],from={x:agent.x,y:agent.y};
 if(agent.inside&&agent.insideZone){const exit=districtDoor(agent.insideZone);path.push(exit.inside,exit.outside);from.x=exit.outside.x;from.y=exit.outside.y}
 if(target.inside){
  const door=districtDoor(zone),roadPath=astar(from,door.outside);path.push(...roadPath);
  if(!path.length||Math.hypot(path.at(-1).x-door.outside.x,path.at(-1).y-door.outside.y)>3)path.push(door.outside);
  path.push(door.inside,{x:target.x,y:target.y})
 }else{
  const roadPath=astar(from,target);path.push(...roadPath);
  if(!path.length||Math.hypot(path.at(-1).x-target.x,path.at(-1).y-target.y)>3)path.push({x:target.x,y:target.y})
 }
 return path
}
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
function normalizeMission(m){return{type:'mission',id:m.id,status:m.status,goal:m.goal||'Mission',updatedAt:m.updatedAt||m.createdAt,workers:(m.workers||[]).map(w=>({...w,id:w.id||w.agentId})),routing:m.routing||null,timeline:m.timeline||[],results:m.results||[],error:m.error||'',raw:m}}
function ensureAgent(w){
 const id=w.id||w.agentId||w.name;if(!id)return;
 let a=agents.get(id),zone=zoneForWorker(w),target=workerTarget(w,zone);
 if(!a){const p=districtCenter('command'),style=ROLE_STYLE[id]||ROLE_STYLE[(w.agentId||'')]||ROLE_STYLE.synthesis;a={id,name:w.name||id,glyph:(w.name||id).trim()[0]?.toUpperCase()||'A',x:p.x,y:p.y,tx:p.x,ty:p.y,path:[],pathI:0,state:'pending',zone:'command',targetZone:zone,color:ROLE_COLOR[id]||'#8fb5e8',model:w.model||'',dir:1,bob:Math.random()*Math.PI*2,step:Math.random()*Math.PI*2,style,activitySeed:Math.random()*10,inside:false,insideZone:null,targetInside:false,transition:'idle'};agents.set(id,a)}
 const old=a.state;a.name=w.name||a.name;a.model=w.model||a.model;a.state=w.state||a.state;a.targetZone=zone;a.color=ROLE_COLOR[id]||a.color;
 if(a.zone!==zone||Math.hypot(a.tx-target.x,a.ty-target.y)>2||a.targetInside!==target.inside){a.tx=target.x;a.ty=target.y;a.targetInside=!!target.inside;a.transition=target.inside?'entering':(a.inside?'exiting':'traveling');a.path=routeToTarget(a,target,zone);a.pathI=0;a.zone=zone}
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
function loadReplay(){try{const saved=JSON.parse(localStorage.getItem(REPLAY_KEY)||'null');if(saved&&Array.isArray(saved.frames)){replay.frames=saved.frames.slice(-120);replay.index=Math.max(0,replay.frames.length-1);replay.speed=saved.speed||1;replay.sourceMissionId=saved.sourceMissionId||''}}catch{}}
function persistReplay(){try{localStorage.setItem(REPLAY_KEY,JSON.stringify({frames:replay.frames.slice(-120),speed:replay.speed,sourceMissionId:replay.sourceMissionId}))}catch{}}
function timelineMission(base,event){
 const m=normalizeMission(base),states=new Map((event.workers||[]).map(w=>[w.id,w]));
 m.status=event.status||m.status;m.updatedAt=event.at||m.updatedAt;m.workers=m.workers.map(w=>({...w,...(states.get(w.id)||{})}));
 return m
}
function primeMissionReplay(m){
 const timeline=m?.timeline||[];if(!timeline.length)return false;
 replay.frames=timeline.map((e,i)=>({at:Date.parse(e.at)||Date.now()+i,reason:e.type||'state',detail:e.detail||'',workerId:e.workerId||'',sig:e.sig||String(i),mission:timelineMission(m,e)})).slice(-120);
 replay.index=Math.max(0,replay.frames.length-1);replay.sourceMissionId=m.id||'';persistReplay();syncReplay();return true
}
function loadMissionReplay(m){if(!m)return;if(!primeMissionReplay(m)){const n=normalizeMission(m);replay.frames=[{at:Date.parse(n.updatedAt)||Date.now(),reason:'snapshot',detail:'Historical mission snapshot',workerId:'',sig:n.id,mission:n}];replay.index=0;replay.sourceMissionId=n.id||'';persistReplay();syncReplay()}addEvent('Replay loaded: '+(m.goal||m.id||'mission'))}
function recordReplayFrame(reason){
 if(replay.active||!current)return;const sig=(current.workers||[]).map(w=>w.id+':'+w.state).join('|')+'|'+current.status;const last=replay.frames.at(-1);if(last?.sig===sig)return;
 replay.frames.push({at:Date.now(),reason,detail:'',workerId:'',sig,mission:JSON.parse(JSON.stringify(current))});replay.frames=replay.frames.slice(-120);replay.index=replay.frames.length-1;replay.sourceMissionId=current.id||replay.sourceMissionId;persistReplay();syncReplay()
}
function replayEventClass(frame){const r=String(frame?.reason||'').toLowerCase();if(/error|attention|blocked|fail/.test(r))return'bad';if(/complete|result/.test(r))return'done';if(/handoff|dispatch|synthesis/.test(r))return'active';return'wait'}
function syncReplay(){
 if(!root)return;const range=$('#awcReplayRange',root),label=$('#awcReplayLabel',root),markers=$('#awcReplayMarkers',root),frame=replay.frames[replay.index];
 if(range){range.max=Math.max(0,replay.frames.length-1);range.value=replay.index;range.disabled=replay.frames.length<2}
 if(label)label.textContent=replay.frames.length?(replay.active?'Replay '+(replay.index+1)+' / '+replay.frames.length+' · '+String(frame?.reason||'state').replaceAll('-',' '):replay.frames.length+' event'+(replay.frames.length===1?'':'s')+' ready'):'0 events';
 if(markers){markers.innerHTML=replay.frames.map((f,i)=>`<button type="button" data-replay-index="${i}" class="${replayEventClass(f)} ${i===replay.index?'active':''}" title="${esc((f.reason||'state')+(f.detail?' — '+f.detail:''))}"></button>`).join('');markers.querySelectorAll('[data-replay-index]').forEach(b=>b.onclick=()=>applyReplayFrame(Number(b.dataset.replayIndex)))}
 $('#awcReplayPlay',root).textContent=replay.playing?'Pause':'Play';$('#awcReplaySpeed',root).textContent=replay.speed+'×';$('#awcReplayLive',root).hidden=!replay.active;
 const detail=$('#awcReplayDetail',root);if(detail)detail.textContent=frame?(new Date(frame.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})+' · '+(frame.detail||String(frame.reason||'state').replaceAll('-',' '))):'Select a mission from history to inspect its execution.'
}
function applyReplayFrame(i,preservePlaying=false){
 if(!replay.frames.length)return;const wasPlaying=replay.playing;replay.active=true;replay.playing=preservePlaying&&wasPlaying;replay.index=clamp(Number(i)||0,0,replay.frames.length-1);const frame=replay.frames[replay.index];agents.clear();artifacts=[];packets=[];sparks=[];dust=[];current=JSON.parse(JSON.stringify(frame.mission));sourceType='replay';current.workers.forEach(ensureAgent);selected=frame.workerId?{type:'agent',id:String(frame.workerId).split(',')[0]}:selected;syncHud();syncSelection();syncReplay()
}
function stepReplay(delta){if(!replay.frames.length)return;if(!replay.active)applyReplayFrame(replay.index);else applyReplayFrame(clamp(replay.index+delta,0,replay.frames.length-1));}
function toggleReplay(){if(replay.frames.length<2)return;if(!replay.active)applyReplayFrame(0);replay.playing=!replay.playing;replay.lastStep=now();syncReplay()}
function cycleReplaySpeed(){replay.speed=replay.speed===1?2:replay.speed===2?4:1;persistReplay();syncReplay()}
function returnReplayLive(){replay.active=false;replay.playing=false;if(liveSnapshot){agents.clear();current=liveSnapshot;sourceType='mission';current.workers.forEach(ensureAgent)}syncHud();syncSelection();syncReplay()}
function applyMission(m){
 if(!m||demo.active)return;const prev=current,next=normalizeMission(m),wasComplete=prev?.status==='complete';
 if(!prev||prev.id!==next.id){agents.clear();artifacts=[];packets=[];sparks=[];dust=[]}
 current=next;liveSnapshot=next;sourceType='mission';current.workers.forEach(ensureAgent);
 if(!prev||prev.id!==current.id)addEvent('Mission entered Agent World');
 if(next.timeline?.length)primeMissionReplay(next);else recordReplayFrame('mission');
 if(next.status==='complete'&&!wasComplete){const p=districtCenter('command');spawnSpark(p.x,p.y,'#75dfa2',54);celebrationUntil=now()+3600;addEvent('Mission complete · Command Center received final synthesis')}
 syncHud()
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
 $('#awcSource',root).textContent=sourceType.toUpperCase();$('#awcObjective',root).textContent=current?.goal||'No active mission';$('#awcObjective',root).title=current?.goal||'';root.dataset.state=bad?'attention':running?'running':current?.status==='complete'?'complete':workers.length?'waiting':'idle';$('#awcStage',root).textContent=stage.label;$('#awcStageDetail',root).textContent=stage.detail;$('#awcStatus',root).textContent=current?humanState(current.status):'Idle';$('#awcProgressText',root).textContent=workers.length?done+'/'+workers.length+' complete':'No workers';$('#awcProgress',root).style.width=(workers.length?Math.round(done/workers.length*100):0)+'%';$('#awcStatRun',root).textContent=running;$('#awcStatDone',root).textContent=done;$('#awcStatAlert',root).textContent=bad;$('#awcStatArtifacts',root).textContent=artifacts.length;$('#awcAttention',root).hidden=!bad;syncRoster()
}
function syncRoster(){
 const h=$('#awcRoster',root);if(!h)return;const workers=current?.workers||[];h.innerHTML=workers.length?workers.map(w=>{const s=ROLE_STYLE[w.id]||ROLE_STYLE[w.agentId]||ROLE_STYLE.synthesis;return `<button class="awc__rosterItem ${esc(w.state)}" data-awc-roster="${esc(w.id)}"><span class="awc__rosterGlyph" style="--worker:${esc(s.accent)}">${esc((s.badge||w.name||w.id||'?').slice(0,2))}</span><span><strong>${esc(w.name||w.id)}</strong><small>${esc(DISTRICTS[zoneForWorker(w)]?.short||zoneForWorker(w))} · ${esc(s.tool)}</small></span><em>${esc(humanState(w.state))}</em></button>`}).join(''):'<div class="awc__empty">No workers active.</div>';h.querySelectorAll('[data-awc-roster]').forEach(b=>b.onclick=()=>focusWorker(b.dataset.awcRoster))
}
function syncEventFeed(){if(!root)return;const h=$('#awcEventFeed',root);if(h)h.innerHTML=events.length?events.slice(0,4).map(e=>`<div><span>${esc(e.text)}</span><time>${e.at.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></div>`).join(''):'<div><span>Waiting for activity</span></div>'}
let externalFocus=false;
function syncSelection(){
 if(!root)return;const h=$('#awcSelection',root);if(!selected){h.innerHTML='<span>Select a worker or building</span><small>Inspect district state and focus the camera.</small>';return}
 if(selected.type==='agent'){const a=agents.get(selected.id);if(!a)return;const w=(current?.workers||[]).find(q=>(q.id||q.agentId)===a.id),rm=w?.routingMeta||{};h.innerHTML=`<strong>${esc(a.name)}</strong><small>${esc(humanState(a.state))} · ${esc(DISTRICTS[a.zone]?.name||a.zone)} · ${esc(a.model||'automatic model')}</small>${rm.capabilityScore!=null?`<small>Capability ${rm.capabilityScore}% · model ${rm.modelScore??'—'}% · ${esc(rm.availability||'available')} · deps ${rm.dependencyCount??0}</small>`:''}`;if(!externalFocus)window.dispatchEvent(new CustomEvent('localai:agentworld-select',{detail:{workerId:a.id}}))}
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
// Theater moves the frame to <body>: an ancestor of the Agents page creates a containing block that traps position:fixed.
let theaterHome=null;
function setTheaterHost(on){if(on&&!theaterHome){theaterHome=document.createComment('agent-world');root.before(theaterHome);document.body.appendChild(root)}else if(!on&&theaterHome){theaterHome.replaceWith(root);theaterHome=null}}
function toggleExpanded(){const on=!root.classList.contains('is-expanded');setTheaterHost(on);root.classList.toggle('is-expanded',on);document.body.classList.toggle('awc-stage-expanded',on);$('#awcExpand',root).textContent=on?'Exit theater':'Theater';setTimeout(()=>{if(on)focusActive();else fitWorld()},40)}
function exitExpanded(){if(!root?.classList.contains('is-expanded'))return;root.classList.remove('is-expanded');setTheaterHost(false);document.body.classList.remove('awc-stage-expanded');$('#awcExpand',root).textContent='Theater';fitWorld()}

function mount(){
 const host=$('#agentWorldCityMount');if(!host)return;root=document.createElement('section');root.className='awc awc-v3';root.dataset.state='idle';root.innerHTML=`
 <header class="awc__commandbar">
  <div class="awc__brand">
   <svg class="awc__mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M6 22a10 10 0 0 1 20 0z" fill="currentColor"/><rect x="4" y="22" width="24" height="4" rx="2" fill="currentColor"/><path d="M14 12h4v6h-4z" fill="#0b1624" opacity=".35"/></svg>
   <div class="awc__brandText"><div class="awc__titleRow"><h2 class="awc__title">Agent World</h2><span class="awc__live"><i></i><b id="awcSource">IDLE</b></span></div><div class="awc__sub">Mission construction crew</div></div>
  </div>
  <dl class="awc__topstats">
   <div class="awc__stat is-run"><dt>Working</dt><dd id="awcStatRun">0</dd></div>
   <div class="awc__stat is-done"><dt>Done</dt><dd id="awcStatDone">0</dd></div>
   <div class="awc__stat is-alert"><dt>Alerts</dt><dd id="awcStatAlert">0</dd></div>
   <div class="awc__stat is-art"><dt>Artifacts</dt><dd id="awcStatArtifacts">0</dd></div>
  </dl>
  <div class="awc__toolbar" role="toolbar" aria-label="Map controls">
   <div class="awc__group"><button id="awcFit" type="button" title="Show the whole city (0)">Fit</button><button id="awcCenter" type="button" title="Jump to the active worker (A)">Active</button><button id="awcFollow" type="button" aria-pressed="false" title="Keep the camera on the active worker (F)">Follow</button></div>
   <div class="awc__group"><button id="awcZoomOut" type="button" aria-label="Zoom out">−</button><span id="awcZoomLabel" aria-live="polite">100%</span><button id="awcZoomIn" type="button" aria-label="Zoom in">+</button></div>
   <div class="awc__group"><button type="button" data-awc-display="labels" aria-pressed="true">Labels</button><button type="button" data-awc-display="flows" aria-pressed="true">Flows</button><button type="button" data-awc-display="night" aria-pressed="false">Night</button></div>
   <div class="awc__group"><button id="awcCrewToggle" type="button" aria-pressed="true">Crew</button><button id="awcExpand" data-game-primary="true" type="button" title="Full-screen view (T)">Theater</button></div>
  </div>
 </header>
 <div class="awc__missionstrip">
  <div class="awc__missioncopy"><span class="awc__eyebrow">Objective</span><strong id="awcObjective">No active mission</strong></div>
  <div class="awc__phase"><span class="awc__phaseDot"></span><span><strong id="awcStage">Standing by</strong><small id="awcStageDetail">Waiting for mission activity</small></span></div>
  <div class="awc__missionstate">
   <div class="awc__missionstateTop"><b id="awcStatus">Idle</b><span id="awcProgressText">No workers</span><span class="awc__attention" id="awcAttention" hidden>Attention</span></div>
   <div class="awc__progress" aria-hidden="true"><span id="awcProgress"></span></div>
  </div>
 </div>
 <div class="awc__gameShell">
  <div class="awc__mapWrap">
   <canvas width="${W}" height="${H}" id="awcCanvas" tabindex="0" aria-label="Interactive Agent World map. Drag to pan, scroll or pinch to zoom, click a district or worker to inspect. Keys: 0 fit, A active worker, F follow, plus and minus zoom, T theater."></canvas>
   <div class="awc__scanlines"></div>
   <div class="awc__tooltip" id="awcTooltip" hidden></div>
   <div class="awc__mapHud">
    <div class="awc__selection" id="awcSelection"><span>Select a worker or building</span><small>Click to inspect</small></div>
    <div class="awc__minimap" id="awcMinimap" aria-hidden="true"></div>
   </div>
   <div class="awc__eventFeed" id="awcEventFeed" aria-live="polite"></div>
   <div class="awc__legend" aria-label="Map legend"><span><i class="run"></i>Running</span><span><i class="done"></i>Complete</span><span><i class="wait"></i>Waiting</span><span><i class="bad"></i>Attention</span><span><i class="dep"></i>Active dependency</span><span><i class="art"></i>Artifact</span></div>
  </div>
  <div class="awc__ops" role="complementary" aria-label="Mission details">
   <div class="awc__opsScroll">
    <section class="awc__section"><div class="awc__opsHead"><h3>Crew</h3><span class="awc__eyebrow">Live roster</span></div>
     <div class="awc__roster" id="awcRoster"><div class="awc__empty">No workers active.</div></div></section>
    <section class="awc__section"><div class="awc__opsHead"><h3>Districts</h3><span class="awc__eyebrow">Jump to</span></div>
     <div class="awc__districtLegend">${Object.entries(DISTRICTS).map(([id,d])=>`<button type="button" data-awc-district="${id}"><i style="--district:${d.accent}"></i><span>${d.short}</span></button>`).join('')}</div></section>
    <section class="awc__section awc__replayPanel"><div class="awc__opsHead"><h3>Replay</h3><strong id="awcReplayLabel">0 events</strong></div><div class="awc__replayMarkers" id="awcReplayMarkers"></div><input id="awcReplayRange" type="range" min="0" max="0" value="0" disabled aria-label="Mission replay position"><small id="awcReplayDetail">Select a mission from history to inspect its execution.</small><div class="awc__replayActions"><button id="awcReplayPrev" type="button" aria-label="Previous replay event">◀</button><button id="awcReplayPlay" type="button">Play</button><button id="awcReplayNext" type="button" aria-label="Next replay event">▶</button><button id="awcReplaySpeed" type="button">1×</button><button id="awcReplayLive" type="button" hidden>Live</button></div></section>
    <section class="awc__section awc__demoPanel"><div class="awc__opsHead"><h3>Simulation</h3><span class="awc__eyebrow">Try the city without a real mission</span></div><select id="awcDemoScenario" aria-label="Demo scenario"><option value="success">Successful mission</option><option value="failure">Failure and repair</option></select><div class="awc__demoActions"><button id="awcDemoPlay" type="button">Play</button><button id="awcDemoStep" type="button">Step</button><button id="awcDemoReset" type="button">Reset</button><button id="awcDemoSpeed" type="button">1×</button></div><button id="awcLiveBtn" class="awc__liveBtn" type="button" hidden>Return to live mission</button></section>
    <p class="awc__hint">Drag to pan, scroll or pinch to zoom, click a district or worker. Keys: 0 fit · A active · F follow · +/− zoom · T theater.</p>
   </div>
  </div>
 </div>`;
 host.appendChild(root);loadReplay();syncReplay();canvas=$('#awcCanvas',root);ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
 $('#awcReplayPrev',root).onclick=()=>stepReplay(-1);$('#awcReplayPlay',root).onclick=toggleReplay;$('#awcReplayNext',root).onclick=()=>stepReplay(1);$('#awcReplaySpeed',root).onclick=cycleReplaySpeed;$('#awcReplayLive',root).onclick=returnReplayLive;$('#awcReplayRange',root).oninput=e=>applyReplayFrame(e.target.value);$('#awcExpand',root).onclick=toggleExpanded;$('#awcCrewToggle',root).onclick=toggleCrew;$('#awcFollow',root).onclick=toggleFollow;$('#awcFit',root).onclick=fitWorld;$('#awcCenter',root).onclick=focusActive;$('#awcZoomIn',root).onclick=()=>zoomAt(1.2);$('#awcZoomOut',root).onclick=()=>zoomAt(.84);$('#awcDemoPlay',root).onclick=toggleDemoPlay;$('#awcDemoStep',root).onclick=stepDemo;$('#awcDemoReset',root).onclick=resetDemo;$('#awcDemoSpeed',root).onclick=cycleSpeed;$('#awcLiveBtn',root).onclick=returnLive;$('#awcDemoScenario',root).onchange=e=>{demo.scenario=e.target.value;if(demo.active)applyDemo()};
 root.querySelectorAll('[data-awc-display]').forEach(b=>b.onclick=()=>toggleDisplay(b.dataset.awcDisplay));root.querySelectorAll('[data-awc-district]').forEach(b=>b.onclick=()=>{selected={type:'district',id:b.dataset.awcDistrict};syncSelection();const d=DISTRICTS[b.dataset.awcDistrict];focusPoint((d.x+d.w/2)*T,(d.y+d.h/2)*T,1.7)});
 canvas.addEventListener('wheel',e=>{e.preventDefault();const p=screenPoint(e);zoomAt(e.deltaY<0?1.12:.89,p.px,p.py)},{passive:false});
 canvas.addEventListener('pointerdown',e=>{try{canvas.setPointerCapture(e.pointerId)}catch{}const p=screenPoint(e);pointers.set(e.pointerId,{x:p.px,y:p.py});if(pointers.size===1){drag={id:e.pointerId,startX:p.px,startY:p.py,panX:view.targetPanX,panY:view.targetPanY,moved:false};pinch=null}else if(pointers.size===2){const ps=[...pointers.values()],dx=ps[1].x-ps[0].x,dy=ps[1].y-ps[0].y;pinch={distance:Math.max(1,Math.hypot(dx,dy)),zoom:view.targetZoom,panX:view.targetPanX,panY:view.targetPanY,cx:(ps[0].x+ps[1].x)/2,cy:(ps[0].y+ps[1].y)/2};drag=null}});
 canvas.addEventListener('pointermove',e=>{updateHover(e);if(!pointers.has(e.pointerId))return;const r=canvas.getBoundingClientRect(),sx=W/r.width,sy=H/r.height,px=(e.clientX-r.left)*sx,py=(e.clientY-r.top)*sy;pointers.set(e.pointerId,{x:px,y:py});if(pointers.size===2&&pinch){const ps=[...pointers.values()],dx=ps[1].x-ps[0].x,dy=ps[1].y-ps[0].y,dist=Math.max(1,Math.hypot(dx,dy)),cx=(ps[0].x+ps[1].x)/2,cy=(ps[0].y+ps[1].y)/2,nz=clamp(pinch.zoom*(dist/pinch.distance),1,3),wx=(pinch.cx-pinch.panX)/pinch.zoom,wy=(pinch.cy-pinch.panY)/pinch.zoom;view.targetZoom=nz;view.targetPanX=cx-wx*nz;view.targetPanY=cy-wy*nz;limitTargetPan();syncZoomLabel();return}if(!drag||drag.id!==e.pointerId)return;const dx=px-drag.startX,dy=py-drag.startY;if(Math.abs(dx)+Math.abs(dy)>4)drag.moved=true;view.targetPanX=drag.panX+dx;view.targetPanY=drag.panY+dy;limitTargetPan()});
 canvas.addEventListener('pointerup',e=>{const wasSingle=pointers.size===1,moved=drag?.moved||false;pointers.delete(e.pointerId);if(wasSingle&&!moved)selectAt(e);if(pointers.size===1){const[id,p]=[...pointers.entries()][0];drag={id,startX:p.x,startY:p.y,panX:view.targetPanX,panY:view.targetPanY,moved:true}}else drag=null;if(pointers.size<2)pinch=null});
 canvas.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);drag=null;if(pointers.size<2)pinch=null});canvas.addEventListener('pointerleave',()=>{const t=$('#awcTooltip',root);if(t)t.hidden=true});
 canvas.addEventListener('keydown',e=>{if(e.key==='+'||e.key==='=')zoomAt(1.2);if(e.key==='-')zoomAt(.84);if(e.key==='0')fitWorld();if(e.key==='f')toggleFollow();if(e.key==='a')focusActive();if(e.key==='t')toggleExpanded();if(e.key==='Enter'&&hovered){selected=hovered;syncSelection()}});document.addEventListener('keydown',e=>{if(e.key==='Escape')exitExpanded()});
 // The Agents panel answers our select event with a focus event; don't echo it back as another select.
 window.addEventListener('localai:agentworld-focus',e=>{externalFocus=true;try{focusWorker(e.detail?.workerId)}finally{externalFocus=false}});
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
  if(d<3){a.pathI++;if(a.pathI>=a.path.length){a.inside=!!a.targetInside;a.insideZone=a.inside?a.zone:null;a.transition=a.inside?'working':'idle';a.motion=a.state==='running'?'working':'idle';a.arrivedAt=ts;spawnSpark(a.x,a.y,a.inside?'#71b7ff':'#f5c04f',5)}continue}
  a.dir=dx<0?-1:1;
  const base=running?150:64,arrival=a.pathI>=a.path.length-1?clamp(d/42,.45,1):1,speed=base*arrival;
  a.x+=dx/d*speed*dt;a.y+=dy/d*speed*dt;
  if(running)spawnRunDust(a,ts)
 }
 for(const p of packets){if(p.done||!p.path[p.i])continue;const t=p.path[p.i],dx=t.x-p.x,dy=t.y-p.y,d=Math.hypot(dx,dy);if(d<3){p.i++;if(p.i>=p.path.length){p.done=true;spawnSpark(p.x,p.y,p.color,8);if(p.label==='HANDOFF')addEvent('Handoff received')}continue}p.x+=dx/d*150*dt;p.y+=dy/d*150*dt}packets=packets.filter(p=>!p.done);
 updateConstruction(dt,ts);updateCrew(dt);
 for(const s of sparks){s.x+=s.vx*dt;s.y+=s.vy*dt;s.vy+=90*dt;s.life-=dt}sparks=sparks.filter(s=>s.life>0);for(const d of dust){d.x+=d.vx*dt;d.y+=d.vy*dt;d.r+=dt*5;d.life-=dt}dust=dust.filter(d=>d.life>0);
 for(const c of traffic){if(c.axis==='x'){c.x+=c.v*c.dir*dt;if(c.x>38*T)c.x=2*T;if(c.x<2*T)c.x=38*T}else{c.y+=c.v*c.dir*dt;if(c.y>23*T)c.y=3*T;if(c.y<3*T)c.y=23*T}}
 if(demo.active&&demo.running&&!demo.paused&&!reduced&&ts-demo.lastAdvance>3200/demo.speed){if(demo.stage<DEMO_STAGES.length-1){demo.stage++;applyDemo();recordReplayFrame('demo');demo.lastAdvance=ts}else demo.running=false;syncDemoControls()}
 if(replay.active&&replay.playing&&ts-replay.lastStep>1200/replay.speed){if(replay.index<replay.frames.length-1){replay.index++;const f=replay.frames[replay.index];agents.clear();artifacts=[];packets=[];sparks=[];dust=[];current=JSON.parse(JSON.stringify(f.mission));sourceType='replay';current.workers.forEach(ensureAgent);selected=f.workerId?{type:'agent',id:String(f.workerId).split(',')[0]}:selected;syncHud();syncSelection();replay.lastStep=ts;syncReplay()}else{replay.playing=false;syncReplay()}}
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
function drawDistrictScene(id,d,ts){
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,pulse=(Math.sin(ts/420)+1)/2;
 // paved service apron and pedestrian path to the door
 px(x+w*.32,y+h+8,w*.36,14,display.night?'#2a3337':'#7a786c');px(x+w/2-3,y+h,6,24,display.night?'#3c4547':'#9a9583');
 if(id==='command'){
  px(x+w/2-34,y-18,68,10,'#23384d');px(x+w/2-2,y-36,4,18,'#5f7689');ctx.fillStyle='#71b7ff';ctx.beginPath();ctx.arc(x+w/2,y-39,4+pulse*2,0,Math.PI*2);ctx.fill();
  for(const dx of[-34,28]){px(x+w/2+dx,y+h+27,6,18,'#55432d');px(x+w/2+dx-6,y+h+23,18,5,'#6e5a3d')}
 }else if(id==='ux'){
  px(x-24,y+24,18,54,'#254b55');px(x-21,y+28,12,18,'#59e2ed');px(x-21,y+51,12,18,'#315f69');
  for(let i=0;i<3;i++){px(x+18+i*32,y+h+24,24,5,'#74624c');px(x+20+i*32,y+h+29,3,9,'#493a2d');px(x+37+i*32,y+h+29,3,9,'#493a2d')}
 }else if(id==='docs'){
  for(let i=0;i<4;i++){px(x+w+10,y+18+i*20,22,14,'#493f5a');px(x+w+13,y+21+i*20,4,8,'#c498ff');px(x+w+20,y+21+i*20,3,8,'#8db7ff')}
 }else if(id==='engineering'){
  px(x-30,y+h-20,26,18,'#5d4a32');px(x-27,y+h-17,20,4,'#ffb86a');
  for(let i=0;i<3;i++){px(x+18+i*30,y+h+27,22,8,'#54442f');px(x+22+i*30,y+h+20,14,7,'#8c744e')}
 }else if(id==='validation'){
  for(let i=0;i<3;i++){const gx=x+18+i*38;px(gx,y+h+22,28,4,'#75dfa2');px(gx,y+h+8,3,18,'#486c59');px(gx+25,y+h+8,3,18,'#486c59')}
  ctx.save();ctx.globalAlpha=.18+.12*pulse;ctx.fillStyle='#75dfa2';ctx.fillRect(x+8,y+18,w-16,4);ctx.restore()
 }else if(id==='models'){
  for(let i=0;i<4;i++){const sx=x+12+i*42;px(sx,y+h+20,28,22,'#182838');px(sx+4,y+h+24,20,3,'#ff8494');px(sx+4,y+h+31,20,3,'#71b7ff')}
  ctx.strokeStyle='#ff8494';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x+w-18,y-14,10,Math.PI,Math.PI*2);ctx.stroke()
 }else if(id==='projects'){
  for(let i=0;i<5;i++){px(x+12+i*42,y+h+22,30,7,'#405f95');px(x+16+i*42,y+h+29,4,12,'#2b3d5d');px(x+34+i*42,y+h+29,4,12,'#2b3d5d')}
 }else if(id==='repair'){
  for(let i=0;i<7;i++)px(x-12+i*16,y+h+20,10,5,i%2?'#1e2024':'#ffb23d');
  ctx.fillStyle='rgba(255,115,131,'+(.28+.25*pulse)+')';ctx.beginPath();ctx.arc(x+w+16,y+18,8,0,Math.PI*2);ctx.fill();px(x+w+14,y+2,4,16,'#6c3940')
 }
}
function drawInterior(id,d,ts){
 const workers=[...agents.values()].filter(a=>a.inside&&a.insideZone===id&&!a.onSite),active=workers.length>0;if(!active)return;
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,pulse=(Math.sin(ts/220)+1)/2;
 ctx.save();const lvl=buildLevel(id);if(lvl<.995){ctx.beginPath();ctx.rect(x-20,y+h-h*lvl,w+40,h);ctx.clip()}ctx.globalAlpha=.96;px(x+8,y+24,w-16,h-36,display.night?'#0c1720':'#15232b');ctx.globalAlpha=1;
 // floor grid and role stations
 ctx.strokeStyle='rgba(255,255,255,.055)';ctx.lineWidth=1;for(let xx=x+16;xx<x+w-14;xx+=22){ctx.beginPath();ctx.moveTo(xx,y+28);ctx.lineTo(xx,y+h-16);ctx.stroke()}
 for(let yy=y+34;yy<y+h-18;yy+=20){ctx.beginPath();ctx.moveTo(x+12,yy);ctx.lineTo(x+w-12,yy);ctx.stroke()}
 const stations=workers.map(a=>({a,x:a.tx,y:a.ty}));for(const s of stations){px(s.x-15,s.y+12,30,6,'#324150');px(s.x-12,s.y+5,24,8,'#1c2a35');px(s.x-8,s.y+1,16,5,roleStyle(s.a).accent);if(s.a.state==='running'){ctx.strokeStyle=roleStyle(s.a).accent;ctx.globalAlpha=.35+.3*pulse;ctx.strokeRect(s.x-18,s.y-22,36,43);ctx.globalAlpha=1}}
 const door=districtDoor(id);px(door.inside.x-10,door.inside.y-5,20,9,'#09121a');ctx.strokeStyle=d.accent;ctx.strokeRect(door.inside.x-11,door.inside.y-6,22,11);
 ctx.restore()
}

function districtWorkers(id){return current?.workers?.filter(q=>zoneForWorker(q)===id)||[]}
// ---- Construction: buildings rise with their district's progress ---------------------------------------
// Each district with crew has a build level (0 = foundation, 1 = finished). It eases toward the real progress
// and creeps upward while a worker is running, so you can watch floors go up. Districts without crew are
// finished buildings. Failed or blocked districts show damage and a repair crew instead.
const build={};let buildMission='';
function buildState(id){return build[id]||(build[id]={level:.12,topped:0,placed:-1,lastSpark:0})}
function districtFlags(id){const w=districtWorkers(id);return{workers:w,active:w.some(q=>q.state==='running'),bad:w.some(q=>['error','blocked'].includes(q.state)),done:w.length>0&&w.every(q=>q.state==='complete')}}
function buildLevel(id){const f=districtFlags(id);return f.workers.length?buildState(id).level:1}
function updateConstruction(dt,ts){
 const key=current?.id||current?.goal||'';if(key!==buildMission){buildMission=key;for(const k of Object.keys(build))delete build[k]}
 for(const[id,d]of Object.entries(DISTRICTS)){
  const f=districtFlags(id);if(!f.workers.length)continue;const b=buildState(id);
  let target=f.done?1:.12+.83*districtProgress(id);
  if(f.active)target=Math.max(target,Math.min(.95,b.level+.035));
  b.level+=(target-b.level)*Math.min(1,dt*(f.done?1.4:.9));
  const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,top=y+h-h*b.level;
  if(f.active&&b.level<.995&&ts-b.lastSpark>140){b.lastSpark=ts;spawnSpark(x+10+Math.random()*(w-20),top,Math.random()<.5?'#ffd36b':'#ffffff',3)}
  if(f.done&&!b.topped&&b.level>.97){b.topped=ts;spawnSpark(x+w/2,y+4,'#3ed598',18);spawnSpark(x+w/2,y+4,'#ffb224',12);addEvent(d.name+' topped out')}
  if(!f.done)b.topped=0
 }
}
// Steel frame above the finished floors, plus the glowing line where new floors are being added.
function drawSkeleton(d,x,y,w,h,top,bad,ts){
 const steel=bad?'rgba(160,172,186,.55)':'rgba(255,178,36,.78)',depth=14;
 ctx.save();ctx.strokeStyle=steel;ctx.lineWidth=2;
 for(let xx=x+2;xx<=x+w;xx+=22){ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,y+8);ctx.stroke()}
 ctx.beginPath();ctx.moveTo(x+w,top);ctx.lineTo(x+w,y+8);ctx.lineTo(x+w+depth,y);ctx.lineTo(x+w+depth,Math.min(y+h-depth,top-8));ctx.stroke();
 ctx.lineWidth=1.5;for(let yy=top-18;yy>y+4;yy-=18){ctx.beginPath();ctx.moveTo(x,yy);ctx.lineTo(x+w,yy);ctx.lineTo(x+w+depth,yy-8);ctx.stroke()}
 ctx.beginPath();ctx.moveTo(x,y+8);ctx.lineTo(x+w,y+8);ctx.lineTo(x+w+depth,y);ctx.stroke();
 ctx.globalAlpha=.35;for(let xx=x+2;xx<x+w-20;xx+=44){ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx+22,Math.max(y+8,top-18));ctx.stroke()}
 ctx.restore();
 const glow=.55+.45*Math.sin(ts/180);ctx.save();ctx.shadowColor=bad?'#ff6b6b':'#ffb224';ctx.shadowBlur=10*glow;px(x-2,top-2,w+4,3,bad?'#ff9b9b':'#ffd27a');ctx.restore()
}
// Tower crane that lifts steel beams from the pallet to the top of the frame.
function drawCrane(id,d,x,y,w,h,top,active,bad,ts){
 const mastX=x+w+24,base=y+h+4,jibY=y-38,jibL=x+4,jibR=mastX+30,steel=bad?'#7b5560':'#e3a22a',dark=bad?'#4d2b33':'#7a5414';
 ctx.save();
 // mast lattice
 px(mastX-4,jibY,3,base-jibY,steel);px(mastX+5,jibY,3,base-jibY,steel);ctx.strokeStyle=steel;ctx.lineWidth=1;ctx.beginPath();for(let yy=jibY;yy<base-8;yy+=10){ctx.moveTo(mastX-3,yy);ctx.lineTo(mastX+6,yy+10);ctx.moveTo(mastX+6,yy);ctx.lineTo(mastX-3,yy+10)}ctx.stroke();
 px(mastX-10,base-4,24,6,'#3b4a58');
 // jib, counter-jib, counterweight, cab, tie lines
 px(jibL,jibY-2,jibR-jibL,4,steel);px(mastX+14,jibY-1,18,9,'#55606b');px(mastX-6,jibY+3,14,10,'#203448');px(mastX-4,jibY+5,7,5,bad?'#ff6b6b':'#9fd8ff');
 ctx.strokeStyle=dark;ctx.beginPath();ctx.moveTo(mastX+1,jibY-16);ctx.lineTo(jibL+20,jibY-2);ctx.moveTo(mastX+1,jibY-16);ctx.lineTo(jibR,jibY-2);ctx.stroke();px(mastX,jibY-18,3,16,steel);
 const blink=Math.floor(ts/500)%2===0;px(mastX,jibY-22,3,3,bad?(blink?'#ff6b6b':'#4d1d22'):(blink?'#ff4d4d':'#5a1616'));
 // load cycle
 const pickX=x+w+8,P=4600,t=ts+(id.length*977),cycle=Math.floor(t/P),p=(t%P)/P,b=buildState(id);
 const targetX=x+16+((cycle*37)%Math.max(24,w-40));let tx=pickX,hy=base-10,load=false;
 if(active&&!bad){
  if(p<.2){tx=pickX;hy=jibY+12+(base-10-jibY-12)*(p/.2);load=p>.12}
  else if(p<.45){const k=(p-.2)/.25;tx=pickX+(targetX-pickX)*k;hy=base-10-(base-10-(jibY+16))*Math.min(1,k*1.6);load=true}
  else if(p<.65){const k=(p-.45)/.2;tx=targetX;hy=jibY+16+(top-6-(jibY+16))*k;load=true}
  else{const k=(p-.65)/.35;tx=targetX+(pickX-targetX)*k;hy=top-6-(top-6-(jibY+12))*Math.min(1,k*2);load=false;if(b.placed!==cycle){b.placed=cycle;spawnSpark(targetX,top-4,'#ffd36b',10);for(let i=0;i<5;i++)dust.push({x:targetX+(Math.random()-.5)*20,y:top,vx:(Math.random()-.5)*20,vy:-8,r:2,life:.5})}}
 }else{tx=mastX-26;hy=jibY+18}
 px(tx-5,jibY+1,10,4,'#2a3a49');ctx.strokeStyle='#c8d3dd';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(tx,jibY+5);ctx.lineTo(tx,hy);ctx.stroke();px(tx-3,hy,6,4,'#f0c24a');
 if(load){px(tx-13,hy+4,26,5,steel);px(tx-13,hy+4,3,5,dark);px(tx+10,hy+4,3,5,dark);ctx.strokeStyle='rgba(200,211,221,.7)';ctx.beginPath();ctx.moveTo(tx,hy+4);ctx.lineTo(tx-10,hy+4);ctx.moveTo(tx,hy+4);ctx.lineTo(tx+10,hy+4);ctx.stroke()}
 ctx.restore()
}
// Pallets, rebar, a cement mixer and a hazard barrier beside a building under construction.
function drawMaterials(x,y,w,h,active,ts){
 const gy=y+h+4;
 for(let r=0;r<3;r++)for(let c=0;c<3-r;c++)px(x+w+4+c*5+r*2,gy-4-r*4,5,4,r%2?'#b4593f':'#c96a4a');px(x+w+2,gy,18,3,'#6b5434');
 for(let i=0;i<4;i++)px(x-34+i*2,gy-2-i,22,2,'#7d8893');
 const mx=x-24,my=gy-16,rot=active?ts/260:0;px(mx-12,my+12,26,4,'#2f3a44');ctx.save();ctx.translate(mx,my+4);ctx.rotate(-.35);ctx.fillStyle='#d9dde2';ctx.beginPath();ctx.ellipse(0,0,11,8,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#e3a22a';ctx.lineWidth=2;for(let i=0;i<3;i++){const a=rot+i*2.1;ctx.beginPath();ctx.moveTo(Math.cos(a)*10,Math.sin(a)*6);ctx.lineTo(Math.cos(a+1)*10,Math.sin(a+1)*6);ctx.stroke()}ctx.restore();px(mx-10,my+14,4,4,'#222');px(mx+6,my+14,4,4,'#222');
 for(let i=0;i<w;i+=10)px(x+i,y+h+1,5,3,i%20?'#1b1b1b':'#ffb224');
}
// Damage on a failed district: cracked panels, smoke and sparks from the repair crew.
function drawDamage(x,y,w,h,repairing,ts){
 ctx.save();ctx.strokeStyle='rgba(10,14,20,.85)';ctx.lineWidth=2;
 for(const[cx,cy]of[[.28,.38],[.66,.55],[.45,.78]]){const ox=x+w*cx,oy=y+h*cy;ctx.beginPath();ctx.moveTo(ox-10,oy-6);ctx.lineTo(ox-3,oy);ctx.lineTo(ox-6,oy+5);ctx.lineTo(ox+4,oy+9);ctx.lineTo(ox+10,oy+4);ctx.stroke();px(ox-4,oy-1,7,6,'rgba(255,107,107,.25)')}
 for(let i=0;i<5;i++){const k=((ts/1700)+i/5)%1;ctx.globalAlpha=(1-k)*.35;ctx.fillStyle='#9aa4ae';ctx.beginPath();ctx.arc(x+w*.3+Math.sin(k*6+i)*6,y+14-k*46,4+k*9,0,Math.PI*2);ctx.fill()}
 ctx.restore();
 if(repairing&&Math.random()<.35)spawnSpark(x+w*.66,y+h*.55,Math.random()<.5?'#9fd8ff':'#ffffff',2)
}
// Green pennant on the roof once a district's work is complete.
function drawTopping(x,y,w,ts){const fx=x+w-14,fy=y-14,wave=Math.sin(ts/200)*2;px(fx,fy,2,20,'#cfd8e0');pathPoly([[fx+2,fy],[fx+16,fy+4+wave],[fx+2,fy+9]],'#3ed598')}
function drawBuilding(id,d,ts){
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,depth=14,workers=districtWorkers(id),active=workers.some(q=>q.state==='running'),bad=workers.some(q=>['error','blocked'].includes(q.state)),done=workers.length&&workers.every(q=>q.state==='complete'),selectedDistrict=selected?.type==='district'&&selected.id===id,pulse=(Math.sin(ts/240)+1)/2;
 const level=buildLevel(id),under=level<.995,top=y+h-h*level;
 ctx.save();
 ctx.shadowColor='rgba(0,0,0,.35)';ctx.shadowBlur=18;px(x+8,y+12,w-2,h-2,'rgba(0,0,0,.28)');ctx.shadowBlur=0;
 px(x-4,y+h-6,w+depth+8,8,display.night?'#2a333b':'#59616a');
 // Only the finished floors are solid; the rest is drawn as a steel frame below.
 ctx.save();if(under){ctx.beginPath();ctx.rect(x-40,top,w+depth+80,h+80);ctx.clip()}
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
 ctx.restore();
 if(under)drawSkeleton(d,x,y,w,h,top,bad,ts);
 // Damage sits on whatever has been built so far.
 if(bad){const by=Math.max(y,top);drawDamage(x,by,w,y+h-by,workers.some(q=>q.state==='running'),ts)}
 if(done&&!under)drawTopping(x,y,w,ts);
 if(display.labels){const tag=workers.length&&(under||bad)?d.name+'  '+(bad?'repair ':'')+Math.round(level*100)+'%':d.name;ctx.fillStyle='rgba(6,11,17,.88)';ctx.fillRect(x+4,y-21,Math.min(w+depth,tag.length*7+18),17);txt(tag,x+10,y-12,bad?'#ffb0b0':active?'#fff':'#c6d4e1',9,'left')}
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
 const workers=districtWorkers(id),active=workers.some(w=>w.state==='running'),bad=workers.some(w=>['error','blocked'].includes(w.state)),progress=districtProgress(id);if(!workers.length)return;
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,level=buildLevel(id),under=level<.995,top=y+h-h*level;
 if(under||active||bad){
  for(let i=0;i<3;i++){const cx=x+16+i*18,cy=y+h+12;pathPoly([[cx,cy],[cx+5,cy-10],[cx+10,cy]],bad?'#ff7383':'#f5a623');px(cx+2,cy-5,6,2,'#fff3b0')}
  // scaffolding up to the working height
  ctx.strokeStyle=bad?'rgba(255,115,131,.55)':'rgba(205,215,225,.5)';ctx.lineWidth=1.5;const sTop=Math.min(y+h-8,top-6);
  for(const sx of[x-10,x+w+2]){ctx.strokeRect(sx,sTop,8,y+h-sTop);for(let yy=sTop;yy<y+h-6;yy+=14){ctx.beginPath();ctx.moveTo(sx,yy);ctx.lineTo(sx+8,yy+14);ctx.stroke();px(sx-1,yy,10,2,'#8b6a3c')}}
 }
 if(under)drawMaterials(x,y,w,h,active,ts);
 for(const a of agents.values())if(a.onSite&&a.zone===id&&(a.climbing||a.y<y+h-40))drawLadder(x+8,y+h,Math.max(y+8,top-2));
 if(under||active)drawCrane(id,d,x,y,w,h,top,active,bad,ts);
 px(x,y+h+19,w,5,'rgba(5,10,16,.7)');px(x,y+h+19,w*(under?level:progress||1),5,bad?'#ff7383':level>=.995?'#3ed598':'#ffb224')
}
// ---- Crew at work: running workers leave the interior and work on the site --------------------------
// A running worker whose district is under construction stands on the top finished floor (or at the damage
// when repairing). Their real position moves, so selection and tooltips still follow them.
function siteSpot(a){
 const d=DISTRICTS[a.zone];if(!d)return null;const f=districtFlags(a.zone),lvl=buildLevel(a.zone);if(a.state!=='running'||workerIsMoving(a)||!a.inside)return null;
 if(!(lvl<.995||f.bad))return null;const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,top=y+h-h*lvl;
 const sx=clamp(a.tx??x+w/2,x+16,x+w-16);
 return f.bad&&lvl>=.995?{x:sx,y:y+h*.55-12}:{x:sx,y:Math.max(y+14,top)-20}
}
function updateCrew(dt){
 for(const a of agents.values()){
  const spot=siteSpot(a);
  if(spot){a.onSite=true;const dy=spot.y-a.y;a.climbing=Math.abs(dy)>3;a.x+=(spot.x-a.x)*Math.min(1,dt*4);a.y+=dy*Math.min(1,dt*(a.climbing?2.2:6))}
  else if(a.onSite&&!workerIsMoving(a)){const home={x:a.tx??a.x,y:a.ty??a.y},dy=home.y-a.y;a.climbing=Math.abs(dy)>3;a.x+=(home.x-a.x)*Math.min(1,dt*4);a.y+=dy*Math.min(1,dt*2.2);if(Math.hypot(home.x-a.x,dy)<1.5){a.onSite=false;a.climbing=false}}
  else if(workerIsMoving(a)){a.onSite=false;a.climbing=false}
 }
}
function siteTrade(a){
 if(districtFlags(a.zone).bad)return'repair';
 const tool=roleStyle(a).tool;
 return{wrench:'hammer',scanner:'weld',tablet:'glass',crate:'bricks',clipboard:'blueprint',holo:'signal',headset:'signal',radio:'signal'}[tool]||'hammer'
}
function drawLadder(x,y1,y2){ctx.save();ctx.strokeStyle='#c9a46a';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x-5,y1);ctx.lineTo(x-5,y2);ctx.moveTo(x+5,y1);ctx.lineTo(x+5,y2);for(let yy=y2+3;yy<y1;yy+=6){ctx.moveTo(x-5,yy);ctx.lineTo(x+5,yy)}ctx.stroke();ctx.restore()}
function drawSiteWork(a,ts){
 const x=a.x,y=a.y,seed=a.activitySeed||0,sx=x+9,sy=y-6,trade=siteTrade(a),s=roleStyle(a);
 const arm=(ang,len=13)=>{const hx=sx+Math.cos(ang)*len,hy=sy+Math.sin(ang)*len;ctx.strokeStyle=s.skin;ctx.lineWidth=6;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(hx,hy);ctx.stroke();ctx.fillStyle='#f2b23d';ctx.beginPath();ctx.arc(hx,hy,3.5,0,Math.PI*2);ctx.fill();return{hx,hy}};
 if(a.climbing){const k=Math.sin(ts/110+seed);arm(-1.9+k*.5,12);return}
 if(trade==='hammer'){
  const t=((ts/520)+seed)%1,ang=t<.72?-.4-1.9*(t/.72):-2.3+2.3*((t-.72)/.28),{hx,hy}=arm(ang);
  const hx2=hx+Math.cos(ang)*9,hy2=hy+Math.sin(ang)*9;ctx.strokeStyle='#8b5a2b';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(hx,hy);ctx.lineTo(hx2,hy2);ctx.stroke();
  ctx.save();ctx.translate(hx2,hy2);ctx.rotate(ang+Math.PI/2);px(-5,-3,10,5,'#9aa6b1');ctx.restore();
  const cyc=Math.floor((ts/520)+seed);if(t>.96&&a.lastStrike!==cyc){a.lastStrike=cyc;spawnSpark(x+20,y+16,'#ffd36b',5);dust.push({x:x+20,y:y+18,vx:6,vy:-6,r:2,life:.45})}
 }else if(trade==='weld'){
  px(x-8,y-24,16,7,'#1d2a33');px(x-6,y-23,12,4,'#2f8fa8');
  const {hx,hy}=arm(-.15);ctx.strokeStyle='#4b5866';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(hx,hy);ctx.lineTo(hx+8,hy+5);ctx.stroke();
  const fl=Math.random();ctx.save();ctx.shadowColor='#bfefff';ctx.shadowBlur=16+fl*12;ctx.fillStyle=fl>.5?'#ffffff':'#bfefff';ctx.beginPath();ctx.arc(hx+9,hy+6,2+fl*2.5,0,Math.PI*2);ctx.fill();ctx.restore();
  if(fl>.55)spawnSpark(hx+9,hy+6,fl>.8?'#ffffff':'#ffb224',2)
 }else if(trade==='glass'){
  const t=((ts/1600)+seed)%1,lift=Math.sin(t*Math.PI)*6;arm(-1.25);
  ctx.save();ctx.globalAlpha=.75;px(x+4,y-34-lift,18,20,'#5fd3e8');ctx.globalAlpha=1;ctx.strokeStyle='#d8f6ff';ctx.lineWidth=1;ctx.strokeRect(x+4,y-34-lift,18,20);
  if(t>.45&&t<.55){ctx.strokeStyle='rgba(255,255,255,.9)';ctx.beginPath();ctx.moveTo(x+7,y-30-lift);ctx.lineTo(x+13,y-24-lift);ctx.stroke()}ctx.restore()
 }else if(trade==='bricks'){
  const t=((ts/1300)+seed)%1,up=Math.sin(t*Math.PI);const {hx,hy}=arm(-.3-1.1*up);px(hx-6,hy-8,12,8,'#c96a4a');px(hx-6,hy-5,12,1,'#8a3f2b');
  if(t>.48&&t<.52)dust.push({x:hx,y:hy-2,vx:0,vy:-4,r:1.5,life:.35})
 }else if(trade==='blueprint'){
  px(x-4,y-8,26,12,'#2c5aa0');ctx.strokeStyle='rgba(255,255,255,.75)';ctx.lineWidth=1;ctx.strokeRect(x-1,y-6,8,7);ctx.beginPath();ctx.moveTo(x+9,y-4);ctx.lineTo(x+19,y-4);ctx.moveTo(x+9,y);ctx.lineTo(x+16,y);ctx.stroke();
  const t=Math.sin(ts/260+seed);const {hx,hy}=arm(.25+t*.35,12);px(hx-1,hy-6,2,7,'#f2d06b')
 }else if(trade==='signal'){
  const w=Math.sin(ts/170+seed);arm(-1.75+w*.35,14);px(x-17,y-20,5,9,'#16222c');px(x-16,y-18,3,2,s.accent);
  ctx.save();ctx.strokeStyle=s.accent;ctx.lineWidth=1.5;for(let i=0;i<3;i++){const k=((ts/700)+i/3)%1;ctx.globalAlpha=(1-k)*.8;ctx.beginPath();ctx.arc(x-15,y-22,4+k*12,-2.4,-.8);ctx.stroke()}ctx.restore()
 }else{
  const ang=-.6+Math.sin(ts/140+seed)*.7,{hx,hy}=arm(-.2);ctx.save();ctx.translate(hx+4,hy);ctx.rotate(ang);ctx.strokeStyle='#d5dee8';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(10,0);ctx.stroke();ctx.beginPath();ctx.arc(12,0,3.5,0,Math.PI*2);ctx.stroke();ctx.restore();
  if(Math.random()<.25)spawnSpark(hx+12,hy,Math.random()<.5?'#ff9b9b':'#ffffff',2)
 }
}
function drawWorkingAction(a,ts){
 if(a.onSite){drawSiteWork(a,ts);return}
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
  ctx.fillStyle=s.skin;ctx.beginPath();ctx.ellipse(x-14,y-2-walk*.25,5,9,-.15,0,Math.PI*2);ctx.fill();if(!a.onSite){ctx.beginPath();ctx.ellipse(x+14,y-2+walk*.25,5,9,.15,0,Math.PI*2);ctx.fill()}
  ctx.fillStyle='#f2b23d';ctx.beginPath();ctx.arc(x-15,y+5-walk*.25,4,0,Math.PI*2);ctx.fill();if(!a.onSite){ctx.beginPath();ctx.arc(x+15,y+5+walk*.25,4,0,Math.PI*2);ctx.fill()}
  px(x-4,y-14,8,5,s.skin);ctx.fillStyle=s.skin;ctx.beginPath();ctx.roundRect(x-10,y-27,20,15,6);ctx.fill();ctx.beginPath();ctx.arc(x-10,y-20,3,0,Math.PI*2);ctx.arc(x+10,y-20,3,0,Math.PI*2);ctx.fill();
  px(x-6,y-23,5,2,s.hair);px(x+1,y-23,5,2,s.hair);px(x-5,y-20,3,3,'#18222b');px(x+2,y-20,3,3,'#18222b');px(x-2,y-16,5,2,'#965b46');
  drawWorkerHat(a,x,y,bob);if(!a.onSite)drawWorkerTool(a,x,y+2,bob,walk);
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
function drawClouds(ts){if(display.night)return;ctx.save();ctx.globalAlpha=.08;for(const c of clouds){const x=(c.x+ts*.006*c.s)%W,y=c.y;ctx.fillStyle='#d8f0ff';ctx.beginPath();ctx.arc(x,y,26*c.s,0,Math.PI*2);ctx.arc(x+28*c.s,y+6,20*c.s,0,Math.PI*2);ctx.arc(x-25*c.s,y+8,17*c.s,0,Math.PI*2);ctx.fill()}ctx.restore()}function drawCommandCelebration(ts){
 if(ts>celebrationUntil)return;const d=DISTRICTS.command,x=(d.x+d.w/2)*T,y=d.y*T-10,life=clamp((celebrationUntil-ts)/3600,0,1);
 ctx.save();ctx.globalAlpha=Math.min(1,life*2);
 for(let i=0;i<18;i++){const a=i/18*Math.PI*2,r=18+(1-life)*90,c=i%3===0?'#75dfa2':i%3===1?'#71b7ff':'#f5c04f';px(x+Math.cos(a)*r,y+Math.sin(a)*r*.55,4,4,c)}
 ctx.strokeStyle='rgba(117,223,162,'+(.35+.35*Math.sin(ts/160))+')';ctx.lineWidth=3;ctx.beginPath();ctx.arc(x,y,20+(1-life)*28,0,Math.PI*2);ctx.stroke();txt('MISSION COMPLETE',x,y-30,'#eafff1',8);ctx.restore()
}

function drawMinimap(){
 const el=$('#awcMinimap',root);if(!el)return;
 const markers=Object.entries(DISTRICTS).map(([id,d])=>`<i style="left:${((d.x+d.w/2)*T/W)*100}%;top:${((d.y+d.h/2)*T/H)*100}%;--c:${d.accent}" title="${esc(d.name)}"></i>`).join('');
 el.innerHTML='<span></span>'+markers;
}
function draw(ts){
 ctx.clearRect(0,0,W,H);ctx.save();ctx.translate(view.panX,view.panY);ctx.scale(view.zoom,view.zoom);drawGround(ts);drawFlows(ts);drawTraffic();for(const[id,d]of Object.entries(DISTRICTS)){drawDistrictScene(id,d,ts);drawBuilding(id,d,ts);drawInterior(id,d,ts);drawWorksite(id,d,ts)}drawAgents(ts);drawCommandCelebration(ts);drawClouds(ts);if(display.night){ctx.fillStyle='rgba(3,7,14,.18)';ctx.fillRect(0,0,W,H)}ctx.restore()
}
// Animate only while the city canvas is on screen and the tab is visible; at most one rAF chain.
let io=null,observed=null,onScreen=!('IntersectionObserver' in window);
function canAnimate(){return !!(canvas&&canvas.isConnected&&onScreen&&!document.hidden)}
function stop(){if(raf){cancelAnimationFrame(raf);raf=0}last=0}
function loop(ts){raf=0;if(!canAnimate()){last=0;return}const dt=last?Math.min(.05,(ts-last)/1000||0):0;last=ts;update(dt,ts);draw(ts);raf=requestAnimationFrame(loop)}
function start(){
 if(canvas&&observed!==canvas&&'IntersectionObserver' in window){io?.disconnect();onScreen=false;observed=canvas;io=new IntersectionObserver(entries=>{onScreen=entries[entries.length-1].isIntersecting;onScreen?start():stop()});io.observe(canvas)}
 if(!raf&&canAnimate())raf=requestAnimationFrame(loop)
}
document.addEventListener('visibilitychange',()=>document.hidden?stop():start());
async function bootstrap(){try{const r=await fetch('/api/agents/missions'),j=await r.json(),items=j.items||j.missions||[],active=items.find(m=>m.status==='running')||items[0];if(active){applyMission(active);connectSSE();return}}catch{}try{const r=await fetch('/api/engineering/runs'),j=await r.json(),runs=j.items||[],active=runs.find(x=>x.status==='running')||runs[0];if(active)applyEngineering(active)}catch{}connectSSE()}
let unsubscribeSSE=null;
function connectSSE(){if(unsubscribeSSE)return;try{unsubscribeSSE=missionStream.subscribe(m=>{liveSnapshot=normalizeMission(m);applyMission(m)})}catch{}}
document.addEventListener('localai:engineering-run',e=>applyEngineering(e.detail?.run||e.detail));window.addEventListener('localai:agentworld-replay-mission',e=>{const m=e.detail?.mission;if(m){loadMissionReplay(m);if((m.timeline||[]).length>1)applyReplayFrame(0)}});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{mount();drawMinimap()},{once:true});else{mount();drawMinimap()}
})();