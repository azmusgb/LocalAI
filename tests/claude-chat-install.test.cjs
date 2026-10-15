'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { makeTlsFixture, OPENSSL_MISSING } = require('./tls-fixture.cjs');

const INSTALL = path.resolve(__dirname, '../host/claude-chat/install.sh');
const CMD = '/opt/homebrew/bin/python3 -I ~/.claude/localai-chat/hook.py';
const CA_FETCH = 'windows-ai type C:\\LocalAI\\https\\localai-ca.crt';
const HASH_PUSH = 'windows-ai docker exec -i local-ai-appliance tee /data/claude-chat-mac-key.sha256';
// Never let a test reach the real appliance: the HTTPS probe goes to a closed local port unless a test sets its own.
const NO_HTTPS = 'https://127.0.0.1:9';

// An ssh stand-in: logs its arguments; the CA fetch (`type ...`) prints caFile (or fails if it does not exist), and
// anything else (the hash push) has its stdin saved to <log>.stdin.
function writeSshStub(stub, log, caFile) {
  fs.writeFileSync(stub, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  *" type "*) if [ -f "${caFile}" ]; then cat "${caFile}"; else echo "The system cannot find the file specified." >&2; exit 1; fi ;;
  *) cat > "${log}.stdin" ;;
esac
`, { mode: 0o755 });
}
function runInstall(home, stubs, env = {}) {
  return new Promise((resolve) => {
    const c = spawn('bash', [INSTALL], { env: { ...process.env, HOME: home, PATH: `${stubs}:${process.env.PATH}`, LOCALAI_HTTPS_URL: NO_HTTPS, ...env } });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const readConfig = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'localai-chat', 'config.json'), 'utf8'));

test('install.sh installs files, key, hash push, hooks and shell function, idempotently', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-install-'));
  try {
    const home = path.join(tmp, 'home'), stubs = path.join(tmp, 'stubs');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.mkdirSync(stubs);
    const other = { type: 'command', command: '/opt/homebrew/bin/python3 -I ~/.claude/hooks/localai-progress.py', async: true, timeout: 10 };
    const original = { statusLine: { type: 'command', command: 'x' }, hooks: { SessionStart: [{ hooks: [other] }], PostToolUse: [{ matcher: '*', hooks: [other] }] } };
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(original, null, 2));
    const log = path.join(tmp, 'ssh.log');
    writeSshStub(path.join(stubs, 'ssh'), log, path.join(tmp, 'no-ca.pem'));
    const run = () => spawnSync('bash', [INSTALL], { env: { ...process.env, HOME: home, PATH: `${stubs}:${process.env.PATH}`, LOCALAI_HTTPS_URL: NO_HTTPS }, encoding: 'utf8' });

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const dest = path.join(home, '.claude', 'localai-chat');
    for (const f of ['bridge.mjs', 'cli.mjs', 'hook.py', 'localai-chat']) assert.ok(fs.existsSync(path.join(dest, f)), f);
    assert.ok(fs.statSync(path.join(dest, 'localai-chat')).mode & 0o100);
    assert.ok(fs.statSync(path.join(dest, 'run')).isDirectory());
    assert.equal(fs.readlinkSync(path.join(home, '.local', 'bin', 'localai-chat')), path.join(dest, 'localai-chat'));
    const key = fs.readFileSync(path.join(dest, 'mac.key'), 'utf8');
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(path.join(dest, 'mac.key')).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(`${log}.stdin`, 'utf8'), crypto.createHash('sha256').update(key).digest('hex'));
    assert.equal(fs.readFileSync(log, 'utf8').trim(), `${HASH_PUSH}\n${CA_FETCH}`);
    assert.ok(fs.existsSync(path.join(dest, 'relay.mjs')));
    assert.match(first.stdout, /source ~\/\.zshrc/); assert.match(first.stdout, /localai-chat status/); assert.match(first.stdout, /claude-chat --resume/);

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(path.join(dest, 'mac.key'), 'utf8'), key);

    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.statusLine, original.statusLine);
    assert.deepEqual(settings.hooks.PostToolUse, original.hooks.PostToolUse);
    assert.deepEqual(settings.hooks.SessionStart[0], original.hooks.SessionStart[0]);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const ours = settings.hooks[event].flatMap(g => g.hooks).filter(h => h.command === CMD);
      assert.equal(ours.length, 1, event);
      assert.equal(ours[0].async, true); assert.equal(ours[0].timeout, 10);
    }
    assert.equal(settings.hooks.SessionStart.length, 2);
    const backups = fs.readdirSync(path.join(home, '.claude')).filter(n => n.startsWith('settings.json.bak-localai-chat-'));
    assert.ok(backups.length >= 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude', backups.sort()[0]), 'utf8')), original);
    const zshrc = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    assert.equal(zshrc.split('# >>> localai-chat >>>').length - 1, 1);
    assert.match(zshrc, /claude-chat\(\) \{ LOCALAI_CHAT=1 claude "\$@"; \}/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('install.sh reports a failed hash push, keeps the key, leaves settings alone, and a re-run completes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-install-fail-'));
  try {
    const home = path.join(tmp, 'home'), stubs = path.join(tmp, 'stubs');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(stubs);
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const before = JSON.stringify({ hooks: {} }, null, 2);
    fs.writeFileSync(settingsPath, before);
    const log = path.join(tmp, 'ssh.log');
    const stub = path.join(stubs, 'ssh');
    fs.writeFileSync(stub, '#!/bin/sh\ncat > /dev/null\nexit 255\n', { mode: 0o755 });
    const run = () => spawnSync('bash', [INSTALL], { env: { ...process.env, HOME: home, PATH: `${stubs}:${process.env.PATH}`, LOCALAI_HTTPS_URL: NO_HTTPS }, encoding: 'utf8' });
    const keyPath = path.join(home, '.claude', 'localai-chat', 'mac.key');

    const failed = run();
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /install\.sh: created .*mac\.key but could not push its hash to the appliance \(ssh windows-ai failed\)\. Fix ssh access and re-run install\.sh/);
    const key = fs.readFileSync(keyPath, 'utf8');
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), before);

    writeSshStub(stub, log, path.join(tmp, 'no-ca.pem'));
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(fs.readFileSync(keyPath, 'utf8'), key);
    assert.equal(fs.readFileSync(`${log}.stdin`, 'utf8'), crypto.createHash('sha256').update(key).digest('hex'));
    assert.ok(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.Stop);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---- HTTPS: the CA comes over ssh (authenticated), is checked, and the relay is probed with it -----------------------
function sandbox(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-install-tls-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home'), stubs = path.join(tmp, 'stubs');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(stubs);
  const log = path.join(tmp, 'ssh.log'), caOut = path.join(tmp, 'ca-out.pem');
  writeSshStub(path.join(stubs, 'ssh'), log, caOut);
  return { tmp, home, stubs, log, caOut, dest: path.join(home, '.claude', 'localai-chat') };
}
async function httpsRelay(t, tls) {
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    res.writeHead(req.url === '/healthz' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `https://127.0.0.1:${server.address().port}`;
}
const tls = makeTlsFixture();
const tlsSkip = tls ? false : OPENSSL_MISSING;
test.after(() => tls?.cleanup());

