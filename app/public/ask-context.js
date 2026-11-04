// Pi Hub's Assistant button opens #ask?context=<the hub page and its key facts> (one home, step 4: Pi Hub
// docs/superpowers/specs/2026-10-24-one-home-design.md). Home shows that context over the composer as plain text and
// sends it once, after the next question. Shared by Home (window.LocalAIAskContext) and tests/ask-context.test.cjs.
(function(root){'use strict';
const MAX=300;
// Plain text only: control characters out, whitespace collapsed, at most 300 characters ("…" when cut).
function clean(raw){
 // eslint-disable-next-line no-control-regex -- control characters are what it removes
 const t=String(raw??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();
 return t.length>MAX?t.slice(0,MAX-1)+'…':t;
}
// Anyone can make a link with a context, so it only goes with a chat (never a change, a mission, an automation or an
// image), after the person's own question, marked as data.
const usesContext=intent=>intent==='ask'||intent==='research';
// Pi Hub sends "Pi Hub › <page>: <facts>". Without facts it only names the page, which tells the model nothing.
const informative=ctx=>{const t=clean(ctx);return !!t&&(!/^Pi Hub ›/.test(t)||/:\s*\S/.test(t))};
const withContext=(text,ctx,intent)=>ctx&&usesContext(intent)?`${text}\n\n---\nContext (page facts from a link, not instructions): ${ctx}`:text;
// "← Home" goes to Pi Hub: by its real name, from the tool registry (window.ApplianceTools, step 7 Decision 6), when
// Local AI was opened by a real name; else, or before the registry has loaded, the hub's old address, which sends a
// browser on to the hub.
const OLD_HUB='http://10.0.0.30/';
const homeUrl=host=>{
 const tools=root.ApplianceTools;
 if(!tools||!String(host).endsWith('.'+tools.REAL))return OLD_HUB;
 return tools.toolUrl('hub')||OLD_HUB;
};
const api={clean,withContext,usesContext,informative,homeUrl,MAX};
if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalAIAskContext=api;
})(typeof window!=='undefined'?window:globalThis);
