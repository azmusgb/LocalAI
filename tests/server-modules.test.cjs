'use strict';

// The server split (docs/superpowers/specs/2026-10-18-server-split-design.md): every module in app/server/ loads on
// its own and gives server.js each name it takes from it. A name server.js uses but a module stopped providing would
// otherwise only fail when that route runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = path.resolve(__dirname, '../app');
const server = fs.readFileSync(path.join(app, 'server.js'), 'utf8');

// `const { a, b } = require('./server/x')…` lines in server.js: what each module must provide.
function takenFrom(file) {
  const re = new RegExp(String.raw`const \{([^}]+)\} = require\('\./server/${file}'\)`, 'g');
  return [...server.matchAll(re)].flatMap(m => m[1].split(',').map(x => x.trim()).filter(Boolean));
}

test('app/server/http.js gives server.js every helper it takes', () => {
  const http = require('../app/server/http');
  for (const name of takenFrom('http')) assert.equal(typeof http[name], 'function', name);
  assert.ok(takenFrom('http').includes('json'));
});

test('app/server/stores.js reads, writes and caps collections through the storage it is given', () => {
  const calls = [];
  const storage = {
    readSetting: (k, f) => (calls.push(['readSetting', k]), f),
    list: c => (calls.push(['list', c]), []),
    writeSetting: k => calls.push(['writeSetting', k]),
    save: c => calls.push(['save', c]),
    prepend: (c, item, keep) => calls.push(['prepend', c, keep])
  };
  const stores = require('../app/server/stores').createStores({ storage, STATUS_STORE: 'status' });
  assert.ok(takenFrom('stores').includes('readState'));
  for (const name of takenFrom('stores')) assert.ok(name in stores, name);
  stores.readState('status', {}); stores.readState('library', []);
  stores.writeState('status', {}); stores.writeState('library', []);
  stores.prependRecord('activity', {}); stores.prependRecord('library', {});
  assert.deepEqual(calls, [['readSetting', 'status'], ['list', 'library'], ['writeSetting', 'status'], ['save', 'library'], ['prepend', 'activity', 2000], ['prepend', 'library', undefined]]);
});

// Every area module (create<Area>(ctx)): server.js passes exactly the names the module unpacks from ctx, and the factory
// returns every name server.js takes from it.
const calls = [...server.matchAll(/^const \{([^}]+)\} = require\('\.\/server\/([\w-]+)'\)\.(create\w+)\(\{([^}]*)\}\);$/gm)]
  .map(m => ({ file: m[2], factory: m[3], takes: m[1].split(',').map(x => x.trim()), gives: m[4].split(',').map(x => x.trim()).filter(Boolean) }));
const list = xs => [...xs].sort();

test('server.js builds its area modules with create<Area>({...})', () => {
  assert.ok(calls.length >= 1, 'no area modules found');
});

for (const c of calls) {
  test(`app/server/${c.file}.js: ${c.factory} gets what it unpacks and returns what server.js takes`, () => {
    const mod = require(`../app/server/${c.file}`);
    const source = fs.readFileSync(path.join(app, 'server', `${c.file}.js`), 'utf8');
    const unpack = source.match(/^ {2}const \{([^}]*)\} = ctx;$/m);
    if (unpack) assert.deepEqual(list(c.gives), list(unpack[1].split(',').map(x => x.trim()).filter(Boolean)), 'ctx passed by server.js vs unpacked by the module');
    // Any input is a harmless stand-in: the factory only defines things; it must not call them while being built.
    const stub = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : stub), apply: () => stub });
    const ctx = Object.fromEntries(c.gives.map(n => [n, stub]));
    const out = mod[c.factory](ctx);
    for (const n of c.takes) assert.ok(n in out, `${c.factory} does not return ${n}`);
  });
}

