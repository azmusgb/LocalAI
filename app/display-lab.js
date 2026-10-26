'use strict';

// The Workshop display's Judge it sheet (docs/WORKSHOP-DISPLAY.md › Local AI cards): the same sheet as the phone's
// (app/public/print-lab.js), stepped one strip per screen on the display. Both routes need the display key.
// GET /api/display/lab/judge?run=<id>: the sheet for the run on the judge card (labStore.judgeTarget), built from the
//   experiment's stored record: its strips (variant tabs) and criteria. An experiment without criteria is judged on
//   the phone only, as on the Print lab page.
// POST /api/display/lab/verdict {run, requestId, grades, inconclusive, replace}: checks the run is still the judge
//   card's and the grades against the record, then queues the very request the phone sends (labStore.queueRequest),
//   with lighting "diagnostic" (the phone's default) and no note. The Mac applies it with lab pull.
// Everything from the record is the Mac's data, passed on as strings only.

const MAX_BODY = 4 * 1024;
const RUN_RE = /^[A-Z]{1,4}-\d{1,6}(-\d{2})?$/;
const MAX_REASON = 500;
const MOVED = 'This print has changed. Open it again.';
const PHONE_ONLY = 'Judge it on your phone: this test compares A and B';
const UNPAIRED = 'Pair the display with Local AI.';
const str = v => typeof v === 'string' && v.length > 0;

// The strips and criteria the sheet shows, from the record: the Mac grades only role "variant" strips, by tab (else id).
function sheetOf(record) {
  const tabs = (Array.isArray(record?.variants) ? record.variants : [])
    .filter(v => v && (v.role === undefined || v.role === 'variant'))
    .map(v => (str(v.tab) ? v.tab : v.id)).filter(str);
  const criteria = (Array.isArray(record?.criteria) ? record.criteria : [])
    .filter(c => c && str(c.key) && str(c.label) && Array.isArray(c.choices) && c.choices.length && c.choices.every(str))
    .map(c => ({ key: c.key, label: c.label, choices: [...c.choices] }));
  return { tabs: [...new Set(tabs)], criteria };
}

const plainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// What is wrong with the grades, or null. Every strip and criterion must be the record's and every value one of the
// criterion's choices or null ("–", not judged). Without an inconclusive reason every strip is graded on every
// criterion, as the phone's Send requires.
function gradesProblem(grades, { tabs, criteria }, inconclusive) {
  if (!plainObject(grades)) return 'grades must be {strip: {criterion: choice}}.';
  const byKey = new Map(criteria.map(c => [c.key, c]));
  for (const [tab, g] of Object.entries(grades)) {
    if (!tabs.includes(tab)) return `${tab} isn't a strip of this test.`;
    if (!plainObject(g)) return 'grades must be {strip: {criterion: choice}}.';
    for (const [k, choice] of Object.entries(g)) {
      const c = byKey.get(k);
      if (!c) return `${k} isn't a criterion of this test.`;
      if (choice !== null && !c.choices.includes(choice)) return `${String(choice)} isn't a choice for ${c.label}.`;
    }
  }
  if (inconclusive === null) {
    for (const tab of tabs) for (const c of criteria) {
      if (!(tab in grades) || !(c.key in grades[tab])) return `Judge strip ${tab} on ${c.label}, or mark it inconclusive.`;
    }
  }
  return null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, over = false;
    req.on('data', c => { if (over) return; size += c.length; if (size > limit) { over = true; chunks.length = 0; return; } chunks.push(c); });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// The queued request's time comes from the print lab's own clock, as the phone's does.
function createDisplayLab({ labStore, json, authorized = () => false }) {
  // The verdict requests for this run, newest first.
  const verdictRequests = (t) => labStore.requestsFor(t.project)
    .filter(r => r && r.kind === 'verdict' && r.experiment === t.experiment.id && r.run === t.run)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  // The target for `run`, or null when the judge card is gone or names another run.
  const targetFor = run => { const t = labStore.judgeTarget(); return t && RUN_RE.test(String(run || '')) && t.run === run ? t : null; };

  async function judge(req, res, url) {
    if (!authorized(req)) return json(res, 401, { error: UNPAIRED });
    const t = targetFor(url.searchParams.get('run'));
    if (!t) return json(res, 409, { error: MOVED });
    const base = { experiment: t.experiment.id, run: t.run, judgeOn: str(t.record?.judge_on) ? t.record.judge_on : (str(t.experiment.judge_on) ? t.experiment.judge_on : '') };
    const sheet = sheetOf(t.record);
    if (!sheet.criteria.length || !sheet.tabs.length) return json(res, 200, { ...base, phoneOnly: true, reason: PHONE_ONLY });
    const reqs = verdictRequests(t);
    const v = t.experiment.verdict || t.experiment.owner_verdict;
    const waiting = reqs.find(r => r.status === 'pending');
    const judged = plainObject(v) ? { at: str(v.at) ? v.at : null, by: str(v.by) ? v.by : null }
      : waiting ? { at: waiting.at, by: waiting.by === 'display' ? 'display' : 'phone' } : null;
    const last = reqs[0];
    json(res, 200, { ...base, ...sheet, judged, pending: last ? { id: last.id, status: last.status, message: last.message ?? null } : null });
  }

  async function verdict(req, res) {
    if (!authorized(req)) { req.resume(); return json(res, 401, { error: UNPAIRED }); }
    const raw = await readBody(req, MAX_BODY);
    if (!raw) return json(res, 413, { error: 'Too large for the print lab.' });
    let data;
    try { data = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'Invalid JSON request body' }); }
    if (!plainObject(data)) return json(res, 400, { error: 'Send {run, requestId, grades, inconclusive}.' });
    const t = targetFor(data.run);
    if (!t) return json(res, 409, { error: MOVED });
    const sheet = sheetOf(t.record);
    if (!sheet.criteria.length || !sheet.tabs.length) return json(res, 409, { error: PHONE_ONLY });
    let inconclusive = null;
    if (data.inconclusive !== null && data.inconclusive !== undefined) {
      inconclusive = typeof data.inconclusive === 'string' ? data.inconclusive.trim() : '';
      if (!inconclusive || [...inconclusive].length > MAX_REASON) return json(res, 400, { error: `An inconclusive reason is up to ${MAX_REASON} characters of text, or null.` });
    }
    const problem = gradesProblem(data.grades, sheet, inconclusive);
    if (problem) return json(res, 400, { error: problem });
    // The phone's body (app/public/print-lab.js sendVerdict), field for field.
    const body = { id: data.requestId, kind: 'verdict', experiment: t.experiment.id, run: t.run,
      payload: { grades: data.grades, lighting: 'diagnostic', note: null, inconclusive, replace: data.replace === true } };
    const [status, answer] = labStore.queueRequest(t.project, body, 'display');
    if (status !== 200) return json(res, status, answer);
    json(res, 202, { id: answer.id, status: answer.status });
  }

  return { judge, verdict };
}

module.exports = { createDisplayLab, sheetOf };
