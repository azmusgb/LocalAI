'use strict';

// One context size for the chat model, kept warm, and trimmed to fit. On the 6 GB GPU an 8192 context stays fully
// resident (about 3.9 GB, 74 tok/s); 32768 spills to the CPU (26 tok/s) and a different num_ctx forces a reload.

const TEXT_NUM_CTX = Math.max(1024, Number(process.env.LOCALAI_NUM_CTX) || 8192);
const TEXT_KEEP_ALIVE = process.env.LOCALAI_KEEP_ALIVE || '30m';
const ANSWER_RESERVE = 1024;
const CHARS_PER_TOKEN = 3.5;
const UNLOAD_WAIT_MS = 2000;
const MIN_KEPT_CHARS = 200;

const estimateTokens = text => Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
const sizeOf = ms => ms.reduce((n, m) => n + String(m.content || '').length, 0);

// Trims messages so the estimated prompt fits numCtx minus the room reserved for the answer. The first system
// message and the newest message are kept; sources (messages marked kind: 'sources') go first, then the oldest
// turns; a last message that is still too big is cut from the front rather than dropped. Pure; returns new objects.
function fitMessages(messages, { numCtx = TEXT_NUM_CTX, reserve = ANSWER_RESERVE } = {}) {
  const budget = Math.max(MIN_KEPT_CHARS, Math.floor((numCtx - reserve) * CHARS_PER_TOKEN));
  let out = (messages || []).map(m => ({ ...m, content: String(m.content ?? '') }));
  const over = () => sizeOf(out) - budget;

  // 1. Sources: shorten, then drop, until the prompt fits.
  for (const m of out) {
    if (m.kind !== 'sources' || over() <= 0) continue;
    const keep = m.content.length - over();
    m.content = keep > MIN_KEPT_CHARS ? m.content.slice(0, keep) : '';
  }
  out = out.filter(m => m.kind !== 'sources' || m.content);

  // 2. Oldest turns, never the leading system message or the newest message.
  const first = out.findIndex(m => m.role === 'system' && m.kind !== 'sources') === 0 ? 1 : 0;
  while (over() > 0 && out.length - first > 1) out.splice(first, 1);

  // 3. One huge newest message: keep its end.
  if (over() > 0 && out.length) {
    const last = out[out.length - 1];
    last.content = last.content.slice(-Math.max(MIN_KEPT_CHARS, last.content.length - over()));
  }
  return out.map(({ kind, ...m }) => m);
}

async function post(fetchFn, url, body, ms) {
  try {
    const call = fetchFn(`${url}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    call.catch?.(() => {});
    if (!ms) return await call;
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, ms); timer.unref?.(); });
    try { return await Promise.race([call, timeout]); } finally { clearTimeout(timer); }
  } catch { return null; }
}

// Loads the model into the GPU with the shared context and keep-alive. Never throws.
function warmTextModel({ fetch: fetchFn = fetch, url, model, numCtx = TEXT_NUM_CTX, keepAlive = TEXT_KEEP_ALIVE }) {
  return post(fetchFn, url, { model, prompt: '.', stream: false, keep_alive: keepAlive, options: { num_ctx: numCtx, num_predict: 1 } }, 0);
}

// Unloads the model so an image job has the GPU to itself. Waits at most 2 s. Never throws.
function unloadTextModel({ fetch: fetchFn = fetch, url, model, waitMs = UNLOAD_WAIT_MS }) {
  return post(fetchFn, url, { model, keep_alive: 0 }, waitMs);
}

module.exports = { TEXT_NUM_CTX, TEXT_KEEP_ALIVE, ANSWER_RESERVE, CHARS_PER_TOKEN, estimateTokens, fitMessages, warmTextModel, unloadTextModel };
