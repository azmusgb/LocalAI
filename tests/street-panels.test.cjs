'use strict';
// Main Street building panels: def.panel(state, world) -> {title, status, tone, rows, open, mission?}.
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = n => require(path.join(__dirname, '..', 'app', 'public', 'street', n + '.js'));
const LONG = 'x'.repeat(300);
const it = (id, extra) => Object.assign({ id, title: 't' + id, status: 'running', startedAt: null }, extra);
const src = o => Object.assign({ running: [], waiting: 0, needsYou: [], failedUnseen: [], recent: [] }, o);
const world = o => ({ street: { chat: src(), images: src(), missions: src(), garage: src(), sheets: src(), clock: src(), ...o } });
const P = (d, w) => d.panel(d.state(w), w);

const RUNS = [
  ['chat', 'Open Chat', '#ask'], ['images', 'Open Images', '#create'], ['missions', 'Open the mission', '#agents?mission=latest'],
  ['garage', 'Open In progress', '#inProgress'], ['sheets', 'Open Spreadsheets', '#spreadsheets'], ['clock', 'Open Automations', '#automationStudio'],
];
for (const [id, label, to] of RUNS) {
  test(id + ': panel rows, order, dedup, cap and cut', () => {
    const d = load(id);
    const w = o => { const x = world({ [id]: src(o) }); if (id === 'sheets') x.sheets = { bridge: true, excel: true, inFlight: 0 }; return x; };
    const quiet = P(d, w());
    assert.deepEqual(quiet.rows, []); assert.deepEqual(quiet.open, { label, to });
    assert.equal(quiet.mission, id === 'missions' ? true : undefined);
    assert.equal(quiet.status, d.chip(d.state(w())).detail); assert.equal(quiet.tone, d.chip(d.state(w())).tone);
    const busy = P(d, w({
      needsYou: [it('n1')], failedUnseen: [it('f1'), it('n1')], running: [it('r1'), it('r2')],
      recent: [it('r1'), it('c1', { status: 'completed', startedAt: '2026-10-28T09:05:00Z' }), it('x1', { status: 'cancelled' }), it('e1', { status: 'failed' }), it('c2', { status: 'completed', startedAt: '2026-10-28T14:30:00Z' })],
    }));
    assert.deepEqual(busy.rows.map(r => [r.id, r.note]), [['n1', 'Needs you'], ['f1', 'Failed'], ['r1', 'Running'], ['r2', 'Running'], ['c1', 'Finished · 9:05'], ['x1', 'Stopped']]);
    assert.equal(busy.rows.length, 6);
    const long = P(d, w({ running: [it('a', { title: LONG })] }));
    assert.equal(long.rows[0].title, 'x'.repeat(79) + '…');
    const markup = P(d, w({ running: [it('a', { title: '<b>&"x"</b>' })] }));
    assert.equal(markup.rows[0].title, '<b>&"x"</b>');
    assert.equal(P(d, w({ recent: [it('a', { status: 'completed', startedAt: 'nope' })] })).rows[0].note, 'Finished');
    const down = P(d, { street: null, sheets: null });
    assert.deepEqual(down.rows, []); assert.equal(down.tone, 'down'); assert.equal(down.status, 'Not answering');
  });
}

test('foundry: a row per model, then the queue', () => {
  const d = load('foundry');
  const w = { models: { loaded: [{ name: 'a', sizeMb: 100, vramMb: 1 }, { name: LONG, sizeMb: 2, vramMb: 1 }], queue: { active: 0, waiting: 3 } } };
  const p = P(d, w);
  assert.deepEqual(p.rows, [{ id: null, title: 'a', note: '100 MB' }, { id: null, title: 'x'.repeat(79) + '…', note: '2 MB' }, { id: null, title: 'Queue: 3 waiting', note: '' }]);
  assert.deepEqual(p.open, { label: 'Open Models', to: '#models' });
  assert.equal(P(d, { models: { loaded: [{ name: 'a', sizeMb: 1 }], queue: { active: 0, waiting: 0 } } }).rows.length, 1);
  const many = Array.from({ length: 9 }, (_, i) => ({ name: 'm' + i, sizeMb: 1 }));
  assert.equal(P(d, { models: { loaded: many, queue: { active: 0, waiting: 2 } } }).rows.length, 6);
  assert.equal(P(d, { models: { loaded: many, queue: null } }).rows.length, 6);
  const quiet = P(d, { models: { loaded: [], queue: null } });
  assert.deepEqual(quiet.rows, []); assert.equal(quiet.tone, 'quiet');
  const down = P(d, { models: { loaded: null, queue: null } });
  assert.equal(down.tone, 'down'); assert.deepEqual(down.rows, []);
});

test('workshop and kiosk: status only', () => {
  const ws = load('workshop'), w = { printer: { state: 'printing', progress: 40, access: 'ok' } };
  const p = P(ws, w);
  assert.deepEqual(p.rows, []); assert.deepEqual(p.open, { label: 'Open Pi Hub', to: 'http://10.0.0.30/' });
  assert.equal(p.status, ws.chip(ws.state(w)).detail); assert.equal(p.tone, ws.chip(ws.state(w)).tone);
  const k = load('kiosk'), kp = P(k, { kiosk: { setUp: true, online: true, firmware: '1.2' } });
  assert.deepEqual(kp.rows, []); assert.deepEqual(kp.open, { label: 'Open Workshop display', to: '#integrations?card=workshop' });
  assert.equal(kp.status, 'Online · 1.2');
  assert.equal(P(k, {}).tone, 'down');
});

test('yard: a row per session', () => {
  const d = load('yard');
  const crews = Array.from({ length: 8 }, (_, i) => ({ id: 's' + i, title: i === 0 ? LONG : 'job ' + i, state: i % 2 ? 'waiting' : 'working', lastAction: '' }));
  const p = P(d, { crews });
  assert.equal(p.rows.length, 6);
  assert.deepEqual(p.rows[0], { id: null, title: 'x'.repeat(79) + '…', note: 'Working' });
  assert.equal(p.rows[1].note, 'Waiting');
  assert.deepEqual(p.open, { label: 'Open Claude Code', to: '#claude' });
  assert.deepEqual(P(d, { crews: [] }).rows, []); assert.deepEqual(P(d, { crews: null }).rows, []);
  assert.equal(P(d, { crews: [] }).status, 'No sessions');
});
