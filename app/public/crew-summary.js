// Agent World for screen readers. The crew rows ui.js draws (#awcRoster, a list: each worker's name, role, current step
// and state) are the city's text equivalent. This keeps one line beside them, #awCrewSummary, counting the crew by state
// ("4 workers: 1 done, 1 working, 2 waiting."). It is read out politely when a worker changes state, and the city
// canvas points at it (aria-describedby). It follows the rows as they are drawn, so it is never out of step with them.
(function(root){'use strict';
function summary(states){
 if(!states.length)return 'No workers yet.';
 const n=new Map();for(const s of states)n.set(s,(n.get(s)||0)+1);
 return `${states.length} worker${states.length===1?'':'s'}: ${[...n].map(([s,k])=>`${k} ${k>1?s.replace(/^needs /,'need '):s}`).join(', ')}.`;
}
function sync(){
 const rows=document.getElementById('awcRoster'),out=document.getElementById('awCrewSummary');if(!rows||!out)return;
 const t=summary([...rows.querySelectorAll('.awc__rosterItem')].map(b=>(b.querySelector('.badge')?.textContent||'waiting').trim().toLowerCase()));
 if(out.textContent!==t)out.textContent=t; // same words: say nothing again
}
function init(){const rows=document.getElementById('awcRoster');if(!rows)return;new MutationObserver(sync).observe(rows,{childList:true,subtree:true,characterData:true});sync()}
if(typeof module==='object'&&module.exports){module.exports={summary};return}
root.LocalAICrewSummary={summary,sync};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(typeof window!=='undefined'?window:globalThis);
