# Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner's iPhone gets Local AI notifications (needs you, failed, down/recovered, long run finished) through built-in Web Push.

**Architecture:** `app/push.js` signs (VAPID) and encrypts (`aes128gcm`) Web Push messages with `node:crypto` and posts them to Apple/Google/Mozilla push hosts. `app/notify.js` decides who gets what (kinds, quiet hours, burst limit, presence, retries) and stores devices in settings. Small hooks in the run ledger and `app/server.js` call `notify()`; the service worker shows notifications; a Notifications card on Health sets it up.

**Tech Stack:** Node 22.13+ (`node:crypto`, `fetch`, `node:test`), vanilla JS in `app/public/ui.js` and `sw.js`, Playwright for browser tests, Windows PowerShell 5.1 for the backup script.

**Spec:** `docs/superpowers/specs/2026-10-15-notifications-design.md`

## Global Constraints

- No npm runtime dependencies; crypto is `node:crypto` only.
- Push endpoints allowed only on hosts ending `.push.apple.com`, equal to `fcm.googleapis.com`, or equal to `updates.push.services.mozilla.com` (HTTPS only).
- Event kinds, exactly: `needs-you`, `failed`, `service`, `finished`. All on by default for a new device.
- `finished` only when the run took ≥ 30 000 ms (`finishedAt − startedAt`) and `push:presence.at` is older than 60 000 ms.
- Quiet hours default `{on: true, start: '22:00', end: '07:00'}` in the appliance time zone (`TZ`, default `America/New_York`); inside them only `failed` and `service` are sent.
- Burst limit: 10 per device per rolling 10 minutes, then one summary (tag `summary`, title `Local AI`, body `N more updates in Local AI`) at most every 10 minutes.
- Drop an identical (kind, tag, title) repeat to the same device within 2 minutes.
- Urgency: `high` for needs-you, failed, service; `normal` for finished. `TTL: 86400`.
- Body ≤ 80 characters (cut with `…`); title ≤ 60.
- One retry after 30 s on a non-404/410 failure; 404/410 removes the device. `notify()` never throws and never delays the caller.
- Settings keys: `push:vapid`, `push:device:<id>`, `push:presence`.
- VAPID subject: `process.env.VAPID_SUBJECT || 'https://github.com/azmusgb/LocalAI'`.
- `/api/push/*` state changes are same-origin JSON (the global cross-site guard covers them; keep it that way).
- Copy is plain sentence case; the app name is "Local AI".

## Review Focus

- Quiet hours that cross midnight (22:00–07:00) and a window with start = end (means off): Task 4 tests both.
- A slow or hanging push endpoint must not slow the request that triggered it: Task 4 tests `notify()` returns before a never-resolving fetch, with a 10 s per-send timeout.
- Subscribing the same browser twice (same endpoint) gives one device, not two: Task 2 tests it.
- Non-ASCII titles (`é`, `→`, emoji) arrive intact, and a long body is cut, never rejected: Task 1 (round-trip decrypt) and Task 4 (cutting).
- One device answering 410 is removed while the others still get the notification: Task 4 tests it.

---

### Task 1: Web Push sender (`app/push.js`)

**Files:**
- Create: `app/push.js`
- Test: `tests/push.test.cjs`

**Interfaces:**
- Produces:
  - `loadOrCreateVapid({ readSetting, writeSetting }) -> { publicKey: string /* base64url, 65-byte uncompressed P-256 */, privateJwk: object }` (stored at `push:vapid`)
  - `vapidHeader(endpoint: string, vapid, { subject: string, now?: number }) -> string` → `vapid t=<jwt>, k=<publicKey>`; JWT header `{typ:'JWT',alg:'ES256'}`, claims `{aud: new URL(endpoint).origin, exp: now/1000 + 12*3600 (integer), sub: subject}`, ES256 signature in `ieee-p1363` form, base64url.
  - `encrypt(plaintext: Buffer, { p256dh: string, auth: string }, { salt?: Buffer, serverKeys?: { privateJwk, publicKey } } = {}) -> Buffer` (RFC 8291 `aes128gcm`, record size 4096, single record, padding delimiter `0x02`)
  - `isAllowedEndpoint(url: string) -> boolean`
  - `sendPush(subscription: {endpoint, keys:{p256dh, auth}}, payload: object, { vapid, subject, urgency, topic, ttl = 86400, fetchImpl = fetch, timeoutMs = 10000 }) -> Promise<{ ok: boolean, status: number, gone: boolean }>`; headers `Content-Encoding: aes128gcm`, `Content-Type: application/octet-stream`, `TTL`, `Urgency`, `Topic` (≤ 32 chars of `[A-Za-z0-9_-]`; derive from the tag with SHA-256 → base64url → first 32), `Authorization: vapidHeader(...)`. `gone` is true for 404 and 410. Rejects (does not throw synchronously) for a disallowed endpoint.

