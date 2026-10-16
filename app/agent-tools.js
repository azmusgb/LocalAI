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

function createResearchTools({ projectRoot, projectId = '', knowledgeStore = () => [], knowledgeScore, searxSearch, allowWeb = false }) {
  const tools = [
    tool('search_project_knowledge', 'Search indexed knowledge for the selected project. Returns matching excerpts with evidence IDs.', { query: stringSchema }, ['query'], async args => {
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
    }, ['path'], async args => {
      objectArgs(args, ['path', 'start_line', 'max_lines']);
      const relative = stringArg(args.path, 'path');
      checkFileName(relative);
      const start = args.start_line ?? 1, count = args.max_lines ?? 80;
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 120) throw new Error('Invalid line range');
      const root = await fs.realpath(projectRoot);
      const target = await fs.realpath(path.resolve(root, relative));
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
        const end = Math.min(lines.length, start + count - 1);
        const full = lines.slice(start - 1, end).join('\n'), content = full.slice(0, 8000);
        const source = `project:${resolvedRelative}#L${start}-L${end}`;
        const evidence = [evidenceRecord(source, content, { kind: 'file', title: resolvedRelative })];
        return { data: { path: resolvedRelative, startLine: start, endLine: end, totalLines: lines.length, content, truncated: full.length > content.length, moreLines: end < lines.length, evidenceId: evidence[0].id }, evidence };
      } finally { await handle.close(); }
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
