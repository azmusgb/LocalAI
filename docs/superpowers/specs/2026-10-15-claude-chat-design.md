# Claude page chat — design

Date: 2026-10-15 · Status: revision 2 (approach B), for review

## Goal

From the LocalAI **Claude** page (phone or any browser on the LAN), talk to a Claude Code session that is already
running in a terminal on the Mac, and see that session's whole conversation there. The terminal keeps working exactly
as it does today: the page is a second window onto the same session, using that session's existing access.

### Decisions (from the user)

| Question | Decision |
|---|---|
| What a web message reaches | A session already running on the Mac. Nothing new is ever started. |
| Who may send | Paired devices only; pairing is approved from the Mac; devices can be revoked. |
| Which sessions | Only sessions started (or resumed) with chat turned on; the page lists those to choose from. |
| What the page shows | The full conversation of an opted-in session: terminal prompts, web messages, Claude's replies. |
| Mechanism | **Approach B**: Claude Code's per-session inbox socket (cross-session messaging), fed by a helper the session starts itself. Revision 1 used channels; they are disabled for the user's Claude Team org (`channelsEnabled`), so the user chose B. |

### Non-goals

- Starting or resuming Claude Code from the page (no runner).
- Approving tool permissions from the page. The session's own permission mode applies.
- Mirroring sessions that did not opt in. Their behavior and the existing progress board are unchanged.
- Streaming partial replies. A reply appears when Claude finishes its turn.

## Spike findings (2026-10-15, Claude Code 2.1.300, macOS)

