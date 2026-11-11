'use strict';

// The Workshop display's "Clear plate" (after a finished or failed print) goes through Local AI to Bambuddy, the Bambu
// printer manager on the Raspberry Pi: the display already has a signed-in, certificate-pinned link to Local AI, so it
// never holds a Bambuddy credential. Local AI clears the plate and the printer's error list.
// LOCALAI_BAMBUDDY_URL (default http://10.0.0.80:8000); LOCALAI_BAMBUDDY_CONTROL_KEY, a Bambuddy API key with
// "Control printer" only, sent as X-API-Key (needed once Bambuddy's sign-in is on); LOCALAI_BAMBUDDY_PRINTER (default 1).
// Never throws.

const TIMEOUT_MS = 5000;

function createBambuddyControl({
  url = process.env.LOCALAI_BAMBUDDY_URL || 'http://10.0.0.80:8000',
  key = process.env.LOCALAI_BAMBUDDY_CONTROL_KEY || '',
  printer = Number(process.env.LOCALAI_BAMBUDDY_PRINTER) || 1,
  // Reading the printer's state needs "Read status"; falls back to the materials key, then the control key.
  statusKey = process.env.LOCALAI_BAMBUDDY_STATUS_KEY || process.env.LOCALAI_MATERIALS_KEY || key,
  fetchImpl = fetch
} = {}) {
  const off = !url || url === 'off';

  async function post(path) {
    try {
      const r = await fetchImpl(new URL(path, url), {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: key ? { 'X-API-Key': key } : {}
      });
      return r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'refused' : `HTTP ${r.status}`;
    } catch {
      return 'no answer';
    }
  }

  // { ok, plate, errors }: the plate is cleared even if clearing its error list fails.
  // Match Pi Hub: never clear errors after a refused/failed plate action.
  async function clearPlate() {
    if (off) return { ok: false, plate: 'off', errors: 'off' };
    const plate = await post(`/api/v1/printers/${printer}/clear-plate`);
    const errors = plate === 'ok' ? await post(`/api/v1/printers/${printer}/hms/clear`) : 'skipped';
    return { ok: plate === 'ok', plate, errors };
  }

  // { ok: true, state, awaitingPlateClear, connected } from Bambuddy's own printer status (the same fields Pi Hub
  // reads), or { ok: false, reason } when it is off, refused or doesn't answer within the short timeout.
  async function status() {
    if (off) return { ok: false, reason: 'off' };
    try {
      const r = await fetchImpl(new URL(`/api/v1/printers/${printer}/status`, url), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'application/json', ...(statusKey ? { 'X-API-Key': statusKey } : {}) }
      });
      if (!r.ok) return { ok: false, reason: r.status === 401 || r.status === 403 ? 'refused' : `HTTP ${r.status}` };
      const body = await r.json();
      if (!body || typeof body !== 'object') return { ok: false, reason: 'unreadable' };
      return { ok: true, state: String(body.state || '').toUpperCase(), awaitingPlateClear: body.awaiting_plate_clear === true, connected: body.connected !== false };
    } catch {
      return { ok: false, reason: 'no answer' };
    }
  }

  return { clearPlate, status };
}

// Clearing is only for a finished or failed print that is waiting for it (Pi Hub offers Clear on the same rule).
// Returns null when allowed, else a plain sentence for the person pressing the button.
function plateClearRefusal(status) {
  if (!status || !status.ok) return 'Could not read the printer\'s state, so the plate was not cleared. Check the printer and try again.';
  if (!status.connected) return 'The printer is offline, so the plate was not cleared.';
  if (['FINISH', 'FAILED'].includes(status.state) && status.awaitingPlateClear) return null;
  return 'The printer is not waiting for the plate to be cleared (it must be finished or failed first).';
}

// The firmware's existing message channel supplies visible completion feedback without a firmware update.
function clearPlateMessage(result) {
  if (!result.ok) return { title: 'Plate not confirmed', text: 'The confirmation did not go through. Check the printer before trying again.', tone: 'warning' };
  if (result.errors !== 'ok') return { title: 'Check printer errors', text: 'Plate confirmed. The printer error list did not clear; check its screen.', tone: 'warning' };
  return { title: 'Plate confirmed', text: 'Bambuddy accepted the plate confirmation.', tone: 'ok' };
}

module.exports = { createBambuddyControl, clearPlateMessage, plateClearRefusal };
