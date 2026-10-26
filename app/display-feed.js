'use strict';
const crypto = require('node:crypto');
// What the Workshop display shows when the printer is idle (docs/WORKSHOP-DISPLAY.md › Local AI cards): a handful
// of short cards, built from what Home and Siri already say. Pure: the server gathers the inputs (GET
// /api/display/feed). Text is cut to what fits a 480×320 card: a title of 24 characters and a line of 90.

const cut = (s, n) => { const c = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return c.length > n ? c.slice(0, n - 1).join('') + '…' : c.join(''); };
const card = (kind, title, text, extra = {}) => ({ kind, title: cut(title, 24), text: cut(text, 90), ...extra });
const firstSentence = (s) => String(s || '').split(/(?<=[.!?])\s+/)[0] || '';

// needs: {count, speech} from glance.needsYouSummary; watch: watchdog findings; running: runs (newest first);
// done: runs that finished lately (newest first; images left out); weather: a sentence or null; images: up to 6
// {title, imageUrl, at} (newest first; at: when it was made, epoch seconds); disk: {label, freeBytes, totalBytes} of
// the fullest disk, or null. The older single `image` still works.
//
// Feed v2 (Workshop OS 12.6): every card has an id (stable while it means the same thing, so the display can tell a
// new card), at (epoch seconds, when known) and ask (the question the display asks when the card is tapped).
const ASK = { lab: null, needs: 'needs', watch: 'health', running: 'running', done: 'today', weather: 'weather', image: null, disk: 'health', playing: null, home: null, materials: 'health' };
const sec = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? Math.floor(t / 1000) : undefined; };
const ago = (atSec, now) => {
  const s = Math.max(0, Math.floor(now / 1000) - atSec);
  return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : 'yesterday';
};
const gb = (n) => `${Math.round(n / 1e9)} GB`;

// piNeeds: Pi Hub's one "Needs you" list ({items}, app/pi-hub.js needs()), or null when the hub didn't answer. It goes
// out as feed.needs [{id, tone, title, detail, source}], at most 6, title cut to 28 and detail to 112 (what the display
// shows), in the hub's order; it never becomes cards (the hub reads the cards, so that would loop). lab: the Print lab
// cards (app/print-lab.js labCards), after the needs card.
const NEED_TONES = new Set(['bad', 'attention', 'warn']);
const str = (v) => (typeof v === 'string' ? v : '');
function needsOf(piNeeds) {
  if (!piNeeds || !Array.isArray(piNeeds.items)) return null;
  return piNeeds.items.filter((i) => i && typeof i === 'object' && str(i.id) && str(i.title)).slice(0, 6).map((i) => ({
    id: cut(i.id, 64), tone: NEED_TONES.has(i.tone) ? i.tone : 'warn', title: cut(i.title, 28), detail: cut(str(i.detail), 112), source: cut(str(i.source), 24)
  }));
}

