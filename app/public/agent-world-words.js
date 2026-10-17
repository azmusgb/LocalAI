// What Agent World says about a mission and its workers, in the owner's words: worker names and roles, what each is
// doing now, the one status sentence under the title, and errors without codes. Pure functions of the mission JSON
// (/api/agents/missions): also the story feed. Shared by the Agent World page (window.LocalAIAgentWords) and tests/agent-world-words.test.cjs.
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
// A follow-up the Coordinator asks for ("ux_analyst-followup-1") is the same specialist doing a second, smaller job.
const FOLLOW=/-followup-\d+$/;
const key=w=>{const id=String(w&&(w.id||w.agentId)||'').replace(FOLLOW,'');return ROUTERS.has(id)?'router':COORDS.has(id)?'synthesis':id};
const isFollowUp=w=>FOLLOW.test(String(w&&(w.id||w.agentId)||''));
function workerName(w){
 if(!w)return'';const id=key(w);
 if(id==='router')return'Team lead';
 const n=String(w.name||w.agentName||'').trim();if(n)return n;
 const raw=String(w.id||w.agentId||'Worker').replace(/[_-]+/g,' ');return raw.charAt(0).toUpperCase()+raw.slice(1);
}
// The worker as the subject of a sentence: a follow-up reads "UX Analyst’s follow-up", not "UX Analyst · follow-up".
function subject(w){if(!isFollowUp(w))return workerName(w);const n=workerName(w).replace(/\s*·\s*follow-up$/i,'');return n+'’s follow-up'}
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
// The server's step labels ("Follow-up stopped: …", "Follow-up failed: …") are dropped: the sentence names the step.
const STEP_LABEL=/^(?:follow-up\s+)?(?:stopped|failed)\s*:\s*/i;
function errorWords(code,msg){
 const c=String(code||'');let t=String(msg||'').trim();
 for(let i=0;i<3&&STEP_LABEL.test(t);i++)t=t.replace(STEP_LABEL,'').trim();
 if(c==='AGENT_TIMEOUT'||/execution deadline reached/i.test(t))return'the agent ran out of time';
 if(c==='AGENT_TURN_LIMIT'||/turn limit reached/i.test(t))return'the agent couldn’t settle on an answer';
 if(c==='AGENT_CONTEXT_LIMIT'||/context limit reached/i.test(t))return'the agent had too much to read';
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
 if(w.state==='blocked'){const stuck=(w.dependsOn||[]).map(byId).filter(x=>x&&BAD.has(x.state));return stuck.length?'Couldn’t start: '+names(stuck.map(subject))+' stopped':'Couldn’t start'}
 const wait=(w.dependsOn||[]).map(byId).filter(x=>x&&x.state!=='complete');
 return wait.length?'Waiting for '+names(wait.map(workerName)):'Waiting to start';
}
function statusSentence(m){
 if(!m)return{tone:'idle',label:'',text:'Give your team a goal'};
 const all=m.workers||[],done=all.filter(w=>w.state==='complete').length,count=done+' of '+all.length+' done';
 const bad=all.find(w=>w.state==='error')||all.find(w=>w.state==='blocked');
 if(m.status==='needs_attention'||m.status==='error'||m.status==='failed'||bad){
  const why=bad?subject(bad)+(bad.state==='error'?' stopped: '+workerError(bad,m):' couldn’t start'):errorWords(m.errorCode,m.error);
  return{tone:'attention',label:'Needs you',text:'Needs you · '+(all.length?count+' · ':'')+why};
 }
 if(m.status==='complete'){const d=duration(span(m.createdAt,m.finishedAt||m.updatedAt)),n=all.length;return{tone:'done',label:'Done',text:'Done'+(d?' in '+d:'')+' · '+n+' worker'+(n===1?'':'s')}}
 const running=all.filter(w=>w.state==='running');
 if(running.length===1&&key(running[0])==='router')return{tone:'working',label:'Working',text:'Starting · the team lead is picking the team'};
 if(!running.length)return{tone:'working',label:'Working',text:'Working · '+count};
 const who=running.length===1?workerName(running[0])+' is '+activity(running[0]):names(running.map(workerName))+' are working';
 return{tone:'working',label:'Working',text:'Working · '+count+' · '+who};
}
// The story: the mission's timeline as sentences, newest first. Each server event carries every worker's state, so a
// sentence is a worker whose state changed since the event before (heartbeats and progress ticks change nothing).
// Without a timeline (older missions) each worker says where it is now.
function storyEvents(m){
 if(!m)return[];const out=[],say=(at,workerId,text,tone)=>out.push({at:at||'',workerId:workerId||'',text,tone});
 const team=ws=>names(ws.filter(w=>key(w)!=='router').map(workerName)),idOf=w=>w.id||w.agentId;
 const tl=(m.timeline||[]).filter(e=>e&&Array.isArray(e.workers));
 if(!tl.length){
  const all=m.workers||[];if(!all.length)return[];say(m.createdAt,'router','The team lead picked the team: '+team(all),'done');
  for(const w of all){if(key(w)==='router')continue;const n=subject(w),step=workerStep(w,m);
   say(m.updatedAt,idOf(w),w.state==='complete'?n+' finished':w.state==='error'||w.state==='blocked'?n+' '+step.charAt(0).toLowerCase()+step.slice(1):n+' is '+step.charAt(0).toLowerCase()+step.slice(1),TONE[w.state]||'wait')}
  return out.reverse();
 }
 let prev=null;const waited=new Set();
 for(const e of tl){
  const ws=e.workers,snap={...m,workers:ws},before=id=>prev?.find(x=>idOf(x)===id)?.state||'pending';
  if(!prev)say(e.at,'router','The team lead picked the team: '+team(ws),'done');
  for(const w of ws){
   if(key(w)==='router')continue;const id=idOf(w),n=subject(w),was=before(id);
   if(w.state!==was){const c=changeSentence(w,snap);if(c)say(e.at,id,c,TONE[w.state])}
   if(w.state==='pending'&&!waited.has(id)){const deps=(w.dependsOn||[]).map(d=>ws.find(x=>idOf(x)===d)).filter(Boolean);
    if(deps.some(d=>d.state==='running')){waited.add(id);say(e.at,id,n+' is waiting for '+names(deps.filter(d=>d.state!=='complete').map(workerName)),'wait')}}
  }
  if(e.type==='mission-complete')say(e.at,'','Done: the summary is ready','done');
  if(e.type==='mission-attention')say(e.at,'','The mission stopped and needs you','bad');
  prev=ws;
 }
 return out.reverse();
}
// One worker's new state as a sentence (the story and the city's floating notes): "UX Analyst started reviewing the screens".
function changeSentence(w,m){const n=subject(w);return w.state==='running'?n+' started '+activity(w):w.state==='complete'?n+' finished':w.state==='error'?n+' stopped: '+workerError(w,m):w.state==='blocked'?n+' '+workerStep(w,m).replace(/^C/,'c'):''}
const TONE={running:'working',complete:'done',error:'bad',blocked:'bad',pending:'wait'};
// Consecutive sentences about one worker read as one group under that worker.
function groupStory(list){const g=[];for(const e of list||[]){const last=g[g.length-1];if(last&&e.workerId&&last.workerId===e.workerId)last.items.push(e);else g.push({workerId:e.workerId||'',items:[e]})}return g}
// Who will be on the team, from the plan preview (/api/agents/dispatch routing.workers): "A UX Analyst will review
// screens for usability; a Coordinator will put everyone’s findings together." The Coordinator always joins.
function teamPreview(list){
 const ws=(list||[]).map(w=>({...w,id:w.id||w.agentId})).filter(w=>key(w)!=='router'&&key(w)!=='synthesis');if(!ws.length)return{workers:[],text:''};
 ws.push({id:'synthesis',name:'Coordinator'});
 const base=(b,e)=>e==='es'&&/(ch|sh|x|ss)$/.test(b)?b:b+(e==='es'?'e':''),will=w=>workerRole(w).replace(/^(\w+?)(es|s)\b/,(m,b,e)=>base(b,e)).replace(/\band (\w+?)(es|s)\b/g,(m,b,e)=>'and '+base(b,e)).replace(/^./,c=>c.toLowerCase());
 const parts=ws.map((w,i)=>{const n=workerName(w),a=/^[AEIOU]/i.test(n)&&!/^U[A-Z]/.test(n)?'an ':'a ';return(i?a:a.charAt(0).toUpperCase()+a.slice(1))+n+' will '+will(w)});
 return{workers:ws,text:parts.join('; ')+'.'};
}
// Why there is no summary yet, in one sentence.
function summaryWhy(m){const all=(m&&m.workers)||[],c=all.find(w=>key(w)==='synthesis'),stopped=all.filter(w=>w.state==='error'&&key(w)!=='synthesis');
 if(c&&c.state==='blocked')return'No summary: the Coordinator couldn’t start because '+(stopped.length?names(stopped.map(subject))+' stopped.':'a worker stopped.');
 if(c&&c.state==='error')return'No summary: the Coordinator stopped before finishing.';
 if(m&&m.status==='complete')return'No summary: the Coordinator didn’t write one.';
 if(stopped.length)return'No summary: '+names(stopped.map(subject))+' stopped.';
 return'No summary yet: the team is still working.'}
const api={summaryWhy,changeSentence,teamPreview,workerName,workerRole,workerStep,stateBadge,statusSentence,storyEvents,groupStory,errorWords,duration};
root.LocalAIAgentWords=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
