'use strict';

// The recorded inputs of two measures in design section 11.8: defect detection and regression escapes. They are data
// the system cannot know by itself, so they are written here, by the owner (through an authenticated route) or by
// deterministic code, and by nothing a model says: no function here is handed to a model or to the reader, and every
// row names who wrote it (`by` is 'owner' or 'code'). Rows are append-only `research_events`, like the budget ledger,
// so there is no schema change. Nothing here edits a permission, budget, safety rule or trusted instruction file.
//
//   entity_type 'ship_record'   entity_id = change id    to_state 'shipped' | 'reverted' | 'fixed_after_ship'
//       reason JSON { gateShouldHaveCaught: boolean (reverted/fixed only), note }
//   entity_type 'defect_record' entity_id = defect id    to_state 'flagged' | 'missed'
//       reason JSON { source: 'seeded' | 'confirmed', check, note }   (flagged: a Tier 0 or Tier 1 check flagged it)
//
// measures.js reads them back; a row it cannot parse makes the measures `unreadable`, never zero.

const crypto = require('node:crypto');
const { redact } = require('../journal');

const SHIP_STATES = ['shipped', 'reverted', 'fixed_after_ship'];
const DEFECT_SOURCES = ['seeded', 'confirmed'];
const WRITERS = ['owner', 'code'];
const ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

function createOutcomes({ db, now = Date.now } = {}) {
  if (!db) throw new Error('db is required');
  const insert = db.prepare('INSERT INTO research_events (id, entity_type, entity_id, from_state, to_state, by, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const shipRows = db.prepare("SELECT to_state FROM research_events WHERE entity_type = 'ship_record' AND entity_id = ? ORDER BY seq ASC");

  const writer = by => { if (!WRITERS.includes(by)) throw fail(400, 'by must be owner or code'); return by; };
  const idOf = (v, what) => { const s = String(v ?? '').trim(); if (!ID_RE.test(s)) throw fail(400, `${what} must be 1 to 80 letters, digits, . _ : -`); return s; };
  const write = (type, entityId, from, to, by, reason) => {
    const id = `rev-${crypto.randomBytes(8).toString('hex')}`, at = new Date(now()).toISOString();
    insert.run(id, type, entityId, from, to, by, JSON.stringify(reason), at);
    return { id, recordedAt: at };
  };

  // A change that went live (`shipped`, once), or was later `reverted` or `fixed_after_ship`. For the last two the
  // caller says whether a gate (a test, a check, a review step) should have caught the defect; only then is it an escape.
  function recordShipOutcome({ changeId, outcome, gateShouldHaveCaught, note = '', by = 'owner' } = {}) {
    writer(by);
    const cid = idOf(changeId, 'changeId');
    if (!SHIP_STATES.includes(outcome)) throw fail(400, `outcome must be one of: ${SHIP_STATES.join(', ')}`);
    const history = shipRows.all(cid).map(r => r.to_state);
    const shipped = history.includes('shipped');
    let reason;
    if (outcome === 'shipped') {
      if (gateShouldHaveCaught !== undefined) throw fail(400, 'gateShouldHaveCaught applies to reverted and fixed_after_ship only');
      if (shipped) throw fail(409, 'that change is already recorded as shipped');
      reason = { note: redact(note, 300) };
    } else {
      if (typeof gateShouldHaveCaught !== 'boolean') throw fail(400, 'gateShouldHaveCaught must be true or false');
      if (!shipped) throw fail(409, 'record the change as shipped first');
      reason = { gateShouldHaveCaught, note: redact(note, 300) };
    }
    return { changeId: cid, outcome, ...write('ship_record', cid, history[history.length - 1] || '', outcome, by, reason) };
  }

  // A defect that was seeded on purpose or later confirmed real, and whether a Tier 0 or Tier 1 check flagged it. A newer
  // record for the same defect id replaces the older one in the measure (a correction); both stay stored.
  function recordDefect({ defectId, source, flaggedByCheck, check = '', note = '', by = 'owner' } = {}) {
    writer(by);
    const did = defectId === undefined || defectId === '' ? `def-${crypto.randomBytes(6).toString('hex')}` : idOf(defectId, 'defectId');
    if (!DEFECT_SOURCES.includes(source)) throw fail(400, `source must be one of: ${DEFECT_SOURCES.join(', ')}`);
    if (typeof flaggedByCheck !== 'boolean') throw fail(400, 'flaggedByCheck must be true or false');
    const reason = { source, check: redact(check, 80), note: redact(note, 300) };
    return { defectId: did, flaggedByCheck, ...write('defect_record', did, '', flaggedByCheck ? 'flagged' : 'missed', by, reason) };
  }

  return { recordShipOutcome, recordDefect };
}

module.exports = { createOutcomes, SHIP_STATES, DEFECT_SOURCES };
