const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createResearchStore } = require('../app/research/store');
const { createResearchRoutes } = require('../app/server/research');

test('research step 2 routes: findings, decide, promote, and outcomes', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createResearchStore({ db });
  const intake = { state: () => ({ enabled: true, paused: false }) };

  const fakeJson = (res, status, data) => {
    res.statusCode = status;
    res.body = data;
    return res;
  };

  const fakeReadBody = async (req) => req.body || {};

  const routes = createResearchRoutes({
    intake,
    store,
    json: fakeJson,
    readBody: fakeReadBody,
    storageError: (res, e) => { res.statusCode = 500; res.body = { error: e.message }; },
    changes: {
      addChange: (c) => ({ id: 'chg-456', ...c })
    }
  });

  // 1. Setup doc and finding
  const src = store.addSource({ name: 'FastAPI Releases', url: 'https://fastapi.tiangolo.com/release.xml' });
  store.saveEntries(src.id, [{
    id: 'entry-fastapi-1',
    title: 'FastAPI 0.165.0 Released',
    text: 'Adds support for Pydantic v2.10 and async Lifespan state optimization.',
    url: 'https://fastapi.tiangolo.com/0.165'
  }]);
  const doc = store.listDocuments({ sourceId: src.id })[0];

  const finding = store.addFinding({
    documentId: doc.id,
    sourceId: src.id,
    claim: 'FastAPI adds async lifespan state optimization',
    quote: 'async Lifespan state optimization',
    targetProject: 'pi-hub',
    relevance: 'Direct Dependency'
  });

  // 2. GET /api/research/findings
  const resList = {};
  await routes.apiResearchFindings({}, resList, new URL('http://localhost/api/research/findings?limit=10'));
  assert.equal(resList.statusCode, 200);
  assert.equal(resList.body.findings.length, 1);
  assert.equal(resList.body.findings[0].id, finding.id);

  // 3. POST /api/research/findings/decide
  const resDecide = {};
  await routes.apiResearchFindingDecide({ body: { id: finding.id, status: 'kept' } }, resDecide);
  assert.equal(resDecide.statusCode, 200);
  assert.equal(resDecide.body.finding.status, 'kept');

  // 4. POST /api/research/findings/promote
  const resPromote = {};
  await routes.apiResearchFindingPromote({ body: { id: finding.id } }, resPromote);
  assert.equal(resPromote.statusCode, 200);
  assert.equal(resPromote.body.changeId, 'chg-456');
  assert.equal(resPromote.body.finding.status, 'promoted');

  // 4. POST /api/improve/outcome
  const resOutcome = {};
  await routes.apiImproveOutcome({
    body: {
      findingId: finding.id,
      changeId: 'chg-456',
      metricName: 'request_latency_ms',
      beforeVal: 12.5,
      afterVal: 9.8,
      verdict: 'validated',
      notes: 'Confirmed 2.7ms reduction in pi-hub gateway response time.'
    }
  }, resOutcome);

  assert.equal(resOutcome.statusCode, 200);
  assert.equal(resOutcome.body.outcome.verdict, 'validated');
});
