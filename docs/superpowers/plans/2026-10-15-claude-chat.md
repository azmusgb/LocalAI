# Claude Page Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat with an already-running, opted-in Claude Code session on the Mac from the LocalAI Claude page, and mirror that session's whole conversation there.

**Architecture:** A relay module on the appliance (`app/claude-chat.js`) stores sessions, messages and paired devices in the existing settings store and authenticates the Mac (shared key) and browsers (device cookie). On the Mac, a Claude Code *channel* (`host/claude-chat/channel.mjs`, stdio MCP, outbound-only) long-polls the relay and pushes web messages into the session; a mirror hook posts terminal prompts and final replies. A panel on the Claude page pairs devices and shows the conversation.

**Tech Stack:** Node ≥ 22 (`node:test`, `node:http`, `node:crypto`), Python 3 stdlib (hook), Playwright (browser tests), Claude Code channels (research preview, `--dangerously-load-development-channels`).

**Spec:** `docs/superpowers/specs/2026-10-15-claude-chat-design.md`

## Global Constraints

- Nothing on the Mac listens on the network; the channel and hooks only make outbound HTTP calls to `LOCALAI_URL` (default `http://10.0.0.21:3080`).
- Never start or resume Claude Code from the appliance or the page.
- Mac key: 32 random bytes at `~/.claude/localai-chat/mac.key` (mode 600); its SHA-256 hex at `${DATA_DIR}/claude-chat-mac-key.sha256` on the appliance, written only via `ssh windows-ai` + `docker exec`. Header: `X-LocalAI-Mac-Key`.
- Device cookie: `localai_chat_device`, HttpOnly, SameSite=Strict, Path=/api/claude/chat, Max-Age 180 days (15552000 s); store only SHA-256 of the token.
- Pairing code: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, valid 10 minutes, at most 5 pending (then 429).
- Session online when `lastSeenAt` < 45 s ago. Inbox long-poll `wait` ≤ 25 s.
- Message `text` capped at 50,000 characters (set `truncated: true`); keep latest 1,000 messages per session; prune sessions idle 30 days.
- POSTs require `Content-Type: application/json` and, when an `Origin` header is present, an origin matching the `Host` (same rule as `/api/gridcraft/run`).
- Messages render as text (`textContent`), never HTML.
- No new npm dependencies; the channel hand-rolls MCP JSON-RPC over stdio.
- Chat failures never block or slow the terminal: hooks are async, 10 s timeout, swallow every error.

## Review Focus

1. **Two devices or tabs send at once** → every message gets a distinct, increasing `seq` (allocated inside `storage.transaction`). Test in Task 2.
2. **The same session has two channels** (resumed twice, or a channel restart overlapping the old poll) → each queued message is delivered exactly once. Test in Task 2.
3. **Stop fires on a turn with no text** (tool-only turn, or a malformed transcript line) → the hook posts nothing and does not raise. Test in Task 3.
4. **Text containing HTML, emoji or 50 kB** → stored verbatim (capped), rendered literally on the page. Tests in Tasks 2 and 6.
5. **Relay restarts or drops mid long-poll** → the channel backs off and resumes; no message is lost (it stays `queued`). Test in Task 4.

---

### Task 1: Spike — session identity, registration and prompt-hook behavior (throwaway)

Answers three questions the design depends on. Nothing from this task is kept except the findings, which go into `docs/CLAUDE-CHAT.md`.

**Files:**
- Create (throwaway, outside the repo): `~/.claude/localai-chat-spike/channel.mjs`, `~/.claude/localai-chat-spike/hook.py`
- Create: `docs/CLAUDE-CHAT.md` (findings section only)

