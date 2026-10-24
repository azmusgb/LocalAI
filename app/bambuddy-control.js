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

  // { ok, plate, errors }: ok when both steps went through.
  async function clearPlate() {
    if (off) return { ok: false, plate: 'off', errors: 'off' };
    const plate = await post(`/api/v1/printers/${printer}/clear-plate`);
    const errors = await post(`/api/v1/printers/${printer}/hms/clear`);
    return { ok: plate === 'ok' && errors === 'ok', plate, errors };
  }

  return { clearPlate };
}

module.exports = { createBambuddyControl };