- [ ] **Step 1: Write the failing tests** in `tests/push.test.cjs`:
  - `encrypt matches RFC 8291 section 5`: using the RFC's plaintext `When I grow up, I want to be a watermelon`, application-server key pair, user-agent public key and auth secret, and salt (copy all values verbatim from RFC 8291 §5), `encrypt(...).toString('base64url')` equals the RFC's final encrypted message exactly.
  - `encrypt round-trips unicode`: decrypt the output with the user-agent private key (implement a test-only `decrypt` helper in the test file following RFC 8291 in reverse) and get back `'Café → done 🎉'`.
  - `vapidHeader is a valid ES256 JWT`: split the token, verify the signature with `crypto.verify('sha256', …, { key: publicKey, dsaEncoding: 'ieee-p1363' })`, and assert `aud === 'https://web.push.apple.com'`, `sub` equals the subject, `exp - now/1000` is between 11 and 13 hours.
  - `loadOrCreateVapid creates once`: two calls against an in-memory settings map return the same `publicKey`; the publicKey decodes to 65 bytes starting with `0x04`.
  - `isAllowedEndpoint`: true for `https://web.push.apple.com/abc`, `https://fcm.googleapis.com/fcm/send/x`, `https://updates.push.services.mozilla.com/wpush/v2/x`; false for `http://web.push.apple.com/x`, `https://evil.com/x`, `https://push.apple.com.evil.com/x`, `https://10.0.0.21/x`.
  - `sendPush posts the right headers and reports gone`: a `fetchImpl` stub captures the request; assert method `POST`, the six headers, body is a Buffer; then stub status 410 → `{ok:false, gone:true}`; status 201 → `{ok:true}`.
- [ ] **Step 2: Run** `node --test tests/push.test.cjs` — expected: FAIL (`Cannot find module '../app/push.js'`).
- [ ] **Step 3: Implement `app/push.js`** to the interfaces above. ECDH: `crypto.createECDH('prime256v1')` (or `generateKeyPairSync('ec', {namedCurve:'prime256v1'})` + `diffieHellman`); HKDF: `crypto.hkdfSync('sha256', …)` with the RFC 8291 info strings (`WebPush: info\0` + ua_public + as_public, then `Content-Encoding: aes128gcm\0` and `Content-Encoding: nonce\0`); AES-128-GCM with the 16-byte tag appended. Header: salt(16) ‖ rs(uint32 BE 4096) ‖ idlen(65) ‖ as_public.
- [ ] **Step 4: Run** `node --test tests/push.test.cjs` and `npm test` — expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Push: VAPID and aes128gcm Web Push sender (node:crypto)"`

### Task 2: Subscribe, test push, service worker and a bare "Send a test" (step 1 of the spec)

**Files:**
- Create: `app/notify.js` (devices only in this task: subscribe/unsubscribe/list/test)
- Modify: `app/server.js` (routes `/api/push/key`, `/api/push/subscribe`, `/api/push/unsubscribe`, `/api/push/test`; create the notifier at startup)
- Modify: `app/public/sw.js` (push and notificationclick handlers; bump `CACHE`)
- Modify: `app/public/ui.js` (new section `// ==== notifications.js ====`: a Health card with "Allow notifications" and "Send a test")
- Modify: `app/public/manifest.json` (`name: "Local AI"`, `short_name: "Local AI"`)
- Test: `tests/push-api.test.cjs`

**Interfaces:**
- Consumes: Task 1's `loadOrCreateVapid`, `sendPush`, `isAllowedEndpoint`.
- Produces:
  - `createNotifier({ storage, sendPush, vapid, subject, now = Date.now, schedule = setTimeout, timeZone }) -> { subscribe(subscription, name) -> device, unsubscribe(endpoint) -> boolean, devices() -> device[] /* without keys */, test(id?) -> Promise<{sent:number, removed:number}>, notify(event), presence(), updateDevice(id, patch), removeDevice(id) }` (`notify`, `presence`, `updateDevice`, `removeDevice` are stubs here, filled in Task 4/6)
  - Device record: `{ id: 'd_<random>', name, endpoint, keys:{p256dh, auth}, kinds:['needs-you','failed','service','finished'], quiet:{on:true,start:'22:00',end:'07:00'}, createdAt, lastOkAt:null, lastError:null }`
  - HTTP: `GET /api/push/key -> {publicKey}`; `POST /api/push/subscribe {subscription, name} -> {device}` (400 if endpoint not allowed or keys missing); `POST /api/push/unsubscribe {endpoint} -> {ok}`; `POST /api/push/test {id?} -> {sent, removed}`.
  - Push payload (JSON): `{ title, body, url, tag }`.

