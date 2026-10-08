'use strict';

const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'app', 'server.js');
const uiPath = path.join(__dirname, '..', 'app', 'public', 'execution-runtime.js');
let source = fs.readFileSync(serverPath, 'utf8');
let ui = fs.readFileSync(uiPath, 'utf8');

function safeIdentifier(value) { return /^[A-Za-z_$][\w$]*$/.test(String(value || '')) ? String(value) : ''; }
function findFunctionRange(text, name) {
  const safe = safeIdentifier(name);
  if (!safe) throw new Error(`Invalid function name: ${name}`);
  const rx = new RegExp(`(?:async\\s+)?function\\s+${safe.replace(/[$]/g, '\\$&')}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const match = rx.exec(text);
  if (!match) throw new Error(`function ${safe} was not found`);
  if (rx.test(text.slice(match.index + match[0].length))) throw new Error(`function ${safe} is not unique`);
  const open = match.index + match[0].lastIndexOf('{');
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (escaped) { escaped = false; continue; } if (c === '\\') { escaped = true; continue; } if (c === quote) quote = ''; continue; }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { start: match.index, end: i + 1 };
  }
  throw new Error(`function ${safe} has an unmatched body`);
}
function replaceFunction(name, fn) {
  const range = findFunctionRange(source, name);
  const replacement = fn.toString().replace(/^((?:async\s+)?function\s+)[A-Za-z_$][\w$]*/, `$1${name}`);
  source = source.slice(0, range.start) + replacement + source.slice(range.end);
}

function replacementLegacyUnifiedRuns() {
  const items = [];
  for (const run of agentRunStore().slice(0, 200)) {
    const status = normalizedExecutionStatus(run.status);
    items.push({
      id: 'legacy-agent:' + run.id,
      type: 'agent',
      title: titleFromText(run.goal, 'Agent run'),
      status,
      progress: executionProgress(status, run.plan),
      createdAt: run.createdAt || null,
      startedAt: run.createdAt || null,
      updatedAt: run.updatedAt || run.createdAt || null,
      finishedAt: ['completed','failed','cancelled'].includes(status) ? (run.updatedAt || null) : null,
      summary: String(run.answer || run.error || '').slice(0, 1200),
      input: { goal: String(run.goal || '').slice(0, 4000), projectId: run.projectId || '' },
      output: run.answer || null,
      error: run.error || null,
      artifactIds: [],
      source: { kind: 'agent', id: run.id },
      meta: { sources: Array.isArray(run.sources) ? run.sources.length : 0 },
      cancellable: false,
      retryable: ['completed','failed'].includes(status),
      attempt: Number.isSafeInteger(Number(run.attempt)) && Number(run.attempt) > 0 ? Number(run.attempt) : 1,
      retryOf: run.retryOf || null,
      events: legacyEvents(run)
    });
  }
  for (const run of automationRunStore().slice(0, 200)) {
    const status = normalizedExecutionStatus(run.status);
    items.push({
      id: 'legacy-automation:' + run.id,
      type: 'automation',
      title: titleFromText(run.name, 'Automation run'),
      status,
      progress: executionProgress(status),
      createdAt: run.startedAt || null,
      startedAt: run.startedAt || null,
      updatedAt: run.finishedAt || run.startedAt || null,
      finishedAt: ['completed','failed','cancelled'].includes(status) ? (run.finishedAt || null) : null,
      summary: String(run.output || run.error || '').slice(0, 1200),
      input: { automationId: run.automationId || '' },
      output: run.output || null,
      error: run.error || null,
      artifactIds: [],
      source: { kind: 'automation', id: run.id },
      meta: { automationId: run.automationId || '' },
      cancellable: false,
      retryable: ['completed','failed'].includes(status),
      attempt: Number.isSafeInteger(Number(run.attempt)) && Number(run.attempt) > 0 ? Number(run.attempt) : 1,
      retryOf: run.retryOf || null,
      events: legacyEvents(run)
    });
  }
  for (const run of effectiveEngineeringRuns().slice(0, 200)) {
    const status = normalizedExecutionStatus(run.status);
    items.push({
      id: 'legacy-engineering:' + run.id,
      type: 'engineering',
      title: titleFromText(run.request, 'Engineering run'),
      status,
      progress: executionProgress(status, run.steps),
      createdAt: run.createdAt || null,
      startedAt: run.createdAt || null,
      updatedAt: run.updatedAt || run.createdAt || null,
      finishedAt: ['completed','failed','cancelled'].includes(status) ? (run.updatedAt || null) : null,
      summary: String(run.error || run.changeStatus || '').slice(0, 1200),
      input: { request: String(run.request || '').slice(0, 4000), target: run.target || '', root: run.root || '' },
      output: run.finalChangeId ? { changeId: run.finalChangeId, changeStatus: run.changeStatus || null } : null,
      error: run.error || null,
      artifactIds: [],
      source: { kind: 'engineering', id: run.id },
      meta: { attempt: run.attempt || 0, maxAttempts: run.maxAttempts || 0, changeId: run.finalChangeId || null },
      cancellable: false,
      retryable: false,
      attempt: run.attempt || 1,
      retryOf: run.retryOf || null,
      events: legacyEvents(run)
    });
  }
  return items;
}

async function replacementApiRunRetry(req, res) {
  try {
    const b = await readBody(req);
    const id = String(b.id || '');
    const replay = retryRequestForRunId(id);
    if (!replay) return json(res, 409, { error: 'This run does not support retry' });
    const allowed = new Set(['/api/chat','/api/images/generate','/api/agents/run','/api/automations/run']);
    if (!allowed.has(replay.path)) return json(res, 409, { error: 'Retry target is not allowed' });

    const parent = unifiedRunItems(500).find(x => x.id === id) || runLedger.get(id);
    const nextAttempt = Math.max(1, Number(parent?.attempt) || 1) + 1;
    const response = await fetchWithTimeout(`http://127.0.0.1:${PORT}${replay.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(replay.body || {})
    }, 900000);
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : {}; } catch { result = { text: raw.slice(0, 8000) }; }
    if (!response.ok) throw new Error(result.error || `Retry HTTP ${response.status}`);

    let newRunId = null;
    if (result?.runId) {
      const updated = runLedger.update(result.runId, { attempt: nextAttempt, retryOf: id }, `Retried from ${id}`);
      newRunId = updated?.id || result.runId;
    } else if (replay.path === '/api/agents/run' && result?.run?.id) {
      const runs = agentRunStore();
      const retry = runs.find(x => x.id === result.run.id);
      if (retry) {
        retry.attempt = nextAttempt;
        retry.retryOf = id;
        retry.updatedAt = retry.updatedAt || nowIso();
        saveStore(RUNS_STORE, runs, 300);
        newRunId = 'legacy-agent:' + retry.id;
      }
    } else if (replay.path === '/api/automations/run' && result?.run?.id) {
      const runs = automationRunStore();
      const retry = runs.find(x => x.id === result.run.id);
      if (retry) {
        retry.attempt = nextAttempt;
        retry.retryOf = id;
        saveStore(AUTOMATION_RUNS_STORE, runs, 500);
        newRunId = 'legacy-automation:' + retry.id;
      }
    }

    recordActivity('run', 'Run retried', id, { runId: id, newRunId, path: replay.path, attempt: nextAttempt });
    json(res, 200, { ok: true, replayedFrom: id, runId: newRunId, attempt: nextAttempt, result });
  } catch (e) {
    storageError(res, e, 500);
  }
}

