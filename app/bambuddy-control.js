'use strict';

// The Workshop display's "Clear plate" (after a finished or failed print) goes through Local AI to Bambuddy, the Bambu
// printer manager on the Raspberry Pi: the display already has a signed-in, certificate-pinned link to Local AI, so it
// never holds a Bambuddy credential. Local AI clears the plate and the printer's error list.
// LOCALAI_BAMBUDDY_URL (default http://10.0.0.30:8000); LOCALAI_BAMBUDDY_CONTROL_KEY, a Bambuddy API key with
// "Control printer" only, sent as X-API-Key (needed once Bambuddy's sign-in is on); LOCALAI_BAMBUDDY_PRINTER (default 1).
// Never throws.

const TIMEOUT_MS = 5000;

function createBambuddyControl({
  url = process.env.LOCALAI_BAMBUDDY_URL || 'http://10.0.0.30:8000',
  key = process.env.LOCALAI_BAMBUDDY_CONTROL_KEY || '',
  printer = Number(process.env.LOCALAI_BAMBUDDY_PRINTER) || 1,
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

  return { clearPlate };
}

// The firmware's existing message channel supplies visible completion feedback without a firmware update.
function clearPlateMessage(result) {
  if (!result.ok) return { title: 'Plate not confirmed', text: 'The confirmation did not go through. Check the printer before trying again.', tone: 'warning' };
  if (result.errors !== 'ok') return { title: 'Check printer errors', text: 'Plate confirmed. The printer error list did not clear; check its screen.', tone: 'warning' };
  return { title: 'Plate confirmed', text: 'Bambuddy accepted the plate confirmation.', tone: 'ok' };
}

module.exports = { createBambuddyControl, clearPlateMessage };
