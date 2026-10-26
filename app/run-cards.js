'use strict';
// Every run describes itself as a card (icon, preview, badge, action) so the UI only renders. Pure: no I/O; lookups are injected.
// STATUS mirrors LocalAIKit.statusBadge in public/ui.js: keep the two tables identical.
const STATUS = Object.freeze({awaiting_approval:['Ready to review','accent'],ready:['Ready to review','accent'],needs_attention:['Needs a look','attention'],applied:['Done','good'],completed:['Done','good'],answered:['Done','good'],running:['Running','accent'],failed:['Failed','bad'],error:['Failed','bad'],validation_failed:['Needs a look','bad'],patch_failed:['Needs a look','bad'],rejected:['Rejected','neutral'],cancelled:['Cancelled','neutral'],queued:['Queued','neutral'],down:['Down','bad'],healthy:['Healthy','good'],optional_offline:['Offline','neutral']});
const KINDS = Object.freeze({chat:['compose','ask'],research:['globe','ask'],image:['image','create'],agent:['automate','agents'],automation:['refresh','automationStudio'],engineering:['build','changes'],spreadsheet:['file','spreadsheets']});
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
// Recent and Work show a readable title, never a long prompt (Pi Hub one home, step 4): a label the caller gave
// (meta.label, from /api/chat's `title`), else the run's own title when it is whole (one line, up to 72 characters),
// else its first words cut at a word with "…" (titleFromText keeps 69 characters of a long first message and adds "…").
// A title that is an instruction ("You are …", e.g. the hub's House questions from before they carried a label) shows
// the kind's name instead. run.title itself is unchanged, so Needs you still groups repeats by it.
const KIND_NAMES = Object.freeze({ chat: 'Chat', research: 'Research', image: 'Image', agent: 'Mission', spreadsheet: 'Spreadsheet', engineering: 'Change', automation: 'Automation', other: 'Run' });
const TITLE_MAX = 72;
function firstWords(title) {
  const lines = title.split(/[\r\n]+/), first = lines[0].replace(/\s+/g, ' ').trim();
  let t = first.replace(/\s*…$/, '');
  if (lines.length === 1 && !first.endsWith('…') && t.length <= TITLE_MAX) return t;
  if (t.length > TITLE_MAX - 1) t = t.slice(0, TITLE_MAX - 1);
  const space = t.lastIndexOf(' ');
  if (space >= 20) t = t.slice(0, space);  // the last word may be cut: drop it (a single long word stays as it is)
  return t.replace(/[\s,;:.\-–—]+$/, '') + '…';
}
function readableTitle(run) {
  const type = LEGACY_TYPES[run?.type] || run?.type, kind = Object.prototype.hasOwnProperty.call(KIND_NAMES, type) ? type : 'other';
  const label = typeof run?.meta?.label === 'string' ? run.meta.label.trim().slice(0, 80) : '';
  if (label) return label;
  const title = typeof run?.title === 'string' ? run.title.trim() : '';
  if (!title || /^you are\b/i.test(title)) return KIND_NAMES[kind];
  return firstWords(title);
}
function runCard(run, { approvalFor, changeFor } = {}) {
  run = run || {};
  const type = LEGACY_TYPES[run.type] || run.type; // older mission and specialist runs are agent runs
  const kind = Object.prototype.hasOwnProperty.call(KINDS, type) ? type : 'other';
  const [icon, view] = KINDS[kind] || ['system', 'runs'];
  const out = run.output && typeof run.output === 'object' ? run.output : {}, meta = run.meta && typeof run.meta === 'object' ? run.meta : {};
  // A mission that finished without some optional follow-ups says so first: "2 follow-ups ran out of time · <answer>".
  const note = kind === 'agent' && typeof out.note === 'string' ? out.note.trim() : '', summary = (note ? note + ' · ' : '') + String(run.summary ?? '');
  let preview = null;
  if (kind === 'chat' || kind === 'research') preview = { type: 'text', text: String(out.text || summary).slice(0, 240) };
  else if (kind === 'image') { const imgs = Array.isArray(out.images) ? out.images : []; preview = { type: 'image', src: imgs[0]?.imageUrl || '', count: imgs.length } }
  else if (kind === 'agent') preview = { type: 'mission', text: summary };
  else if (kind === 'spreadsheet') preview = { type: 'text', text: String(out.text || summary).slice(0, 240) };
  else if (kind === 'engineering') {
    const ch = meta.changeId && changeFor ? changeFor(meta.changeId) : null, files = ch && Array.isArray(ch.files) ? fileStats(ch) : null;
    // No file list: still being prepared while it runs or waits for approval; once finished (failed, cancelled, done) there's nothing to show.
    preview = files || ['running', 'queued', 'awaiting_approval'].includes(run.status) ? { type: 'diff', changeId: meta.changeId || null, files } : null; }
  const action = { label: run.status === 'awaiting_approval' ? 'Review' : run.status === 'failed' && run.retryable ? 'Retry' : 'Open' };
  let approval = null;
  if (approvalFor) { const a = approvalFor(run); if (a) approval = { id: a.id, title: a.title, detail: a.detail, risk: a.risk } }
  return { kind, icon, title: readableTitle(run), summary, badge: badge(run.status), preview, action, approval, view };
}
module.exports = { runCard, readableTitle, STATUS, workKind, WORK_CHIPS };
