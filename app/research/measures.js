'use strict';

// The measures of design section 11.8, computed here from rows already stored: never reported by a model and never
// written anywhere. Each is a numerator and a denominator; a denominator of zero is "no data" (value null), not 0%, and
// a measure whose inputs the system does not record yet says so instead of guessing. A failed read of any input makes
// the whole result `unreadable`: no measure is shown as zero because its source could not be read.

const ratio = (num, den) => (den > 0 ? num / den : null);
function measure(num, den, { unit, note = '' } = {}) {
  return { noData: !(den > 0), value: ratio(num, den), num, den, unit, note };
}
const needs = (note) => ({ noData: true, value: null, num: 0, den: 0, unit: '', note });

function createMeasures({ db } = {}) {
  if (!db) throw new Error('db is required');

  function compute() {
    try {
      // Model spend, all time, by tier, from the budget ledger (budget.js).
      const spend = { 1: { calls: 0, chars: 0 }, 2: { calls: 0, chars: 0 } };
      for (const r of db.prepare("SELECT reason FROM research_events WHERE entity_type = 'budget' ORDER BY seq ASC").all()) {
        let e; try { e = JSON.parse(r.reason); } catch { throw new Error('unreadable budget row'); }
        if (!e || (e.tier !== 1 && e.tier !== 2) || !Number.isInteger(e.calls) || !Number.isInteger(e.chars)) throw new Error('unreadable budget row');
        spend[e.tier].calls += e.calls; spend[e.tier].chars += e.chars;
      }
      const allCalls = spend[1].calls + spend[2].calls, allChars = spend[1].chars + spend[2].chars;
      const documents = db.prepare('SELECT count(*) AS n FROM research_documents').get().n;
      const decided = db.prepare("SELECT count(*) AS n FROM research_findings WHERE status IN ('kept', 'dismissed', 'promoted')").get().n;
      // The newest outcome of each finding is its verdict: a later "refuted" overrides an earlier "validated".
      const latest = db.prepare(`SELECT o.verdict AS verdict FROM research_outcomes o
        WHERE o.rowid = (SELECT o2.rowid FROM research_outcomes o2 WHERE o2.finding_id = o.finding_id ORDER BY o2.created_at DESC, o2.rowid DESC LIMIT 1)`).all();
      const validated = latest.filter(r => r.verdict === 'validated').length;
      const judged = latest.filter(r => r.verdict === 'validated' || r.verdict === 'refuted').length;

      return {
        unreadable: false,
        measures: {
          costPerValidatedImprovement: {
            ...measure(allCalls, validated, { unit: 'model calls per validated finding' }),
            chars: ratio(allChars, validated), numChars: allChars,
            note: 'all model spend, both tiers, divided by findings whose newest outcome is validated',
          },
          modelCallsAvoided: measure(Math.max(0, documents - allCalls), documents, { unit: 'documents that needed no model call', note: 'stored documents minus model calls made' }),
          defectDetection: needs('not measured: the system does not yet record confirmed defects to compare its checks against'),
          recommendationPrecision: measure(validated, judged, { unit: 'validated of findings with a verdict', note: 'findings whose newest outcome is validated or refuted' }),
          regressionEscapes: needs('not measured: the system does not yet record reverts or fixes of shipped changes'),
          investigationEfficiency: {
            ...measure(allCalls, decided, { unit: 'model calls per decided finding' }),
            chars: ratio(allChars, decided), numChars: allChars,
            byTier: { tier1: { ...spend[1] }, tier2: { ...spend[2] } },
            note: 'decided means kept, dismissed or promoted',
          },
        },
      };
    } catch {
      return { unreadable: true, reason: 'the measures could not be read', measures: {} };
    }
  }

  return { compute };
}

module.exports = { createMeasures };