- Each session binds a Unix socket and exports `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` to hooks
  (before `SessionStart`) and Bash. Writing two lines to it injects a message:
  `{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}` then
  `{"type":"user","message":{"role":"user","content":"<text>"}}`.
  The format is undocumented (it comes from Claude Code's own debug hint); the token and socket are documented.
- A message from the session's own child process with the token is delivered even in bypass-permissions mode; an idle
  session starts a new turn, a busy one reads it between tool calls.
- Claude sees it as "Another Claude session sent a message": it acts within its own permissions, never changes
  permissions, `CLAUDE.md` or config because of it, and it cannot answer a permission prompt.
- `UserPromptSubmit` fires for injected messages, so the mirror hook must recognise and skip them.
- The inbox drops messages past a burst limit and queues at most 50; same-machine messages are capped near 1M characters.

## Architecture

```text
 phone / browser ──(paired-device cookie)──▶ LocalAI appliance (10.0.0.21:3080)
                                               chat relay: messages, sessions, devices
                                                   ▲                    ▲
                     long-poll inbox (Mac key) ────┘                    └──── mirror posts (Mac key)
                                                   │                    │
 Mac:  claude-chat   (= LOCALAI_CHAT=1 claude …)
         ├── SessionStart hook ── starts ──▶ bridge  (one per session; posts to the session's own inbox socket)
         └── mirror hook (UserPromptSubmit, Stop)
```

Nothing on the Mac listens on the network. The appliance is the only rendezvous point.

### Units

| Unit | Location | Responsibility | Depends on |
|---|---|---|---|
| Chat relay | `app/claude-chat.js` (new module), routes wired in `app/server.js` | Store sessions, messages, devices, pairing requests; authenticate both sides; long-poll inbox | `storage.js` settings API |
| Chat panel | `app/public/ui.js` (Claude page section), `app/public/index.html`, `app/public/app.css` | Pairing screen, session picker, conversation, composer | relay device API |
| Hook | `host/claude-chat/hook.py`, installed to `~/.claude/localai-chat/` | `SessionStart`: start the bridge. `UserPromptSubmit`/`Stop`: mirror. Acts only when `LOCALAI_CHAT=1` | Python 3 stdlib |
| Bridge | `host/claude-chat/bridge.mjs`, installed to `~/.claude/localai-chat/` | Announce the session, long-poll the relay, inject each web message into the session's inbox socket | Node ≥ 22 (Mac has 26), no npm deps |
| Mac CLI | `host/claude-chat/localai-chat` (sh) + `cli.mjs` | `pair <code> [name]`, `devices`, `revoke <id>`, `status` | Mac key file |
| Installer | `host/claude-chat/install.sh` | Copy files, add hook entries, create the Mac key, put its hash on the appliance over `ssh windows-ai`, add the `claude-chat` shell function | ssh access to the host |

### Opt-in and session identity

- `claude-chat` is a shell function: `LOCALAI_CHAT=1 claude "$@"` (so `claude-chat --resume <id>` opts an existing
  conversation in). Hooks inherit the variable; sessions started with plain `claude` never have it.
- Hooks receive `session_id` directly; the bridge gets it as an argument. The chat session id is Claude's full
  `session_id`. The page title is `<cwd basename> · <first 8 of session_id>`.

## Pairing and authentication

**Mac key.** `install.sh` creates 32 random bytes at `~/.claude/localai-chat/mac.key` (mode 600) and writes its SHA-256
to `/data/claude-chat-mac-key.sha256` inside the appliance container over `ssh windows-ai` + `docker exec`. No network
endpoint can set or change it. Mac-side requests send `X-LocalAI-Mac-Key`; the relay compares hashes in constant time.

**Devices.**

1. On an unpaired device the panel shows **Pair this device** → `POST /api/claude/chat/pair-request` returns a 6-character
   code (no ambiguous characters) valid for 10 minutes. The page shows: “On your Mac run `localai-chat pair K7M4QX`”.
2. On the Mac, `localai-chat pair K7M4QX "My iPhone"` calls `POST /api/claude/chat/pair/approve` with the Mac key.
3. The page polls `GET /api/claude/chat/pair-status?id=…`; on approval the relay sets cookie
   `localai_chat_device` (HttpOnly, SameSite=Strict, Path=/api/claude/chat, 180 days) and stores only its SHA-256.
4. Revoke from the page (any paired device can revoke any device, including itself) or from the Mac
   (`localai-chat devices`, `localai-chat revoke <id>`). Revoking deletes the stored hash; the cookie stops working at once.

**Request checks.**

- Device endpoints require a valid device cookie, except `pair-request` and `pair-status`.
- `POST` endpoints require `Content-Type: application/json` and a same-origin `Origin` when one is sent (as `/api/gridcraft/run`).
- Pairing requests are rate-limited: at most 5 pending at a time, after which new ones get 429.

**Known limit.** The appliance serves plain HTTP, so the device cookie crosses the Wi-Fi unencrypted. Anyone able to
sniff it could send messages until it is revoked. `prod-https` on the board closes this. The page states it in the
pairing screen.

## Data model (storage settings)

| Key | Value |
|---|---|
| `claudeChat:session:<sessionId>` | `{sessionId, title, cwd, announcedAt, lastSeenAt}`; online when `lastSeenAt` < 45 s ago (the bridge's long-poll refreshes it) |
| `claudeChat:msg:<sessionId>:<seq>` | `{id, sessionId, seq, role: user\|assistant, source: web\|terminal\|reply, text, at, deviceId?, deviceName?, status: queued\|delivering\|delivered\|answered, leaseUntil?}`; `seq` zero-padded to 10 digits; `leaseUntil` only while `delivering` |
| `claudeChat:seq:<sessionId>` | per-session counter |
| `claudeChat:device:<id>` | `{id, name, tokenSha256, pairedAt, lastSeenAt}` |
| `claudeChat:pair:<id>` | `{id, code, createdAt, approvedAt?, deviceId?}`; deleted on approval or expiry |

`text` is capped at 50,000 characters (marked truncated). Each session keeps its latest 1,000 messages. Sessions with no
activity for 30 days are pruned, along with their messages.

## API

Mac side (header `X-LocalAI-Mac-Key`):

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/claude/chat/announce` | `{sessionId, title, cwd}`: mark the session chat-enabled and online |
| GET | `/api/claude/chat/inbox?sessionId=&wait=25` | Long-poll: return queued web messages and lease them (`delivering`, `leaseUntil` = now + 60 s); first requeues any `delivering` message whose lease expired; refreshes `lastSeenAt` |
| POST | `/api/claude/chat/inbox/ack` | `{sessionId, ids}` (≤ 50 ids of that session): each still-`delivering` message becomes `delivered`; returns `{acked: [ids flipped]}`. Unknown, already delivered/answered, or expired-and-requeued ids are left out, not errors |
| POST | `/api/claude/chat/mirror` | `{sessionId, role, source, text}` from the hook; a `reply` marks every earlier `delivered` web message `answered` (not `delivering` ones) |
| POST | `/api/claude/chat/pair/approve` | `{code, name}` |
| GET / POST | `/api/claude/chat/devices`, `/api/claude/chat/devices/revoke` | Device list and revoke for the Mac CLI |

Device side (cookie):

| Method | Path | Purpose |
|---|---|---|
| POST / GET | `/api/claude/chat/pair-request`, `/api/claude/chat/pair-status` | Pairing (no cookie needed) |
| GET | `/api/claude/chat/sessions` | Opted-in sessions with an `online` flag |
| GET | `/api/claude/chat/messages?sessionId=&after=<seq>` | Conversation, incremental |
| POST | `/api/claude/chat/send` | `{sessionId, text}` → stored as `queued`, `source: web`; 409 when the session is offline |
| POST | `/api/claude/chat/messages/delete` | `{id}`: delete a still-`queued` web message |
| GET / POST | `/api/claude/chat/devices`, `/api/claude/chat/devices/revoke` | Same as the Mac versions, for the page |

The relay never returns the Mac key or device tokens, and `/api/claude/board` and `/priorities` are unchanged.

## Bridge behavior

- Started by the `SessionStart` hook as a detached background process (`node bridge.mjs <sessionId> <title> <cwd>`),
  inheriting `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`. `SessionStart` also fires on resume, clear
  and compact, so the bridge keeps a pidfile `~/.claude/localai-chat/run/<sessionId>.pid` and a second start exits at once
  while the first is alive.
- Loop: `announce`, then `GET inbox?wait=25`, then `POST inbox/ack` for the returned ids; for each id in `acked` (and
  only those), open the socket, write the auth line and
  `{"type":"user","message":{"role":"user","content":"[LocalAI web · <deviceName>] <text>"}}`, close. One message per
  connection, at most one per second, so the session's burst limit is never hit.
- Exits when the session is gone: the socket path no longer exists, or a connect fails with `ENOENT`/`ECONNREFUSED`
  three times in a row. Removes its pidfile on exit.
- Relay errors back off (1 s doubling to 30 s) and are logged to `~/.claude/localai-chat/bridge.log`; the inbox call only
  leases a message (`delivering`); it becomes `delivered` when the bridge acks it, just before injecting. If the inbox
  response or the ack is lost, the lease expires after 60 s and the message is queued again, so a dropped connection
  delays a message instead of losing it, and an unacknowledged message is never injected (at most once). The bridge retries an injection that fails while
  the socket still exists (3 tries) before logging it as lost.

## Hook behavior

- Does nothing unless `LOCALAI_CHAT=1`. Async, 10 s timeout, swallows every error: chat never blocks the terminal.
- `SessionStart`: start the bridge (see above).
- `UserPromptSubmit`: post `{role: user, source: terminal, text: prompt}` unless the prompt starts with `[LocalAI web · `
  (that is a web message the relay already has).
- `Stop`: read `transcript_path`, take the assistant text blocks after the last user entry, and post
  `{role: assistant, source: reply, text}`. Skip if empty.

## Chat panel (Claude page)

- Above the board on phones, beside it on wide screens (board layout unchanged).
- **Unpaired:** pairing card with the code, the Mac command to run, the HTTP warning, and a live “waiting for approval” state.
- **Paired:**
  - Session picker: opted-in sessions, newest first, each with an online/offline dot and title.
  - Conversation: one message per bubble. Terminal prompts and web messages are labeled differently; replies are
    plain text with preserved line breaks (no HTML/markdown rendering in v1, so no injection surface).
  - Status under each web message: queued, sending (`delivering`), delivered, answered.
  - Composer: textarea (16 px, Enter = newline, a Send button; Cmd/Ctrl+Enter sends). Disabled with a reason when the
    session is offline: messages to an offline session are not accepted, so nothing runs unexpectedly hours later.
  - Polls `messages?after=` every 2 s while the panel is visible, every 15 s when hidden.
  - A one-line note under the composer: web messages reach Claude as messages from another session, so it acts within
    the session's permissions but will not change its settings or approve prompts because of them.
- **Devices** disclosure: list paired devices with last-seen and Revoke.
- Meets the phone checks in `tests/mobile-ui.mjs` (44 px targets, no sideways scroll, composer clear of the tab bar).

## Failure handling

| Situation | Behavior |
|---|---|
| Session offline (no inbox poll for 45 s) | Composer disabled with “Start or resume it with `claude-chat`”; history still readable |
| Message queued, session goes offline before pickup | Stays `queued`; shown as “not delivered”; the sender can delete it |
| Claude busy when a message arrives | Claude reads it between tool calls; page shows `delivered` |
| Session holds the message (own-child check failed) | Claude Code shows an approval dialog in the terminal; page shows `delivered`; documented in troubleshooting |
| Relay unreachable from the Mac | Bridge backs off and retries; hooks drop silently; terminal unaffected |
| Device revoked | Next request returns 401; panel returns to the pairing screen |
| Mac key missing or wrong | Mac-side calls return 401; `localai-chat status` explains how to re-run the installer |
| Claude Code changes the inbox format | Injected messages stop arriving; `bridge.log` records each injection and failure, and `localai-chat status` shows the last successful one; documented as the main maintenance risk |

## Testing

- **Relay** (`tests/claude-chat.test.cjs`, node:test against a spawned server): pairing (expiry, rate limit, approve
  needs Mac key), device cookie checks, revoke, cross-origin and non-JSON rejection, inbox long-poll leases once,
  ack marks delivered, an unacknowledged lease expires and the message is offered again, mirror reply marks answered, offline sessions refuse `send`, caps and pruning.
- **Bridge** (`tests/claude-chat-bridge.test.cjs`): run `bridge.mjs` against a fake relay and a fake Unix-socket inbox;
  check the auth line and the exact user-message line with the `[LocalAI web · <device>]` prefix, one message per
  connection, single instance per session, exit when the socket disappears, recovery after relay errors.
- **Hook** (`tests/claude-chat-hook.test.cjs`, runs `hook.py` from node with fixture transcripts): no-op without
  `LOCALAI_CHAT=1`; SessionStart starts the bridge (stubbed command); prompt mirroring skips web-prefixed prompts; Stop
  extracts the last assistant text; malformed transcripts and a dead relay never raise.
- **Panel** (`tests/claude-chat-ui.mjs`, Playwright, in `test:browser`): pairing flow approved through the Mac-key API,
  session picker, send → queued → delivered → answered, offline disables composer, revoke returns to pairing, phone layout.
- **End to end (manual, once):** `claude-chat --resume <this session>`, pair the phone, send "what time is it" from the
  page, see the reply there; type in the terminal and see both turns mirrored.

## Rollout

1. Spike (done): findings above.
2. Relay + tests; deploy (inert until a Mac key exists).
3. Hook and bridge + tests.
4. Mac CLI and installer; run the installer on the Mac.
5. Panel + tests; deploy.
6. Manual end-to-end; `docs/CLAUDE-CHAT.md`; update the board.
