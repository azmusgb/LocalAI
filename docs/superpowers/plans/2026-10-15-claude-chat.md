# Claude Page Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat with an already-running, opted-in Claude Code session on the Mac from the LocalAI Claude page, and mirror that session's whole conversation there.

**Architecture:** A relay module on the appliance (`app/claude-chat.js`) stores sessions, messages and paired devices in the existing settings store and authenticates the Mac (shared key) and browsers (device cookie). On the Mac, sessions started with `claude-chat` (`LOCALAI_CHAT=1`) run a hook that starts a bridge (`host/claude-chat/bridge.mjs`, outbound-only) which long-polls the relay and injects web messages into the session's own inbox socket; the same hook mirrors terminal prompts and final replies. A panel on the Claude page pairs devices and shows the conversation.

**Tech Stack:** Node ≥ 22 (`node:test`, `node:http`, `node:net`, `node:crypto`), Python 3 stdlib (hook), Playwright (browser tests), Claude Code per-session inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN`).

**Spec:** `docs/superpowers/specs/2026-10-15-claude-chat-design.md`

## Global Constraints

- Nothing on the Mac listens on the network; the bridge and hook only make outbound HTTP calls to `LOCALAI_URL` (default `http://10.0.0.21:3080`).
- Opt-in is the environment variable `LOCALAI_CHAT=1`, set by the `claude-chat` shell function (`LOCALAI_CHAT=1 claude "$@"`); hooks do nothing without it.
- Inbox injection, exactly: connect to `$CLAUDE_CODE_MESSAGING_SOCKET`, write `{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}\n` then `{"type":"user","message":{"role":"user","content":"[LocalAI web · <deviceName>] <text>"}}\n`, close. One message per connection, at most one per second.
- Web-message prefix: `[LocalAI web · ` — the hook never mirrors a prompt that starts with it.
- Never start or resume Claude Code from the appliance or the page.
- Mac key: 32 random bytes at `~/.claude/localai-chat/mac.key` (mode 600); its SHA-256 hex at `${DATA_DIR}/claude-chat-mac-key.sha256` on the appliance, written only via `ssh windows` + `docker exec`. Header: `X-LocalAI-Mac-Key`.
- Device cookie: `localai_chat_device`, HttpOnly, SameSite=Strict, Path=/api/claude/chat, Max-Age 180 days (15552000 s); store only SHA-256 of the token.
- Pairing code: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, valid 10 minutes, at most 5 pending (then 429).
- Session online when `lastSeenAt` < 45 s ago. Inbox long-poll `wait` ≤ 25 s.
- Message `text` capped at 50,000 characters (set `truncated: true`); keep latest 1,000 messages per session; prune sessions idle 30 days.
- POSTs require `Content-Type: application/json` and, when an `Origin` header is present, an origin matching the `Host` (same rule as `/api/gridcraft/run`).
- Messages render as text (`textContent`), never HTML.
- No new npm dependencies.
- Chat failures never block or slow the terminal: hooks are async, 10 s timeout, swallow every error.

## Review Focus

1. **Two devices or tabs send at once** → every message gets a distinct, increasing `seq` (allocated inside `storage.transaction`). Test in Task 2.
2. **The same session gets two bridges** (SessionStart fires again on resume/clear/compact, or two inbox polls overlap) → each queued message is delivered exactly once. Tests in Tasks 2 and 4.
3. **Stop fires on a turn with no text** (tool-only turn, or a malformed transcript line) → the hook posts nothing and does not raise. Test in Task 3.
4. **Text containing HTML, emoji or 50 kB** → stored verbatim (capped), rendered literally on the page. Tests in Tasks 2 and 6.
5. **Relay restarts or drops mid long-poll** → the bridge backs off and resumes; no message is lost (it stays `queued`). Test in Task 4.

---

### Task 1: Spike — DONE

Findings are in the spec ("Spike findings"). Remaining step: write them into `docs/CLAUDE-CHAT.md` as part of Task 7.

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

### Task 3: Hook (opt-in, mirror, bridge start)

**Files:**
- Create: `host/claude-chat/hook.py`
- Test: `tests/claude-chat-hook.test.cjs` (runs the hook with `python3 -I` against a fake relay `http.createServer`, fixture transcripts in a temp dir, a temp `LOCALAI_CHAT_HOME`, and `LOCALAI_CHAT_BRIDGE_CMD` pointing at a stub script that records its argv)

**Interfaces:**
- Consumes: Task 2 `POST /api/claude/chat/mirror`; `mac.key` in `${LOCALAI_CHAT_HOME:-~/.claude/localai-chat}`.
- Produces: on `SessionStart` with `LOCALAI_CHAT=1`, spawns `${LOCALAI_CHAT_BRIDGE_CMD:-node ~/.claude/localai-chat/bridge.mjs} <sessionId> <title> <cwd>` detached (new session, stdio to `/dev/null`), inheriting the environment. `title` = `<cwd basename> · <first 8 chars of session_id>`.

- [ ] **Step 1: Write failing tests:**
  - `without LOCALAI_CHAT=1 nothing happens on any event` (no HTTP request, stub bridge not run).
  - `SessionStart starts the bridge with sessionId, title and cwd`.
  - `UserPromptSubmit posts {role:'user', source:'terminal', text: prompt}`.
  - `a prompt starting with "[LocalAI web · " is not posted`.
  - `Stop posts the assistant text after the last user entry`, joining text blocks with blank lines and ignoring `tool_use` blocks.
  - `Stop with a tool-only turn or a malformed transcript line posts nothing and exits 0` (Review Focus 3).
  - `relay down → exit 0 within 10 s`.
