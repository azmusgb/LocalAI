// Print lab on Local AI since platform step 6, PR 6.4: the tab sends the browser to Pi Hub's /lab. On an iPhone and a
// desktop, each Print lab address lands on Pi Hub's /lab with its e, p and do, Back returns to Local AI, and nothing but
// that one address is asked of anywhere off Local AI. The lab's own routes (/api/lab/*, kept until 6.7) are covered
// against a real server by tests/print-lab.test.cjs: sync, records and projects, and photos up and back.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const { spawnAppServer } = createRequire(import.meta.url)('./spawn-server.cjs');
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, e.message); } }

// The Mac key only pairs the test's browser as a device.
const KEY = 'print-lab-ui-key';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-lab-ui-'));
fs.writeFileSync(path.join(dataDir, 'claude-chat-mac-key.sha256'), crypto.createHash('sha256').update(KEY).digest('hex'));
const off = 'http://127.0.0.1:9';
const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, GRIDCRAFT_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, LOCALAI_WORKSHOP_URL: off, LOCALAI_PI_HUB_URL: 'off', LOCALAI_BAMBUDDY_URL: off, LOCALAI_MATERIALS_URL: 'off' } });
const base = await ready;

const browser = await chromium.launch();
const errors = [];

// Pair a device for phone tests
const pairRes = await fetch(`${base}/api/claude/chat/pair-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const { id: pairId, code } = await pairRes.json();
await fetch(`${base}/api/claude/chat/pair/approve`, {
  method: 'POST',
  headers: { 'X-LocalAI-Mac-Key': KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, name: 'Test Device' })
});
const statusRes = await fetch(`${base}/api/claude/chat/pair-status?id=${pairId}`);
const rawCookie = statusRes.headers.get('set-cookie') || '';
const [nameVal] = rawCookie.split(';');
const eqIdx = nameVal.indexOf('=');
const cookieName = nameVal.slice(0, eqIdx).trim();
const cookieVal = nameVal.slice(eqIdx + 1).trim();

// Platform step 6, PR 6.4: Local AI's Print lab tab sends the browser to Pi Hub's /lab, keeping e, p and do (the plan's
// acceptance: "#/printLab?e=E-025 lands on Pi Hub's URL with e"). Opened on 127.0.0.1, Local AI's address for the hub is
// the old one, http://10.0.0.30; the test answers it itself, so nothing leaves this machine.
const HUB_LAB = /^http:\/\/10\.0\.0\.30\/lab(\?|$)/;
async function urlBecomes(page, ok, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (ok(page.url())) return;
  throw new Error(`still at ${page.url()}`);
}
for (const [name, viewport] of [['iPhone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
  const context = await browser.newContext({ viewport, colorScheme: 'dark' });
  await context.addCookies([{ name: cookieName, value: cookieVal, url: base }]);
  // Everything that isn't Local AI is answered here and recorded, so a redirect anywhere else shows up (and never
  // reaches a real network).
  const hubHits = [];
  const origin = new URL(base).origin;
  await context.route(u => u.origin !== origin, r => {
    hubHits.push(r.request().url());
    return r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Pi Hub lab</title>' });
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));

  for (const [hash, want] of [
    ['#printLab', 'http://10.0.0.30/lab'],
    ['#/printLab?e=E-025', 'http://10.0.0.30/lab?e=E-025'],
    ['#printLab?p=hex-tile&e=E-023&do=judge', 'http://10.0.0.30/lab?p=hex-tile&e=E-023&do=judge'],
  ]) {
    await check(`${name}: ${hash} lands on Pi Hub's ${want.slice(17)}`, async () => {
      await page.goto(`${base}/${hash}`);
      await page.waitForURL(HUB_LAB, { timeout: 10000 });
      assert.equal(page.url(), want);
      assert.equal(await page.title(), 'Pi Hub lab', 'the stand-in hub answered, not a real one');
    });
  }

  await check(`${name}: going back doesn't bounce off the lab again`, async () => {
    await page.goto(`${base}/#home`);
    await page.waitForFunction(() => typeof window.showView === 'function');
    await page.evaluate(() => { location.hash = '#printLab'; });
    // From inside the app the redirect follows a same-document hash change, which Playwright's navigation waits report
    // as aborted; the address bar is what counts, so poll it.
    await urlBecomes(page, u => HUB_LAB.test(u));
    await page.goBack().catch(() => {});
    await urlBecomes(page, u => new URL(u).origin === new URL(base).origin);
    await page.waitForFunction(() => typeof window.showView === 'function');
    assert.notEqual(new URL(page.url()).hash, '#printLab', 'the replaced entry is gone, so Back is Local AI');
  });

  await check(`${name}: off Local AI, only Pi Hub's /lab was asked for`, async () => {
    assert.ok(hubHits.length > 0, 'the redirect reached the stand-in hub');
    assert.deepEqual(hubHits.filter(u => !HUB_LAB.test(u)), []);
  });
  await page.close();
  await context.close();
}

await check('no script errors', async () => assert.deepEqual(errors, []));

await browser.close();
const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
fs.rmSync(dataDir, { recursive: true, force: true });
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('print-lab-ui: all checks passed');
