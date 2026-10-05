'use strict';
const fs = require('node:fs');
const path = require('node:path');

function readRelease(appRoot) {
  const file = path.join(appRoot, 'release.json');
  if (!fs.existsSync(file)) return null;
  let release;
  try { release = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (cause) { throw new Error('Invalid deployment release.json; refusing to report a healthy release.', { cause }); }
  if (!release || typeof release.commit !== 'string' || !/^[a-f0-9]{40}$/.test(release.commit)) {
    throw new Error('Deployment release.json must contain a full commit SHA');
  }
  return { commit: release.commit };
}
module.exports = { readRelease };
