'use strict';
// Watchdog (docs/WATCHDOG.md): spots trouble around Local AI before it breaks something, and tells the owner once
// per problem. It looks at what the appliance can see itself (its disks, the Workshop display and printer through
// app/workshop.js) and at what the Mac reports (POST /api/watch/heartbeat: its disk and the camera bridge). A
// problem must last limits.settleMs before it notifies, so one slow poll never pages anyone, and it notifies once:
// when it clears it just leaves Home. Each finding says how it is pushed: a printer error is 'failed' (it gets
// through quiet hours), disks and the display are 'needs-you' (they wait for morning), and a Mac that went quiet
// is only listed (a Mac sleeps every night). The Windows computer going away can't be seen from here (Local AI
// runs on it), so the Mac side notifies about that itself (host/mac-watch).

const fs = require('node:fs');

const LIMITS = {
  macSilentMs: 15 * 60 * 1000, // no heartbeat for this long: the Mac (or its watcher) went quiet
  diskPct: 90,                 // a disk this full (percent used) ...
  diskFreeBytes: 15e9,         // ... or with less than this free
  displayOfflineMs: 10 * 60 * 1000,
  settleMs: 2 * 60 * 1000
};
const STATE_KEY = 'watchdog:state';
const MAC_KEY = 'watchdog:mac';

const gb = (bytes) => `${Math.max(0, Math.round(bytes / 1e9))} GB`;
const pct = (free, total) => (total > 0 ? Math.round(((total - free) / total) * 100) : 0);
const clock = (ms, timeZone) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });

function diskFinding(id, where, disk, limits) {
  const total = Number(disk?.totalBytes), free = Number(disk?.freeBytes);
  if (!(total > 0) || !(free >= 0)) return null;
  const used = pct(free, total);
  if (used < limits.diskPct && free >= limits.diskFreeBytes) return null;
  return {
    id, severity: used >= 97 || free < 5e9 ? 'high' : 'medium', push: 'needs-you',
    title: `${where} disk is ${used}% full`,
    detail: `${gb(free)} free. Builds, updates and images start failing when it runs out.`
  };
}

// What is wrong right now, from the latest inputs. Pure: the same inputs give the same findings.
function evaluate({ now, mac, hostDisks = [], printer, startedAt = now, limits = LIMITS, timeZone }) {
  const out = [];
  if (mac?.at) {
    const at = Date.parse(mac.at);
    if (now - at > limits.macSilentMs) {
      out.push({ id: 'mac-silent', severity: 'medium', push: null, title: 'The Mac stopped checking in', detail: `Last heard from at ${clock(at, timeZone)}. It may be asleep, off or off the network.` });
    } else {
      const d = diskFinding('mac-disk', 'Mac', mac.disk, limits);
      if (d) out.push(d);
      if (mac.bridge?.installed && mac.bridge.running === false) {
        out.push({ id: 'camera-bridge', severity: 'medium', push: 'needs-you', title: "The printer camera bridge isn't running", detail: 'The Workshop display shows no camera until it runs again on the Mac.' });
      }
    }
  }
  for (const disk of hostDisks) {
    const d = diskFinding(`host-disk:${disk.name}`, disk.label || 'Windows', disk, limits);
    if (d) out.push(d);
  }
  if (printer) {
    const seen = printer.seenAt ? Date.parse(printer.seenAt) : startedAt;
    if (printer.access === 'offline' && now - seen > limits.displayOfflineMs) {
      out.push({ id: 'display-offline', severity: 'high', push: 'needs-you', title: "The Workshop display isn't answering", detail: 'Printer status stops reaching Local AI until it is back on Wi-Fi.' });
    }
    if (printer.state === 'error') {
      out.push({ id: 'printer-error', severity: 'high', push: 'failed', title: 'The printer stopped with an error', detail: printer.errorCode ? `Error ${printer.errorCode}. Check the printer.` : 'Check the printer.' });
    }
  }
  return out;
}

