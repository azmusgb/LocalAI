'use strict';

// The measures of design section 11.8, computed here from rows already stored: never reported by a model and never
// written anywhere. Each is a numerator and a denominator; a denominator of zero is "no data" (value null), not 0%, and
// defect detection and regression escapes read records the owner or deterministic code wrote (outcomes.js), never a model. A failed read of any input makes
// the whole result `unreadable`: no measure is shown as zero because its source could not be read.

const ratio = (num, den) => (den > 0 ? num / den : null);
function measure(num, den, { unit, note = '' } = {}) {
  return { noData: !(den > 0), value: ratio(num, den), num, den, unit, note };
}

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

      // Owner- or code-recorded inputs (outcomes.js). A row that does not parse makes the whole result unreadable.
      const defects = new Map(); // newest record per defect id wins
      for (const r of db.prepare("SELECT entity_id, to_state, by, reason FROM research_events WHERE entity_type = 'defect_record' ORDER BY seq ASC").all()) {
        let e; try { e = JSON.parse(r.reason); } catch { throw new Error('unreadable defect row'); }
        if (!e || (r.to_state !== 'flagged' && r.to_state !== 'missed') || (r.by !== 'owner' && r.by !== 'code')) throw new Error('unreadable defect row');
        defects.set(r.entity_id, r.to_state === 'flagged');
      }
      const shipped = new Set(), escaped = new Set();
      for (const r of db.prepare("SELECT entity_id, to_state, by, reason FROM research_events WHERE entity_type = 'ship_record' ORDER BY seq ASC").all()) {
        let e; try { e = JSON.parse(r.reason); } catch { throw new Error('unreadable ship row'); }
        if (!e || (r.by !== 'owner' && r.by !== 'code')) throw new Error('unreadable ship row');
        if (r.to_state === 'shipped') shipped.add(r.entity_id);
        else if (r.to_state === 'reverted' || r.to_state === 'fixed_after_ship') {
          if (typeof e.gateShouldHaveCaught !== 'boolean') throw new Error('unreadable ship row');
          if (e.gateShouldHaveCaught) escaped.add(r.entity_id);
        } else throw new Error('unreadable ship row');
      }
      for (const id of escaped) if (!shipped.has(id)) throw new Error('unreadable ship row');
      const flagged = [...defects.values()].filter(Boolean).length;

      return {
        unreadable: false,
        measures: {
          costPerValidatedImprovement: {
            ...measure(allCalls, validated, { unit: 'model calls per validated finding' }),
            chars: ratio(allChars, validated), numChars: allChars,
            note: 'all model spend, both tiers, divided by findings whose newest outcome is validated',
          },
          modelCallsAvoided: measure(Math.max(0, documents - allCalls), documents, { unit: 'documents that needed no model call', note: 'stored documents minus model calls made' }),
          defectDetection: measure(flagged, defects.size, { unit: 'recorded defects flagged by a Tier 0 or Tier 1 check', note: 'seeded or confirmed defects the owner or code recorded; newest record per defect' }),
          recommendationPrecision: measure(validated, judged, { unit: 'validated of findings with a verdict', note: 'findings whose newest outcome is validated or refuted' }),
          regressionEscapes: measure(escaped.size, shipped.size, { unit: 'shipped changes later reverted or fixed for a defect a gate should have caught', note: 'of changes recorded as shipped; a revert or fix the owner says no gate should have caught is not counted' }),
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
