'use strict';

// Starts app/server.js with PORT=0 and resolves with its base URL once it is listening.
// Why not pick a free port first and pass it in: between closing the probe socket and the server binding, another
// test can be given the same port on 127.0.0.1. On macOS the server's 0.0.0.0 bind still succeeds, but requests to
// 127.0.0.1:<port> reach the other listener, so /healthz answers 404 (or another appliance answers) and the test
// fails with "server did not start" or wrong data. With PORT=0 the system hands the server a port no one holds, and
// the server prints it ("listening on 0.0.0.0:<port>"). A server that exits before listening fails at once with its
// last output instead of after a polling timeout.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const APP = path.resolve(__dirname, '../app');
// Test servers must never reach the owner's real Workshop display (the app's default LOCALAI_WORKSHOP_URL). Port 9
// (discard) on loopback refuses at once, so the Workshop card simply reads as offline. Household clients and camera
// probes default to off as well, and so does the owner-fact suggestion job (it would ask the fake model after each chat). Synthetic stand-ins passed in env explicitly override these test defaults.
const SAFE_WORKSHOP_URL = 'http://127.0.0.1:9';

function spawnAppServer({ appDir = APP, env = {}, timeoutMs = 15000 } = {}) {
  const child = spawn(process.execPath, [path.join(appDir, 'server.js')], {
    env: { ...process.env, LOCALAI_PI_HUB_URL: 'off', LOCALAI_MATERIALS_URL: 'off', LOCALAI_BAMBUDDY_URL: 'off', LOCALAI_WORKSHOP_CAMERA_PROBES: 'off', LOCALAI_FACT_SUGGESTIONS: 'off', LOCALAI_WORKSHOP_URL: process.env.LOCALAI_WORKSHOP_URL || SAFE_WORKSHOP_URL, ...env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  const keep = b => { out = (out + b).slice(-4000); };
  child.stderr.on('data', keep);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start within ${timeoutMs} ms:\n${out}`)), timeoutMs);
    const onData = b => {
      keep(b);
      const m = out.match(/listening on 0\.0\.0\.0:(\d+)/);
      if (m) { clearTimeout(timer); child.removeListener('exit', onExit); resolve(`http://127.0.0.1:${m[1]}`); }
    };
    const onExit = (code, signal) => { clearTimeout(timer); reject(new Error(`server exited (${signal || code}) before listening:\n${out}`)); };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
  // Keep draining output after start-up so a chatty server never blocks on a full pipe.
  ready.then(() => { child.stdout.removeAllListeners('data'); child.stdout.on('data', keep); }, () => child.kill());
  return { child, ready };
}

// Shared test teardown: kill a spawned child and wait for it to exit; remove a temp dir (win32 retries file locks).
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  await new Promise((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener('exit', finish);
      reject(new Error(`child ${child.pid || 'unknown'} did not exit after kill()`));
    }, 5000);
    timer.unref?.();

    child.once('exit', finish);

    try {
      if (!child.kill()) finish();
    } catch (error) {
      child.removeListener('exit', finish);
      clearTimeout(timer);
      reject(error);
    }
  });
}

function removeTree(dir) {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    ...(process.platform === 'win32'
      ? { maxRetries: 5, retryDelay: 50 }
      : {}),
  });
}

module.exports = { spawnAppServer, stopChild, removeTree, SAFE_WORKSHOP_URL };