- [ ] **Step 2: Run** `node --test tests/claude-chat-hook.test.cjs` — expected: FAIL.
- [ ] **Step 3: Implement `hook.py`** (stdlib only; same never-raise structure as `~/.claude/hooks/localai-progress.py`; detach with `subprocess.Popen(..., start_new_session=True)`).
- [ ] **Step 4: Run** the test file — expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Claude chat: hook for opted-in sessions (mirror, start bridge)"`

---

### Task 4: Bridge

**Files:**
- Create: `host/claude-chat/bridge.mjs`
- Test: `tests/claude-chat-bridge.test.cjs` (spawns the bridge with a fake relay, a fake inbox `net.createServer` on a temp Unix socket path passed as `CLAUDE_CODE_MESSAGING_SOCKET`, a token in `CLAUDE_CODE_MESSAGING_TOKEN`, and a temp `LOCALAI_CHAT_HOME`)

**Interfaces:**
- Consumes: Task 2 `announce` and `inbox` (items `{id, seq, text, deviceName}`); argv `<sessionId> <title> <cwd>`.
- Produces: pidfile `run/<sessionId>.pid`; log `bridge.log`; the injection lines from Global Constraints.

- [ ] **Step 1: Write failing tests:**
  - `announces the session, then injects each queued message as auth line + user line with the [LocalAI web · <device>] prefix` (assert the exact JSON of both lines).
  - `one message per connection, at least 1 s apart` (test sets `LOCALAI_CHAT_INJECT_GAP_MS=50` and asserts the configured gap).
  - `a second bridge for the same session exits at once while the first is alive` (Review Focus 2).
  - `exits and removes its pidfile when the socket path disappears`.
  - `relay returns 500 twice, then recovers: the queued message is still injected` (Review Focus 5); `LOCALAI_CHAT_BACKOFF_MS=50`.
  - `an injection that fails while the socket exists is retried (3 tries) and then logged as lost`.
- [ ] **Step 2: Run** `node --test tests/claude-chat-bridge.test.cjs` — expected: FAIL.
- [ ] **Step 3: Implement `bridge.mjs`** (no stdout use needed; log to `bridge.log`; record the time of the last successful injection in `run/<sessionId>.last` for `localai-chat status`).
- [ ] **Step 4: Run** the test file and `npm test` — expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Claude chat: bridge that injects web messages into the session inbox"`

---

### Task 5: Pairing, devices, Mac CLI and installer

**Files:**
- Modify: `app/claude-chat.js` (replace `deviceFor` with cookie auth; add pairing and device endpoints)
- Create: `host/claude-chat/localai-chat` (POSIX sh wrapper → `node host/claude-chat/cli.mjs`), `host/claude-chat/cli.mjs`, `host/claude-chat/install.sh`
- Test: extend `tests/claude-chat.test.cjs`; add `tests/claude-chat-cli.test.cjs`

**Interfaces:**
- Produces (HTTP): `POST /api/claude/chat/pair-request` → `201 {id, code, expiresAt}` (429 when 5 pending); `GET /api/claude/chat/pair-status?id=` → `{status:'pending'|'approved'|'expired'}` and, once, `Set-Cookie` on approval; `POST /api/claude/chat/pair/approve {code, name}` (Mac key) → `{deviceId}`; `GET /api/claude/chat/devices` and `POST /api/claude/chat/devices/revoke {id}` (Mac key **or** device cookie).
- Produces (CLI): `localai-chat pair <code> [name]`, `localai-chat devices`, `localai-chat revoke <id>`, `localai-chat status` (key present, relay reachable, key accepted, running bridges and their last successful injection).
- Produces (installer): copies `bridge.mjs`, `cli.mjs`, `hook.py` to `~/.claude/localai-chat/`; creates `mac.key` if missing; writes the hash on the appliance (`ssh windows docker exec -i local-ai-appliance sh -c 'cat > /data/claude-chat-mac-key.sha256'`); adds hook entries (SessionStart, UserPromptSubmit, Stop → `/opt/homebrew/bin/python3 -I ~/.claude/localai-chat/hook.py`; async, 10 s) to `~/.claude/settings.json` after backing it up, without touching the existing progress hook; appends a `claude-chat` function (`LOCALAI_CHAT=1 claude "$@"`) to `~/.zshrc`; prints next steps. Re-running it is safe (idempotent).

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
  - `the composer shows the note that web messages arrive as messages from another session`.
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
- Create: `docs/CLAUDE-CHAT.md` (how it works incl. the spike findings from the spec, setup, daily use, pairing, revoking, security notes incl. plain HTTP and the another-session framing, troubleshooting with `localai-chat status` and `bridge.log`)

- [ ] **Step 1:** Write the docs. Open a PR from `feature/claude-chat`; wait for CI green and review comments; address them.
- [ ] **Step 2:** Merge; on the host `git pull` + `deploy\Deploy-LocalAI.ps1`; confirm `GET /healthz` reports the merge commit.
- [ ] **Step 3:** On the Mac run `host/claude-chat/install.sh`; `localai-chat status` → key accepted.
- [ ] **Step 4 (with the user):** `claude-chat --resume <session>`; pair the phone; send "what time is it?" from the page → reply appears on the page; type in the terminal → both turns appear on the page; revoke the phone → page returns to pairing.
- [ ] **Step 5:** Run every browser suite against the appliance (`LOCALAI_URL=http://10.0.0.21:3080 npm run test:browser`); post the result to the Claude board and mark the finding fixed.
