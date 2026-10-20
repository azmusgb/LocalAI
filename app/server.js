const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3080);
// The port the server listens on: PORT, or the one the system picked when PORT=0 (tests/spawn-server.cjs). Calls to itself use it.
const listenPort = () => server.address()?.port || PORT;
// Second listener for host-only tools (PowerShell Workbench). Docker publishes it on 127.0.0.1 only, so a request
// that arrives on this port came from the Windows host itself; unlike the Host header, a LAN client cannot fake that.
const LOCAL_UI_PORT = Number(process.env.LOCAL_UI_PORT || 0);
const MODEL = process.env.MODEL || 'qwen3:4b-instruct-32k';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const { modelFetch, modelFetchWithTimeout } = require('./model-http');
const { isAboutLocalAi, aboutApplianceBlock } = require('./about-appliance');
const { TEXT_NUM_CTX, TEXT_NUM_CTX_LARGE, LARGE_ANSWER_RESERVE, MISSION_NUM_CTX, MISSION_ANSWER_RESERVE, TEXT_KEEP_ALIVE, ANSWER_RESERVE, fitMessages, warmTextModel, unloadTextModel } = require('./text-context');
const COMFY_URL = process.env.COMFY_URL || 'http://host.docker.internal:8188';
const N8N_URL = process.env.N8N_URL || 'http://local-ai-n8n:5678';
const PROXY_URL = process.env.PROXY_URL || 'http://local-ai-ollama-responses-proxy:8080';
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://local-ai-searxng:8080';
const MAC_AI_HOME_URL = process.env.MAC_AI_HOME_URL || 'http://10.0.0.16:3083';
const MAC_DSH_URL = process.env.MAC_DSH_URL || 'http://10.0.0.16:3084';
// GridCraft host bridge. The browser reaches it only through /api/gridcraft/*, so the bridge can stay off the LAN.
const GRIDCRAFT_URL = process.env.GRIDCRAFT_URL || 'http://host.docker.internal:8787';
const GRIDCRAFT_RUN_TIMEOUT_MS = 360000; // the bridge allows 300 s, after waiting up to 30 s for a workbook read to finish
const REPORT_PATH = process.env.REPORT_PATH || '/reports/LocalAI-Certification-latest.txt';
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SELF_APP_ROOT = process.env.SELF_APP_ROOT || '/app';
const ENGINEERING_MODEL_TIMEOUT_MS = Math.max(60000, Math.min(1800000, Number(process.env.ENGINEERING_MODEL_TIMEOUT_MS || 600000)));
const CHAT_MODEL_TIMEOUT_MS = Math.max(30000, Math.min(900000, Number(process.env.CHAT_MODEL_TIMEOUT_MS || 180000)));
// Mission settings (agent-orchestrator.js). Each is optional; out-of-range values fall back to the default.
const envInt = (name, min, max) => { const n = Number(process.env[name]); return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined; };
const MISSION_TIMEOUT_MS = envInt('LOCALAI_MISSION_TIMEOUT_MS', 1000, 3600000); // a worker's and the coordinator's deadline; default 10 minutes
const MISSION_EVIDENCE_TOKENS = envInt('LOCALAI_MISSION_EVIDENCE_TOKENS', 500, 100000); // first-turn evidence; default 6000
const MISSION_MODEL_CONCURRENCY = envInt('LOCALAI_MISSION_MODEL_CONCURRENCY', 1, 8); // model turns at once; default 1
const CAPABILITY_CACHE_MS = Math.max(5000, Math.min(300000, Number(process.env.CAPABILITY_CACHE_MS || 30000)));
let capabilityCache = { expiresAt: 0, value: null };
const POWERSHELL_BRIDGE_TOKEN = String(process.env.POWERSHELL_BRIDGE_TOKEN || '');
const POWERSHELL_UI_TOKEN = String(process.env.POWERSHELL_UI_TOKEN || '');

const ACTIVITY_STORE = 'activity';
const STATUS_STORE = 'status';
const LIBRARY_STORE = 'library';

const crypto = require('crypto');
const { Storage } = require('./storage');
const { RunLedger, cleanId: cleanRunId } = require('./run-ledger');
const { Trash } = require('./trash');
const busy = require('./busy');
const improve = require('./improve');
const selfChange = require('./public/self-change');
const needsYou = require('./public/needs-you');
const { runCard, workKind, WORK_CHIPS } = require('./run-cards');
const libraryThreads = require('./library-threads');
const { loadOllamaModelRuntime } = require('./model-runtime');
const { createModelPulls } = require('./model-pulls');
const imageEngines = require('./image-engines');
const plainText = require('./plain-text');
const workshop = require('./workshop');
if (String(process.env.LOCALAI_WORKSHOP_URL || '').trim() && !workshop.portalUrl()) console.warn('LOCALAI_WORKSHOP_URL is not an http(s) address on the home network (a private IP or a .local name); the Workshop display card shows it as not set up.');
// Printer status through the display's read-only token, when LOCALAI_WORKSHOP_STATUS_TOKEN is set; started after listen.
const workshopPrinter = workshop.createPrinterPoller();
// LOCALAI_TEST_NOW_FILE (tests only): a file holding the clock in ms, so tests can move time.
const clockNow = () => { const f = process.env.LOCALAI_TEST_NOW_FILE; if (f) { try { return Number(fs.readFileSync(f, 'utf8')) || Date.now(); } catch {} } return Date.now(); };
const workshopCode = workshop.createPortalCodeGate({ now: clockNow });
// Last measured seconds per engine on this machine, shown as an estimate in the Images page. Keyed by id and
// family, so "best" switching from FLUX to Z-Image doesn't show FLUX's time.
const IMAGE_ESTIMATES = {};
const IMAGE_PROMPT_MODEL = process.env.IMAGE_PROMPT_MODEL || process.env.GRIDCRAFT_MODEL || 'qwen3:4b-instruct';
const release = require('./release').readRelease(__dirname);
// A staged copy (self-change smoke test) passes its own APP_VERSION; otherwise the release decides.
const APP_VERSION = /-stage$/.test(process.env.APP_VERSION || '') ? process.env.APP_VERSION : require('./release').appVersion(__dirname, release);
// The app folder (server.js's own): area modules in app/server/ get it as APP_DIR instead of their own __dirname.
const APP_DIR = __dirname;
const storage = new Storage({ dataDir: DATA_DIR });
// The state collections and the HTTP helpers every area uses live in app/server/ (the server split, step 1).
const { readState, writeState, prependRecord, RETENTION } = require('./server/stores').createStores({ storage, STATUS_STORE });
const { json, storageError, text, readBody, fetchWithTimeout, sameOriginJson, allowedHosts, hostAllowed } = require('./server/http');
const ALLOWED_HOSTS = allowedHosts(); // DNS-rebinding guard: the names this server answers to (server/http.js)
// Phone notifications (Web Push): app/push.js sends, app/notify.js decides; docs/OPERATIONS.md › Notifications.
const pushLib = require('./push');
const notifyLib = require('./notify');
const glance = require('./glance');
const voice = require('./voice');
const { voiceFacts } = require('./voice-context');
const weather = require('./weather');
const notifier = notifyLib.createNotifier({
  storage, sendPush: pushLib.sendPush, vapid: pushLib.loadOrCreateVapid(storage),
  subject: process.env.VAPID_SUBJECT || 'https://github.com/azmusgb/LocalAI'
});
// Watchdog (app/watchdog.js, docs/WATCHDOG.md): disks, the Mac's heartbeat, the display and printer; one push per problem.
const watchdog = require('./watchdog').createWatchdog({
  storage, now: clockNow,
  notify: event => notifier.notify(event),
  printer: () => workshopPrinter.current(),
  hostPaths: [
    { path: '/workspace/projects', name: 'windows', label: 'Windows' },
    { path: DATA_DIR, name: 'data', label: 'Local AI data' }
  ]
});
// The Raspberry Pi's hub (app/pi-hub.js): Plex's now playing and the hub's issues, for the display's cards.
const piHub = require('./pi-hub').createPiHub();
// Pairing the Workshop display from its touchscreen (app/display-pairing.js).
const displayPairing = require('./display-pairing').createDisplayPairing({
  dataDir: DATA_DIR, tlsName: process.env.LOCALAI_NAME || 'localai.home.arpa',
  onPaired: () => recordActivity('display', 'Workshop display paired', 'A new display key replaced the old one.')
});
// The Workshop display's messages (app/display-messages.js): the notification kinds the owner picked also show there.
const displayMessages = require('./display-messages').createDisplayMessages({ storage, now: clockNow });
{
  const notifyPhones = notifier.notify;
  notifier.notify = event => { displayMessages.fromNotification(event); return notifyPhones(event); };
}
// LOCALAI_NOTIFY_LOG (tests only): also append each notify() call as a JSON line to this file.
if (process.env.LOCALAI_NOTIFY_LOG) {
  const realNotify = notifier.notify;
  notifier.notify = event => { try { fs.appendFileSync(process.env.LOCALAI_NOTIFY_LOG, JSON.stringify(event) + '\n'); } catch {} return realNotify(event); };
}
// Work with no record while it runs (a GridCraft request, an automation): GET /api/busy lists it.
const inFlight = busy.createInFlight();
const runLedger = new RunLedger({ storage, onTransition: (run, previous) => { const e = notifyLib.runEvent(run, previous); if (e) notifier.notify(e); } });
const activeRunControllers = new Map();
const claudeChat = require('./claude-chat').createClaudeChat({ storage, dataDir: DATA_DIR, json, readBody });
// Sign-in, report-only for now (app/signin.js): who would be refused is listed on Health; nothing is blocked.
// The Workshop display's key (X-LocalAI-Display-Key) signs it in for its feed only; host/workshop-display/set-key.sh sets it.
const displayKey = require('./route-keys').createRouteKey({ dataDir: DATA_DIR, file: 'workshop-display-key.sha256', header: 'x-localai-display-key' });
const signIn = require('./signin').createSignIn({ storage, signedIn: req => !!claudeChat.deviceFor(req) || claudeChat.macAuthorized(req), routeKeys: {
  '/api/display/feed': req => displayKey.authorized(req),
  '/api/display/ask': req => displayKey.authorized(req),
  '/api/display/events': req => displayKey.authorized(req),
  '/api/display/approvals': req => displayKey.authorized(req),
  '/api/display/approvals/decide': req => displayKey.authorized(req),
  '/api/display/heartbeat': req => displayKey.authorized(req),
  // The feed's latest-image card links here; the display fetches the JPEG with its key.
  '/api/images/view': req => displayKey.authorized(req)
} });








function activityStore() {
  const value = readState(ACTIVITY_STORE, []);
  return Array.isArray(value) ? value : [];
}

function recordActivity(type, title, detail = '', meta = {}) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type,
    title,
    detail,
    at: new Date().toISOString(),
    meta
  };
  prependRecord(ACTIVITY_STORE, item);
  return item;
}

function libraryStore() {
  const value = readState(LIBRARY_STORE, []);
  return Array.isArray(value) ? value : [];
}

