const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createTopicManager } = require('../app/research/topics');
const { createResearchRoutes } = require('../app/server/research');

test('topics and events lifecycle: depth, breadth, reasons, and conflicts', () => {
  const db = new DatabaseSync(':memory:');
  const mgr = createTopicManager({ db });

  // 1. Add topic (Criterion: Every depth or breadth change has a stored reason naming driving factors)
  const top = mgr.addTopic({
    name: 'Retrieval & Hybrid Search',
    depth: 'D1',
    breadth: 'B1',
    budgetCalls: 10,
    budgetChars: 30000,
    reason: 'Evaluating Past work recall against BM25 baseline'
  });

  assert.ok(top.id.startsWith('top-'));
  assert.equal(top.depth, 'D1');
  assert.equal(top.breadth, 'B1');

  // Verify initial event recorded
  const initialEvents = mgr.getEvents(top.id);
  assert.equal(initialEvents.length, 1);
  assert.equal(initialEvents[0].reason, 'Evaluating Past work recall against BM25 baseline');

  // 2. Expand topic to D3 (test/corroborate) with driving factor reason
  const updated = mgr.updateTopic(top.id, {
    depth: 'D3',
    reason: 'Corroboration required: contradictory findings on reciprocal rank fusion'
  });
  assert.equal(updated.depth, 'D3');

  // Verify update event recorded with explicit factor reason
  const allEvents = mgr.getEvents(top.id);
  assert.equal(allEvents.length, 2);
  assert.equal(allEvents[1].from_state, 'D1/B1:active');
  assert.equal(allEvents[1].to_state, 'D3/B1:active');
  assert.equal(allEvents[1].reason, 'Corroboration required: contradictory findings on reciprocal rank fusion');

  // Attempting update without a reason must fail
  assert.throws(() => {
    mgr.updateTopic(top.id, { depth: 'D2', reason: '' });
  }, /reason naming driving factors is required/);

  // 3. Conflict handling: Both findings kept, typed conflict recorded
  const cnf = mgr.recordConflict({
    findingAId: 'fnd-101',
    findingBId: 'fnd-102',
    conflictType: 'methodological',
    reason: 'Finding 101 tests on in-memory FTS5 while Finding 102 tests on disk with cold cache'
  });

  assert.ok(cnf.id.startsWith('cnf-'));
  assert.equal(cnf.conflictType, 'methodological');

  // Check conflicts queryable by finding id
  const conflictsA = mgr.getConflictsForFinding('fnd-101');
  assert.equal(conflictsA.length, 1);
  assert.equal(conflictsA[0].id, cnf.id);

  const conflictsB = mgr.getConflictsForFinding('fnd-102');
  assert.equal(conflictsB.length, 1);
  assert.equal(conflictsB[0].id, cnf.id);
});

test('HTTP routes: /api/research/topics, /api/research/topics/update, and /api/research/conflicts', async () => {
  const db = new DatabaseSync(':memory:');
  const mgr = createTopicManager({ db });

  const fakeJson = (res, status, data) => {
    res.statusCode = status;
    res.body = data;
    return res;
  };

  const routes = createResearchRoutes({
    topics: mgr,
    intake: { state: () => ({ enabled: true, paused: false }) },
    store: {},
    json: fakeJson,
    readBody: async req => req.body || {},
    storageError: (res, e) => { res.statusCode = 500; res.body = { error: e.message }; }
  });

  // 1. POST /api/research/topics
  const resTopPost = {};
  await routes.apiResearchTopics({ method: 'POST', body: { name: 'FTS5 Optimization', depth: 'D1', reason: 'Initial seed' } }, resTopPost);
  assert.equal(resTopPost.statusCode, 200);
  assert.ok(resTopPost.body.topic.id.startsWith('top-'));

  // 2. GET /api/research/topics
  const resTopGet = {};
  await routes.apiResearchTopics({ method: 'GET' }, resTopGet, new URL('http://localhost/api/research/topics'));
  assert.equal(resTopGet.statusCode, 200);
  assert.equal(resTopGet.body.topics.length, 1);

  // 3. POST /api/research/topics/update
  const resTopUpd = {};
  await routes.apiResearchTopicUpdate({
    body: {
      id: resTopPost.body.topic.id,
      depth: 'D2',
      reason: 'Promoted to read depth after scanning initial release docs'
    }
  }, resTopUpd);
  assert.equal(resTopUpd.statusCode, 200);
  assert.equal(resTopUpd.body.topic.depth, 'D2');

  // 4. POST /api/research/conflicts
  const resCnfPost = {};
  await routes.apiResearchConflicts({
    method: 'POST',
    body: {
      findingAId: 'fnd-201',
      findingBId: 'fnd-202',
      conflictType: 'factual',
      reason: 'Factual disagreement on SQLite 3.45 vector extensions'
    }
  }, resCnfPost);
  assert.equal(resCnfPost.statusCode, 200);
  assert.ok(resCnfPost.body.conflict.id.startsWith('cnf-'));

  // 5. GET /api/research/conflicts
  const resCnfGet = {};
  await routes.apiResearchConflicts({ method: 'GET' }, resCnfGet, new URL('http://localhost/api/research/conflicts?findingId=fnd-201'));
  assert.equal(resCnfGet.statusCode, 200);
  assert.equal(resCnfGet.body.conflicts.length, 1);
});
