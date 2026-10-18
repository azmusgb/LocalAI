'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function evidenceRecord(source, text, extra = {}) {
  const id = 'E-' + createHash('sha256').update(source + '\n' + text).digest('hex').slice(0, 16);
  return { ...extra, id, source, excerpt: text.slice(0, 1200), excerptTruncated: text.length > 1200 };
}

function objectArgs(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unexpected argument');
}
function stringArg(value, name, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be a nonempty string of at most ${max} characters`);
  return value.trim();
}
function tool(name, description, properties, required, execute) {
  return { name, definition: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }, execute };
}
const stringSchema = { type: 'string' };
const deniedPart = part => part.startsWith('.') || /^(node_modules|data|reports|logs|backups|credentials|secrets|tokens)$/i.test(part);
const allowedExtension = /\.(js|cjs|mjs|ts|tsx|jsx|json|md|txt|css|html|py|rs|go|java|cs|yaml|yml|toml)$/i;
function checkFileName(relative) {
  if (!relative || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes('\\') || relative.split('/').some(part => part === '..' || deniedPart(part)) || !allowedExtension.test(relative)) {
    throw new Error('Only permitted text files inside the configured project root may be read');
  }
}

// Paths as the evidence labels spell them (mission-evidence.js): the app folder is app/, and the deploy's copy of
// docs/ and host/ (repo-context) is docs/ and host/. read_project_file accepts these spellings.
function aliasesFor(relative) {
  return [relative, ...(/^app\//.test(relative) ? [relative.slice(4)] : []), ...(/^(docs|host)\//.test(relative) ? ['repo-context/' + relative] : [])];
}
const labelFor = rel => rel.startsWith('repo-context/') ? rel.slice('repo-context/'.length) : 'app/' + rel;

// find_in_project: the lines that contain a name or word, with their line numbers, so a worker reads exactly those
// lines instead of paging through a 4,000-line bundle, and so "it isn't there" rests on a search rather than on the few
// parts it happened to read. Same files as read_project_file: inside the project root, no hidden, credential,
// generated-data or dependency paths, no symbolic links, text files of at most 1 MiB.
const FIND_MATCHES = 20, FIND_LINE_CHARS = 160, FIND_MAX_FILES = 4000, FIND_MAX_BYTES = 32 * 1024 * 1024;
function findTerms(query) {
  const words = query.toLowerCase().replace(/["'`]/g, ' ').split(/[\s|,;]+/).filter(w => w.length >= 2);
  return [...new Set(words)].slice(0, 6);
}
function snippet(line, at) {
  if (line.length <= FIND_LINE_CHARS) return line.trim();
  const from = Math.max(0, at - 40);
  return (from ? '…' : '') + line.slice(from, from + FIND_LINE_CHARS).trim() + (from + FIND_LINE_CHARS < line.length ? '…' : '');
}
async function findInProject(projectRoot, query, scope, maxChars) {
  const terms = findTerms(query);
  if (!terms.length) throw new Error('query must name at least one word of two or more characters');
  const root = await fs.realpath(projectRoot);
  let start = root, startRel = '';
  if (scope) {
    if (path.isAbsolute(scope) || /^[a-z]:/i.test(scope) || scope.includes('\\') || scope.split('/').some(part => part === '..' || deniedPart(part))) throw new Error('Only permitted paths inside the configured project root may be searched');
    let found = null;
    for (const candidate of aliasesFor(scope.replace(/\/+$/, ''))) { try { await fs.access(path.resolve(root, candidate)); found = candidate; break; } catch { /* try the next spelling */ } }
    if (!found) throw new Error(`No file or folder ${scope} in the project`);
    start = await fs.realpath(path.resolve(root, found));
    startRel = path.relative(root, start).split(path.sep).join('/');
    if (startRel.startsWith('..') || path.isAbsolute(startRel) || startRel.split('/').some(deniedPart)) throw new Error('Only permitted paths inside the configured project root may be searched');
  }
  const files = [];let complete = true;
  const walk = async (dir, rel) => {
    let entries;try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= FIND_MAX_FILES) { complete = false; return; }
      if (deniedPart(e.name)) continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), childRel);
      else if (e.isFile() && allowedExtension.test(e.name)) files.push(childRel);
    }
  };
  const top = await fs.lstat(start);
  if (top.isFile()) { checkFileName(startRel); files.push(startRel); } else if (top.isDirectory()) await walk(start, startRel); else throw new Error('Only regular files and folders may be searched');
  const hits = [], perFile = new Map();let bytes = 0, searched = 0;
  for (const rel of files) {
    let text;
    try { const st = await fs.stat(path.join(root, rel)); if (st.size > 1024 * 1024) continue; if (bytes + st.size > FIND_MAX_BYTES) { complete = false; break; } bytes += st.size; text = await fs.readFile(path.join(root, rel), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    searched++;
    const lines = text.split(/\r?\n/), label = labelFor(rel);
    for (let n = 0; n < lines.length; n++) {
      const low = lines[n].toLowerCase(), found = terms.filter(t => low.includes(t));
      if (!found.length) continue;
      hits.push({ path: label, line: n + 1, score: found.length, text: snippet(lines[n], low.indexOf(found[0])) });
      perFile.set(label, (perFile.get(label) || 0) + 1);
    }
  }
  // Lines with more of the words first, then in file order.
  const ranked = hits.map((h, i) => ({ h, i })).sort((a, b) => b.h.score - a.h.score || a.i - b.i).map(x => x.h);
  const where = scope || 'the project';
  const build = count => {
    const matches = ranked.slice(0, count).map(({ path: p, line, text }) => ({ path: p, line, text }));
    const evidenceText = hits.length ? matches.map(m => `${m.path}:${m.line}: ${m.text}`).join('\n') : `No line contains ${terms.map(t => '"' + t + '"').join(' or ')} in ${where} (${searched} files searched${complete ? '' : ', search stopped early'}).`;
    const evidence = [evidenceRecord(`find:${query}${scope ? ' in ' + scope : ''}`, evidenceText, { kind: 'search', title: `find_in_project "${query}"`, query, scope: scope || '', matches: hits.length, complete })];
    const data = { query, path: scope || '', terms, filesSearched: searched, totalMatches: hits.length, matches, files: [...perFile].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, c]) => ({ path: p, count: c })), evidenceId: evidence[0].id };
    if (!complete) data.complete = false;
    if (!hits.length) data.note = complete ? `Nothing found: no line in ${where} contains ${terms.join(' or ')}. You may say it was not found by this search, citing [${evidence[0].id}].` : 'Nothing found, but the search stopped early; narrow it with path before saying anything is absent.';
    else if (count < hits.length) data.note = `Showing ${count} of ${hits.length} matching lines; read one with read_project_file (path, start_line), or narrow the query or path.`;
    return { data, evidence };
  };
  // The caller's room (agent-runtime.js) bounds the result: fewer lines come back rather than a refusal.
  const fits = r => !maxChars || JSON.stringify({ ok: true, ...r }).length <= maxChars;
  for (let count = Math.min(FIND_MATCHES, hits.length); count >= 0; count = count > 5 ? count - 5 : count - 1) {
    const result = build(count);
    if (fits(result)) return result;
  }
  throw new Error('Not enough room left in the model context to search; write up what you have');
}

