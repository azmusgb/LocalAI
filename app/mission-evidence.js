'use strict';
// What a mission's workers read about Local AI itself (agent-orchestrator.js projectGrounding): the code and docs of
// the part of the app the goal names. A goal naming a page or feature ("agent world", "Spreadsheets") brings that
// feature's files, ui.js sections and specs; otherwise a keyword search over app/, docs/ and host/ ranks files by
// matches; a goal about nothing in the repo brings no repo code.
// Excerpts stay small (the model is a 4B on a 6 GB GPU): each source is a map of its functions or headings with their
// line numbers (first, so it survives fitEvidence's cut), its header, then its most relevant blocks, long lines cut.
const fs = require('node:fs');
const path = require('node:path');
const VIEWS = require('./public/view-registry').VIEWS;

const SPECS = 'docs/superpowers/specs/';
// Each feature: the words that name it (besides its registry views' labels, ids and aka), and its sources in order of
// use. A source is a repo path, optionally narrowed: `section` (a ui.js `// ==== name ====` section), `anchor` (an
// index.html `<section id>`), `match` (keep only CSS rules or blocks containing one of these strings).
const FEATURES = [
  { id: 'agent-world', views: ['agents'], names: ['agent world', 'agent-world', 'agentworld', 'mission', 'missions', 'crew', 'specialist', 'specialists', 'coordinator', 'follow-up', 'follow-ups'],
    sources: [{ path: 'app/public/ui.js', section: 'agent-world-city.js' }, { path: 'app/public/ui.js', section: 'agent-specialists.js' }, { path: 'app/public/agent-world-words.js' },
      { path: SPECS + '2026-10-17-agent-world-design.md' }, { path: SPECS + '2026-10-18-agent-world-visuals.md' }, { path: 'app/public/index.html', anchor: 'agents' },
      { path: 'app/public/app.css', match: ['.aw-', '.awc', '#agents'] }, { path: 'app/agent-orchestrator.js' }, { path: 'app/specialist-agents.json' }] },
  { id: 'spreadsheets', views: ['spreadsheets'], names: ['gridcraft', 'spreadsheet', 'spreadsheets', 'excel', 'workbook', 'workbooks', 'sheet', 'sheets'],
    sources: [{ path: 'app/public/spreadsheets.js' }, { path: 'docs/GRIDCRAFT.md' }, { path: SPECS + '2026-10-17-gridcraft-workbook-ux-design.md' }, { path: 'app/public/index.html', anchor: 'spreadsheets' },
      { path: 'app/server/gridcraft.js' }, { path: 'host/gridcraft-bridge.py' }, { path: 'host/gridcraft-agent/gridcraft_ai.py' }, { path: 'app/public/app.css', match: ['.sheets-', '#spreadsheets'] }] },
  { id: 'images', views: ['create'], names: ['image', 'images', 'picture', 'pictures', 'comfyui', 'artcraft', 'image generation'],
    sources: [{ path: 'app/image-engines.js' }, { path: 'app/public/index.html', anchor: 'create' }, { path: 'docs/ARTCRAFT.md' }, { path: 'host/comfyui/README.md' }, { path: 'app/server.js', match: ['comfy', 'image'] }, { path: 'app/public/app.css', match: ['.img-'] }] },
  { id: 'health', views: ['status', 'models', 'integrations'], names: ['health', 'health check', 'services', 'models', 'integrations'],
    sources: [{ path: 'app/public/index.html', anchor: 'status' }, { path: 'app/glance.js' }, { path: 'app/server.js', match: ['capabilit', 'health'] }, { path: 'docs/OPERATIONS.md' }, { path: 'app/model-runtime.js' }] },
  { id: 'work', views: ['work', 'runs'], names: ['work page', 'work tab', 'run card', 'run cards'],
    sources: [{ path: 'app/public/work.js' }, { path: 'app/run-cards.js' }, { path: 'app/run-ledger.js' }, { path: 'app/public/run-bodies.js' }, { path: SPECS + '2026-10-15-navigation-home-work-design.md' }, { path: 'app/public/index.html', anchor: 'work' }, { path: 'app/public/app.css', match: ['.work-', '.run-'] }] },
  { id: 'home', views: ['home'], names: ['home page', 'home screen', 'needs you'],
    sources: [{ path: 'app/public/home.js' }, { path: SPECS + '2026-10-15-navigation-home-work-design.md' }, { path: SPECS + '2026-10-15-ask-local-ai-design.md' }, { path: 'app/public/index.html', anchor: 'home' }, { path: 'app/public/app.css', match: ['.home-'] }] },
  { id: 'improve', views: ['backlog', 'inProgress', 'shipped', 'signals'], names: ['improve', 'change request', 'change requests'],
    sources: [{ path: 'app/improve.js' }, { path: 'app/public/improve.js' }, { path: SPECS + '2026-10-15-improve-design.md' }, { path: 'app/public/index.html', anchor: 'backlog' }, { path: 'app/public/app.css', match: ['.improve-'] }] },
  { id: 'claude', views: ['claude'], names: ['claude code', 'claude board', 'claude chat', 'claude'],
    sources: [{ path: 'app/claude-chat.js' }, { path: 'app/public/ui.js', section: 'claude-board.js' }, { path: 'app/public/ui.js', section: 'claude-chat.js' }, { path: 'docs/CLAUDE-CHAT.md' }, { path: SPECS + '2026-10-15-claude-chat-design.md' }, { path: 'host/claude-chat/bridge.mjs' }, { path: 'app/public/app.css', match: ['.claude-'] }] },
  { id: 'navigation', views: [], names: ['navigation', 'nav', 'menu', 'rail', 'sidebar', 'tab bar', 'command palette'],
    sources: [{ path: 'app/public/view-registry.js' }, { path: 'app/public/router.js' }, { path: 'app/public/ui.js', section: 'ux-architecture-v2.js' }, { path: SPECS + '2026-10-17-navigation-structure-design.md' }, { path: 'app/public/app.css', match: ['.ux-'] }] },
  { id: 'notifications', views: ['inbox'], names: ['notification', 'notifications', 'push', 'alert', 'alerts'],
    sources: [{ path: 'app/notify.js' }, { path: 'app/push.js' }, { path: 'app/public/ui.js', section: 'notifications.js' }, { path: SPECS + '2026-10-15-notifications-design.md' }, { path: 'app/public/index.html', anchor: 'inbox' }] },
  { id: 'chat', views: ['ask'], names: ['chat page', 'ask local ai'],
    sources: [{ path: 'app/public/index.html', anchor: 'ask' }, { path: SPECS + '2026-10-15-ask-local-ai-design.md' }, { path: 'app/text-context.js' }, { path: 'app/public/app.css', match: ['.chat-', '.ask-'] }] },
  { id: 'voice', views: [], names: ['voice', 'siri', 'apple watch', 'shortcut', 'shortcuts'],
    sources: [{ path: 'app/voice.js' }, { path: 'app/voice-context.js' }, { path: 'docs/APPLE-WATCH.md' }] },
];
// Registry names that are ordinary words count only when the goal also talks about the app ("the Home page").
const GENERIC = new Set(['home', 'work', 'inbox', 'memory', 'library', 'sources', 'models', 'files', 'chat', 'images', 'image', 'signals', 'backlog', 'shipped', 'health',
  'services', 'projects', 'automations', 'activity', 'status', 'knowledge', 'repository', 'actions', 'runs', 'in progress', 'push', 'alert', 'alerts', 'menu', 'rail', 'sheet', 'sheets',
  'shortcut', 'shortcuts', 'voice', 'improve', 'picture', 'pictures', 'crew', 'mission', 'nav', 'tools', 'tool']);