function titleFromText(value, fallback = 'Untitled') {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length <= 72 ? clean : `${clean.slice(0, 69).trim()}…`;
}

function recordArtifact(kind, title, summary = '', meta = {}, data = {}) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 9)}`,
    kind: String(kind || 'artifact'),
    title: titleFromText(title, 'Untitled artifact'),
    summary: String(summary || '').slice(0, 1200),
    createdAt: new Date().toISOString(),
    pinned: false,
    meta: meta && typeof meta === 'object' ? meta : {},
    data: data && typeof data === 'object' ? data : {}
  };
  prependRecord(LIBRARY_STORE, item);
  return item;
}

// A chat or research turn reaches Library only once its conversation is kept (☆ Keep; owner decision, 18 Oct). A
// later turn of a kept conversation updates its item in place (title stays the first message; summary becomes the
// latest answer). Any other turn stays in Work only, and this returns null.
function recordTurnArtifact(summary, meta, data, execution) {
  const threadId = execution?.threadId || '', runId = execution?.id || '';
  if (!threadId) return null;
  const next = libraryThreads.continueThread(libraryStore(), { threadId, runId, summary, meta, data, now: new Date().toISOString() });
  return next ? storage.upsert(LIBRARY_STORE, next) : null;
}

// An answer too long for the run ledger (its output is cut to a preview) is kept whole under answer/<runId>, so the run
// view shows it whether or not its conversation is in Library. Only the newest MAX_LONG_ANSWERS are kept.
const ANSWER_PREFIX = 'answer/', MAX_LONG_ANSWERS = 500;
function keepLongAnswer(runId, text) {
  if (!runId || typeof text !== 'string' || !runLedger.get(runId)?.output?.truncated) return false;
  if (typeof storage.readSetting(ANSWER_PREFIX + runId, null)?.text === 'string') return true;
  storage.writeSetting(ANSWER_PREFIX + runId, { runId, text });
  storage.pruneSettings(ANSWER_PREFIX, MAX_LONG_ANSWERS);
  return true;
}
// A Library item leaving Library (un-keep, delete, the one-time repair) leaves its long answers with their runs.
function keepItemAnswers(item) {
  for (const runId of libraryThreads.runIdsOf(item)) {
    const text = item?.data?.turns?.[runId] ?? (item?.meta?.runId === runId ? item?.data?.response : undefined);
    keepLongAnswer(runId, text);
  }
}
function fullAnswer(runId, items = null) {
  const saved = storage.readSetting(ANSWER_PREFIX + runId, null);
  if (typeof saved?.text === 'string') return saved.text;
  for (const it of items || libraryStore()) {
    const t = it?.data?.turns?.[runId] ?? (it?.meta?.runId === runId ? it?.data?.response : undefined);
    if (typeof t === 'string') return t;
  }
  return null;
}

// Keep (☆) a chat or research run: its whole conversation becomes one Library item (or the item it already has is
// marked kept). Un-keep takes the conversation out of Library; its runs stay in Work. Returns {kept, item} or {error}.
const KEEPABLE = new Set(['chat', 'research']);
function libraryItemsOfRun(run, items) {
  return items.filter(it => libraryThreads.isThreadItem(it) && ((run.threadId && it.meta?.threadId === run.threadId) || libraryThreads.runIdsOf(it).includes(run.id)));
}
// Best's quick preview stays out of Library until it is kept: Keep adds its picture, un-keep removes it again.
function setPreviewKept(run, kept) {
  const items = libraryStore(), mine = it => it?.kind === 'image' && it.meta?.runId === run.id;
  const found = items.filter(mine);
  if (!kept) {
    if (found.length) writeState(LIBRARY_STORE, items.filter(it => !mine(it)), items);
    return { kept: false, item: null };
  }
  if (found.length) return { kept: true, item: found[0] };
  const o = run.output || {}, prompt = run.input?.prompt || run.title || '';
  const style = imageEngines.STYLES[o.style] && o.style !== 'none' ? ` · ${imageEngines.STYLES[o.style].label}` : '';
  let item = null;
  for (const im of [...(o.images || [])].reverse()) {
    item = recordArtifact('image', prompt, `${o.width} × ${o.height} · ${o.engineLabel || 'Best'} preview${style}`,
      { engine: o.engine, engineLabel: o.engineLabel, family: o.family, style: o.style, width: o.width, height: o.height, steps: o.steps, cfg: o.cfg, preview: true, imageUrl: im.imageUrl, seed: im.seed, runId: run.id },
      { prompt, imageUrl: im.imageUrl });
  }
  return item ? { kept: true, item } : { status: 409, error: 'This preview has no picture to keep' };
}
function setRunKept(runId, kept) {
  const run = runLedger.get(runId);
  if (!run) return { status: 404, error: 'Run not found' };
  if (run.type === 'image' && run.meta?.preview === true) return setPreviewKept(run, kept);
  if (!KEEPABLE.has(run.type)) return { status: 409, error: 'Only chats, research and image previews are kept this way' };
  const items = libraryStore(), found = libraryItemsOfRun(run, items);
  if (!kept) {
    if (!found.length) return { kept: false, item: null };
    for (const it of found) keepItemAnswers(it);
    const drop = new Set(found.map(it => it.id));
    writeState(LIBRARY_STORE, items.filter(it => !drop.has(it?.id)), items);
    return { kept: false, item: null };
  }
  if (found.length) return { kept: true, item: found[0].kept ? found[0] : storage.upsert(LIBRARY_STORE, { ...found[0], kept: true }) };
  const runs = run.threadId ? runLedger.list({ threadId: run.threadId, limit: 500 }) : [run];
  runs.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  const answered = runs.filter(r => r.output);
  const answerOf = r => (r?.output?.truncated ? fullAnswer(r.id, items) : r?.output?.text);
  const item = libraryThreads.itemFromRuns(answered.length ? answered : runs, { id: `${Date.now()}-${Math.random().toString(16).slice(2, 9)}`, now: nowIso(), answerOf });
  item.title = titleFromText(item.title, 'Conversation');
  prependRecord(LIBRARY_STORE, item);
  return { kept: true, item };
}
// Which runs are in Library: for chat and research rows, `kept` says whether ☆ Keep is on.
function keptMarker() {
  const threads = new Set(), runs = new Set();
  for (const it of libraryStore()) {
    if (!libraryThreads.isThreadItem(it)) continue;
    if (it.meta?.threadId) threads.add(it.meta.threadId);
    for (const id of libraryThreads.runIdsOf(it)) runs.add(id);
  }
  return x => (KEEPABLE.has(x?.type) ? { ...x, kept: (!!x.threadId && threads.has(x.threadId)) || runs.has(x.id) } : x);
}

// Failed runs the owner has opened, on any device (id -> when), so Home's Needs you lets them go everywhere at once
// (app/public/needs-you.js). One settings record; the newest SEEN_MAX are kept, which covers far more than a day's runs.
const SEEN_KEY = 'needs-you/seen', SEEN_MAX = 1000;
const seenRuns = () => { const v = storage.readSetting(SEEN_KEY, null); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
const withSeen = seen => x => (seen[x?.id] ? { ...x, seenAt: seen[x.id] } : x);
async function apiRunsSeen(req, res) {
  try {
    const b = await readBody(req), ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    if (!ids.length || ids.length > 200 || ids.some(id => !(cleanRunId(id) || (/^legacy-[a-z]+:[\w.-]{1,160}$/.test(id))))) return json(res, 400, { error: 'Say which runs (1 to 200 run ids)' });
    const at = nowIso(), seen = seenRuns();
    for (const id of ids) if (!seen[id]) seen[id] = at;
    const kept = Object.entries(seen).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, SEEN_MAX);
    storage.writeSetting(SEEN_KEY, Object.fromEntries(kept));
    json(res, 200, { seen: ids.length });
  } catch (e) { storageError(res, e, 400); }
}

function updateArtifact(id, patch = {}) {
  const items = libraryStore();
  const index = items.findIndex(x => x && x.id === id);
  if (index < 0) return null;
  if (typeof patch.pinned === 'boolean') items[index].pinned = patch.pinned;
  if (typeof patch.title === 'string' && patch.title.trim()) items[index].title = titleFromText(patch.title);
  writeState(LIBRARY_STORE, items);
  return items[index];
}

function deleteArtifact(id) {
  const items = libraryStore();
  const next = items.filter(x => x && x.id !== id);
  if (next.length === items.length) return false;
  keepItemAnswers(items.find(x => x && x.id === id));   // a conversation's runs stay in Work, with their long answers
  writeState(LIBRARY_STORE, next, items);
  return true;
}


function migrateLegacyActivityToLibrary() {
  const items = libraryStore();
  const seen = new Set(items.map(x => x?.meta?.imageUrl).filter(Boolean));
  let changed = false;
  for (const a of activityStore()) {
    // Only v1.1 activity: an image made since has a run (a preview kept out of Library, an image deleted from it) and
    // must not come back on the next start.
    if (a?.type !== 'image' || !a?.meta?.imageUrl || a.meta.runId || a.meta.preview || seen.has(a.meta.imageUrl)) continue;
    items.push({
      id: `migrated-${a.id || Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      kind: 'image',
      title: titleFromText(a.detail || 'Generated image'),
      summary: 'Imported from v1.1 image activity',
      createdAt: a.at || new Date().toISOString(),
      pinned: false,
      meta: { ...a.meta, migratedFromActivity: true },
      data: { prompt: a.detail || '', imageUrl: a.meta.imageUrl }
    });
    seen.add(a.meta.imageUrl);
    changed = true;
  }
  if (changed) {
    items.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    writeState(LIBRARY_STORE, items);
  }
}

async function probe(name, label, url, goodCodes = [200], timeoutMs = 3000, required = true) {
  const started = Date.now();
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs);
    const latencyMs = Date.now() - started;
    return {
      name, label, required,
      state: goodCodes.includes(r.status) ? 'HEALTHY' : 'DEGRADED',
      statusCode: r.status,
      latencyMs
    };
  } catch (e) {
    return {
      name, label, required, state: 'DOWN', statusCode: null,
      latencyMs: Date.now() - started,
      error: String(e.message || e)
    };
  }
}

function overallState(services) {
  const core = services.filter(x => x.required !== false);
  if (core.some(x => x.state === 'DOWN')) return 'DOWN';
  if (core.some(x => x.state === 'DEGRADED')) return 'DEGRADED';
  return 'HEALTHY';
}

// What stops working when a core service is down, in the owner's words (Home › Needs you shows it).
const SERVICE_IMPACT = {
  ollama: 'Chat, research and missions are unavailable.',
  comfy: 'Images are unavailable.',
  n8n: 'Workflows and scheduled automations are paused.',
  proxy: 'Apps that talk to Local AI through its compatible endpoint are cut off.',
  search: 'Research and current facts are unavailable.'
};

function presentService(service) {
  const optional = service.required === false;
  const available = service.state === 'HEALTHY';
  return {
    ...service,
    availability: available ? 'available' : 'unavailable',
    displayState: optional && !available ? 'OPTIONAL_OFFLINE' : service.state,
    severity: available ? 'ok' : optional ? 'info' : service.state === 'DEGRADED' ? 'warning' : 'critical',
    impact: optional && !available ? 'Core appliance unaffected' : available ? 'Ready' : SERVICE_IMPACT[service.name] || 'Part of Local AI is unavailable.'
  };
}

