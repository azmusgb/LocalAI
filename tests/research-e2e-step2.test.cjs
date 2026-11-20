const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createResearchStore } = require('../app/research/store');
const { createResearchRoutes } = require('../app/server/research');
const { validateFindingOutput } = require('../app/research/reader');

test('knowledge loop e2e integration flow (Task 5)', async () => {
  // 1. Initialize In-Memory Store
  const db = new DatabaseSync(':memory:');
  const store = createResearchStore({ db });
  const intake = { state: () => ({ enabled: true, paused: false }) };

  const fakeJson = (res, status, data) => {
    res.statusCode = status;
    res.body = data;
    return res;
  };

  const routes = createResearchRoutes({
    intake,
    store,
    json: fakeJson,
    readBody: async (req) => req.body || {},
    storageError: (res, e) => { res.statusCode = 500; res.body = { error: e.message }; },
    changes: {
      addChange: (c) => ({ id: 'chg-e2e-1', ...c })
    }
  });

  // 2. Intake: Register source and ingest document
  const src = store.addSource({ name: 'FastAPI Release Feed', url: 'https://fastapi.tiangolo.com/feed.xml' });
  store.saveEntries(src.id, [{
    id: 'fastapi-0.165',
    title: 'FastAPI 0.165.0',
    text: 'Support for Python 3.13 and enhanced dependency injection caching.',
    url: 'https://fastapi.tiangolo.com/0.165'
  }]);

  const doc = store.listDocuments({ sourceId: src.id })[0];
  assert.ok(doc, 'Document ingested');

  // 3. Reader: Process document with verbatim validation
  const simulatedModelOutput = {
    relevant: true,
    claim: 'FastAPI 0.165.0 adds dependency injection caching',
    verbatim_quote: 'enhanced dependency injection caching',
    target_project: 'pi-hub',
    relevance: 'Direct Dependency'
  };

  const validatedFinding = validateFindingOutput(doc, simulatedModelOutput);
  assert.ok(validatedFinding, 'Verbatim quote validation succeeded');

  // Store extracted finding
  const storedFinding = store.addFinding({
    documentId: doc.id,
    sourceId: src.id,
    claim: validatedFinding.claim,
    quote: validatedFinding.quote,
    targetProject: validatedFinding.targetProject,
    relevance: validatedFinding.relevance
  });
  assert.equal(storedFinding.status, 'extracted');

  // 4. API Triage: Listing obeys cap and status
  const listRes = {};
  await routes.apiResearchFindings({}, listRes, new URL('http://localhost/api/research/findings?limit=10'));
  assert.equal(listRes.body.findings.length, 1);
  assert.equal(listRes.body.findings[0].id, storedFinding.id);

  // 5. Promotion: Elevate finding to Improve backlog item
  const promoteRes = {};
  await routes.apiResearchFindingPromote({ body: { id: storedFinding.id } }, promoteRes);
  assert.equal(promoteRes.statusCode, 200);
  assert.equal(promoteRes.body.finding.status, 'promoted');
  assert.equal(promoteRes.body.changeId, 'chg-e2e-1');

  // 6. Close the Loop: Record post-release outcome
  const outcomeRes = {};
  await routes.apiImproveOutcome({
    body: {
      findingId: storedFinding.id,
      changeId: promoteRes.body.changeId,
      metricName: 'api_startup_seconds',
      beforeVal: 1.42,
      afterVal: 1.08,
      verdict: 'validated',
      notes: 'pi-hub startup reduced by 340ms.'
    }
  }, outcomeRes);

  assert.equal(outcomeRes.statusCode, 200);
  assert.equal(outcomeRes.body.outcome.verdict, 'validated');

  // Confirm final state in store
  const outcomes = store.listOutcomes(storedFinding.id);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].afterVal, 1.08);
});
