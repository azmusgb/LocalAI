'use strict';
// Messages for the Workshop display (docs/WORKSHOP-DISPLAY.md › Messages): a banner on the display, with an optional
// chime and one action (start its timer, or open a page). The display pulls them with its key, from the feed and the
// long poll, so nothing ever connects to the display and the display key gets no new powers. Kept in memory for 15
// minutes; each has a seq that only grows (milliseconds, so a restart never reuses one), and the display shows those
// newer than the last it showed.
//
// What gets here: POST /api/display/notify (a signed-in person, n8n, the Mac), and the phone notification kinds the
// owner picked for the display (setting display:alerts), with their own quiet hours: inside them the banner still
// shows but the chime stays off, except for failures.

const KINDS = ['needs-you', 'failed', 'service', 'finished'];
const TONES = ['info', 'ok', 'attention', 'warning', 'busy'];
const PAGES = ['localai', 'image', 'camera', 'printer'];
const KEEP_MS = 15 * 60 * 1000, MAX = 20, RATE = 6, RATE_MS = 60 * 1000;
const DEFAULTS = { kinds: [...KINDS], chime: true, quiet: { on: true, start: '22:00', end: '07:00' } };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const cut = (text, max) => { const chars = [...String(text ?? '').replace(/\s+/g, ' ').trim()]; return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join(''); };
const inQuiet = (q, hhmm) => !!q?.on && q.start !== q.end && (q.start < q.end ? hhmm >= q.start && hhmm < q.end : hhmm >= q.start || hhmm < q.end);
const TONE_OF = { 'needs-you': 'attention', failed: 'warning', service: 'attention', finished: 'ok' };

// A message from outside, checked; throws with a sentence for the caller.
function clean(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Send {title, text}');
  const title = cut(input.title, 24), text = cut(input.text, 120);
  if (!title) throw new Error('title is required');
  const tone = TONES.includes(input.tone) ? input.tone : 'info';
  let action = null;
  if (input.action != null) {
    const a = input.action;
    if (a?.type === 'timer' && Number.isInteger(a.minutes) && a.minutes >= 1 && a.minutes <= 240) action = { type: 'timer', minutes: a.minutes };
    else if (a?.type === 'show' && PAGES.includes(a.page)) action = { type: 'show', page: a.page };
    else throw new Error(`action must be {type:"timer", minutes:1-240} or {type:"show", page:${PAGES.join('|')}}`);
  }
  return { title, text, tone, chime: input.chime !== false, action };
}

function createDisplayMessages({ storage, now = Date.now, timeZone = process.env.TZ || 'America/New_York' }) {
  let list = [];
  let last = 0;
  const sends = [];
  const localTime = (t) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(t);
  const settings = () => ({ ...DEFAULTS, ...(storage.readSetting('display:alerts', null) || {}) });

  function prune(t) { list = list.filter((m) => t - m.seq < KEEP_MS).slice(-MAX); }
  function add(message, source) {
    const t = now();
    const seq = Math.max(t, last + 1);
    last = seq;
    prune(t);
    const m = { seq, ...message, source, at: Math.floor(t / 1000) };
    list.push(m);
    return m;
  }

  // POST /api/display/notify. At most 6 a minute, so a runaway automation can't flood the screen.
  function post(input, source = 'api') {
    const t = now();
    while (sends.length && t - sends[0] > RATE_MS) sends.shift();
    if (sends.length >= RATE) { const e = new Error('At most 6 messages a minute'); e.statusCode = 429; throw e; }
    const m = add(clean(input), source);
    sends.push(t);
    return m;
  }

  // A phone notification event (app/notify.js), when the owner wants that kind on the display.
  function fromNotification(event) {
    try {
      const s = settings();
      if (!event || !KINDS.includes(event.kind) || !s.kinds.includes(event.kind)) return null;
      const quiet = inQuiet(s.quiet, localTime(now()));
      const chime = !!s.chime && (!quiet || event.kind === 'failed');
      const page = event.kind === 'finished' && /image/i.test(String(event.tag || '')) ? 'image' : 'localai';
      return add({ title: cut(event.title || 'Local AI', 24), text: cut(event.body, 120), tone: TONE_OF[event.kind], chime, action: { type: 'show', page } }, `notify:${event.kind}`);
    } catch {
      return null; // a notification must never break what triggered it
    }
  }

  function updateSettings(patch = {}) {
    const s = settings();
    if (Array.isArray(patch.kinds)) s.kinds = patch.kinds.filter((k) => KINDS.includes(k));
    if (typeof patch.chime === 'boolean') s.chime = patch.chime;
    if (patch.quiet) {
      const q = { ...s.quiet, ...patch.quiet };
      if (!HHMM.test(q.start) || !HHMM.test(q.end)) throw new Error('Quiet hours are HH:MM');
      s.quiet = { on: !!q.on, start: q.start, end: q.end };
    }
    storage.writeSetting('display:alerts', s);
    return s;
  }

  // For the feed: the last 15 minutes, oldest first, without where each came from.
  function recent() { prune(now()); return list.map(({ source, ...m }) => m); }
  return { post, fromNotification, recent, latest: () => last, settings, updateSettings };
}

module.exports = { createDisplayMessages, clean, KINDS, PAGES };
