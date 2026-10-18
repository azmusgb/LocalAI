'use strict';

// The state collections: read, write and capped prepend (moved from server.js unchanged). The status record lives
// in a setting rather than a collection.

function createStores({ storage, STATUS_STORE }) {
  function readState(collection, fallback) {
    return collection === STATUS_STORE ? storage.readSetting('status', fallback) : storage.list(collection);
  }
  // History and log collections are capped; user-owned data (projects, conversations, knowledge, memory,
  // approvals, library, …) is never pruned.
  const RETENTION = Object.freeze({ activity: 2000, notifications: 500, automationRuns: 500, qualityEvents: 500, qualityScans: 100, agentRuns: 300, engineeringRuns: 300, powerShellJobs: 250 });
  function prependRecord(collection, item) { return storage.prepend(collection, item, RETENTION[collection]); }
  function writeState(collection, value, previous = value) {
    if (collection === STATUS_STORE) return storage.writeSetting('status', value);
    return storage.save(collection, value, previous);
  }
  return { readState, writeState, prependRecord, RETENTION };
}

module.exports = { createStores };
