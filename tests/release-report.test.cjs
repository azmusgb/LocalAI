// deploy/Send-LocalAI-ReleaseReport.ps1 (platform step 3: Pi Hub's release:localai): run under pwsh against a local
// stand-in for Pi Hub. Reports wait in the outbox until Pi Hub takes them, go oldest first, and the key is never printed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'Send-LocalAI-ReleaseReport.ps1');
const KEY = 'f'.repeat(64);
const A = 'a'.repeat(40), B = 'b'.repeat(40);
let pwsh = null;
try { execFileSync('pwsh', ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); pwsh = 'pwsh'; } catch {}

function hub(statuses) {
  const got = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      got.push({ url: req.url, key: req.headers['x-hub-deploy-key'], body: JSON.parse(data || '{}') });
      res.statusCode = statuses.length ? statuses.shift() : 200;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, url: `http://127.0.0.1:${server.address().port}` })));
}

function run(args, { dir, url, key = true }) {
  const keyFile = path.join(dir, 'pi-hub-deploy.key');
  if (key) fs.writeFileSync(keyFile, KEY + '\r\n'); else fs.rmSync(keyFile, { force: true });
  return new Promise((resolve) => execFile(pwsh, ['-NoProfile', '-File', SCRIPT, ...args, '-StateDir', dir, '-HubUrl', url, '-KeyFile', keyFile],
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr })));
}
const outbox = (dir) => { try { return [].concat(JSON.parse(fs.readFileSync(path.join(dir, 'release-outbox.json'), 'utf8').replace(/^\uFEFF/, ''))); } catch { return []; } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'release-report-'));

test('a queued report is sent with the key and leaves the outbox empty', { skip: !pwsh && 'needs pwsh' }, async () => {
  const dir = tmp(); const h = await hub([200]);
  try {
    const r = await run(['-Action', 'Queue', '-Commit', A, '-Result', 'deployed', '-Head', A, '-Message', 'ok'], { dir, url: h.url });
    assert.equal(r.code, 0, r.out);
    assert.equal(h.got.length, 1);
    assert.equal(h.got[0].url, '/api/releases/localai');
    assert.equal(h.got[0].key, KEY);
    const b = h.got[0].body;
    assert.deepEqual([b.commit, b.result, b.mechanism, b.head, b.message], [A, 'deployed', 'safe-deploy', A, 'ok']);
    assert.ok(!('target' in b));
    assert.match(b.at, /^\d{4}-\d\d-\d\dT.*(Z|[+-]\d\d:\d\d)$/);
    assert.deepEqual(outbox(dir), []);
    assert.ok(!r.out.includes(KEY), 'the key is never printed');
  } finally { h.server.close(); }
});

test('Pi Hub down: the report waits, and the next run sends the outbox oldest first', { skip: !pwsh && 'needs pwsh' }, async () => {
  const dir = tmp(); const h = await hub([503, 503]);
  try {
    await run(['-Action', 'Queue', '-Commit', A, '-Result', 'failed'], { dir, url: h.url });
    await run(['-Action', 'Queue', '-Commit', B, '-Result', 'deployed'], { dir, url: h.url });
    assert.deepEqual(outbox(dir).map((x) => x.commit), [A, B]);
    const r = await run(['-Action', 'Flush'], { dir, url: h.url });
    assert.match(r.out, /taken/);
    assert.deepEqual(h.got.slice(-2).map((g) => g.body.commit), [A, B]);
    assert.deepEqual(outbox(dir), []);
  } finally { h.server.close(); }
});

test('no key yet: reports wait and nothing is sent', { skip: !pwsh && 'needs pwsh' }, async () => {
  const dir = tmp(); const h = await hub([]);
  try {
    const r = await run(['-Action', 'Queue', '-Commit', A, '-Result', 'deployed'], { dir, url: h.url, key: false });
    assert.match(r.out, /no deploy key yet; 1 waiting/);
    assert.equal(h.got.length, 0);
    assert.equal(outbox(dir).length, 1);
  } finally { h.server.close(); }
});

test('a report Pi Hub refuses as invalid is dropped; the rest still go', { skip: !pwsh && 'needs pwsh' }, async () => {
  const dir = tmp(); const h = await hub([503, 400, 200]);
  try {
    await run(['-Action', 'Queue', '-Commit', A, '-Result', 'deployed'], { dir, url: h.url });
    const r = await run(['-Action', 'Queue', '-Commit', B, '-Result', 'rolled-back', '-Running', A], { dir, url: h.url });
    assert.match(r.out, /refused as invalid; dropped/);
    assert.equal(h.got.at(-1).body.running, A);
    assert.deepEqual(outbox(dir), []);
  } finally { h.server.close(); }
});

test('a bad commit is refused before it reaches the outbox, and the run still exits 0', { skip: !pwsh && 'needs pwsh' }, async () => {
  const dir = tmp(); const h = await hub([]);
  try {
    const r = await run(['-Action', 'Queue', '-Commit', 'nope', '-Result', 'deployed'], { dir, url: h.url });
    assert.equal(r.code, 0);
    assert.match(r.out, /needs a commit/);
    assert.deepEqual(outbox(dir), []);
  } finally { h.server.close(); }
});

test('Safe Deploy queues a report after each deploy and flushes the outbox every run', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'Run-LocalAI-AutoDeploy.ps1'), 'utf8');
  assert.match(src, /Send-ReleaseReport @\{ Action = 'Flush' \}/);
  assert.match(src, /Result = 'deployed'/);
  assert.match(src, /Get-FailedReport/);
  assert.ok(src.indexOf("Action = 'Flush'") < src.indexOf('$started = Get-Date'), 'the flush runs before any early exit');
});

test('Safe Deploy reports a healthy no-change run once after a failure at the running commit, so the hub record clears', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'Run-LocalAI-AutoDeploy.ps1'), 'utf8');
  const branch = src.slice(src.indexOf("elseif ($code -eq 0 -and $last -like 'NO CHANGE:*')"), src.indexOf('elseif ($code -ne 0)'));
  assert.match(branch, /Test-ApplianceHealthy/);
  assert.match(branch, /\$failed -eq \$short/);
  assert.match(branch, /Result = 'deployed'/);
  assert.match(branch, /Remove-Item \$failState/);
});
