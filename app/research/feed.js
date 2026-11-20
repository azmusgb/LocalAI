'use strict';

// Feed reader for research intake: Atom and RSS text in, plain entries out. Pure: no I/O. The text comes from the
// internet, so this is a tolerant scanner rather than an XML parser: block boundaries are found with indexOf, the few
// regular expressions are single-pass with no nested quantifiers, and no entity is ever defined or expanded (a
// DOCTYPE or ENTITY declaration rejects the feed). Only the five named entities and numeric references are decoded.

class FeedError extends Error {
  constructor(message) { super(message); this.name = 'FeedError'; }
}

const DEFAULT_MAX_ENTRIES = 200;
const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const BLOCK_TAGS = new Set(['p', 'br', 'div', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table', 'hr', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer']);
const ATTR = /\s*([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/y;

const isNameEnd = c => c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13 || Number.isNaN(c); // > / space \t \n \r
const isBoundary = ch => ch === undefined || ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(ENTITY, (whole, ref) => {
    if (ref[0] !== '#') return NAMED[ref];
    const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    if (!(cp > 0 && cp <= 0x10FFFF) || (cp >= 0xD800 && cp <= 0xDFFF)) return whole;
    return String.fromCodePoint(cp);
  });
}

// Element content to a string: CDATA sections are literal, everything else has entities decoded once.
function unwrap(s) {
  let out = '', pos = 0;
  for (;;) {
    const open = s.indexOf('<![CDATA[', pos);
    if (open < 0) return out + decodeEntities(s.slice(pos));
    out += decodeEntities(s.slice(pos, open));
    const end = s.indexOf(']]>', open + 9);
    if (end < 0) return out + s.slice(open + 9);
    out += s.slice(open + 9, end);
    pos = end + 3;
  }
}

function tagEnd(s, from) {
  let quote = 0;
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (quote) { if (c === quote) quote = 0; } else if (c === 34 || c === 39) quote = c; else if (c === 62) return j;
  }
  return s.indexOf('>', from); // an unbalanced quote: fall back to the first '>'
}

// Remove markup from text that was HTML after the first decode. script and style go with their content.
function stripTags(s) {
  if (s.indexOf('<') < 0) return s;
  let out = '', pos = 0;
  const closer = /<\/(?:script|style)\b/gi;
  for (;;) {
    const lt = s.indexOf('<', pos);
    if (lt < 0) return out + s.slice(pos);
    const c = s.charCodeAt(lt + 1);
    const tagLike = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 47 || c === 33 || c === 63;
    if (!tagLike) { out += s.slice(pos, lt + 1); pos = lt + 1; continue; }
    out += s.slice(pos, lt);
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      if (e < 0) return out;
      pos = e + 3; continue;
    }
    let i = lt + 1;
    if (s[i] === '/') i++;
    const nameStart = i;
    while (i < s.length && !isNameEnd(s.charCodeAt(i))) i++;
    const name = s.slice(nameStart, i).toLowerCase();
    const gt = s.indexOf('>', i);
    if (gt < 0) return out;
    pos = gt + 1;
    if ((name === 'script' || name === 'style') && s[lt + 1] !== '/') {
      closer.lastIndex = pos;
      const m = closer.exec(s);
      if (!m) return out;
      const e = s.indexOf('>', m.index);
      if (e < 0) return out;
      pos = e + 1;
    } else if (BLOCK_TAGS.has(name)) out += ' ';
  }
}

// Whitespace and control characters (code points up to space, and DEL) collapse to one space.
function collapse(s) {
  let out = '', gap = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 32 || c === 127) { gap = out !== ''; continue; }
    if (gap) { out += ' '; gap = false; }
    out += s[i];
  }
  return out;
}
const plain = inner => collapse(unwrap(inner));
// Fields that may hold HTML: decode once, then strip markup and decode what was escaped inside it, until the text stops
// changing (at most 4 passes). A final strip means no tag survives however many times the source was escaped; a
// '<' not followed by a letter, '/', '!' or '?' (as in "a < b") is prose and stays.
function textOf(inner) {
  let s = unwrap(inner);
  for (let pass = 0; pass < 4; pass++) {
    const next = decodeEntities(stripTags(s));
    if (next === s) break;
    s = next;
  }
  return collapse(stripTags(s));
}

// The direct child elements of a block, in order, with the namespace prefix kept in qname and dropped from name.
// An element's content ends at its closing tag; a missing closing tag means "to the end".
function children(s) {
  const out = [];
  let pos = 0;
  while (pos < s.length) {
    const lt = s.indexOf('<', pos);
    if (lt < 0) break;
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); pos = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt + 9); pos = e < 0 ? s.length : e + 3; continue; }
    const first = s[lt + 1];
    if (first === '/' || first === '?' || first === '!') { pos = lt + 2; continue; }
    let i = lt + 1;
    while (i < s.length && !isNameEnd(s.charCodeAt(i))) i++;
    const qname = s.slice(lt + 1, i);
    if (!qname) { pos = lt + 1; continue; }
    const gt = tagEnd(s, i);
    if (gt < 0) break;
    const selfClosing = s[gt - 1] === '/';
    const attrs = s.slice(i, selfClosing ? gt - 1 : gt);
    let inner = '';
    pos = gt + 1;
    if (!selfClosing) {
      const close = '</' + qname;
      let at = s.indexOf(close, pos);
      while (at >= 0 && !isBoundary(s[at + close.length])) at = s.indexOf(close, at + 1);
      if (at < 0) { inner = s.slice(pos); pos = s.length; } else {
        inner = s.slice(pos, at);
        const e = s.indexOf('>', at);
        pos = e < 0 ? s.length : e + 1;
      }
    }
    out.push({ qname, name: qname.slice(qname.indexOf(':') + 1), attrs, inner });
  }
  return out;
}

