'use strict';
// Phone notifications: the devices that subscribed (settings push:device:<id>) and, from Task 4, the rules for
// what each one gets. Sending goes through app/push.js. Since platform step 5 (D2), each event goes to Pi Hub first
// (sendHub, app/hub-notify.js), which keeps quiet hours, de-duplication and the cap; Web Push and its rules below are
// only the fallback for an event Pi Hub didn't take.

const crypto = require('node:crypto');

const KINDS = ['needs-you', 'failed', 'service', 'finished', 'answer'];
// Inside quiet hours only these still notify.
const ALWAYS = new Set(['failed', 'service', 'answer']);
const URGENCY = { 'needs-you': 'high', failed: 'high', service: 'high', finished: 'normal', answer: 'normal' };
const REPEAT_MS = 2 * 60 * 1000, BURST_MS = 10 * 60 * 1000, BURST_MAX = 10, SUMMARY_DELAY_MS = 60 * 1000, RETRY_MS = 30 * 1000, PRESENCE_MS = 60 * 1000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const cut = (text, max) => { const chars = [...String(text ?? '')]; return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join(''); };
function inQuiet(quiet, hhmm) {
  if (!quiet?.on || quiet.start === quiet.end) return false;
  return quiet.start < quiet.end ? hhmm >= quiet.start && hhmm < quiet.end : hhmm >= quiet.start || hhmm < quiet.end;
}
const DEVICE_PREFIX = 'push:device:';
// A device saved before 'answer' existed has never been asked about it, so it counts as on; once its kinds are
// edited (answerSet) the list is the owner's choice.
const wants = (device, kind) => !!device.kinds?.includes(kind) || (kind === 'answer' && !device.answerSet);
const publicDevice = ({ keys, answerSet, ...device }) => ({ ...device, kinds: KINDS.filter((k) => wants({ ...device, answerSet }, k)) });

function createNotifier({ storage, sendPush, sendHub = null, vapid, subject, now = Date.now, schedule = setTimeout, timeZone = process.env.TZ || 'America/New_York' }) {
  const all = () => storage.listSettings(DEVICE_PREFIX);
  const save = (device) => storage.writeSetting(DEVICE_PREFIX + device.id, device);

  function subscribe(subscription, name) {
    const existing = all().find((d) => d.endpoint === subscription.endpoint);
    const device = existing ? { ...existing, keys: subscription.keys, name: String(name || existing.name).slice(0, 40) } : {
      id: `d_${crypto.randomBytes(6).toString('hex')}`,
      name: String(name || 'Device').slice(0, 40),
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      kinds: [...KINDS],
      quiet: { on: true, start: '22:00', end: '07:00' },
      createdAt: new Date(now()).toISOString(),
      lastOkAt: null,
      lastError: null
    };
    save(device);
    return publicDevice(device);
  }

  function unsubscribe(endpoint) {
    const device = all().find((d) => d.endpoint === endpoint);
    if (device) storage.deleteSetting(DEVICE_PREFIX + device.id);
    return !!device;
  }

  // One send to one device, recording the outcome; a device the push service no longer knows is removed.
  async function deliver(device, payload, urgency) {
    try {
      const r = await sendPush(device, payload, { vapid, subject, urgency, topic: payload.tag });
      if (r.gone) { storage.deleteSetting(DEVICE_PREFIX + device.id); return 'removed'; }
      const current = storage.readSetting(DEVICE_PREFIX + device.id, null);
      if (current) save(r.ok ? { ...current, lastOkAt: new Date(now()).toISOString(), lastError: null } : { ...current, lastError: `HTTP ${r.status}` });
      return r.ok ? 'sent' : 'failed';
    } catch (error) {
      const current = storage.readSetting(DEVICE_PREFIX + device.id, null);
      if (current) save({ ...current, lastError: String(error?.message || error).slice(0, 200) });
      return 'failed';
    }
  }

  // Per device: when recent sends went out, when the last summary did, and how many were held back since.
  const recent = new Map(), repeats = new Map();
  const localTime = (t) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);

  function sendWithRetry(device, payload, urgency) {
    Promise.resolve()
      .then(() => deliver(device, payload, urgency))
      .then((result) => { if (result === 'failed') schedule(() => { deliver(device, payload, urgency).catch(() => {}); }, RETRY_MS); })
      .catch(() => {});
  }

  function allowBurst(device) {
    const t = now(), state = recent.get(device.id) || { times: [], summaryAt: 0, held: 0, pending: false };
    recent.set(device.id, state);
    state.times = state.times.filter((x) => t - x < BURST_MS);
    if (state.times.length < BURST_MAX) { state.times.push(t); return true; }
    state.held++;
    if (!state.pending && t - state.summaryAt >= BURST_MS) {
      state.pending = true;
      schedule(() => {
        state.pending = false; state.summaryAt = now();
        const held = state.held; state.held = 0;
        if (held > 0) sendWithRetry(device, { title: 'Local AI', body: `${held} more update${held === 1 ? '' : 's'} in Local AI`, url: '/?open=inbox', tag: 'summary' }, 'normal');
      }, SUMMARY_DELAY_MS);
    }
    return false;
  }

  // Never throws and never waits for the push service: callers fire and forget.
  function notify(event) {
    try {
      if (!event || !KINDS.includes(event.kind)) return;
      const t = now();
      const payload = { title: cut(event.title || 'Local AI', 60), body: cut(event.body, event.kind === 'answer' ? 180 : 80), url: String(event.url || '/'), tag: String(event.tag || event.kind) };
      const presenceAt = storage.readSetting('push:presence', null)?.at || 0;
      if (event.kind === 'finished' && t - presenceAt < PRESENCE_MS) return;
      if (sendHub) {
        Promise.resolve()
          .then(() => sendHub({ ...payload, kind: event.kind, title: event.title || payload.title, body: event.body ?? payload.body }))
          .then((r) => { if (!r?.ok) webPush(event, payload, t); }, () => webPush(event, payload, t))
          .catch(() => {});
        return;
      }
      webPush(event, payload, t);
    } catch {
      // A notification must never break what triggered it.
    }
  }

  // Today's Web Push to each subscribed device, with its kinds, quiet hours, repeat rule and burst cap.
  function webPush(event, payload, t) {
    try {
      if (repeats.size > 500) for (const [k, v] of repeats) if (t - v >= REPEAT_MS) repeats.delete(k);
      const hhmm = localTime(t);
      for (const device of all()) {
        if (!wants(device, event.kind)) continue;
        if (!ALWAYS.has(event.kind) && inQuiet(device.quiet, hhmm)) continue;
        const key = `${device.id}|${event.kind}|${payload.tag}|${payload.title}`;
        if (t - (repeats.get(key) || -Infinity) < REPEAT_MS) continue;
        repeats.set(key, t);
        if (!allowBurst(device)) continue;
        sendWithRetry(device, payload, URGENCY[event.kind]);
      }
    } catch {
      // A notification must never break what triggered it.
    }
  }

  function updateDevice(id, patch = {}) {
    const device = storage.readSetting(DEVICE_PREFIX + id, null);
    if (!device) return null;
    if (patch.name !== undefined) device.name = String(patch.name).trim().slice(0, 40) || device.name;
    if (Array.isArray(patch.kinds)) { device.kinds = KINDS.filter((k) => patch.kinds.includes(k)); device.answerSet = true; }
    if (patch.quiet) {
      const { on, start, end } = { ...device.quiet, ...patch.quiet };
      if (!HHMM.test(start) || !HHMM.test(end)) throw Object.assign(new Error('Quiet hours use HH:MM, e.g. 22:00.'), { status: 400 });
      device.quiet = { on: !!on, start, end };
    }
    save(device);
    return publicDevice(device);
  }

  // "Send a test": ignores kinds and quiet hours.
  async function test(id) {
    const targets = all().filter((d) => !id || d.id === id);
    const payload = { title: 'Test from Local AI', body: 'Notifications work on this device.', url: '/?open=status', tag: 'test' };
    const results = await Promise.all(targets.map((d) => deliver(d, payload, 'high')));
    const failedIds = targets.filter((d, i) => results[i] === 'failed').map((d) => d.id);
    const error = failedIds.length ? storage.readSetting(DEVICE_PREFIX + failedIds[0], null)?.lastError || 'unknown error' : null;
    return { sent: results.filter((r) => r === 'sent').length, removed: results.filter((r) => r === 'removed').length, failed: failedIds.length, error };
  }

  return {
    subscribe, unsubscribe, test,
    devices: () => all().map(publicDevice),
    notify, updateDevice,
    presence: () => storage.writeSetting('push:presence', { at: now() }),
    removeDevice(id) { const exists = !!storage.readSetting(DEVICE_PREFIX + id, null); if (exists) storage.deleteSetting(DEVICE_PREFIX + id); return exists; }
  };
}

