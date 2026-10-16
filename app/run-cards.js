'use strict';
// Every run describes itself as a card (icon, preview, badge, action) so the UI only renders. Pure: no I/O; lookups are injected.
// STATUS mirrors LocalAIKit.statusBadge in public/ui.js: keep the two tables identical.
const STATUS = Object.freeze({awaiting_approval:['Ready to review','accent'],ready:['Ready to review','accent'],needs_attention:['Needs a look','attention'],applied:['Done','good'],completed:['Done','good'],answered:['Done','good'],running:['Running','accent'],failed:['Failed','bad'],queued:['Queued','neutral'],down:['Down','bad'],healthy:['Healthy','good'],optional_offline:['Offline','neutral']});
const KINDS = Object.freeze({chat:['compose','ask'],research:['globe','ask'],image:['image','create'],agent:['automate','agents'],automation:['refresh','automationStudio'],engineering:['build','changes']});
const LEGACY_TYPES = Object.freeze({mission:'agent',specialist:'agent'});
// Work's filter chips: which chip a run belongs to. GET /api/runs?kind= filters by it; anything not listed (automation too) is "other".
const WORK_KINDS = Object.freeze({chat:'chats',research:'chats',image:'images',agent:'missions',engineering:'changes'});
const WORK_CHIPS = Object.freeze(['chats','images','missions','changes','other']);
const workKind = run => { const t = LEGACY_TYPES[run?.type] || run?.type; return Object.prototype.hasOwnProperty.call(WORK_KINDS, t) ? WORK_KINDS[t] : 'other'; };
function badge(status) {
  const key = String(status ?? '').trim().toLowerCase(), hit = Object.prototype.hasOwnProperty.call(STATUS, key) ? STATUS[key] : null;
  if (hit) return { label: hit[0], tone: hit[1] };
  const raw = String(status ?? '').trim().replace(/[_-]+/g, ' ');
  return { label: raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : 'Unknown', tone: 'neutral' };
}
// Diff stat per file, never the patch: count +/- lines of the staged diff, else estimate from the planned operations.
const nl = t => typeof t === 'string' && t ? t.split('\n').length : 0;
function fileStats(change) {
  const diffs = Array.isArray(change.diffs) ? change.diffs : [];
  return (Array.isArray(change.files) ? change.files : []).map(f => {
    const d = diffs.find(x => x && x.path === f.path);
    if (d && typeof d.diff === 'string') { let added = 0, removed = 0; for (const l of d.diff.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) added++; else if (l.startsWith('-') && !l.startsWith('---')) removed++ } return { path: f.path, added, removed } }
    let added = 0, removed = 0;
    for (const o of Array.isArray(f.operations) ? f.operations : []) { added += nl(o.content ?? o.replace ?? o.replacement); removed += nl(o.find) }
    return { path: f.path, added, removed };
  });
}
function runCard(run, { approvalFor, changeFor } = {}) {
  run = run || {};
  const type = LEGACY_TYPES[run.type] || run.type; // older mission and specialist runs are agent runs
  const kind = Object.prototype.hasOwnProperty.call(KINDS, type) ? type : 'other';
  const [icon, view] = KINDS[kind] || ['system', 'runs'];
  const summary = String(run.summary ?? ''), out = run.output && typeof run.output === 'object' ? run.output : {}, meta = run.meta && typeof run.meta === 'object' ? run.meta : {};
  let preview = null;
  if (kind === 'chat' || kind === 'research') preview = { type: 'text', text: String(out.text || summary).slice(0, 240) };
  else if (kind === 'image') { const imgs = Array.isArray(out.images) ? out.images : []; preview = { type: 'image', src: imgs[0]?.imageUrl || '', count: imgs.length } }
  else if (kind === 'agent') preview = { type: 'mission', text: summary };
  else if (kind === 'engineering') { const ch = meta.changeId && changeFor ? changeFor(meta.changeId) : null; preview = { type: 'diff', changeId: meta.changeId || null, files: ch && Array.isArray(ch.files) ? fileStats(ch) : null } }
  const action = { label: run.status === 'awaiting_approval' ? 'Review' : run.status === 'failed' && run.retryable ? 'Retry' : 'Open' };
  let approval = null;
  if (approvalFor) { const a = approvalFor(run); if (a) approval = { id: a.id, title: a.title, detail: a.detail, risk: a.risk } }
  return { kind, icon, title: run.title || run.id || '', summary, badge: badge(run.status), preview, action, approval, view };
}
module.exports = { runCard, STATUS, workKind, WORK_CHIPS };
