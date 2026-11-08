'use strict';

// Agent World's Main Street: every kind of run (the ledger plus the engineering, automation and spreadsheet stores, as
// Work and Home see them) boiled down to one small summary per building (chat, images, missions,
// garage, sheets, clock). A pure function: GET /api/world (app/world.js) passes in the recent runs and reads nothing
// itself, so the answer depends only on its input and the `now` it is given.
//   running       up to 3 runs in progress (running or streaming), newest first; the rest count into `waiting`;
//   waiting       queued runs plus running past the cap of 3;
//   needsYou      up to 3 approvals the person must decide, from the same pick() Home's "Needs you" uses;
//   failedUnseen  up to 3 failures pick() still lists (not opened, under a day old, not answered by a retry);
//   recent        the last 3 finished runs (completed, failed or cancelled), newest first.
// An item is only {id, title, status, startedAt}: the id as a string (a run with no id is left out), the readable title
// cut to 80 characters, startedAt the run's createdAt or null. A missions item also carries missionId when the run names
// its mission (meta.missionId, output.missionId, source.id or meta.sourceId, as ui.js's Open in Work matches them): the
// run id is the ledger's, and Missions HQ's rows open the mission.
// crewList() does the same for Claude crew sessions (claudeLive()'s lastEvent becomes lastAction): at most 6, text cut to 80 characters.
const { readableTitle } = require('./run-cards');
const { pick } = require('./public/needs-you');

const STREET_KEYS = ['chat', 'images', 'missions', 'garage', 'sheets', 'clock'];
const KEYS = { chat: 'chat', research: 'chat', image: 'images', agent: 'missions', mission: 'missions', specialist: 'missions', engineering: 'garage', spreadsheet: 'sheets', automation: 'clock' };
const MAX_RUNNING = 3;
const MAX_RECENT = 3;
const MAX_ASKS = 3;
const MAX_CREW = 6;
const TEXT_MAX = 80;
const FINISHED = new Set(['completed', 'failed', 'cancelled']);

const ms = (v) => Date.parse(v) || 0;
const cut = (v) => (typeof v === 'string' ? v : '').slice(0, TEXT_MAX);

function streetKey(run) {
  const type = run && run.type;
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(KEYS, type) ? KEYS[type] : null;
}

const missionOf = (r) => [r.meta && r.meta.missionId, r.output && r.output.missionId, r.source && r.source.id, r.meta && r.meta.sourceId].find((v) => typeof v === 'string' && v);
const item = (r) => {
  const i = { id: String(r.id), title: readableTitle(r).slice(0, TEXT_MAX), status: r.status, startedAt: typeof r.createdAt === 'string' ? r.createdAt : null };
  const m = streetKey(r) === 'missions' && missionOf(r);
  if (m) i.missionId = m.slice(0, TEXT_MAX);
  return i;
};
const hasId = (r) => r.id !== undefined && r.id !== null && r.id !== '';

function buildStreet(runs, { now = Date.now() } = {}) {
  const street = Object.fromEntries(STREET_KEYS.map((k) => [k, { running: [], waiting: 0, needsYou: [], failedUnseen: [], recent: [] }]));
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r && hasId(r) && streetKey(r));
  const active = {};
  const finished = {};
  for (const r of list) {
    const k = streetKey(r);
    if (r.status === 'running' || r.status === 'streaming') (active[k] = active[k] || []).push(r);
    else if (r.status === 'queued') street[k].waiting++;
    else if (FINISHED.has(r.status)) (finished[k] = finished[k] || []).push(r);
  }
  for (const k of STREET_KEYS) {
    const live = (active[k] || []).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    street[k].running = live.slice(0, MAX_RUNNING).map(item);
    street[k].waiting += Math.max(0, live.length - MAX_RUNNING);
    const done = (finished[k] || []).sort((a, b) => ms(b.finishedAt || b.updatedAt) - ms(a.finishedAt || a.updatedAt));
    street[k].recent = done.slice(0, MAX_RECENT).map(item);
  }
  for (const r of pick(list, { now })) {
    const b = street[streetKey(r)];
    if (r.status === 'awaiting_approval' && b.needsYou.length < MAX_ASKS) b.needsYou.push(item(r));
    else if (r.status === 'failed' && b.failedUnseen.length < MAX_ASKS) b.failedUnseen.push(item(r));
  }
  return street;
}

function crewList(live) {
  return (Array.isArray(live) ? live : []).filter(Boolean).slice(0, MAX_CREW).map((s) => ({
    id: s.id, title: cut(s.title), state: s.state === 'waiting' ? 'waiting' : 'working', lastAction: cut(s.lastEvent),
  }));
}

module.exports = { streetKey, buildStreet, crewList, STREET_KEYS };
