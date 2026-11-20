import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCases, scoreRetrieval } from '../evals/past-work-retrieval/scorer.mjs';

test('past work retrieval benchmark scorer evaluates recall@k and mrr', () => {
  const cases = loadCases();
  assert.ok(cases.length >= 10);

  // Simulated retrieval engine
  const mockSearch = (query, k) => {
    if (query.includes('SSRF')) return [{ id: 'j-ssrf-001' }];
    if (query.includes('FastAPI')) return [{ id: 'j-fastapi-002' }];
    if (query.includes('Bambu')) return [{ id: 'j-bambu-003' }];
    if (query.includes('Tailscale')) return [{ id: 'j-ssrf-001' }];
    if (query.includes('volumetric')) return [{ id: 'j-bambu-003' }]; // held out
    return [];
  };

  const results = scoreRetrieval({ cases, searchFn: mockSearch, k: 5 });

  assert.equal(results.k, 5);
  assert.equal(results.totalCases, cases.length);
  assert.ok(results.recallAtK > 0, `Expected recall > 0, got ${results.recallAtK}`);
  assert.ok(results.mrr > 0, `Expected MRR > 0, got ${results.mrr}`);
  assert.ok(results.heldOutTotal >= 2);
  assert.ok(results.heldOutRecallAtK > 0);
  assert.equal(results.perCase.length, cases.length);
});