// What each event looks like on the phone (spec: Events).
function runEvent(run, previousStatus) {
  if (!run || run.status === previousStatus) return null;
  // A spoken ask owns its notification (the handoff in app/server.js), so the generic ones stay quiet.
  if (run.meta?.voice) return null;
  const base = { url: `/?open=run:${run.id}`, tag: `run:${run.id}` };
  if (run.status === 'awaiting_approval') return { kind: 'needs-you', title: 'Waiting for your approval', body: run.title, ...base };
  // Only the run's title reaches the lock screen, never its output or error text (spec: Privacy).
  if (run.status === 'failed') return { kind: 'failed', title: 'Failed', body: run.title, ...base };
  if (run.status === 'completed' && run.startedAt && run.finishedAt && Date.parse(run.finishedAt) - Date.parse(run.startedAt) >= 30000) {
    return { kind: 'finished', title: 'Done', body: run.title, ...base };
  }
  return null;
}
function serviceEvent(overall, affected = []) {
  return overall === 'HEALTHY'
    ? { kind: 'service', title: 'Recovered', body: 'All core services are back.', url: '/?open=status', tag: 'service' }
    : { kind: 'service', title: `Down: ${affected.join(', ') || overall}`, body: `Local AI health changed to ${overall}`, url: '/?open=status', tag: 'service' };
}
// Inbox notices that should also reach the phone: approvals, and host jobs (meta.source 'host') that failed. The
// app's own health monitor also files 'monitor' notices, every 15 minutes while an optional companion is off;
// those stay in the Inbox, since Down/recovered already covers real outages.
function noticeEvent(kind, title, detail, level, meta = {}) {
  if (kind === 'approval') return { kind: 'needs-you', title: 'Approval needed', body: title, url: '/?open=approvals', tag: `approval:${title}` };
  if (['deploy', 'backup', 'monitor'].includes(kind) && level === 'attention' && meta?.source === 'host') return { kind: 'failed', title, body: detail, url: '/?open=inbox', tag: kind };
  return null;
}

module.exports = { createNotifier, KINDS, runEvent, serviceEvent, noticeEvent };
