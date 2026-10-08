'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Compile the guarded patch generator after converting its embedded helper
// template into a JSON string so nested server template literals remain literal.
const original = path.join(__dirname, 'patch-run-execution.cjs');
const text = fs.readFileSync(original, 'utf8');
const startMarker = 'const RUN_HELPERS = String.raw`';
const endMarker = '`;\n\nconst storageRequire';
const start = text.indexOf(startMarker);
const end = text.indexOf(endMarker, start + startMarker.length);

if (start < 0 || end < 0) {
  throw new Error('RUN_HELPERS source markers were not found');
}
if (text.indexOf(startMarker, start + startMarker.length) >= 0) {
  throw new Error('RUN_HELPERS start marker is ambiguous');
}
if (text.indexOf(endMarker, end + endMarker.length) >= 0) {
  throw new Error('RUN_HELPERS end marker is ambiguous');
}

const helperSource = text.slice(start + startMarker.length, end);
const fixed =
  text.slice(0, start) +
  `const RUN_HELPERS = ${JSON.stringify(helperSource)};\n\nconst storageRequire` +
  text.slice(end + endMarker.length);

const compiled = new Module(original, module);
compiled.filename = original;
compiled.paths = module.paths;
compiled._compile(fixed, original);
