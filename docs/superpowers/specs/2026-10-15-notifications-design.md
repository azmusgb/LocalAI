# Notifications — design (roadmap sub-project 6)

Date: 2026-10-15 · Status: approved in conversation, spec for review
Roadmap: `2026-10-15-localai-evolution-design.md`, sub-project 6 (depends on 1, done). Board item: `prod-monitoring`
(alerting part).

## Intent

**Outcome:** the owner's iPhone tells them when Local AI needs them, when something failed or went down, and when
a long run they started has finished, without opening the site.

**Who:** one owner, one iPhone (more devices work the same way).

**Success:**
- A test notification arrives on the iPhone within seconds of "Send a test".
- Each event kind below arrives once, opens the right item when tapped, and stays quiet during quiet hours
  unless it is a failure or an outage.
- A burst of events never floods the lock screen; nothing exists only on the phone (the Inbox has everything).

**Not goals:** Android-specific features, SMS/email, a separate notification app (ntfy is only the fallback if
step 1 fails), per-project notification rules.

## Decisions (from the conversation)

- **Device:** iPhone. Web push works only from the Home Screen app (iOS 16.4+), over HTTPS with the Local AI CA
  trusted (Health › Secure connection), and every push must show a notification (`userVisibleOnly`).
- **Approach A:** built-in Web Push using Node's `crypto` (VAPID ES256, `aes128gcm` payload encryption per
  RFC 8291/8188). No new service, no npm runtime dependency (repo rule). ntfy (approach C) only if iOS refuses in step 1.
- **Event kinds, all on by default:** Needs you, Failed, Down/recovered, Finished.
- **"Finished" only** for runs that took ≥ 30 s and when no Local AI page was visible in the last 60 s.
- **Quiet hours** default 22:00–07:00 (appliance time zone, America/New_York): only Failed and Down/recovered get
  through; the rest wait in the Inbox. Per device, can be changed or turned off.

## Architecture

| Unit | Does | Depends on |
|---|---|---|
| `app/push.js` | VAPID key pair (made once, setting `push:vapid`); signs the request JWT (ES256, `ieee-p1363`); encrypts the payload for a subscription (ECDH P-256 + HKDF + AES-128-GCM, `aes128gcm`); POSTs to the endpoint with `TTL`, `Urgency`, `Topic`. Only endpoints on Apple, Google and Mozilla push hosts (`*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`) are accepted. Pure apart from `fetch`, injectable for tests. | `node:crypto`, `fetch` |
| `app/notify.js` | `notify({kind, title, body, url, tag})`: for each device, applies its kinds, quiet hours, the burst limit and presence; sends via `push.js`; removes devices whose endpoint is gone (404/410); one retry after 30 s on other failures; records `lastOkAt` / `lastError`. Never throws to the caller; sending happens after the event is saved. | `push.js`, settings storage, clock |
| Event hooks (in `app/server.js`, `app/run-ledger.js`) | Call `notify()` where events already happen (table below). The run ledger gains an optional `onTransition(run, previousStatus)` callback so status changes have one hook. | `notify.js` |
| `app/public/sw.js` | `push` → `showNotification(title, {body, tag, data:{url}})`; `notificationclick` → focus an open Local AI window and navigate it, or open one at `url`. | — |
| Notifications card (`app/public/ui.js` section, Health page) | Guided setup, per-device kinds and quiet hours, test, device list. Self-contained so the roadmap's System page can host it later. | `/api/push/*` |

**Storage** (settings): `push:vapid` `{publicKey, privateKey (JWK), subject}`;
`push:device:<id>` `{id, name, endpoint, keys:{p256dh, auth}, kinds:[…], quiet:{on, start, end}, createdAt,
lastOkAt, lastError}`; `push:presence` `{at}` (last visible page heartbeat).

**API** (same-origin JSON only, like the other state-changing routes):

| Route | Purpose |
|---|---|
| `GET /api/push/key` | VAPID public key for `pushManager.subscribe` |
| `POST /api/push/subscribe` | `{subscription, name}` → device (idempotent on endpoint) |
| `POST /api/push/unsubscribe` | `{endpoint}` |
| `GET /api/push/devices` | devices without keys |
| `POST /api/push/devices/update` | `{id, name?, kinds?, quiet?}` |
| `POST /api/push/test` | `{id?}` → sends "Test from Local AI" now (ignores quiet hours) |
| `POST /api/push/presence` | heartbeat from a visible page (every 30 s while `document.visibilityState === 'visible'`) |

## Events

