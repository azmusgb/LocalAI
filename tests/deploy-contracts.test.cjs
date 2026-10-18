// Runs the string and file "contracts" of deploy/Test-LocalAI-Candidate.ps1 inside `npm test`.
// The deploy validator only runs under pwsh (local CI and the host), so a PR that removes a name it lists (#252
// removed toggleCrew) passed `npm test` and then blocked every deploy. This test reads the script itself, so the
// lists stay in one place: it finds every
//   foreach($s in @("a","b")){if(-not $var.Contains($s)){throw "<Name> contract missing: $s"}}  (plus single if(-not $var.Contains("a")) checks)
//   foreach($r in @("server.js",...)){if(-not(Test-Path(Join-Path $app $r))){throw "Missing required file: $r"}}
//   $nativeTests = @("tests/x.test.cjs",...)
// maps each $var to the file its `$var=Get-Content (Join-Path $app "...") -Raw` line read, and checks the strings
// are there. A shape it doesn't recognise, a variable it can't map or finding no contracts at all fails the test,
// so a change to the script can't make this pass by checking nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SCRIPT_REL = 'deploy/Test-LocalAI-Candidate.ps1';
const SCRIPT = path.join(root, SCRIPT_REL);
const FIX = `If the removal was deliberate, update the list in ${SCRIPT_REL} in the same PR.`;

