'use strict';

// Glance, Siri and Apple Watch voice (/api/glance, /api/glance/ask, /api/voice/home), the Mac watcher (/api/watch/heartbeat),
// and the Workshop display's feed, ask buttons, approvals, pairing and alerts (/api/display/*).
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createVoice(ctx) {
  const { APPROVALS_STORE, APP_VERSION, approvalStore, chatOnce, claudeChat, clockNow, displayAuthorized, hubAuthorized, displayMessages, displayPairing, featureAtLeast, fetchWithTimeout, getCapabilitiesSnapshot, glance, json, listenPort, materialsClient, needsThreads, needsYou, notifier, nowIso, piHub, printLab, readBody, recordActivity, runLedger, saveStore, searxSearch, startMissionRun, storage, storageError, text, voice, voiceFacts, watchdog, weather } = ctx;

  // What Home lists under Needs you (app/public/home.js, loadNeeds and paintNeeds), for Siri and the Watch to say the
  // same: the runs app/public/needs-you.js picks (a waiting approval; a failure that is unseen, under a day old, not
  // retried and not answered by a later success), failures of one goal as one entry, and the pending approvals that no
  // picked run already stands for. Changes and Claude findings are not on Home's list, so they are not spoken as needing you.
  function homeNeedsYou() {
    const runs = needsThreads();
    const awaiting = runs.filter(r => r.status === 'awaiting_approval');
    const waiting = new Set(awaiting.map(r => r.meta?.changeId).filter(Boolean));
    const approvals = approvalStore().filter(a => a.status === 'pending' && !(a.meta?.changeId && waiting.has(a.meta.changeId)));
    const failed = needsYou.group(runs.filter(r => r.status === 'failed')).map(g => g.run);
    return { approvals: [...awaiting, ...approvals], failed };
  }

  // Cards for the Workshop display's idle screen (app/display-feed.js, docs/WORKSHOP-DISPLAY.md › Local AI cards).
  // No model calls; the weather is the home location's, cached for 15 minutes.
  const displayFeed = require('../display-feed');
  let feedWeather = { at: 0, text: null };
  async function feedWeatherText() {
    if (Date.now() - feedWeather.at < 15 * 60 * 1000) return feedWeather.text;
    const home = voiceHome();
    let text = null;
    if (Number.isFinite(home.lat) && Number.isFinite(home.lon)) {
      try {
        const f = await Promise.race([weather.forecast(home.lat, home.lon, { timeZone: home.timeZone }), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 3000))]);
        text = weather.weatherSentence(f, { when: 'now', place: home.place }) || null;
      } catch { text = feedWeather.text; }
    }
    feedWeather = { at: Date.now(), text };
    return text;
  }
  // Runs the Workshop display shows as finished: not images (they have their own card), at least 30 s long (as phone
  // notifications), finished within `windowMs`, newest first.
  function displayDoneRuns(windowMs) {
    const since = Date.now() - windowMs;
    return ['completed', 'failed'].flatMap(status => runLedger.list({ status, limit: 30 }))
      .filter(r => r.type !== 'image' && Date.parse(r.finishedAt || '') >= since && Date.parse(r.finishedAt) - Date.parse(r.startedAt || r.createdAt) >= 30000)
      .sort((x, y) => Date.parse(y.finishedAt) - Date.parse(x.finishedAt));
  }
  // withNeeds: Pi Hub's Needs you list goes only to the display (its key). Pi Hub builds that list from this very feed
  // (read without a key), so fetching it for Pi Hub's read would send the hub a request that reads the feed again.
  async function displayFeedNow({ withNeeds = false, aiOnly = false } = {}) {
    const snapshot = await getCapabilitiesSnapshot();
    const health = glance.healthSummary({ services: snapshot.services || [], version: APP_VERSION });
    const home = homeNeedsYou();
    const running = ['running', 'streaming'].flatMap(status => runLedger.list({ status, limit: 20 }));
    const needs = glance.needsYouSummary({ approvals: home.approvals.length, failed: home.failed.length }, health);
    const images = runLedger.list({ type: 'image', status: 'completed', limit: 12 })
      .filter(r => r.output?.images?.[0]?.imageUrl).slice(0, 6)
      .map(r => { const t = Date.parse(r.finishedAt || r.updatedAt || ''); return { title: r.title, imageUrl: displayFeed.jpegUrl(r.output.images[0].imageUrl), at: Number.isFinite(t) ? Math.floor(t / 1000) : undefined }; })
      .filter(i => i.imageUrl);
    const disks = watchdog.summary().hostDisks || [];
    const disk = disks.filter(d => d.totalBytes > 0).sort((x, y) => x.freeBytes / x.totalBytes - y.freeBytes / y.totalBytes)[0] || null;
    // The Pi hub's summary and its "Needs you" list are read side by side, so a slow hub costs one 3 s wait, not two.
    // aiOnly (Pi Hub's ai-cards): nothing here calls Pi Hub, Bambuddy or the weather service, which Pi Hub owns.
    const [pi, piNeeds] = aiOnly ? [null, null] : await Promise.all([piHub.read(), withNeeds && piHub.needs ? piHub.needs() : null]);
    let lab = [];
    if (!aiOnly) try { lab = printLab?.feedCards?.() || []; } catch { lab = []; }
    const feed = displayFeed.buildFeed({ needs, piNeeds, lab, watch: watchdog.list(), running, done: displayDoneRuns(2 * 3600 * 1000), weather: aiOnly ? null : await feedWeatherText(), images, disk, pi, materials: aiOnly ? null : await materialsClient.read() });
    feed.messages = displayMessages.recent();
    return feed;
  }
  // POST /api/display/pair/start (signed in): a 6-digit code for 10 minutes; GET /api/display/pair/status; POST
  // /api/display/pair {code} from the display (open: it has no key yet), which answers {key, tlsName}.
  async function apiDisplayPair(req, res, p) {
    try {
      if (p === '/api/display/pair/start') return json(res, 200, displayPairing.start());
      if (p === '/api/display/pair/status') return json(res, 200, displayPairing.status());
      json(res, 200, displayPairing.pair(await readBody(req, 1024)));
    } catch (e) { json(res, e.statusCode || 400, { error: String(e.message || e) }); }
  }
  // POST /api/display/notify {title, text, tone?, chime?, action?}: a banner on the Workshop display (app/display-messages.js).
  async function apiDisplayNotify(req, res) {
    try {
      const m = displayMessages.post(await readBody(req), 'api');
      json(res, 200, { ok: true, seq: m.seq });
    } catch (e) { json(res, e.statusCode || 400, { error: String(e.message || e) }); }
  }
  // GET/POST /api/display/alerts: which notification kinds also show on the display, the chime, and its quiet hours.
  async function apiDisplayAlerts(req, res) {
    try {
      if (req.method === 'POST') return json(res, 200, displayMessages.updateSettings(await readBody(req)));
      json(res, 200, { ...displayMessages.settings(), kindsAvailable: require('../display-messages').KINDS });
    } catch (e) { json(res, 400, { error: String(e.message || e) }); }
  }
  // Approvals on the Workshop display (docs/WORKSHOP-DISPLAY.md › Approvals): it lists what waits, and may decide only
  // an approval at or below the risk the owner allows there (setting display:approvals, {maxRisk: none|low|medium};
  // low by default). A change waiting on its approval (code, deploys) is never decided from the display. Every decision
  // is in the activity log as the Workshop display's.
  const RISKS = ['none', 'low', 'medium'];
  const displayMaxRisk = () => { const r = storage.readSetting('display:approvals', null)?.maxRisk; return RISKS.includes(r) ? r : 'low'; };
  const displayMayDecide = a => a.status === 'pending' && !a.meta?.changeId && displayMaxRisk() !== 'none' && RISKS.indexOf(a.risk || 'medium') > 0 && RISKS.indexOf(a.risk || 'medium') <= RISKS.indexOf(displayMaxRisk());
  async function apiDisplayApprovals(req, res) {
    try {
      const items = homeNeedsYou().approvals.slice(0, 8).map(a => ({
        id: a.id, title: displayFeed.cut(String(a.threadTitle || a.title || 'Approval').replace(/\s+chg-\d+-[0-9a-f]+$/, ''), 60),
        risk: a.risk || (a.status === 'awaiting_approval' ? 'high' : 'medium'), at: Math.floor(Date.parse(a.createdAt || a.updatedAt || '') / 1000) || undefined,
        decidable: a.status === 'pending' && displayMayDecide(a)
      }));
      json(res, 200, { items, maxRisk: displayMaxRisk() });
    } catch (e) { json(res, 500, { error: String(e.message || e) }); }
  }
  async function apiDisplayApprovalDecide(req, res) {
    try {
      const b = await readBody(req);
      if (!['approved', 'rejected'].includes(b?.decision)) return json(res, 400, { error: 'decision must be approved or rejected' });
      const items = approvalStore();
      const i = items.findIndex(x => x.id === b.id);
      if (i < 0) return json(res, 404, { error: 'Approval not found' });
      if (!displayMayDecide(items[i])) return json(res, 403, { error: 'Decide this one on your phone or in Local AI' });
      items[i].status = b.decision;
      items[i].updatedAt = nowIso();
      items[i].meta = { ...items[i].meta, decidedBy: 'Workshop display' };
      saveStore(APPROVALS_STORE, items, 500);
      recordActivity('approval', `Approval ${b.decision} on the Workshop display`, items[i].title, { approvalId: items[i].id, by: 'Workshop display' });
      json(res, 200, { ok: true, status: items[i].status });
    } catch (e) { json(res, 400, { error: String(e.message || e) }); }
  }
  // POST /api/display/heartbeat: the display's own state every few minutes (version, uptime, Wi-Fi, memory, camera), for
  // GET /api/watch's display section. Unknown fields are dropped.
  async function apiDisplayHeartbeat(req, res) {
    try {
      const b = await readBody(req, 4096);
      const num = v => (Number.isFinite(v) ? v : null);
      const beat = { at: new Date(clockNow()).toISOString(), version: String(b.version || '').slice(0, 24), sourceSha: String(b.sourceSha || '').slice(0, 40), uptimeS: num(b.uptimeS), rssi: num(b.rssi), heapFree: num(b.heapFree), psramFree: num(b.psramFree), camera: String(b.camera || '').slice(0, 24) };
      storage.writeSetting('display:heartbeat', beat);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e.message || e) }); }
  }
  // Pi Hub consumes only Local AI's own attention. No household fetch, model call, weather or inventory read:
  // the aggregate list must never become its own input through the display feed.
  async function apiAttention(req, res) {
    try {
      const home = homeNeedsYou();
      const needs = glance.needsYouSummary({ approvals: home.approvals.length, failed: home.failed.length });
      const feed = displayFeed.buildFeed({ needs, watch: watchdog.list() });
      json(res, 200, { schema: 1, source: 'localai', at: feed.at, cards: feed.cards });
    } catch (e) { json(res, 500, { error: String(e.message || e) }); }
  }

  // GET /api/display/ai-cards (Pi Hub's key only): the AI cards of the feed below, for Pi Hub's own display feed. The
  // host's loopback passes sign-in, so the key is checked here too.
  async function apiDisplayAiCards(req, res) {
    if (!hubAuthorized(req)) return json(res, 401, { error: 'Pi Hub key required.' });
    try { json(res, 200, displayFeed.aiCards(await displayFeedNow({ aiOnly: true }))); } catch (e) { json(res, 500, { error: String(e.message || e) }); }
  }

  async function apiDisplayFeed(req, res) {
    try { json(res, 200, await displayFeedNow({ withNeeds: displayAuthorized(req) })); } catch (e) { json(res, 500, { error: String(e.message || e) }); }
  }

  // GET /api/display/events?since=<sig>: the display's long poll (Workshop OS 12.6). Answers {sig} at once when the
  // feed's cards are not the ones `since` describes, else when they change, else after 25 s; the display then fetches
  // the feed. The signature leaves out the times, so "12 min ago" ticking over is not news.
  async function apiDisplayEvents(req, res, urlObj) {
    const since = String(urlObj.searchParams.get('since') || '').slice(0, 64);
    const deadline = Date.now() + 25000;
    let closed = false;
    res.on('close', () => { closed = true; }); // the display gave up (or asked something else)
    const withNeeds = displayAuthorized(req);
    try {
      for (;;) {
        const sig = displayFeed.signature(await displayFeedNow({ withNeeds }));
        if (sig !== since || Date.now() >= deadline || closed) return closed ? undefined : json(res, 200, { sig, changed: sig !== since });
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) { json(res, 500, { error: String(e.message || e) }); }
  }

  // The Workshop display's ask buttons (docs/WORKSHOP-DISPLAY.md › Ask buttons): a fixed question, a short answer, no
  // model. needs: what Home's Needs you lists, by name; running: what Local AI is doing; health: services and the
  // watchdog's problems.
  async function apiDisplayAsk(req, res, urlObj) {
    const q = urlObj.searchParams.get('q');
    try {
      let answer;
      if (q === 'needs') answer = await voiceNeedsSentence();
      else if (q === 'running') {
        const running = ['running', 'streaming'].flatMap(status => runLedger.list({ status, limit: 20 }));
        answer = running.length
          ? `${running.length === 1 ? 'Working on' : `${running.length} things running:`} ${running.slice(0, 3).map(r => String(r.title || 'a run').split('\n')[0].trim().slice(0, 60)).join('; ')}${running.length > 3 ? '; …' : ''}.`
          : 'Nothing is running right now.';
      } else if (q === 'health') {
        const snapshot = await getCapabilitiesSnapshot();
        const health = glance.healthSummary({ services: snapshot.services || [], version: APP_VERSION });
        const watch = watchdog.list();
        answer = health.speech + (watch.length ? ` Also: ${watch.map(w => w.title).join('; ')}.` : '');
      } else if (q === 'today') {
        const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
        answer = displayFeed.todaySentence(displayDoneRuns(Date.now() - midnight.getTime()).filter(r => r.status === 'completed'));
      } else if (q === 'next') {
        answer = displayFeed.nextSentence({ approvals: homeNeedsYou().approvals.map(a => ({ title: String(a.threadTitle || a.title || '').replace(/\s+chg-\d+-[0-9a-f]+$/, '') || 'approval' })), queued: runLedger.list({ status: 'queued', limit: 20 }) });
      } else if (q === 'weather') {
        answer = (await feedWeatherText()) || 'Weather needs your home location: set it in Local AI under Health, Home location.';
      } else return json(res, 400, { error: 'q must be needs, running, health, today, next or weather' });
      json(res, 200, { question: q, answer: displayFeed.cut(answer, 200) });
    } catch (e) { json(res, 500, { error: String(e.message || e) }); }
  }

  // The Mac's watcher (host/mac-watch) reports its disk and the camera bridge every few minutes, with the Mac key.
  async function apiWatchHeartbeat(req, res) {
    if (!claudeChat.macAuthorized(req)) return json(res, 401, { error: 'Unauthorized' });
    const body = await readBody(req);
    json(res, 200, { ok: true, heartbeat: watchdog.heartbeat(body) });
  }

  // Spoken summaries for Siri Shortcuts (docs/APPLE-WATCH.md). ?topic=health for "Is Local AI OK?", otherwise
  // "What needs me?". ?format=text returns just the sentence, which a shortcut can speak without parsing JSON.
  async function apiGlance(req, res, urlObj) {
    try {
      const snapshot = await getCapabilitiesSnapshot();
      const health = glance.healthSummary({ services: snapshot.services || [], version: APP_VERSION });
      const home = homeNeedsYou();
      const running = ['running', 'streaming'].reduce((n, status) => n + runLedger.list({ status, limit: 200 }).length, 0);
      const needs = glance.needsYouSummary({ approvals: home.approvals.length, failed: home.failed.length, running }, health);
      const watch = watchdog.list();
      if (watch.length) needs.speech += ` Also: ${watch.map(w => w.title).join('; ')}.`;
      const topic = urlObj.searchParams.get('topic') === 'health' ? 'health' : 'needs';
      const speech = topic === 'health' ? health.speech : needs.speech;
      if (urlObj.searchParams.get('format') === 'text') return text(res, 200, speech, 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
      json(res, 200, { topic, speech, needsYou: { count: needs.count, items: needs.items }, health: { ok: health.ok, down: health.down, total: health.total }, watch, version: APP_VERSION });
    } catch (e) { storageError(res, e, 500); }
  }

  // "Ask Local AI" from Siri (GET ?q= or POST {text}): a rules-only router picks the answer, the model only
  // handles open questions, and every reply is plain text that is safe to read aloud. Siri speaks the body
  // whatever the status, so errors are sentences, never JSON.
  const voiceThreads = voice.createVoiceThreads({
    now: clockNow,
    windowMs: 300000
  });
  const VOICE_BUDGET_MS = Number(process.env.LOCALAI_VOICE_BUDGET_MS) || 8000;
  const VOICE_HANDOFF = "Still working on that \u2014 I'll send it to your phone.";
  const VOICE_QUEUE_WAIT_MS = Number(process.env.LOCALAI_VOICE_QUEUE_WAIT_MS) || 6000;
  const VOICE_DOWN = "Local AI can't answer right now. Try again in a minute.";
  const VOICE_REFUSAL = "That needs your phone \u2014 I've put it in Needs you.";
  const VOICE_POST_ONLY = 'Use the Ask Local AI shortcut to start that.';
  const voiceTimeZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const VOICE_FACT_MS = 3000;

  // searxSearch, but gives up (and cancels the request) after ms.
  async function searxWithin(query, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try { return await searxSearch(query, controller.signal); } finally { clearTimeout(timer); }
  }

  let lastWeather = null; // { threadId, loc: {lat, lon, place, timeZone} }

  function voiceHome() { return storage.readSetting('voice-home', null) || {}; }

  async function voiceWeather(question, here, threadId) {
    const q = question.toLowerCase();
    const when = /\btomorrow\b/.test(q) ? 'tomorrow' : /\btonight\b/.test(q) ? 'tonight' : /\btoday\b/.test(q) ? 'today' : 'now';
    let lat = Number(here.lat), lon = Number(here.lon), place = null, timeZone = null;
    if (here.lat != null && here.lat !== '' && here.lon != null && here.lon !== '' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      place = undefined; // looked up below, alongside the forecast
    } else if (lastWeather?.threadId === threadId && voice.timeOnly(question)) {
      ({ lat, lon, place, timeZone } = lastWeather.loc);
    } else {
      const home = voiceHome();
      if (!Number.isFinite(home.lat) || !Number.isFinite(home.lon)) return "Set your home location on Local AI's Health page.";
      ({ lat, lon, place, timeZone } = home);
    }
    try {
      const [f, name] = await Promise.all([weather.forecast(lat, lon, { timeZone }), place === undefined ? weather.reverse(lat, lon) : place]);
      lastWeather = { threadId, loc: { lat, lon, place: name, timeZone } };
      const sentence = weather.weatherSentence(f, { when, place: name });
      return sentence ? voice.speakable(sentence) : "I couldn't get the weather right now.";
    } catch { return "I couldn't get the weather right now."; }
  }

  async function apiVoiceHome(req, res) {
    if (req.method === 'GET') return json(res, 200, voiceHome());
    const body = await readBody(req).catch(() => ({}));
    let found;
    try { found = await weather.geocode(typeof body?.place === 'string' ? body.place : ''); }
    catch { return json(res, 503, { error: "Couldn't reach the place lookup. Try again in a minute." }); }
    if (!found) return json(res, 400, { error: "Couldn't find that place." });
    const home = { place: found.name, lat: found.lat, lon: found.lon, timeZone: found.timeZone };
    storage.writeSetting('voice-home', home);
    feedWeather = { at: 0, text: null }; // the display's weather card follows the new place at once
    json(res, 200, home);
  }

  // "What needs me?" names the same things Home lists (homeNeedsYou), plus core services that are down.
  async function voiceNeedsSentence() {
    const snapshot = await getCapabilitiesSnapshot();
    const home = homeNeedsYou();
    return glance.needsYouSentence(glance.needsYouItems({
      // Home's approval rows drop a trailing change id from the title; so does what is spoken.
      approvals: home.approvals.map(a => ({ title: String(a.threadTitle || a.title || '').replace(/\s+chg-\d+-[0-9a-f]+$/, '') || 'Approval needed' })),
      failedRuns: home.failed,
      downServices: (snapshot.services || []).filter(s => s && s.required !== false && s.state !== 'HEALTHY')
    }));
  }

  // A notification for a spoken ask or the job it started. The tag is the run's, else a fresh one, so the repeat
  // filter never drops one.
  function voiceNotify(title, body, runId) {
    notifier.notify({ kind: 'answer', title, body, url: runId ? `#run/${runId}` : '/', tag: runId ? `answer:${runId}` : `answer:voice:${require('node:crypto').randomBytes(6).toString('hex')}` });
  }

  // "Make an image of…", "start a mission to…", "research…": start the job, reply as soon as it has started, and
  // never wait for it to finish. Images and research report back by notification; missions use the run's own.
  async function voiceAction({ action, subject }) {
    if (action === 'image') {
      if (!subject) return 'What should the image show?';
      // Through the server's own route, so the image is made exactly as one asked for in the app.
      fetchWithTimeout(`http://127.0.0.1:${listenPort()}/api/images/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: subject, voice: true }) }, 900000)
        .then(async r => {
          const j = await r.json().catch(() => ({}));
          if (r.ok) voiceNotify('Your image is ready', subject, j.runId);
          else voiceNotify("Couldn't make the image", 'Tap to see what went wrong.', j.runId);
        }, () => voiceNotify("Couldn't make the image", 'Tap to see what went wrong.'));
      return `Started an image of ${subject}. I'll notify you when it's ready.`;
    }
    if (action === 'mission') {
      if (!subject) return 'What should the mission do?';
      if (!featureAtLeast(4)) return "Missions aren't available on this Local AI.";
      startMissionRun(subject, '', undefined, false, '', { voice: true });
      return `Started a mission: ${subject}.`;
    }
    // research: a full answer for the app, not a spoken one; the notification carries its start.
    chatOnce({ messages: [{ role: 'user', content: subject }], webSearch: true, voiceRun: true }).then(
      result => voiceNotify('Research ready', voice.speakable(result.message.content) || 'Tap to read it.', result.runId),
      err => voiceNotify("Couldn't finish the research", 'Tap to see what went wrong.', err?.runId)
    );
    return `Researching ${subject}. I'll send you the answer.`;
  }

  async function apiGlanceAsk(req, res, urlObj) {
    const say = (status, value) => text(res, status, value, 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
    try {
      let textIn = '';
      let here = { lat: urlObj.searchParams.get('lat'), lon: urlObj.searchParams.get('lon') };
      if (req.method === 'GET') textIn = String(urlObj.searchParams.get('q') || '');
      else { const b = await readBody(req).catch(e => { if (e.statusCode === 413) throw e; return {}; }); textIn = typeof b?.text === 'string' ? b.text : ''; if (b?.lat != null && b?.lon != null) here = { lat: b.lat, lon: b.lon }; }
      textIn = textIn.trim().slice(0, 4000);
      const reset = voice.stripReset(textIn);
      const route = voice.classify(reset.text);
      if (route.intent === 'empty') {
        if (reset.fresh) { voiceThreads.take(textIn); return say(200, 'Okay. What is your question?'); }
        return say(200, "I didn't catch that.");
      }
      // Images, missions and research start only from the shortcut's POST, which the cross-site guard covers. Any web
      // page can make the owner's browser load a GET, so a GET that asks to start work starts nothing.
      if (route.intent === 'action' && req.method !== 'POST') return say(200, VOICE_POST_ONLY);
      const question = reset.text;
      const { threadId } = voiceThreads.take(textIn);
      // Every answer is a turn in the thread; only chat asks hand the earlier turns to the model.
      const turn = async build => {
        const answer = await build();
        voiceThreads.record(threadId, question, answer);
        return answer;
      };
      // "and tomorrow?" right after a weather answer on this thread is weather for the same place.
      const followUpWeather = lastWeather?.threadId === threadId && ['chat', 'current'].includes(route.intent) && voice.timeOnly(question);
      let runId = null;
      const asked = voiceThreads.run(threadId, () => {
        if (route.intent === 'time') return turn(async () => voice.speakable(voiceFacts({ now: new Date(), timeZone: voiceTimeZone() })));
        if (route.intent === 'needs') return turn(async () => voice.speakable(await voiceNeedsSentence()));
        if (route.intent === 'health') {
          return turn(async () => {
            const snapshot = await getCapabilitiesSnapshot();
            return voice.speakable(glance.healthSummary({ services: snapshot.services || [], version: APP_VERSION }).speech);
          });
        }
        if (route.intent === 'weather' || followUpWeather) return turn(() => voiceWeather(question, here, threadId));
        if (route.intent === 'current') {
          return turn(async () => {
            let sources;
            try { sources = (await searxWithin(question, VOICE_FACT_MS)).slice(0, 3); } catch { return "I couldn't look that up right now."; }
            if (!sources.length) return "I couldn't find anything on that.";
            const messages = [...voiceThreads.history(threadId), { role: 'user', content: question }];
            const result = await chatOnce({ messages, brief: true, voice: true, threadId, presetSources: sources, sourceHost: voice.siteName(sources[0].url) });
            runId = result.runId;
            const host = voice.siteName(sources[0].url);
            let said = String(result.message.content || '').trim();
            // The model is asked to cite; make sure the spoken answer names the site either way.
            if (said && host && !said.toLowerCase().includes(host.toLowerCase())) said = `According to ${host}, ${/^[A-Z][a-z]/.test(said) ? said[0].toLowerCase() + said.slice(1) : said}`;
            return voice.speakable(said) || "I didn't catch that.";
          });
        }
        // Approving, applying, deploying, deleting and PowerShell never happen by voice; nothing is called.
        if (route.intent === 'refuse') return turn(async () => VOICE_REFUSAL);
        if (route.intent === 'action') return turn(() => voiceAction(route));
        return turn(async () => {
          const messages = [...voiceThreads.history(threadId), { role: 'user', content: question }];
          const result = await chatOnce({ messages, brief: true, voice: true, threadId });
          runId = result.runId;
          return voice.speakable(result.message.content) || "I didn't catch that.";
        });
      }, { waitMs: VOICE_QUEUE_WAIT_MS });
      // The budget covers the whole ask, queue wait included. Past it the run carries on and the answer is pushed.
      const outcome = await voice.withBudget(asked, VOICE_BUDGET_MS);
      if (outcome.done) return say(200, outcome.value);
      const handoff = (title, body, id) => voiceNotify(title, body, id || runId);
      outcome.later.then(
        late => handoff('Local AI answered', String(late)),
        err => handoff("Local AI couldn't answer", "Tap to see what went wrong.", err?.runId)
      );
      say(200, VOICE_HANDOFF);
    } catch (e) { say(e.statusCode === 413 ? 413 : 503, e.statusCode === 413 ? 'That was too long for me.' : VOICE_DOWN); }
  }

  return { apiAttention, apiDisplayAiCards, apiDisplayAlerts, apiDisplayApprovalDecide, apiDisplayApprovals, apiDisplayAsk, apiDisplayEvents, apiDisplayFeed, apiDisplayHeartbeat, apiDisplayNotify, apiDisplayPair, apiGlance, apiGlanceAsk, apiVoiceHome, apiWatchHeartbeat, voiceTimeZone };
}

module.exports = { createVoice };
