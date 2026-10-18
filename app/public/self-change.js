// A request to change Local AI itself ("Improve the look and feel of Agent World") is better done by Claude Code, which
// reads the code and opens a tested pull request, than by a mission on this computer's models (measured 18 Oct 2026:
// both models gave wrong or empty answers). isSelfChange() spots one; offer() shows the one-line suggestion with
// Hand to Claude and the owner's own way (start the mission anyway). Shared by app/server.js (routeIntent), Home,
// Agent World's start sheet and Improve's New idea (window.LocalAISelfChange), and tests/self-change.test.cjs.
(function(root){'use strict';
const VERB=/\b(improve|fix|update|upgrade|refactor|patch|implement|modify|change|enhance|adjust|rewrite|redesign|rethink|rework|restyle|polish|tidy|clean up|simplify|tweak|add|remove|build|make|review|audit)\b/;
// Local AI and its pages by name. Generic words (home, library, work) count only as "… page", "… tab" or "… screen",
// and words that are as likely about something else (a menu, a UI) count only with "this" or "your": a mission
// to "make a dinner menu" is a plain mission.
const SELF=/\b(local ?ai|this (?:site|app|application|ui|page|navigation|dashboard|appliance)|your (?:ui|navigation|site|app|own code|code|pages?|sidebar|menus?)|the appliance|agent world|claude code page|(?:home|work|projects?|library|sources|memory|backlog|signals|inbox|health|models|services|automations|spreadsheets|images|chat|missions?)\s+(?:page|tab|screen|view))\b/;
const QUESTION=/^(how|what|why|which|where|when|explain|describe|tell me|show me how|can you explain|could you explain)\b/;
function isSelfChange(text){const t=String(text||'').toLowerCase().replace(/\s+/g,' ').trim();return !!t&&!QUESTION.test(t)&&VERB.test(t)&&SELF.test(t)}

// The suggestion, in `box` (emptied and shown): Hand to Claude posts the text to /api/improve/handoff and toasts;
// the other button is the owner's own way and runs `anyway`. Either one closes the suggestion.
function offer(box,{text,from,anywayLabel='Start a mission anyway',anyway,onHanded}={}){
 if(!box)return;const UI=root.LocalAIUI||{};
 box.hidden=false;box.classList.add('self-change');
 box.innerHTML='<p>This is a change to Local AI itself. Claude Code reviews the code and opens a tested pull request.</p><p class="self-change__actions"><button type="button" class="btn-primary" data-self-change="hand">Hand to Claude</button><button type="button" class="btn-outline" data-self-change="anyway"></button></p><p class="self-change__error" role="alert" hidden></p>';
 const [hand,other]=box.querySelectorAll('[data-self-change]'),err=box.querySelector('.self-change__error');other.textContent=anywayLabel;
 hand.onclick=async()=>{hand.disabled=true;err.hidden=true;
  try{const r=await fetch('/api/improve/handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:typeof text==='function'?text():text,from})});
   const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'HTTP '+r.status);
   hide(box);UI.toast?.('Handed to Claude Code — it appears in Improve › In progress');onHanded?.(j.item)}
  catch(e){err.textContent='Couldn’t hand it over: '+e.message;err.hidden=false}finally{hand.disabled=false}};
 other.onclick=()=>{hide(box);anyway?.()};
}
function hide(box){if(box){box.hidden=true;box.replaceChildren()}}
const api={isSelfChange,offer,hide};
if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalAISelfChange=api;
})(typeof window!=='undefined'?window:globalThis);
