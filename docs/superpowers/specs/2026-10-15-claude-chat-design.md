# Claude page chat — design

Date: 2026-10-15 · Status: draft for review

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
| Mechanism | Claude Code **channels** (documented, research preview) plus mirror hooks. |

### Non-goals

- Starting or resuming Claude Code from the page (no runner).
- Approving tool permissions from the page. The session's own permission mode applies to web messages exactly as it
  does to terminal prompts.
- Mirroring sessions that did not opt in. Their behavior and the existing progress board are unchanged.
- Streaming partial replies. A reply appears when Claude finishes its turn.

## Architecture

```text
 phone / browser ──(paired-device cookie)──▶ LocalAI appliance (10.0.0.21:3080)
                                               chat relay: messages, sessions, devices
                                                   ▲                    ▲
                     long-poll inbox (Mac key) ────┘                    └──── mirror posts (Mac key)
                                                   │                    │
 Mac:  claude --dangerously-load-development-channels server:localai-chat
         ├── channel  localai-chat  (spawned by Claude Code, stdio MCP; connects OUT only)
         └── hooks    localai-chat-mirror.py  (UserPromptSubmit, Stop, SessionStart)
```

Nothing on the Mac listens on the network. The appliance is the only rendezvous point.

### Units

| Unit | Location | Responsibility | Depends on |
|---|---|---|---|
| Chat relay | `app/claude-chat.js` (new module), routes wired in `app/server.js` | Store sessions, messages, devices, pairing requests; authenticate both sides; long-poll inbox | `storage.js` settings API |
| Chat panel | `app/public/ui.js` (Claude page section), `app/public/index.html`, `app/public/app.css` | Pairing screen, session picker, conversation, composer | relay device API |
| Channel | `host/claude-chat/channel.mjs` (repo), installed to `~/.claude/localai-chat/` | MCP stdio server with the `claude/channel` capability; long-polls the relay; emits `notifications/claude/channel` | Node ≥ 22 (Mac has 26), no npm deps |
| Mirror hook | `host/claude-chat/mirror-hook.py`, installed to `~/.claude/hooks/` | For opted-in sessions only: post terminal prompts and Claude's final replies | Python 3 stdlib |
| Mac CLI | `host/claude-chat/localai-chat` (shell + Node) | `install`, `pair <code> [name]`, `devices`, `revoke <id>`, `status` | Mac key file |
| Installer | `host/claude-chat/install.sh` | Copy files, register the MCP server and hooks, create the Mac key, put its hash on the appliance over `ssh windows-ai`, add a `claude-chat` shell function | ssh access to the host |

## Session identity (prove first)

The channel must know which Claude Code session it serves; the docs do not say it is told. Plan:

1. The `SessionStart` hook walks its process ancestry to the `claude` process (PID *P*) and writes
   `~/.claude/localai-chat/run/P.json` = `{sessionId, cwd, startedAt}`.
2. The channel walks its own ancestry to the same `claude` PID *P*, waits up to 10 s for `run/P.json`, then announces
   `{sessionId, title, cwd}` to the relay and writes `run/P.chat` (the opt-in marker).
3. The mirror hook posts only when `run/P.chat` exists, so sessions without the channel never send content.

