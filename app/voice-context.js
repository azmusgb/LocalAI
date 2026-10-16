'use strict';

// Facts the local model cannot know on its own, handed to it when answering by voice.

function partsOf(date, timeZone, options) {
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone, ...options }).formatToParts(date)) out[p.type] = p.value;
  return out;
}

function voiceFacts({ now = new Date(), timeZone = 'UTC', place = '' } = {}) {
  const d = partsOf(now, timeZone, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const h = partsOf(now, timeZone, { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });
  const hour24 = Number(h.hour) % 24;
  const hour12 = hour24 % 12 || 12;
  const period = hour24 >= 5 && hour24 < 12 ? 'morning' : hour24 >= 12 && hour24 < 17 ? 'afternoon' : hour24 >= 17 && hour24 < 22 ? 'evening' : 'night';
  return `Today is ${d.weekday}, ${d.month} ${d.day}, ${d.year}. It is ${hour12}:${h.minute} in the ${period} in ${timeZone}.` +
    (place ? ` The owner is in ${place}.` : '');
}

module.exports = { voiceFacts };
