// Local CI's own cache: green results it may reuse and how long each browser suite took. It lives in the repository's
// git common dir (`<common dir>/localai-ci/`), so it is local, never committed, and shared by every worktree.
// green.json: { "green": [{ key, tree, node, at, pr, summary }, …] }, newest first (see addGreen in local-ci-lib.mjs).
// durations.json: { "<suite>-ui.mjs": seconds, … }.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Reads a JSON file. A missing file is `fallback`; an unreadable or malformed one is too, but says so through `onBad`
// so a damaged cache is visible rather than silently empty.
export function readJson(file, fallback, onBad = () => {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') onBad(`couldn't read ${file}: ${e.message}`); return fallback; }
  try { return JSON.parse(raw); }
  catch (e) { onBad(`${file} is not valid JSON (${e.message}); starting it afresh`); return fallback; }
}

// Writes JSON so a reader sees the old file or the new one, never half of one: a temporary file in the same directory,
// then a rename over the target. The temporary file is removed if anything fails.
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

// sha256 of a file's bytes (hex), or null when it can't be read.
export function fileHash(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}
