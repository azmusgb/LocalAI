'use strict';

const crypto = require('node:crypto');

const EXPERIMENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS research_experiments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hypothesis TEXT NOT NULL,
    factor TEXT NOT NULL,
    expect_metric TEXT NOT NULL,
    expect_better_by REAL NOT NULL,
    suite_name TEXT NOT NULL,
    suite_commit TEXT NOT NULL,
    control_metrics TEXT NOT NULL DEFAULT '{}',
    candidate_metrics TEXT NOT NULL DEFAULT '{}',
    derived_outcome TEXT NOT NULL DEFAULT 'planned', -- planned, supported, refuted, inconclusive
    status TEXT NOT NULL DEFAULT 'planned',          -- planned, running, completed, cancelled
    created_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_contracts (
    id TEXT PRIMARY KEY,
    finding_id TEXT,
    experiment_id TEXT,
    suite_name TEXT NOT NULL,
    suite_commit TEXT NOT NULL,
    target_metric TEXT NOT NULL,
    min_acceptable_val REAL NOT NULL,
    hash TEXT NOT NULL,
    superseded_by TEXT,
    created_at TEXT NOT NULL
  ) STRICT;
`;

function createExperimentRunner({ db }) {
  if (!db) throw new Error('Database instance is required');
  db.exec(EXPERIMENTS_SCHEMA);

  const insertExp = db.prepare(`
    INSERT INTO research_experiments (
      id, name, hypothesis, factor, expect_metric, expect_better_by,
      suite_name, suite_commit, control_metrics, candidate_metrics,
      derived_outcome, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateExpResult = db.prepare(`
    UPDATE research_experiments
    SET control_metrics = ?, candidate_metrics = ?, derived_outcome = ?, status = 'completed', completed_at = ?
    WHERE id = ?
  `);

  const getExp = db.prepare('SELECT * FROM research_experiments WHERE id = ?');
  const listExps = db.prepare('SELECT * FROM research_experiments ORDER BY created_at DESC LIMIT ?');

  const insertContract = db.prepare(`
    INSERT INTO research_contracts (
      id, finding_id, experiment_id, suite_name, suite_commit, target_metric, min_acceptable_val, hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getContract = db.prepare('SELECT * FROM research_contracts WHERE id = ?');
  const supersedeContract = db.prepare('UPDATE research_contracts SET superseded_by = ? WHERE id = ?');

  function deriveVerdict(expectMetric, expectBetterBy, controlMetrics, candidateMetrics) {
    const cVal = controlMetrics[expectMetric];
    const candVal = candidateMetrics[expectMetric];
    if (typeof cVal !== 'number' || typeof candVal !== 'number') return 'inconclusive';

    const diff = candVal - cVal;
    if (diff >= expectBetterBy) return 'supported';
    if (diff <= 0) return 'refuted';
    return 'inconclusive';
  }

  function planExperiment({ name, hypothesis, factor, expectMetric, expectBetterBy, suiteName, suiteCommit }) {
    const id = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    insertExp.run(
      id,
      String(name || id),
      String(hypothesis || ''),
      String(factor || ''),
      String(expectMetric || ''),
      Number(expectBetterBy) || 0,
      String(suiteName || ''),
      String(suiteCommit || ''),
      '{}',
      '{}',
      'planned',
      'planned',
      now
    );
    return getExperiment(id);
  }

  function recordExperimentRun(id, { controlMetrics = {}, candidateMetrics = {} }) {
    const exp = getExperiment(id);
    if (!exp) throw new Error(`Unknown experiment: ${id}`);

    const outcome = deriveVerdict(exp.expect_metric, exp.expect_better_by, controlMetrics, candidateMetrics);
    const now = new Date().toISOString();

    updateExpResult.run(
      JSON.stringify(controlMetrics),
      JSON.stringify(candidateMetrics),
      outcome,
      now,
      id
    );

    return getExperiment(id);
  }

  function getExperiment(id) {
    const row = getExp.get(String(id || ''));
    if (!row) return null;
    return {
      ...row,
      control_metrics: JSON.parse(row.control_metrics || '{}'),
      candidate_metrics: JSON.parse(row.candidate_metrics || '{}')
    };
  }

  function listExperiments({ limit = 50 } = {}) {
    return listExps.all(limit).map(r => ({
      ...r,
      control_metrics: JSON.parse(r.control_metrics || '{}'),
      candidate_metrics: JSON.parse(r.candidate_metrics || '{}')
    }));
  }

  function createContract({ findingId = null, experimentId = null, suiteName, suiteCommit, targetMetric, minAcceptableVal }) {
    const id = `ctr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    
    // Hash is derived from immutable specification
    const payload = `${suiteName}:${suiteCommit}:${targetMetric}:${minAcceptableVal}:${findingId || ''}:${experimentId || ''}`;
    const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);

    insertContract.run(
      id,
      findingId ? String(findingId) : null,
      experimentId ? String(experimentId) : null,
      String(suiteName),
      String(suiteCommit),
      String(targetMetric),
      Number(minAcceptableVal),
      hash,
      now
    );

    return getContractRecord(id);
  }

  function getContractRecord(id) {
    return getContract.get(String(id || '')) || null;
  }

  function supersedeContractRecord(oldId, newId) {
    supersedeContract.run(String(newId), String(oldId));
    return getContractRecord(oldId);
  }

  return {
    deriveVerdict,
    planExperiment,
    recordExperimentRun,
    getExperiment,
    listExperiments,
    createContract,
    getContractRecord,
    supersedeContractRecord
  };
}

module.exports = {
  createExperimentRunner
};
