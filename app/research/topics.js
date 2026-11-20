'use strict';

// Research topics, event journal, and contradiction propagation.
// Single append-only transition/events log covers lifecycle decisions and reasons.

const TOPICS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS research_topics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    target_project TEXT NOT NULL DEFAULT 'LocalAI',
    depth TEXT NOT NULL DEFAULT 'D1', -- D1 (scan), D2 (read), D3 (test/corroborate)
    breadth TEXT NOT NULL DEFAULT 'B1', -- B1 (core), B2 (adjacent)
    budget_daily_model_calls INTEGER NOT NULL DEFAULT 5,
    budget_daily_characters INTEGER NOT NULL DEFAULT 20000,
    status TEXT NOT NULL DEFAULT 'active', -- active, paused, retired
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_events (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL, -- topic, finding, experiment, contract
    entity_id TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    by TEXT NOT NULL DEFAULT 'system',
    reason TEXT NOT NULL,
    at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_conflicts (
    id TEXT PRIMARY KEY,
    finding_a_id TEXT NOT NULL,
    finding_b_id TEXT NOT NULL,
    conflict_type TEXT NOT NULL, -- temporal, contextual, methodological, factual
    reason TEXT NOT NULL,
    at TEXT NOT NULL
  ) STRICT;
`;

function createTopicManager({ db, now = () => Date.now(), nowIso = () => new Date(now()).toISOString() }) {
  if (!db) throw new Error('Database instance is required');
  db.exec(TOPICS_SCHEMA);

  const insertTopic = db.prepare(`
    INSERT INTO research_topics (
      id, name, parent_id, target_project, depth, breadth, budget_daily_model_calls, budget_daily_characters, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateTopicSetting = db.prepare(`
    UPDATE research_topics
    SET depth = ?, breadth = ?, budget_daily_model_calls = ?, budget_daily_characters = ?, status = ?, updated_at = ?
    WHERE id = ?
  `);

  const getTopicStmt = db.prepare('SELECT * FROM research_topics WHERE id = ?');
  const listTopicsStmt = db.prepare('SELECT * FROM research_topics ORDER BY created_at ASC');

  const insertEvent = db.prepare(`
    INSERT INTO research_events (
      id, entity_type, entity_id, from_state, to_state, by, reason, at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const listEventsForEntityStmt = db.prepare('SELECT * FROM research_events WHERE entity_id = ? ORDER BY seq ASC');

  const insertConflictStmt = db.prepare(`
    INSERT INTO research_conflicts (
      id, finding_a_id, finding_b_id, conflict_type, reason, at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const listConflictsStmt = db.prepare(`
    SELECT * FROM research_conflicts
    WHERE finding_a_id = ? OR finding_b_id = ?
    ORDER BY at DESC
  `);

  function recordEvent({ entityType, entityId, fromState, toState, by = 'system', reason }) {
    if (!reason || !String(reason).trim()) throw new Error('Stored reason naming driving factors is required');
    const id = `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const at = nowIso();
    insertEvent.run(id, String(entityType), String(entityId), String(fromState), String(toState), String(by), String(reason), at);
    return { id, entityType, entityId, fromState, toState, by, reason, at };
  }

  function addTopic({ name, parentId = null, targetProject = 'LocalAI', depth = 'D1', breadth = 'B1', budgetCalls = 5, budgetChars = 20000, reason = 'Initial branch creation' }) {
    const id = `top-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const at = nowIso();
    const d = ['D1', 'D2', 'D3'].includes(depth) ? depth : 'D1';
    const b = ['B1', 'B2'].includes(breadth) ? breadth : 'B1';

    insertTopic.run(
      id,
      String(name),
      parentId ? String(parentId) : null,
      String(targetProject),
      d,
      b,
      Number(budgetCalls) || 5,
      Number(budgetChars) || 20000,
      'active',
      at,
      at
    );

    recordEvent({
      entityType: 'topic',
      entityId: id,
      fromState: 'none',
      toState: `${d}/${b}`,
      by: 'owner',
      reason
    });

    return getTopic(id);
  }

  function updateTopic(id, { depth, breadth, budgetCalls, budgetChars, status, reason }) {
    const cur = getTopic(id);
    if (!cur) throw new Error(`Unknown topic ${id}`);
    if (!reason || !String(reason).trim()) throw new Error('A reason naming driving factors is required for depth/breadth modifications');

    const nextD = depth && ['D1', 'D2', 'D3'].includes(depth) ? depth : cur.depth;
    const nextB = breadth && ['B1', 'B2'].includes(breadth) ? breadth : cur.breadth;
    const nextCalls = budgetCalls !== undefined ? Number(budgetCalls) : cur.budget_daily_model_calls;
    const nextChars = budgetChars !== undefined ? Number(budgetChars) : cur.budget_daily_characters;
    const nextStatus = status && ['active', 'paused', 'retired'].includes(status) ? status : cur.status;
    const at = nowIso();

    updateTopicSetting.run(nextD, nextB, nextCalls, nextChars, nextStatus, at, cur.id);

    recordEvent({
      entityType: 'topic',
      entityId: cur.id,
      fromState: `${cur.depth}/${cur.breadth}:${cur.status}`,
      toState: `${nextD}/${nextB}:${nextStatus}`,
      by: 'planner',
      reason
    });

    return getTopic(cur.id);
  }

  function getTopic(id) {
    return getTopicStmt.get(String(id || '')) || null;
  }

  function listTopics() {
    return listTopicsStmt.all();
  }

  function getEvents(entityId) {
    return listEventsForEntityStmt.all(String(entityId || ''));
  }

  function recordConflict({ findingAId, findingBId, conflictType, reason }) {
    const valid = ['temporal', 'contextual', 'methodological', 'factual'];
    if (!valid.includes(conflictType)) throw new Error(`Invalid conflictType. Must be one of: ${valid.join(', ')}`);
    if (!reason || !String(reason).trim()) throw new Error('Reason required for conflict record');

    const id = `cnf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const at = nowIso();
    insertConflictStmt.run(id, String(findingAId), String(findingBId), conflictType, String(reason), at);

    recordEvent({
      entityType: 'finding',
      entityId: findingAId,
      fromState: 'unconflicted',
      toState: `conflicted:${conflictType}`,
      reason: `Conflict recorded with finding ${findingBId}: ${reason}`
    });

    recordEvent({
      entityType: 'finding',
      entityId: findingBId,
      fromState: 'unconflicted',
      toState: `conflicted:${conflictType}`,
      reason: `Conflict recorded with finding ${findingAId}: ${reason}`
    });

    return { id, findingAId, findingBId, conflictType, reason, at };
  }

  function getConflictsForFinding(findingId) {
    return listConflictsStmt.all(String(findingId || ''), String(findingId || ''));
  }

  return {
    addTopic,
    updateTopic,
    getTopic,
    listTopics,
    recordEvent,
    getEvents,
    recordConflict,
    getConflictsForFinding
  };
}

module.exports = {
  createTopicManager
};
