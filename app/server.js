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
// The model coordinator (docs/superpowers/specs/2026-10-26-model-coordinator-design.md): local by default; free US cloud
// models only for work that isn't private, only when the owner switches cloud on (Models page, settings key below).
const modelRouter = require('./model-router');
const cloudModels = require('./cloud-models').createCloudModels();
const ROUTING_KEY = 'model-routing';
const routingSetting = () => ({ cloud: false, ...storage.readSetting(ROUTING_KEY, {}) });
// Chat, research, the change planner and mission summaries all go through this one runner (app/model-coordinator.js).
// What the server's own key and token files hold (the Mac key's hash, route keys) is never sent either, if it ever
// turned up in text: read at each cloud call, small files in DATA_DIR only.
const keyFileValues = () => { try { return fs.readdirSync(DATA_DIR).filter(f => /key|token|secret/i.test(f)).flatMap(f => { try { const p = path.join(DATA_DIR, f), st = fs.statSync(p); return st.isFile() && st.size < 4096 ? [fs.readFileSync(p, 'utf8').trim()] : []; } catch { return []; } }); } catch { return []; } };
const coordinator = require('./model-coordinator').createCoordinator({ modelRouter, cloudModels, routingSetting, recordActivity: (...a) => recordActivity(...a), localModel: MODEL, secrets: keyFileValues });
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
  storage, sendPush: pushLib.sendPush, sendHub: require('./hub-notify').createHubNotify(), vapid: pushLib.loadOrCreateVapid(storage),
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
// LocalAI Materials client (app/materials.js): active spool & inventory metrics for display feed.
const materialsClient = require('./materials').createMaterialsClient();
// The display's Clear plate goes through Local AI to Bambuddy (app/bambuddy-control.js).
const bambuddyControl = require('./bambuddy-control').createBambuddyControl();
const { plateClearRefusal, clearPlateMessage } = require('./bambuddy-control');
let plateClearing = false; // an overlapping clear-plate request is refused while one is in flight
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
// The journal (app/journal.js): one searchable record of what happens; finished runs are recorded as they end.
const journal = require('./journal').createJournal({ db: storage.db, now: clockNow, timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
const journalRecorders = require('./journal-recorders');
const runLedger = new RunLedger({ storage, onTransition: (run, previous) => {
  const e = notifyLib.runEvent(run, previous); if (e) notifier.notify(e);
  const entry = journalRecorders.runEntry(run); if (entry) journal.record(entry);
} });
const activeRunControllers = new Map();
const claudeChat = require('./claude-chat').createClaudeChat({ storage, dataDir: DATA_DIR, json, readBody });
const hostAddrs = require('./signin').hostAddresses();
const isHostReq = req => !req.headers['x-forwarded-for'] && hostAddrs.has(String(req.socket?.remoteAddress || '').replace(/^::ffff:/, ''));
// Print lab: a read-only copy of the Mac's print-lab records; only the Mac (its key) writes. The live print
// block reads the Workshop printer's last polled state; it never asks the display itself.
const labCallers = require('./lab-callers').createLabCallers({ storage });
const printLab = require('./print-lab').createPrintLab({
  storage,
  dataDir: DATA_DIR,
  json,
  macAuthorized: req => claudeChat.macAuthorized(req),
  deviceFor: req => claudeChat.deviceFor(req) || (isHostReq(req) ? { id: 'dev-mac-local', name: 'Mac' } : null),
  printer: () => workshopPrinter.current()
});
// Sign-in (app/signin.js): who would be refused is listed on Health; the routes that run code, write files or approve
// changes are refused without a device, and LOCALAI_SIGN_IN=required refuses the rest.
// The Workshop display's key (X-LocalAI-Display-Key) signs it in for its feed only; host/workshop-display/set-key.sh sets it.
const displayKey = require('./route-keys').createRouteKey({ dataDir: DATA_DIR, file: 'workshop-display-key.sha256', header: 'x-localai-display-key' });
// The display's Judge it sheet (app/display-lab.js): the phone's verdict request, queued from the display's key alone.
const displayLab = require('./display-lab').createDisplayLab({ labStore: printLab, json, authorized: req => displayKey.authorized(req) });
// Pi Hub's service key (X-LocalAI-Hub-Key, app/hub-key.js): the AI cards, and what the display's key opens, for Pi Hub.
const hubKey = require('./hub-key');
const signIn = require('./signin').createSignIn({ storage, signedIn: req => !!claudeChat.deviceFor(req) || claudeChat.macAuthorized(req) || isHostReq(req), routeKeys: {
  '/api/display/feed': req => displayKey.authorized(req),
  '/api/display/ai-cards': req => hubKey.authorized(req),
  '/api/display/ask': req => displayKey.authorized(req) || hubKey.authorized(req),
  '/api/display/events': req => displayKey.authorized(req),
  '/api/display/approvals': req => displayKey.authorized(req) || hubKey.authorized(req),
  '/api/display/approvals/decide': req => displayKey.authorized(req) || hubKey.authorized(req),
  '/api/display/heartbeat': req => displayKey.authorized(req),
  '/api/display/printer/clear': req => displayKey.authorized(req),
  '/api/display/poster': req => displayKey.authorized(req),
  '/api/display/lab/judge': req => displayKey.authorized(req),
  '/api/display/lab/verdict': req => displayKey.authorized(req),
  // The feed's latest-image card links here; the display fetches the JPEG with its key.
  '/api/images/view': req => displayKey.authorized(req) || hubKey.authorized(req),
  // Pi Hub's own reads (its Agents tile, Needs you and print lab line) and its house question.
  '/api/world': req => hubKey.authorized(req),
  '/api/attention': req => hubKey.authorized(req),
  '/api/lab/projects': req => hubKey.authorized(req),
  '/api/chat': req => hubKey.authorized(req)
} });








// Activity and Library (app/server/library.js); created here, before the areas below that record activity.
const { activityStore, apiActivity, apiActivityClear, apiLibrary, apiLibraryDelete, apiLibraryKeep, apiLibraryUpdate, apiRunAnswers, apiRunsSeen, apiWorkspace, keepItemAnswers, keepLongAnswer, keptMarker, libraryStore, migrateLegacyActivityToLibrary, recordActivity, recordArtifact, recordTurnArtifact, sanitizeMessages, seenRuns, titleFromText, withSeen } = require('./server/library').createLibrary({ ACTIVITY_STORE, LIBRARY_STORE, cleanRunId, imageEngines, json, libraryThreads, nowIso, prependRecord, readBody, readState, runLedger, storage, storageError, writeState });

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
const { bridgeHealth, gridcraftRuns, apiArtcraftOpen, apiArtcraftStatus, apiGridcraftCell, apiGridcraftDecide, apiGridcraftDownload, apiGridcraftHealth, apiGridcraftNew, apiGridcraftOpen, apiGridcraftProgress, apiGridcraftRun, apiGridcraftRuns, apiGridcraftUpload, apiGridcraftWorkbook, apiGridcraftWorkbooks, apiWorkshopCamera, apiWorkshopPortalCode, apiWorkshopStatus } = require('./server/gridcraft').createGridcraft({ GRIDCRAFT_RUN_TIMEOUT_MS, GRIDCRAFT_URL, inFlight, json, makeId, modelFetchWithTimeout, readBody, recordActivity, sameOriginJson, storage, workshop, workshopCode, workshopPrinter });
// changes.js takes addNotification from here and this takes these two back from it: called, never at load, so
// they are looked up when called (the server split, step 6).
const { addNotification, apiApprovalCreate, apiApprovalDecide, apiApprovals, apiNotificationSeed, apiNotificationSystem, apiNotificationUpdate, apiNotifications, approvalStore, notificationStore, resolveDeployFailures } = require('./server/notifications').createNotifications({ APPROVALS_STORE, NOTIFICATIONS_STORE, changeStore: (...a) => changeStore(...a), decideChange: (...a) => decideChange(...a), hostDetail, isInfoNotice, json, makeId, normalizeTitle, notifier, notifyLib, nowIso, objectStore, prependRecord, readBody, recordActivity, requireFeature, saveStore, storage, storageError });
const { apiNavPins } = require('./server/nav-pins').createNavPins({ json, readBody, sameOriginJson, storage, storageError });
const { apiJournal, apiJournalDelete } = require('./server/journal').createJournalRoutes({ journal, json, readBody, storageError });
const { accessAddresses, apiAccess, apiPush, apiReleases, recordReleaseHistory } = require('./server/push').createPush({ APP_VERSION, json, notifier, nowIso, pushLib, readBody, release, resolveDeployFailures, storage, storageError });
const { apiBrowserFetch, apiComputerBatch, apiHttpCheck, apiRepoInspect, apiWorkbenchCommand, apiWorkbenchDiff, apiWorkbenchRead, apiWorkbenchSearch, apiWorkbenchTree, apiWorkbenchWrite, childEnv, safeWorkspacePath, simpleDiff, workspaceRel } = require('./server/workbench').createWorkbench({ URL, WORKSPACE_ROOT, fetchWithTimeout, fs, json, path, readBody, recordActivity, requireFeature, spawn, storageError });
const { apiConversationDelete, apiConversationSave, apiConversations, apiKnowledge, apiKnowledgeDelete, apiKnowledgeImport, apiKnowledgeSearch, apiMemory, apiMemoryAdd, apiMemoryDelete, apiMemoryUpdate, apiProjectIntelligence, apiProjects, apiProjectsCreate, apiProjectsUpdate, knowledgeScore, knowledgeStore, projectStore } = require('./server/projects').createProjects({ CONVERSATIONS_STORE, KNOWLEDGE_STORE, MEMORY_STORE, PROJECTS_STORE, json, makeId, normalizeTitle, nowIso, objectStore, readBody, recordActivity, requireFeature, saveStore, storage, storageError });
const { apiCheckpoints, apiGenerateImage, apiImageModels, apiImageView, getImageModelLists, warmText } = require('./server/images').createImages({ COMFY_URL, IMAGE_ESTIMATES, IMAGE_PROMPT_MODEL, MODEL, OLLAMA_URL, URL, buildImageModelCatalog, cleanRunId, comfyOptions, fetchWithTimeout, getCheckpointNames, imageEngines, json, modelFetchWithTimeout, readBody, recordActivity, recordArtifact, runLedger, titleFromText, unloadTextModel, warmTextModel });
const atlas = require('./server/atlas').createAtlas({ json, readBody, fetchWithTimeout, systemsCache: path.join(DATA_DIR, 'atlas-systems.json') });
const { apiAtlas } = atlas;
// Step 10: snapshot each live release's commit, from Pi Hub's release records (app/atlas-releases.js).
require('./atlas-releases').createAtlasReleaseTrigger({ snapshots: atlas.snapshots, requestSnapshot: atlas.requestSnapshot, log: (m) => console.log(`${nowIso()} ${m}`) }).start();
const { apiCapabilities, apiModelDelete, apiModelPull, apiModelPullCancel, apiModelPulls, apiModels, apiStatus, capabilityPrompt, getCapabilitiesSnapshot, getStatusAndRecordTransition, searxSearch } = require('./server/status').createStatus({ APP_VERSION, CAPABILITY_CACHE_MS, COMFY_URL, LOCAL_UI_PORT, MAC_AI_HOME_URL, MAC_DSH_URL, MODEL, N8N_URL, OLLAMA_URL, POWERSHELL_BRIDGE_TOKEN, PROXY_URL, REPORT_PATH, SEARXNG_URL, STATUS_STORE, URL, agentRunStore, buildImageModelCatalog, changeStore: (...a) => changeStore(...a), createModelPulls, effectiveEngineeringRuns: (...a) => effectiveEngineeringRuns(...a), fetchWithTimeout, fs, getImageModelLists, imageEngines, issueStore: (...a) => issueStore(...a), json, listenPort, loadOllamaModelRuntime, notifier, notifyLib, projectStore, readBody, readState, recordActivity, release, sameOriginJson, storageError, watchdog, writeState });
// Takes changeStore, duplicateHtmlIds, duplicateTopLevelFunctions, generatePatchPlan, publicChange, runImproveReconcile, runProcess, saveChanges from changes.js, which takes names from it in turn: looked up when called (never at load).
const { apiIssuePrepareChange, apiIssueUpdate, apiIssues, apiIssuesScan, apiQuality, apiQualityClientEvent, apiQualityScan, issueSchedulerTick, issueStore, saveIssues } = require('./server/quality').createQuality({ APP_DIR, PUBLIC_DIR, SELF_APP_ROOT, addNotification, changeStore: (...a) => changeStore(...a), duplicateHtmlIds: (...a) => duplicateHtmlIds(...a), duplicateTopLevelFunctions: (...a) => duplicateTopLevelFunctions(...a), featureAtLeast, fs, generatePatchPlan: (...a) => generatePatchPlan(...a), getStatusAndRecordTransition, json, makeId, nowIso, objectStore, path, prependRecord, publicChange: (...a) => publicChange(...a), readBody, recordActivity, requireFeature, runImproveReconcile: (...a) => runImproveReconcile(...a), runProcess: (...a) => runProcess(...a), saveChanges: (...a) => saveChanges(...a), saveStore, storageError });
const { busyNow, missionModelQueue, apiAgentCatalog, apiAgentDispatch, apiAgentMission, apiAgentMissionEvents, apiAgentMissionStart, apiAgentMissions, apiAgentModels, apiAgentPlan, apiAgentRun, apiAgents, apiBusy, apiSpecialistRun, runEngineeringPlannerModel, runLocalModel, startMissionRun } = require('./server/agents').createAgents({ APPROVALS_STORE, APP_DIR, DATA_DIR, ENGINEERING_MODEL_TIMEOUT_MS, LARGE_ANSWER_RESERVE, MISSION_ANSWER_RESERVE, MISSION_EVIDENCE_TOKENS, MISSION_MODEL_CONCURRENCY, MISSION_NUM_CTX, MISSION_TIMEOUT_MS, MODEL, OLLAMA_URL, RUNS_STORE, TEXT_KEEP_ALIVE, TEXT_NUM_CTX, TEXT_NUM_CTX_LARGE, URL, activeRunControllers, coordinator, addNotification, agentRunStore, approvalStore, busy, fetchWithTimeout, fitMessages, inFlight, json, knowledgeScore, knowledgeStore, makeId, modelFetchWithTimeout, nowIso, plainText, readBody, recordActivity, requireFeature, runLedger, saveStore, searxSearch, storage, storageError, titleFromText });
// GET /api/world: Agent World's summary of the models, the printer, Spreadsheets and the Workshop display (app/world.js).
const world = require('./world').createWorld({
  ollamaUrl: OLLAMA_URL, fetchImpl: fetchWithTimeout, modelQueue: () => missionModelQueue, busy: busyNow, printer: workshopPrinter, printerRecord: () => piHub.printer(),
  bridgeHealth, gridcraftInFlight: () => inFlight.list().filter(w => w.kind === 'gridcraft').length,
  kioskUrl: () => workshop.portalUrl(), kioskHealth: url => workshop.workshopStatus({ url, log: line => console.warn(line) }),
  runs: () => streetRuns(), crews: () => claudeLiveNow() // both declared below; called only per request
});
const { claudeLiveNow, apiChangeApprove, apiChangeCapabilities, apiChangeDeployResult, apiChangePlan, apiChangeRequestApply, apiChangeStage, apiChanges, apiClaudeBoard, apiClaudeDecision, apiClaudeEvents, apiClaudeFindings, apiClaudePriorities, apiClaudeVote, apiEngineeringRun, apiEngineeringRuns, apiEngineeringStart, apiImproveHandoff, apiImproveIdea, apiImproveItem, apiImproveItems, apiImproveSignal, changeStore, claudeFindings, decideChange, duplicateHtmlIds, duplicateTopLevelFunctions, effectiveEngineeringRuns, engineeringRunStore, generatePatchPlan, publicChange, retireChangesOfClosedItems, runImproveReconcile, runProcess, saveChanges, shipQueuedSelfChanges } = require('./server/changes').createChanges({ APPROVALS_STORE, APP_VERSION, DATA_DIR, ENGINEERING_MODEL_TIMEOUT_MS, SELF_APP_ROOT, addNotification, approvalStore, childEnv, coordinator, MODEL, fetchWithTimeout, fs, improve, issueStore, json, makeId, notifier, nowIso, objectStore, path, plainText, readBody, recordActivity, release, requireFeature, runEngineeringPlannerModel, safeWorkspacePath, sameOriginJson, saveIssues, saveStore, simpleDiff, spawn, storage, storageError, workspaceRel });
const { apiConfig, redirectFor, serveStatic } = require('./server/web').createWeb({ ALLOWED_HOSTS, hostAllowed, APP_VERSION, CAPABILITY_CACHE_MS, CHAT_MODEL_TIMEOUT_MS, ENGINEERING_MODEL_TIMEOUT_MS, LOCAL_UI_PORT, MODEL, PUBLIC_DIR, accessAddresses, changeStore, claudeFindings, crypto, engineeringRunStore, fs, json, listenPort, path, release, text });
const { apiPowerShellApprove, apiPowerShellCancel, apiPowerShellCreate, apiPowerShellHostNext, apiPowerShellHostResult, apiPowerShellJobs, apiPowerShellRequestRun } = require('./server/powershell').createPowerShell({ LOCAL_UI_PORT, POWERSHELL_BRIDGE_TOKEN, POWERSHELL_UI_TOKEN, json, listenPort, makeId, nowIso, objectStore, readBody, recordActivity, requireFeature, saveStore, storageError });
const { apiAutomationCreate, apiAutomationRun, apiAutomationUpdate, apiAutomations, apiMonitorCreate, apiMonitorRun, apiMonitors, apiMorningBrief, automationSchedulerTick, monitorSchedulerTick } = require('./server/automations').createAutomations({ AUTOMATIONS_STORE, AUTOMATION_RUNS_STORE, MONITORS_STORE, activityStore, addNotification, automationRunStore, automationStore, featureAtLeast, getStatusAndRecordTransition, inFlight, json, makeId, normalizeTitle, notificationStore, nowIso, objectStore, readBody, recordActivity, requireFeature, runLocalModel, saveStore, searxSearch, storageError });
const { apiRunCancel, apiRunRetry, apiRunUpdate, apiRuns, createChatExecution, needsThreads, streetRuns } = require('./server/runs').createRuns({ AUTOMATION_RUNS_STORE, MODEL, RUNS_STORE, WORK_CHIPS, activeRunControllers, agentRunStore, approvalStore, automationRunStore, changeStore, cleanRunId, effectiveEngineeringRuns, fetchWithTimeout, gridcraftRuns, json, keptMarker, listenPort, needsYou, nowIso, projectStore, readBody, recordActivity, runCard, runLedger, sanitizeMessages, saveStore, seenRuns, storageError, titleFromText, withSeen, workKind });
const { apiChat, apiChatStream, apiRoute, chatOnce } = require('./server/chat').createChat({ ANSWER_RESERVE, CHAT_MODEL_TIMEOUT_MS, MODEL, OLLAMA_URL, coordinator, TEXT_KEEP_ALIVE, TEXT_NUM_CTX, aboutApplianceBlock, accessAddresses, activeRunControllers, capabilityPrompt, createChatExecution, fitMessages, getCapabilitiesSnapshot, isAboutLocalAi, json, keepLongAnswer, modelFetch, modelFetchWithTimeout, readBody, recordActivity, recordTurnArtifact, runLedger, sanitizeMessages, searxSearch, selfChange, storageError, voiceFacts, voiceTimeZone: (...a) => voiceTimeZone(...a) });
const { apiAttention, apiDisplayAiCards, apiDisplayAlerts, apiDisplayApprovalDecide, apiDisplayApprovals, apiDisplayAsk, apiDisplayEvents, apiDisplayFeed, apiDisplayHeartbeat, apiDisplayNotify, apiDisplayPair, apiGlance, apiGlanceAsk, apiVoiceHome, apiWatchHeartbeat, voiceTimeZone } = require('./server/voice').createVoice({ APPROVALS_STORE, APP_VERSION, approvalStore, chatOnce, claudeChat, clockNow, displayAuthorized: req => displayKey.authorized(req), hubAuthorized: req => hubKey.authorized(req), displayMessages, displayPairing, featureAtLeast, fetchWithTimeout, getCapabilitiesSnapshot, glance, json, listenPort, materialsClient, needsThreads, needsYou, notifier, nowIso, piHub, printLab, readBody, recordActivity, runLedger, saveStore, searxSearch, startMissionRun, storage, storageError, text, voice, voiceFacts, watchdog, weather });
const { setFramePolicy } = require('./server/framing');
const server = http.createServer(async (req, res) => {
  setFramePolicy(res);
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = urlObj.pathname;

  try {
    if (!hostAllowed(req.headers.host, ALLOWED_HOSTS)) { req.resume(); res.setHeader('Connection', 'close'); return json(res, 421, { error: 'Unknown host name. Open Local AI by its own address.' }); }
    if (crossSiteRequest(req)) { req.resume(); res.setHeader('Connection', 'close'); return json(res, 403, { error: 'Cross-site request blocked' }); }
    if (signIn.blocks(signIn.check(req, p), p, req.method)) { req.resume(); return json(res, 401, { error: 'Sign in on this device first: pair it under Build › Claude Code.', signIn: true }); }
    if (req.method === 'GET' && p === '/api/signin/report') return signIn.apiReport(req, res, json);
    if (req.method === 'POST' && p === '/api/signin/report/clear') { signIn.clear(); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && p === '/healthz') return json(res, 200, { status: 'ok', appliance: 'Local AI', version: APP_VERSION, releaseCommit: release?.commit || null, storage: { engine: 'sqlite', schemaVersion: 1 }, addresses: accessAddresses() });
    if (req.method === 'GET' && p === '/api/busy') return apiBusy(req, res);
    if (req.method === 'GET' && p === '/api/world') return await world.api(req, res);
    if ((req.method === 'GET' || req.method === 'PUT') && p === '/api/nav/pins') return await apiNavPins(req, res);
    if (req.method === 'GET' && p === '/api/journal') return await apiJournal(req, res, urlObj);
    if (req.method === 'POST' && p === '/api/journal/delete') return await apiJournalDelete(req, res);
    if (req.method === 'GET' && p === '/api/releases') return await apiReleases(req, res);
    if (req.method === 'GET' && p === '/api/access') return await apiAccess(req, res);
    if (req.method === 'GET' && p === '/api/glance') return await apiGlance(req, res, urlObj);
    if ((req.method === 'GET' || req.method === 'POST') && p === '/api/voice/home') return await apiVoiceHome(req, res);
    if ((req.method === 'GET' || req.method === 'POST') && p === '/api/glance/ask') return await apiGlanceAsk(req, res, urlObj);
    if (p.startsWith('/api/push/')) return await apiPush(req, res, p);
    if (req.method === 'GET' && p === '/api/storage/status') return json(res, 200, storage.status());
    if (req.method === 'GET' && p === '/api/status') return await apiStatus(req, res);
    if (req.method === 'GET' && p === '/api/models') return await apiModels(req, res);
    if (p === '/api/models/routing' && req.method === 'GET') return json(res, 200, { ...routingSetting(), providers: cloudModels.status(), table: modelRouter.table() });
    if (p === '/api/models/routing' && req.method === 'PUT') {
      const b = await readBody(req);
      if (typeof b.cloud !== 'boolean') return json(res, 400, { error: 'Send {"cloud": true} or {"cloud": false}.' });
      storage.writeSetting(ROUTING_KEY, { cloud: b.cloud, at: new Date().toISOString() });
      recordActivity('model', b.cloud ? 'Cloud models switched on' : 'Cloud models switched off', b.cloud ? 'Work that isn\'t private may use Groq or Cerebras.' : 'Everything runs on this PC.', {});
      return json(res, 200, { ...routingSetting(), providers: cloudModels.status(), table: modelRouter.table() });
    }
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
    if (p.startsWith('/api/atlas/')) return await apiAtlas(req, res, p);
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
    if (req.method === 'POST' && p === '/api/gridcraft/new') return await apiGridcraftNew(req, res);
    if (req.method === 'POST' && p === '/api/gridcraft/upload') return await apiGridcraftUpload(req, res);
    if (req.method === 'GET' && p === '/api/gridcraft/download') return await apiGridcraftDownload(req, res, urlObj);
    if (req.method === 'POST' && p === '/api/gridcraft/cell') return await apiGridcraftCell(req, res);
    { const m = req.method === 'POST' && p.match(/^\/api\/gridcraft\/runs\/(gc-[\w-]+)\/(keep|discard)$/); if (m) return await apiGridcraftDecide(req, res, m[1], m[2]); }
    if (req.method === 'GET' && p === '/api/artcraft/status') return await apiArtcraftStatus(req, res);
    if (req.method === 'POST' && p === '/api/artcraft/open') return await apiArtcraftOpen(req, res);
    if (req.method === 'GET' && p === '/api/workshop/status') return await apiWorkshopStatus(req, res, urlObj);
    if (req.method === 'GET' && (p === '/api/workshop/camera' || p === '/api/workshop/camera.jpg')) return await apiWorkshopCamera(req, res);
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
    if (req.method === 'GET' && p === '/api/lab-callers') return json(res, 200, labCallers.report());
    if (p.startsWith('/api/lab/')) {
      labCallers.record(req, p, {
        hubKeyAuthorized: req => hubKey.authorized(req),
        macAuthorized: req => claudeChat.macAuthorized(req),
        deviceFor: req => claudeChat.deviceFor(req),
        isHostReq
      });
      if (await printLab.handle(req, res, p)) return;
    }
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
    if (req.method === 'GET' && p === '/api/attention') return await apiAttention(req,res);
    if (req.method === 'GET' && p === '/api/display/feed') return await apiDisplayFeed(req,res);
    if (req.method === 'GET' && p === '/api/display/ai-cards') return await apiDisplayAiCards(req,res);
    // Home's Needs you: Pi Hub's one list (the display's cached fetch), or items null when the hub doesn't answer.
    if (req.method === 'GET' && p === '/api/home/hub-needs') { const hub = await piHub.needs(); return json(res, 200, { items: hub ? hub.items : null }); }
    if (req.method === 'GET' && p === '/api/display/ask') return await apiDisplayAsk(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/display/events') return await apiDisplayEvents(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/display/poster') {
      const jpg = await piHub.poster(Number(urlObj.searchParams.get('n') ?? 0));
      if (!jpg) return json(res, 404, { error: 'Nothing is playing' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpg.length, 'Cache-Control': 'private, max-age=60' });
      return res.end(jpg);
    }
    if (req.method === 'POST' && p === '/api/display/notify') return await apiDisplayNotify(req,res);
    if ((req.method === 'POST' && (p === '/api/display/pair' || p === '/api/display/pair/start')) || (req.method === 'GET' && p === '/api/display/pair/status')) return await apiDisplayPair(req,res,p);
    if (req.method === 'GET' && p === '/api/display/approvals') return await apiDisplayApprovals(req,res);
    if (req.method === 'POST' && p === '/api/display/approvals/decide') return await apiDisplayApprovalDecide(req,res);
    if (req.method === 'GET' && p === '/api/display/lab/judge') return await displayLab.judge(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/display/lab/verdict') return await displayLab.verdict(req,res);
    // A printer action: only the display's key or a signed-in device, whatever the sign-in mode.
    if (req.method === 'POST' && p === '/api/display/printer/clear') {
      req.resume();
      if (!displayKey.authorized(req) && !claudeChat.deviceFor(req) && !claudeChat.macAuthorized(req)) return json(res, 401, { error: 'Only the Workshop display or a signed-in device can clear the plate.' });
      // One clear at a time, and only while the printer is finished or failed and waiting for it (as Pi Hub does).
      if (plateClearing) return json(res, 409, { error: 'Already clearing' });
      plateClearing = true;
      let r;
      try {
        const state = await bambuddyControl.status();
        const refusal = state.reason === 'off' ? null : plateClearRefusal(state);
        if (refusal) return json(res, 409, { error: refusal });
        r = await bambuddyControl.clearPlate();
      } finally { plateClearing = false; }
      try { displayMessages.post({ ...clearPlateMessage(r), chime: false, action: { type: 'show', page: 'printer' } }, 'printer-control'); } catch { /* feedback must not retry or undo an accepted command */ }
      recordActivity('printer', r.ok ? 'Plate cleared from the Workshop display' : 'Clear plate from the Workshop display did not go through', `Bambuddy: plate ${r.plate}, errors ${r.errors}`, { by: 'Workshop display' });
      return json(res, r.ok ? 200 : 502, r);
    }
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
  // Past work into the journal, once; resumable, so a restart mid-way continues (app/journal-import.js).
  setTimeout(() => require('./journal-import').importAll({ storage, journal, runLedger })
    .then(r => { if (r.added) console.log(`${nowIso()} Journal import added ${r.added} entries`); })
    .catch(e => console.error(`${nowIso()} Journal import failed:`, e)), 5000).unref?.();
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
