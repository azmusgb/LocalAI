// Standalone deterministic scorer for Past Work Retrieval evaluation
// Computes recall@k, MRR (mean reciprocal rank), and held-out slice aggregates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadCases(casesPath = path.join(__dirname, 'cases.jsonl')) {
  const content = fs.readFileSync(casesPath, 'utf8');
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function scoreRetrieval({ cases, searchFn, k = 5 }) {
  let hits = 0;
  let totalCases = 0;
  let reciprocalRankSum = 0;

  let heldOutHits = 0;
  let heldOutTotal = 0;

  const perCase = [];

  for (const c of cases) {
    totalCases++;
    const results = searchFn(c.query, k) || [];
    const resultIds = results.map(r => (typeof r === 'string' ? r : r.id));

    let matchedRank = -1;
    for (let i = 0; i < resultIds.length; i++) {
      if (c.expectedIds.includes(resultIds[i])) {
        matchedRank = i + 1;
        break;
      }
    }

    const hit = matchedRank > 0 && matchedRank <= k;
    if (hit) hits++;
    if (matchedRank > 0) reciprocalRankSum += 1 / matchedRank;

    if (c.heldOut) {
      heldOutTotal++;
      if (hit) heldOutHits++;
    }

    perCase.push({
      id: c.id,
      query: c.query,
      hit,
      matchedRank: matchedRank > 0 ? matchedRank : null,
      heldOut: Boolean(c.heldOut)
    });
  }

  const recallAtK = totalCases > 0 ? Number((hits / totalCases).toFixed(4)) : 0;
  const mrr = totalCases > 0 ? Number((reciprocalRankSum / totalCases).toFixed(4)) : 0;
  const heldOutRecallAtK = heldOutTotal > 0 ? Number((heldOutHits / heldOutTotal).toFixed(4)) : 0;

  return {
    k,
    totalCases,
    recallAtK,
    mrr,
    heldOutTotal,
    heldOutRecallAtK,
    perCase
  };
}
