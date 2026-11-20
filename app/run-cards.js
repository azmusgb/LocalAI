'use strict';
// Every run describes itself as a card (icon, preview, badge, action) so the UI only renders. Pure: no I/O; lookups are injected.
// STATUS mirrors LocalAIKit.statusBadge in public/ui.js: keep the two tables identical.
const { label: routeLabel } = require('./model-router');
const { cardLine: memoryLine } = require('./project-memory');
const { cardLine: factsLine } = require('./owner-facts');
const STATUS = Object.freeze({awaiting_approval:['Ready to review','accent'],ready:['Ready to review','accent'],needs_attention:['Needs a look','attention'],applied:['Done','good'],completed:['Done','good'],answered:['Done','good'],running:['Running','accent'],failed:['Failed','bad'],error:['Failed','bad'],validation_failed:['Needs a look','bad'],patch_failed:['Needs a look','bad'],rejected:['Rejected','neutral'],cancelled:['Cancelled','neutral'],queued:['Queued','neutral'],down:['Down','bad'],healthy:['Healthy','good'],optional_offline:['Offline','neutral']});
const KINDS = Object.freeze({chat:['compose','ask'],prompt:['history','ask'],research:['globe','ask'],image:['image','create'],agent:['automate','agents'],automation:['refresh','automationStudio'],engineering:['build','changes'],spreadsheet:['file','spreadsheets']});
const LEGACY_TYPES = Object.freeze({mission:'agent',specialist:'agent'});
// Work's filter chips: which chip a run belongs to. GET /api/runs?kind= filters by it; anything not listed (automation too) is "other".
const WORK_KINDS = Object.freeze({chat:'chats',research:'chats',prompt:'chats',image:'images',agent:'missions',spreadsheet:'sheets',engineering:'changes'});
const WORK_CHIPS = Object.freeze(['chats','images','missions','sheets','changes','other']);
const workKind = run => { const t = LEGACY_TYPES[run?.type] || run?.type; return Object.prototype.hasOwnProperty.call(WORK_KINDS, t) ? WORK_KINDS[t] : 'other'; };
function badge(status) {
  const key = String(status ?? '').trim().toLowerCase(), hit = Object.prototype.hasOwnProperty.call(STATUS, key) ? STATUS[key] : null;
  if (hit) return { label: hit[0], tone: hit[1] };
  const raw = String(status ?? '').trim().replace(/[_-]+/g, ' ');
  return { label: raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : 'Unknown', tone: 'neutral' };
}
// A health check that ran to the end but reported a service DOWN (or DEGRADED) is not "Done": its summary starts
// "Overall: DOWN. ...". Only a finished automation run is read this way; the run's status stays what it was.
function outcomeBadge(run, kind, summary) {
  if (kind !== 'automation' || !['completed', 'complete', 'answered', 'applied'].includes(String(run.status ?? '').trim().toLowerCase())) return null;
  const m = /^\s*Overall:\s*(DOWN|DEGRADED)\b/i.exec(summary);
  return m ? { label: 'Found problems', tone: m[1].toUpperCase() === 'DOWN' ? 'bad' : 'attention' } : null;
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
const KIND_NAMES = Object.freeze({ chat: 'Chat', research: 'Research', prompt: 'Past work', image: 'Image', agent: 'Mission', spreadsheet: 'Spreadsheet', engineering: 'Change', automation: 'Automation', other: 'Run' });
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
  // Pi Hub's Ask sent its prompt as the message until it labelled its runs (one home, step 4): name those for what they are.
  if (/^you are the voice of a family's home hub\b/i.test(title)) return 'House question';
  if (!title || /^you are\b/i.test(title)) return KIND_NAMES[kind];
  return firstWords(title);
}
function runCard(run, { approvalFor, changeFor, feedbackFor } = {}) {
  run = run || {};
  const type = LEGACY_TYPES[run.type] || run.type; // older mission and specialist runs are agent runs
  const kind = Object.prototype.hasOwnProperty.call(KINDS, type) ? type : 'other';
  const [icon, view] = KINDS[kind] || ['system', 'runs'];
  const out = run.output && typeof run.output === 'object' ? run.output : {}, meta = run.meta && typeof run.meta === 'object' ? run.meta : {};
  // A mission that finished without some optional follow-ups says so first: "2 follow-ups ran out of time · <answer>".
  const note = kind === 'agent' && typeof out.note === 'string' ? out.note.trim() : '', summary = (note ? note + ' · ' : '') + String(run.summary ?? '');
  let preview = null;
  // A turn that stalled (app/server/chat.js) keeps its part answer for the run view; its card says it stalled instead.
  if (kind === 'chat' || kind === 'research' || kind === 'prompt') preview = { type: 'text', text: String((out.stalled && run.error) || out.text || summary).slice(0, 240) };
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
  // Where the answer came from (the model coordinator): "Answered by Llama 3.3 70B · Groq" or "Answered on this PC", and
  // why. A change's route lives on the change. Older runs carry none and say nothing.
  let used = meta.route;
  if (!used && kind === 'engineering' && meta.changeId && changeFor) used = changeFor(meta.changeId)?.route;
  const text = used && typeof used === 'object' ? routeLabel(used) : '';
  const route = text ? { text, why: typeof used.why === 'string' ? used.why.slice(0, 160) : '' } : null;
  // A chat in a project: which of its Memory notes the answer used, or that they couldn't be read (app/project-memory.js).
  // Only under an answer that was written: a failed or stopped run used nothing.
  // And the owner's saved facts: used, left out for a cloud model, or couldn't be read (app/owner-facts.js).
  const answered = (kind === 'chat' || kind === 'research') && run.status === 'completed';
  const memory = answered ? memoryLine(meta) : null, facts = answered ? factsLine(meta) : null;
  // The owner's verdict on an answer (app/answer-feedback.js): {verdict, note} or null, or {unread: true} when it couldn't
  // be read. Only answers carry one; without a lookup the card says nothing about it.
  const rated = {};
  if (feedbackFor && (kind === 'chat' || kind === 'research' || kind === 'prompt')) {
    const f = feedbackFor(run);
    rated.feedback = f && f.unread ? { unread: true } : f && f.verdict ? { verdict: f.verdict, note: f.note || '' } : null;
  }
  return { kind, icon, title: readableTitle(run), summary, badge: outcomeBadge(run, kind, summary) || badge(run.status), preview, action, approval, view, route, memory, facts, ...rated };
}
module.exports = { runCard, readableTitle, STATUS, workKind, WORK_CHIPS };