const find = (list, name) => list.find(c => c.qname === name) || list.find(c => c.name === name);
const firstText = (list, names, read) => {
  for (const n of names) { const c = find(list, n); const v = c ? read(c.inner) : ''; if (v) return v; }
  return '';
};

function attr(attrs, name) {
  ATTR.lastIndex = 0;
  for (;;) {
    const m = ATTR.exec(attrs);
    if (!m) return '';
    if (m[1].toLowerCase() === name) return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
}

function findTag(s, name, from) {
  for (let at = s.indexOf('<' + name, from); at >= 0; at = s.indexOf('<' + name, at + 1))
    if (isBoundary(s[at + 1 + name.length])) return at;
  return -1;
}

function absoluteHttps(raw, baseUrl) {
  const value = raw.trim();
  if (!value) return '';
  try {
    const u = new URL(value, baseUrl);
    return u.protocol === 'https:' ? u.href : '';
  } catch { return ''; }
}

function isoDate(raw) {
  if (!/\d{4}/.test(raw)) return '';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function entryLink(list, baseUrl) {
  for (const c of list) {
    if (c.name !== 'link') continue;
    const href = attr(c.attrs, 'href');
    if (href) {
      const rel = attr(c.attrs, 'rel').toLowerCase();
      if (rel && rel !== 'alternate') continue;
      return absoluteHttps(href, baseUrl);
    }
    const text = plain(c.inner);
    if (text) return absoluteHttps(text, baseUrl);
  }
  return '';
}

function readEntry(block, kind, baseUrl) {
  const list = children(block);
  const url = entryLink(list, baseUrl);
  const id = firstText(list, [kind === 'atom' ? 'id' : 'guid'], plain) || url;
  if (!id) return null;
  return {
    id, url,
    title: firstText(list, ['title'], textOf),
    text: firstText(list, kind === 'atom' ? ['content', 'summary'] : ['content:encoded', 'description'], textOf),
    published: isoDate(firstText(list, kind === 'atom' ? ['published', 'updated'] : ['pubDate', 'dc:date'], plain))
  };
}

function parseFeed(xml, { baseUrl, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  if (typeof xml !== 'string' || /<!(?:doctype|entity)/i.test(xml)) throw new FeedError('not a feed');
  const roots = [['atom', 'feed', '</feed'], ['rss', 'rss', '</rss'], ['rss', 'rdf:RDF', '</rdf:RDF']]
    .map(([kind, tag, closeTag]) => ({ kind, closeTag, at: findTag(xml, tag, 0) }))
    .filter(r => r.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (!roots.length) throw new FeedError('not a feed');
  const { kind, closeTag, at: rootAt } = roots[0];
  const limit = Number.isInteger(maxEntries) && maxEntries >= 0 ? maxEntries : DEFAULT_MAX_ENTRIES;
  const tag = kind === 'atom' ? 'entry' : 'item';
  const entryClose = '</' + tag;

  const entries = [];
  let complete = 0, from = rootAt, firstEntry = -1;
  for (;;) {
    const open = findTag(xml, tag, from);
    if (open < 0) break;
    if (firstEntry < 0) firstEntry = open;
    const gt = tagEnd(xml, open + 1 + tag.length);
    if (gt < 0) break;
    let close = xml.indexOf(entryClose, gt + 1);
    while (close >= 0 && !isBoundary(xml[close + entryClose.length])) close = xml.indexOf(entryClose, close + 1);
    if (close < 0) break; // a truncated last entry is dropped
    complete++;
    from = close + entryClose.length;
    if (entries.length >= limit) break;
    if (xml[gt - 1] === '/') continue;
    const entry = readEntry(xml.slice(gt + 1, close), kind, baseUrl);
    if (entry) entries.push(entry);
  }
  if (!complete && xml.indexOf(closeTag, rootAt) < 0) throw new FeedError('not a feed');

  const rootEnd = tagEnd(xml, rootAt + 1);
  const header = rootEnd < 0 ? '' : xml.slice(rootEnd + 1, firstEntry < 0 ? xml.length : firstEntry);
  const top = children(header);
  let titleEl = find(top, 'title');
  if (!titleEl) { const channel = find(top, 'channel'); if (channel) titleEl = find(children(channel.inner), 'title'); }
  return { kind, title: titleEl ? textOf(titleEl.inner) : '', entries };
}

module.exports = { parseFeed, FeedError };
