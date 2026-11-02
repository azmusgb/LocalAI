'use strict';

// Questions about Local AI itself get the "About this appliance" facts in the chat's system context; others don't.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { isAboutLocalAi, aboutApplianceBlock } = require('../app/about-appliance');
const { spawnAppServer } = require('./spawn-server.cjs');

const ADDRESSES = [{ label: 'Home Wi-Fi', url: 'https://10.0.0.21' }, { label: 'Anywhere (Tailscale)', url: 'https://pc.tail1234.ts.net' }];

test('the block is short, factual and uses the live addresses and view-registry labels', () => {
  const block = aboutApplianceBlock({ addresses: ADDRESSES });
  assert.ok(block.length <= 1500, `block is ${block.length} characters`);
  assert.match(block, /ComfyUI/);
  assert.match(block, /diffusion_models/);
  assert.match(block, /text_encoders/);
  assert.match(block, /\bvae\b/);
  assert.match(block, /https:\/\/10\.0\.0\.21/);
  assert.match(block, /https:\/\/pc\.tail1234\.ts\.net/);
  assert.match(block, /one icon that works everywhere/i);
  assert.match(block, /45 minutes/);
  assert.match(block, /Spreadsheets in Work/);
  assert.match(block, /Automations in Work/);
  assert.match(block, /Services in System/);
  const none = aboutApplianceBlock({ addresses: [] });
  assert.match(none, /Tailscale is not set up/);
  assert.doesNotMatch(none, /one icon/i, 'no Home Screen advice without a Tailscale address');
});

test('only questions about Local AI itself are recognised', () => {
  for (const q of ['where do I put a .safetensors model?', 'how do I reach Local AI away from home?', 'Where is the Spreadsheets page?', 'how do I install an image model?', 'is ComfyUI running?'])
    assert.ok(isAboutLocalAi(q), q);
  for (const q of ['what is the capital of France?', 'write a poem about autumn', 'summarize this email', 'fix my python script', ''])
    assert.ok(!isAboutLocalAi(q), q);
});

test('the chat sends the block only with a question about Local AI', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-about-'));
  const chats = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
      if (req.url === '/api/chat') chats.push(JSON.parse(body));
      res.end(JSON.stringify({ message: { content: 'ok' } }));
    });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: `http://127.0.0.1:${mock.address().port}`, MODEL: 'test-model',
      LOCALAI_HOST_IP: '10.0.0.21', LOCALAI_REMOTE_NAME: 'pc.tail1234.ts.net',
      COMFY_URL: off, N8N_URL: off, PROXY_URL: off, SEARXNG_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off }
  });
  t.after(async () => {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    mock.closeAllConnections(); await new Promise(r => mock.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const system = async question => {
    const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: question }] }) });
    assert.equal(r.status, 200, question);
    return chats.at(-1).messages.find(m => m.role === 'system').content;
  };

  const safetensors = await system('where do I put a .safetensors model?');
  assert.match(safetensors, /ABOUT THIS APPLIANCE/);
  assert.match(safetensors, /z_image_turbo_bf16\.safetensors in diffusion_models/);
  assert.match(safetensors, /text_encoders/);

  const away = await system('how do I reach Local AI away from home?');
  assert.match(away, /Tailscale https:\/\/pc\.tail1234\.ts\.net/);
  assert.match(away, /home Wi-Fi https:\/\/10\.0\.0\.21/);

  const unrelated = await system('what is the capital of France?');
  assert.doesNotMatch(unrelated, /ABOUT THIS APPLIANCE/);
  assert.match(unrelated, /RUNTIME CAPABILITY SNAPSHOT/, 'the snapshot itself is unchanged');
});
