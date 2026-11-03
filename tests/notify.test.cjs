'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier } = require('../app/notify.js');

const flush = () => new Promise((r) => setImmediate(r));
// 2026-10-15 is EDT (UTC-4): 23:30 local = 03:30Z next day.
const at = (iso) => Date.parse(iso);

function harness({ startAt = at('2026-10-15T16:00:00Z'), statusFor = {}, sendHub = null } = {}) {
  const settings = new Map();
  const storage = {
    readSetting: (k, f) => (settings.has(k) ? structuredClone(settings.get(k)) : f),
    writeSetting: (k, v) => settings.set(k, structuredClone(v)),
    deleteSetting: (k) => settings.delete(k),
    listSettings: (prefix) => [...settings].filter(([k]) => k.startsWith(prefix)).map(([, v]) => structuredClone(v))
  };
  const sent = [], scheduled = [];
  let clock = startAt;
  const sendPush = async (device, payload, opts) => {
    sent.push({ device: device.id, payload, opts });
    const s = statusFor[device.endpoint];
    if (s === 'hang') return new Promise(() => {});
    if (s === 'throw') throw new Error('network down');
    const status = typeof s === 'function' ? s() : (s || 201);
    return { ok: status < 300, status, gone: status === 404 || status === 410 };
  };
  const n = createNotifier({ storage, sendPush, sendHub, vapid: {}, subject: 's', now: () => clock, schedule: (fn, ms) => scheduled.push({ fn, ms }), timeZone: 'America/New_York' });
  const device = (name, patch = {}) => {
    const d = n.subscribe({ endpoint: `https://web.push.apple.com/${name}`, keys: { p256dh: 'p', auth: 'a' } }, name);
    if (Object.keys(patch).length) n.updateDevice(d.id, patch);
    return d;
  };
  return { n, sent, scheduled, settings, device, setClock: (t) => { clock = t; }, advance: (ms) => { clock += ms; } };
}
const ev = (kind, extra = {}) => ({ kind, title: `${kind} title`, body: 'body', url: '/', tag: `${kind}-tag`, ...extra });

test('kinds', async () => {
  const h = harness(); h.device('phone', { kinds: ['failed'] });
  h.n.notify(ev('failed')); h.n.notify(ev('finished', { tag: 'x' }));
  await flush();
  assert.deepEqual(h.sent.map((s) => s.payload.title), ['failed title']);
});

test('quiet hours across midnight', async () => {
  const h = harness({ startAt: at('2026-10-16T03:30:00Z') }); // 23:30 New York
  h.device('phone');
  for (const k of ['needs-you', 'finished', 'failed', 'service']) h.n.notify(ev(k));
  await flush();
  assert.deepEqual(h.sent.map((s) => s.payload.title).sort(), ['failed title', 'service title']);
  h.setClock(at('2026-10-16T11:00:00Z')); // 07:00 New York
  h.n.notify(ev('needs-you', { tag: 'later' }));
  await flush();
  assert.equal(h.sent.at(-1).payload.tag, 'later');
});

test('a quiet window with start equal to end never blocks', async () => {
  const h = harness({ startAt: at('2026-10-16T13:00:00Z') }); // 09:00 New York
  h.device('phone', { quiet: { on: true, start: '09:00', end: '09:00' } });
  h.n.notify(ev('finished')); await flush();
  assert.equal(h.sent.length, 1);
});

test('finished needs no Local AI page visible in the last minute', async () => {
  const h = harness(); h.device('phone');
  h.n.presence();
  h.advance(59000); h.n.notify(ev('finished', { tag: 'a' })); await flush();
  assert.equal(h.sent.length, 0);
  h.advance(2000); h.n.notify(ev('finished', { tag: 'b' })); await flush();
  assert.equal(h.sent.length, 1);
});

test('an identical repeat within 2 minutes is dropped', async () => {
  const h = harness(); h.device('phone');
  h.n.notify(ev('failed')); h.n.notify(ev('failed')); await flush();
  assert.equal(h.sent.length, 1);
  h.advance(121000); h.n.notify(ev('failed')); await flush();
  assert.equal(h.sent.length, 2);
});

test('burst limit sends one summary', async () => {
  const h = harness(); h.device('phone');
  for (let i = 0; i < 12; i++) { h.n.notify(ev('failed', { tag: `t${i}`, title: `t${i}` })); h.advance(1000); }
  await flush();
  assert.equal(h.sent.length, 10);
  const summaries = h.scheduled.filter((s) => s.ms === 60000);
  assert.equal(summaries.length, 1);
  summaries[0].fn(); await flush();
  assert.deepEqual(h.sent.at(-1).payload, { title: 'Local AI', body: '2 more updates in Local AI', url: '/?open=inbox', tag: 'summary' });
  for (let i = 0; i < 3; i++) h.n.notify(ev('failed', { tag: `u${i}`, title: `u${i}` }));
  await flush();
  assert.equal(h.scheduled.filter((s) => s.ms === 60000).length, 1);
});

test('long titles and bodies are cut, not rejected', async () => {
  const h = harness(); h.device('phone');
  h.n.notify(ev('failed', { title: 'T'.repeat(100), body: 'é'.repeat(200) })); await flush();
  const p = h.sent[0].payload;
  assert.equal([...p.title].length, 60); assert.ok(p.title.endsWith('…'));
  assert.equal([...p.body].length, 80); assert.ok(p.body.endsWith('…'));
});

