(()=>{'use strict';
const W=960,H=600,T=24,COLS=W/T,ROWS=H/T;
const DISTRICTS={
 command:{name:'Command Center',x:18,y:10,w:5,h:5,color:'#6aaeff',roof:'#2d6ba5'},
 ux:{name:'UX Lab',x:5,y:5,w:5,h:4,color:'#54e0f0',roof:'#178b9b'},
 docs:{name:'Documentation Studio',x:28,y:5,w:5,h:4,color:'#c18cff',roof:'#7a4fa5'},
 engineering:{name:'Engineering Bay',x:5,y:17,w:6,h:5,color:'#ffb866',roof:'#9c5f20'},
 validation:{name:'Validation Lab',x:28,y:17,w:5,h:5,color:'#79d9a0',roof:'#2f8052'},
 models:{name:'Model Foundry',x:16,y:20,w:7,h:4,color:'#ff7d8c',roof:'#9d3546'},
 projects:{name:'Projects Quarter',x:15,y:3,w:8,h:4,color:'#86b6ff',roof:'#405f9a'},
 repair:{name:'Repair Bay',x:31,y:11,w:5,h:4,color:'#ff7180',roof:'#983543'}
};
const ROLE_ZONE={router:'command',mission_router:'command',ux_analyst:'ux',documentation:'docs',synthesis:'command',coordinator:'command',engineer:'engineering',validator:'validation',reviewer:'command',deployer:'engineering',operator:'validation'};
const ROLE_COLOR={router:'#6aaeff',mission_router:'#6aaeff',ux_analyst:'#54e0f0',documentation:'#c18cff',synthesis:'#9caeff',coordinator:'#9caeff',engineer:'#ffb866',validator:'#79d9a0',reviewer:'#c18cff',deployer:'#ffb866',operator:'#79d9a0'};
const $=(s,r=document)=>r.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
let root,canvas,ctx,current=null,sourceType='idle',selected=null,raf=0,last=0,events=[],agents=new Map(),roads=new Set();
const key=(x,y)=>x+','+y, clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
function tileCenter(z){const d=DISTRICTS[z]||DISTRICTS.command;return {x:(d.x+d.w/2)*T,y:(d.y+d.h+1)*T}}
function road(x,y){roads.add(key(x,y))}
function buildRoads(){
 roads.clear();
 for(let x=2;x<COLS-2;x++){road(x,14);road(x,15)}
 for(let y=2;y<ROWS-2;y++){road(13,y);road(14,y);road(25,y);road(26,y)}
 for(let x=3;x<37;x++){road(x,9);road(x,23)}
 for(let y=4;y<24;y++){road(4,y);road(35,y)}
}
function blocked(x,y){
 if(x<1||y<1||x>=COLS-1||y>=ROWS-1)return true;
 for(const d of Object.values(DISTRICTS))if(x>=d.x-1&&x<d.x+d.w+1&&y>=d.y-1&&y<d.y+d.h+1)return true;
 return !roads.has(key(x,y));
}
function nearestRoad(pt){let best=null,bd=1e9;for(const k of roads){const [x,y]=k.split(',').map(Number),px=(x+.5)*T,py=(y+.5)*T,d=(px-pt.x)**2+(py-pt.y)**2;if(d<bd){bd=d;best={x,y}}}return best||{x:14,y:14}}
function astar(a,b){
 const start=nearestRoad(a),goal=nearestRoad(b),open=[start],came=new Map(),g=new Map([[key(start.x,start.y),0]]),f=new Map([[key(start.x,start.y),Math.abs(start.x-goal.x)+Math.abs(start.y-goal.y)]]);
 while(open.length){open.sort((u,v)=>(f.get(key(u.x,u.y))??1e9)-(f.get(key(v.x,v.y))??1e9));const cur=open.shift();if(cur.x===goal.x&&cur.y===goal.y){const path=[];let k=key(cur.x,cur.y),p=cur;while(p){path.unshift({x:(p.x+.5)*T,y:(p.y+.5)*T});const prev=came.get(k);p=prev;k=prev?key(prev.x,prev.y):''}return path}
 for(const n of [{x:cur.x+1,y:cur.y},{x:cur.x-1,y:cur.y},{x:cur.x,y:cur.y+1},{x:cur.x,y:cur.y-1}]){if(blocked(n.x,n.y)&&!(n.x===goal.x&&n.y===goal.y))continue;const nk=key(n.x,n.y),tent=(g.get(key(cur.x,cur.y))||0)+1;if(tent<(g.get(nk)??1e9)){came.set(nk,cur);g.set(nk,tent);f.set(nk,tent+Math.abs(n.x-goal.x)+Math.abs(n.y-goal.y));if(!open.some(o=>o.x===n.x&&o.y===n.y))open.push(n)}}}
 return [];
}
function zoneForWorker(w){
 if(w.state==='error'||w.state==='blocked')return 'repair';
 return ROLE_ZONE[w.id]||ROLE_ZONE[w.agentId]||(/doc/i.test(w.name||'')?'docs':/ux/i.test(w.name||'')?'ux':/model/i.test(w.name||'')?'models':'command')
}
function ensureAgent(w){
 const id=w.id||w.agentId||w.name;if(!id)return;
 let a=agents.get(id);const targetZone=zoneForWorker(w),target=tileCenter(targetZone);
 if(!a){const home=tileCenter(id==='router'?'command':targetZone);a={id,name:w.name||id,glyph:(w.name||id).trim()[0]?.toUpperCase()||'A',x:home.x,y:home.y,tx:target.x,ty:target.y,path:[],pathI:0,state:w.state||'pending',zone:targetZone,color:ROLE_COLOR[id]||'#8fb5e8',model:w.model||''};agents.set(id,a)}
 a.name=w.name||a.name;a.state=w.state||a.state;a.model=w.model||a.model;a.zone=targetZone;a.color=ROLE_COLOR[id]||a.color;
 if(Math.hypot(a.tx-target.x,a.ty-target.y)>2){a.tx=target.x;a.ty=target.y;a.path=astar({x:a.x,y:a.y},target);a.pathI=0}
}
function mount(){
 const host=$('#agentWorldCityMount');if(!host)return;
 root=document.createElement('section');root.className='awc';root.innerHTML=`
 <div class="awc__top"><div class="awc__brand"><div class="awc__mark">AW</div><div><div class="awc__title">Agent World</div><div class="awc__sub">Live multi-agent city · mission-driven simulation</div></div></div><div class="awc__badges"><span class="awc__badge live"><i class="awc__led"></i><span id="awcLiveText">LIVE</span></span><span class="awc__badge" id="awcSource">IDLE</span></div></div>
 <div class="awc__body"><div class="awc__mapWrap"><div class="awc__mapTop"><div class="awc__objective"><small>Current objective</small><strong id="awcObjective">Waiting for live mission activity</strong></div><div class="awc__mode" id="awcMode">CITY OPS</div></div><canvas width="${W}" height="${H}" id="awcCanvas" aria-label="Live Agent World city"></canvas><div class="awc__hud"><span class="awc__chip" id="awcStatus">status: idle</span><span class="awc__chip" id="awcZone">district: —</span></div></div>
 <aside class="awc__side"><div class="awc__mission"><div class="awc__eyebrow">Mission control</div><h3 id="awcMissionTitle">No active mission</h3><p id="awcMissionText">Agent World will automatically follow the newest live mission. Engineering activity is used as a fallback when no mission is active.</p><div class="awc__progress"><span id="awcProgress"></span></div></div><div class="awc__tabs"><button class="awc__tab active" data-awctab="agents">Agents</button><button class="awc__tab" data-awctab="events">Events</button><button class="awc__tab" data-awctab="inspect">Inspect</button></div><div class="awc__panel active" data-awcpanel="agents" id="awcAgents"></div><div class="awc__panel" data-awcpanel="events" id="awcEvents"></div><div class="awc__panel" data-awcpanel="inspect" id="awcInspect"></div><div class="awc__legend"><span><i style="background:#54e0f0"></i>running</span><span><i style="background:#6ce39a"></i>complete</span><span><i style="background:#ff7180"></i>attention</span></div></aside></div>`;
 host.appendChild(root);canvas=$('#awcCanvas',root);ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
 root.addEventListener('click',e=>{const t=e.target.closest('[data-awctab]');if(t){$('.awc__tab.active',root)?.classList.remove('active');t.classList.add('active');root.querySelectorAll('[data-awcpanel]').forEach(p=>p.classList.toggle('active',p.dataset.awcpanel===t.dataset.awctab))}});
 canvas.addEventListener('click',e=>{const r=canvas.getBoundingClientRect(),sx=canvas.width/r.width,sy=canvas.height/r.height,x=e.offsetX*sx,y=e.offsetY*sy;selected=null;for(const [id,d] of Object.entries(DISTRICTS)){if(x>=d.x*T&&x<=(d.x+d.w)*T&&y>=d.y*T&&y<=(d.y+d.h)*T){selected={type:'district',id};break}}for(const a of agents.values()){if(Math.hypot(x-a.x,y-a.y)<16){selected={type:'agent',id:a.id};break}}renderInspect()});
 document.body.classList.add('agent-world-city-ready');buildRoads();start();bootstrap();
}
function addEvent(text){events.unshift({text,at:new Date()});events=events.slice(0,40);renderEvents()}
function normalizeMission(m){
 const workers=(m.workers||[]).map(w=>({...w,id:w.id||w.agentId}));return {type:'mission',id:m.id,status:m.status,goal:m.goal||'Mission',updatedAt:m.updatedAt||m.createdAt,workers,error:m.error||'',raw:m}
}
function applyMission(m){
 if(!m)return;const prev=current;current=normalizeMission(m);sourceType='mission';current.workers.forEach(ensureAgent);
 if(!prev||prev.id!==current.id)addEvent('Mission '+current.id+' entered Agent World');else{
  current.workers.forEach(w=>{const old=prev.workers?.find(x=>x.id===w.id);if(old&&old.state!==w.state)addEvent((w.name||w.id)+' → '+w.state)})
 }
 renderUI()
}
function engWorkers(run){const s=run.status||'idle';return[
 {id:'engineer',name:'Engineer',state:s==='running'?'running':s==='needs_attention'?'error':s==='applied'?'complete':'pending'},
 {id:'validator',name:'Validator',state:s==='running'?'running':s==='awaiting_approval'?'complete':'pending'},
 {id:'reviewer',name:'Reviewer',state:s==='awaiting_approval'?'running':['approved','apply_requested','applied'].includes(s)?'complete':'pending'},
 {id:'deployer',name:'Deployer',state:['approved','apply_requested'].includes(s)?'running':s==='applied'?'complete':'pending'},
 {id:'operator',name:'Operator',state:s==='applied'?'complete':'pending'}
]}
function applyEngineering(run){if(!run)return;current={type:'engineering',id:run.id,status:run.status,goal:run.request||'Engineering run',updatedAt:run.updatedAt,workers:engWorkers(run),error:run.error||'',raw:run};sourceType='engineering';current.workers.forEach(ensureAgent);renderUI()}
function renderUI(){
 if(!root||!current)return;
 $('#awcSource',root).textContent=sourceType.toUpperCase();$('#awcObjective',root).textContent=current.goal;$('#awcMissionTitle',root).textContent=(current.type==='mission'?'Mission ':'Engineering ')+current.id;$('#awcMissionText',root).textContent=current.error||('Live '+current.type+' · '+current.status);
 $('#awcStatus',root).textContent='status: '+current.status;const done=current.workers.filter(w=>w.state==='complete').length,total=current.workers.length||1;$('#awcProgress',root).style.width=Math.round(done/total*100)+'%';
 const holder=$('#awcAgents',root);holder.innerHTML=current.workers.map(w=>`<button class="awc__worker ${esc(w.state)}" data-awcworker="${esc(w.id)}"><span class="awc__avatar">${esc((w.name||w.id)[0]||'A')}</span><span><strong>${esc(w.name||w.id)}</strong><small>${esc(w.model||zoneForWorker(w))}</small></span><span class="awc__state">${esc(w.state)}</span></button>`).join('')||'<div class="awc__empty">No workers.</div>';
 holder.querySelectorAll('[data-awcworker]').forEach(b=>b.onclick=()=>{selected={type:'agent',id:b.dataset.awcworker};renderInspect();root.querySelector('[data-awctab="inspect"]').click()});renderInspect()
}
function renderEvents(){if(!root)return;const h=$('#awcEvents',root);h.innerHTML=events.length?events.map(e=>`<div class="awc__event">${esc(e.text)}<time>${e.at.toLocaleTimeString()}</time></div>`).join(''):'<div class="awc__empty">No live events yet.</div>'}
function renderInspect(){
 if(!root)return;const h=$('#awcInspect',root);if(!selected){h.innerHTML='<div class="awc__empty">Select a building or agent on the city map.</div>';$('#awcZone',root).textContent='district: —';return}
 if(selected.type==='district'){const d=DISTRICTS[selected.id];$('#awcZone',root).textContent='district: '+d.name;h.innerHTML=`<div class="awc__inspect"><h4>${esc(d.name)}</h4><dl><dt>District</dt><dd>${esc(selected.id)}</dd><dt>Workers</dt><dd>${[...agents.values()].filter(a=>a.zone===selected.id).map(a=>esc(a.name)).join(', ')||'None'}</dd></dl></div>`;return}
 const a=agents.get(selected.id);if(!a){h.innerHTML='<div class="awc__empty">Agent unavailable.</div>';return}$('#awcZone',root).textContent='district: '+DISTRICTS[a.zone]?.name;h.innerHTML=`<div class="awc__inspect"><h4>${esc(a.name)}</h4><dl><dt>State</dt><dd>${esc(a.state)}</dd><dt>District</dt><dd>${esc(DISTRICTS[a.zone]?.name||a.zone)}</dd><dt>Model</dt><dd>${esc(a.model||'—')}</dd><dt>Mission</dt><dd>${esc(current?.id||'—')}</dd></dl></div>`
}
function update(dt){
 for(const a of agents.values()){if(!a.path?.length||a.pathI>=a.path.length)continue;const p=a.path[a.pathI],dx=p.x-a.x,dy=p.y-a.y,d=Math.hypot(dx,dy),speed=(a.state==='running'?80:58);if(d<2){a.pathI++;continue}a.x+=dx/d*speed*dt;a.y+=dy/d*speed*dt}
}
function px(x,y,w,h,c){ctx.fillStyle=c;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h))}
function text(t,x,y,c='#d9e7f4',size=9){ctx.fillStyle=c;ctx.font='800 '+size+'px ui-monospace,monospace';ctx.textAlign='center';ctx.fillText(t,x,y)}
function drawGround(){
 px(0,0,W,H,'#0a1820');
 for(let y=0;y<H;y+=T){for(let x=0;x<W;x+=T){const n=((x/T*13+y/T*7)%11);px(x,y,T,T,n<2?'#132d25':n<5?'#153425':'#183829');if(n===0){px(x+5,y+6,3,3,'#24533b');px(x+16,y+15,2,2,'#2e6548')}}}
 roads.forEach(k=>{const [x,y]=k.split(',').map(Number);px(x*T,y*T,T,T,'#26313c');px(x*T+2,y*T+2,T-4,T-4,'#303c48')});
 for(let x=0;x<COLS;x++){if(roads.has(key(x,14)))px(x*T+7,14*T+11,10,2,'#d6a84e');if(roads.has(key(x,15)))px(x*T+7,15*T+11,10,2,'#d6a84e')}
 for(let y=0;y<ROWS;y++){if(roads.has(key(13,y)))px(13*T+11,y*T+7,2,10,'#d6a84e');if(roads.has(key(25,y)))px(25*T+11,y*T+7,2,10,'#d6a84e')}
}
function building(id,d){
 const x=d.x*T,y=d.y*T,w=d.w*T,h=d.h*T,active=current?.workers?.some(q=>zoneForWorker(q)===id&&q.state==='running'),bad=current?.workers?.some(q=>zoneForWorker(q)===id&&['error','blocked'].includes(q.state));
 px(x-4,y+8,w+8,h+4,'rgba(0,0,0,.26)');px(x,y,w,h,d.roof);px(x+6,y+7,w-12,h-13,'#1a2632');px(x+10,y+11,w-20,h-22,d.color);
 for(let yy=y+17;yy<y+h-14;yy+=13)for(let xx=x+16;xx<x+w-14;xx+=17)px(xx,yy,7,6,active?'#eafcff':'#173b50');
 px(x+Math.floor(w/2)-7,y+h-15,14,15,'#101922');text(d.name,x+w/2,y-7,active?'#f4fbff':'#a9bbcb',8);
 if(active){ctx.strokeStyle=d.color;ctx.lineWidth=3;ctx.strokeRect(x-3,y-3,w+6,h+6)}if(bad){ctx.strokeStyle='#ff7180';ctx.lineWidth=3;ctx.strokeRect(x-3,y-3,w+6,h+6)}
}
function drawDecor(){
 // parks / trees / utility details
 for(const [x,y] of [[2,2],[3,3],[37,3],[38,4],[2,22],[38,22],[9,2],[30,2],[9,25],[30,25]]){px(x*T+6,y*T+10,12,10,'#185b37');px(x*T+10,y*T+5,5,12,'#2d8a52')}
 // central plaza
 px(17*T,12*T,6*T,3*T,'#6b6652');for(let i=0;i<6;i++)px((18+i%3)*T+8,(12+Math.floor(i/3))*T+8,8,8,'#8c876a');
}
function drawAgents(ts){
 for(const a of agents.values()){const pulse=a.state==='running'?(Math.sin(ts/180)+1)*1.5:0,c=a.state==='error'||a.state==='blocked'?'#ff7180':a.state==='complete'?'#6ce39a':a.color;ctx.fillStyle='rgba(0,0,0,.35)';ctx.beginPath();ctx.ellipse(a.x,a.y+9,9,4,0,0,Math.PI*2);ctx.fill();px(a.x-6-pulse/2,a.y-8-pulse/2,12+pulse,13+pulse,c);px(a.x-3,a.y-5,2,2,'#071019');px(a.x+2,a.y-5,2,2,'#071019');text(a.glyph,a.x,a.y+17,'#eaf5ff',7)}
}
function draw(ts){drawGround();drawDecor();for(const [id,d] of Object.entries(DISTRICTS))building(id,d);drawAgents(ts)}
function loop(ts){const dt=Math.min(.05,(ts-last)/1000||0);last=ts;update(dt);draw(ts);raf=requestAnimationFrame(loop)}
function start(){if(!raf)raf=requestAnimationFrame(loop)}
async function bootstrap(){
 try{const r=await fetch('/api/agents/missions'),j=await r.json(),items=j.items||j.missions||[];const active=items.find(m=>m.status==='running')||items[0];if(active){applyMission(active);connectSSE();return}}catch{}
 try{const r=await fetch('/api/engineering/runs'),j=await r.json(),runs=j.items||[];const active=runs.find(x=>x.status==='running')||runs[0];if(active)applyEngineering(active)}catch{}
 connectSSE()
}
function connectSSE(){try{const es=new EventSource('/api/agents/missions/events');es.onmessage=e=>{try{applyMission(JSON.parse(e.data))}catch{}};es.onerror=()=>{}}catch{}}
document.addEventListener('localai:engineering-run',e=>{if(sourceType!=='mission'||current?.status!=='running')applyEngineering(e.detail?.run||e.detail)});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();