- [ ] **Step 1: Write the failing tests** in `tests/push-api.test.cjs` (spawn the server on a free port with a temp `DATA_DIR`, as `tests/notifications-api.test.cjs` does; point the notifier at a fake push host by setting `PUSH_TEST_ENDPOINT_HOST=127.0.0.1:<port>` so `isAllowedEndpoint` also accepts `http://<that host>` in tests only):
  - `key is stable`: two `GET /api/push/key` return the same 87-character base64url key.
  - `subscribe is idempotent per endpoint`: subscribing the same endpoint twice → one device in `devices()`, keys not exposed by `GET`-style listing.
  - `subscribe rejects a non-push endpoint`: `https://evil.com/x` → 400.
  - `test sends to the fake push service`: the fake endpoint receives one POST with `Content-Encoding: aes128gcm` and an `Authorization` starting `vapid t=`; response `{sent:1, removed:0}`.
  - `410 removes the device`: fake endpoint answers 410 → `{sent:0, removed:1}` and the device is gone.
  - `cross-site subscribe is refused`: `Origin: http://evil.example` → 403.
- [ ] **Step 2: Run** `node --test tests/push-api.test.cjs` — expected: FAIL.
- [ ] **Step 3: Implement** the device part of `app/notify.js` and the four routes (test sends `{title:'Test from Local AI', body:'Notifications work on this device.', url:'/?open=status', tag:'test'}`, ignoring kinds and quiet hours). `PUSH_TEST_ENDPOINT_HOST` (test-only, never set on the appliance) additionally allows `http://<that host>` endpoints; say so in a comment next to the allow-list.
- [ ] **Step 4: Implement the service worker handlers** in `sw.js`: `push` → `event.waitUntil(self.registration.showNotification(title, { body, tag, data: { url }, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' }))`, always showing one (iOS requirement); `notificationclick` → close, then focus an existing client and `postMessage({ type: 'localai-open', url })`, else `clients.openWindow(url)`. Bump `CACHE` so phones pick up the new worker.
- [ ] **Step 5: Implement the bare card** in the new `ui.js` section, mounted on `#status` after the secure-connection card: if `!('PushManager' in window)` or not standalone on iOS, show the next step text (spec "Setup flow" 1–2); else an "Allow notifications" button (`Notification.requestPermission()` → `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` → `POST /api/push/subscribe` with name `iPhone` on iOS, else the platform) and "Send a test".
- [ ] **Step 6: Run** `npm test` and `node tests/run-browser.mjs` against a throwaway server — expected: PASS (no browser test for push yet; existing suites stay green).
- [ ] **Step 7: Commit** `git commit -m "Push: subscribe, test push, service worker handlers, Allow notifications on Health"`

### Task 3: Prove delivery on the owner's iPhone (gate)

**Files:** none (deploy and check). If anything changes, it goes in a follow-up commit to Task 2's files.

- [ ] **Step 1:** Open a PR with Tasks 1–2, wait for CI, merge; confirm `/healthz` reports the merge commit.
- [ ] **Step 2:** Ask the owner to: trust the Local AI certificate (Health › Secure connection), open `https://10.0.0.21` in Safari, Share › Add to Home Screen, open the Home Screen app, Health › Allow notifications, then Send a test.
- [ ] **Step 3:** Expected: the test notification appears on the iPhone within ~10 s; tapping it opens Health. Check `push:device:*` has `lastOkAt` set. If Apple rejects the request (look at the stored `lastError`, e.g. `BadJwtToken`, `403`), fix and repeat. If iOS will not subscribe at all from a local-CA site, **stop** and report: the fallback is ntfy (spec approach C), which needs a new plan.

### Task 4: Notification rules (`notify`)

**Files:**
- Modify: `app/notify.js`
- Test: `tests/notify.test.cjs`

**Interfaces:**
- Consumes: Task 2's notifier and device record.
- Produces: `notify({ kind, title, body = '', url = '/', tag }) -> void` (fire-and-forget; returns immediately); `presence() -> void` (writes `push:presence` `{at: now()}`); `updateDevice(id, { name?, kinds?, quiet? }) -> device` (validates kinds against the four, times as `HH:MM`); `removeDevice(id) -> boolean`.

