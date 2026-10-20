// Agent World watch mode (docs/USER-GUIDE.md › Watch mode), loaded on demand by ui.js (agent-world-watch loader).
// Agent World as a screen you leave on, e.g. a TV or a spare tablet: the city goes full screen and follows the work;
// a caption says what the team is doing; when nothing is running the last mission replays on a loop; a soft chime
// marks a mission starting, finishing or needing you; the screen stays awake. Built on window.LocalAIAgentWorld and
// window.LocalAIAgentWords only.
(function(){'use strict';
const POLL_MS=10000,REPLAY_EVERY_MS=120000,IDLE_CURSOR_MS=3000;
// Its styles come with it, so the page's stylesheet stays the same size.
const CSS='.aw-watch{position:fixed;left:24px;right:24px;bottom:24px;z-index:10000;display:flex;align-items:center;justify-content:space-between;gap:var(--ds-space-4,16px);padding:16px 20px;border-radius:var(--ds-radius-lg);background:color-mix(in srgb,var(--ds-surface,#0f1a2a) 88%,transparent);border:1px solid var(--ds-border,#24344a);color:var(--ds-text,#e8eef6);box-shadow:0 18px 50px rgba(0,0,0,.5);backdrop-filter:blur(8px)}\n.aw-watch[hidden]{display:none}\n.aw-watch__text{display:flex;flex-direction:column;gap:4px;min-width:0}\n.aw-watch__title{font-size:var(--ds-fs-5);line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.aw-watch__status{font-size:var(--ds-fs-3);color:var(--ds-text-dim,#9fb0c3)}\n.aw-watch[data-tone="attention"] .aw-watch__status{color:var(--ds-danger,#ff8a80)}\n.aw-watch[data-tone="done"] .aw-watch__status{color:var(--ds-success,#7ee2a8)}\n.aw-watch__actions{display:flex;gap:8px;flex:none}\n.aw-watch__actions button{min-height:44px;padding:0 14px;border-radius:var(--ds-radius-md);border:1px solid var(--ds-border,#24344a);background:transparent;color:inherit;font:inherit;cursor:pointer}\nbody.aw-watching .awc-v3.is-expanded{inset:0;border-radius:0}\nbody.aw-watch-idle,body.aw-watch-idle *{cursor:none!important}\nbody.aw-watch-idle .aw-watch__actions{opacity:0;transition:opacity .4s}\n@media (max-width:760px){.aw-watch{left:8px;right:8px;bottom:8px;flex-direction:column;align-items:stretch}}';
function css(){if(document.getElementById('awWatchCss'))return;const st=document.createElement('style');st.id='awWatchCss';st.textContent=CSS;document.head.appendChild(st)}
const S={on:false,sound:true,timer:0,lock:null,last:null,lastReplayAt:0,ctx:null,cursor:0,bar:null};
const W=()=>window.LocalAIAgentWorld,words=()=>window.LocalAIAgentWords;
const expanded=()=>!!document.querySelector('.awc-v3.is-expanded');
function tone(kind){if(!S.sound)return;try{S.ctx=S.ctx||new (window.AudioContext||window.webkitAudioContext)();const c=S.ctx,t=c.currentTime,notes=kind==='done'?[523.25,783.99]:kind==='attention'?[440,349.23]:[392,523.25];
 notes.forEach((f,i)=>{const o=c.createOscillator(),g=c.createGain();o.type='sine';o.frequency.value=f;g.gain.setValueAtTime(0,t+i*.18);g.gain.linearRampToValueAtTime(.12,t+i*.18+.02);g.gain.exponentialRampToValueAtTime(.0001,t+i*.18+.6);o.connect(g).connect(c.destination);o.start(t+i*.18);o.stop(t+i*.18+.65)})}catch{}}
function bar(){if(S.bar)return S.bar;const b=document.createElement('div');b.className='aw-watch';b.setAttribute('role','status');b.setAttribute('aria-live','polite');
 b.innerHTML='<div class="aw-watch__text"><strong class="aw-watch__title"></strong><span class="aw-watch__status"></span></div><div class="aw-watch__actions"><button type="button" class="aw-watch__sound" aria-pressed="true">Sound on</button><button type="button" class="aw-watch__exit">Exit watch mode</button></div>';
 b.querySelector('.aw-watch__exit').onclick=()=>stop();
 b.querySelector('.aw-watch__sound').onclick=e=>{S.sound=!S.sound;e.currentTarget.setAttribute('aria-pressed',String(S.sound));e.currentTarget.textContent=S.sound?'Sound on':'Sound off';if(S.sound)tone('start')};
 document.body.appendChild(b);S.bar=b;return b}
function caption(m,replaying){const b=bar(),st=words()?.statusSentence(m||null);b.querySelector('.aw-watch__title').textContent=m?.goal||'Agent World';
 b.querySelector('.aw-watch__status').textContent=!m?'Nothing running. A new mission shows here when it starts.':(replaying?'Replay of the last mission · ':'')+(st?.text||'');b.dataset.tone=replaying?'replay':st?.tone||'idle'}
function toneFor(m){const st=words()?.statusSentence(m);return st?.tone==='attention'?'attention':m.status==='complete'?'done':null}
async function poll(){if(!S.on)return;let items=[];try{const j=await (await fetch('/api/agents/missions')).json();items=j.items||j.missions||[]}catch{}
 const running=items.find(m=>m.status==='running'),latest=running||items[0]||null,prev=S.last;
 if(running){
  if(!prev||prev.id!==running.id||prev.status!=='running'){document.getElementById('awcReplayLive')?.click();window.dispatchEvent(new CustomEvent('localai:agentworld-mission',{detail:{mission:running}}));tone('start')}
  W()?.follow?.(true);caption(running,false);
 }else if(latest){
  if(prev&&prev.id===latest.id&&prev.status==='running'){const t=toneFor(latest);if(t)tone(t);S.lastReplayAt=Date.now()}
  if(!W()?.busy?.()&&Date.now()-S.lastReplayAt>=REPLAY_EVERY_MS&&(latest.timeline||[]).length>1){window.dispatchEvent(new CustomEvent('localai:agentworld-replay-mission',{detail:{mission:latest,play:true}}));S.lastReplayAt=Date.now()}
  caption(latest,!!W()?.busy?.());
 }else caption(null,false);
 S.last=latest?{id:latest.id,status:latest.status}:null;S.timer=setTimeout(poll,POLL_MS)}
async function wake(){try{S.lock=await navigator.wakeLock?.request('screen')}catch{S.lock=null}}
function onVisible(){if(S.on&&document.visibilityState==='visible'&&!S.lock)wake()}
function idleCursor(){document.body.classList.remove('aw-watch-idle');clearTimeout(S.cursor);S.cursor=setTimeout(()=>{if(S.on)document.body.classList.add('aw-watch-idle')},IDLE_CURSOR_MS)}
function onKey(e){if(S.on&&e.key==='Escape'&&!document.fullscreenElement)stop()}
function onFullscreen(){if(S.on&&!document.fullscreenElement&&S.wasFullscreen)stop()}
function start({fullscreen=true}={}){if(S.on)return;css();S.on=true;S.last=null;S.lastReplayAt=0;document.body.classList.add('aw-watching');
 if(!expanded())W()?.view?.('theater');W()?.follow?.(true);
 if(fullscreen&&document.documentElement.requestFullscreen)document.documentElement.requestFullscreen().then(()=>{S.wasFullscreen=true}).catch(()=>{});
 wake();bar().hidden=false;caption(null,false);idleCursor();
 document.addEventListener('visibilitychange',onVisible);document.addEventListener('mousemove',idleCursor);document.addEventListener('keydown',onKey);document.addEventListener('fullscreenchange',onFullscreen);
 poll()}
function stop(){if(!S.on)return;S.on=false;clearTimeout(S.timer);clearTimeout(S.cursor);document.body.classList.remove('aw-watching','aw-watch-idle');
 document.removeEventListener('visibilitychange',onVisible);document.removeEventListener('mousemove',idleCursor);document.removeEventListener('keydown',onKey);document.removeEventListener('fullscreenchange',onFullscreen);
 try{S.lock?.release()}catch{}S.lock=null;if(document.fullscreenElement)document.exitFullscreen?.().catch(()=>{});S.wasFullscreen=false;
 if(expanded())W()?.view?.('theater');if(S.bar)S.bar.hidden=true}
window.LocalAIAgentWorldWatch={start,stop,active:()=>S.on};
})();
