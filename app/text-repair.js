'use strict';
// Repairs text that was UTF-8 but got decoded as Windows-1252 (often several times over, by Windows PowerShell),
// e.g. "×" -> "Ã—" -> "ÃƒÂ—". Each run of non-ASCII characters is turned back into the bytes it was read from
// and decoded as UTF-8 again, until it stops changing. A run is only replaced when that yields valid UTF-8, so
// genuine accented text ("café", "naïve") and other scripts are left alone.

// Windows-1252 characters in 0x80-0x9F; other code points below 0x100 map to themselves.
const CP1252 = new Map([[0x20AC,0x80],[0x201A,0x82],[0x0192,0x83],[0x201E,0x84],[0x2026,0x85],[0x2020,0x86],[0x2021,0x87],[0x02C6,0x88],[0x2030,0x89],[0x0160,0x8A],[0x2039,0x8B],[0x0152,0x8C],[0x017D,0x8E],[0x2018,0x91],[0x2019,0x92],[0x201C,0x93],[0x201D,0x94],[0x2022,0x95],[0x2013,0x96],[0x2014,0x97],[0x02DC,0x98],[0x2122,0x99],[0x0161,0x9A],[0x203A,0x9B],[0x0153,0x9C],[0x017E,0x9E],[0x0178,0x9F]]);
const SPECIALS = [...CP1252.keys()].map(c => String.fromCodePoint(c)).join('');
const RUN = new RegExp(`[\\u0080-\\u00FF${SPECIALS}]{2,}`, 'g');
// A lead byte of a multi-byte UTF-8 sequence (as Windows-1252 shows it) followed by a continuation byte.
const LOOKS_BROKEN = new RegExp(`[\\u00C2-\\u00F4][\\u0080-\\u00BF${SPECIALS}]`);

function decodeOnce(run) {
  const bytes = [];
  for (const ch of run) {
    const c = ch.codePointAt(0);
    if (c < 0x100) bytes.push(c);
    else if (CP1252.has(c)) bytes.push(CP1252.get(c));
    else return null;
  }
  const text = Buffer.from(bytes).toString('utf8');
  return text.includes('�') ? null : text;
}

function repairRun(run) {
  let current = run;
  for (let i = 0; i < 6 && LOOKS_BROKEN.test(current); i++) {
    const next = decodeOnce(current);
    if (next === null || next === current) break;
    current = next;
  }
  return current;
}

function repairText(value) {
  if (typeof value !== 'string' || !LOOKS_BROKEN.test(value)) return value;
  // A repaired run can leave a shorter broken run behind (nested encodings), so repeat until stable.
  let current = value;
  for (let i = 0; i < 6; i++) {
    const next = current.replace(RUN, repairRun);
    if (next === current) break;
    current = next;
  }
  return current;
}

module.exports = { repairText };