function certificationInfo() {
  try {
    const content = fs.readFileSync(REPORT_PATH, 'utf8');
    const stat = fs.statSync(REPORT_PATH);
    const overall = /OVERALL:\s*(PASS|WARN|FAIL)/i.exec(content);
    const summary = /OVERALL:\s*(PASS|WARN|FAIL)\s*\|\s*([^\r\n]+)/i.exec(content);
    return {
      available: true,
      result: overall ? overall[1].toUpperCase() : 'UNKNOWN',
      summary: summary ? summary[2].trim() : null,
      modifiedAt: stat.mtime.toISOString()
    };
  } catch {
    return { available: false, result: 'UNKNOWN', summary: null, modifiedAt: null };
  }
}

// Web research: up is SearXNG's /healthz, which costs the search engines nothing (a real search every health tick got
// them rate-limiting us). Whether searches find anything comes from the last real one; with none for SEARCH_CHECK_MS,
// one test search runs in the background. A search that found nothing marks research DEGRADED, naming the engines that
// did not answer.
const SEARCH_CHECK_MS = Math.max(1000, Number(process.env.SEARCH_CHECK_MS) || 6 * 60 * 60 * 1000);
let searchOutcome = null, searchTest = null;
function noteSearch(j) {
  const unresponsive = (Array.isArray(j?.unresponsive_engines) ? j.unresponsive_engines : []).map(x => String(Array.isArray(x) ? x[0] : x));
  searchOutcome = { at: Date.now(), results: Array.isArray(j?.results) ? j.results.length : null, unresponsive };
}
async function searchProbe() {
  const up = await probe('search', 'Web research', `${SEARXNG_URL}/healthz`, [200], 5000);
  if (up.state !== 'HEALTHY') return up;
  if (!searchTest && (!searchOutcome || Date.now() - searchOutcome.at > SEARCH_CHECK_MS)) {
    searchTest = searxSearch('weather today').catch(() => {}).finally(() => { searchTest = null; });
  }
  if (searchOutcome?.results !== 0) return up;
  const engines = searchOutcome.unresponsive.length ? ` (not answering: ${searchOutcome.unresponsive.join(', ')})` : '';
  return { ...up, state: 'DEGRADED', error: `Searches find nothing${engines}` };
}

const HEALTH_SETTLE_MS = Number(process.env.HEALTH_SETTLE_MS || 120000);
async function getStatusAndRecordTransition() {
  const services = await Promise.all([
    probe('ollama', 'Intelligence', `${OLLAMA_URL}/api/tags`, [200]),
    probe('comfy', 'Image generation', `${COMFY_URL}/system_stats`, [200]),
    probe('n8n', 'Automation engine', `${N8N_URL}/healthz`, [200]),
    probe('proxy', 'Conversation compatibility', `${PROXY_URL}/healthz`, [200]),
    searchProbe(),
    probe('home', 'Companion home', `${MAC_AI_HOME_URL}/`, [200], 3000, false),
    probe('dsh', 'Developer assistant', `${MAC_DSH_URL}/`, [200, 401], 3000, false)
  ]);

  const overall = overallState(services);
  const previous = readState(STATUS_STORE, {});
  const now = new Date();
  // A slow probe can flip health for one check. Record a change only once the new state has held for
  // HEALTH_SETTLE_MS, so the Audit log and Inbox show real outages instead of a flicker every minute.
  if (!previous.overall || previous.overall === overall) {
    writeState(STATUS_STORE, { overall, checkedAt: now.toISOString() });
  } else if (previous.pending !== overall) {
    writeState(STATUS_STORE, { ...previous, pending: overall, pendingSince: now.toISOString(), checkedAt: now.toISOString() });
  } else if (now - new Date(previous.pendingSince) >= HEALTH_SETTLE_MS) {
    if (overall === 'HEALTHY') {
      recordActivity('recovery', 'System recovered', `Health returned to normal from ${previous.overall}.`, { previous: previous.overall, current: overall });
      notifier.notify(notifyLib.serviceEvent(overall));
    } else {
      const affected = services.filter(x => x.required !== false && x.state !== 'HEALTHY').map(x => x.label);
      recordActivity('system', 'System needs attention', affected.join(', ') || `Health changed to ${overall}.`, { previous: previous.overall, current: overall });
      notifier.notify(notifyLib.serviceEvent(overall, affected));
    }
    writeState(STATUS_STORE, { overall, checkedAt: now.toISOString() });
  }

  return {
    appliance: 'Local AI',
    overall,
    checkedAt: new Date().toISOString(),
    services: services.map(presentService),
    serviceSummary: {
      core: services.filter(x => x.required !== false).length,
      optional: services.filter(x => x.required === false).length,
      coreUnhealthy: services.filter(x => x.required !== false && x.state !== 'HEALTHY').length,
      optionalUnhealthy: services.filter(x => x.required === false && x.state !== 'HEALTHY').length
    },
    certification: require('./release').deployCheck(certificationInfo(), release)
  };
}

async function apiStatus(req, res) {
  json(res, 200, await getStatusAndRecordTransition());
}

// Downloads and removals from the Models page. Models Local AI itself uses can't be removed: the default chat
// model and the GridCraft bridge's model (GRIDCRAFT_MODEL, as in host/gridcraft-bridge.py); PROTECTED_MODELS adds more.
const PROTECTED_MODELS = () => [...new Set([MODEL, process.env.GRIDCRAFT_MODEL || 'qwen3:4b-instruct', ...String(process.env.PROTECTED_MODELS || '').split(',').map(x => x.trim()).filter(Boolean)])];
const modelPulls = createModelPulls({
  baseUrl: OLLAMA_URL,
  protectedModels: PROTECTED_MODELS,
  onFinish: p => {
    capabilityCache = { expiresAt: 0, value: null };
    if (p.state === 'done') recordActivity('model', 'Model downloaded', p.name);
    else if (p.state === 'failed') recordActivity('model', 'Model download failed', `${p.name}: ${p.error}`);
  }
});
async function apiModelPulls(req, res) { json(res, 200, { items: modelPulls.list() }); }
async function apiModelPull(req, res) {
  if (!sameOriginJson(req, res)) return;
  try { const b = await readBody(req); json(res, 202, { item: modelPulls.start(b.name) }); }
  catch (e) { json(res, e.status || 400, { error: e.message }); }
}
async function apiModelPullCancel(req, res) {
  if (!sameOriginJson(req, res)) return;
  try { const b = await readBody(req); json(res, 200, { item: modelPulls.cancel(b.name) }); }
  catch (e) { json(res, e.status || 400, { error: e.message }); }
}
async function apiModelDelete(req, res) {
  if (!sameOriginJson(req, res)) return;
  try {
    const b = await readBody(req);
    const result = await modelPulls.remove(b.name);
    capabilityCache = { expiresAt: 0, value: null };
    recordActivity('model', 'Model removed', result.name);
    json(res, 200, result);
  } catch (e) { json(res, e.status || 502, { error: e.message }); }
}

async function apiModels(req, res) {
  try {
    const runtime = await loadOllamaModelRuntime({
      baseUrl: OLLAMA_URL,
      fetchWithTimeout,
      defaultModel: MODEL,
      timeoutMs: 5000
    });
    json(res, 200, { ...runtime, protectedModels: PROTECTED_MODELS() });
  } catch (e) {
    const error = String(e.message || e);
    json(res, 502, {
      error,
      available: false,
      default: MODEL,
      models: [MODEL],
      installed: [],
      loaded: [],
      installedCount: 0,
      loadedCount: 0,
      runtimeAvailable: false,
      runtimeError: error,
      defaultInstalled: false,
      defaultLoaded: false
    });
  }
}

async function searxSearch(query, signal = null) {
  const u = new URL(`${SEARXNG_URL}/search`);
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'json');
  const r = await fetchWithTimeout(u.toString(), { signal }, 8000);
  if (!r.ok) throw new Error(`Web research returned HTTP ${r.status}`);
  const j = await r.json();
  noteSearch(j);
  return (j.results || []).slice(0, 6).map(x => ({
    title: x.title || '',
    url: x.url || '',
    content: x.content || ''
  }));
}

function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages.slice(-16) : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 26000) }));
}

function capabilityPrompt(snapshot) {
  const images = snapshot?.images?.models || [];
  const imageEngineList = snapshot?.images?.engines || [];
  const textModels = snapshot?.models || {};
  const installedText = Array.isArray(textModels.installed) ? textModels.installed : [];
  const loadedText = Array.isArray(textModels.loaded) ? textModels.loaded : [];
  const serviceText = (snapshot?.services || []).map(x => `${x.name}:${x.state}${x.required === false ? ':optional' : ':core'}`).join(', ');
  return [
    'RUNTIME CAPABILITY SNAPSHOT (authoritative for this response):',
    `Local AI version: ${snapshot?.version || APP_VERSION}`,
    `Configured local model: ${snapshot?.model || MODEL}`,
    `Appliance state: ${snapshot?.overall || 'UNKNOWN'}`,
    `Services: ${serviceText || 'unavailable'}`,
    `Installed text models: ${installedText.length ? installedText.map(x => x.name).join(', ') : 'none verified'}`,
    `Loaded text models: ${loadedText.length ? loadedText.map(x => `${x.name}${x.contextLength ? ` [ctx ${x.contextLength}]` : ''}`).join(', ') : 'none currently resident'}`,
    `Model runtime detail: ${textModels.runtimeAvailable ? 'available' : 'unavailable'}`,
    `Image engines (Images page): ${imageEngineList.length ? imageEngineList.map(x => `${x.label} = ${x.model} (${x.files.join(', ')})`).join('; ') : 'none discovered'}`,
    `Installed image checkpoints: ${images.length ? images.map(x => `${x.checkpoint} [${x.familyLabel || x.family}]`).join(', ') : 'none discovered'}`,
    `Projects: ${snapshot?.projects?.count ?? 0}`,
    `Engineering: ${snapshot?.engineering?.active ?? 0} active; ${snapshot?.engineering?.awaitingApproval ?? 0} awaiting approval`,
    `Changes: ${snapshot?.changes?.pending ?? 0} pending`,
    `Issues: ${snapshot?.issues?.open ?? 0} open`,
    `PowerShell Workbench: ${snapshot?.powershell?.configured ? 'configured' : 'not configured'}`,
    'Use this snapshot instead of guessing. Never claim a text or image model is installed unless it appears above. A text model can be installed without being currently loaded because Ollama may unload idle models. Never report a hard-coded appliance version. Image models are not Ollama models: they are files in ComfyUI on the Windows computer (its models folders: checkpoints, diffusion_models, text_encoders, vae), so never suggest installing one with Ollama. Image generation is available only when a discovered image engine or supported checkpoint is present. Local AI can prepare self-changes through Engineering -> Change Intelligence -> approval -> host self-update; never claim a change was applied unless the runtime reports it.'
  ].join('\n');
}