// Registry aka that name nothing in particular.
const SKIP = new Set(['ask', 'create', 'overview', 'done', 'released', 'ideas', 'priorities', 'changes', 'engineer', 'kept', 'everything you kept', 'bridges', 'detections', 'issues']);
const APP_CONTEXT = /\b(?:page|tab|screen|view|views|ui|ux|app|local ?ai|button|card|cards|list|layout|menu|panel|sheet|feature|shows?|display|appliance|nav)\b/i;
// Filler and request words that say nothing about where in the repo to look.
const STOP = new Set(('the and for with this that from into local implementation recommendations about what when where which while would could should please make makes made '
  + 'improve improving improvement look looks feel feels polish polished better nicer plan planning fix fixes add adds show shows showing wrong right want need needs help some more less '
  + 'all any its our your their them they there here have has had does doing done get gets set use using used new also just like very really much many way ways thing things not but are was '
  + 'were been can will why how who whom whose than then only over under again each every other same such too out off one two three give').split(' '));
// "Look and feel" goals: the visual vocabulary of the code and CSS.
const VISUAL = /\b(?:look|feel|polish|visual|visuals|design|style|styling|pretty|ugly|beautiful|layout|colou?rs?|theme|animation|motion|ui|ux|aesthetic)\b/i;
const VISUAL_TERMS = ['draw', 'color', 'colour', 'style', 'theme', 'font', 'shadow', 'animation', 'motion', 'layout', 'sprite', 'palette', 'radius', 'visual', 'render', '--ds-', '--aw-'];
const SEARCH_DIRS = ['app', 'docs', 'host'];
const SEARCH_EXT = /\.(?:js|cjs|mjs|json|html|css|md|py|ps1|sh)$/i;
const SEARCH_SKIP = /(?:^|\/)(?:node_modules|fonts|icons|data|\.[^/]*)(?:\/|$)/;
const LINE_CHARS = 240;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'try']);

