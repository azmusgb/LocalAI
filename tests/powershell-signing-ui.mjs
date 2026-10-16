// PowerShell Workbench, browser half of the chain: unlock, create, approve and queue a job in the real UI, and check
// the signature the browser computed (WebCrypto) is exactly the HMAC the Windows host verifies
// (host/powershell-bridge/Run-LocalAI-PowerShellHost.ps1, Test-JobSignature). The Windows half runs on CI in
// tests/Test-LocalAI-PowerShellBridge.ps1. Starts its own server with the bridge tokens set.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = await new Promise(r => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const dataDir = mkdtempSync(join(tmpdir(), 'localai-ps-'));
const UI_TOKEN = 'ui-token-for-tests-0123456789', BRIDGE_TOKEN = 'bridge-token-for-tests-0123456789', KEY = 'approval-key-for-tests-0123456789abcdef';
const server = spawn(process.execPath, [join(root, 'app/server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, POWERSHELL_UI_TOKEN: UI_TOKEN, POWERSHELL_BRIDGE_TOKEN: BRIDGE_TOKEN }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }
const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
// The UI asks for "RUN" in an approval sheet, then the approval key in a second sheet (no native dialogs).
page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
await page.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.devTools', '1'); });
await page.goto(base, { waitUntil: 'networkidle' });
await page.evaluate(() => window.showView('powershell'));
const script = "Write-Output ('héllo → ' + (Get-Date).Year)\r\n# second line";

await check('the browser signs exactly what the Windows host verifies', async () => {
  await page.fill('#powershellToken', UI_TOKEN);
  await page.click('#powershellUnlockBtn');
  await page.waitForFunction(() => /host bridge ready/.test(document.getElementById('powershellBridge').textContent));
  await page.selectOption('#powershellCwd', 'C:\\Projects');
  await page.fill('#powershellTimeout', '45');
  await page.locator('#powershellScript').evaluate((el, v) => { el.value = v; }, script);
  await page.click('#powershellCreateBtn');
  await page.locator('[data-ps-approve]').click();
  await page.locator('[data-ps-run]').click();
  const sheet = page.locator('dialog.ask-sheet[open]');
  await sheet.waitFor();
  await sheet.locator('input').fill('RUN');
  await sheet.getByRole('button', { name: 'Queue' }).click();
  await sheet.waitFor();
  assert.equal(await sheet.locator('input').getAttribute('type'), 'password');
  await sheet.locator('input').fill(KEY);
  await sheet.getByRole('button', { name: 'Use key' }).click();
  await page.waitForFunction(() => /Queued/.test(document.getElementById('powershellStatus').textContent));
  // What the host receives: the job and the browser's signature.
  const next = await (await fetch(base + '/api/powershell/host/next', { headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` } })).json();
  const job = next.item;
  // Browsers normalise a textarea's line endings to \n; that text is what's signed and what the host runs.
  assert.equal(job.script, script.replace(/\r\n/g, '\n'));
  const expected = createHmac('sha256', KEY).update(`localai-ps-v1\n${job.id}\n${job.cwd}\n${job.timeoutSec}\n${job.script}`, 'utf8').digest('hex');
  assert.equal(job.signature, expected);
  assert.equal(job.timeoutSec, 45);
});
await check('no script errors', async () => assert.deepEqual(errors, []));
await browser.close();
server.kill('SIGTERM');
rmSync(dataDir, { recursive: true, force: true });
if (failed) { console.log(`${failed} PowerShell signing check(s) failed`); process.exit(1) }
