'use strict';

// A screen never re-types a platform phrase (appliance-ui DESIGN.md, Words): it reads the phrase from the vendored
// kit, /ui/needs.js. app.js used to type two of them by hand: the Assistant-not-answering sentence on Assistant
// status and the Inbox's nothing-waiting line. This keeps both out of app.js and checks the kit still offers them
// in the form app.js reads. tests/system-lists-ui.mjs checks the words the page shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.resolve(__dirname, '../app/public');
const js = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const kit = require(path.join(pub, 'ui/needs.js'));

// The kit's empty line is not exported by name; renderList([]) with no `empty` option draws it.
const doc = { createElement: tag => ({ tagName: tag, className: '', textContent: '' }) };
const emptyLine = kit.renderList([], { doc });

test('the kit offers both phrases the way app.js reads them', () => {
  assert.equal(typeof kit.PHRASES.assistant_down, 'string');
  assert.ok(kit.PHRASES.assistant_down.length > 0);
  assert.doesNotMatch(kit.PHRASES.assistant_down, /[.{]/, 'app.js adds the full stop and fills no placeholder');
  assert.equal(typeof emptyLine.textContent, 'string');
  assert.ok(emptyLine.textContent.length > 0);
});

test('app.js types neither phrase by hand', () => {
  assert.ok(!js.includes(kit.PHRASES.assistant_down), `app.js re-types the kit's assistant_down phrase`);
  assert.ok(!js.includes(emptyLine.textContent), `app.js re-types the kit's empty line`);
  assert.ok(!js.includes(emptyLine.textContent.replace(/\.$/, '')), `app.js re-types the kit's empty line without its full stop`);
});

test('app.js reads both from the kit', () => {
  assert.match(js, /ApplianceNeeds\?\.PHRASES\?\.assistant_down/);
  assert.match(js, /ApplianceNeeds\?\.renderList\?\.\(\[\]\)/);
});

test('index.html loads the kit before app.js', () => {
  const kitAt = html.indexOf('<script src="/ui/needs.js"></script>');
  const appAt = html.indexOf('<script type="module" src="/app.js"></script>');
  assert.ok(kitAt > -1 && appAt > -1, 'both scripts are on the page');
  assert.ok(kitAt < appAt, '/ui/needs.js comes first');
});