function buildFeed({ needs, piNeeds = null, lab = [], watch = [], running = [], done = [], weather = null, image = null, images = null, disk = null, pi = null, materials = null, now = Date.now() }) {
  const cards = [];
  const add = (kind, id, title, text, extra = {}) => {
    const c = card(kind, title, text, extra);
    c.id = String(id).slice(0, 48);
    if (c.at === undefined) delete c.at;
    if (ASK[kind]) c.ask = ASK[kind];
    cards.push(c);
  };
  // "All clear" only when nothing else on the feed is a problem. The needs card counts approvals and replies, so beside
  // a problem card (a full disk, the Pi, a low spool) it says just that, instead of contradicting it.
  const used = disk && disk.totalBytes > 0 ? 1 - disk.freeBytes / disk.totalBytes : 0;
  const problems = watch.length > 0 || lab.some((l) => l.tone === 'attention') || (pi?.issues || []).length > 0 || used >= 0.8 || (materials?.summary?.low || 0) > 0;
  add('needs', needs?.count ? `needs-${needs.count}` : 'needs-0', needs?.count ? 'Needs you' : problems ? 'No approvals' : 'All clear',
    needs?.count ? firstSentence(needs.speech).replace(/^Needs you:\s*/, '') : problems ? 'Nothing is waiting for your answer.' : 'Nothing needs you right now.',
    { count: needs?.count || 0, tone: needs?.count ? 'attention' : 'ok' });
  // Print lab: Lab · E-021 while it prints, then Judge E-021 until a verdict (or 24 h). Only these fields, as strings.
  for (const l of (Array.isArray(lab) ? lab : []).slice(0, 1)) {
    add('lab', l.id, l.title, l.text, { tone: l.tone === 'attention' ? 'attention' : 'busy', ...(l.ask === 'lab-judge' ? { ask: 'lab-judge' } : {}), ...(typeof l.run === 'string' && l.run ? { run: l.run.slice(0, 24) } : {}) });
  }
  for (const w of watch.slice(0, 2)) add('watch', `watch-${w.id || w.title}`, w.severity === 'high' ? 'Heads up' : 'Worth a look', w.title, { tone: w.severity === 'high' ? 'attention' : 'warning', at: sec(w.since) });
  // The Pi hub's own issues (app/pi-hub.js), as "Pi: <what>".
  for (const i of (pi?.issues || []).slice(0, 1)) add('home', `home-${i.what}`, `Pi: ${i.what}`, i.say || 'Needs a look.', { tone: i.tone === 'bad' ? 'attention' : 'warning' });
  if (running.length) {
    const top = running[0];
    const more = running.length > 1 ? ` · ${running.length - 1} more` : '';
    add('running', `running-${top.id || top.title}`, 'Working on', `${top.title || 'A run'}${more}`, { count: running.length, tone: 'busy', at: sec(top.startedAt || top.createdAt) });
  }
  // What Plex on the Pi is playing: the title, how far in, paused, and where.
  const play = pi?.playing?.[0];
  if (play) {
    const bits = [play.title, play.state === 'paused' ? 'paused' : play.minutesLeft != null ? `${play.minutesLeft} min left` : play.progress != null && `${play.progress}%`, play.where].filter(Boolean);
    const more = pi.playing.length > 1 ? ` · ${pi.playing.length - 1} more` : '';
    add('playing', `playing-${play.title}`, 'Now playing', bits.join(' · ') + more, { tone: 'busy', ...(play.progress != null ? { percent: play.progress } : {}) });
  }
  const fin = done[0];
  if (fin) {
    const at = sec(fin.finishedAt);
    const failed = fin.status === 'failed';
    add('done', `done-${fin.id || fin.title}`, failed ? 'Didn\'t finish' : 'Finished', `${String(fin.title || 'A run').split('\n')[0]}${at ? ` · ${ago(at, now)}` : ''}`, { tone: failed ? 'warning' : 'ok', at });
  }
  if (weather) add('weather', 'weather', 'Weather', weather, { tone: 'info' });
  // While something plays, its poster leads the pictures (the display opens it from the Now playing card).
  const posterPic = play?.poster ? [{ title: `Now playing · ${play.title}`, imageUrl: '/api/display/poster?n=0', at: Math.floor(now / 1000) }] : [];
  const pics = [...posterPic, ...(images || (image ? [image] : []))].filter((i) => i?.imageUrl).slice(0, 6);
  if (pics.length) add('image', `image-${pics[0].at || (pics[0].imageUrl.match(/filename=([^&]+)/) || [])[1] || 'latest'}`, 'Latest image', pics[0].title || 'An image', { imageUrl: pics[0].imageUrl, tone: 'info', at: pics[0].at });
  if (disk && disk.totalBytes > 0) {
    const used = 1 - disk.freeBytes / disk.totalBytes;
    add('disk', `disk-${disk.label}`, 'Disk', `${disk.label} · ${gb(disk.freeBytes)} free of ${gb(disk.totalBytes)}`, { tone: used >= 0.9 ? 'attention' : used >= 0.8 ? 'warning' : 'info', percent: Math.round(used * 100) });
  }
  // Materials: the spools in Bambuddy on the Pi (app/materials.js)
  if (materials?.summary) {
    const s = materials.summary;
    const tone = s.low > 0 ? 'warning' : s.unknown > 0 ? 'info' : 'ok';
    // Bambuddy's summary (app/materials.js) words its own status; the counts are the fallback.
    const text = materials.status || (s.low > 0 ? `${s.low} spool${s.low > 1 ? 's' : ''} low`
      : s.loaded > 0 ? `${s.loaded} spools loaded · ${s.spools} in inventory`
      : `${s.spools} spools in stock`);
    add('materials', `materials-${s.low ? 'low' : 'ok'}`, 'Materials', text, { tone });
  }
  const feed = { v: 2, at: new Date(now).toISOString(), cards };
  const needList = needsOf(piNeeds);
  if (needList) feed.needs = needList;
  if (pics.length) feed.images = pics.map((i) => ({ title: cut(i.title || 'An image', 90), imageUrl: i.imageUrl, ...(Number.isFinite(i.at) ? { at: i.at } : {}) }));
  return feed;
}

// Display Ask answers that need no model (GET /api/display/ask). today: what finished since local midnight; next:
// approvals waiting and work queued; weather: the sentence, or how to turn it on.
function todaySentence(doneToday) {
  if (!doneToday.length) return 'Nothing has finished yet today.';
  const names = doneToday.slice(0, 3).map((r) => String(r.title || 'a run').split('\n')[0].trim().slice(0, 50));
  return `${doneToday.length === 1 ? 'One thing' : `${doneToday.length} things`} finished today: ${names.join('; ')}${doneToday.length > 3 ? '; …' : ''}.`;
}
function nextSentence({ approvals = [], queued = [] }) {
  const parts = [];
  if (approvals.length) parts.push(`${approvals.length === 1 ? 'An approval waits' : `${approvals.length} approvals wait`}: ${approvals.slice(0, 2).map((a) => String(a.title || 'approval').slice(0, 50)).join('; ')}`);
  if (queued.length) parts.push(`${queued.length} queued: ${queued.slice(0, 2).map((r) => String(r.title || 'a run').split('\n')[0].slice(0, 50)).join('; ')}`);
  return parts.length ? `${parts.join('. ')}.` : 'Nothing is waiting on you or queued.';
}

// The display decodes JPEG only; ComfyUI's /view converts with preview=jpeg;<quality>.
function jpegUrl(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('/api/images/view?')) return null;
  const u = new URL(imageUrl, 'http://x');
  u.searchParams.set('preview', 'jpeg;80');
  return u.pathname + u.search;
}

// What the display's long poll compares: the cards and pictures, without their times and "… ago" words.
function signature(feed) {
  const parts = (feed.cards || []).map((c) => [c.kind, c.id, c.tone, c.count ?? '', c.kind === 'done' ? '' : c.text].join('|'));
  for (const i of feed.images || []) parts.push(i.imageUrl);
  for (const m of feed.messages || []) parts.push(`m${m.seq}`);
  for (const n of feed.needs || []) parts.push(`n${n.id}|${n.tone}|${n.title}|${n.detail}`);
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

module.exports = { signature, buildFeed, jpegUrl, cut, todaySentence, nextSentence };
