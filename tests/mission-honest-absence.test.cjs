'use strict';
// Live (18 Oct): "Improve look feel and polish of agent world" finished, but its answer said there was "no evidence"
// of construction stages (scaffolding, cranes), flags, warning signs or fireworks, and that the rendering was static.
// All of them are in app/public/ui.js. The UX Analyst (a 4B model, 12k context) had read three small parts of the
// 3,900-line file and the Coordinator repeated "not in what I read" as "doesn't exist". Now each source opens with a
// map of names and line numbers, find_in_project finds a name anywhere, the prompts say "not seen in the parts I read",
// and an absence claim nobody searched for gets a visible caveat. The model is a fake Ollama over HTTP.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const createMissionEvidence = require('../app/mission-evidence');
const { fitEvidence, checkAbsenceClaims } = require('../app/mission-evidence');
const { createOllamaTurn, FINAL_TURN_PROMPT, ABSENCE_RULE } = require('../app/agent-runtime');
const { createResearchTools } = require('../app/agent-tools');
const createOrchestrator = require('../app/agent-orchestrator');

const repo = path.resolve(__dirname, '..');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

// A bundle like ui.js: a header, then sections; the Agent World section has functions at known lines.
function bundle() {
  const lines = ['// bundle header', '// ==== ui-kit.js ====', 'function kit(){ return 1; }'];
  for (let i = 0; i < 30; i++) lines.push(`function kitPart${i}(){ return ${i}; }`);
  lines.push('// ==== agent-world-city.js ====', "(()=>{'use strict';");
  const want = {};
  for (const name of ['drawSkeleton', 'drawCrane', 'buildState', 'districtFlags', 'drawDamage', 'drawFireworks']) {
    lines.push('// ' + name + ' paints one part of the city.');
    want[name] = lines.length + 1;
    lines.push(`function ${name}(d,x,y){`);
    for (let i = 0; i < 12; i++) lines.push(`  ctx.fillRect(x+${i},y,4,4); // ${name} step ${i}`);
    lines.push('}');
  }
  lines.push('})();', '// ==== notifications.js ====', 'function notify(){ return 0; }');
  return { text: lines.join('\n'), want };
}
const mapEntries = text => {
  const line = text.split('\n').find(l => l.startsWith('Functions: '));
  return line.replace(/^Functions: /, '').replace(/ … .*$/, '').split(', ').map(e => { const m = /^(.*) (\d+)$/.exec(e); return { name: m[1], line: Number(m[2]) }; });
};

test('each source opens with a map of its names and their real line numbers', t => {
  const app = path.join(tmp(t, 'localai-map-'), 'app');
  const { text, want } = bundle();
  write(app, 'public/ui.js', text);
  const evidence = createMissionEvidence({ appRoot: app });
  const city = evidence.select('Improve look feel and polish of agent world').find(s => s.source === 'app/public/ui.js#agent-world-city.js');
  assert.ok(city, 'the Agent World section is a source');
  const lines = text.split('\n');
  assert.match(city.text, /^MAP app\/public\/ui\.js lines 34–\d+ \(name line; read_project_file start_line = that line\):\nFunctions: /, 'the map comes first and is scoped to the section');
  const entries = mapEntries(city.text);
  for (const [name, line] of Object.entries(want)) assert.deepEqual(entries.find(e => e.name === name), { name, line }, name);
  for (const e of entries) assert.match(lines[e.line - 1], new RegExp('\\b' + e.name + '\\b'), `${e.name} is on line ${e.line}`);
  assert.ok(!entries.some(e => /^kit|^notify/.test(e.name)), 'only the section the goal maps to');

  // A whole file lists its sections too.
  write(app, 'zebra.js', text.replace(/agent-world/g, 'zebra-crossing'));
  const whole = createMissionEvidence({ appRoot: app }).select('zebra crossing kitPart').find(s => s.source === 'app/zebra.js');
  assert.match(whole.text, /\nSections: ui-kit\.js 2, zebra-crossing-city\.js 34, notifications\.js \d+\n/);

  // The map survives the first turn's budget cut (fitEvidence keeps the start of a block).
  const fitted = fitEvidence(['[E-0000000000000000] SOURCE: ' + city.source + '\n' + city.text], 900);
  assert.match(fitted.blocks[0], /MAP app\/public\/ui\.js[\s\S]*drawSkeleton \d+/);
});

