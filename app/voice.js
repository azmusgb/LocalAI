'use strict';

// Spoken "Ask Local AI" (Siri on iPhone or Apple Watch): a rules-only router that decides what a dictated
// question is, and a filter that makes any answer safe to read aloud. No model calls here.

const NOISE = /^(?:(?:um+|uh+|uh huh|er+|erm|hm+|hmm+|mm+|ah+|oh+|eh|huh|like|so|okay|ok|yeah|hey|hello|hi)\b[\s,.!?-]*)*$/;

const REFUSE = /^(?:(?:please|hey|can you|could you|would you|go ahead and|just)\s+)*(?:approve|reject|deny|apply|deploy|ship|roll\s?back|restart|reboot|delete|remove|erase|wipe|destroy)\b|\bpowershell\b/;
const IMAGE = /^(?:(?:please|can you|could you)\s+)*(?:make|create|generate|draw|paint|render)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|drawing|illustration|painting)\s*(?:of\s+)?(.*)$/;
const MISSION = /^(?:(?:please|can you|could you)\s+)*(?:start|begin|launch|kick off|run)\s+(?:a\s+|the\s+)?mission\b\s*(?:(?:to|for|that|about|on)\s+)?(.*)$/;
const RESEARCH = /^(?:(?:please|can you|could you)\s+)*(?:research|investigate|dig into|look into)\s+(.+)$/;
const NEEDS = /\b(?:need(?:s)?\s+me|need(?:s)?\s+my\s+attention|waiting\s+for\s+me|anything\s+for\s+me|what\s+needs\s+me|what\s+do\s+i\s+need\s+to)\b/;
const HEALTH = /\b(?:local ai|appliance)\b.*\b(?:ok|okay|up|down|healthy|running|working|fine|status)\b|\b(?:health|status)\s+check\b/;
const TIME = /\bwhat(?:'s|\s+is)\s+(?:the\s+)?(?:current\s+)?(?:time|date|day)\b|\bwhat\s+time\s+is\s+it\b|\bwhat\s+day\s+is\s+(?:it|today)\b|\btoday's\s+date\b/;
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
  const sentences = s.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [];
  return sentences.slice(0, 2).map(x => x.trim()).filter(Boolean).join(' ');
}

module.exports = { classify, speakable };