- [ ] **Step 1: Write the failing tests** in `tests/notify.test.cjs` with an in-memory storage, a fake `sendPush` that records calls and returns per-endpoint results, a controllable `now`, and a `schedule` that captures retries:
  - `kinds`: a device with `kinds:['failed']` gets `failed`, not `finished`.
  - `quiet hours across midnight`: device quiet `22:00–07:00`, `timeZone: 'America/New_York'`; at 23:30 local `needs-you` and `finished` are not sent, `failed` and `service` are; at 07:00 everything is sent; quiet `{on:true,start:'09:00',end:'09:00'}` never blocks.
  - `finished needs a long run and no presence`: (`notify` is called by Task 5 only for runs ≥ 30 s; here assert presence) after `presence()` at t, a `finished` at t+59 s is not sent, at t+61 s is.
  - `repeat dropped`: same (kind, tag, title) twice within 2 min → one send; after 2 min → two.
  - `burst summary`: 12 distinct events in 1 min → 10 sends, then one `summary` with body `2 more updates in Local AI`; more events in the same 10 min add no second summary.
  - `cutting`: a 200-character body arrives as 80 characters ending `…`; a 100-character title as 60.
  - `410 removes only that device`: two devices, one answers 410 → it is removed, the other gets the send and `lastOkAt` updates.
  - `one retry`: a 500 schedules one retry after 30 000 ms; a second 500 sets `lastError` and stops.
  - `never blocks or throws`: `sendPush` that never resolves → `notify()` returns synchronously; `sendPush` that throws → no exception escapes.
  - `urgency`: `needs-you` sends `urgency:'high'`, `finished` sends `'normal'`.
- [ ] **Step 2: Run** `node --test tests/notify.test.cjs` — expected: FAIL.
- [ ] **Step 3: Implement** the rules in `app/notify.js` (burst and repeat state in memory per device; local time via `Intl.DateTimeFormat(…, { timeZone, hour:'2-digit', minute:'2-digit', hourCycle:'h23' })`).
- [ ] **Step 4: Run** `node --test tests/notify.test.cjs` and `npm test` — expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Notify: kinds, quiet hours, burst limit, repeats, presence, retry"`

### Task 5: Event hooks

**Files:**
- Modify: `app/run-ledger.js` (constructor option `onTransition(run, previousStatus)`, called after `write` in `update()` when the status changed; errors from the callback are caught)
- Modify: `app/server.js` (wire `onTransition`; the three approval-creation sites at `apiApprovalCreate`, the risky agent path and the change `awaiting_approval` path; `apiClaudeFindings` for new `proposed` findings; `getStatusAndRecordTransition` down/recovered branches; `apiNotificationSystem` attention notices; `POST /api/push/presence`)
- Modify: `deploy/Backup-LocalAI-Data.ps1` (on failure, POST `{kind:'backup', title:'Nightly backup failed', detail, meta:{outcome:'failed'}}` as UTF-8 bytes to `http://127.0.0.1:3080/api/notifications/system`, swallowing errors, before the final `throw`)
- Modify: `app/public/ui.js` (notifications section: `POST /api/push/presence` every 30 s while `document.visibilityState === 'visible'`)
- Test: `tests/run-ledger.test.cjs` (extend), `tests/notify-hooks.test.cjs`

**Interfaces:**
- Consumes: Task 4's `notify(event)`, `presence()`.
- Produces: event mapping (exact):
  - run → `awaiting_approval`: `{kind:'needs-you', title:'Waiting for your approval', body: run.title, url:'/?open=run:'+id, tag:'run:'+id}`
  - run → `failed`: `{kind:'failed', title:'Failed: '+run.title, body: run.error, url:'/?open=run:'+id, tag:'run:'+id}`
  - run → `completed` with `finishedAt − startedAt ≥ 30000`: `{kind:'finished', title:'Done: '+run.title, body: run.summary, url:'/?open=run:'+id, tag:'run:'+id}`
  - approval created pending: `{kind:'needs-you', title:'Approval needed', body: approval.title, url:'/?open=approvals', tag:'approval:'+id}`
  - new Claude finding with status `proposed`: `{kind:'needs-you', title:'Claude needs your decision', body: finding.title, url:'/?open=claude', tag:'finding:'+id}` (not when the id already existed)
  - health down: `{kind:'service', title:'Down: '+affected.join(', '), body:'Local AI health changed to '+overall, url:'/?open=status', tag:'service'}`; recovered: `{kind:'service', title:'Recovered', body:'All core services are back.', url:'/?open=status', tag:'service'}`
  - host notice with level `attention`: `{kind:'failed', title, body: detail, url:'/?open=inbox', tag: kind}` (`deploy`, `backup`, `monitor`)

