'use strict';

const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'app', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function safeIdentifier(value) { return /^[A-Za-z_$][\w$]*$/.test(String(value || '')) ? String(value) : ''; }
function findFunctionRange(text, name) {
  const safe = safeIdentifier(name);
  if (!safe) throw new Error(`Invalid function name: ${name}`);
  const rx = new RegExp(`(?:async\\s+)?function\\s+${safe.replace(/[$]/g, '\\$&')}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const match = rx.exec(text);
  if (!match) throw new Error(`function ${safe} was not found`);
  if (rx.test(text.slice(match.index + match[0].length))) throw new Error(`function ${safe} is not unique`);
  const open = match.index + match[0].lastIndexOf('{');
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (escaped) { escaped = false; continue; } if (c === '\\') { escaped = true; continue; } if (c === quote) quote = ''; continue; }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { start: match.index, end: i + 1 };
  }
  throw new Error(`function ${safe} has an unmatched body`);
}
function replaceFunction(name, fn) {
  const range = findFunctionRange(source, name);
  const replacement = fn.toString().replace(/^((?:async\s+)?function\s+)[A-Za-z_$][\w$]*/, `$1${name}`);
  source = source.slice(0, range.start) + replacement + source.slice(range.end);
}

async function replacementFetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const externalSignal = options?.signal || null;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

async function replacementSearxSearch(query, signal = null) {
  const u = new URL(`${SEARXNG_URL}/search`);
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'json');
  const r = await fetchWithTimeout(u.toString(), { signal }, 8000);
  if (!r.ok) throw new Error(`Web research returned HTTP ${r.status}`);
  const j = await r.json();
  return (j.results || []).slice(0, 6).map(x => ({
    title: x.title || '',
    url: x.url || '',
    content: x.content || ''
  }));
}

async function replacementPrepareChat(body, signal = null) {
  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    const error = new Error('Run cancelled');
    error.name = 'AbortError';
    throw error;
  };
  throwIfAborted();
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : MODEL;
  const messages = sanitizeMessages(body.messages);
  if (!messages.length) throw new Error('messages[] is required');

  let sources = [];
  let researchContext = '';
  if (body.webSearch === true) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (lastUser) {
      sources = await searxSearch(lastUser.content, signal);
      throwIfAborted();
      researchContext = sources.map((s, i) =>
        `[${i + 1}] ${s.title}\n${s.content}\n${s.url}`
      ).join('\n\n');
    }
  }

  let capabilityContext = '';
  try {
    capabilityContext = capabilityPrompt(await getCapabilitiesSnapshot());
    throwIfAborted();
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  throwIfAborted();
  return { model, messages, sources, researchContext, capabilityContext };
}

async function replacementApiChatStream(req, res) {
  let execution = null;
  let controller = null;
  try {
    const body = await readBody(req);
    execution = createChatExecution(body, true);
    runLedger.start(execution.id, body.webSearch === true ? 'Research run started' : 'Chat run started');
    controller = new AbortController();
    activeRunControllers.set(execution.id, controller);
    res.on('close', () => {
      if (!res.writableEnded) {
        runLedger.cancel(execution.id, 'Client disconnected');
        if (!controller.signal.aborted) controller.abort(new Error('Client disconnected'));
      }
    });

    const prep = await prepareChat(body, controller.signal);
    if (controller.signal.aborted || runLedger.get(execution.id)?.status === 'cancelled') {
      throw new Error('Run cancelled');
    }
    const started = Date.now();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('meta', { model: prep.model, sources: prep.sources, runId: execution.id });

    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: prep.model,
        messages: [systemPrompt(prep.researchContext, prep.capabilityContext), ...prep.messages],
        stream: true,
        options: { num_ctx: 32768 }
      })
    });

    if (!upstream.ok || !upstream.body) {
      const raw = await upstream.text();
      throw new Error(`Intelligence service HTTP ${upstream.status}: ${raw.slice(0, 500)}`);
    }

    runLedger.stream(execution.id, 'Streaming model output');
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let item;
        try { item = JSON.parse(line); } catch { continue; }
        const chunk = item?.message?.content || '';
        if (chunk) {
          full += chunk;
          send('token', { text: chunk });
        }
      }
    }

    const elapsedMs = Date.now() - started;
    const lastUser = [...prep.messages].reverse().find(m => m.role === 'user');
    recordActivity(
      body.webSearch === true ? 'research' : 'chat',
      body.webSearch === true ? 'Researched with AI' : 'Asked AI',
      (lastUser?.content || '').slice(0, 180),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id }
    );
    const artifact = recordArtifact(
      body.webSearch === true ? 'research' : 'conversation',
      lastUser?.content || (body.webSearch === true ? 'Research' : 'Conversation'),
      full.slice(0, 420),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id },
      { prompt: lastUser?.content || '', response: full.slice(0, 40000), sources: prep.sources }
    );
    runLedger.complete(execution.id, {
      summary: full.slice(0, 420),
      output: { text: full.slice(0, 40000), model: prep.model, elapsedMs, sources: prep.sources },
      artifactIds: artifact?.id ? [artifact.id] : [],
      meta: { model: prep.model, elapsedMs, sources: prep.sources.length }
    });

    send('done', { elapsedMs, model: prep.model, sources: prep.sources, runId: execution.id });
    res.end();
  } catch (e) {
    const current = execution ? runLedger.get(execution.id) : null;
    const cancelled = current?.status === 'cancelled' || (controller?.signal.aborted && current?.status !== 'failed');
    if (execution && !cancelled) runLedger.fail(execution.id, e);
    if (!res.headersSent) {
      if (!res.destroyed) {
        if (cancelled) json(res, 409, { error: 'Run cancelled', runId: execution?.id || null });
        else storageError(res,e,500);
      }
    } else {
      try {
        res.write(`event: ${cancelled ? 'cancelled' : 'error'}\ndata: ${JSON.stringify(cancelled ? { runId: execution.id } : { error: String(e.message || e), runId: execution?.id || null })}\n\n`);
        res.end();
      } catch {}
    }
  } finally {
    if (execution) activeRunControllers.delete(execution.id);
  }
}

replaceFunction('fetchWithTimeout', replacementFetchWithTimeout);
replaceFunction('searxSearch', replacementSearxSearch);
replaceFunction('prepareChat', replacementPrepareChat);
replaceFunction('apiChatStream', replacementApiChatStream);

const streamRange = findFunctionRange(source, 'apiChatStream');
const streamSource = source.slice(streamRange.start, streamRange.end);
if (streamSource.indexOf('activeRunControllers.set(execution.id, controller)') > streamSource.indexOf('await prepareChat')) {
  throw new Error('Abort controller is still registered after chat preparation');
}
if (!source.includes('searxSearch(lastUser.content, signal)')) throw new Error('Research preparation does not receive cancellation signal');
if (!source.includes("externalSignal?.addEventListener('abort'")) throw new Error('fetchWithTimeout does not bridge external cancellation');

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Applied cancellation race fix to app/server.js');