test('install.sh fetches the CA over ssh, verifies HTTPS with it, and writes config.json', { skip: tlsSkip }, async (t) => {
  const s = sandbox(t);
  const url = await httpsRelay(t, tls);
  fs.writeFileSync(s.caOut, tls.caPem.replace(/\n/g, '\r\n')); // Windows `type` output has CRLF line endings
  const r = await runInstall(s.home, s.stubs, { LOCALAI_HTTPS_URL: url });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.readFileSync(s.log, 'utf8').split('\n').includes(CA_FETCH), 'the CA comes over ssh');
  const caPath = path.join(s.dest, 'localai-ca.crt');
  assert.equal(fs.readFileSync(caPath, 'utf8'), tls.caPem);
  assert.deepEqual(readConfig(s.home), { url, ca: caPath });
  assert.doesNotMatch(r.stderr, /warning/i);
  assert.match(r.stdout, new RegExp(`Relay: ${url.replace(/[.]/g, '\\.')} \\(HTTPS, verified with the LocalAI CA\\)`));
});

test('install.sh keeps plain HTTP, with a warning, when HTTPS is unreachable or not trusted with the CA', { skip: tlsSkip }, async (t) => {
  const url = await httpsRelay(t, tls);
  for (const [name, env, pem] of [['unreachable', {}, tls.caPem], ['wrong CA', { LOCALAI_HTTPS_URL: url }, fs.readFileSync(tls.otherCaPath, 'utf8')]]) {
    const s = sandbox(t);
    fs.writeFileSync(s.caOut, pem);
    const r = await runInstall(s.home, s.stubs, env);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /install\.sh: warning: HTTPS at https:\/\/127\.0\.0\.1:\d+ is not reachable or not trusted with the LocalAI CA; using plain HTTP \(http:\/\/10\.0\.0\.21:3080\)/, name);
    const caPath = path.join(s.dest, 'localai-ca.crt');
    assert.deepEqual(readConfig(s.home), { url: 'http://10.0.0.21:3080', ca: caPath }, name);
  }
});

test('install.sh rejects a CA that is not a PEM certificate, or that ssh cannot fetch, and keeps plain HTTP', { skip: tlsSkip }, async (t) => {
  const url = await httpsRelay(t, tls);
  for (const [name, content] of [['garbage', 'The system cannot find the path specified.\r\n'], ['missing', null]]) {
    const s = sandbox(t);
    if (content !== null) fs.writeFileSync(s.caOut, content);
    const r = await runInstall(s.home, s.stubs, { LOCALAI_HTTPS_URL: url });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /install\.sh: warning: could not get a valid LocalAI CA certificate over ssh/, name);
    assert.match(r.stderr, /using plain HTTP \(http:\/\/10\.0\.0\.21:3080\)/, name);
    assert.equal(fs.existsSync(path.join(s.dest, 'localai-ca.crt')), false, name);
    assert.deepEqual(readConfig(s.home), { url: 'http://10.0.0.21:3080' }, name);
  }
});

test('install.sh re-run replaces a stale CA and switches an http config to HTTPS', { skip: tlsSkip }, async (t) => {
  const s = sandbox(t);
  const url = await httpsRelay(t, tls);
  fs.writeFileSync(s.caOut, 'not a cert');
  assert.equal((await runInstall(s.home, s.stubs, { LOCALAI_HTTPS_URL: url })).status, 0);
  assert.equal(readConfig(s.home).url, 'http://10.0.0.21:3080');
  fs.writeFileSync(s.caOut, tls.caPem);
  const r = await runInstall(s.home, s.stubs, { LOCALAI_HTTPS_URL: url });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readConfig(s.home), { url, ca: path.join(s.dest, 'localai-ca.crt') });
});
