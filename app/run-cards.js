'use strict';
// Every run describes itself as a card (icon, preview, badge, action) so the UI only renders. Pure: no I/O; lookups are injected.
// STATUS mirrors LocalAIKit.statusBadge in public/ui.js: keep the two tables identical.
const STATUS = Object.freeze({awaiting_approval:['Ready to review','accent'],ready:['Ready to review','accent'],needs_attention:['Needs a look','attention'],applied:['Done','good'],completed:['Done','good'],answered:['Done','good'],running:['Running','accent'],failed:['Failed','bad'],queued:['Queued','neutral'],down:['Down','bad'],healthy:['Healthy','good'],optional_offline:['Offline','neutral']});
const KINDS = Object.freeze({chat:['compose','ask'],research:['globe','ask'],image:['image','create'],agent:['automate','agents'],automation:['refresh','automationStudio'],engineering:['build','changes']});
function badge(status) {
  const key = String(status ?? '').trim().toLowerCase(), hit = Object.prototype.hasOwnProperty.call(STATUS, key) ? STATUS[key] : null;
  if (hit) return { label: hit[0], tone: hit[1] };
  const raw = String(status ?? '').trim().replace(/[_-]+/g, ' ');
  return { label: raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : 'Unknown', tone: 'neutral' };
}
function runCard(run, { approvalFor, changeFor } = {}) {
  run = run || {};
  const kind = Object.prototype.hasOwnProperty.call(KINDS, run.type) ? run.type : 'other';
  const [icon, view] = KINDS[kind] || ['system', 'runs'];
  const summary = String(run.summary ?? ''), out = run.output && typeof run.output === 'object' ? run.output : {}, meta = run.meta && typeof run.meta === 'object' ? run.meta : {};
  let preview = null;
  if (kind === 'chat' || kind === 'research') preview = { type: 'text', text: String(out.text || summary).slice(0, 240) };
  else if (kind === 'image') { const imgs = Array.isArray(out.images) ? out.images : []; preview = { type: 'image', src: imgs[0]?.imageUrl || '', count: imgs.length } }
  else if (kind === 'agent') preview = { type: 'mission', text: summary };
  else if (kind === 'engineering') { const ch = meta.changeId && changeFor ? changeFor(meta.changeId) : null; preview = { type: 'diff', changeId: meta.changeId || null, files: ch && Array.isArray(ch.files) ? ch.files : null } }
  const action = { label: run.status === 'awaiting_approval' ? 'Review' : run.status === 'failed' && run.retryable ? 'Retry' : 'Open' };
  let approval = null;
  if (approvalFor) { const a = approvalFor(run); if (a) approval = { id: a.id, title: a.title, detail: a.detail, risk: a.risk } }
  return { kind, icon, title: run.title || run.id || '', summary, badge: badge(run.status), preview, action, approval, view };
}
module.exports = { runCard, STATUS };
