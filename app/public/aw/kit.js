// Agent World's on-demand modules live in app/public/aw/. ui.js fetches each one listed in its AW_MODS the first time
// the city is on screen (Missions, or a mission's run view), never with the shell, so they have their own budget
// (tests/budgets.test.cjs: 12 KB in all, 4 KB each, gzipped). sw.js precaches them for offline use.
//
// A module adds to the city with window.LocalAIAgentWorld.addLayer({...}). Every key is optional:
//   reserve  [{x,y,w,h}] in tiles (LocalAIAgentWorld.grid: 40 x 23 tiles of 32 px). No worker, flow, tree or lamp
//            ever enters them; check free blocks with window.__awcLayout (localai.debug = 1) before drawing art there.
//   ground   {sig(), paint(ctx, env)}: painted into the cached ground layer under the day/night light, in world pixels.
//            It is repainted only when sig() returns something new, so make sig() cheap and change it only with state.
//   draw     (ctx, ts, env): a small overlay every frame, over the buildings and under the workers. Keep it to a few
//            fills; with env.reduced (reduced motion) show state by colour and words, not movement.
//   hit      (x, y) in world pixels → {id, label, detail} or null: a tap there selects it.
//   rows     () → [{id, label, detail}]: the City services list beside the crew, the canvas's accessible equivalent.
//   open     (item): called for a tap (hit) or a row. A tap and its row should open the same thing.
// env is {night, reduced}. A layer that throws is skipped for that call. addLayer returns {refresh(), remove()}: call
// refresh() when rows change. Text from outside goes through clean() below before it is drawn or listed (rows are
// escaped by ui.js; fillText needs no escaping but still gets control and direction characters stripped).
(function(root){'use strict';
// C0 and C1 controls, and the bidi marks, embeddings, overrides and isolates (U+200E/F, U+202A-E, U+2066-9).
// eslint-disable-next-line no-control-regex
const BAD=/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
// One line of plain text, at most n characters (code points), cut with an ellipsis.
function clean(s,n=80){const t=String(s??'').replace(BAD,' ').replace(/\s+/g,' ').trim(),a=[...t];return a.length>n?a.slice(0,Math.max(1,n-1)).join('').trimEnd()+'…':t}
const api={clean};
root.LocalAIAWKit=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
