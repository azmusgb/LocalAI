// What Agent World says about a mission and its workers, in the owner's words: worker names and roles, what each is
// doing now, the one status sentence under the title, and errors without codes. Pure functions of the mission JSON
// (/api/agents/missions), shared by the Agent World page (window.LocalAIAgentWords) and tests/agent-world-words.test.cjs.
(function(root){'use strict';
const ROUTERS=new Set(['router','model_router','mission_router']);
const COORDS=new Set(['synthesis','coordinator']);
// id: [what they do, what they are doing while working]
const ROLES={
 router:['Picks the team and plans the work','picking the team'],
 ux_analyst:['Reviews screens for usability','reviewing the screens'],
 documentation:['Writes the documentation','writing the documentation'],
 code_analyst:['Reads the code and spots problems','reading the code'],
 test_engineer:['Plans and checks the tests','checking the tests'],
 research_agent:['Looks things up and gathers sources','gathering sources'],
 security_reviewer:['Checks for security risks','checking for security risks'],
 performance_analyst:['Checks speed and resource use','checking speed'],
 synthesis:['Puts everyone’s findings together','putting the findings together'],
 engineer:['Builds the change','building the change'],
 validator:['Checks the change works','checking the change'],
 reviewer:['Reviews the change','reviewing the change'],
 deployer:['Ships the change','shipping the change'],
 operator:['Watches it run','watching it run']
};
const key=w=>{const id=String(w&&(w.id||w.agentId)||'');return ROUTERS.has(id)?'router':COORDS.has(id)?'synthesis':id};
function workerName(w){
 if(!w)return'';const id=key(w);
 if(id==='router')return'Team lead';
 const n=String(w.name||w.agentName||'').trim();if(n)return n;
 const raw=String(w.id||w.agentId||'Worker').replace(/[_-]+/g,' ');return raw.charAt(0).toUpperCase()+raw.slice(1);
}
const workerRole=w=>(ROLES[key(w)]||['Helps with the mission'])[0];
const activity=w=>(ROLES[key(w)]||[0,'working'])[1];
const BADGE={running:['Working','accent'],complete:['Done','good'],pending:['Waiting','neutral'],queued:['Waiting','neutral'],error:['Needs you','bad'],blocked:['Needs you','bad'],needs_attention:['Needs you','bad']};
function stateBadge(state){const b=BADGE[state]||['Waiting','neutral'];return{label:b[0],tone:b[1]}}
function duration(ms){
 if(!Number.isFinite(ms)||ms<0)return'';
 const m=Math.round(ms/60000);if(m<1)return'under a minute';if(m<60)return m+' min';
 const h=Math.floor(m/60),r=m%60;return h+' h'+(r?' '+r+' min':'');
}
const span=(a,b)=>Date.parse(b)-Date.parse(a);
function errorWords(code,msg){
 const c=String(code||''),t=String(msg||'').trim();
 if(c==='MODEL_CONNECTION_ERROR'||/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(t))return'the model didn’t answer';
 if(c==='MODEL_TIMEOUT'||/time(d)? ?out/i.test(t))return'the model took too long';
 if(c==='APPLIANCE_RESTART')return'Local AI restarted while it was working';
 if(c==='MODEL_NO_TOOLS')return'the model can’t use tools';
 if(!t||t.length>80)return'something went wrong';
 return t.replace(/[.\s]+$/,'').replace(/^[A-Z](?![A-Z])/,s=>s.toLowerCase());
}
const BAD=new Set(['error','blocked']);
function resultFor(m,w){return((m&&m.results)||[]).find(r=>r.agentId===(w.id||w.agentId))||null}
function workerError(w,m){const r=resultFor(m,w)||{};return errorWords(w.errorCode||r.errorCode,w.error||r.error)}
const names=list=>list.length<2?list.join(''):list.slice(0,-1).join(', ')+' and '+list[list.length-1];
function workerStep(w,m){
 if(!w)return'';const all=(m&&m.workers)||[],byId=id=>all.find(x=>(x.id||x.agentId)===id);
 if(w.state==='running'){
  const p=String(w.phase||'');
  if(p==='model_queue')return'Waiting for the model'+(w.queuePosition>0?' ('+w.queuePosition+' ahead)':'');
  if(p==='Gather context')return'Reading the sources';
  if(p==='Publish result')return'Writing it up';
  const a=activity(w);return a.charAt(0).toUpperCase()+a.slice(1);
 }
 if(w.state==='complete'){
  if(key(w)==='router')return'Picked the team';
  const d=duration(span(w.startedAt,w.finishedAt));return d?'Finished in '+d:'Finished';
 }
 if(w.state==='error')return'Stopped: '+workerError(w,m);
 if(w.state==='blocked'){const stuck=(w.dependsOn||[]).map(byId).filter(x=>x&&BAD.has(x.state));return stuck.length?'Couldn’t start: '+names(stuck.map(workerName))+' stopped':'Couldn’t start'}
 const wait=(w.dependsOn||[]).map(byId).filter(x=>x&&x.state!=='complete');
 return wait.length?'Waiting for '+names(wait.map(workerName)):'Waiting to start';
}
function statusSentence(m){
 if(!m)return{tone:'idle',label:'',text:'Give your team a goal'};
 const all=m.workers||[],done=all.filter(w=>w.state==='complete').length,count=done+' of '+all.length+' done';
 const bad=all.find(w=>w.state==='error')||all.find(w=>w.state==='blocked');
 if(m.status==='needs_attention'||m.status==='error'||m.status==='failed'||bad){
  const why=bad?workerName(bad)+(bad.state==='error'?' stopped: '+workerError(bad,m):' couldn’t start'):errorWords(m.errorCode,m.error);
  return{tone:'attention',label:'Needs you',text:'Needs you · '+(all.length?count+' · ':'')+why};
 }
 if(m.status==='complete'){const d=duration(span(m.createdAt,m.finishedAt||m.updatedAt)),n=all.length;return{tone:'done',label:'Done',text:'Done'+(d?' in '+d:'')+' · '+n+' worker'+(n===1?'':'s')}}
 const running=all.filter(w=>w.state==='running');
 if(running.length===1&&key(running[0])==='router')return{tone:'working',label:'Working',text:'Starting · the team lead is picking the team'};
 if(!running.length)return{tone:'working',label:'Working',text:'Working · '+count};
 const who=running.length===1?workerName(running[0])+' is '+activity(running[0]):names(running.map(workerName))+' are working';
 return{tone:'working',label:'Working',text:'Working · '+count+' · '+who};
}
const api={workerName,workerRole,workerStep,stateBadge,statusSentence,errorWords,duration};
root.LocalAIAgentWords=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