test('the real Agent World map points at drawCrane, drawSkeleton and the rest, at their lines', () => {
  const ui = fs.readFileSync(path.join(repo, 'app/public/ui.js'), 'utf8').split('\n');
  const evidence = createMissionEvidence({ appRoot: path.join(repo, 'app') });
  const city = evidence.select('Improve look feel and polish of agent world', { agentId: 'ux_analyst' }).find(s => s.source === 'app/public/ui.js#agent-world-city.js');
  const entries = mapEntries(city.text);
  for (const name of ['drawSkeleton', 'drawCrane', 'buildState', 'districtFlags', 'drawDamage', 'drawCommandCelebration']) {
    const e = entries.find(x => x.name === name);
    assert.ok(e, name + ' is on the map');
    assert.match(ui[e.line - 1], new RegExp('function ' + name + '\\b'), name);
  }
  for (const e of entries) assert.match(ui[e.line - 1], new RegExp('(?:^|[^\\w$])' + e.name.replace(/\$/g, '\\$') + '(?:[^\\w$]|$)'), e.name);
  assert.ok(city.text.length <= 5600);
});

test('find_in_project returns lines with numbers, inside the allowed roots only', async t => {
  const root = tmp(t, 'localai-find-');
  const outside = tmp(t, 'localai-find-outside-');
  const { text, want } = bundle();
  write(root, 'public/ui.js', text);
  write(root, 'repo-context/docs/CITY.md', '# City\n\nThe crane lifts beams.\n');
  for (const hidden of ['data/state.json', '.git/crane.js', 'node_modules/x/crane.js', 'secrets/crane.md', 'public/crane.bin']) write(root, hidden, 'drawCrane crane');
  write(outside, 'crane.js', 'function drawCrane(){} // outside');
  fs.symlinkSync(outside, path.join(root, 'public', 'linked'));
  const find = createResearchTools({ projectRoot: root }).find(x => x.name === 'find_in_project');
  assert.ok(find, 'the tool is offered');
  assert.deepEqual(find.definition.function.parameters.required, ['query']);

  const got = await find.execute({ query: 'drawCrane' });
  assert.equal(got.data.matches[0].path, 'app/public/ui.js');
  assert.equal(got.data.matches[0].line, want.drawCrane - 1, 'the comment that names it comes first, in file order');
  assert.ok(got.data.matches.some(m => m.line === want.drawCrane && /^function drawCrane\(/.test(m.text)));
  assert.ok(got.data.matches.every(m => m.path === 'app/public/ui.js'), 'nothing hidden, generated, dependency, binary or linked: ' + JSON.stringify(got.data.files));
  assert.equal(got.evidence[0].kind, 'search');
  assert.equal(got.evidence[0].id, got.data.evidenceId);

  // Several words find any of them, lines with more of them first; docs come back by their repo path.
  const crane = await find.execute({ query: 'crane beams' });
  assert.deepEqual(crane.data.matches[0], { path: 'docs/CITY.md', line: 3, text: 'The crane lifts beams.' });
  assert.ok((await find.execute({ query: 'crane', path: 'docs/CITY.md' })).data.matches.length === 1, 'path takes the evidence labels’ spelling');
  assert.equal((await find.execute({ query: 'crane', path: 'app/public' })).data.files[0].path, 'app/public/ui.js');

  for (const bad of ['..', '../x', '/etc', 'data', '.git', 'public/linked', 'public/../..']) {
    await assert.rejects(find.execute({ query: 'crane', path: bad }), /Only permitted|No file or folder/, bad);
  }
  await assert.rejects(find.execute({ query: 'crane', extra: 1 }), /Unexpected argument/);

  // Nothing found is evidence of its own, to cite for an absence claim.
  const none = await find.execute({ query: 'hovercraft' });
  assert.equal(none.data.totalMatches, 0);
  assert.match(none.data.note, new RegExp('^Nothing found: no line in the project contains hovercraft\\. .*\\[' + none.data.evidenceId + '\\]'));
  assert.equal(none.evidence[0].matches, 0);

  // Small enough for the room left: fewer lines come back, with a note, rather than a refusal.
  const many = await find.execute({ query: 'step' }, { maxChars: 1500 });
  assert.ok(JSON.stringify({ ok: true, ...many }).length <= 1500);
  assert.ok(many.data.matches.length > 0 && many.data.matches.length < 20);
  assert.match(many.data.note, /^Showing \d+ of \d+ matching lines/);
  await assert.rejects(find.execute({ query: 'step' }, { maxChars: 300 }), /Not enough room/);
});

// A fake /api/chat: `reply(body)` gets the parsed request and returns the assistant message.
async function fakeOllama(t, reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: '', ...reply(body) } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
async function missionFixture(t, reply) {
  const dataDir = tmp(t, 'localai-absence-mission-');
  const root = tmp(t, 'localai-absence-project-');
  write(root, 'public/ui.js', bundle().text);
  const fake = await fakeOllama(t, reply);
  const orchestrator = createOrchestrator({
    dataDir, ollamaUrl: fake.url, defaultModel: 'test-model', projectRoot: root,
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: 'test-model' }] }) }),
    runLocalModel: async () => { throw new Error('unused'); },
    runAgentTurn: createOllamaTurn({ ollamaUrl: fake.url }), agentLimits: { maxTurns: 3 },
  });
  t.after(() => orchestrator.close());
  return { orchestrator, fake };
}
const isCoordinator = body => body.messages[0].content.startsWith('You are the mission coordinator');
const firstId = text => text.match(/E-[a-f0-9]{16}/)[0];