replaceFunction('legacyUnifiedRuns', replacementLegacyUnifiedRuns);
replaceFunction('apiRunRetry', replacementApiRunRetry);

const oldUi = "['Attempt', String(run.attempt || 1)], ['Run ID', run.id]";
const newUi = "['Attempt', String(run.attempt || 1)], ['Retry of', run.retryOf || '—'], ['Run ID', run.id]";
const first = ui.indexOf(oldUi);
const second = ui.indexOf(oldUi, first + oldUi.length);
if (first < 0 || second >= 0) throw new Error('Execution drawer detail anchor is missing or ambiguous');
ui = ui.slice(0, first) + newUi + ui.slice(first + oldUi.length);

if (!source.includes("retryOf: id")) throw new Error('Native retry lineage was not added');
if (!source.includes("newRunId = 'legacy-agent:' + retry.id")) throw new Error('Agent retry lineage was not added');
if (!source.includes("newRunId = 'legacy-automation:' + retry.id")) throw new Error('Automation retry lineage was not added');
if (!ui.includes("['Retry of', run.retryOf || '—']")) throw new Error('Execution drawer does not display retry lineage');

fs.writeFileSync(serverPath, source, 'utf8');
fs.writeFileSync(uiPath, ui, 'utf8');
console.log('Applied retry lineage integration');