const lower = s => String(s || '').toLowerCase();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function hasWord(text, phrase) { return new RegExp('(?:^|[^a-z0-9])' + esc(phrase) + '(?:$|[^a-z0-9])').test(text); }
function goalTerms(goal) {
  const words = lower(goal).match(/[a-z][a-z0-9_-]{2,}/g) || [];
  return [...new Set(words.filter(w => !STOP.has(w)))].slice(0, 18);
}
function featureNames(feature) {
  const names = new Set(feature.names);
  for (const v of VIEWS) {
    if (!feature.views.includes(v.id)) continue;
    // An aka that is another page's id or another feature's name ("agents" on Work) names that one, not this one.
    for (const n of [v.label, v.tab, v.id, ...(v.aka || [])]) {
      const low = lower(n);if (!low || SKIP.has(low) || low.length < 3) continue;
      if (n !== v.id && (VIEWS.some(o => o.id !== v.id && lower(o.id) === low) || FEATURES.some(o => o !== feature && o.names.includes(low)))) continue;
      names.add(low);
    }
  }
  return [...names];
}
// The features a goal names, best first: a distinctive name scores 3 (a phrase 4), a generic one 1 and only with app context.
function featuresFor(goal) {
  const text = lower(goal), context = APP_CONTEXT.test(text), out = [];
  for (const f of FEATURES) {
    let score = 0;
    for (const n of featureNames(f)) {
      if (!hasWord(text, n) && !hasWord(text, n.replace(/s$/, ''))) continue;
      if (GENERIC.has(n)) { if (context) score += 1; } else score += n.includes(' ') ? 4 : 3;
    }
    if (score) out.push({ feature: f, score });
  }
  return out.sort((a, b) => b.score - a.score).map(x => x.feature);
}

