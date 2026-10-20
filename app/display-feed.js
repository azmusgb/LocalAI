'use strict';
// What the Workshop display shows when the printer is idle (docs/WORKSHOP-DISPLAY.md › Local AI cards): a handful
// of short cards, built from what Home and Siri already say. Pure: the server gathers the inputs (GET
// /api/display/feed). Text is cut to what fits a 480×320 card: a title of 24 characters and a line of 90.

const cut = (s, n) => { const c = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return c.length > n ? c.slice(0, n - 1).join('') + '…' : c.join(''); };
const card = (kind, title, text, extra = {}) => ({ kind, title: cut(title, 24), text: cut(text, 90), ...extra });
const firstSentence = (s) => String(s || '').split(/(?<=[.!?])\s+/)[0] || '';

// needs: {count, speech} from glance.needsYouSummary; watch: watchdog findings; running: runs (newest first);
// weather: a sentence or null; image: {title, imageUrl} or null.
function buildFeed({ needs, watch = [], running = [], weather = null, image = null, now = Date.now() }) {
  const cards = [];
  cards.push(needs?.count
    ? card('needs', 'Needs you', firstSentence(needs.speech).replace(/^Needs you:\s*/, ''), { count: needs.count, tone: 'attention' })
    : card('needs', 'All clear', 'Nothing needs you right now.', { count: 0, tone: 'ok' }));
  for (const w of watch.slice(0, 2)) cards.push(card('watch', w.severity === 'high' ? 'Heads up' : 'Worth a look', w.title, { tone: w.severity === 'high' ? 'attention' : 'warning' }));
  if (running.length) {
    const top = running[0];
    const more = running.length > 1 ? ` · ${running.length - 1} more` : '';
    cards.push(card('running', 'Working on', `${top.title || 'A run'}${more}`, { count: running.length, tone: 'busy' }));
  }
  if (weather) cards.push(card('weather', 'Weather', weather, { tone: 'info' }));
  if (image?.imageUrl) cards.push(card('image', 'Latest image', image.title || 'An image', { imageUrl: image.imageUrl, tone: 'info' }));
  return { at: new Date(now).toISOString(), cards };
}

// The display decodes JPEG only; ComfyUI's /view converts with preview=jpeg;<quality>.
function jpegUrl(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('/api/images/view?')) return null;
  const u = new URL(imageUrl, 'http://x');
  u.searchParams.set('preview', 'jpeg;80');
  return u.pathname + u.search;
}

module.exports = { buildFeed, jpegUrl, cut };
