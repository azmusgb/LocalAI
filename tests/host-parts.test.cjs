'use strict';
// deploy/host-parts.json lists the Windows host's long-running parts so a deploy can tell which one runs older code
// (#450). A server added to the repo root or host/ without an entry there would quietly keep running old code after
// every release, so this fails until it is listed (or the server is added to NOT_PARTS with its reason).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { parts } = JSON.parse(fs.readFileSync(path.join(root, 'deploy', 'host-parts.json'), 'utf8'));
// A file that serves until it is stopped: Python's HTTP servers and PowerShell's HttpListener.
const SERVES = /\bserve_forever\(|\b(?:Threading)?HTTPServer\(|\bHttpListener\b/;
// Servers that aren't a host part, with why. Empty today.
const NOT_PARTS = {};

function candidates() {
  const files = fs.readdirSync(root).filter((name) => /\.(py|ps1)$/.test(name));
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return ['.venv', 'node_modules', '__pycache__'].includes(entry.name) ? [] : walk(rel);
    return /\.(py|ps1)$/.test(entry.name) ? [rel] : [];
  });
  return [...files, ...walk('host')];
}

test('every server in the repo root or host/ is a listed host part', () => {
  const listed = new Set(parts.flatMap((part) => part.paths || []));
  const servers = candidates().filter((file) => SERVES.test(fs.readFileSync(path.join(root, file), 'utf8')));
  assert.ok(servers.length >= 2, `expected Atlas and the GridCraft bridge, found ${servers.join(', ')}`);
  const missing = servers.filter((file) => !listed.has(file) && !NOT_PARTS[file]);
  assert.deepEqual(missing, [], 'add these to deploy/host-parts.json (or NOT_PARTS, with the reason)');
});

test('each host part names files that exist, and ids are unique', () => {
  const ids = parts.map((part) => part.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(', ')}`);
  for (const part of parts) {
    assert.ok(['compose-service', 'scheduled-task', 'self-reloading'].includes(part.kind), `${part.id}: kind ${part.kind}`);
    for (const file of [...(part.paths || []), ...(part.compose ? [part.compose] : [])]) {
      assert.ok(fs.existsSync(path.join(root, file)), `${part.id}: ${file} does not exist`);
    }
    if (part.kind === 'compose-service') {
      const compose = fs.readFileSync(path.join(root, part.compose), 'utf8');
      assert.match(compose, new RegExp(`container_name:\\s*${part.container}\\b`), `${part.id}: ${part.container} not in ${part.compose}`);
    }
  }
});
