'use strict';

// The server's source as one text: app/server.js and the area modules split out of it (app/server/*.js). Tests that
// check what the server's code says read this, so moving code into a module doesn't break them
// (docs/superpowers/specs/2026-10-18-server-split-design.md, S4).
const fs = require('node:fs');
const path = require('node:path');

function serverSource() {
  const app = path.resolve(__dirname, '../app');
  const dir = path.join(app, 'server');
  const modules = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort().map(f => path.join(dir, f)) : [];
  return [path.join(app, 'server.js'), ...modules].map(f => fs.readFileSync(f, 'utf8')).join('\n');
}

module.exports = { serverSource };