// Split a text into blocks (a function, a CSS rule, a Markdown section, an HTML element) with a short head for the outline.
function splitBlocks(lines, kind) {
  const starts = kind === 'md' ? /^#{1,6}\s/
    : kind === 'css' ? /^\s{0,2}[^\s/*@}][^{]*\{|^\s{0,2}@media/
      : kind === 'html' ? /^\s{0,4}<(?:section|header|nav|main|footer|dialog|aside|form|div class="topbar")\b/
        : /^\s{0,2}(?:export\s+)?(?:async\s+)?function\s*\*?\s*[\w$]+|^\s{0,2}(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>|\(\(\)|\{|\[)|^\s{0,4}(?:async\s+)?def\s+\w+|^\s{0,4}class\s+\w+|^function\s+[\w-]+|^\s{0,2}[\w$]+\s*\([^)]*\)\s*\{/;
  const comment = kind === 'md' || kind === 'html' ? null : kind === 'css' ? /^\s*\/\*/ : /^\s*(?:\/\/|#(?!!)|<#)/;
  const blocks = [];let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], prevComment = i > 0 && comment && comment.test(lines[i - 1]);
    const begin = !cur || (starts.test(line) && !prevComment) || (comment && comment.test(line) && !prevComment && !(cur && cur.start === i));
    if (begin) { cur = { start: i, end: i, head: '' }; blocks.push(cur); } else cur.end = i;
    if (!cur.head && (starts.test(line) || kind === 'md')) { cur.head = headOf(line, kind);cur.headLine = i; }
  }
  return blocks;
}
function headOf(line, kind) {
  const t = line.trim();
  if (kind === 'md') return t.replace(/^#+\s*/, '').slice(0, 70);
  if (kind === 'css') return t.split('{')[0].trim().slice(0, 60);
  if (kind === 'html') { const id = t.match(/\bid="([^"]+)"/); return id ? '#' + id[1] : t.slice(0, 40); }
  const m = t.match(/(?:function\s*\*?\s*|def\s+|class\s+|(?:const|let|var)\s+)([\w$-]+)/) || t.match(/^([\w$]+)\s*\(/);
  return m ? m[1] : '';
}
function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.md' ? 'md' : ext === '.css' ? 'css' : ext === '.html' ? 'html' : ext === '.json' ? 'json' : 'code';
}
function scoreText(text, terms) {
  const low = lower(text);let distinct = 0, hits = 0;
  for (const t of terms) { if (!low.includes(t)) continue; distinct++; let i = low.indexOf(t), n = 0; while (i >= 0 && n < 5) { n++; i = low.indexOf(t, i + t.length); } hits += n; }
  return distinct * 10 + hits;
}
// The map that opens a source: each function (heading, rule, element) and `// ==== section ====` header with its line
// in the real file, so a worker reads exactly that range with read_project_file instead of paging through a bundle.
// Names and lines only; over MAP_CHARS the names that match the goal and the longer (more specific) ones are kept.
const MAP_CHARS = 3000;
function sourceMap(file, all, blocks, { kind, terms, from, end }) {
  const seen = new Set(), names = [];
  for (const b of blocks) {
    const h = b.head;if (!h || h.length < 3 || KEYWORDS.has(h) || seen.has(h)) continue;
    seen.add(h);names.push({ name: h, line: b.headLine + 1 });
  }
  const sections = [];
  if (kind === 'code') for (let n = from; n <= end; n++) { const m = /^\/\/ ==== (.+?) ====/.exec(all[n]); if (m) sections.push({ name: m[1], line: n + 1 }); }
  if (names.length < 2 && sections.length < 2) return '';
  const title = `MAP ${file} lines ${from + 1}–${end + 1} (name line; read_project_file start_line = that line):`;
  const label = kind === 'md' ? 'Headings: ' : kind === 'css' ? 'Rules: ' : kind === 'html' ? 'Elements: ' : 'Functions: ';
  const join = list => list.map(x => x.name + ' ' + x.line).join(', ');
  const head = title + (sections.length > 1 ? '\nSections: ' + join(sections) : '') + '\n' + label;
  let kept = names, room = MAP_CHARS - head.length;
  if (join(names).length > room) {
    const rank = x => (terms.some(t => lower(x.name).includes(t)) ? 2 : 0) + (x.name.length >= 5 ? 1 : 0);
    const order = names.map((x, i) => ({ x, i, r: rank(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
    room -= 60;kept = [];let size = 0;
    for (const { x } of order) { const add = x.name.length + String(x.line).length + 3; if (size + add > room) continue; kept.push(x);size += add; }
    kept.sort((a, b) => a.line - b.line);
    return head + join(kept) + ` … ${names.length - kept.length} more (find_in_project finds any name)`;
  }
  return head + join(kept);
}
const cut = line => line.length > LINE_CHARS ? line.slice(0, LINE_CHARS) + ' …' : line;
const numbered = (lines, from, to) => { const out = []; for (let n = from; n <= to; n++) out.push(String(n + 1).padStart(5, ' ') + ' | ' + cut(lines[n])); return out.join('\n'); };

// One source as a small excerpt: the map, header lines, then the most relevant blocks in file order.
function excerpt(label, raw, { kind, terms, from = 0, to, match, maxChars }) {
  const all = raw.split(/\r?\n/), end = Math.min(all.length - 1, to ?? all.length - 1);
  if (kind === 'json' || (end - from < 60 && !match)) {
    const text = numbered(all, from, end);
    return { source: label, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  let blocks = splitBlocks(all.slice(from, end + 1), kind).map(b => ({ ...b, start: b.start + from, end: b.end + from, headLine: (b.headLine ?? b.start) + from }));
  const head = blocks[0];
  if (match) blocks = blocks.filter(b => match.some(m => all.slice(b.start, b.end + 1).join('\n').includes(m)));
  if (!blocks.length) return null;
  const parts = [];let used = 0;
  const lead = match ? null : head;
  if (lead) { const text = numbered(all, lead.start, Math.min(lead.end, lead.start + 7)); parts.push({ at: lead.start, text }); used += text.length; }
  const map = sourceMap(label.split('#')[0], all, blocks, { kind, terms, from, end });
  if (map) { parts.push({ at: -1, text: map }); used += map.length; }
  const ranked = blocks.filter(b => b !== lead).map((b, i) => ({ b, i, score: scoreText(all.slice(b.start, b.end + 1).join('\n'), terms) }))
    .sort((x, y) => y.score - x.score || x.i - y.i);
  for (const { b, score } of ranked) {
    if (used >= maxChars - 200) break;
    if (!score && used > maxChars / 2) continue;
    // A long block keeps its head and the lines that mention the goal.
    let text = numbered(all, b.start, b.end);
    if (used + text.length > maxChars) {
      const keep = [b.start];for (let n = b.start + 1; n <= b.end; n++) if (terms.some(t => lower(all[n]).includes(t))) keep.push(n);
      text = keep.map(n => String(n + 1).padStart(5, ' ') + ' | ' + cut(all[n])).join('\n');
      if (used + text.length > maxChars) text = text.slice(0, Math.max(0, maxChars - used - 20));
    }
    if (!text) continue;
    parts.push({ at: b.start, text });used += text.length + 5;
  }
  const body = parts.sort((a, b) => a.at - b.at).map(p => p.text).join('\n...\n');
  return { source: label, text: body.slice(0, maxChars), truncated: true };
}

module.exports = function createMissionEvidence({ appRoot, repoRoots, maxSources = 7, maxChars = 5600 } = {}) {
  // docs/ and host/ sit next to app/ in a checkout; the deploy copies them into app/repo-context (the container sees only app/).
  const roots = repoRoots || [path.join(appRoot, '..'), path.join(appRoot, 'repo-context')];
  const cache = new Map();
  function resolve(rel) {
    if (rel.startsWith('app/')) return path.join(appRoot, rel.slice(4));
    for (const r of roots) { const full = path.join(r, rel); if (fs.existsSync(full)) return full; }
    return null;
  }
  function read(rel) {
    if (cache.has(rel)) return cache.get(rel);
    let text = null;
    try { const full = resolve(rel); if (full) { const st = fs.statSync(full); if (st.isFile() && st.size <= 1024 * 1024) text = fs.readFileSync(full, 'utf8'); } } catch { text = null; }
    cache.set(rel, text);return text;
  }
  function sectionRange(raw, name) {
    const lines = raw.split(/\r?\n/), at = lines.findIndex(l => l.startsWith('// ==== ' + name));
    if (at < 0) return null;
    let end = lines.length - 1;for (let n = at + 1; n < lines.length; n++) if (lines[n].startsWith('// ==== ')) { end = n - 1; break; }
    return { from: at, to: end };
  }
  function anchorRange(raw, id) {
    const lines = raw.split(/\r?\n/), at = lines.findIndex(l => l.includes('<section id="' + id + '"'));
    if (at < 0) return null;
    let end = lines.length - 1;for (let n = at + 1; n < lines.length; n++) if (/^<section\b/.test(lines[n])) { end = n - 1; break; }
    return { from: at, to: end };
  }
  function sourceFor(src, terms) {
    const raw = read(src.path);if (raw == null) return null;
    let range = {}, label = src.path;
    if (src.section) { range = sectionRange(raw, src.section);if (!range) return null;label += '#' + src.section; }
    if (src.anchor) { range = anchorRange(raw, src.anchor);if (!range) return null;label += '#' + src.anchor; }
    return excerpt(label, raw, { kind: kindOf(src.path), terms, match: src.match, maxChars, ...range });
  }
  let index = null;
  function files() {
    if (index) return index;
    index = [];
    const walk = (rel) => {
      const full = resolve(rel);if (!full) return;
      let entries = [];try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const child = rel + '/' + e.name;
        if (SEARCH_SKIP.test(child) || child === 'app/repo-context') continue;
        if (e.isDirectory()) walk(child); else if (SEARCH_EXT.test(e.name)) index.push(child);
      }
    };
    SEARCH_DIRS.forEach(walk);
    return index;
  }
  // Files ranked by the goal's words they contain, a rare word counting more than a common one (inverse document
  // frequency), then by how often; each file must hold at least half of the words.
  function search(terms, skip, limit, bias) {
    if (!terms.length || limit <= 0) return [];
    const need = Math.max(1, Math.ceil(terms.length / 2)), rows = [], df = new Map(terms.map(t => [t, 0]));
    for (const rel of files()) {
      const text = read(rel);if (!text) continue;
      const low = lower(text), found = terms.filter(t => hasWord(low, t) || hasWord(low, t.replace(/s$/, '')));
      found.forEach(t => df.set(t, df.get(t) + 1));
      if (found.length >= need && !skip.has(rel)) rows.push({ rel, low, found });
    }
    const n = files().length, idf = t => Math.log((n + 1) / (df.get(t) + 1));
    // Two goal words side by side ("morning brief") count again where the file has them together.
    const pairs = terms.slice(1).map((t, i) => [terms[i], t]);
    return rows.map(r => {
      let count = 0;for (const t of r.found) count += Math.min(50, r.low.split(t).length - 1);
      const together = pairs.filter(([a, b]) => r.low.includes(a + ' ' + b)).reduce((w, [a, b]) => w + 2 * (idf(a) + idf(b)), 0);
      return { rel: r.rel, weight: r.found.reduce((w, t) => w + idf(t), 0) + together + (bias && bias(r.rel) ? 0.5 : 0), count };
    }).sort((a, b) => b.weight - a.weight || b.count - a.count || a.rel.localeCompare(b.rel)).slice(0, limit).map(x => x.rel);
  }
  function select(goal, { agentId } = {}) {
    const words = goalTerms(goal), features = featuresFor(goal);
    const terms = [...new Set([...words, ...features.flatMap(f => featureNames(f).filter(n => !GENERIC.has(n))), ...(VISUAL.test(goal) ? VISUAL_TERMS : [])])];
    const out = [], seen = new Set();
    for (const f of features) for (const src of f.sources) {
      if (out.length >= maxSources) break;
      const key = src.path + '#' + (src.section || src.anchor || (src.match || []).join());
      if (seen.has(key)) continue;seen.add(key);
      const ex = sourceFor(src, terms);if (ex) { out.push(ex);seen.add(src.path); }
    }
    const bias = agentId === 'ux_analyst' ? rel => /^app\/public\/|^docs\//.test(rel) : null;
    for (const rel of search(words, seen, maxSources - out.length, bias)) {
      const ex = sourceFor({ path: rel }, terms);if (ex) out.push(ex);
    }
    return out;
  }
  return { select, featuresFor: goal => featuresFor(goal).map(f => f.id), goalTerms };
};
module.exports.FEATURES = FEATURES;

// The first turn's budget. A 4B model on the 6 GB GPU reads a prompt at about 113 tokens/s when its context spills to
// the CPU, so 6000 tokens of evidence is under a minute, and under two with a second worker queued. The budget never
// takes more of the mission context than leaves room for the answer and a few tool calls.
const CHARS_PER_TOKEN = 4;
const DEFAULT_EVIDENCE_TOKENS = 6000;
const EVIDENCE_HEADROOM_TOKENS = 5000; // system prompt, rules, tool definitions, tool results and the answer
function evidenceTokenBudget(tokens, numCtx) {
  const wanted = Number.isSafeInteger(tokens) && tokens > 0 ? tokens : DEFAULT_EVIDENCE_TOKENS;
  const room = Number.isSafeInteger(numCtx) && numCtx > 0 ? Math.max(1000, numCtx - EVIDENCE_HEADROOM_TOKENS) : Infinity;
  return Math.min(wanted, room);
}

// Source blocks arrive most relevant first (select above). Whole blocks are kept while they fit; the next one is cut
// to the room left when that is still worth reading; the rest are left for the tools.
const MIN_CUT_CHARS = 800;
const SEPARATOR = 2; // '\n\n' between blocks
function fitEvidence(blocks, budgetChars) {
  const kept = [];
  let used = 0;
  for (const block of blocks || []) {
    const text = String(block);
    const room = budgetChars - used - (kept.length ? SEPARATOR : 0);
    if (text.length <= room) { kept.push(text); used += text.length + (kept.length > 1 ? SEPARATOR : 0); continue; }
    if (room >= MIN_CUT_CHARS) { const cut = text.slice(0, room - 2) + ' …'; kept.push(cut); used += cut.length + (kept.length > 1 ? SEPARATOR : 0); }
    break;
  }
  return { blocks: kept, kept: kept.length, chars: used };
}
module.exports.fitEvidence = fitEvidence;
module.exports.evidenceTokenBudget = evidenceTokenBudget;
module.exports.CHARS_PER_TOKEN = CHARS_PER_TOKEN;
module.exports.DEFAULT_EVIDENCE_TOKENS = DEFAULT_EVIDENCE_TOKENS;

// The Coordinator's answer, checked for absence it can't back. Live (18 Oct): a worker read a few parts of a 3,900-line
// file, wrote that cranes, flags and fireworks were "not evident", and the Coordinator reported them as unimplemented;
// all of them exist. A sentence that says something does not exist, has no evidence or is missing stands only when it
// cites a find_in_project search that found nothing ([E-...]) or names one of that search's words. Any other such
// sentence is quoted in a caveat line put first in the answer. A caveat rather than a rewrite: it never garbles the
// model's sentence or hides what it said, and the owner sees both the claim and that it wasn't checked.
const ABSENCE = /\b(?:does(?:n['’]t| not) exist|do(?:n['’]t| not) exist|no evidence|lacks?(?: an?| any)? implementation|(?:is|are) missing|(?:is|are) not implemented|not (?:yet )?implemented|(?:is|are) absent)\b/i;
function absenceSentences(text) {
  return String(text || '').split(/\n+|(?<=[.!?])\s+(?=[*_"“([]*[A-Z0-9])/).map(s => s.trim()).filter(s => ABSENCE.test(s));
}
function checkAbsenceClaims(answer, searches = []) {
  const empty = searches.filter(s => s && s.kind === 'search' && s.matches === 0 && s.complete !== false);
  const backed = [], flagged = [];
  for (const sentence of absenceSentences(answer)) {
    const low = lower(sentence);
    const by = empty.find(s => sentence.includes(s.id) || String(s.query || '').toLowerCase().split(/[\s|,;"'`]+/).some(t => t.length >= 4 && low.includes(t)));
    if (by) backed.push({ sentence, search: by.id }); else flagged.push(sentence);
  }
  if (!flagged.length) return { answer, flagged, backed };
  const quote = s => '“' + (s.length > 160 ? s.slice(0, 157).trimEnd() + '…' : s).replace(/\*\*|__/g, '').replace(/^[-*#>\s]+/, '') + '”';
  const caveat = `Caveat: ${flagged.length === 1 ? 'one statement below says' : flagged.length + ' statements below say'} something is missing, but no worker searched the code for it, so it wasn't checked and may well exist: ${flagged.slice(0, 5).map(quote).join('; ')}${flagged.length > 5 ? '; …' : ''}`;
  return { answer: caveat + '\n\n' + answer, flagged, backed, caveat };
}
module.exports.checkAbsenceClaims = checkAbsenceClaims;