// Free and total bytes of each distinct filesystem behind `paths` (bind mounts of one drive count once).
function measureDisks(paths, statfs = fs.statfsSync) {
  const seen = new Map();
  for (const { path, name, label } of paths) {
    try {
      const s = statfs(path);
      const totalBytes = Number(s.blocks) * Number(s.bsize), freeBytes = Number(s.bavail) * Number(s.bsize);
      const key = `${totalBytes}`;
      if (totalBytes > 0 && !seen.has(key)) seen.set(key, { name, label, totalBytes, freeBytes });
    } catch { /* not mounted here */ }
  }
  return [...seen.values()];
}

function cleanHeartbeat(body, nowIso) {
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const disk = body?.disk && typeof body.disk === 'object' ? { freeBytes: num(body.disk.freeBytes), totalBytes: num(body.disk.totalBytes) } : null;
  const b = body?.bridge && typeof body.bridge === 'object' ? body.bridge : null;
  return {
    at: nowIso,
    name: String(body?.name || 'Mac').slice(0, 40),
    disk: disk && disk.totalBytes ? disk : null,
    bridge: b ? { installed: b.installed === true, running: b.running === true, frameAgeMs: num(b.frameAgeMs) } : null
  };
}

function createWatchdog({ storage, notify, now = Date.now, limits = LIMITS, hostPaths = [], printer = () => null, statfs, timeZone = process.env.TZ || 'America/New_York' }) {
  const startedAt = now();
  const state = () => storage.readSetting(STATE_KEY, { active: {}, printerState: null });

  function heartbeat(body) {
    const beat = cleanHeartbeat(body, new Date(now()).toISOString());
    storage.writeSetting(MAC_KEY, beat);
    return beat;
  }

  // One pass: evaluate, settle, notify on changes. Returns the settled findings.
  function tick() {
    const t = now();
    const p = printer();
    const findings = evaluate({ now: t, mac: storage.readSetting(MAC_KEY, null), hostDisks: measureDisks(hostPaths, statfs), printer: p, startedAt, limits, timeZone });
    const prev = state();
    const active = {};
    for (const f of findings) {
      const was = prev.active[f.id];
      const since = was?.since ?? t;
      const settled = t - since >= limits.settleMs;
      const notified = was?.notified || false;
      if (settled && !notified && f.push) {
        notify({ kind: f.push, title: f.title, body: f.detail, url: '/?open=status', tag: `watch:${f.id}` });
      }
      active[f.id] = { since, notified: notified || settled, finding: f };
    }
    // A print that just finished on its own (not cancelled, not failed).
    const printerState = p?.state && p.state !== 'unknown' ? p.state : prev.printerState;
    if (prev.printerState === 'printing' && p?.state === 'ended') {
      notify({ kind: 'finished', title: 'Print finished', body: 'The plate is ready to take off.', url: '/?open=status', tag: 'watch:print-done' });
    }
    storage.writeSetting(STATE_KEY, { active, printerState, checkedAt: new Date(t).toISOString() });
    return list();
  }

  // Settled findings, for Home's Needs you, /api/glance and GET /api/watch.
  function list() {
    const t = now();
    return Object.values(state().active)
      .filter((a) => t - a.since >= limits.settleMs)
      .map((a) => ({ ...a.finding, since: new Date(a.since).toISOString() }));
  }

  function summary() {
    const mac = storage.readSetting(MAC_KEY, null);
    return {
      checkedAt: state().checkedAt || null,
      findings: list(),
      mac: mac ? { name: mac.name, lastAt: mac.at, disk: mac.disk, bridge: mac.bridge } : null,
      hostDisks: measureDisks(hostPaths, statfs).map(({ name, label, totalBytes, freeBytes }) => ({ name, label, totalBytes, freeBytes }))
    };
  }

  return { heartbeat, tick, list, summary };
}

module.exports = { createWatchdog, evaluate, measureDisks, cleanHeartbeat, LIMITS };
