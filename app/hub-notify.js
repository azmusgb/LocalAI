'use strict';
// Pi Hub is the one phone channel (platform step 5, D2): the notifier posts each event to Pi Hub's
// POST /api/notify/localai first, with the localai deploy key (X-Hub-Deploy-Key; the same key Safe Deploy reports
// releases with). Pi Hub keeps quiet hours, de-duplication and the cap; Web Push is only the fallback for an event Pi
// Hub didn't take, until it retires. No token (LOCALAI_PI_HUB_TOKEN empty) means no Pi Hub channel: Web Push as
// before. The name ends in TOKEN so childEnv and the model coordinator's redaction (SECRET_ENV) both treat it as secret.

// Its own variable: LOCALAI_PI_HUB_URL is the plain-http LAN address app/pi-hub.js and app/print-lab.js read unsigned
// machine paths from (/api/needs, /api/records), which the real name would put behind Pi Hub's sign-in.
const DEFAULT_HUB = 'https://hub.rahe-home.duckdns.org';
const cut = (text, max) => { const chars = [...String(text ?? '')]; return chars.length > max ? chars.slice(0, max).join('') : chars.join(''); };

// The tap link: the app's own path on its HTTPS name, which Pi Hub accepts (notify_routes.CLICK_HOSTS).
function clickFor(url, name) {
  const path = String(url || '/');
  if (!path.startsWith('/') || path.startsWith('//') || !/^[A-Za-z0-9\-._~:/?#[\]!$&'()*+,;=%]*$/.test(path)) return undefined;
  return `https://${name}${path}`;
}

// Returns send(event) -> Promise<{ ok, status }>, or null with no key. ok means Pi Hub took it: sent, held for quiet
// hours, a duplicate, or over its cap (kept in its Alerts history). Never throws.
function createHubNotify({ key = process.env.LOCALAI_PI_HUB_TOKEN, url = process.env.LOCALAI_PI_HUB_NOTIFY_URL || DEFAULT_HUB,
  name = process.env.LOCALAI_NAME || 'localai.home.arpa', fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  key = String(key || '').trim();
  if (!key || !/^https:\/\//.test(url)) return null;
  const endpoint = `${url.replace(/\/+$/, '')}/api/notify/localai`;
  return async function send(event) {
    const body = {
      kind: event.kind, title: cut(event.title || 'Local AI', 120), body: cut(event.body, 500),
      click: clickFor(event.url, name), dedupe: cut(`${event.kind}:${event.tag || ''}:${event.title || ''}`, 80)
    };
    try {
      const r = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', 'X-Hub-Deploy-Key': key }, body: JSON.stringify(body)
      });
      return { ok: (r.status >= 200 && r.status < 300) || r.status === 429, status: r.status };
    } catch {
      return { ok: false, status: 0 };
    }
  };
}

module.exports = { createHubNotify, clickFor };
