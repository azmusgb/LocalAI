'use strict';
// Phone notifications: the devices that subscribed (settings push:device:<id>) and, from Task 4, the rules for
// what each one gets. Sending goes through app/push.js.

const crypto = require('node:crypto');

const KINDS = ['needs-you', 'failed', 'service', 'finished'];
const DEVICE_PREFIX = 'push:device:';
const publicDevice = ({ keys, ...device }) => device;

function createNotifier({ storage, sendPush, vapid, subject, now = Date.now, schedule = setTimeout, timeZone = process.env.TZ || 'America/New_York' }) {
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

  // "Send a test": ignores kinds and quiet hours.
  async function test(id) {
    const targets = all().filter((d) => !id || d.id === id);
    const payload = { title: 'Test from Local AI', body: 'Notifications work on this device.', url: '/?open=status', tag: 'test' };
    const results = await Promise.all(targets.map((d) => deliver(d, payload, 'high')));
    return { sent: results.filter((r) => r === 'sent').length, removed: results.filter((r) => r === 'removed').length };
  }

  return {
    subscribe, unsubscribe, test,
    devices: () => all().map(publicDevice),
    // Filled in by Task 4 (rules) and Task 6 (device settings).
    notify() {}, presence() {}, updateDevice() { return null; }, removeDevice() { return false; }
  };
}

module.exports = { createNotifier, KINDS };
