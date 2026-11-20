const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createExperimentRunner } = require('../app/research/experiments');

test('experiments lifecycle: plan, run, and derive outcome', () => {
  const db = new DatabaseSync(':memory:');
  const runner = createExperimentRunner({ db });

  // 1. Plan experiment
  const exp = runner.planExperiment({
    name: 'BM25 + recency ranking for Past Work',
    hypothesis: 'Adding recency score improves recall@5 by at least 0.05',
    factor: 'recency_weight',
    expectMetric: 'recallAtK',
    expectBetterBy: 0.05,
    suiteName: 'past-work-retrieval',
    suiteCommit: '4c1d9e2'
  });

  assert.ok(exp.id.startsWith('exp-'));
  assert.equal(exp.status, 'planned');
  assert.equal(exp.derived_outcome, 'planned');

  // 2. Derive supported outcome
  const supported = runner.recordExperimentRun(exp.id, {
    controlMetrics: { recallAtK: 0.71, mrr: 0.65 },
    candidateMetrics: { recallAtK: 0.79, mrr: 0.72 }
  });
  assert.equal(supported.status, 'completed');
  assert.equal(supported.derived_outcome, 'supported');
  assert.equal(supported.candidate_metrics.recallAtK, 0.79);

  // 3. Plan second experiment that ends refuted
  const exp2 = runner.planExperiment({
    name: 'Aggressive stemming on journal FTS5',
    hypothesis: 'Aggressive porter stemming improves recall@5 by 0.10',
    factor: 'stemmer_mode',
    expectMetric: 'recallAtK',
    expectBetterBy: 0.10,
    suiteName: 'past-work-retrieval',
    suiteCommit: '4c1d9e2'
  });

  const refuted = runner.recordExperimentRun(exp2.id, {
    controlMetrics: { recallAtK: 0.75 },
    candidateMetrics: { recallAtK: 0.70 } // Worse -> refuted
  });
  assert.equal(refuted.derived_outcome, 'refuted');

  // 4. Verify listed experiments keep refuted visible
  const list = runner.listExperiments({ limit: 10 });
  assert.equal(list.length, 2);
  assert.ok(list.some(e => e.derived_outcome === 'refuted'));
});

test('contracts lifecycle: immutable creation, hash calculation, and superseding', () => {
  const db = new DatabaseSync(':memory:');
  const runner = createExperimentRunner({ db });

  const c1 = runner.createContract({
    suiteName: 'past-work-retrieval',
    suiteCommit: '4c1d9e2',
    targetMetric: 'recallAtK',
    minAcceptableVal: 0.75
  });

  assert.ok(c1.id.startsWith('ctr-'));
  assert.ok(c1.hash.length >= 8);
  assert.equal(c1.superseded_by, null);

  // Create contract v2 that supersedes v1
  const c2 = runner.createContract({
    suiteName: 'past-work-retrieval',
    suiteCommit: '8f2a1b3',
    targetMetric: 'recallAtK',
    minAcceptableVal: 0.80
  });

  const updatedC1 = runner.supersedeContractRecord(c1.id, c2.id);
  assert.equal(updatedC1.superseded_by, c2.id);

  const fetchC2 = runner.getContractRecord(c2.id);
  assert.equal(fetchC2.superseded_by, null);
});

test('HTTP routes: /api/research/experiments and /api/research/contracts', async () => {
  const { createResearchRoutes } = require('../app/server/research');
  const db = new DatabaseSync(':memory:');
  const runner = createExperimentRunner({ db });

  const fakeJson = (res, status, data) => {
    res.statusCode = status;
    res.body = data;
    return res;
  };

  const routes = createResearchRoutes({
    experiments: runner,
    intake: { state: () => ({ enabled: true, paused: false }) },
    store: {},
    json: fakeJson,
    readBody: async req => req.body || {},
    storageError: (res, e) => { res.statusCode = 500; res.body = { error: e.message }; }
  });

  // 1. POST /api/research/experiments
  const resExpPost = {};
  await routes.apiResearchExperiments({ method: 'POST', body: { name: 'Exp 1', hypothesis: 'H1', factor: 'F1', expectMetric: 'm1', expectBetterBy: 0.1, suiteName: 's1', suiteCommit: 'c1' } }, resExpPost);
  assert.equal(resExpPost.statusCode, 200);
  assert.ok(resExpPost.body.experiment.id.startsWith('exp-'));

  // 2. GET /api/research/experiments
  const resExpGet = {};
  await routes.apiResearchExperiments({ method: 'GET' }, resExpGet, new URL('http://localhost/api/research/experiments'));
  assert.equal(resExpGet.statusCode, 200);
  assert.equal(resExpGet.body.experiments.length, 1);

  // 3. POST /api/research/contracts
  const resCtrPost = {};
  await routes.apiResearchContracts({ method: 'POST', body: { suiteName: 's1', suiteCommit: 'c1', targetMetric: 'm1', minAcceptableVal: 0.5 } }, resCtrPost);
  assert.equal(resCtrPost.statusCode, 200);
  assert.ok(resCtrPost.body.contract.id.startsWith('ctr-'));

  // 4. GET /api/research/contracts
  const resCtrGet = {};
  await routes.apiResearchContracts({ method: 'GET' }, resCtrGet, new URL(`http://localhost/api/research/contracts?id=${resCtrPost.body.contract.id}`));
  assert.equal(resCtrGet.statusCode, 200);
  assert.equal(resCtrGet.body.contract.id, resCtrPost.body.contract.id);
});
