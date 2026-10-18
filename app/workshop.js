'use strict';

// Services › Workshop display: the BambuHelper touchscreen beside the 3D printer (docs/WORKSHOP-DISPLAY.md).
// Local AI only reads the display's one public route, GET /hardware/health, and links to the display's own portal.
// It never proxies the portal, which holds the printer controls (Stop among them). The portal is meant to have its own
// sign-in, CSRF and same-origin checks; the firmware installed on 18 Oct 2026 has no sign-in (docs/WORKSHOP-DISPLAY.md,
// Current state), and Local AI must not become another way to the controls either way.
const { modelFetchWithTimeout } = require('./model-http');

const DEFAULT_URL = 'http://10.0.0.124';
const TIMEOUT_MS = 4000;
const MAX_BODY = 16 * 1024; // the real answer is about 500 bytes

// 10/8, 172.16/12 and 192.168/16 (the home network), or 127/8 (tests run a stand-in device on loopback).
function privateIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some(n => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

// LOCALAI_WORKSHOP_URL, or the default when it is unset or empty. Only a plain http(s) address on the home network
// (a private IPv4 address or a .local name), with no path, query or credentials, is used; anything else counts as
// not set up (null), so the appliance never fetches an outside address or offers a link to one.
function portalUrl(raw = process.env.LOCALAI_WORKSHOP_URL) {
  const text = String(raw ?? '').trim() || DEFAULT_URL;
  let u;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
  const host = u.hostname.toLowerCase();
  const lan = privateIpv4(host) || /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+local$/.test(host);
  return lan ? u.origin : null;
}

const text = v => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80) || null : null);

async function readCapped(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel().catch(() => {}); throw new Error('Answer too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// What the Services card shows. The object is rebuilt field by field: nothing else the display reports (Wi-Fi
// strength, memory, printer state) passes through.
async function workshopStatus({ url = portalUrl(), fetchImpl = modelFetchWithTimeout, timeoutMs = TIMEOUT_MS } = {}) {
  const offline = { online: false, board: null, panel: null, screen: null, touchscreenConfigured: null, portalUrl: url };
  if (!url) return offline;
  try {
    const r = await fetchImpl(`${url}/hardware/health`, { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs);
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return offline; }
    const d = JSON.parse(await readCapped(r, MAX_BODY));
    if (!d || typeof d !== 'object' || Array.isArray(d)) return offline;
    return {
      online: true,
      board: text(d.board),
      panel: text(d.panel),
      screen: Number.isSafeInteger(d.screen) ? d.screen : null,
      touchscreenConfigured: typeof d.touchscreenConfigured === 'boolean' ? d.touchscreenConfigured : null,
      portalUrl: url
    };
  } catch {
    return offline;
  }
}

module.exports = { DEFAULT_URL, TIMEOUT_MS, portalUrl, workshopStatus };
