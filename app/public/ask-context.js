// Pi Hub's Assistant button opens #ask?context=<the hub page and its key facts> (one home, step 4: Pi Hub
// docs/superpowers/specs/2026-10-24-one-home-design.md). Home shows that context over the composer as plain text and
// sends it once, after the next question. Shared by Home (window.LocalAIAskContext) and tests/ask-context.test.cjs.
(function(root){'use strict';
const MAX=300;
// Plain text only: control characters out, whitespace collapsed, at most 300 characters ("…" when cut).
function clean(raw){
 const t=String(raw??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();
 return t.length>MAX?t.slice(0,MAX-1)+'…':t;
}
const withContext=(text,ctx)=>ctx?`${text}\n\nContext: ${ctx}`:text;
// "← Home" goes to Pi Hub: by its home.arpa name when Local AI was opened by one, else the hub's old address, which
// works on every device before the names do.
const homeUrl=host=>host==='home.arpa'||String(host).endsWith('.home.arpa')?'https://home.home.arpa/':'http://10.0.0.30/';
const api={clean,withContext,homeUrl,MAX};
if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalAIAskContext=api;
})(typeof window!=='undefined'?window:globalThis);