async function getCapabilitiesSnapshot(force = false) {
  if (!force && capabilityCache.value && capabilityCache.expiresAt > Date.now()) return capabilityCache.value;
  const [statusResult, imageResult, modelResult] = await Promise.allSettled([
    getStatusAndRecordTransition(),
    getImageModelLists().then(lists => ({
      ...buildImageModelCatalog(lists.checkpoints),
      engines: imageEngines.discoverEngines(lists).engines.map(e => ({ id: e.id, label: e.label, model: e.model, files: Object.values(e.files) }))
    })),
    loadOllamaModelRuntime({
      baseUrl: OLLAMA_URL,
      fetchWithTimeout,
      defaultModel: MODEL,
      timeoutMs: 5000
    })
  ]);
  const status = statusResult.status === 'fulfilled' ? statusResult.value : { overall: 'UNKNOWN', services: [] };
  const imageCatalog = imageResult.status === 'fulfilled' ? imageResult.value : { models: [], families: [], engines: [], defaultCheckpoint: null, defaultFamily: null };
  const modelRuntime = modelResult.status === 'fulfilled'
    ? modelResult.value
    : {
        available: false,
        default: MODEL,
        models: [],
        installed: [],
        loaded: [],
        installedCount: 0,
        loadedCount: 0,
        runtimeAvailable: false,
        runtimeError: String(modelResult.reason?.message || modelResult.reason || 'Model runtime unavailable'),
        defaultInstalled: false,
        defaultLoaded: false
      };
  const changes = changeStore();
  const issues = issueStore();
  const engineeringRuns = effectiveEngineeringRuns();
  const snapshot = {
    appliance: 'Local AI', version: APP_VERSION, model: MODEL,
    overall: status.overall, services: status.services || [], serviceSummary: status.serviceSummary || {},
    models: modelRuntime,
    images: { ...imageCatalog, available: imageCatalog.models.some(x => x.supported) || imageCatalog.engines.length > 0 },
    projects: { count: projectStore().length },
    agents: { running: agentRunStore().filter(x => x.status === 'running').length },
    changes: { pending: changes.filter(x => ['planned','patch_failed','validation_failed','staged','awaiting_approval','approved','apply_requested'].includes(x.status)).length },
    issues: { open: issues.filter(x => x.status === 'open').length },
    engineering: { active: engineeringRuns.filter(x => x.status === 'running').length, awaitingApproval: engineeringRuns.filter(x => x.status === 'awaiting_approval').length },
    powershell: { configured: !!POWERSHELL_BRIDGE_TOKEN, localOnly: true, localPort: LOCAL_UI_PORT || listenPort() },
    watch: watchdog.list()
  };
  capabilityCache = { value: snapshot, expiresAt: Date.now() + CAPABILITY_CACHE_MS };
  return snapshot;
}

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
const displayFeed = require('./display-feed');
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
async function displayFeedNow() {
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
  const feed = displayFeed.buildFeed({ needs, watch: watchdog.list(), running, done: displayDoneRuns(2 * 3600 * 1000), weather: await feedWeatherText(), images, disk, pi: await piHub.read() });
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
    json(res, 200, { ...displayMessages.settings(), kindsAvailable: require('./display-messages').KINDS });
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
async function apiDisplayFeed(req, res) {
  try { json(res, 200, await displayFeedNow()); } catch (e) { json(res, 500, { error: String(e.message || e) }); }
}

// GET /api/display/events?since=<sig>: the display's long poll (Workshop OS 12.6). Answers {sig} at once when the
// feed's cards are not the ones `since` describes, else when they change, else after 25 s; the display then fetches
// the feed. The signature leaves out the times, so "12 min ago" ticking over is not news.
async function apiDisplayEvents(req, res, urlObj) {
  const since = String(urlObj.searchParams.get('since') || '').slice(0, 64);
  const deadline = Date.now() + 25000;
  let closed = false;
  res.on('close', () => { closed = true; }); // the display gave up (or asked something else)
  try {
    for (;;) {
      const sig = displayFeed.signature(await displayFeedNow());
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
    startMissionRun(subject, '', undefined);
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

async function apiCapabilities(req, res) {
  try { json(res, 200, await getCapabilitiesSnapshot(true)); }
  catch (e) { storageError(res,e,500); }
}

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

// The messages for the text model: system prompt, research sources (trimmed first), then the conversation, fitted to the shared context.
function chatMessages(prep) {
  const system = systemPrompt('', prep.capabilityContext, prep.brief, prep.voice ? voiceFacts({ now: new Date(), timeZone: voiceTimeZone(), includeZone: true }) : '', prep.sourceHost);
  const sources = prep.researchContext
    ? [{ role: 'system', kind: 'sources', content: `Current metasearch results are below. Use them when relevant and cite source numbers like [1].\n\n${prep.researchContext}` }]
    : [];
  return fitMessages([system, ...sources, ...prep.messages], { numCtx: TEXT_NUM_CTX, reserve: ANSWER_RESERVE });
}

async function prepareChat(body, signal = null) {
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
  return { model, messages, sources, researchContext, capabilityContext, brief: body.brief === true, voice: body.voice === true, sourceHost: typeof body.sourceHost === 'string' ? body.sourceHost : '' };
}

async function apiChat(req, res) {
  try { json(res, 200, await chatOnce(await readBody(req))); }
  catch (e) { storageError(res,e,500); }
}

// One non-streaming chat turn as a run; shared by /api/chat and /api/glance/ask.
async function chatOnce(body) {
  let execution = null;
  try {
    execution = createChatExecution(body, false);
    runLedger.start(execution.id, body.webSearch === true ? 'Research run started' : 'Chat run started');
    const prep = await prepareChat(body);
    const started = Date.now();

    const r = await modelFetchWithTimeout(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: prep.model,
        messages: chatMessages(prep),
        stream: false,
        keep_alive: TEXT_KEEP_ALIVE,
        options: { num_ctx: TEXT_NUM_CTX }
      })
    }, CHAT_MODEL_TIMEOUT_MS);

    const raw = await r.text();
    if (!r.ok) throw new Error(`Intelligence service HTTP ${r.status}: ${raw.slice(0, 500)}`);
    const j = JSON.parse(raw);
    const content = j?.message?.content || '';
    const elapsedMs = Date.now() - started;
    const lastUser = [...prep.messages].reverse().find(m => m.role === 'user');

    recordActivity(
      body.webSearch === true ? 'research' : 'chat',
      body.webSearch === true ? 'Researched with AI' : 'Asked AI',
      (lastUser?.content || '').slice(0, 180),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id }
    );
    const artifact = recordTurnArtifact(
      content.slice(0, 420),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id },
      { prompt: lastUser?.content || '', response: content.slice(0, 40000), sources: prep.sources },
      execution
    );
    runLedger.complete(execution.id, {
      summary: content.slice(0, 420),
      output: { text: content.slice(0, 40000), model: prep.model, elapsedMs, sources: prep.sources },
      artifactIds: artifact?.id ? [artifact.id] : [],
      meta: { model: prep.model, elapsedMs, sources: prep.sources.length, ...(body.voice === true || body.voiceRun === true ? { voice: true } : {}) }
    });
    keepLongAnswer(execution.id, content.slice(0, 40000));

    return {
      message: { role: 'assistant', content },
      model: prep.model,
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

    armIdle();
    // modelFetch: no 300 s limit on Ollama's first byte while it reads a long prompt behind other work.
    const upstream = await modelFetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: prep.model,
        messages: chatMessages(prep),
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
    let full = '';

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

    const elapsedMs = Date.now() - started;
    const lastUser = [...prep.messages].reverse().find(m => m.role === 'user');
    recordActivity(
      body.webSearch === true ? 'research' : 'chat',
      body.webSearch === true ? 'Researched with AI' : 'Asked AI',
      (lastUser?.content || '').slice(0, 180),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id }
    );
    const artifact = recordTurnArtifact(
      full.slice(0, 420),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id },
      { prompt: lastUser?.content || '', response: full.slice(0, 40000), sources: prep.sources },
      execution
    );
    runLedger.complete(execution.id, {
      summary: full.slice(0, 420),
      output: { text: full.slice(0, 40000), model: prep.model, elapsedMs, sources: prep.sources },
      artifactIds: artifact?.id ? [artifact.id] : [],
      meta: { model: prep.model, elapsedMs, sources: prep.sources.length }
    });
    keepLongAnswer(execution.id, full.slice(0, 40000));

    send('done', { elapsedMs, model: prep.model, sources: prep.sources, runId: execution.id });
    res.end();
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

async function apiActivity(req, res) {
  const items = activityStore();
  json(res, 200, { items: items.slice(0, 100) });
}

async function apiActivityClear(req, res) {
  const items = activityStore();
  const kept = items.filter(x => x && (x.type === 'system' || x.type === 'recovery'));
  writeState(ACTIVITY_STORE, kept, items);
  recordActivity('system', 'User activity cleared', 'User-generated activity was cleared; system and recovery audit events were preserved.');
  json(res, 200, { ok: true, preserved: kept.length });
}