- [ ] **Step 1: Write the failing tests:** in `tests/run-ledger.test.cjs`, `onTransition fires once per status change` (create→start→complete gives `running`, `completed` with previous statuses; a progress-only update gives none; a throwing callback doesn't break `update`). In `tests/notify-hooks.test.cjs` (spawn the server with a fake push host and one subscribed device): a run failed via the runs API sends a `failed` push with tag `run:<id>`; posting the same Claude finding id twice (first `proposed`) sends one `needs-you`; `POST /api/notifications/system` with `outcome:'failed'` sends `failed`, with `outcome:'deployed'` sends nothing; `POST /api/push/presence` then a ≥ 30 s completed run sends nothing.
- [ ] **Step 2: Run** both files — expected: FAIL.
- [ ] **Step 3: Implement** the ledger option and the server hooks with the mapping above (each hook one `notifier.notify(...)` call after the state is saved).
- [ ] **Step 4: Implement** the backup failure notice and the presence heartbeat.
- [ ] **Step 5: Run** `npm test`, the browser suites, and `./tests/Test-LocalAI-DeployContracts.ps1` under `pwsh` — expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "Notify: runs, approvals, Claude findings, health, host failures and backups"`

### Task 6: Notifications card, deep links, icons and docs

**Files:**
- Modify: `app/public/ui.js` (full card per spec "Setup flow" step 4: kind switches, quiet hours on/start/end, Turn off on this device, device list with last delivered/last error, rename, remove)
- Modify: `app/server.js` (`GET /api/push/devices`, `POST /api/push/devices/update`, `POST /api/push/devices/remove`)
- Modify: `app/public/app.js` (on load and on `message {type:'localai-open', url}`: `?open=<view>` → `showView(view)`; `?open=run:<id>` → `window.LocalAIRuns.open(id)`; then `history.replaceState` to `/`)
- Create: `app/public/icons/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (180×180): the brand mark (rounded blue gradient square with the eye glyph, as in `.brandmark`) on the app background
- Modify: `app/public/manifest.json` (`icons` for 192 and 512, `purpose: "any"`), `app/public/index.html` (`<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`)
- Modify: `docs/OPERATIONS.md` (section "Notifications": setup on iPhone, what notifies, quiet hours, privacy, test, `VAPID_SUBJECT`)
- Test: `tests/notifications-ui.mjs`

**Interfaces:**
- Consumes: Task 4's `updateDevice`, `removeDevice`, `devices`; Task 2's routes.
- Produces: HTTP `GET /api/push/devices -> {devices}`; `POST /api/push/devices/update {id, name?, kinds?, quiet?} -> {device}`; `POST /api/push/devices/remove {id} -> {ok}`.

- [ ] **Step 1: Write the failing browser test** `tests/notifications-ui.mjs` (mock `window.PushManager`, `Notification.requestPermission → 'granted'`, `navigator.serviceWorker.ready.pushManager.subscribe` returning a fake subscription; route `/api/push/*` or use the real server with `PUSH_TEST_ENDPOINT_HOST`):
  - on an iPhone user agent outside standalone, the card shows "Add Local AI to your Home Screen" and no Allow button;
  - standalone + not subscribed → Allow notifications → `POST /api/push/subscribe` sent with name `iPhone`, card shows the four switches all on and quiet hours 22:00–07:00;
  - toggling Finished off sends `devices/update` with kinds without `finished`;
  - the browser has a subscription whose endpoint the server doesn't list (device removed after a 410, or the VAPID key lost) → the card says "Notifications stopped on this device." with a "Turn them on again" button that re-subscribes;
  - Send a test → `POST /api/push/test`;
  - `/?open=status` opens Health; a `localai-open` message with `/?open=claude` opens the Claude page;
  - no script errors.
- [ ] **Step 2: Run** `node tests/run-browser.mjs notifications` against a throwaway server — expected: FAIL.
- [ ] **Step 3: Implement** the device routes, the card (including the stopped-device state: compare `pushManager.getSubscription()`'s endpoint with `GET /api/push/devices`), deep links, icons, manifest and the apple-touch-icon link.
- [ ] **Step 4: Run** `npm test` and the full browser suite — expected: PASS. Check `/icons/icon-192.png` is served (200, `image/png`).
- [ ] **Step 5: Write** the OPERATIONS.md section.
- [ ] **Step 6: Commit** `git commit -m "Notifications card, deep links, Home Screen icons and docs"`; open the PR, merge when green, confirm `/healthz`, ask the owner to check the card on the iPhone; mark board item `prod-monitoring` fixed with the PR numbers.
