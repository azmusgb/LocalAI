'use strict';

// Phone notifications (Web Push devices), release history and the addresses a phone can reach Local AI at.
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createPush(ctx) {
  const { APP_VERSION, json, notifier, nowIso, pushLib, readBody, release, resolveDeployFailures, storage, storageError } = ctx;
  async function apiPush(req, res, p) {
    try {
      if (req.method === 'GET' && p === '/api/push/key') return json(res, 200, { publicKey: pushLib.loadOrCreateVapid(storage).publicKey });
      if (req.method === 'GET' && p === '/api/push/devices') return json(res, 200, { devices: notifier.devices() });
      if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
      const b = await readBody(req, 16 * 1024);
      if (p === '/api/push/subscribe') {
        const s = b.subscription || {};
        if (!pushLib.isAllowedEndpoint(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) return json(res, 400, { error: 'That is not a browser push subscription.' });
        return json(res, 200, { device: notifier.subscribe(s, b.name) });
      }
      if (p === '/api/push/unsubscribe') return json(res, 200, { ok: notifier.unsubscribe(String(b.endpoint || '')) });
      if (p === '/api/push/test') return json(res, 200, await notifier.test(b.id ? String(b.id) : undefined));
      if (p === '/api/push/presence') { notifier.presence(); return json(res, 200, { ok: true }); }
      if (p === '/api/push/devices/update') { const d = notifier.updateDevice(String(b.id || ''), { name: b.name, kinds: b.kinds, quiet: b.quiet }); return d ? json(res, 200, { device: d }) : json(res, 404, { error: 'No such device' }); }
      if (p === '/api/push/devices/remove') return json(res, 200, { ok: notifier.removeDevice(String(b.id || '')) });
      return json(res, 404, { error: 'Not found' });
    } catch (e) { storageError(res, e, 400); }
  }
  // Each deployed release is recorded once (by commit) so the app can show what changed and when.
  const REPO_URL = process.env.LOCALAI_REPO_URL || 'https://github.com/azmusgb/LocalAI';
  function recordReleaseHistory() {
    if (!release?.commit || storage.readSetting('release:last', null)?.commit === release.commit) return;
    const entry = { commit: release.commit, version: APP_VERSION, deployedAt: release.deployedAt || nowIso(), notes: release.notes || [] };
    storage.writeSetting(`release:history:${entry.deployedAt}`, entry);
    storage.writeSetting('release:last', { commit: release.commit });
    try { resolveDeployFailures(APP_VERSION); } catch (e) { console.error(`${nowIso()} Resolving old update failures failed:`, e); }
    storage.pruneSettings('release:history:', 50);
  }
  // Addresses a phone can be pointed at (Health › Secure connection). LOCALAI_REMOTE_NAME is the host's Tailscale name;
  // the Caddy placeholder (*.invalid) and anything that isn't a plain host name count as not set.
  function remoteAccessName(raw = process.env.LOCALAI_REMOTE_NAME) {
    const name = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name) && !name.endsWith('.invalid') ? name : '';
  }
  // LOCALAI_HOST_IP is the host's LAN address (the one Caddy serves https://<ip> for). Anything else counts as not set.
  function homeAccessIp(raw = process.env.LOCALAI_HOST_IP) {
    const ip = String(raw || '').trim();
    return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(ip) ? ip : '';
  }
  // Every HTTPS address this appliance answers on, for a phone that can't reach the one it's using (offline-copy.js
  // offers the other one). Host names and URLs only, from the deploy (deploy/Install-LocalAI-HTTPS.ps1 → stack.env).
  function accessAddresses() {
    const ip = homeAccessIp(), remote = remoteAccessName();
    return [
      ...(ip ? [{ label: 'Home Wi-Fi', url: `https://${ip}` }] : []),
      ...(remote ? [{ label: 'Anywhere (Tailscale)', url: `https://${remote}` }] : [])
    ];
  }
  async function apiAccess(req, res) {
    json(res, 200, { remoteName: remoteAccessName(), addresses: accessAddresses() });
  }
  async function apiReleases(req, res) {
    json(res, 200, {
      current: { version: APP_VERSION, commit: release?.commit || null, deployedAt: release?.deployedAt || null },
      repoUrl: REPO_URL,
      history: storage.listSettings('release:history:', { limit: 20 })
    });
  }
  return { accessAddresses, apiAccess, apiPush, apiReleases, recordReleaseHistory };
}

module.exports = { createPush };
