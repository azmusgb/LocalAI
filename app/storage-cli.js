#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Storage, COLLECTIONS } = require('./storage');

function main(argv) {
  const command = argv.shift();
  const options = {};
  while (argv.length) {
    const flag = argv.shift(), value = argv.shift();
    if (!['--data-dir', '--output'].includes(flag) || !value || value.startsWith('--') || options[flag]) throw new Error('Expected unique --data-dir and/or --output values');
    options[flag] = value;
  }
  if (!['status', 'check', 'migrate', 'backup', 'export-json', 'downgrade-json'].includes(command)) {
    throw new Error('Usage: node app/storage-cli.js <status|check|migrate|backup|export-json|downgrade-json> [--data-dir PATH] [--output PATH]');
  }
  if (['backup', 'export-json', 'downgrade-json'].includes(command) && !options['--output']) throw new Error('--output is required');
  const dataDir = path.resolve(options['--data-dir'] || process.env.DATA_DIR || '/data');
  const storage = new Storage({ dataDir });
  try {
    if (command === 'backup') return { ok: true, backup: storage.backup(options['--output']) };
    if (command === 'export-json') return { ok: true, export: storage.exportLegacy(options['--output']) };
    if (command === 'downgrade-json') {
      // Operator/deployer must stop the application before running this command.
      const output = storage.exportLegacy(options['--output']);
      const backup = storage.backup(path.join(output, 'localai.db'));
      storage.close();
      for (const [, filename] of Object.values(COLLECTIONS)) if (filename) {
        const temporary = path.join(dataDir, filename + '.sqlite-export.tmp');
        fs.copyFileSync(path.join(output, filename), temporary);
        fs.renameSync(temporary, path.join(dataDir, filename));
      }
      fs.copyFileSync(path.join(output, 'status-state.json'), path.join(dataDir, 'status-state.json'));
      // Remove the old import marker along with the old DB, so a subsequent upgrade
      // imports JSON edits made while running the downgraded application.
      for (const suffix of ['', '-wal', '-shm']) {
        const source = path.join(dataDir, 'localai.db' + suffix);
        if (fs.existsSync(source)) fs.renameSync(source, path.join(output, 'archived-localai.db' + suffix));
      }
      return { ok: true, export: output, backup, downgraded: true };
    }
    return { ok: storage.check(), ...storage.status() };
  } finally { storage.close(); }
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error('LocalAI storage: ' + error.message); process.exitCode = 1; }
}
module.exports = { main };
