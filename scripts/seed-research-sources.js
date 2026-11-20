#!/usr/bin/env node
'use strict';

// Seeds initial production release and advisory feeds into LocalAI's research store.
// Can be run standalone or invoked by an automation job.

const path = require('node:path');
const { Storage } = require('../app/storage');
const { createResearchStore } = require('../app/research/store');

const SEED_SOURCES = [
  {
    name: 'Node.js Releases',
    url: 'https://nodejs.org/en/feed/releases.xml',
    kind: 'feed',
    trust: 'official',
    topics: ['core-runtime', 'engine'],
    scheduleMinutes: 360
  },
  {
    name: 'FastAPI Releases',
    url: 'https://fastapi.tiangolo.com/release.xml',
    kind: 'feed',
    trust: 'official',
    topics: ['pi-hub', 'gateway'],
    scheduleMinutes: 360
  },
  {
    name: 'Playwright Releases',
    url: 'https://github.com/microsoft/playwright/releases.atom',
    kind: 'feed',
    trust: 'official',
    topics: ['testing', 'browser-acceptance'],
    scheduleMinutes: 720
  },
  {
    name: 'Ollama Releases',
    url: 'https://github.com/ollama/ollama/releases.atom',
    kind: 'feed',
    trust: 'official',
    topics: ['models', 'local-inference'],
    scheduleMinutes: 360
  },
  {
    name: 'SQLite News',
    url: 'https://sqlite.org/news.rss',
    kind: 'feed',
    trust: 'official',
    topics: ['persistence', 'fts5'],
    scheduleMinutes: 720
  }
];

function seedSources(dataDir = process.env.DATA_DIR || path.join(__dirname, '../data')) {
  const storage = new Storage({ dataDir });
  const store = createResearchStore({ db: storage.db });

  let added = 0;
  let existing = 0;

  for (const s of SEED_SOURCES) {
    try {
      store.addSource(s);
      added++;
      console.log(`+ Added source: ${s.name} (${s.url})`);
    } catch (e) {
      if (e.status === 409) {
        existing++;
        console.log(`= Already exists: ${s.name}`);
      } else {
        console.error(`! Failed to add ${s.name}:`, e.message);
      }
    }
  }

  console.log(`\nSeed summary: ${added} added, ${existing} already present.`);
  return { added, existing };
}

if (require.main === module) {
  seedSources();
}

module.exports = { seedSources, SEED_SOURCES };