async function apiLibrary(req, res) {
  const items = libraryStore();
  const counts = items.reduce((acc, item) => {
    const key = item?.kind || 'artifact';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  json(res, 200, { items: items.slice(0, 250), counts, total: items.length });
}

async function apiLibraryUpdate(req, res) {
  try {
    const body = await readBody(req);
    const id = String(body.id || '');
    if (!id) return json(res, 400, { error: 'id is required' });
    const item = updateArtifact(id, body);
    if (!item) return json(res, 404, { error: 'Artifact not found' });
    json(res, 200, { ok: true, item });
  } catch (e) {
    storageError(res,e,400);
  }
}

async function apiLibraryDelete(req, res) {
  try {
    const body = await readBody(req);
    const id = String(body.id || '');
    if (!id) return json(res, 400, { error: 'id is required' });
    const deleted = deleteArtifact(id);
    if (!deleted) return json(res, 404, { error: 'Artifact not found' });
    recordActivity('system', 'Library item removed', 'An artifact was removed from the workspace library.');
    json(res, 200, { ok: true });
  } catch (e) {
    storageError(res,e,400);
  }
}

// ☆ Keep / un-keep a chat or research run: {runId, kept}. Un-keep takes it out of Library only; it stays in Work.
async function apiLibraryKeep(req, res) {
  try {
    const body = await readBody(req);
    const runId = String(body.runId || '');
    if (!cleanRunId(runId)) return json(res, 400, { error: 'runId is required' });
    if (typeof body.kept !== 'boolean') return json(res, 400, { error: 'kept must be true or false' });
    const out = setRunKept(runId, body.kept);
    if (out.error) return json(res, out.status, { error: out.error });
    json(res, 200, { ok: true, kept: out.kept, item: out.item });
  } catch (e) {
    storageError(res, e, 400);
  }
}

// Full answers too long for the run ledger: ?ids=run-a,run-b → {answers: {runId: text}} (a missing one is left out).
async function apiRunAnswers(req, res, urlObj) {
  const ids = String(urlObj.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
  if (!ids.length || ids.some(id => !cleanRunId(id))) return json(res, 400, { error: 'ids must be run ids' });
  const items = libraryStore(), answers = {};
  for (const id of ids) { const text = fullAnswer(id, items); if (typeof text === 'string') answers[id] = text; }
  json(res, 200, { answers });
}

async function apiWorkspace(req, res) {
  const activity = activityStore();
  const library = libraryStore();
  const byKind = library.reduce((acc, item) => {
    const key = item?.kind || 'artifact';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  json(res, 200, {
    activity: activity.slice(0, 8),
    recent: library.slice(0, 8),
    pinned: library.filter(x => x?.pinned).slice(0, 6),
    totals: { activity: activity.length, library: library.length, byKind }
  });
}

// ComfyUI describes a file picker as [[...names]] or, in newer nodes, ["COMBO", {options: [...names]}].
function comfyOptions(spec) {
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options;
  return [];
}

async function getCheckpointNames() {
  const r = await fetchWithTimeout(`${COMFY_URL}/object_info/CheckpointLoaderSimple`, {}, 7000);
  if (!r.ok) throw new Error(`Image service returned HTTP ${r.status}`);
  const j = await r.json();
  return comfyOptions(j?.CheckpointLoaderSimple?.input?.required?.ckpt_name);
}

function inferImageFamily(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'unknown';
  if (/\bflux\b/.test(n)) return 'flux';
  if (/sdxl|stable[._ -]?diffusion[._ -]?xl|xl[._ -]?base|\bxl\b/.test(n)) return 'sdxl';
  if (/v1[-._ ]?5|sd1[._ -]?5|stable[._ -]?diffusion[._ -]?1[._ -]?5|\b1[._ -]?5\b/.test(n)) return 'sd15';
  return 'unknown';
}

function imageFamilyLabel(family) {
  return ({ sd15: 'SD 1.5', sdxl: 'SDXL', flux: 'FLUX', unknown: 'Unknown' })[family] || family;
}

function imageModelInfo(name) {
  const family = inferImageFamily(name);
  if (family === 'flux') {
    return { checkpoint: name, family, familyLabel: imageFamilyLabel(family), supported: false, workflow: 'requires-custom-graph', reason: 'FLUX checkpoints require a dedicated ComfyUI workflow graph in this appliance release.' };
  }
  if (family === 'sdxl') {
    return { checkpoint: name, family, familyLabel: imageFamilyLabel(family), supported: true, workflow: 'checkpoint-basic', reason: 'Supported by the standard checkpoint workflow.' };
  }
  if (family === 'sd15') {
    return { checkpoint: name, family, familyLabel: imageFamilyLabel(family), supported: true, workflow: 'checkpoint-basic', reason: 'Supported by the standard checkpoint workflow.' };
  }
  return { checkpoint: name, family, familyLabel: imageFamilyLabel(family), supported: true, workflow: 'checkpoint-basic', reason: 'Unknown family; generation will use the standard checkpoint workflow on a best-effort basis.' };
}

function buildImageModelCatalog(names) {
  const models = (Array.isArray(names) ? names : []).map(imageModelInfo);
  const order = ['sd15', 'sdxl', 'flux', 'unknown'];
  const families = order
    .map(family => {
      const group = models.filter(x => x.family === family);
      if (!group.length) return null;
      return {
        family,
        familyLabel: imageFamilyLabel(family),
        supported: group.some(x => x.supported),
        reason: group.some(x => x.supported) ? null : group[0].reason,
        models: group
      };
    })
    .filter(Boolean);
  const defaultModel = models.find(x => x.supported) || models[0] || null;
  return {
    models,
    families,
    defaultCheckpoint: defaultModel ? defaultModel.checkpoint : null,
    defaultFamily: defaultModel ? defaultModel.family : null
  };
}


















// ===== CUMULATIVE PRODUCT PLATFORM (v1.3+) ===================================
// parseInt so suffixed versions such as the staged smoke server's '1.18-stage' keep their level.
// Features are gated by the 1.x minor version. A 2.x (or later) release includes every 1.x feature.
function featureLevelFor(version) { const [major, minor] = String(version || '1.2').split('.'); return Number(major) >= 2 ? 99 : (parseInt(minor, 10) || 2); }
const FEATURE_LEVEL = featureLevelFor(APP_VERSION);
const PROJECTS_STORE = 'projects';
const CONVERSATIONS_STORE = 'conversations';
const KNOWLEDGE_STORE = 'knowledge';
const AUTOMATIONS_STORE = 'automations';
const RUNS_STORE = 'agentRuns';
const AUTOMATION_RUNS_STORE = 'automationRuns';
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';

function featureAtLeast(level) { return FEATURE_LEVEL >= level; }
function objectStore(file) { const v = readState(file, []); return Array.isArray(v) ? v : []; }
function saveStore(collection, items, _legacyMax, previous = items) { const saved = storage.save(collection, items, previous); if (RETENTION[collection]) storage.prune(collection, RETENTION[collection]); return saved; }
function makeId(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 9)}`; }
function nowIso() { return new Date().toISOString(); }
function normalizeTitle(v, fallback) { return titleFromText(String(v || ''), fallback); }
function requireFeature(res, level) { if (!featureAtLeast(level)) { json(res, 404, { error: `Requires v1.${level}+` }); return false; } return true; }

function automationStore(){ return objectStore(AUTOMATIONS_STORE); }
function agentRunStore(){ return objectStore(RUNS_STORE); }
function automationRunStore(){ return objectStore(AUTOMATION_RUNS_STORE); }










setInterval(()=>automationSchedulerTick().catch(e=>console.error(`${nowIso()} Automation scheduler failed:`,e)),30000).unref?.();
// ===== END CUMULATIVE PRODUCT PLATFORM =======================================


// ===== PRODUCT EVOLUTION PLATFORM (v1.7+) ==================================
const NOTIFICATIONS_STORE = 'notifications';
const MEMORY_STORE = 'memory';
const APPROVALS_STORE = 'approvals';
const MONITORS_STORE = 'monitors';
const { spawn } = require('child_process');


// Delete with Undo (app/trash.js): Work rows (a whole thread), Library items and projects. A day later it is for good.
const trash = new Trash({
  settings: storage, ledger: runLedger, now: () => Date.now(),
  collections: { get: name => objectStore(name), set: (name, next, previous) => writeState(name, next, previous) },
  beforeLibraryRemove: item => keepItemAnswers(item) // a conversation's runs stay in Work, with their long answers
});
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
async function apiItemsDelete(req, res) {
  if (!sameOriginJson(req, res)) return;
  try {
    const b = await readBody(req), out = trash.delete(b.items);
    const d = out.deleted, what = [d.runs && plural(d.runs, 'run'), d.library && plural(d.library, 'Library item'), d.projects && plural(d.projects, 'project')].filter(Boolean).join(', ');
    recordActivity('system', 'Deleted', what || 'Nothing');
    json(res, 200, { ok: true, ...out });
  } catch (e) { json(res, e.status || 500, { error: e.message || String(e) }); }
}
async function apiItemsRestore(req, res) {
  if (!sameOriginJson(req, res)) return;
  try {
    const b = await readBody(req), out = trash.restore(b.trashId);
    recordActivity('system', 'Undid a delete', '');
    json(res, 200, { ok: true, ...out });
  } catch (e) { json(res, e.status || 500, { error: e.message || String(e) }); }
}
try { trash.purge(); } catch (e) { console.error(`${nowIso()} Trash purge failed:`, e); }
setInterval(() => { try { trash.purge(); } catch (e) { console.error(`${nowIso()} Trash purge failed:`, e); } }, 60 * 60 * 1000).unref?.();

// Info notices (a release went live, a backup finished, a monitor recovered) stay in the Inbox but don't count
// toward its badge; only things that need the owner do. Older deploy notices predate `level`, hence the meta check.
const isInfoNotice=x=>x.level==='info'||(x.kind==='deploy'&&x.meta?.outcome==='deployed');
// Windows PowerShell 5.1 turns a blank stderr line from a native command into the text
// "System.Management.Automation.RemoteException"; it says nothing, so it never reaches the Inbox.
function hostDetail(detail){
  return String(detail||'').split('\n').map(l=>l.replace(/(?:\s*System\.Management\.Automation\.RemoteException)+\s*$/g,'').trimEnd()).filter(l=>l.trim()).join('\n').slice(0,2000);
}




setInterval(()=>monitorSchedulerTick().catch(()=>{}),60000).unref?.();


setInterval(()=>issueSchedulerTick(),5*60*1000).unref?.();
// ===== END CLAUDE BOARD ======================================================

// Cross-site request guard for every mutating route. Another website open in a LAN browser can send simple
// (no-preflight) POSTs here, so a browser request must come from this origin: Sec-Fetch-Site must not be
// cross-site, and an Origin header, when present, must name the host:port the request was sent to (Host, or
// X-Forwarded-Host from the HTTPS proxy). Requests without either header (scripts, hooks, curl, host jobs) pass:
// browsers always send Origin on these methods, other clients are not the threat this guards against.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function sameHost(protocol, origin, host) {
  if (!host) return false;
  try { return new URL(`${protocol}//${host}`).host === origin; } catch { return false; }
}
// The voice ask also answers GET, and an answer costs model time and may push a notification, so it is guarded too.
const GUARDED_GET = /^\/api\/glance\/ask(?:\?|$)/;
function crossSiteRequest(req) {
  if (!MUTATING_METHODS.has(req.method) && !(req.method === 'GET' && GUARDED_GET.test(req.url || ''))) return false;
  if (String(req.headers['sec-fetch-site'] || '').trim().toLowerCase() === 'cross-site') return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  let parsed;
  try { parsed = new URL(String(origin)); } catch { return true; } // "null" (sandboxed frame, file://) or garbage
  if (parsed.origin === 'null') return true;
  const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  return !sameHost(parsed.protocol, parsed.host, req.headers.host) && !sameHost(parsed.protocol, parsed.host, forwarded);
}
// The server's areas (app/server/*.js), each given what it uses; a module comes after those it takes names from.
const { bridgeHealth, gridcraftRuns, apiArtcraftOpen, apiArtcraftStatus, apiGridcraftCell, apiGridcraftDecide, apiGridcraftHealth, apiGridcraftOpen, apiGridcraftProgress, apiGridcraftRun, apiGridcraftRuns, apiGridcraftWorkbook, apiGridcraftWorkbooks, apiWorkshopPortalCode, apiWorkshopStatus } = require('./server/gridcraft').createGridcraft({ GRIDCRAFT_RUN_TIMEOUT_MS, GRIDCRAFT_URL, inFlight, json, makeId, modelFetchWithTimeout, readBody, recordActivity, sameOriginJson, storage, workshop, workshopCode, workshopPrinter });
// changes.js takes addNotification from here and this takes these two back from it: called, never at load, so
// they are looked up when called (the server split, step 6).
const { addNotification, apiApprovalCreate, apiApprovalDecide, apiApprovals, apiNotificationSeed, apiNotificationSystem, apiNotificationUpdate, apiNotifications, approvalStore, notificationStore, resolveDeployFailures } = require('./server/notifications').createNotifications({ APPROVALS_STORE, NOTIFICATIONS_STORE, changeStore: (...a) => changeStore(...a), decideChange: (...a) => decideChange(...a), hostDetail, isInfoNotice, json, makeId, normalizeTitle, notifier, notifyLib, nowIso, objectStore, prependRecord, readBody, recordActivity, requireFeature, saveStore, storage, storageError });
const { accessAddresses, apiAccess, apiPush, apiReleases, recordReleaseHistory } = require('./server/push').createPush({ APP_VERSION, json, notifier, nowIso, pushLib, readBody, release, resolveDeployFailures, storage, storageError });
const { apiBrowserFetch, apiComputerBatch, apiHttpCheck, apiRepoInspect, apiWorkbenchCommand, apiWorkbenchDiff, apiWorkbenchRead, apiWorkbenchSearch, apiWorkbenchTree, apiWorkbenchWrite, childEnv, safeWorkspacePath, simpleDiff, workspaceRel } = require('./server/workbench').createWorkbench({ URL, WORKSPACE_ROOT, fetchWithTimeout, fs, json, path, readBody, recordActivity, requireFeature, spawn, storageError });
// Takes changeStore, duplicateHtmlIds, duplicateTopLevelFunctions, generatePatchPlan, publicChange, runImproveReconcile, runProcess, saveChanges from changes.js, which takes names from it in turn: looked up when called (never at load).
const { apiIssuePrepareChange, apiIssueUpdate, apiIssues, apiIssuesScan, apiQuality, apiQualityClientEvent, apiQualityScan, issueSchedulerTick, issueStore, saveIssues } = require('./server/quality').createQuality({ APP_DIR, PUBLIC_DIR, SELF_APP_ROOT, addNotification, changeStore: (...a) => changeStore(...a), duplicateHtmlIds: (...a) => duplicateHtmlIds(...a), duplicateTopLevelFunctions: (...a) => duplicateTopLevelFunctions(...a), featureAtLeast, fs, generatePatchPlan: (...a) => generatePatchPlan(...a), getStatusAndRecordTransition, json, makeId, nowIso, objectStore, path, prependRecord, publicChange: (...a) => publicChange(...a), readBody, recordActivity, requireFeature, runImproveReconcile: (...a) => runImproveReconcile(...a), runProcess: (...a) => runProcess(...a), saveChanges: (...a) => saveChanges(...a), saveStore, storageError });
const { apiConversationDelete, apiConversationSave, apiConversations, apiKnowledge, apiKnowledgeDelete, apiKnowledgeImport, apiKnowledgeSearch, apiMemory, apiMemoryAdd, apiMemoryDelete, apiMemoryUpdate, apiProjectIntelligence, apiProjects, apiProjectsCreate, apiProjectsUpdate, knowledgeScore, knowledgeStore, projectStore } = require('./server/projects').createProjects({ CONVERSATIONS_STORE, KNOWLEDGE_STORE, MEMORY_STORE, PROJECTS_STORE, json, makeId, normalizeTitle, nowIso, objectStore, readBody, recordActivity, requireFeature, saveStore, storage, storageError });
const { busyNow, missionModelQueue, apiAgentCatalog, apiAgentDispatch, apiAgentMission, apiAgentMissionEvents, apiAgentMissionStart, apiAgentMissions, apiAgentModels, apiAgentPlan, apiAgentRun, apiAgents, apiBusy, apiSpecialistRun, runEngineeringPlannerModel, runLocalModel, startMissionRun } = require('./server/agents').createAgents({ APPROVALS_STORE, APP_DIR, DATA_DIR, ENGINEERING_MODEL_TIMEOUT_MS, LARGE_ANSWER_RESERVE, MISSION_ANSWER_RESERVE, MISSION_EVIDENCE_TOKENS, MISSION_MODEL_CONCURRENCY, MISSION_NUM_CTX, MISSION_TIMEOUT_MS, MODEL, OLLAMA_URL, RUNS_STORE, TEXT_KEEP_ALIVE, TEXT_NUM_CTX, TEXT_NUM_CTX_LARGE, URL, activeRunControllers, addNotification, agentRunStore, approvalStore, busy, fetchWithTimeout, fitMessages, inFlight, json, knowledgeScore, knowledgeStore, makeId, modelFetchWithTimeout, nowIso, plainText, readBody, recordActivity, requireFeature, runLedger, saveStore, searxSearch, storage, storageError, titleFromText });
// GET /api/world: Agent World's summary of the models, the printer, Spreadsheets and the Workshop display (app/world.js).
const world = require('./world').createWorld({
  ollamaUrl: OLLAMA_URL, fetchImpl: fetchWithTimeout, modelQueue: () => missionModelQueue, busy: busyNow, printer: workshopPrinter,
  bridgeHealth, gridcraftInFlight: () => inFlight.list().filter(w => w.kind === 'gridcraft').length,
  kioskUrl: () => workshop.portalUrl(), kioskHealth: url => workshop.workshopStatus({ url })
});
const { apiChangeApprove, apiChangeCapabilities, apiChangeDeployResult, apiChangePlan, apiChangeRequestApply, apiChangeStage, apiChanges, apiClaudeBoard, apiClaudeDecision, apiClaudeEvents, apiClaudeFindings, apiClaudePriorities, apiClaudeVote, apiEngineeringRun, apiEngineeringRuns, apiEngineeringStart, apiImproveHandoff, apiImproveIdea, apiImproveItem, apiImproveItems, apiImproveSignal, changeStore, claudeFindings, decideChange, duplicateHtmlIds, duplicateTopLevelFunctions, effectiveEngineeringRuns, engineeringRunStore, generatePatchPlan, publicChange, retireChangesOfClosedItems, runImproveReconcile, runProcess, saveChanges, shipQueuedSelfChanges } = require('./server/changes').createChanges({ APPROVALS_STORE, APP_VERSION, DATA_DIR, ENGINEERING_MODEL_TIMEOUT_MS, SELF_APP_ROOT, addNotification, approvalStore, childEnv, fetchWithTimeout, fs, improve, issueStore, json, makeId, notifier, nowIso, objectStore, path, plainText, readBody, recordActivity, release, requireFeature, runEngineeringPlannerModel, safeWorkspacePath, sameOriginJson, saveIssues, saveStore, simpleDiff, spawn, storage, storageError, workspaceRel });
const { apiConfig, redirectFor, serveStatic } = require('./server/web').createWeb({ APP_VERSION, CAPABILITY_CACHE_MS, CHAT_MODEL_TIMEOUT_MS, ENGINEERING_MODEL_TIMEOUT_MS, LOCAL_UI_PORT, MODEL, PUBLIC_DIR, accessAddresses, changeStore, claudeFindings, crypto, engineeringRunStore, fs, json, listenPort, path, release, text });
const { apiPowerShellApprove, apiPowerShellCancel, apiPowerShellCreate, apiPowerShellHostNext, apiPowerShellHostResult, apiPowerShellJobs, apiPowerShellRequestRun } = require('./server/powershell').createPowerShell({ LOCAL_UI_PORT, POWERSHELL_BRIDGE_TOKEN, POWERSHELL_UI_TOKEN, json, listenPort, makeId, nowIso, objectStore, readBody, recordActivity, requireFeature, saveStore, storageError });
const { apiCheckpoints, apiGenerateImage, apiImageModels, apiImageView, getImageModelLists, warmText } = require('./server/images').createImages({ COMFY_URL, IMAGE_ESTIMATES, IMAGE_PROMPT_MODEL, MODEL, OLLAMA_URL, URL, buildImageModelCatalog, cleanRunId, comfyOptions, fetchWithTimeout, getCheckpointNames, imageEngines, json, modelFetchWithTimeout, readBody, recordActivity, recordArtifact, runLedger, titleFromText, unloadTextModel, warmTextModel });
const { apiAutomationCreate, apiAutomationRun, apiAutomationUpdate, apiAutomations, apiMonitorCreate, apiMonitorRun, apiMonitors, apiMorningBrief, automationSchedulerTick, monitorSchedulerTick } = require('./server/automations').createAutomations({ AUTOMATIONS_STORE, AUTOMATION_RUNS_STORE, MONITORS_STORE, activityStore, addNotification, automationRunStore, automationStore, featureAtLeast, getStatusAndRecordTransition, inFlight, json, makeId, normalizeTitle, notificationStore, nowIso, objectStore, readBody, recordActivity, requireFeature, runLocalModel, saveStore, searxSearch, storageError });
const { apiRunCancel, apiRunRetry, apiRunUpdate, apiRuns, createChatExecution, needsThreads } = require('./server/runs').createRuns({ AUTOMATION_RUNS_STORE, MODEL, RUNS_STORE, WORK_CHIPS, activeRunControllers, agentRunStore, approvalStore, automationRunStore, changeStore, cleanRunId, effectiveEngineeringRuns, fetchWithTimeout, gridcraftRuns, json, keptMarker, listenPort, needsYou, nowIso, projectStore, readBody, recordActivity, runCard, runLedger, sanitizeMessages, saveStore, seenRuns, storageError, titleFromText, withSeen, workKind });
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = urlObj.pathname;

  try {
    if (!hostAllowed(req.headers.host, ALLOWED_HOSTS)) { req.resume(); res.setHeader('Connection', 'close'); return json(res, 421, { error: 'Unknown host name. Open Local AI by its own address.' }); }
    if (crossSiteRequest(req)) { req.resume(); res.setHeader('Connection', 'close'); return json(res, 403, { error: 'Cross-site request blocked' }); }
    signIn.check(req, p);
    if (req.method === 'GET' && p === '/api/signin/report') return signIn.apiReport(req, res, json);
    if (req.method === 'POST' && p === '/api/signin/report/clear') { signIn.clear(); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && p === '/healthz') return json(res, 200, { status: 'ok', appliance: 'Local AI', version: APP_VERSION, releaseCommit: release?.commit || null, storage: { engine: 'sqlite', schemaVersion: 1 }, addresses: accessAddresses() });
    if (req.method === 'GET' && p === '/api/busy') return apiBusy(req, res);
    if (req.method === 'GET' && p === '/api/world') return await world.api(req, res);
    if (req.method === 'GET' && p === '/api/releases') return await apiReleases(req, res);
    if (req.method === 'GET' && p === '/api/access') return await apiAccess(req, res);
    if (req.method === 'GET' && p === '/api/glance') return await apiGlance(req, res, urlObj);
    if ((req.method === 'GET' || req.method === 'POST') && p === '/api/voice/home') return await apiVoiceHome(req, res);
    if ((req.method === 'GET' || req.method === 'POST') && p === '/api/glance/ask') return await apiGlanceAsk(req, res, urlObj);
    if (p.startsWith('/api/push/')) return await apiPush(req, res, p);
    if (req.method === 'GET' && p === '/api/storage/status') return json(res, 200, storage.status());
    if (req.method === 'GET' && p === '/api/status') return await apiStatus(req, res);
    if (req.method === 'GET' && p === '/api/models') return await apiModels(req, res);
    if (req.method === 'GET' && p === '/api/models/pulls') return await apiModelPulls(req, res);
    if (req.method === 'POST' && p === '/api/models/pull') return await apiModelPull(req, res);
    if (req.method === 'POST' && p === '/api/models/pull/cancel') return await apiModelPullCancel(req, res);
    if (req.method === 'POST' && p === '/api/models/delete') return await apiModelDelete(req, res);
    if (req.method === 'GET' && p === '/api/config') return apiConfig(req, res);
    if (req.method === 'GET' && p === '/api/capabilities') return await apiCapabilities(req, res);
    if (req.method === 'GET' && p === '/api/activity') return await apiActivity(req, res);
    if (req.method === 'POST' && p === '/api/activity/clear') return await apiActivityClear(req, res);
    if (req.method === 'GET' && p === '/api/library') return await apiLibrary(req, res);
    if (req.method === 'POST' && p === '/api/library/update') return await apiLibraryUpdate(req, res);
    if (req.method === 'POST' && p === '/api/library/delete') return await apiLibraryDelete(req, res);
    if (req.method === 'POST' && p === '/api/items/delete') return await apiItemsDelete(req, res);
    if (req.method === 'POST' && p === '/api/items/restore') return await apiItemsRestore(req, res);
    if (req.method === 'POST' && p === '/api/library/keep') return await apiLibraryKeep(req, res);
    if (req.method === 'GET' && p === '/api/workspace') return await apiWorkspace(req, res);
    if (req.method === 'POST' && p === '/api/route') return await apiRoute(req, res);
    if (req.method === 'POST' && p === '/api/chat') return await apiChat(req, res);
    if (req.method === 'POST' && p === '/api/chat/stream') return await apiChatStream(req, res);
    if (req.method === 'GET' && p === '/api/images/models') return await apiImageModels(req, res);
    if (req.method === 'GET' && p === '/api/images/checkpoints') return await apiCheckpoints(req, res);
    if (req.method === 'POST' && p === '/api/images/generate') return await apiGenerateImage(req, res);
    if (req.method === 'GET' && p === '/api/images/view') return await apiImageView(req, res, urlObj);
    if (req.method === 'GET' && p === '/api/gridcraft/health') return await apiGridcraftHealth(req, res);
    if (req.method === 'POST' && p === '/api/gridcraft/run') return await apiGridcraftRun(req, res);
    if (req.method === 'GET' && p === '/api/gridcraft/runs') return await apiGridcraftRuns(req, res);
    if (req.method === 'GET' && p === '/api/gridcraft/workbook') return await apiGridcraftWorkbook(req, res, urlObj);
    if (req.method === 'GET' && p === '/api/gridcraft/workbooks') return await apiGridcraftWorkbooks(req, res);
    if (req.method === 'GET' && p === '/api/gridcraft/progress') return await apiGridcraftProgress(req, res);
    if (req.method === 'POST' && p === '/api/gridcraft/open') return await apiGridcraftOpen(req, res);
    if (req.method === 'POST' && p === '/api/gridcraft/cell') return await apiGridcraftCell(req, res);
    { const m = req.method === 'POST' && p.match(/^\/api\/gridcraft\/runs\/(gc-[\w-]+)\/(keep|discard)$/); if (m) return await apiGridcraftDecide(req, res, m[1], m[2]); }
    if (req.method === 'GET' && p === '/api/artcraft/status') return await apiArtcraftStatus(req, res);
    if (req.method === 'POST' && p === '/api/artcraft/open') return await apiArtcraftOpen(req, res);
    if (req.method === 'GET' && p === '/api/workshop/status') return await apiWorkshopStatus(req, res, urlObj);
    if (req.method === 'POST' && p === '/api/workshop/portal-code') return await apiWorkshopPortalCode(req, res);

    // cumulative release features
    if (req.method === 'GET' && p === '/api/projects') return await apiProjects(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/projects/create') return await apiProjectsCreate(req,res);
    if (req.method === 'POST' && p === '/api/projects/update') return await apiProjectsUpdate(req,res);
    if (req.method === 'GET' && p === '/api/conversations') return await apiConversations(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/conversations/save') return await apiConversationSave(req,res);
    if (req.method === 'POST' && p === '/api/conversations/delete') return await apiConversationDelete(req,res);
    if (req.method === 'GET' && p === '/api/knowledge') return await apiKnowledge(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/knowledge/import') return await apiKnowledgeImport(req,res);
    if (req.method === 'POST' && p === '/api/knowledge/delete') return await apiKnowledgeDelete(req,res);
    if (req.method === 'POST' && p === '/api/knowledge/search') return await apiKnowledgeSearch(req,res);
    if (req.method === 'GET' && p === '/api/agents/catalog') return await apiAgentCatalog(req,res);
    if (req.method === 'GET' && p === '/api/agents/models') return await apiAgentModels(req,res);
    if (req.method === 'POST' && p === '/api/agents/specialist/run') return await apiSpecialistRun(req,res);
    if (req.method === 'POST' && p === '/api/agents/dispatch') return await apiAgentDispatch(req,res);
    if (req.method === 'GET' && p === '/api/agents/missions') return await apiAgentMissions(req,res);
    if (req.method === 'GET' && p === '/api/agents/mission') return await apiAgentMission(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/agents/missions/start') return await apiAgentMissionStart(req,res);
    if (req.method === 'GET' && p === '/api/agents/missions/events') return await apiAgentMissionEvents(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/agents') return await apiAgents(req,res);
    if (req.method === 'POST' && p === '/api/agents/run') return await apiAgentRun(req,res);
    if (req.method === 'GET' && p === '/api/automations') return await apiAutomations(req,res);
    if (req.method === 'POST' && p === '/api/automations/create') return await apiAutomationCreate(req,res);
    if (req.method === 'POST' && p === '/api/automations/update') return await apiAutomationUpdate(req,res);
    if (req.method === 'POST' && p === '/api/automations/run') return await apiAutomationRun(req,res);
    if (req.method === 'GET' && p === '/api/workbench/tree') return await apiWorkbenchTree(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/workbench/read') return await apiWorkbenchRead(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/workbench/diff') return await apiWorkbenchDiff(req,res);
    if (req.method === 'POST' && p === '/api/workbench/write') return await apiWorkbenchWrite(req,res);
    if (req.method === 'POST' && p === '/api/workbench/search') return await apiWorkbenchSearch(req,res);
    if (req.method === 'POST' && p === '/api/browser/fetch') return await apiBrowserFetch(req,res);
    if (req.method === 'POST' && p === '/api/actions/http-check') return await apiHttpCheck(req,res);
    if (req.method === 'POST' && p === '/api/computer/batch') return await apiComputerBatch(req,res);


    // product evolution features
    if (req.method === 'GET' && p === '/api/notifications') return await apiNotifications(req,res);
    if (req.method === 'POST' && p === '/api/notifications/update') return await apiNotificationUpdate(req,res);
    if (req.method === 'POST' && p === '/api/notifications/seed') return await apiNotificationSeed(req,res);
    if (req.method === 'POST' && p === '/api/notifications/system') return await apiNotificationSystem(req,res);
    if (req.method === 'GET' && p === '/api/memory') return await apiMemory(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/memory/add') return await apiMemoryAdd(req,res);
    if (req.method === 'POST' && p === '/api/memory/update') return await apiMemoryUpdate(req,res);
    if (req.method === 'POST' && p === '/api/memory/delete') return await apiMemoryDelete(req,res);
    if (req.method === 'GET' && p === '/api/projects/intelligence') return await apiProjectIntelligence(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/approvals') return await apiApprovals(req,res);
    if (req.method === 'POST' && p === '/api/approvals/create') return await apiApprovalCreate(req,res);
    if (req.method === 'POST' && p === '/api/approvals/decide') return await apiApprovalDecide(req,res);
    if (req.method === 'POST' && p === '/api/agents/plan') return await apiAgentPlan(req,res);
    if (req.method === 'GET' && p === '/api/repo/inspect') return await apiRepoInspect(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/workbench/command') return await apiWorkbenchCommand(req,res);
    if (req.method === 'GET' && p === '/api/monitors') return await apiMonitors(req,res);
    if (req.method === 'POST' && p === '/api/monitors/create') return await apiMonitorCreate(req,res);
    if (req.method === 'POST' && p === '/api/monitors/run') return await apiMonitorRun(req,res);
    if (req.method === 'GET' && p === '/api/brief') return await apiMorningBrief(req,res);
    if (req.method === 'GET' && p === '/api/runs') return await apiRuns(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/runs/answers') return await apiRunAnswers(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/runs/cancel') return await apiRunCancel(req,res);
    if (req.method === 'POST' && p === '/api/runs/update') return await apiRunUpdate(req,res);
    if (req.method === 'POST' && p === '/api/runs/seen') return await apiRunsSeen(req,res);
    if (req.method === 'POST' && p === '/api/runs/retry') return await apiRunRetry(req,res);
    if (req.method === 'GET' && p === '/api/engineering/runs') return await apiEngineeringRuns(req,res);
    if (req.method === 'POST' && p === '/api/engineering/run') return await apiEngineeringRun(req,res);
    if (req.method === 'POST' && p === '/api/engineering/start') return await apiEngineeringStart(req,res);

    if (req.method === 'GET' && p === '/api/issues') return await apiIssues(req,res);
    if (req.method === 'POST' && p === '/api/issues/scan') return await apiIssuesScan(req,res);
    if (req.method === 'POST' && p === '/api/issues/update') return await apiIssueUpdate(req,res);
    if (req.method === 'POST' && p === '/api/issues/prepare-change') return await apiIssuePrepareChange(req,res);

    if (req.method === 'GET' && p === '/api/quality') return await apiQuality(req,res);
    if (req.method === 'POST' && p === '/api/quality/scan') return await apiQualityScan(req,res);
    if (req.method === 'POST' && p === '/api/quality/client-event') return await apiQualityClientEvent(req,res);

    if (req.method === 'GET' && p === '/api/changes') return await apiChanges(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/changes/capabilities') return await apiChangeCapabilities(req,res);
    if (req.method === 'POST' && p === '/api/changes/plan') return await apiChangePlan(req,res);
    if (req.method === 'POST' && p === '/api/changes/stage') return await apiChangeStage(req,res);
    if (req.method === 'POST' && p === '/api/changes/approve') return await apiChangeApprove(req,res);
    if (req.method === 'POST' && p === '/api/changes/request-apply') return await apiChangeRequestApply(req,res);
    if (req.method === 'POST' && p === '/api/changes/deploy-result') return await apiChangeDeployResult(req,res);

    if (req.method === 'GET' && p === '/api/powershell/jobs') return await apiPowerShellJobs(req,res);
    if (req.method === 'POST' && p === '/api/powershell/create') return await apiPowerShellCreate(req,res);
    if (req.method === 'POST' && p === '/api/powershell/approve') return await apiPowerShellApprove(req,res);
    if (req.method === 'POST' && p === '/api/powershell/request-run') return await apiPowerShellRequestRun(req,res);
    if (req.method === 'POST' && p === '/api/powershell/cancel') return await apiPowerShellCancel(req,res);
    if (req.method === 'GET' && p === '/api/powershell/host/next') return await apiPowerShellHostNext(req,res);
    if (req.method === 'POST' && p === '/api/powershell/host/result') return await apiPowerShellHostResult(req,res);
    if (p.startsWith('/api/claude/chat/') && await claudeChat.handle(req, res, urlObj, p)) return;
    if (req.method === 'GET' && p === '/api/improve/items') return await apiImproveItems(req,res);
    if (req.method === 'POST' && p === '/api/improve/idea') return await apiImproveIdea(req,res);
    if (req.method === 'POST' && p === '/api/improve/item') return await apiImproveItem(req,res);
    if (req.method === 'POST' && p === '/api/improve/handoff') return await apiImproveHandoff(req,res);
    if (req.method === 'POST' && p === '/api/improve/signal') return await apiImproveSignal(req,res);
    if (req.method === 'GET' && p === '/api/claude/board') return await apiClaudeBoard(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/claude/priorities') return await apiClaudePriorities(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/claude/events') return await apiClaudeEvents(req,res);
    if (req.method === 'POST' && p === '/api/watch/heartbeat') return await apiWatchHeartbeat(req,res);
    if (req.method === 'GET' && p === '/api/watch') return json(res, 200, { ...watchdog.summary(), display: storage.readSetting('display:heartbeat', null) });
    if (req.method === 'GET' && p === '/api/display/feed') return await apiDisplayFeed(req,res);
    if (req.method === 'GET' && p === '/api/display/ask') return await apiDisplayAsk(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/display/events') return await apiDisplayEvents(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/display/notify') return await apiDisplayNotify(req,res);
    if ((req.method === 'POST' && (p === '/api/display/pair' || p === '/api/display/pair/start')) || (req.method === 'GET' && p === '/api/display/pair/status')) return await apiDisplayPair(req,res,p);
    if (req.method === 'GET' && p === '/api/display/approvals') return await apiDisplayApprovals(req,res);
    if (req.method === 'POST' && p === '/api/display/approvals/decide') return await apiDisplayApprovalDecide(req,res);
    if (req.method === 'POST' && p === '/api/display/heartbeat') return await apiDisplayHeartbeat(req,res);
    if ((req.method === 'GET' || req.method === 'POST') && p === '/api/display/alerts') return await apiDisplayAlerts(req,res);
    if (req.method === 'POST' && p === '/api/claude/findings') return await apiClaudeFindings(req,res);
    if (req.method === 'POST' && p === '/api/claude/findings/vote') return await apiClaudeVote(req,res);
    if (req.method === 'POST' && p === '/api/claude/findings/decision') return await apiClaudeDecision(req,res);

    if (req.method === 'GET' && p.startsWith('/go/')) {
      if (redirectFor(req, res, p)) return;
    }
    if (req.method === 'GET') return serveStatic(req, res, p);
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    // A streaming handler may already have sent headers; writing them again would throw out of this handler.
    if (res.headersSent) { console.error(`${new Date().toISOString()} ${req.method} ${req.url} failed after response started:`, e); res.end(); }
    else storageError(res,e,500);
  }
});

// Log instead of exiting when background work (schedulers, model calls) rejects unexpectedly.
process.on('unhandledRejection', reason => console.error(`${new Date().toISOString()} Unhandled rejection:`, reason));

// One time: Library titles/summaries and Inbox notices saved before the encoding fixes show text that Windows
// PowerShell decoded as Windows-1252 ("512 ÃƒÆ’… 512"). Repair them; change requests keep what was pasted.
function repairGarbledTextOnce() {
  const KEY = 'repair:garbled-text-v1';
  if (storage.readSetting(KEY, null)) return;
  const { repairText } = require('./text-repair.js');
  const counts = {};
  for (const [collection, fields] of [[LIBRARY_STORE, ['title', 'summary']], [NOTIFICATIONS_STORE, ['title', 'detail']]]) {
    const items = objectStore(collection);
    let changed = 0;
    for (const item of items) {
      if (!item) continue;
      let touched = false;
      for (const f of fields) { const fixed = repairText(item[f]); if (fixed !== item[f]) { item[f] = fixed; touched = true; } }
      if (touched) changed++;
    }
    if (changed) writeState(collection, items);
    counts[collection] = changed;
  }
  storage.writeSetting(KEY, { completedAt: nowIso(), repaired: counts });
  if (counts[LIBRARY_STORE] || counts[NOTIFICATIONS_STORE]) console.log(`${nowIso()} Repaired garbled text: ${JSON.stringify(counts)}`);
}

// One time: runs saved before the encoding fixes have the same garbled text in Work ("ideÃƒÂ¢…"), and some model
// titles carry markdown bold ("**Dev Design**") that Work shows as asterisks. Times and status are left alone.
function repairRunTextOnce() {
  const KEY = 'repair:run-text-v1';
  if (storage.readSetting(KEY, null)) return;
  const { repairText } = require('./text-repair.js');
  const fix = t => repairText(t).replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
  const repaired = runLedger.rewriteText(fix);
  storage.writeSetting(KEY, { completedAt: nowIso(), repaired });
  if (repaired) console.log(`${nowIso()} Repaired run text: ${repaired}`);
}

// One time: image runs saved before the summary format changed read "1 704 × 1024 image edited with …", where the
// count looks like a width. Only the summary changes; times, status and output are left alone.
function repairImageSummariesOnce() {
  const KEY = 'repair:image-summaries-v1';
  if (storage.readSetting(KEY, null)) return;
  const { repairImageSummary } = require('./text-repair.js');
  const repaired = runLedger.rewriteText(repairImageSummary);
  storage.writeSetting(KEY, { completedAt: nowIso(), repaired });
  if (repaired) console.log(`${nowIso()} Repaired image-run summaries: ${repaired}`);
}

// One time: conversations saved before one-item-per-thread have a Library item per turn. Merge them by thread; the
// oldest item keeps its id, title and pin, the newest gives the summary, and every turn's answer is kept.
function repairLibraryThreadsOnce() {
  const KEY = 'repair:library-threads-v1';
  if (storage.readSetting(KEY, null)) return;
  const items = libraryStore();
  const threadOf = it => it?.meta?.threadId || (it?.meta?.runId ? runLedger.get(it.meta.runId)?.threadId : '') || '';
  const { items: next, merged } = libraryThreads.mergeThreads(items, threadOf);
  if (merged) writeState(LIBRARY_STORE, next, items);
  storage.writeSetting(KEY, { completedAt: nowIso(), merged });
  if (merged) console.log(`${nowIso()} Merged per-turn Library items into their conversations: ${merged}`);
}

// One time (owner decision, 18 Oct: Library holds only what you keep): chats and research saved to Library by themselves
// leave it. Kept, pinned and project items stay (an item counts as in a project when it or one of its runs is filed
// there, or its run is pinned in Work), and images stay. Runs and threads are not touched, so every one is still in
// Work. The removed records are backed up under backup:library-kept-v1 (ids and records), so this can be undone.
const LIBRARY_KEPT_BACKUP = 'backup:library-kept-v1';
function repairLibraryKeptOnce() {
  const KEY = 'repair:library-kept-v1';
  if (storage.readSetting(KEY, null)) return;
  const items = libraryStore();
  const tied = it => libraryThreads.runIdsOf(it).some(id => { const r = runLedger.get(id); return !!(r?.projectId || r?.pinned); });
  const { keep, moved } = libraryThreads.splitKept(items, tied);
  if (moved.length) {
    if (!storage.readSetting(LIBRARY_KEPT_BACKUP, null)) storage.writeSetting(LIBRARY_KEPT_BACKUP, { at: nowIso(), ids: moved.map(it => it.id), items: moved });
    for (const it of moved) keepItemAnswers(it);
    writeState(LIBRARY_STORE, keep, items);
    const n = moved.length, line = `Library: ${n} auto-saved chat${n === 1 ? '' : 's'} moved out; ${n === 1 ? "it's" : "they're"} still in Work`;
    recordActivity('system', line, 'Library now holds only what you keep. Tap ☆ Keep on a chat to keep it there.', { moved: n, backup: LIBRARY_KEPT_BACKUP });
    console.log(`${nowIso()} ${line} (backup: ${LIBRARY_KEPT_BACKUP})`);
  }
  storage.writeSetting(KEY, { completedAt: nowIso(), moved: moved.length, ...(moved.length ? { backup: LIBRARY_KEPT_BACKUP } : {}) });
}



migrateLegacyActivityToLibrary();
recordReleaseHistory();
// Each start-up pass is on its own: one bad record must not stop the appliance starting.
for (const [name, pass] of [['ship queued self changes', shipQueuedSelfChanges], ['retire changes of closed items', retireChangesOfClosedItems]]) {
  try { pass(); } catch (e) { console.error(`${nowIso()} Start-up pass "${name}" failed:`, e); }
}
// One bad record must not stop the appliance starting; Improve catches up on the next scan or save.
try { runImproveReconcile({ startup: true }); } catch (e) { console.error(`${nowIso()} Improve start-up reconcile failed:`, e); }
// Health is checked on its own every minute, so an outage reaches the phone (Down/Recovered) even with no page open.
const HEALTH_TICK_MS = Math.max(200, Number(process.env.HEALTH_TICK_MS) || 60000);
setInterval(() => { getStatusAndRecordTransition().catch(() => {}); }, HEALTH_TICK_MS).unref();
setInterval(() => { try { watchdog.tick(); } catch (e) { console.error(`${nowIso()} Watchdog tick failed:`, e); } }, HEALTH_TICK_MS).unref();
repairGarbledTextOnce();
try { repairRunTextOnce(); } catch (e) { console.error(`${nowIso()} Run text repair failed:`, e); }
try { repairImageSummariesOnce(); } catch (e) { console.error(`${nowIso()} Image summary repair failed:`, e); }
try { repairLibraryThreadsOnce(); } catch (e) { console.error(`${nowIso()} Library thread repair failed:`, e); }
try { repairLibraryKeptOnce(); } catch (e) { console.error(`${nowIso()} Library kept-only repair failed:`, e); }

server.listen(PORT, '0.0.0.0', () => {
  warmText();
  // The bound port, not PORT: with PORT=0 the system picks a free one (tests/spawn-server.cjs reads it from this line).
  console.log(`${new Date().toISOString()} Local AI Appliance v${APP_VERSION} listening on 0.0.0.0:${server.address().port}`);
  recordActivity('system', 'Appliance started', `Local AI Appliance v${APP_VERSION} is ready.`);
  workshopPrinter.start();
});
const localUiServer = LOCAL_UI_PORT && LOCAL_UI_PORT !== PORT ? http.createServer((req, res) => server.emit('request', req, res)) : null;
localUiServer?.listen(LOCAL_UI_PORT, '0.0.0.0', () => console.log(`${new Date().toISOString()} Host-only tools listening on 0.0.0.0:${LOCAL_UI_PORT}`));


// Finish in-flight requests before closing the authoritative data store.
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  localUiServer?.close();
  server.close(() => { storage.close(); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => { storage.close(); process.exit(0); }, 10000).unref();
});
