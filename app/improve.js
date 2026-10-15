'use strict';

// Improve (roadmap sub-project 4): the rules for the one pipeline that changes Local AI. Backlog items are Claude
// board findings; Signals are the issues store; change requests keep their own store. Pure: no I/O, the clock is
// passed in as `at`. Spec: docs/superpowers/specs/2026-10-15-improve-design.md.

const crypto = require('node:crypto');

// A change in one of these states is still being worked on, so its item is In progress.
const LIVE_CHANGE = ['planned', 'patch_failed', 'validation_failed', 'staged', 'awaiting_approval', 'approved', 'apply_requested'];
const HAND_TO_CLAUDE_BOOST = 30;
const HANDED_NOTE = 'Handed to Claude';

const clip = (value, max) => String(value ?? '').slice(0, max);

// The planner sometimes leaves a change's summary at its default; the request's first line says what it was.
const GENERIC_TITLES = new Set(['', 'Proposed change', 'Change request']);
function changeTitle(change) {
  const summary = String(change.summary || '').trim();
  if (!GENERIC_TITLES.has(summary)) return clip(summary, 120);
  const line = String(change.request || '').split('\n').map(l => l.trim()).find(Boolean);
  return clip(line || 'Change request', 120);
}

function stageOf(item, changesById = new Map()) {
  if (item.status === 'fixed') return 'shipped';
  if (item.status === 'deferred' || item.status === 'rejected') return 'setAside';
  if (item.status === 'in_progress') return 'inProgress';
  const change = item.changeId ? changesById.get(item.changeId) : null;
  if (change && LIVE_CHANGE.includes(change.status)) return 'inProgress';
  return 'backlog';
}

// Service-health checks fail while a companion is down and pass when it's back; Health already reports and notifies
// that, so promoting them only churned the Backlog (promoted, resolved on its own, reopened).
const isServiceHealth = s => s?.kind === 'quality-check' && /^service health/i.test(String(s.name || ''));
function shouldPromote(signal) {
  if (isServiceHealth(signal)) return false;
  return signal?.status === 'open' && (signal.severity === 'high' || Number(signal.occurrences) >= 3);
}

function signalItemId(signalId) { return 'signal-' + signalId; }

function promoteSignal(signal, at) {
  return {
    id: signalItemId(signal.id), source: 'signal', signalId: signal.id, status: 'proposed',
    severity: ['high', 'medium', 'low'].includes(signal.severity) ? signal.severity : 'medium',
    category: 'bug', title: clip(signal.name || 'Signal', 240), summary: clip(signal.detail, 2000),
    createdAt: at, updatedAt: at
  };
}

function ideaItem(text, at) {
  const body = String(text ?? '').trim();
  if (!body) return null;
  return {
    id: `idea-${Date.parse(at) || Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    source: 'idea', status: 'approved', severity: 'medium', category: 'idea',
    title: clip(body.split('\n')[0].trim(), 120), summary: clip(body, 2000), createdAt: at, updatedAt: at
  };
}

function moveToTopBoost(item, openItems, scoreOf) {
  const others = openItems.filter(o => o.id !== item.id);
  const top = others.length ? Math.max(...others.map(scoreOf)) : scoreOf(item);
  const base = scoreOf({ ...item, priorityBoost: 0 });
  // Already on top: keep its boost rather than lowering it to "top + 1".
  return Math.max(Number(item.priorityBoost) || 0, top + 1 - base);
}

function handToClaude(item, at) {
  return {
    status: 'approved', handedToClaude: true, handedAt: at,
    priorityBoost: (Number(item.priorityBoost) || 0) + HAND_TO_CLAUDE_BOOST,
    decisionNote: item.decisionNote ? `${item.decisionNote} · ${HANDED_NOTE}` : HANDED_NOTE
  };
}

// Everything automatic in one idempotent pass; returns the items to write (whole new items, or patches merged by id).
function reconcile({ items = [], changes = [], signals = [], release = null, startup = false, at }) {
  const upserts = [];
  const byId = new Map(items.map(i => [i.id, i]));
  const changesById = new Map(changes.map(c => [c.id, c]));
  const linked = new Set(items.map(i => i.changeId).filter(Boolean));

  for (const signal of signals) {
    const existing = byId.get(signalItemId(signal.id));
    if (!existing) {
      if (shouldPromote(signal)) upserts.push(promoteSignal(signal, at));
    } else if (signal.status === 'open' && existing.status === 'fixed' && existing.decisionNote === 'Resolved on its own') {
      upserts.push({ id: existing.id, status: 'proposed', decisionNote: 'Came back after resolving on its own', updatedAt: at });
    } else if (signal.status === 'resolved' && stageOf(existing, changesById) === 'backlog') {
      upserts.push({ id: existing.id, status: 'fixed', decisionNote: 'Resolved on its own', updatedAt: at });
    }
  }

  for (const item of items) {
    const change = item.changeId ? changesById.get(item.changeId) : null;
    // The first release linked old change requests as in_progress, which told Claude sessions someone was on them.
    // Linked items are approved; the live change is what puts them In progress. Fix those once.
    if (item.id.startsWith('idea-change-') && item.status === 'in_progress' && !item.handedToClaude) {
      upserts.push({ id: item.id, status: 'approved', updatedAt: at });
    }
    // Items linked before titles came from the request keep the generic one; rename them once.
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (change && title && GENERIC_TITLES.has(title) && changeTitle(change) !== title) {
      upserts.push({ id: item.id, title: changeTitle(change), updatedAt: at });
    }
    if (change?.status === 'applied' && item.status !== 'fixed') {
      upserts.push({ id: item.id, status: 'fixed', shipped: { pending: true, at }, updatedAt: at });
    } else if (startup && item.shipped?.pending && release) {
      upserts.push({ id: item.id, shipped: { version: release.version || '', commit: release.commit || '', at: item.shipped.at || at, pending: false }, updatedAt: at });
    }
  }

  // Only at start-up: changes that were already open before Improve existed get an item, once. Changes planned
  // later come from Improve (already linked) or from the engineering agent's own attempts (never linked).
  for (const change of startup ? changes : []) {
    if (!LIVE_CHANGE.includes(change.status) || linked.has(change.id) || change.sourceEngineeringRunId) continue;
    upserts.push({
      id: `idea-change-${change.id}`, source: 'idea', status: 'approved', changeId: change.id,
      severity: 'medium', category: 'idea', title: changeTitle(change),
      summary: clip(change.request || change.summary, 2000), createdAt: at, updatedAt: at
    });
  }

  return { upserts };
}

module.exports = { LIVE_CHANGE, changeTitle, stageOf, shouldPromote, signalItemId, promoteSignal, ideaItem, moveToTopBoost, handToClaude, reconcile };
