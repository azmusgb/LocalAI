import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// Starts its own appliance because it has to hold the Mac key (to approve pairing and play the Mac side).
const here = path.dirname(fileURLToPath(import.meta.url));
const MAC_KEY = crypto.randomBytes(32).toString('hex');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-chat-ui-'));
fs.writeFileSync(path.join(dataDir, 'claude-chat-mac-key.sha256'), crypto.createHash('sha256').update(MAC_KEY).digest('hex'));
const probe = http.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`;
const off = 'http://127.0.0.1:9';
const server = spawn(process.execPath, [path.resolve(here, '../app/server.js')], {
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), WORKSPACE_ROOT: dataDir, LOCALAI_CHAT_ONLINE_MS: '4000', OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off }
});
let diagnostics = '';
server.stdout.on('data', c => diagnostics += c);
server.stderr.on('data', c => diagnostics += c);
for (let i = 0; ; i++) {
  if (server.exitCode !== null) throw new Error(diagnostics);
  try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
  if (i > 100) throw new Error(`Server did not start: ${diagnostics}`);
  await new Promise(r => setTimeout(r, 100));
}

const mac = async (method, route, body) => {
  const r = await fetch(`${base}/api/claude/chat/${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-LocalAI-Mac-Key': MAC_KEY }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// A session stays "online" only while the Mac keeps announcing it (the test shortens the window to 4 s).
const beats = new Map();
const announce = (id, title) => mac('POST', 'announce', { sessionId: id, title, cwd: '/Users/me/project' });
const heartbeat = async (id, title) => { await announce(id, title); beats.set(id, setInterval(() => announce(id, title), 1000)); };
const stopBeat = id => { clearInterval(beats.get(id)); beats.delete(id); };
// What the bridge does: claim (the relay leases the messages as "delivering"), then acknowledge them ("delivered").
const ack = (id, items) => mac('POST', 'inbox/ack', { sessionId: id, ids: items.map(m => m.id) });
const pickup = async id => { const r = await mac('GET', `inbox?sessionId=${id}&wait=0`); await ack(id, r.body.items); return r; };

const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}
async function finish() {
  for (const id of [...beats.keys()]) stopBeat(id);
  await browser.close().catch(() => {});
  if (server.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGTERM'); await done; }
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ux-primary-rail');
  await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.showView('claude'));
  await page.waitForSelector('#claude.active');
  await heartbeat('sess-a', 'Fix the login bug');

  let code = '';
  await check('unpaired: shows the code, the exact command "localai-chat pair <code>" and the plain-HTTP warning', async () => {
    await page.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.getElementById('claudeChatCode')?.textContent.trim() || ''), null, { timeout: 8000 });
    code = (await page.locator('#claudeChatCode').innerText()).trim();
    assert.equal(await page.locator('#claudeChatPair').isVisible(), true);
    assert.equal(await page.locator('#claudeChatPair code').filter({ hasText: `localai-chat pair ${code}` }).count(), 1);
    assert.match(await page.locator('#claudeChatPair').innerText(), /served over plain HTTP, so the pairing cookie crosses your Wi-Fi unencrypted until HTTPS is set up/);
    assert.equal(await page.locator('#claudeChatSession').isVisible(), false);
  });

  await check('approval switches the panel to the session picker without a reload', async () => {
    await page.evaluate(() => { window.__noReload = 1; });
    const approved = await mac('POST', 'pair/approve', { code, name: 'Test phone' });
    assert.equal(approved.status, 200);
    await page.waitForSelector('#claudeChatSession', { state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => [...document.querySelectorAll('#claudeChatSession option')].some(o => o.value === 'sess-a'), null, { timeout: 12000 });
    assert.equal(await page.evaluate(() => window.__noReload), 1);
    assert.equal(await page.locator('#claudeChatPair').isVisible(), false);
    await page.selectOption('#claudeChatSession', 'sess-a');
  });

  await check('the composer shows the note that web messages arrive as messages from another session', async () => {
    assert.match(await page.locator('#claudeChat').innerText(), /Web messages reach Claude as messages from another session: it acts within this session's permissions, but won't change its settings or approve prompts because of them\./);
  });

  await check('send shows queued, then sending while the bridge holds the lease, delivered after its ack, then the mirrored reply with answered', async () => {
    assert.equal(await page.locator('#claudeChatSend').isDisabled(), true, 'empty composer disables Send');
    await page.fill('#claudeChatInput', 'Run the tests');
    await page.press('#claudeChatInput', 'Control+Enter');
    const msg = page.locator('#claudeChatLog .claude-chat-msg.web', { hasText: 'Run the tests' });
    await msg.waitFor({ timeout: 5000 });
    await page.waitForFunction(() => /queued/.test(document.querySelector('#claudeChatLog .claude-chat-msg.web .claude-chat-status')?.textContent || ''), null, { timeout: 5000 });
    assert.equal(await page.inputValue('#claudeChatInput'), '', 'composer is cleared after sending');
    const inbox = await mac('GET', 'inbox?sessionId=sess-a&wait=0');
    assert.equal(inbox.body.items.length, 1);
    await page.waitForFunction(() => /^sending$/.test(document.querySelector('#claudeChatLog .claude-chat-msg.web .claude-chat-status')?.textContent || ''), null, { timeout: 8000 });
    assert.equal(await page.locator('#claudeChatLog .claude-chat-msg.web').getByRole('button', { name: 'Delete' }).count(), 0, 'a message being sent cannot be deleted');
    assert.deepEqual((await ack('sess-a', inbox.body.items)).body.acked, [inbox.body.items[0].id]);
    await page.waitForFunction(() => /delivered/.test(document.querySelector('#claudeChatLog .claude-chat-msg.web .claude-chat-status')?.textContent || ''), null, { timeout: 8000 });
    await mac('POST', 'mirror', { sessionId: 'sess-a', role: 'assistant', source: 'reply', text: 'All 12 tests pass.' });
    await page.locator('#claudeChatLog .claude-chat-msg.reply', { hasText: 'All 12 tests pass.' }).waitFor({ timeout: 8000 });
    await page.waitForFunction(() => /answered/.test(document.querySelector('#claudeChatLog .claude-chat-msg.web .claude-chat-status')?.textContent || ''), null, { timeout: 8000 });
  });

  await check('terminal prompts and web messages carry different labels', async () => {
    await mac('POST', 'mirror', { sessionId: 'sess-a', role: 'user', source: 'terminal', text: 'typed in the terminal' });
    await page.locator('#claudeChatLog .claude-chat-msg.terminal', { hasText: 'typed in the terminal' }).waitFor({ timeout: 8000 });
    const label = c => page.locator(`#claudeChatLog .claude-chat-msg.${c} .claude-chat-who`).first().innerText();
    assert.equal(await label('terminal'), 'Terminal');
    assert.equal(await label('web'), 'Web · Test phone');
    assert.equal(await label('reply'), 'Claude');
  });

  await check('HTML in a reply renders literally', async () => {
    const html = '<b>x</b><img src=x onerror="window.__x=1">';
    await mac('POST', 'mirror', { sessionId: 'sess-a', role: 'assistant', source: 'reply', text: html });
    await page.locator('#claudeChatLog .claude-chat-msg.reply', { hasText: '<b>x</b>' }).waitFor({ timeout: 8000 });
    assert.match(await page.locator('#claudeChatLog').innerText(), /<b>x<\/b><img src=x onerror="window\.__x=1">/);
    assert.equal(await page.evaluate(() => typeof window.__x), 'undefined');
    assert.equal(await page.locator('#claudeChatLog img, #claudeChatLog b').count(), 0);
  });

  await check('an unanswered message is polled with one small request, never a full refetch', async () => {
    const urls = [];
    const onReq = r => { if (/\/api\/claude\/chat\/messages\?/.test(r.url())) urls.push(r.url()); };
    await page.fill('#claudeChatInput', 'Still thinking?');
    await page.press('#claudeChatInput', 'Control+Enter');
    await page.locator('#claudeChatLog .claude-chat-msg.web', { hasText: 'Still thinking?' }).waitFor({ timeout: 5000 });
    await pickup('sess-a');
    await page.waitForFunction(() => [...document.querySelectorAll('#claudeChatLog .claude-chat-msg.web')].some(m => /Still thinking/.test(m.textContent) && /delivered/.test(m.textContent)), null, { timeout: 8000 });
    page.on('request', onReq);
    await page.waitForTimeout(5000);
    page.off('request', onReq);
    assert.ok(urls.length >= 1 && urls.length <= 3, `${urls.length} message requests in 5 s: ${urls.join(' ')}`);
    assert.ok(!urls.some(u => /after=0(&|$)/.test(u)), `full refetch: ${urls.join(' ')}`);
    await mac('POST', 'mirror', { sessionId: 'sess-a', role: 'assistant', source: 'reply', text: 'Done thinking.' });
    await page.waitForFunction(() => [...document.querySelectorAll('#claudeChatLog .claude-chat-msg.web')].every(m => /answered/.test(m.textContent)), null, { timeout: 8000 });
  });

  await check('a delivered message older than 10 minutes no longer widens the poll window', async () => {
    await page.fill('#claudeChatInput', 'Never answered');
    await page.press('#claudeChatInput', 'Control+Enter');
    await page.locator('#claudeChatLog .claude-chat-msg.web', { hasText: 'Never answered' }).waitFor({ timeout: 5000 });
    const picked = await pickup('sess-a');
    const latest = picked.body.items[0].seq;
    await mac('POST', 'mirror', { sessionId: 'sess-a', role: 'user', source: 'terminal', text: 'later terminal line' });
    await page.locator('#claudeChatLog .claude-chat-msg.terminal', { hasText: 'later terminal line' }).waitFor({ timeout: 8000 });
    // Move the page clock 11 minutes ahead: the delivered message is now stale.
    await page.evaluate(() => { window.__realNow = Date.now; const skew = 11 * 60 * 1000; Date.now = () => window.__realNow() + skew; });
    const urls = [];
    const onReq = r => { if (/\/api\/claude\/chat\/messages\?/.test(r.url())) urls.push(r.url()); };
    await page.waitForTimeout(2500);
    page.on('request', onReq);
    await page.waitForTimeout(5000);
    page.off('request', onReq);
    // Reload so no timestamp taken under the shifted clock lingers in the panel state.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.showView === 'function');
    await page.evaluate(() => window.showView('claude'));
    await page.waitForSelector('#claudeChatInput', { state: 'visible', timeout: 12000 });
    assert.ok(urls.length >= 1, 'no message polls');
    const afters = urls.map(u => Number(new URL(u).searchParams.get('after')));
    assert.ok(afters.every(a => a === latest + 1), `poll window widened by a stale delivered message: after=${afters.join(',')} (latest seq ${latest + 1})`);
    await mac('POST', 'mirror', { sessionId: 'sess-a', role: 'assistant', source: 'reply', text: 'Finally.' });
    await page.waitForFunction(() => [...document.querySelectorAll('#claudeChatLog .claude-chat-msg.web')].every(m => /answered/.test(m.textContent)), null, { timeout: 8000 });
  });

  await heartbeat('sess-b', 'Refactor billing');
  await check('offline session disables the composer with the claude-chat hint', async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('#claudeChatSession option')].some(o => o.value === 'sess-b'), null, { timeout: 12000 });
    await page.selectOption('#claudeChatSession', 'sess-b');
    await page.fill('#claudeChatInput', 'Please look at invoices');
    await page.press('#claudeChatInput', 'Control+Enter');
    await page.locator('#claudeChatLog .claude-chat-msg.web', { hasText: 'Please look at invoices' }).waitFor({ timeout: 5000 });
    stopBeat('sess-b');
    await page.waitForFunction(() => document.getElementById('claudeChatSend').disabled && /This session is offline\. Start or resume it on your Mac with `?claude-chat`?\./.test(document.getElementById('claudeChat').innerText), null, { timeout: 25000 });
    assert.equal(await page.locator('#claudeChatInput').isDisabled(), true);
  });

  await check('a message still queued when its session goes offline shows "not delivered" and a Delete button that removes it', async () => {
    const msg = page.locator('#claudeChatLog .claude-chat-msg.web', { hasText: 'Please look at invoices' });
    assert.match(await msg.locator('.claude-chat-status').innerText(), /not delivered/);
    await msg.getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction(() => !/Please look at invoices/.test(document.getElementById('claudeChatLog').innerText), null, { timeout: 6000 });
  });

  await check('phone: composer and Send clear the tab bar; no sideways scroll; touch targets and text are large enough', async () => {
    await page.selectOption('#claudeChatSession', 'sess-a');
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const cookies = await context.cookies();
    await phone.addCookies(cookies);
    const p = await phone.newPage();
    await p.addInitScript(() => localStorage.setItem('localai.claudeChat.session', 'sess-a'));
    await p.goto(base, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#uxMobileNav');
    await p.waitForFunction(() => typeof window.showView === 'function');
    await p.evaluate(() => window.showView('claude'));
    await p.waitForSelector('#claudeChatInput', { state: 'visible', timeout: 12000 });
    await p.waitForFunction(() => document.querySelectorAll('#claudeChatLog .claude-chat-msg').length >= 3, null, { timeout: 8000 });
    // The panel is the first block under the page header, so on a phone it is what you see first.
    const first = await p.evaluate(() => { const n = document.querySelector('#claude > .topbar').nextElementSibling; const b = n.getBoundingClientRect(); return { id: n.id, top: b.top, h: b.height }; });
    assert.equal(first.id, 'claudeChat');
    assert.ok(first.top < 844 && first.h > 100, JSON.stringify(first));
    // Scroll each control to the bottom edge of the screen (what focusing it does) and make sure it is not under the tab bar.
    const clear = async id => {
      await p.evaluate(i => document.getElementById(i).scrollIntoView({ block: 'end' }), id);
      await p.waitForTimeout(150);
      return p.evaluate(i => {
        const e = document.getElementById(i), b = e.getBoundingClientRect(), nav = document.querySelector('#uxMobileNav').getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return { id: i, bottom: b.bottom, nav: nav.top, hit: !!hit && (hit === e || e.contains(hit)), h: b.height, font: parseFloat(getComputedStyle(e).fontSize),
          sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
      }, id);
    };
    const input = await clear('claudeChatInput');
    const sendBtn = await clear('claudeChatSend');
    for (const m of [input, sendBtn]) {
      assert.ok(m.hit, `${m.id} is covered: ${JSON.stringify(m)}`);
      assert.ok(m.bottom <= m.nav + 0.5, `${m.id} sits under the tab bar: ${JSON.stringify(m)}`);
      assert.ok(m.h >= 44, `${m.id} height ${m.h}`);
      assert.ok(m.sw <= m.cw + 1, `scrollWidth ${m.sw} > ${m.cw}`);
    }
    assert.ok(input.font >= 16, `textarea font ${input.font}`);
    assert.ok((await p.evaluate(() => document.getElementById('claudeChatSession').getBoundingClientRect().height)) >= 44);
    await p.evaluate(() => document.getElementById('claudeChat').scrollIntoView({ block: 'start' }));
    await p.waitForTimeout(150);
    const dir = process.env.CLAUDE_CHAT_SHOTS;
    if (dir) {
      await p.screenshot({ path: path.join(dir, 'task-6-phone-390x844.png') });
      await page.locator('#claudeChat').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(dir, 'task-6-desktop-1440x900.png') });
    }
    await phone.close();
  });

  await check('revoking this device returns to the pairing screen', async () => {
    await page.locator('#claudeChatDevices summary').click();
    const row = page.locator('#claudeChatDevices .claude-chat-device', { hasText: 'Test phone' });
    await row.waitFor({ timeout: 5000 });
    await row.getByRole('button', { name: /Revoke/ }).click();
    await page.waitForSelector('#claudeChatPair', { state: 'visible', timeout: 8000 });
    await page.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.getElementById('claudeChatCode')?.textContent.trim() || ''), null, { timeout: 8000 });
    assert.equal(await page.locator('#claudeChatSession').isVisible(), false);
  });

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
} catch (error) {
  failures.push(error.message);
  console.error('FAIL', error.message);
} finally {
  await finish();
}
