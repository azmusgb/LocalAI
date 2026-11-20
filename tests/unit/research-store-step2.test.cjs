const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createResearchStore } = require('../../app/research/store');

test('research store findings and outcomes lifecycle', () => {
  const db = new DatabaseSync(':memory:');
  const store = createResearchStore({ db });

  // Add source and document
  const src = store.addSource({ name: 'Node.js Releases', url: 'https://nodejs.org/feed.xml' });
  store.saveEntries(src.id, [{
    id: 'entry-1',
    title: 'Node 27 Released',
    text: 'Node.js 27 brings new sqlite features and enhanced streams support.',
    url: 'https://nodejs.org/27'
  }]);

  const docs = store.listDocuments({ sourceId: src.id });
  assert.equal(docs.length, 1);
  const doc = docs[0];

  // Add finding
  const finding = store.addFinding({
    documentId: doc.id,
    sourceId: src.id,
    claim: 'Node 27 brings enhanced SQLite capabilities',
    quote: 'Node.js 27 brings new sqlite features',
    targetProject: 'LocalAI',
    relevance: 'Direct Dependency'
  });

  assert.ok(finding.id.startsWith('fnd-'));
  assert.equal(finding.status, 'extracted');
  assert.equal(finding.claim, 'Node 27 brings enhanced SQLite capabilities');

  // List findings
  const list = store.listFindings({ status: 'extracted' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, finding.id);

  // Decide finding (keep)
  const kept = store.decideFinding(finding.id, 'kept');
  assert.equal(kept.status, 'kept');
  assert.ok(kept.decidedAt);

  // Record outcome
  const out = store.recordOutcome({
    findingId: finding.id,
    changeId: 'chg-123',
    metricName: 'sqlite_query_ms',
    beforeVal: 45.2,
    afterVal: 32.1,
    verdict: 'validated',
    notes: 'Upgrade to Node 27 reduced latency by 13ms'
  });

  assert.ok(out.id.startsWith('out-'));
  assert.equal(out.verdict, 'validated');

  const outcomes = store.listOutcomes(finding.id);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].metricName, 'sqlite_query_ms');
  assert.equal(outcomes[0].beforeVal, 45.2);
  assert.equal(outcomes[0].afterVal, 32.1);
});
