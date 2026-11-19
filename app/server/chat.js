'use strict';

// Chat (/api/chat, /api/chat/stream), prompt construction and intent routing (/api/route).
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
const { secretish } = require('../model-coordinator');
const { stickyPrivate } = require('../model-router');
const { cleanId } = require('../run-ledger');
// Project Memory notes for a chat filed under a project (A28 D5: data in a marked block, no tools, this PC only).
const projectMemory = require('../project-memory');
// The owner's saved facts (owner facts §3): in the same block, only in what this PC's model is sent; they never route.
const ownerFacts = require('../owner-facts');
// Pi Hub's page facts, as ask-context.js appends them: they describe the household's pages, so the chat stays here.
const HUB_CONTEXT = /\n---\nContext \(page facts from a link/;
// The home hub's prompt (Pi Hub's House questions), as app/run-cards.js readableTitle knows it.
const HUB_PROMPT = /^you are the voice of a family's home hub\b/i;
function createChat(ctx) {
  const { ANSWER_RESERVE, CHAT_MODEL_TIMEOUT_MS, MODEL, OLLAMA_URL, coordinator, TEXT_KEEP_ALIVE, TEXT_NUM_CTX, aboutApplianceBlock, accessAddresses, activeRunControllers, capabilityPrompt, createChatExecution, factSuggestions, fitMessages, getCapabilitiesSnapshot, isAboutLocalAi, json, keepLongAnswer, modelFetch, modelFetchWithTimeout, projectNotes, projectStore, readBody, recordActivity, recordTurnArtifact, runLedger, sanitizeMessages, searxSearch, selfChange, storageError, voiceFacts, voiceTimeZone } = ctx;

  function systemPrompt(researchContext = '', capabilityContext = '', brief = false, facts = '', sourceHost = '') {
    return {
      role: 'system',
      content:
        'You are the assistant inside a private local AI appliance. Be concise, technically precise, useful, and action-oriented. ' +
        'Do not expose infrastructure implementation details unless the user asks. Do not claim an action was executed unless it actually was. ' +
        'When discussing this appliance, use the supplied runtime capability snapshot as authoritative and do not invent installed models, versions, services, or completed actions.' +
        (capabilityContext ? `\n\n${capabilityContext}` : '') +
        (facts ? `\n\n${facts}` : '') +
        (researchContext
          ? `\n\nCurrent metasearch results are below. Use them when relevant and cite source numbers like [1].\n\n${researchContext}`
          : '') +
        // Siri Shortcuts on a phone or watch read the answer aloud (docs/APPLE-WATCH.md).
        (brief ? '\n\nThis answer will be read aloud on a watch: reply in at most two short sentences of plain text, with no lists, markdown, links or source numbers.' : '') +
        (brief && sourceHost ? ` Start the answer with "According to ${sourceHost},".` : '')
    };
  }

  // The messages for this PC's model: system prompt, the owner's facts and the project's notes (one block), research
  // sources, then the conversation, fitted to the shared context (sources are trimmed first, then the oldest turns, then
  // the block). → {messages, notesSent, factsSent}: false when there were none, or fitting had to leave the block out.
  function chatMessages(prep) {
    const system = systemPrompt('', prep.capabilityContext, prep.brief, prep.voice ? voiceFacts({ now: new Date(), timeZone: voiceTimeZone(), includeZone: true }) : '', prep.sourceHost);
    const notes = prep.memory?.state === 'used' ? prep.memory.notes : [], facts = prep.facts?.state === 'used' ? prep.facts.facts : [];
    const memory = notes.length || facts.length ? projectMemory.memoryMessage({ project: prep.memory?.project, notes, facts }) : null;
    const sources = prep.researchContext
      ? [{ role: 'system', kind: 'sources', content: `Current metasearch results are below. Use them when relevant and cite source numbers like [1].\n\n${prep.researchContext}` }]
      : [];
    const messages = fitMessages([system, ...(memory ? [memory] : []), ...sources, ...prep.messages], { numCtx: TEXT_NUM_CTX, reserve: ANSWER_RESERVE });
    const sent = !!memory && messages.some(m => m.role === 'system' && m.content === memory.content);
    return { messages, notesSent: sent && notes.length > 0, factsSent: sent && facts.length > 0 };
  }

  // What a cloud model is sent: the conversation and its public sources, never the appliance's own snapshot or facts,
  // and never project notes (a turn with notes is private, so it doesn't get here; this keeps them out regardless) or the
  // owner's facts (D1: a turn going to a cloud model is answered without them, and its line says so).
  function cloudMessages(prep) {
    const system = systemPrompt('', '', prep.brief, '', prep.sourceHost);
    const sources = prep.researchContext
      ? [{ role: 'system', kind: 'sources', content: `Current metasearch results are below. Use them when relevant and cite source numbers like [1].\n\n${prep.researchContext}` }]
      : [];
    return fitMessages([system, ...sources, ...prep.messages], { numCtx: TEXT_NUM_CTX, reserve: ANSWER_RESERVE }).map(({ kind, ...m }) => m);
  }

  async function prepareChat(body, signal = null) {
    const throwIfAborted = () => {
      if (!signal?.aborted) return;
      const error = new Error('Run cancelled');
      error.name = 'AbortError';
      throw error;
    };
    throwIfAborted();
    const picked = typeof body.model === 'string' && body.model.trim() && body.model.trim() !== MODEL ? body.model.trim() : '';
    const model = picked || MODEL;
    const messages = sanitizeMessages(body.messages);
    if (!messages.length) throw new Error('messages[] is required');

    let sources = [];
    let researchContext = '';
    if (Array.isArray(body.presetSources) && body.presetSources.length) {
      // Voice "current facts": the sources were already fetched (and timed) by the caller.
      sources = body.presetSources.map(x => ({ title: String(x.title || ''), url: String(x.url || ''), content: String(x.content || '') }));
      researchContext = sources.map((x, i) => `[${i + 1}] ${x.title}\n${x.content}\n${x.url}`).join('\n\n');
    } else if (body.webSearch === true) {
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
    // Questions about Local AI itself also get the "About this appliance" facts (where things run and live, addresses, updates).
    const asked = [...messages].reverse().find(m => m.role === 'user');
    if (asked && isAboutLocalAi(asked.content)) capabilityContext = [capabilityContext, aboutApplianceBlock({ addresses: accessAddresses() })].filter(Boolean).join('\n\n');
    // The coordinator (app/model-router.js): which model answers. Private work, and everything while cloud is off, stays
    // here. The guard reads everything that would be sent: every turn of the conversation and the research sources.
    // A conversation that touches Local AI itself, in any turn, stays here too (it carries the appliance's own details).
    // House questions are known by the hub's prompt too (a caller may leave out the title); a request that brings its own
    // system message, or text that looks like a key or is about keys, passwords or setup, stays here (secretish).
    const raw = Array.isArray(body.messages) ? body.messages.filter(m => m && typeof m === 'object') : [];
    // Privacy belongs to the conversation: a follow-up or a retry resends the turns without their markers (voice, House,
    // files, "Keep on this PC", a system message), so an earlier turn that was private for a reason of its own keeps
    // every later turn of the thread here. Judged on the server from the runs it recorded; the client's flags don't count.
    // The lookup uses the ledger's own id rule (cleanId): a threadId it would not keep as it is can't find its earlier
    // runs, so it keeps the request here rather than failing open.
    const askedThread = body.threadId === undefined || body.threadId === null || body.threadId === '' ? '' : body.threadId;
    const threadId = askedThread ? cleanId(askedThread) : '';
    const threadRuns = threadId ? runLedger.list({ threadId, all: true }) : [];
    const keptBefore = (askedThread && threadId !== askedThread) || threadRuns.some(r => stickyPrivate(r.meta?.privacy) || stickyPrivate(r.meta?.route) || r.meta?.voice === true);
    // Project notes: the request's own projectId (D1: a first turn gets notes only so), else the project of the newest
    // run in this thread that is filed under one. A turn that carries them stays on this PC (A28 D5.3).
    const memory = projectMemory.notesForTurn({ projectId: projectFor(body, threadRuns), readProjects: projectStore, readNotes: projectNotes });
    const sent = [...messages.map(m => m.content), researchContext].join('\n');
    const route = coordinator.route({
      kind: body.webSearch === true ? 'research' : 'chat', text: sent, model: picked,
      voice: body.voice === true || body.brief === true || body.voiceRun === true,
      house: body.title === 'House question' || raw.some(m => HUB_PROMPT.test(String(m.content || '').trim()) || HUB_CONTEXT.test(String(m.content || ''))),
      attachments: (Array.isArray(body.images) && body.images.length) || raw.some(m => Array.isArray(m.images) && m.images.length),
      keepLocal: body.keepLocal === true || messages.some(m => isAboutLocalAi(m.content)),
      stay: memory.state === 'used' ? projectMemory.STAY : keptBefore ? 'This conversation was kept on this PC' : raw.some(m => m.role === 'system') ? 'Requests with their own instructions stay on this PC' : secretish(sent) ? 'Keys, passwords and setup stay on this PC' : '',
      bigger: body.bigger === true, localModel: model
    });
    // Read after routing, so the facts never decide where the turn goes; read each turn, never cached.
    const facts = ownerFacts.forTurn(() => projectNotes(''));
    return { model, route, messages, sources, researchContext, capabilityContext, memory, facts, brief: body.brief === true, voice: body.voice === true, sourceHost: typeof body.sourceHost === 'string' ? body.sourceHost : '' };
  }

  // Which project a turn's notes come from: a valid projectId on the request, else the newest filed run of the thread.
  function projectFor(body, threadRuns) {
    const asked = typeof body.projectId === 'string' ? cleanId(body.projectId) : null;
    if (asked) return asked;
    const filed = threadRuns.filter(r => r && typeof r.projectId === 'string' && r.projectId)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return filed[0]?.projectId || '';
  }

  // The cloud candidates in the route, in order; the first answer wins. null = none answered (or none allowed): the
  // caller goes on to this PC's model, so a request never fails only because the cloud did.
  async function cloudAnswer(prep) {
    return coordinator.run(prep.route, cloudMessages(prep), { kind: prep.researchContext ? 'research' : 'chat' });
  }
  const usedLocal = prep => ({ provider: 'ollama', model: prep.model, class: prep.route.class, why: prep.route.why });

  // After a chat turn is answered and sent: the owner-fact suggestion job (app/fact-suggestions.js), scheduled and left
  // to run on its own. Only the chat routes call this, never voice, missions, agents or Past work; the job itself skips
  // cloud-answered, research and private turns. It can never delay or fail the answer.
  function suggestFact(body, out) {
    try {
      const asked = [...sanitizeMessages(body?.messages)].reverse().find(m => m.role === 'user');
      factSuggestions.afterChat({ used: out.route, body, question: asked?.content || '', answer: out.content, runId: out.runId });
    } catch { /* a suggestion is never worth a failed answer */ }
  }

  async function apiChat(req, res) {
    let body, out;
    try { body = await readBody(req); out = await chatOnce(body); json(res, 200, out); }
    catch (e) { return storageError(res,e,500); }
    suggestFact(body, { route: out.route, content: out.message.content, runId: out.runId });
  }

  // One non-streaming chat turn as a run; shared by /api/chat and /api/glance/ask.
  async function chatOnce(body) {
    let execution = null;
    try {
      execution = createChatExecution(body, false);
      runLedger.start(execution.id, body.webSearch === true ? 'Research run started' : 'Chat run started');
      const prep = await prepareChat(body);
      const local = chatMessages(prep);
      runLedger.update(execution.id, { meta: { privacy: { class: prep.route.class, why: prep.route.why }, ...projectMemory.runMeta(prep.memory, local.notesSent) } });
      const started = Date.now();
      const cloud = await cloudAnswer(prep);
      let content, used;
      if (cloud) ({ content, used } = cloud);
      else {
        const r = await modelFetchWithTimeout(`${OLLAMA_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: prep.model,
            messages: local.messages,
            stream: false,
            keep_alive: TEXT_KEEP_ALIVE,
            options: { num_ctx: TEXT_NUM_CTX }
          })
        }, CHAT_MODEL_TIMEOUT_MS);

        const raw = await r.text();
        if (!r.ok) throw new Error(`Intelligence service HTTP ${r.status}: ${raw.slice(0, 500)}`);
        const j = JSON.parse(raw);
        content = j?.message?.content || '';
        used = usedLocal(prep);
      }
      const elapsedMs = Date.now() - started;
      const lastUser = [...prep.messages].reverse().find(m => m.role === 'user');

      recordActivity(
        body.webSearch === true ? 'research' : 'chat',
        body.webSearch === true ? 'Researched with AI' : 'Asked AI',
        (lastUser?.content || '').slice(0, 180),
        { model: used.model, provider: used.provider, elapsedMs, sources: prep.sources.length, runId: execution.id }
      );
      const artifact = recordTurnArtifact(
        content.slice(0, 420),
        { model: used.model, elapsedMs, sources: prep.sources.length, runId: execution.id },
        { prompt: lastUser?.content || '', response: content.slice(0, 40000), sources: prep.sources },
        execution
      );
      runLedger.complete(execution.id, {
        summary: content.slice(0, 420),
        output: { text: content.slice(0, 40000), model: used.model, elapsedMs, sources: prep.sources },
        artifactIds: artifact?.id ? [artifact.id] : [],
        meta: { model: used.model, route: used, elapsedMs, sources: prep.sources.length, ...ownerFacts.runMeta(prep.facts, { sent: local.factsSent, cloud: !!cloud }), ...(body.voice === true || body.voiceRun === true ? { voice: true } : {}) }
      });
      keepLongAnswer(execution.id, content.slice(0, 40000));

      return {
        message: { role: 'assistant', content },
        model: used.model,
        route: used,
        elapsedMs,
        sources: prep.sources,
        runId: execution.id
      };
    } catch (e) {
      if (execution) { runLedger.fail(execution.id, e); try { e.runId = execution.id; } catch {} }
      throw e;
    }
  }

  async function apiChatStream(req, res) {
    let execution = null;
    let controller = null;
    // Ollama can stall while loading a model or mid-stream; abort when no output arrives for CHAT_MODEL_TIMEOUT_MS.
    let idleTimer = null;
    let stalled = false;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stalled = true;
        controller?.abort(new Error(`No model output for ${Math.round(CHAT_MODEL_TIMEOUT_MS / 1000)}s`));
      }, CHAT_MODEL_TIMEOUT_MS);
    };
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
      const local = chatMessages(prep);
      runLedger.update(execution.id, { meta: { privacy: { class: prep.route.class, why: prep.route.why }, ...projectMemory.runMeta(prep.memory, local.notesSent) } });
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

      // A cloud answer (when the route allows one) arrives whole; this PC's model streams as before.
      const cloud = await cloudAnswer(prep);
      const used = cloud ? cloud.used : usedLocal(prep);
      send('meta', { model: used.model, route: used, sources: prep.sources, runId: execution.id });
      let full = '';
      if (cloud) {
        full = cloud.content;
        send('token', { text: full });
      } else {
        armIdle();
        // modelFetch: no 300 s limit on Ollama's first byte while it reads a long prompt behind other work.
        const upstream = await modelFetch(`${OLLAMA_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: prep.model,
            messages: local.messages,
            stream: true,
            keep_alive: TEXT_KEEP_ALIVE,
            options: { num_ctx: TEXT_NUM_CTX }
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

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          armIdle();
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
      }

      const elapsedMs = Date.now() - started;
      const lastUser = [...prep.messages].reverse().find(m => m.role === 'user');
      recordActivity(
        body.webSearch === true ? 'research' : 'chat',
        body.webSearch === true ? 'Researched with AI' : 'Asked AI',
        (lastUser?.content || '').slice(0, 180),
        { model: used.model, provider: used.provider, elapsedMs, sources: prep.sources.length, runId: execution.id }
      );
      const artifact = recordTurnArtifact(
        full.slice(0, 420),
        { model: used.model, elapsedMs, sources: prep.sources.length, runId: execution.id },
        { prompt: lastUser?.content || '', response: full.slice(0, 40000), sources: prep.sources },
        execution
      );
      runLedger.complete(execution.id, {
        summary: full.slice(0, 420),
        output: { text: full.slice(0, 40000), model: used.model, elapsedMs, sources: prep.sources },
        artifactIds: artifact?.id ? [artifact.id] : [],
        meta: { model: used.model, route: used, elapsedMs, sources: prep.sources.length, ...ownerFacts.runMeta(prep.facts, { sent: local.factsSent, cloud: !!cloud }) }
      });
      keepLongAnswer(execution.id, full.slice(0, 40000));

      send('done', { elapsedMs, model: used.model, route: used, sources: prep.sources, runId: execution.id });
      res.end();
      suggestFact(body, { route: used, content: full, runId: execution.id });
    } catch (e) {
      const current = execution ? runLedger.get(execution.id) : null;
      const cancelled = !stalled && (current?.status === 'cancelled' || (controller?.signal.aborted && current?.status !== 'failed'));
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
      clearTimeout(idleTimer);
      if (execution) activeRunControllers.delete(execution.id);
    }
  }

  function recentEngineeringRequest(messages = []) {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (!m || m.role !== 'user') continue;
      const text = String(m.content || '').trim();
      if (!text) continue;
      const r = routeIntent(text, 'auto', [], true);
      if (r.intent === 'engineering') return text;
    }
    return '';
  }

  function routeIntent(textValue, requestedMode = 'auto', messages = [], skipContinuation = false) {
    const text = String(textValue || '').trim();
    const mode = String(requestedMode || 'auto').toLowerCase();
    if (['ask', 'create', 'research', 'automate', 'engineering'].includes(mode)) {
      return { intent: mode, target: mode === 'engineering' ? 'self' : null, confidence: 1, reason: 'explicit-mode', effectiveRequest: text };
    }

    const t = text.toLowerCase();
    const continuation = !skipContinuation && /^(do it|implement it|apply that|apply it|make those changes|go ahead|use your recommendation|proceed|make it so)[.!\s]*$/i.test(text);
    if (continuation) {
      const previous = recentEngineeringRequest(messages);
      if (previous) return { intent: 'engineering', target: 'self', confidence: 0.98, reason: 'engineering-continuation', effectiveRequest: previous };
    }

    // Capability questions are informational even when they mention image/create features.
    if (/\b(what|which|show|list|tell me|are there|do i have)\b.*\b(models?|capabilit(?:y|ies)|services?|version|installed|running)\b/.test(t)) {
      return { intent: 'ask', target: null, confidence: 0.96, reason: 'capability-question', effectiveRequest: text };
    }

    const selfObject = /\b(local ai|this (?:site|app|application|ui|page|navigation|dashboard)|your (?:ui|navigation|site|app)|create page|home page|sidebar|menu|workbench|engineer|powershell|status page|ui|interface)\b/.test(t);
    const engineeringVerb = /\b(improve|fix|update|upgrade|refactor|patch|implement|modify|change|enhance|adjust|rewrite|redesign|rethink|add|remove|build|make)\b/.test(t);
    const codeArtifact = /\b(html|css|javascript|js|frontend|backend|endpoint|route|navigation|dashboard|component|layout|code|feature)\b/.test(t);
    const explicitEngineering = /\b(generate|create)\b.*\b(html|css|javascript|code|component|dashboard|page|navigation|endpoint)\b/.test(t);
    const informational = /^(how|what|why|which|where|when|explain|describe|tell me|show me how|can you explain|could you explain)\b/.test(t);
    // selfChange names Local AI's pages too ("polish Agent World"), the same check missions and Home's suggestion use.
    if (!informational && ((engineeringVerb && (selfObject || codeArtifact)) || explicitEngineering || selfChange.isSelfChange(text))) {
      return { intent: 'engineering', target: 'self', confidence: 0.97, reason: 'software-modification', effectiveRequest: text };
    }

    // Visual-content language is evaluated only after engineering intent.
    if (/\b(generate|create|render|draw|illustrate|make)\b.*\b(image|picture|photo|artwork|portrait|scene|logo|poster|visual)\b/.test(t) || /\b(image|picture|photo|artwork)\b.*\b(of|showing|depicting)\b/.test(t)) {
      return { intent: 'create', target: null, confidence: 0.94, reason: 'visual-content', effectiveRequest: text };
    }
    if (/\b(workflow|automation|automate|n8n|trigger|webhook|schedule|data table)\b/.test(t)) {
      return { intent: 'automate', target: null, confidence: 0.9, reason: 'automation-language', effectiveRequest: text };
    }
    if (/\b(latest|today|current|news|search the web|web search|research online|look up)\b/.test(t)) {
      return { intent: 'research', target: null, confidence: 0.86, reason: 'fresh-information-language', effectiveRequest: text };
    }
    return { intent: 'ask', target: null, confidence: 0.7, reason: 'default', effectiveRequest: text };
  }

  async function apiRoute(req, res) {
    try {
      const body = await readBody(req);
      const route = routeIntent(body.text, body.mode, sanitizeMessages(body.messages));
      json(res, 200, route);
    } catch (e) {
      storageError(res,e,400);
    }
  }

  return { apiChat, apiChatStream, apiRoute, chatOnce };
}

module.exports = { createChat };
