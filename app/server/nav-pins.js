'use strict';

// Pinned pages (navigation depth, D2): GET and PUT /api/nav/pins keep up to four view ids, in order, in the settings
// table under `nav-pins`. One owner, several devices: the server is the only copy. The rules (known ids only, no
// duplicates, at most four) live in public/pins.js, which the browser uses too. ctx holds what this code uses from the server.
const pins = require('../public/pins');
const KEY = 'nav-pins';

function createNavPins(ctx) {
  const { json, readBody, sameOriginJson, storage, storageError } = ctx;
  const read = () => pins.clean(storage.readSetting(KEY, {}).ids).ids; // an id the registry has since dropped falls away
  async function apiNavPins(req, res) {
    if (req.method === 'GET') return json(res, 200, { ids: read(), max: pins.MAX });
    if (!sameOriginJson(req, res)) return;
    try {
      const b = await readBody(req, 4 * 1024);
      if (!Array.isArray(b.ids)) return json(res, 400, { error: 'Send {"ids": ["status", "models"]}: the pages to pin, in order.' });
      const out = pins.clean(b.ids);
      if (out.tooMany) return json(res, 400, { error: `You can pin up to ${pins.MAX} pages. Unpin one to make room.` });
      storage.writeSetting(KEY, { ids: out.ids, at: new Date().toISOString() });
      return json(res, 200, { ids: out.ids, max: pins.MAX });
    } catch (e) { storageError(res, e, 400); }
  }
  return { apiNavPins };
}

module.exports = { createNavPins };
