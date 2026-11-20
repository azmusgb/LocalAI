// Imported first by every tests/*-ui.mjs suite that reads LOCALAI_URL (tests/browser-target.test.cjs checks it), so a
// suite run directly (`node tests/<name>-ui.mjs`) makes the same check as tests/run-browser.mjs before its own code
// runs: exit 2 when the target is a deployed release or can't be read. run-browser.mjs passes the URL it already
// checked in LOCALAI_TARGET_CHECKED, and the check is skipped only for that same URL.
import { checkBrowserTarget, DEFAULT_TARGET, TARGET_CHECKED } from './browser-target.mjs';

const base = process.env.LOCALAI_URL || DEFAULT_TARGET;
if (process.env[TARGET_CHECKED] !== base) {
  const target = await checkBrowserTarget(base);
  if (!target.ok) { console.error(target.reason); process.exit(2); }
  if (target.warning) console.error(target.warning);
}