test('the worker and Coordinator prompts carry the absence rule, and workers get find_in_project', async t => {
  const { orchestrator, fake } = await missionFixture(t, body => isCoordinator(body)
    ? { content: 'Summary [' + firstId(body.messages[1].content) + ']' }
    : { content: 'Findings [' + firstId(body.messages[1].content) + ']' });
  const mission = await orchestrator.mission('Improve look feel and polish of agent world', '', ['ux_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  const worker = fake.requests.find(b => !isCoordinator(b)), coordinator = fake.requests.find(isCoordinator);
  const rule = /write "not seen in the parts I read \(lines X–Y of file\)", never "does not exist" or "no evidence it exists"\. Say something is absent only after find_in_project for it returned no matches, and cite that search's evidence ID\./;
  assert.match(worker.messages[1].content, rule, 'the grounding rules');
  assert.match(worker.messages[1].content, /OBSERVED ABSENCE IN SUPPLIED EXCERPTS/, 'the contract rule stays');
  assert.match(worker.messages[1].content, /Each source opens with a MAP of its functions or headings and their line numbers/);
  assert.match(worker.messages[1].content, /MAP app\/public\/ui\.js lines \d+–\d+/);
  assert.ok(worker.messages[0].content.includes(ABSENCE_RULE), 'the runtime system prompt');
  assert.match(ABSENCE_RULE, /never "does not exist" or "no evidence it exists"/);
  assert.match(FINAL_TURN_PROMPT, /something you did not see is "not seen in the parts I read \(lines X–Y of file\)", never "does not exist"/);
  assert.ok(worker.tools.some(x => x.function.name === 'find_in_project'));
  assert.match(coordinator.messages[0].content, /not seen in the parts it read means it was not checked, never that a feature is missing\. Report something as missing only when a specialist's find_in_project search for it returned no matches/);
  assert.ok(coordinator.messages[0].content.includes(require('../app/mission-answer').ANSWER_FORMAT), 'the Coordinator is told how to write the answer');
  assert.equal(mission.answer, 'Summary [' + firstId(coordinator.messages[1].content) + ']', 'nothing to caveat');
  assert.equal(mission.rawAnswer, undefined, 'nothing to tidy');
  assert.equal(mission.absenceCheck, undefined);
});

test('a Coordinator answer that calls something missing nobody searched for is marked "not checked", with a caveat line', async t => {
  let said = '';
  const { orchestrator } = await missionFixture(t, body => {
    if (!isCoordinator(body)) return { content: 'Read the city section [' + firstId(body.messages[1].content) + ']; fireworks were not seen in the parts I read.' };
    said = 'The city draws buildings [' + firstId(body.messages[1].content) + '].\n\n**No evidence** for construction stages such as cranes in the rendering logic. Fireworks do not exist in the city.';
    return { content: said };
  });
  const mission = await orchestrator.mission('Improve look feel and polish of agent world', '', ['ux_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  // The answer leads; each claim is marked where it stands (the bold went with the Markdown, mission-answer.js plainText).
  assert.equal(mission.answer, said.replace('**No evidence**', 'No evidence').replace('rendering logic.', 'rendering logic (not checked).').replace('in the city.', 'in the city (not checked).')
    + '\n\nCaveat: 2 statements marked “not checked” say something is missing, but no worker searched the code for those things, so they may well exist.');
  assert.equal(mission.rawAnswer, said, 'the Coordinator\'s own words are kept');
  assert.deepEqual(mission.absenceCheck.flagged, ['No evidence for construction stages such as cranes in the rendering logic.', 'Fireworks do not exist in the city.']);
  assert.deepEqual(mission.absenceCheck.backed, []);
});

test('an absence claim backed by a cited empty search is kept as written', async t => {
  let said = '';
  const { orchestrator } = await missionFixture(t, body => {
    if (isCoordinator(body)) {
      // The worker's write-up, among the specialist outputs, cites its empty search.
      const searchId = body.messages[1].content.match(/for hovercraft found nothing \[(E-[a-f0-9]{16})\]/)[1];
      assert.match(body.messages[1].content, new RegExp('"id":"' + searchId + '","source":"find:hovercraft"'), 'the search is in the evidence index');
      said = 'Hovercraft does not exist in the app: find_in_project found no line naming it [' + searchId + '].';
      return { content: said };
    }
    const result = body.messages.find(m => m.role === 'tool');
    if (!result) return { tool_calls: [{ function: { name: 'find_in_project', arguments: { query: 'hovercraft' } } }] };
    const data = JSON.parse(result.content).data;
    assert.equal(data.totalMatches, 0);
    return { content: 'No hovercraft: find_in_project for hovercraft found nothing [' + data.evidenceId + '].' };
  });
  const mission = await orchestrator.mission('Improve look feel and polish of agent world', '', ['ux_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  assert.equal(mission.answer, said, 'no caveat');
  assert.equal(mission.absenceCheck.flagged.length, 0);
  assert.equal(mission.absenceCheck.backed.length, 1);
  assert.match(mission.absenceCheck.backed[0].search, /^E-[a-f0-9]{16}$/);
});

test('the check: a search that found the thing, or stopped early, backs no absence claim', () => {
  const found = { kind: 'search', id: 'E-1111111111111111', query: 'drawCrane', matches: 3 };
  const early = { kind: 'search', id: 'E-2222222222222222', query: 'fireworks', matches: 0, complete: false };
  const empty = { kind: 'search', id: 'E-3333333333333333', query: 'hovercraft', matches: 0 };
  const answer = 'drawCrane is missing [E-1111111111111111]. Fireworks are not implemented. Hovercraft lacks implementation. Workers walk.';
  const checked = checkAbsenceClaims(answer, [found, early, empty]);
  assert.deepEqual(checked.flagged, ['drawCrane is missing [E-1111111111111111].', 'Fireworks are not implemented.']);
  assert.deepEqual(checked.backed, [{ sentence: 'Hovercraft lacks implementation.', search: empty.id }]);
  assert.equal(checked.answer, 'drawCrane is missing [E-1111111111111111] (not checked). Fireworks are not implemented (not checked). Hovercraft lacks implementation. Workers walk.'
    + '\n\nCaveat: 2 statements marked “not checked” say something is missing, but no worker searched the code for those things, so they may well exist.');
  assert.match(checkAbsenceClaims('Fireworks do not exist.', []).answer, /^Fireworks do not exist \(not checked\)\.\n\nCaveat: the statement marked “not checked” says something is missing, but no worker searched the code for it, so it may well exist\.$/);
  assert.deepEqual(checkAbsenceClaims('All good.', []), { answer: 'All good.', flagged: [], backed: [] });
});
