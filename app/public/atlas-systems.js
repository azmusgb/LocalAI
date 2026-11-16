// The Systems strip on Architecture (Atlas redesign spec, PR 4): what runs where, one card per host, from Pi Hub's list
// (GET /api/atlas/systems; never a list typed into the page). Choosing a repository loads its map below: the strip asks
// architecture.js with an "atlas:choose" event and marks the one shown when architecture.js says "atlas:source".
(function(root){
'use strict';

const LEVEL={problem:3,attention:2};
const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
const short=c=>String(c||'').slice(0,7);

function ago(iso,now){
  const t=Date.parse(iso);if(!Number.isFinite(t))return '';
  const m=Math.max(0,Math.round((now-t)/60000));
  if(m<2)return 'just now';
  if(m<120)return `${m} minutes ago`;
  if(m<48*60)return `${Math.round(m/60)} hours ago`;
  return `${Math.round(m/1440)} days ago`;
}

// One line for a host's services: fine, or the ones that need a look, the worst first. A stale or unknown reading is
// never called fine.
function hostHealth(host){
  const all=Array.isArray(host?.services)?host.services:[];
  if(!all.length)return {text:'',tone:''};
  const bad=all.map(s=>({s,rank:LEVEL[s.severity]||(s.stale?1:0)})).filter(x=>x.rank).sort((a,b)=>b.rank-a.rank)
    .map(({s})=>`${s.label} (${LEVEL[s.severity]?String(s.state).replace(/_/g,' '):'old reading'})`);
  if(!bad.length)return {text:`${plural(all.length,'service')} · ${all.length===1?'fine':'all fine'}`,tone:'ok'};
  const worst=all.some(s=>s.severity==='problem')?'error':'warn';
  return {text:`${bad.length} of ${all.length} need a look: ${bad.join(', ')}`,tone:worst};
}

// One line per repository, in words: how the newest map compares with the running release, then the commits and the
// map's age. A commit count is said only when it is known and positive; ahead never carries one.
function freshSentence(f){
  const n=Number(f.behind);
  if(f.state==='current')return 'Map matches the running release';
  if(f.state==='behind')return Number.isInteger(n)&&n>0?`Map is ${plural(n,'commit')} behind the running release`:'Map is of a different commit than the running release';
  if(f.state==='ahead')return 'Map is newer than the running release';
  if(f.state==='no release')return 'No release recorded';
  return 'Freshness unknown';
}

function repoLine(repo,now=Date.now()){
  const snap=repo?.snapshot;
  if(!snap)return 'Not mapped yet';
  const f=repo.freshness||{state:!repo.liveCommit?'no release':snap.commit===repo.liveCommit?'current':'behind'};
  const parts=[freshSentence(f)];
  const differs=f.state==='behind'||f.state==='ahead';
  if(differs&&repo.liveCommit)parts.push(`map ${short(snap.commit)}, live ${short(repo.liveCommit)}`);
  else parts.push(f.state==='no release'?`map ${short(snap.commit)}`:short(snap.commit));
  const t=Date.parse(snap.generatedAt);
  if(Number.isFinite(t)){const d=Math.floor((now-t)/86400000);parts.push(d<1?'today':`${plural(d,'day')} old`);}
  if(f.state==='behind'&&repo.atLive)parts.push('a map of the running release exists');
  return parts.join(' · ');
}

// Local AI opens on the latest scan (the deploy checkout); another repository on its newest snapshot.
const commitFor=repo=>repo?.repo==='localai'?'':repo?.snapshot?.commit||'';

function sourceNote(body,now=Date.now()){
  if(body?.error&&typeof body.error==='object')return {text:`${body.error.message||'The list of systems could not be read.'} The map below still works.`,tone:'error'};
  if(body?.source==='cache')return {text:`${body.error||'Pi Hub could not be reached.'} Showing its list from ${ago(body.fetchedAt,now)||'earlier'}.`,tone:'warn'};
  return {text:`From Pi Hub, ${ago(body?.fetchedAt,now)||'just now'}.`,tone:''};
}

const exported={hostHealth,repoLine,commitFor,sourceNote};
if(typeof module==='object'&&module.exports){module.exports=exported;return;}

const page=document.getElementById('architecture');
const list=document.getElementById('atlasSystemsList');
const note=document.getElementById('atlasSystemsNote');
if(!page||!list||!note)return;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={body:null,at:0,loading:null,repo:'localai'};

function render(){
  const body=state.body,now=Date.now();
  const n=body?sourceNote(body,now):{text:'Reading Pi Hub…',tone:''};
  note.textContent=n.text;note.dataset.tone=n.tone;
  const hosts=Array.isArray(body?.hosts)?body.hosts:[];
  list.hidden=!hosts.length;
  list.innerHTML=hosts.map(h=>{
    const health=hostHealth(h);
    const code=[...(h.repos||[]).map(r=>`<li><button type="button" class="atlas-host-repo" data-atlas-repo="${esc(r.repo)}" aria-pressed="${r.repo===state.repo}">
      <span>${esc(r.label)}</span><small>${esc(repoLine(r,now))}</small></button></li>`),
      ...(h.targets||[]).filter(t=>!t.atlas).map(t=>`<li class="atlas-host-target"><span>${esc(t.label)}</span><small>${esc([t.commit?short(t.commit):t.state,'not mapped'].join(' · '))}</small></li>`)];
    return `<article class="atlas-host" data-host="${esc(h.id)}"><h3>${esc(h.label)}<small>${esc(h.runs)}</small></h3>
      ${health.text?`<p class="atlas-host-health" data-tone="${health.tone}">${esc(health.text)}</p>`:''}
      ${code.length?`<ul class="atlas-host-code">${code.join('')}</ul>`:'<p class="atlas-host-none">Nothing deployed here.</p>'}</article>`;
  }).join('');
}

async function load(){
  if(state.loading)return state.loading;
  state.loading=(async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const r=await fetch('/api/atlas/systems',{signal:controller.signal,headers:{Accept:'application/json'}});
      const body=await r.json().catch(()=>null);
      state.body=body&&(r.ok||body.error)?body:{error:{message:`The list of systems could not be read (${r.status}).`}};
    }catch(error){
      state.body={error:{message:error.name==='AbortError'?'Reading the list of systems timed out.':'The list of systems could not be read.'}};
    }finally{clearTimeout(timer);state.at=Date.now();state.loading=null;}
    render();
  })();
  return state.loading;
}

list.addEventListener('click',e=>{
  const b=e.target.closest('[data-atlas-repo]');if(!b)return;
  const repo=(state.body?.hosts||[]).flatMap(h=>h.repos||[]).find(r=>r.repo===b.dataset.atlasRepo);
  if(repo)page.dispatchEvent(new CustomEvent('atlas:choose',{detail:{repo:repo.repo,commit:commitFor(repo)}}));
});
// Each time the map loads (opening the page, Refresh, another repository): mark it, and read Pi Hub again if the
// copy is more than half a minute old.
page.addEventListener('atlas:source',e=>{
  state.repo=e.detail?.repo||'localai';
  if(!state.body||Date.now()-state.at>30000)void load();
  render();
});

root.LocalAIAtlasSystems={load};
})(typeof window==='undefined'?globalThis:window);