**Questions:**
1. Can the channel and the hooks find the same `claude` PID by walking process ancestry (`ps -o ppid= -o comm= -p <pid>`)?
2. Does `claude --dangerously-load-development-channels server:<name>` pick the server up from `~/.mcp.json` when started in `~` (the user's usual cwd), or does it need `claude mcp add --scope user`?
3. When a channel notification starts a turn, does `UserPromptSubmit` fire (which would double-mirror web messages)?

- [ ] **Step 1:** Write `channel.mjs`: answers `initialize` with `capabilities.experimental['claude/channel'] = {}`, logs its ancestry chain to `spike.log`, and after 5 s emits one `notifications/claude/channel` with `content: "spike: reply with the word PONG"`.
- [ ] **Step 2:** Write `hook.py` for SessionStart and UserPromptSubmit that appends `{event, ancestry, session_id}` to `spike.log`. Register it temporarily in `~/.claude/settings.json` (keep a backup and restore it in Step 5).
- [ ] **Step 3 (needs the user at a terminal):** Register `spike` in `~/.mcp.json`; the user runs `claude --dangerously-load-development-channels server:spike` in `~`, accepts the confirmation, and waits for PONG.
- [ ] **Step 4:** Read `spike.log`. Expected: same `claude` PID in both ancestry chains; the notification appears and Claude replies PONG; record whether `UserPromptSubmit` fired for it. If question 2 fails, repeat with `claude mcp add --scope user spike -- node …`.
- [ ] **Step 5:** Restore `~/.claude/settings.json`, remove the `spike` MCP entry and the spike folder. Write the three answers into `docs/CLAUDE-CHAT.md` under "How it works". If question 1 failed, switch Tasks 3–4 to the spec's fallback (relay joins PID → sessionId) before continuing.
- [ ] **Step 6:** Commit `docs/CLAUDE-CHAT.md`: `git commit -m "Claude chat: spike findings"`.

---

### Task 2: Relay — sessions, messages, inbox, mirror

**Files:**
- Create: `app/claude-chat.js`
- Modify: `app/server.js` (construct the relay after `storage`; route `/api/claude/chat/*` to it before the other `/api/claude/` routes near line 2598)
- Test: `tests/claude-chat.test.cjs` (spawns `app/server.js` with a temp `DATA_DIR`, same pattern as `tests/gridcraft-proxy.test.cjs`; writes the Mac key hash file into `DATA_DIR` before start)

**Interfaces:**
- Produces: `createClaudeChat({ storage, dataDir, json, readBody, now = () => Date.now() }) → { handle(req, res, urlObj, path): Promise<boolean> }` — returns `true` when it handled the path.
- Produces (HTTP, Mac key): `POST /api/claude/chat/announce {sessionId, title, cwd}` → `{ok:true}`; `GET /api/claude/chat/inbox?sessionId=&wait=` → `{items:[{id, seq, text, deviceName}]}`; `POST /api/claude/chat/mirror {sessionId, role:'user'|'assistant', source:'terminal'|'reply', text}` → `{ok:true, seq}`.
- Produces (HTTP, device side; until Task 5 these are open only when the test env `LOCALAI_CHAT_TEST_OPEN=1` is set, otherwise 401): `GET /api/claude/chat/sessions` → `{items:[{sessionId,title,cwd,online,lastSeenAt}]}`; `GET /api/claude/chat/messages?sessionId=&after=` → `{items:[{id,seq,role,source,text,at,status,deviceName?,truncated?}]}`; `POST /api/claude/chat/send {sessionId,text}` → `201 {item}`, `409` when offline; `POST /api/claude/chat/messages/delete {id}` → `{ok:true}` for a `queued` web message, `409` otherwise.
- Storage keys exactly as the spec's data model; message key `claudeChat:msg:<sessionId>:<seq zero-padded to 10>`; counter `claudeChat:seq:<sessionId>`.

- [ ] **Step 1: Write failing tests** in `tests/claude-chat.test.cjs`:
  - `mac-side calls need the key`: announce without header → 401; wrong key → 401; right key → 200.
  - `announce makes a session online, then offline once the window passes`: the spawned server gets `LOCALAI_CHAT_ONLINE_MS=300` (the module reads it, default 45000); online right after announce, offline after 400 ms.
  - `send to an online session queues it; inbox delivers it once`: send → `status:'queued'`; inbox → one item; second inbox (wait=0) → empty; messages now show `status:'delivered'`.
  - `two concurrent inbox polls never share a message` (Review Focus 2): queue 10, run two inbox calls in parallel, union has 10 distinct ids, intersection empty.
  - `20 concurrent sends get distinct increasing seqs` (Review Focus 1).
  - `long-poll wakes on send`: start inbox `wait=25`, send after 200 ms, inbox resolves in < 2 s with that message.
  - `mirror reply marks the newest delivered web message answered`; `mirror user/terminal appears in messages with source 'terminal'`.
  - `send to an offline session is refused with 409`.
  - `a queued message can be deleted by its sender; a delivered one cannot (409)`.
  - `text is stored verbatim and capped` (Review Focus 4): `<img src=x onerror=alert(1)> 😀` round-trips exactly; a 60,000-char text comes back as 50,000 chars with `truncated:true`.
  - `messages?after= returns only newer messages`; `only the latest 1,000 messages are kept`.
- [ ] **Step 2: Run** `node --test tests/claude-chat.test.cjs` — expected: FAIL (404s / module missing).
- [ ] **Step 3: Implement `app/claude-chat.js`.** Mac-key check: read and cache `${dataDir}/claude-chat-mac-key.sha256` (re-read when its mtime changes), compare `sha256(header)` with `crypto.timingSafeEqual`; missing file → every Mac call 401. Device check in this task: a function `deviceFor(req)` that Task 5 replaces; here it accepts requests only when the test env `LOCALAI_CHAT_TEST_OPEN=1` is set, otherwise 401 — so nothing is open before pairing exists. Long-poll: an in-process `EventEmitter` keyed by sessionId; `send` emits; inbox waits on it or the timeout, then claims queued messages inside `storage.transaction` (read queued via `listSettings(prefix,{where:{status:'queued'}})`, flip to `delivered`). Each inbox call writes `lastSeenAt`. Prune: on announce, delete sessions idle > 30 days and their message prefix.
- [ ] **Step 4: Run** `node --test tests/claude-chat.test.cjs` and `npm test` — expected: all PASS.
- [ ] **Step 5: Commit** `git add app/claude-chat.js app/server.js tests/claude-chat.test.cjs && git commit -m "Claude chat relay: sessions, messages, inbox, mirror"`

---

### Task 3: Mirror hook and session marker

**Files:**
- Create: `host/claude-chat/mirror-hook.py`
- Test: `tests/claude-chat-hook.test.cjs` (runs the hook with `python3 -I` against a fake relay `http.createServer`, fixture transcripts in a temp dir, and a temp `LOCALAI_CHAT_HOME`)

**Interfaces:**
- Consumes: Task 2 `POST /api/claude/chat/mirror`, `X-LocalAI-Mac-Key`.
- Produces: `${LOCALAI_CHAT_HOME:-~/.claude/localai-chat}/run/<claudePid>.json` = `{sessionId, cwd, startedAt}` on SessionStart; reads `run/<claudePid>.chat` (written by Task 4) to decide whether to post. `claudePid` = first ancestor whose command name is `claude` (Task 1 finding); tests set `LOCALAI_CHAT_PID` to bypass the ancestry walk.

- [ ] **Step 1: Write failing tests:**
  - `SessionStart writes the run file and posts nothing`.
  - `without the .chat marker, UserPromptSubmit and Stop post nothing` (privacy for sessions that did not opt in).
  - `with the marker, UserPromptSubmit posts {role:'user', source:'terminal', text: prompt}`.
  - `Stop posts the assistant text after the last user entry`, joining multiple text blocks with blank lines and ignoring `tool_use` blocks.
  - `Stop with a tool-only turn or a malformed transcript line posts nothing and exits 0` (Review Focus 3).
  - `relay down → exit 0 within 10 s`.
  - If Task 1 found that channel notifications trigger UserPromptSubmit: `a prompt that starts with <channel source="localai-chat" is not posted`.
- [ ] **Step 2: Run** `node --test tests/claude-chat-hook.test.cjs` — expected: FAIL.
- [ ] **Step 3: Implement `mirror-hook.py`** (stdlib only; read the key from `mac.key`; same never-raise structure as `~/.claude/hooks/localai-progress.py`).
- [ ] **Step 4: Run** the test file — expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Claude chat: mirror hook for opted-in sessions"`

---

### Task 4: Channel

**Files:**
- Create: `host/claude-chat/channel.mjs`
- Test: `tests/claude-chat-channel.test.cjs` (spawns the channel with stdio pipes, a fake relay, `LOCALAI_CHAT_HOME` temp dir, `LOCALAI_CHAT_PID` set, and a pre-written `run/<pid>.json`)

**Interfaces:**
- Consumes: Task 2 `announce` and `inbox`; Task 3 `run/<pid>.json`.
- Produces: `run/<pid>.chat` marker (created after a successful announce, removed on exit); MCP over stdio: `initialize` result `{protocolVersion: <client's>, capabilities: {experimental: {'claude/channel': {}}}, serverInfo: {name:'localai-chat', version:'1.0.0'}, instructions: <spec text>}`; notification `{jsonrpc:'2.0', method:'notifications/claude/channel', params:{content, meta:{from:'web', device, message_id}}}`.

- [ ] **Step 1: Write failing tests:**
  - `initialize declares the claude/channel capability and the instructions` (exact instructions string from the spec, with "the owner of this Mac").
  - `announces the session from run/<pid>.json, then writes the .chat marker`.
  - `each queued message becomes one notification with from/device/message_id meta` (meta keys contain only `[A-Za-z0-9_]`).
  - `ping gets a result; unknown methods get error -32601`.
  - `relay returns 500 twice, then recovers: the queued message is still delivered` (Review Focus 5); backoff starts at 1 s (test uses `LOCALAI_CHAT_BACKOFF_MS=50`).
  - `stdin close removes the .chat marker and exits 0`.
- [ ] **Step 2: Run** `node --test tests/claude-chat-channel.test.cjs` — expected: FAIL.
- [ ] **Step 3: Implement `channel.mjs`** (line-delimited JSON-RPC on stdin/stdout; logs only to `channel.log`, never stdout, since stdout is the protocol).
- [ ] **Step 4: Run** the test file and `npm test` — expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Claude chat: channel that delivers web messages into the session"`

---

### Task 5: Pairing, devices, Mac CLI and installer

**Files:**
- Modify: `app/claude-chat.js` (replace `deviceFor` with cookie auth; add pairing and device endpoints)
- Create: `host/claude-chat/localai-chat` (POSIX sh wrapper → `node host/claude-chat/cli.mjs`), `host/claude-chat/cli.mjs`, `host/claude-chat/install.sh`
- Test: extend `tests/claude-chat.test.cjs`; add `tests/claude-chat-cli.test.cjs`

**Interfaces:**
- Produces (HTTP): `POST /api/claude/chat/pair-request` → `201 {id, code, expiresAt}` (429 when 5 pending); `GET /api/claude/chat/pair-status?id=` → `{status:'pending'|'approved'|'expired'}` and, once, `Set-Cookie` on approval; `POST /api/claude/chat/pair/approve {code, name}` (Mac key) → `{deviceId}`; `GET /api/claude/chat/devices` and `POST /api/claude/chat/devices/revoke {id}` (Mac key **or** device cookie).
- Produces (CLI): `localai-chat pair <code> [name]`, `localai-chat devices`, `localai-chat revoke <id>`, `localai-chat status` (key present, relay reachable, key accepted).
- Produces (installer): copies `channel.mjs`, `cli.mjs`, `mirror-hook.py` to `~/.claude/localai-chat/`; creates `mac.key` if missing; writes the hash on the appliance (`ssh windows-ai docker exec local-ai-appliance sh -c 'cat > /data/claude-chat-mac-key.sha256'`); registers the MCP server the way Task 1 found works; adds the hook entries (SessionStart, UserPromptSubmit, Stop; async, 10 s) without touching the existing progress hook; appends a `claude-chat` function to `~/.zshrc` that runs `claude --dangerously-load-development-channels server:localai-chat "$@"`; prints next steps. Re-running it is safe (idempotent).

- [ ] **Step 1: Write failing tests:**
  - `device endpoints return 401 without a cookie` (and remove `LOCALAI_CHAT_TEST_OPEN` from Task 2's tests, pairing a device in a `before` hook instead).
  - `pairing: request → approve with Mac key → status sets an HttpOnly SameSite=Strict cookie once` (assert every attribute from Global Constraints); the second status call sets no cookie.
  - `approve without the Mac key → 401`; `wrong code → 404`; `a code older than 10 minutes → expired`.
  - `a sixth pending pairing request → 429`.
  - `codes use only the allowed alphabet` (100 requests, regex `^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$`; expire them between batches).
  - `revoke stops the cookie working immediately`.
  - `cross-origin POST → 403; non-JSON POST → 415`.
  - CLI: `pair`/`devices`/`revoke` hit the right endpoints with the key; `status` reports a missing key with the installer hint.
- [ ] **Step 2: Run** both files — expected: FAIL.
- [ ] **Step 3: Implement** pairing and cookie auth in `app/claude-chat.js`; write `cli.mjs`, the wrapper and `install.sh` (`shellcheck`-clean if available).
- [ ] **Step 4: Run** `npm test` — expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Claude chat: device pairing, Mac CLI and installer"`

---

### Task 6: Chat panel on the Claude page

**Files:**
- Modify: `app/public/index.html` (`#claude` section: add `<div id="claudeChat" class="card claude-chat">` before the board), `app/public/ui.js` (new `// ==== claude-chat.js ====` section after the claude-board section), `app/public/app.css` (styles before the phone layer; phone rules inside it)
- Test: `tests/claude-chat-ui.mjs` (Playwright), added to `test:browser` in `package.json` and to the `node --check` / `test -f` lists in `.github/workflows/validate.yml`

**Interfaces:**
- Consumes: Task 2 and Task 5 HTTP APIs. The test approves pairing by calling `pair/approve` directly with the Mac key it wrote into the server's `DATA_DIR`, and simulates the Mac with `announce`, `inbox` and `mirror`.
- Produces: element ids `claudeChat`, `claudeChatPair`, `claudeChatCode`, `claudeChatSession`, `claudeChatLog`, `claudeChatInput`, `claudeChatSend`, `claudeChatDevices`.

- [ ] **Step 1: Write failing tests:**
  - `unpaired: shows the code, the exact command "localai-chat pair <code>" and the plain-HTTP warning`.
  - `approval switches the panel to the session picker without a reload`.
  - `send shows queued, then delivered after an inbox pickup, then the mirrored reply with answered`.
  - `terminal prompts and web messages carry different labels`.
  - `HTML in a reply renders literally` (Review Focus 4): mirror `<b>x</b><img src=x onerror="window.__x=1">`; assert visible text contains `<b>x</b>` and `window.__x` is undefined.
  - `offline session disables the composer with the claude-chat hint`.
  - `a message still queued when its session goes offline shows "not delivered" and a Delete button that removes it`.
  - `revoking this device returns to the pairing screen`.
  - Phone (390×844): composer and Send clear `#uxMobileNav`; no sideways scroll; Send and inputs ≥ 44 px; textarea font ≥ 16 px.
- [ ] **Step 2: Run** `LOCALAI_URL=http://127.0.0.1:3099 node tests/claude-chat-ui.mjs` against a local server — expected: FAIL.
- [ ] **Step 3: Implement** the panel: render with `textContent`; poll `messages?after=` every 2 s while `#claude` is the active view and `document.visibilityState==='visible'`, else every 15 s; Cmd/Ctrl+Enter sends, Enter inserts a newline; disable Send while a request is in flight.
- [ ] **Step 4: Run** `npm test` and `npm run test:browser` against the local server — expected: all PASS (including `mobile-ui.mjs` and `claude-board-ui.mjs`).
- [ ] **Step 5: Commit** `git commit -m "Claude page: chat panel with pairing"`

---

### Task 7: Docs, deploy and end-to-end

**Files:**
- Modify: `docs/CLAUDE-CHAT.md` (setup, daily use, pairing, revoking, security notes incl. plain HTTP and bypass mode, troubleshooting with `localai-chat status`)

- [ ] **Step 1:** Write the docs. Open a PR from `feature/claude-chat`; wait for CI green and review comments; address them.
- [ ] **Step 2:** Merge; on the host `git pull` + `deploy\Deploy-LocalAI.ps1`; confirm `GET /healthz` reports the merge commit.
- [ ] **Step 3:** On the Mac run `host/claude-chat/install.sh`; `localai-chat status` → key accepted.
- [ ] **Step 4 (with the user):** `claude-chat --resume <session>`; pair the phone; send "what time is it?" from the page → reply appears on the page; type in the terminal → both turns appear on the page; revoke the phone → page returns to pairing.
- [ ] **Step 5:** Run every browser suite against the appliance (`LOCALAI_URL=http://10.0.0.21:3080 npm run test:browser`); post the result to the Claude board and mark the finding fixed.