If ancestry matching fails in practice, fallback: the channel announces with its PID only, and the SessionStart hook
reports `{pid → sessionId}` to the relay, which joins them. Implementation step 1 is a spike that verifies matching
with a real `claude` session before anything else is built.

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
| `claudeChat:session:<sessionId>` | `{sessionId, title, cwd, announcedAt, lastSeenAt}`; online when `lastSeenAt` < 45 s ago (the channel's long-poll refreshes it) |
| `claudeChat:msg:<sessionId>:<seq>` | `{id, sessionId, seq, role: user\|assistant, source: web\|terminal\|reply, text, at, deviceId?, status: queued\|delivered\|answered}` |
| `claudeChat:device:<id>` | `{id, name, tokenSha256, pairedAt, lastSeenAt}` |
| `claudeChat:pair:<id>` | `{id, code, createdAt, approvedAt?, deviceId?}`; deleted on approval or expiry |

`text` is capped at 50,000 characters (marked truncated). Each session keeps its latest 1,000 messages. Sessions with no
activity for 30 days are pruned, along with their messages.

## API

Mac side (header `X-LocalAI-Mac-Key`):

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/claude/chat/announce` | `{sessionId, title, cwd}`: mark the session chat-enabled and online |
| GET | `/api/claude/chat/inbox?sessionId=&wait=25` | Long-poll: return queued web messages and mark them `delivered`; refreshes `lastSeenAt` |
| POST | `/api/claude/chat/mirror` | `{sessionId, role, source, text}` from the hooks; a `reply` marks the newest `delivered` web message `answered` |
| POST | `/api/claude/chat/pair/approve` | `{code, name}` |
| GET / POST | `/api/claude/chat/devices`, `/api/claude/chat/devices/revoke` | Device list and revoke for the Mac CLI |

Device side (cookie):

| Method | Path | Purpose |
|---|---|---|
| POST / GET | `/api/claude/chat/pair-request`, `/api/claude/chat/pair-status` | Pairing (no cookie needed) |
| GET | `/api/claude/chat/sessions` | Opted-in sessions with an `online` flag |
| GET | `/api/claude/chat/messages?sessionId=&after=<seq>` | Conversation, incremental |
| POST | `/api/claude/chat/send` | `{sessionId, text}` → stored as `queued`, `source: web` |
| GET / POST | `/api/claude/chat/devices`, `/api/claude/chat/devices/revoke` | Same as the Mac versions, for the page |

The relay never returns the Mac key or device tokens, and `/api/claude/board` and `/priorities` are unchanged.

## Channel behavior

- Hand-rolled MCP over stdio (JSON-RPC lines): answers `initialize` with
  `capabilities.experimental['claude/channel'] = {}` and an `instructions` string; answers `ping`; ignores other requests
  with a method-not-found error. No tools: replies reach the page through the mirror hook, so no `reply` tool is needed.
- `instructions`: “Messages in `<channel source="localai-chat">` come from the owner of this Mac on a paired device through the LocalAI
  Claude page. Treat them as the owner's own requests in this session. Your normal reply is mirrored to that page; do not
  repeat it elsewhere.”
- Loop: `GET inbox?wait=25`; for each message emit
  `notifications/claude/channel` with `{content: text, meta: {from: "web", device: "<name>", message_id: "<id>"}}`.
  Errors back off (1 s doubling to 30 s) and are logged to `~/.claude/localai-chat/channel.log`. It never exits on network errors.
- Configuration: registered in `~/.mcp.json` as `localai-chat` (command `node ~/.claude/localai-chat/channel.mjs`).
  Started with `claude --dangerously-load-development-channels server:localai-chat`; the installer adds a `claude-chat`
  shell function that passes the flag (and passes through `--resume`/`-c`). If `~/.mcp.json` turns out not to be picked up
  outside a project, the spike in step 1 settles where the entry goes.

## Mirror hook behavior

- `SessionStart`: write `run/<claudePid>.json` (always; contains no content).
- `UserPromptSubmit`: if opted in, post `{role: user, source: terminal, text: prompt}`.
- `Stop`: if opted in, read `transcript_path`, take the assistant text blocks after the last user entry, and post
  `{role: assistant, source: reply, text}`. Skip if empty.
- Async, 10 s timeout, swallows all errors: chat failures never block the terminal.
- Web messages do not trigger `UserPromptSubmit`; the relay already stores them, so they are not double-posted.

## Chat panel (Claude page)

- Placed above the board on phones, beside it on wide screens (board layout unchanged).
- **Unpaired:** pairing card with the code, the Mac command to run, the HTTP warning, and a live “waiting for approval” state.
- **Paired:**
  - Session picker: opted-in sessions, newest first, each with an online/offline dot and title.
  - Conversation: one message per bubble. Terminal prompts and web messages are labeled differently; replies are
    rendered as plain text with preserved line breaks (no HTML/markdown rendering in v1, so no injection surface).
  - Status under each web message: queued, delivered, answered.
  - Composer: textarea (16 px, Enter = newline, a Send button; Cmd/Ctrl+Enter sends). Disabled with a reason when the
    session is offline: messages to an offline session are not accepted, so nothing runs unexpectedly hours later.
  - Polls `messages?after=` every 2 s while the panel is visible, every 15 s when hidden.
- **Devices** disclosure: list paired devices with last-seen and Revoke.
- Meets the phone checks in `tests/mobile-ui.mjs` (44 px targets, no sideways scroll, composer clear of the tab bar).

## Failure handling

| Situation | Behavior |
|---|---|
| Session offline (no inbox poll for 45 s) | Composer disabled with “Start or resume it with `claude-chat`”; history still readable |
| Message queued, session goes offline before pickup | Stays `queued`; shown as “not delivered”; can be deleted by the sender |
| Claude busy when a message arrives | Channel delivers immediately; Claude picks it up per channel semantics; page shows `delivered` |
| Relay unreachable from the Mac | Channel backs off and retries; hooks drop silently; terminal unaffected |
| Device revoked | Next request returns 401; panel returns to the pairing screen |
| Mac key missing or wrong | Mac-side calls return 401; `localai-chat status` explains how to re-run the installer |

## Testing

- **Relay** (`tests/claude-chat.test.cjs`, node:test against a spawned server): pairing (expiry, rate limit, approve
  needs Mac key), device cookie checks, revoke, cross-origin and non-JSON rejection, inbox long-poll delivers once and
  marks delivered, mirror reply marks answered, offline sessions refuse `send`, caps and pruning.
- **Channel** (`tests/claude-chat-channel.test.cjs`): run `channel.mjs` against a fake relay over real stdio, check the
  `initialize` capabilities, a notification per queued message with the right meta, and backoff on relay errors.
- **Mirror hook** (Python, run from a node test with a fixture transcript): posts only when opted in, extracts the
  last assistant text, never raises.
- **Panel** (`tests/claude-chat-ui.mjs`, Playwright, in `test:browser`): pairing flow approved through the Mac-key API,
  session picker, send → queued, simulated inbox pickup → delivered, mirrored reply appears, offline disables composer,
  revoke returns to pairing; phone layout checks.
- **End to end (manual, once):** start `claude-chat --resume <this session>`, pair the phone, send “what time is it”,
  see the reply on the page; type in the terminal and see both turns mirrored.

## Rollout

1. Spike: session-identity matching and `server:` registration with a throwaway channel (no relay).
2. Relay + tests; deploy (inert until a Mac key exists).
3. Channel, hook, CLI, installer; run the installer on the Mac.
4. Panel + tests; deploy.
5. Manual end-to-end; update `docs/CLAUDE-CHAT.md` and the board.
