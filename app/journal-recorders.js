'use strict';

// Recorders turn events Local AI already sees into journal entries (app/journal.js). Each builder is pure and
// returns null when there is nothing to record. They record the Assistant's own work only (amendment A28 D1 and D2):
// runs, voice answers, approval decisions and Local AI's own releases. record() is how callers write one: it never
// throws, so a journal that fails never breaks the thing being recorded.

const { titleFromText, wrappedQuestion } = require('./prompt-title');

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const str = v => (typeof v === 'string' ? v.trim() : '');
// What the owner asked: the prompt, or the question it wraps in instructions (Pi Hub's House question), never the
// instructions themselves.
const askedOf = run => wrappedQuestion(run?.input?.prompt) || str(run?.input?.prompt);
// An entry is named by the run's title, except a run whose prompt wraps a question, which is named by that question
// (its run title is the instructions' first words, or a caller's label such as "House question").
const runTitle = run => { const q = wrappedQuestion(run?.input?.prompt); return q ? titleFromText(q) : run?.title; };

// The readable result of a run: its own text, then the summary, then a bare outcome.
function runText(run) {
  const o = run?.output;
  let text = typeof o === 'string' ? o.trim() : '';
  if (!text && o && typeof o === 'object') text = str(o.text) || str(o.answer) || str(o.content);
  if (!text) text = str(run?.summary);
  if (!text && o && typeof o === 'object') text = str(o.outcome) || str(o.preview);
  const asked = askedOf(run), title = str(runTitle(run));
  if (asked && asked !== title && !text.includes(asked)) text = text ? `${text}\nAsked: ${asked}` : `Asked: ${asked}`;
  return text;
}

function runEntry(run) {
  if (!run || typeof run.id !== 'string' || !TERMINAL.has(run.status)) return null;
  // A Past work answer (app/journal-ask.js) is made from journal entries; kept, it would be cited instead of the work.
  if (run.meta?.mode === 'history') return null;
  const hidden = run.type === 'powershell' || run.meta?.powershell === true; // host commands: title only
  const body = hidden ? '' : run.status === 'failed' && !runText({ ...run, summary: '' }) ? str(run.error) : runText(run);
  return {
    at: run.finishedAt || run.updatedAt || run.createdAt, source: 'run', kind: String(run.type || 'task'), title: runTitle(run),
    body, link: `#run/${run.id}`, ref: `run:${run.id}:${run.status}`, meta: { status: run.status, type: run.type }
  };
}

const iso = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : undefined; };

// A spoken answer that has no run of its own (the clock, Needs you, health, weather, a refusal, a started job). One a
// run answered is that run's entry (runEntry), so it is not written twice; a Past work answer is made from journal
// entries and is never written back (A28 D5).
function voiceEntry({ intent, question, answer, runId, at } = {}) {
  const kind = str(intent), title = str(question), body = str(answer);
  if (!kind || kind === 'history' || !title || !body || runId) return null;
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(t)) return null;
  return { at: new Date(t).toISOString(), source: 'voice', kind, title, body, ref: `voice:${t}`, meta: { intent: kind } };
}

// An approval decided in the app or on the Workshop display. Same ref as the one-time import's (app/journal-import.js),
// so a decision the import already took is not written again. Host commands keep their text out, as PowerShell runs do.
const WHERE = { app: 'in Local AI', display: 'on the Workshop display', workbench: 'in the PowerShell Workbench' };
function approvalEntry(item, { where = 'app', at } = {}) {
  if (!item || typeof item.id !== 'string' || !['approved', 'rejected'].includes(item.status)) return null;
  const hidden = item.meta?.powershell === true || /^ps-/.test(String(item.meta?.jobId || ''));
  const said = `${item.status === 'approved' ? 'Approved' : 'Declined'} ${WHERE[where] || WHERE.app}.`;
  const detail = hidden ? '' : str(item.detail);
  return {
    at: iso(at) || iso(item.updatedAt), source: 'approval', kind: item.status, title: str(item.title) || 'Approval',
    body: detail ? `${said}\n${detail}` : said, ref: `approval:${item.id}:${item.status}`,
    meta: { approvalId: item.id, by: WHERE[where] ? where : 'app', ...(item.meta?.changeId ? { changeId: item.meta.changeId } : {}) }
  };
}

// A PowerShell job approved or declined in the Workbench (app/server/powershell.js). Its ids are `ps-…`, so its refs
// never meet an approval's (`approval-…`, the one-time import's too). Cancelling a job that was still waiting for approval
// is declining it, so both give the one `rejected` entry. Never the script, its folder or its output: title and risk only.
const PS_DECIDED = { approved: 'approved', rejected: 'rejected' };
function powerShellApprovalEntry(job, { cancelledFrom, at } = {}) {
  if (!job || typeof job.id !== 'string' || !/^ps-/.test(job.id)) return null;
  const status = job.status === 'cancelled' ? (cancelledFrom === 'pending_approval' ? 'rejected' : null) : PS_DECIDED[job.status];
  if (!status) return null;
  const risk = ['low', 'medium', 'high'].includes(job.risk) ? ` (${job.risk} risk)` : '';
  return approvalEntry({ id: job.id, title: `PowerShell job${risk}`, status, updatedAt: job.updatedAt, meta: { powershell: true, jobId: job.id } }, { where: 'workbench', at });
}

// The release Local AI is running (app/release.js readRelease), with the merged PR titles the deploy wrote as its notes.
function releaseEntry(release, { version, at } = {}) {
  if (!release || typeof release.commit !== 'string' || !release.commit) return null;
  const v = str(version) || str(release.version) || release.commit.slice(0, 7);
  const notes = (Array.isArray(release.notes) ? release.notes : []).map(n => str(n?.title)).filter(Boolean);
  return {
    at: iso(release.deployedAt) || iso(at), source: 'release', kind: 'update', title: `Local AI updated to ${v}`,
    body: notes.join('\n'), ref: `release:${release.commit}`, meta: { commit: release.commit, version: v }
  };
}

// Writes one entry; make is the entry or a function that builds it. Never throws: answers null when there was nothing to
// record or the journal failed (app/journal.js logs that), else {id}.
function record(journal, make) {
  try {
    const entry = typeof make === 'function' ? make() : make;
    return entry ? journal.record(entry) || null : null;
  } catch { return null; }
}

// At start-up: the running release, once. Setting journal-release holds the last commit recorded, so a restart on the
// same release adds nothing; it is stored only after the entry is written, so a journal that failed tries again on the
// next start. A setting that can't be read records nothing (unknown is not "never recorded").
const RELEASE_SETTING = 'journal-release';
function recordRelease({ journal, storage, release, version, now = Date.now }) {
  try {
    if (!release?.commit) return null;
    const last = storage.readSetting(RELEASE_SETTING, null);
    if (last?.commit === release.commit) return null;
    const done = record(journal, () => releaseEntry(release, { version, at: now() }));
    if (done) storage.writeSetting(RELEASE_SETTING, { commit: release.commit, at: new Date(now()).toISOString() });
    return done;
  } catch { return null; }
}

module.exports = { runEntry, runText, voiceEntry, approvalEntry, powerShellApprovalEntry, releaseEntry, record, recordRelease, RELEASE_SETTING };