test('410 removes only that device', async () => {
  const h = harness({ statusFor: { 'https://web.push.apple.com/gone': 410 } });
  const gone = h.device('gone'), phone = h.device('phone');
  h.n.notify(ev('failed')); await flush();
  assert.deepEqual(h.n.devices().map((d) => d.id), [phone.id]);
  assert.ok(h.n.devices()[0].lastOkAt);
  assert.ok(!h.n.devices().some((d) => d.id === gone.id));
});

test('one retry after 30 seconds, then the error is recorded', async () => {
  const h = harness({ statusFor: { 'https://web.push.apple.com/phone': 500 } }); h.device('phone');
  h.n.notify(ev('failed')); await flush();
  const retries = h.scheduled.filter((s) => s.ms === 30000);
  assert.equal(retries.length, 1);
  retries[0].fn(); await flush();
  assert.equal(h.sent.length, 2);
  assert.equal(h.scheduled.filter((s) => s.ms === 30000).length, 1);
  assert.equal(h.n.devices()[0].lastError, 'HTTP 500');
});

test('notify never blocks or throws', async () => {
  const h = harness({ statusFor: { 'https://web.push.apple.com/hang': 'hang', 'https://web.push.apple.com/boom': 'throw' } });
  h.device('hang'); h.device('boom');
  assert.equal(h.n.notify(ev('failed')), undefined);
  assert.doesNotThrow(() => h.n.notify({ kind: 'nonsense' }));
  assert.doesNotThrow(() => h.n.notify(null));
  await flush();
});

test('urgency follows the kind', async () => {
  const h = harness(); h.device('phone');
  h.n.notify(ev('needs-you')); h.n.notify(ev('finished')); await flush();
  assert.deepEqual(h.sent.map((s) => s.opts.urgency), ['high', 'normal']);
});

test('updateDevice validates and removeDevice removes', () => {
  const h = harness(); const d = h.device('phone');
  assert.deepEqual(h.n.updateDevice(d.id, { kinds: ['failed', 'bogus'], quiet: { on: false, start: '21:30', end: '06:00' }, name: 'My iPhone' }).kinds, ['failed']);
  assert.equal(h.n.devices()[0].name, 'My iPhone');
  assert.throws(() => h.n.updateDevice(d.id, { quiet: { on: true, start: '25:00', end: '07:00' } }), /HH:MM/);
  assert.equal(h.n.updateDevice('nope', { name: 'x' }), null);
  assert.equal(h.n.removeDevice(d.id), true);
  assert.equal(h.n.devices().length, 0);
});

test('answer: a device from before the kind existed gets it; one that turned Answers off does not', async () => {
  const h = harness();
  const old = h.device('old');
  const stored = h.settings.get(`push:device:${old.id}`);
  h.settings.set(`push:device:${old.id}`, { ...stored, kinds: ['needs-you', 'failed', 'service', 'finished'] });
  h.device('off', { kinds: ['failed'] });
  h.n.notify(ev('answer')); await flush();
  assert.deepEqual(h.sent.map((s) => s.device), [old.id]);
  assert.ok(h.n.devices().find((d) => d.id === old.id).kinds.includes('answer'));
});

test('answer: inside quiet hours an answer is sent while finished is held', async () => {
  const h = harness({ startAt: at('2026-10-16T03:30:00Z') }); // 23:30 local
  h.device('phone');
  h.n.notify(ev('finished')); await flush();
  assert.equal(h.sent.length, 0);
  h.n.notify(ev('answer')); await flush();
  assert.equal(h.sent.length, 1);
});

// Platform step 5 (D2): Pi Hub first; Web Push only for an event Pi Hub didn't take.
test('an event Pi Hub takes is not also sent by Web Push', async () => {
  const hub = [];
  const h = harness({ sendHub: async (e) => { hub.push(e); return { ok: true, status: 200 }; } });
  h.device('phone');
  h.n.notify(ev('failed', { title: 'Failed', body: 'Run 7' }));
  await flush(); await flush();
  assert.deepEqual(hub.map((e) => [e.kind, e.title, e.body, e.tag]), [['failed', 'Failed', 'Run 7', 'failed-tag']]);
  assert.equal(h.sent.length, 0);
});

test('an event Pi Hub did not take (or a throw) falls back to Web Push with its rules', async () => {
  let status = 502;
  const h = harness({ sendHub: async () => (status === 'throw' ? Promise.reject(new Error('x')) : { ok: false, status }) });
  h.device('phone');
  h.n.notify(ev('failed'));
  await flush(); await flush();
  assert.equal(h.sent.length, 1);
  status = 'throw';
  h.n.notify(ev('service'));
  await flush(); await flush();
  assert.equal(h.sent.length, 2);
  h.n.notify(ev('service'));  // the fallback keeps its own 2-minute repeat rule
  await flush(); await flush();
  assert.equal(h.sent.length, 2);
});

test('a finished run while a page is visible goes nowhere, Pi Hub included', async () => {
  const hub = [];
  const h = harness({ sendHub: async (e) => { hub.push(e); return { ok: true, status: 200 }; } });
  h.n.presence();
  h.n.notify(ev('finished'));
  await flush();
  assert.equal(hub.length, 0);
});

