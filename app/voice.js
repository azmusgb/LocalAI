'use strict';

// Spoken "Ask Local AI" (Siri on iPhone or Apple Watch): a rules-only router that decides what a dictated
// question is, and a filter that makes any answer safe to read aloud. No model calls here.

const NOISE = /^(?:(?:um+|uh+|uh huh|er+|erm|hm+|hmm+|mm+|ah+|oh+|eh|huh|like|so|okay|ok|yeah|hey|hello|hi)\b[\s,.!?-]*)*$/;

const REFUSE = /^(?:(?:please|hey|can you|could you|would you|go ahead and|just)\s+)*(?:approve|reject|deny|apply|deploy|ship|roll\s?back|restart|reboot|delete|remove|erase|wipe|destroy)\b|\bpowershell\b/;
const IMAGE = /^(?:(?:please|can you|could you)\s+)*(?:make|create|generate|draw|paint|render)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|drawing|illustration|painting)\s*(?:of\s+)?(.*)$/;
const MISSION = /^(?:(?:please|can you|could you)\s+)*(?:start|begin|launch|kick off|run)\s+(?:a\s+|the\s+)?mission\b\s*(?:(?:to|for|that|about|on)\s+)?(.*)$/;
const RESEARCH = /^(?:(?:please|can you|could you)\s+)*(?:research|investigate|dig into|look into)\s+(.+)$/;
const NEEDS = /\b(?:need(?:s)?\s+me|need(?:s)?\s+my\s+attention|waiting\s+for\s+me|anything\s+for\s+me|what\s+needs\s+me|what\s+do\s+i\s+need\s+to)\b/;
const HEALTH = /\b(?:local\s?ai|appliance)\b.*\b(?:ok|okay|up|down|healthy|running|working|fine|status)\b|\b(?:health|status)\s+check\b/;
const TIME = /\bwhat(?:'s|s|\s+is)\s+(?:the\s+)?(?:current\s+)?(?:time|date|day)\b|\btell\s+me\s+(?:the\s+)?(?:time|date|day)\b|\bwhat\s+time\s+is\s+it\b|\bwhat\s+day\s+is\s+(?:it|today)\b|\btoday's\s+date\b/;
const WEATHER = /\b(?:weather|forecast|temperature|rain(?:ing)?|snow(?:ing)?|how\s+(?:hot|cold|warm))\b/;
const CURRENT = /\b(?:latest|news|current(?:ly)?|recent(?:ly)?|right\s+now|who\s+won|score\s+of|stock\s+price|price\s+of|last\s+(?:year|week|night)|this\s+(?:year|week)|yesterday|tonight)\b/;

function classify(input) {
  const t = String(input || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  if (!t || NOISE.test(t)) return { intent: 'empty' };
  if (REFUSE.test(t)) return { intent: 'refuse' };
  let m = t.match(IMAGE);
  if (m) return { intent: 'action', action: 'image', subject: m[1].replace(/[.!?]+$/, '').trim() };
  m = t.match(MISSION);
  if (m) return { intent: 'action', action: 'mission', subject: m[1].replace(/[.!?]+$/, '').trim() };
  m = t.match(RESEARCH);
  if (m) return { intent: 'action', action: 'research', subject: m[1].replace(/[.!?]+$/, '').trim() };
  if (NEEDS.test(t)) return { intent: 'needs' };
  if (HEALTH.test(t)) return { intent: 'health' };
  if (TIME.test(t) && !/\bin\s+[a-z]/.test(t)) return { intent: 'time' };
  if (WEATHER.test(t)) return { intent: 'weather' };
  if (CURRENT.test(t)) return { intent: 'current' };
  return { intent: 'chat' };
}

// Whatever the model sends back, make it something a voice can read: no markdown, links, emoji or lists,
// and no more than two sentences.
function speakable(input) {
  let s = String(input || '');
  s = s.replace(/```[a-z0-9]*\n?/gi, ' ');
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
  s = s.replace(/[\p{Extended_Pictographic}️‍⃣]/gu, ' ');
  s = s.replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gm, '');
  s = s.replace(/^[ \t]*>+[ \t]?/gm, '').replace(/^[ \t]*#+[ \t]*/gm, '');
  s = s.replace(/\b_+([^_\n]+?)_+\b/g, '$1').replace(/[*`~]/g, '').replace(/(^|\s)#+(?=\s|$)/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return firstSentences(s, 2);
}

// Titles and shorthand that end in a full stop without ending the sentence. "etc." and the clock times can end
// a sentence, so they only count as shorthand when a lower-case word follows.
const ALWAYS_ABBR = /^(?:e\.g\.|i\.e\.|mr\.|mrs\.|ms\.|dr\.|st\.|vs\.|u\.s\.)$/i;
const SOMETIMES_ABBR = /^(?:etc\.|a\.m\.|p\.m\.)$/i;

// A sentence ends at . ! or ? followed by whitespace; decimals (3.5) never qualify, abbreviations are skipped.
function firstSentences(s, count) {
  const out = [];
  let start = 0;
  const re = /[.!?]+(?=\s|$)/g;
  let m;
  while ((m = re.exec(s))) {
    const end = m.index + m[0].length;
    const word = s.slice(0, end).split(/\s/).pop();
    const next = s.slice(end).trimStart().charAt(0);
    if (ALWAYS_ABBR.test(word) || (/^no\.$/i.test(word) && /\d/.test(next)) || (SOMETIMES_ABBR.test(word) && /[a-z]/.test(next))) continue;
    out.push(s.slice(start, end).trim());
    start = end;
    if (out.length === count) return out.join(' ');
  }
  const rest = s.slice(start).trim();
  if (rest) out.push(rest);
  return out.join(' ');
}

// "New question" / "start over" at the front of an ask forces a fresh thread; the rest is the question.
const RESET = /^\s*(?:ok(?:ay)?[,.]?\s+)?(?:new\s+question|start\s+over|new\s+conversation)\b[\s,.:;!-]*/i;
function stripReset(input) {
  const s = String(input || '');
  return RESET.test(s) ? { fresh: true, text: s.replace(RESET, '').trim() } : { fresh: false, text: s.trim() };
}

// Follow-up threads for Siri: an ask within windowMs of the last one continues the same conversation, so
// "and tomorrow?" works with no state in the shortcut. One instance per server: the thread is global, so two devices asking within the window share it. The window runs from the previous ask, not from its answer. Turns on a thread run one at a
// time (run), so overlapping asks answer in order and the history stays consistent.
function createVoiceThreads({ now = Date.now, windowMs = 300000, maxTurns = 6 } = {}) {
  let current = null; // { id, turns: [{user, answer}], last, tail }
  const history = id => current && current.id === id
    ? current.turns.slice(-maxTurns).flatMap(t => [{ role: 'user', content: t.user }, { role: 'assistant', content: t.answer }])
    : [];
  return {
    take(text) {
      const t = now();
      if (!current || stripReset(text).fresh || t - current.last > windowMs) {
        current = { id: 't-' + require('node:crypto').randomBytes(16).toString('hex'), turns: [], last: t, tail: Promise.resolve() };
      }
      current.last = t;
      return { threadId: current.id };
    },
    history,
    record(threadId, userText, answer) {
      if (!current || current.id !== threadId) return;
      current.turns.push({ user: String(userText), answer: String(answer) });
      current.turns = current.turns.slice(-maxTurns);
    },
    // Run fn after the earlier turns on this thread have finished, waiting at most waitMs for them: a stuck
    // turn must not block later asks (they go ahead with the history recorded so far, and the late turn still
    // records when it finishes). A failed turn does not block the next.
    run(threadId, fn, { waitMs = 6000 } = {}) {
      const th = current && current.id === threadId ? current : { tail: Promise.resolve() };
      const before = th.tail;
      const gate = new Promise(resolve => {
        const timer = setTimeout(resolve, waitMs);
        before.then(() => { clearTimeout(timer); resolve(); });
      });
      const result = gate.then(fn);
      th.tail = result.catch(() => {});
      return result;
    }
  };
}

// Race a promise against a time budget. Settles in time -> {done:true, value} (or rejects); otherwise
// {done:false, later} where later is the same promise, still running, so the caller can finish the job.
function withBudget(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { promise.catch(() => {}); resolve({ done: false, later: promise }); }, ms);
    promise.then(value => { clearTimeout(timer); resolve({ done: true, value }); }, error => { clearTimeout(timer); reject(error); });
  });
}

// A source named for the ear: the bare host, no "www.".
function siteName(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./i, ''); } catch { return ''; }
}

// "and tomorrow?", "what about tonight?", "today?": a question that names only a time.
const TIME_ONLY = /^(?:(?:and|what about|how about|ok(?:ay)?)\s+)*(?:for\s+)?(?:right\s+now|now|today|tomorrow|tonight)(?:\s+then)?\s*[?.!]*$/;
function timeOnly(input) {
  return TIME_ONLY.test(String(input || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim());
}

module.exports = { timeOnly, siteName, withBudget, classify, speakable, stripReset, createVoiceThreads };
