'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const INSTALL = path.resolve(__dirname, '../host/claude-chat/install.sh');
const CMD = '/opt/homebrew/bin/python3 -I ~/.claude/localai-chat/hook.py';

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
    fs.writeFileSync(path.join(stubs, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncat > "${log}.stdin"\n`, { mode: 0o755 });
    const run = () => spawnSync('bash', [INSTALL], { env: { ...process.env, HOME: home, PATH: `${stubs}:${process.env.PATH}` }, encoding: 'utf8' });

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
    assert.equal(fs.readFileSync(log, 'utf8').trim(), 'windows-ai docker exec -i local-ai-appliance tee /data/claude-chat-mac-key.sha256');
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