| Kind | Fires when | Tag (replaces earlier on the phone) | Opens |
|---|---|---|---|
| **needs-you** | a run enters `awaiting_approval`; an approval is created `pending` (`apiApprovalCreate` and the agent/change paths that create approvals); a Claude session posts a **new** finding with status `proposed` (`apiClaudeFindings`, not updates of existing ids) | item id | the item |
| **failed** | a run becomes `failed` (not `cancelled`); a host notice with `outcome: failed` (auto-deploy rollback); a nightly backup fails — `deploy/Backup-LocalAI-Data.ps1` gains a failure notice (`kind: backup, outcome: failed`) | run id / `deploy` / `backup` | the run / Health |
| **service** | the 2-minute-settled health transition (`getStatusAndRecordTransition`): down lists the core services affected; recovered replaces it | `service` | Health |
| **finished** | a run becomes `completed`, took ≥ 30 s (`finishedAt − startedAt`), and `push:presence.at` is older than 60 s | run id | the run |

Body text: the run's title or the service names, cut to ~80 characters. Urgency `high` for needs-you, failed and
service; `normal` for finished.

## Rules

- **Kinds:** a device gets only the kinds it has on.
- **Quiet hours:** inside the device's window only `failed` and `service` are sent.
- **Burst limit:** at most 10 per device per rolling 10 minutes; past that, one "N more updates in Local AI"
  (tag `summary`) at most every 10 minutes.
- **Grouping:** the tag makes the phone replace an earlier notification of the same tag; the server also drops an
  identical (kind, tag, title) repeat within 2 minutes.
- **Inbox:** every notification corresponds to an Inbox notice or a run; push never carries anything the app doesn't
  show.
- **Deep links:** `url` is `/?open=<view>` or `/?open=run:<id>`; the app opens it on load, and an open window
  receives it via `postMessage` from the service worker.

## Setup flow (Notifications card)

Shows only the next missing step on this device:

1. Not HTTPS → link to `https://<host>/` (certificate steps are in Secure connection, just above).
2. On iPhone and not the Home Screen app (`navigator.standalone !== true` and not `display-mode: standalone`) →
   "Add Local AI to your Home Screen: Share › Add to Home Screen, then open it from there."
3. Not subscribed → **Allow notifications** button (the iOS prompt needs a tap) → `pushManager.subscribe` with the
   VAPID key → `POST /api/push/subscribe`.
4. Subscribed → **Send a test**, the four kind switches, quiet hours (on, start, end), **Turn off on this device**,
   and the device list (name, last delivered, last error, rename, remove).

The manifest becomes plain "Local AI" with Home Screen icons (iOS shows them on the Home Screen and notifications).

## Failures

- 404/410 from the push service → device removed; the card on that device says notifications stopped and offers to
  turn them on again.
- Other errors/timeouts → one retry after 30 s, then dropped (the Inbox still has it); `lastError` on the device.
- No devices, or push disabled → `notify()` does nothing.
- VAPID key lost → devices must subscribe again (the card detects a subscription the server doesn't know and
  re-subscribes).

## Privacy and safety

Payloads are end-to-end encrypted to the device; Apple's push service sees only that a message was sent. The
appliance contacts only the listed push hosts. `/api/push/*` accepts same-origin JSON only. No prompts or file
contents beyond the ~80-character title.

## Testing

- **`tests/push.test.cjs`:** RFC 8291 §5 test vector (fixed keys and salt → exact ciphertext); VAPID JWT verifies with the
  public key and has `aud`, `exp` (≤ 24 h), `sub`; endpoint allow-list.
- **`tests/notify.test.cjs`:** against a fake push endpoint and a fake clock: kinds, quiet hours, burst summary,
  repeat dropping, presence for finished, 410 removal, one retry, never throws.
- **Hook tests:** run transitions, new vs updated Claude findings, health transition, host failure notice → `notify`
  called with the right kind and tag.
- **`tests/notifications-ui.mjs`:** the card's steps with a mocked `PushManager`/`Notification`.
- **Real device:** step 1 ends with a test notification on the owner's iPhone.

## Order of work

1. **Prove it on the iPhone:** `push.js` with its tests, `/api/push/key|subscribe|test`, the service-worker handlers,
   a bare "Send a test" in the card. The owner installs the Home Screen app and taps it. If iOS refuses (for example,
   because of the local CA), stop and switch to ntfy.
2. `notify.js`: devices, kinds, quiet hours, burst limit, presence, retries.
3. Event hooks: run ledger, approvals and findings, health, host failure notices (including the backup script).
4. The full card, manifest name and icons, docs (`docs/OPERATIONS.md` › Notifications).