// Reads a PowerShell string literal starting at text[i] (a quote). Returns { value, end } (end is past the closing
// quote). Rejects interpolation and escapes, which this parser does not evaluate.
function readString(text, i) {
  const q = text[i];
  let j = i + 1;
  let value = '';
  for (;;) {
    if (j >= text.length) throw new Error(`${SCRIPT_REL}: unterminated string at offset ${i}`);
    const c = text[j];
    if (c === q) {
      if (text[j + 1] === q) { value += q; j += 2; continue; }
      break;
    }
    value += c;
    j++;
  }
  if (q === '"' && (/\$[\w({]/.test(value) || value.includes('`'))) {
    throw new Error(`${SCRIPT_REL}: string ${JSON.stringify(value)} uses interpolation or escapes, which tests/deploy-contracts.test.cjs can't evaluate; extend the parser`);
  }
  return { value, end: j + 1 };
}

// Reads an @( "a", 'b', ... ) list whose "@(" ends at text[i - 1]. Returns { items, end } (end is past the ")").
function readList(text, i) {
  const items = [];
  let j = i;
  for (;;) {
    while (j < text.length && /[\s,]/.test(text[j])) j++;
    const c = text[j];
    if (c === ')') return { items, end: j + 1 };
    if (c === '"' || c === "'") {
      const s = readString(text, j);
      items.push(s.value);
      j = s.end;
      continue;
    }
    throw new Error(`${SCRIPT_REL}: unexpected ${JSON.stringify(text.slice(j, j + 30))} in a @(...) list at offset ${j}; tests/deploy-contracts.test.cjs only understands lists of string literals`);
  }
}

function parseScript(text) {
  // Path variables: $app=Join-Path $CandidateRoot "app" (relative to the candidate root, which is this repo).
  const dirs = { CandidateRoot: '' };
  for (const m of text.matchAll(/\$(\w+)\s*=\s*Join-Path\s+\$(\w+)\s+(["'])([^"']*)\3/g)) {
    if (!(m[2] in dirs)) throw new Error(`${SCRIPT_REL}: $${m[1]} joins unknown path variable $${m[2]}`);
    dirs[m[1]] = path.posix.join(dirs[m[2]], m[4].replace(/\\/g, '/'));
  }
  const joinRel = (base, rel) => {
    if (!(base in dirs)) throw new Error(`${SCRIPT_REL}: path variable $${base} is not set by a Join-Path line`);
    return path.posix.join(dirs[base], rel.replace(/\\/g, '/'));
  };

  // Content variables: $x=Get-Content (Join-Path $app "public\app.js") -Raw, or [IO.File]::ReadAllText((Join-Path ...)).
  const files = {};
  const contentRe = /\$(\w+)\s*=\s*(?:Get-Content\s+(?:-LiteralPath\s+|-Path\s+)?\(\s*Join-Path\s+\$(\w+)\s+(["'])([^"']+)\3\s*\)\s*-Raw|\[(?:System\.)?IO\.File\]::ReadAllText\(\s*\(?\s*Join-Path\s+\$(\w+)\s+(["'])([^"']+)\6\s*\)?\s*\))/g;
  for (const m of text.matchAll(contentRe)) {
    files[m[1]] = m[2] ? joinRel(m[2], m[4]) : joinRel(m[5], m[7]);
  }
  // Any other content read is a shape this parser would silently miss.
  const reads = (text.match(/\$\w+\s*=\s*(?:Get-Content|\[(?:System\.)?IO\.File\]::ReadAll)/g) || []).length;
  if (reads !== Object.keys(files).length) {
    throw new Error(`${SCRIPT_REL}: found ${reads} file reads but could map only ${Object.keys(files).length} (${Object.keys(files).join(', ')}); extend tests/deploy-contracts.test.cjs for the new shape`);
  }

  const contracts = [];   // { name, variable, file, strings }
  const requiredFiles = []; // { name, files }
  let handledContains = 0;

  for (const m of text.matchAll(/foreach\s*\(\s*\$(\w+)\s+in\s+@\(/g)) {
    const loopVar = m[1];
    const list = readList(text, m.index + m[0].length);
    const rest = text.slice(list.end);
    let b;
    if ((b = rest.match(new RegExp(String.raw`^\s*\)\s*\{\s*if\s*\(\s*-not\s+\$(\w+)\.Contains\(\s*\$${loopVar}\s*\)\s*\)\s*\{\s*throw\s+"([^"]*?):?\s*\$${loopVar}"`)))) {
      const variable = b[1];
      if (!(variable in files)) throw new Error(`${SCRIPT_REL}: "${b[2]}" checks $${variable}, which no Get-Content line in the script reads from a file`);
      contracts.push({ name: b[2], variable, file: files[variable], strings: list.items });
      handledContains++;
    } else if ((b = rest.match(new RegExp(String.raw`^\s*\)\s*\{\s*if\s*\(\s*-not\s*\(\s*Test-Path\s*\(\s*Join-Path\s+\$(\w+)\s+\$${loopVar}\s*\)\s*\)\s*\)\s*\{\s*throw\s+"([^"]*?):\s*\$${loopVar}"`)))) {
      requiredFiles.push({ name: b[2], files: list.items.map(f => joinRel(b[1], f)) });
    } else {
      throw new Error(`${SCRIPT_REL}: foreach($${loopVar} in @(...)) at offset ${m.index} has a body tests/deploy-contracts.test.cjs doesn't recognise: ${JSON.stringify(rest.slice(0, 120))}; extend the parser`);
    }
  }

  // Single checks: if(-not $var.Contains("literal")){throw "..."}
  for (const m of text.matchAll(/if\s*\(\s*-not\s+\$(\w+)\.Contains\(\s*(["'])/g)) {
    const s = readString(text, m.index + m[0].length - 1);
    const t = text.slice(s.end).match(/^\s*\)\s*\)\s*\{\s*throw\s+"([^"]*)"/);
    if (!t) throw new Error(`${SCRIPT_REL}: unrecognised check on $${m[1]}.Contains(${JSON.stringify(s.value)})`);
    if (!(m[1] in files)) throw new Error(`${SCRIPT_REL}: "${t[1]}" checks $${m[1]}, which no Get-Content line in the script reads from a file`);
    contracts.push({ name: t[1], variable: m[1], file: files[m[1]], strings: [s.value] });
    handledContains++;
  }

  const allContains = (text.match(/\.Contains\(/g) || []).length;
  if (allContains !== handledContains) {
    throw new Error(`${SCRIPT_REL}: has ${allContains} .Contains( checks but tests/deploy-contracts.test.cjs recognised ${handledContains}; extend the parser for the new shape`);
  }

  // Native tests the validator runs with node --test.
  const native = text.match(/\$nativeTests\s*=\s*@\(/);
  if (native) requiredFiles.push({ name: 'Native test file ($nativeTests)', files: readList(text, native.index + native[0].length).items });

  return { contracts, requiredFiles };
}

const text = fs.readFileSync(SCRIPT, 'utf8');
const parsed = parseScript(text);

test('the deploy validator script parses into contracts', () => {
  assert.ok(parsed.contracts.length >= 10, `expected at least 10 string contracts in ${SCRIPT_REL}, found ${parsed.contracts.length}; the parser in tests/deploy-contracts.test.cjs no longer matches the script`);
  for (const c of parsed.contracts) assert.ok(c.strings.length > 0, `${c.name} has an empty list`);
  assert.ok(parsed.requiredFiles.some(r => r.files.length > 0), `found no required-file list in ${SCRIPT_REL}`);
});

test('every string the deploy validator requires is in its file', () => {
  const cache = new Map();
  const read = rel => {
    if (!cache.has(rel)) {
      const abs = path.join(root, rel);
      assert.ok(fs.existsSync(abs), `${rel} (read by ${SCRIPT_REL}) does not exist`);
      cache.set(rel, fs.readFileSync(abs, 'utf8'));
    }
    return cache.get(rel);
  };
  const missing = [];
  for (const c of parsed.contracts) {
    const body = read(c.file);
    for (const s of c.strings) if (!body.includes(s)) missing.push(`${c.name}: ${JSON.stringify(s)} is not in ${c.file} ($${c.variable})`);
  }
  assert.deepEqual(missing, [], `The deploy validator would reject this candidate and block every deploy:\n  ${missing.join('\n  ')}\n${FIX}`);
});

test('every file the deploy validator requires exists', () => {
  const missing = [];
  for (const r of parsed.requiredFiles) for (const f of r.files) if (!fs.existsSync(path.join(root, f))) missing.push(`${r.name}: ${f}`);
  assert.deepEqual(missing, [], `The deploy validator would reject this candidate and block every deploy:\n  ${missing.join('\n  ')}\n${FIX}`);
});
