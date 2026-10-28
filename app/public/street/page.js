// Agent World's page is the street: window.LocalAIStreetPage, the last of home.js's STREET_MODS. router.js calls
// enter(query) each time #agents shows. #agents[data-aw-mode] is 'street' (the default) or 'mission' (?mission=<id|latest>):
// - street: the full street mounted once into #awStreetMount, focused on ?place=<id> when it names a building. A chip tap
//   focuses its building and puts it in the URL (replace); a phone's swipe does the same through onFocus. #awPlace (the rail;
//   the sheet on a phone) shows the focused building's panel(state, world), re-rendered with each world: title, status, its
//   rows (a row with an id opens its run, or for Missions HQ its mission) and its Open link. app.css hides the mission parts.
// - mission: today's page (ui.js), handed over through window.LocalAIMissionView.show(id) (renders it fresh; 'latest' is
//   loadHistory's pick) / hide() (lowers the sheet, ends watch mode and full screen, so the old city sleeps).
//   Missions HQ's chip and its rows go there with a push (Back returns to the street); #awToStreet comes back.
// In street mode the header (#awTitle, #awStatus) and the phone's peek (#awSheetStatus) say the street's words. What the
// mission code writes there meanwhile is kept aside (a MutationObserver puts the street's words back) and put back in
// mission mode. Every text is set with textContent.
(function(root){'use strict';
const doc=root.document,$=id=>doc.getElementById(id),S=()=>root.LocalAIStreet,R=()=>root.LocalAIRouter,MV=()=>root.LocalAIMissionView;
const HEAD=['awTitle','awStatus','awSheetStatus'];
let mode=null,h=null,fid=null,world=null,want={},wrote={},kept={},seen=null,mo=null;
// /?watch=1 (watch mode, which stays on the old city) opens mission mode the first time #agents shows.
let watch=/[?&]watch=1\b/.test(root.location?.search||'');
const def=id=>S().defs().find(d=>d.id===id);
function stateOf(d){try{return d.state(world)||{}}catch{return{}}}
function panelOf(id){const d=def(id);if(!d||!d.panel)return null;try{return d.panel(stateOf(d),world)}catch(e){console.warn('Main Street: '+id+' panel failed',e);return null}}
// '<n> busy · <k> need you' from the standing buildings' chip tones, or 'All quiet'.
function summary(){
 if(!world)return'Looking down the street…';let b=0,k=0;
 for(const d of S().defs()){const s=stateOf(d);if(s.hidden)continue;let t;try{t=d.chip(s).tone}catch{continue}if(t==='busy')b++;else if(t==='attention')k++}
 return[b&&b+' busy',k&&k+' need you'].filter(Boolean).join(' · ')||'All quiet';
}
// The street's words in the header and the peek; anything else found there was the mission code's, kept for mission mode.
function guard(){
 if(mode!=='street')return;
 for(const id of HEAD){const el=$(id);if(!el||el.textContent===want[id])continue;if(el.textContent!==wrote[id])kept[id]=el.innerHTML;el.textContent=wrote[id]=want[id]}
}
function restore(){for(const id in kept){const el=$(id);if(el)el.innerHTML=kept[id]}kept={};wrote={}}
const add=(p,tag,cls,text)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);p.append(e);return e};
function render(){
 if(mode!=='street')return;
 const p=fid?panelOf(fid):null,st=summary();
 want={awTitle:'Agent World',awStatus:st,awSheetStatus:p?p.title+': '+p.status:st};guard();
 const el=$('awPlace'),sig=fid+JSON.stringify(p);if(!el||sig===seen)return;seen=sig;el.replaceChildren();
 if(!p){add(el,'p','aw-place__status','Tap a building to see what’s inside.');return}
 add(el,'h2','',p.title);add(el,'p','aw-place__status',p.status);
 if(p.rows&&p.rows.length){const l=add(el,'div','aw-place__rows');for(const r of p.rows){
  const b=add(l,r.id?'button':'div','aw-place__row');add(b,'span','',r.title);add(b,'small','',r.note);
  if(r.id){b.type='button';b.addEventListener('click',()=>p.mission?toMission(r.id):root.LocalAIRuns?.show(r.id))}
 }}
 if(p.open){
  // The workshop's Pi Hub lives where Home's back link points.
  const to=fid==='workshop'?$('homeBack')?.getAttribute('href')||'http://10.0.0.30/':String(p.open.to),a=add(el,'a','btn-outline aw-place__open',p.open.label);a.href=to;
  if(to[0]==='#')a.addEventListener('click',e=>{e.preventDefault();if(p.mission)toMission('latest');else R()?.go(to)});
 }
}
function pick(id){fid=id;h.focus(id);history.replaceState(history.state,'',location.pathname+location.search+'#agents?place='+encodeURIComponent(id));render()}
function mountOnce(){
 if(h)return;
 h=S().mount($('awStreetMount'),{mode:'full',onOpen:id=>id==='missions'?toMission('latest'):pick(id),onFocus:id=>{if(id!==fid)pick(id)},onWorld:w=>{world=w;render()}});
 mo=new MutationObserver(guard);for(const id of HEAD){const el=$(id);if(el)mo.observe(el,{childList:true,characterData:true,subtree:true})}
}
// On a phone the header (and #awToStreet) is off screen: the sheet's peek gets its own ← Street in mission mode.
function peekStreet(){
 const r=doc.querySelector('#awSheet .aw-sheet__peek');if(!r||$('awPeekStreet'))return;
 const b=doc.createElement('button');b.type='button';b.id='awPeekStreet';b.className='btn-outline aw-sheet__action';b.textContent='← Street';b.addEventListener('click',toStreet);r.prepend(b);
}
function set(m){
 const pg=$('agents');if(!pg)return false;peekStreet();if(mode==='street'&&m!=='street')restore();mode=m;pg.dataset.awMode=m;
 for(const [id,on] of [['awStreetMount',m==='street'],['awPlace',m==='street'],['awToStreet',m==='mission'],['awPeekStreet',m==='mission']]){const e=$(id);if(e)e.hidden=!on}
 return true;
}
function enter(q){
 q=q||new URLSearchParams();const m=q.get('mission');
 if(watch){watch=false;if(!m){R()?.go('#agents?mission=latest',{replace:true});return}}
 if(m){if(set('mission'))MV()?.show(m);return}
 const was=mode;if(!set('street'))return;if(was!=='street')MV()?.hide();
 // A bare #agents (← Street, Back) has no building focused, whatever was before.
 mountOnce();const p=q.get('place'),f=p&&S().defs().some(d=>d.id===p)?p:null;if(f||fid){fid=f;h.focus(f)}seen=null;render();
}
// Pushed through the router, which then shows #agents again and calls enter with the new query.
function toMission(id){R()?.go('#agents?mission='+encodeURIComponent(id||'latest'))}
function toStreet(){R()?.open('agents')}
if(doc)$('awToStreet')?.addEventListener('click',toStreet);
root.LocalAIStreetPage={enter,mode:()=>mode,toStreet,toMission};
if(typeof module==='object'&&module.exports)module.exports=root.LocalAIStreetPage;
})(typeof window!=='undefined'?window:globalThis);