function createResearchTools({ projectRoot, projectId = '', knowledgeStore = () => [], knowledgeScore, searxSearch, allowWeb = false }) {
  const tools = [
    tool('search_project_knowledge', 'Search indexed knowledge documents for the selected project (not the app code: use find_in_project for code). Returns matching excerpts with evidence IDs.', { query: stringSchema }, ['query'], async args => {
      objectArgs(args, ['query']);
      const query = stringArg(args.query, 'query');
      const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_-]{2,}/g) || [])];
      const score = knowledgeScore || ((q, text) => terms.filter(term => text.toLowerCase().includes(term)).length);
      const hits = [];
      for (const doc of knowledgeStore().filter(doc => String(doc.projectId || '') === projectId)) {
        const chunks = Array.isArray(doc.chunks) ? doc.chunks : [doc.content || doc.text || ''];
        chunks.forEach((text, index) => {
          if (typeof text !== 'string') return;
          const rank = score(query, text);
          if (rank > 0) hits.push({ doc, text, index, rank });
        });
      }
      const selected = hits.sort((a, b) => b.rank - a.rank).slice(0, 5);
      const evidence = selected.map(({ doc, text, index }) => evidenceRecord(`knowledge:${doc.id}#chunk-${index}`, text.slice(0, 2400), { kind: 'knowledge', title: String(doc.name || doc.id).slice(0, 200) }));
      return { data: { matches: selected.map(({ text, rank }, i) => ({ evidenceId: evidence[i].id, source: evidence[i].source, text: text.slice(0, 2400), score: rank, truncated: text.length > 2400 })), moreMatches: hits.length > selected.length }, evidence };
    }),
    tool('read_project_file', 'Read a text file relative to the configured project root. Hidden, credential, generated-data and dependency paths are unavailable. Specify a line range for focused evidence.', {
      path: stringSchema, start_line: { type: 'integer', minimum: 1 }, max_lines: { type: 'integer', minimum: 1, maximum: 120 },
    }, ['path'], async (args, { maxChars } = {}) => {
      objectArgs(args, ['path', 'start_line', 'max_lines']);
      const relative = stringArg(args.path, 'path');
      checkFileName(relative);
      const start = args.start_line ?? 1, count = args.max_lines ?? 80;
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 120) throw new Error('Invalid line range');
      const root = await fs.realpath(projectRoot);
      // Evidence labels are repo paths ("app/public/ui.js", "docs/GRIDCRAFT.md"); the root is the app folder, and the
      // deploy copies docs/ and host/ into its repo-context folder (mission-evidence.js).
      const aliases = aliasesFor(relative);
      let chosen = relative;
      for (const candidate of aliases) { try { await fs.access(path.resolve(root, candidate)); chosen = candidate; break; } catch { /* try the next spelling */ } }
      const target = await fs.realpath(path.resolve(root, chosen));
      const resolvedRelative = path.relative(root, target).split(path.sep).join('/');
      checkFileName(resolvedRelative);
      const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('File must be regular text and at most 1 MiB');
        // A fixed-size read also bounds files that grow after stat().
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 1024 * 1024) throw new Error('File exceeds 1 MiB');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
        if (text.includes('\0')) throw new Error('Binary files are unavailable');
        const lines = text.split(/\r?\n/);
        if (start > lines.length) throw new Error(`File has only ${lines.length} lines`);
        const asked = Math.min(lines.length, start + count - 1);
        const piece = (end, cap = 8000) => {
          const full = lines.slice(start - 1, end).join('\n'), content = full.slice(0, cap);
          const source = `project:${resolvedRelative}#L${start}-L${end}`;
          const evidence = [evidenceRecord(source, content, { kind: 'file', title: resolvedRelative })];
          const data = { path: resolvedRelative, startLine: start, endLine: end, totalLines: lines.length, content, truncated: full.length > content.length, moreLines: end < lines.length, evidenceId: evidence[0].id };
          if (end < asked) Object.assign(data, { fitted: true, note: `Showing lines ${start}–${end} of the ${start}–${asked} you asked for, to fit the room left; ask for the next part from line ${end + 1}` });
          return { data, evidence };
        };
        // The caller's room (agent-runtime.js) bounds the result: the largest run of whole lines from start_line that
        // fits comes back with a note, rather than a refusal that costs the model a turn.
        const fits = r => !maxChars || JSON.stringify({ ok: true, ...r }).length <= maxChars;
        let result = piece(asked);
        if (!fits(result)) {
          let lo = start, hi = asked - 1, best = null;
          while (lo <= hi) { const mid = (lo + hi) >> 1, r = piece(mid); if (fits(r)) { best = r; lo = mid + 1; } else hi = mid - 1; }
          // One long line (a bundle) is cut to fit; below a few hundred characters there is nothing worth reading.
          if (!best) { const one = piece(start), cap = one.data.content.length - (JSON.stringify({ ok: true, ...one }).length - maxChars) - 16; if (cap >= 300) { best = piece(start, cap); best.data.fitted = true; best.data.note = `Showing the start of line ${start} to fit the room left; write up what you have or ask for a smaller part`; } }
          if (!best || !fits(best)) throw new Error('Not enough room left in the model context to read more; write up what you have');
          result = best;
        }
        return result;
      } finally { await handle.close(); }
    }),
    tool('find_in_project', 'Find the lines in the project code and docs that contain a name or word (for example drawCrane, scaffolding, fireworks). Returns up to 20 lines with file paths and line numbers to read with read_project_file. Several words find lines with any of them. path narrows the search to a file or folder (for example app/public/ui.js). An empty result is the only evidence that something is absent.', {
      query: stringSchema, path: stringSchema,
    }, ['query'], async (args, { maxChars } = {}) => {
      objectArgs(args, ['query', 'path']);
      const query = stringArg(args.query, 'query', 200);
      const scope = args.path === undefined || args.path === '' ? '' : stringArg(args.path, 'path');
      return findInProject(projectRoot, query, scope, maxChars);
    }),
  ];
  if (allowWeb && typeof searxSearch === 'function') tools.push(tool('search_web', 'Search the public web using SearXNG. Queries leave the local machine. Search snippets are evidence, not verified full-page content.', { query: stringSchema }, ['query'], async (args, { signal } = {}) => {
    objectArgs(args, ['query']);
    const query = stringArg(args.query, 'query');
    const rows = (await searxSearch(query, signal)).slice(0, 5).filter(row => {
      try { return ['http:', 'https:'].includes(new URL(row.url).protocol); } catch { return false; }
    });
    const evidence = rows.map(row => evidenceRecord(row.url, String(row.content || '').slice(0, 2400), { kind: 'web', title: String(row.title || '').slice(0, 200) }));
    return { data: { matches: rows.map((row, i) => ({ title: evidence[i].title, url: row.url, snippet: String(row.content || '').slice(0, 2400), evidenceId: evidence[i].id })) }, evidence };
  }));
  return tools;
}

module.exports = { createResearchTools, evidenceRecord, tool, objectArgs, stringArg };
