# Claude chat

The **Claude Code** page of LocalAI (Build › Changes) can talk to a Claude Code session that is already running in a terminal on your Mac, from a phone or any browser on the LAN, and shows that session's whole conversation (terminal prompts, web messages, replies).

Related: [Security](SECURITY.md), [Architecture](ARCHITECTURE.md), and the [design record](superpowers/specs/2026-10-15-claude-chat-design.md).

It is a second window onto a session you started yourself. It is **not** a runner: nothing on the appliance starts, resumes or stops Claude Code, and the session keeps its own permission mode. Sessions started with plain `claude` are never visible to it; the existing progress board is unchanged.

## How it works

```text
 phone / browser --(paired-device cookie)--> LocalAI appliance (https://10.0.0.21, or :3080)
                                               chat relay: messages, sessions, devices
                                                   ^                    ^
        long-poll inbox (Mac key, HTTPS) ----+                    +---- mirror posts (Mac key, HTTPS)
                                                   |                    |
 Mac:  claude-chat  (= LOCALAI_CHAT=1 claude ...)
         |-- SessionStart hook ---- starts --> bridge (one per session; writes to the session's inbox socket)
         '-- mirror hook (UserPromptSubmit, Stop)
```

- **Opt-in.** `claude-chat` is a shell function, `LOCALAI_CHAT=1 claude "$@"`. Hooks inherit the variable and do nothing without it.
- **Hook** (`~/.claude/localai-chat/hook.py`, async, 10 s timeout, swallows every error). `SessionStart` starts the bridge. `UserPromptSubmit` posts your terminal prompt to the relay. `Stop` posts Claude's reply text: the hook input's `last_assistant_message` (the transcript is written asynchronously and can lag behind the turn's final text), or, if Claude Code does not send it, the text read from the transcript.
- **Bridge** (`~/.claude/localai-chat/bridge.mjs`, one per session, detached). Announces the session, long-polls the relay's inbox, acknowledges what it received, and injects each acknowledged web message into the session. The inbox only reserves (leases) the messages it returns; the bridge's ack marks them delivered just before it injects them. If the inbox response or the ack never arrives (the Mac sleeps mid-poll, the connection drops), the reservation runs out after 60 s and the message is queued again for the next poll: it arrives late rather than never, and a message that was not acknowledged is never injected, so it is never injected twice. Only one bridge runs per session and per Claude Code process: it keeps a pidfile `run/<sessionId>.pid` and a per-socket lock `run/sock-<hash>.json` in `~/.claude/localai-chat/`. `/clear` starts a new session id in the same process, so the new bridge stops the old one, and the cleared conversation goes offline on the page after 45 s. It exits when the session's socket disappears.
- **Relay connection** (`~/.claude/localai-chat/relay.mjs` for the bridge and CLI, built into `hook.py`). The URL is `LOCALAI_URL`, else `url` in `~/.claude/localai-chat/config.json` (written by the installer), else `http://10.0.0.21:3080`. For `https://` URLs the certificate is verified against the CA named by `ca` in `config.json` (Node: the `ca` option of `node:https`; Python: `ssl.create_default_context(cafile=...)`); proxies are ignored and verification is never turned off.
- **Relay** (`app/claude-chat.js` in the appliance). Stores sessions, messages, devices and pairing requests; authenticates the Mac (key) and devices (cookie). Nothing on the Mac listens on the network; the appliance is the only rendezvous point.
- **Panel** (Claude Code page, `claude-chat` section of `app/public/ui.js`). Pairing, session picker, conversation, composer, devices.

### Injection: spike findings (Claude Code 2.1.300, macOS)

Each Claude Code session binds a Unix inbox socket and exports `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` to hooks and Bash. The bridge writes two lines to it: an auth line with the token, then a `user` message line, prefixed `[LocalAI web · <device name>] `.

- The message format is **undocumented**: it comes from Claude Code's own diagnostics. The socket and token are documented. This is the main maintenance risk (see Troubleshooting).
- Claude sees web messages as "Another Claude session sent a message". It acts within the session's own permissions, will not change permissions, `CLAUDE.md` or config because of one, and cannot answer a permission prompt.
- A message from the session's own child process (the bridge, with the token) is delivered even in bypass-permissions mode. An idle session starts a turn; a busy one reads it between tool calls.
- `UserPromptSubmit` also fires for injected messages, so the hook skips prompts starting with `[LocalAI web · ` (the relay already has them).
- The inbox drops messages past a burst limit and queues at most 50; the bridge injects at most one message per second.

Channels were the first design. They are disabled for the Claude Team org (`channelsEnabled`), hence the inbox socket.

## Setup

On the Mac, from the repo checkout (needs `ssh windows-ai` to work, Node 22+, Python 3 at `/opt/homebrew/bin/python3`, `openssl` and `curl`, both standard on macOS):

```sh
host/claude-chat/install.sh
source ~/.zshrc
localai-chat status
```

The installer is safe to re-run. It:

1. Copies `bridge.mjs`, `cli.mjs`, `relay.mjs`, `hook.py` and `localai-chat` to `~/.claude/localai-chat/` and symlinks `localai-chat` into `~/.local/bin` (it tells you if that directory does not exist).
2. Creates the Mac key, 32 random bytes as hex, at `~/.claude/localai-chat/mac.key` (mode 600), unless one already exists.
3. Pushes the key's SHA-256 to the appliance over `ssh windows-ai docker exec -i local-ai-appliance tee /data/claude-chat-mac-key.sha256`.
4. Chooses the relay URL. It fetches the LocalAI CA certificate over ssh (`ssh windows-ai type C:\LocalAI\https\localai-ca.crt`, exported there by `deploy/Install-LocalAI-HTTPS.ps1`), checks it is a PEM certificate (`openssl x509`), saves it as `~/.claude/localai-chat/localai-ca.crt`, and checks `https://10.0.0.21/healthz` with it. If that works, `~/.claude/localai-chat/config.json` gets `{"url": "https://10.0.0.21", "ca": ".../localai-ca.crt"}`. If it cannot get a valid CA or reach HTTPS on a fresh install, it prints a warning and writes `http://10.0.0.21:3080` instead; fix the cause and re-run. If `config.json` already uses HTTPS, it never downgrades: it prints an error, leaves `config.json` and the CA file as they were, and exits non-zero. Pass `--allow-http` to switch to plain HTTP deliberately. Only the PEM block of the ssh output is kept, so ssh banners do not matter. (`LOCALAI_HTTPS_URL` changes the HTTPS address it tries.)
5. Backs up `~/.claude/settings.json` to `settings.json.bak-localai-chat-<timestamp>` and adds `SessionStart`, `UserPromptSubmit` and `Stop` hook entries (`/opt/homebrew/bin/python3 -I ~/.claude/localai-chat/hook.py`, async, 10 s), skipping any already present.
6. Adds a marked block to `~/.zshrc` defining `claude-chat`.

The installer ends with `Relay: https://10.0.0.21 (HTTPS, verified with the LocalAI CA)` or `Relay: http://10.0.0.21:3080 (plain HTTP)`. `localai-chat status` should show the key present, the relay reachable (with the `https://` URL and the CA path) and the key `accepted`. Until the key hash is on the appliance, the feature is inert.

**Switching an existing install to HTTPS:** re-run `host/claude-chat/install.sh` (it keeps your key), check its `Relay:` line, then restart or resume your `claude-chat` sessions so new bridges read `config.json`. Running bridges keep the URL they started with. Because the key may have crossed plain HTTP before, consider [rotating it](#security-notes).

## Daily use

- Start or resume a session with chat on: `claude-chat` or `claude-chat --resume <id>`. It then appears on the Claude Code page. Start the session with plain `claude` and it stays invisible.
- **Pair a phone** (once per device): open the Claude Code page; an unpaired device shows a 6-character code (valid 10 minutes) and the command to run. Then, on the Mac, run `localai-chat pair <code> "My iPhone"`. The page picks it up and stays paired for 180 days.
- **Send**: pick a session, type, press Send (Cmd/Ctrl+Enter also sends; Enter is a newline). The reply appears when Claude finishes its turn; there is no partial streaming. Replies are shown as plain text.
- **Statuses** under a web message: `queued` (relay has it, bridge has not fetched it), `sending` (the bridge fetched it and is acknowledging it; normally a second or two), `delivered` (acknowledged and injected into the session), `answered` (Claude replied after it; one reply answers every earlier delivered message). A message reserved by a bridge that vanished before acknowledging it returns to `queued` after 60 s and is sent again. A queued or `sending` message on a session that has gone offline shows `not delivered` with a Delete button; a `sending` one can be deleted once its 60 s reservation has run out (until then the page says to try again in a moment). A message still `delivered` after 10 minutes is no longer polled for; it keeps that status until a later reply.
- **Offline**: a session is online while its bridge has polled in the last 45 s. When offline the composer is disabled ("Start or resume it on your Mac with `claude-chat`"); history stays readable and messages are never accepted for later.
- **The terminal keeps working** as normal. Typing there is mirrored to the page, and both sides' turns appear in the conversation. If the appliance is unreachable, hooks drop silently and the bridge retries with backoff (1 s up to 30 s); the terminal is unaffected.

## Managing devices

On the page, expand **Paired devices** (below the composer) to see each paired device with last-seen and **Revoke** (any paired device may revoke any device, including itself). From the Mac:

```sh
localai-chat devices
localai-chat revoke <id>
```

Revoking takes effect immediately; the device's next request gets 401 and its page returns to the pairing screen.

## Security notes

- Nothing listens on the Mac. The bridge and hooks only make outbound HTTP(S) calls to the appliance and talk to the session's own local socket.
- The Mac key lives at `~/.claude/localai-chat/mac.key` (mode 600). Only its SHA-256 is on the appliance, at `/data/claude-chat-mac-key.sha256`, and no network endpoint can set or change it; only the installer can, over ssh.
- The device cookie `localai_chat_device` is HttpOnly, SameSite=Strict, Path=`/api/claude/chat`, 180 days. The appliance stores only its hash.
- **HTTP and HTTPS.** Port 3080 is plain HTTP. A device that uses the app over `http://` sends its cookie across the Wi-Fi unencrypted; anyone who sniffs it can send messages until the device is revoked. Use the HTTPS address ([Deploy › HTTPS](DEPLOY.md#https-with-caddy)) on phones. A device that pairs over HTTPS gets a `Secure` cookie, which its browser never sends to the `http://` address; one paired over `http://` (or before this change) has no `Secure` flag, so re-pair it on the HTTPS address.
- **The Mac key** travels in the `X-LocalAI-Mac-Key` header of every bridge long-poll (up to 25 s each) and every hook call. With the installer's HTTPS config it is encrypted and only sent to a server whose certificate chains to the LocalAI CA. On the plain-HTTP fallback (installer warning, a Mac installed before HTTPS support, or `LOCALAI_URL=http://...`) it crosses the Wi-Fi in clear. Whoever has it can do everything the Mac can: approve pairing codes (and so pair their own devices), post fake terminal prompts and replies, announce fake sessions, and read web messages from the inbox. It cannot be revoked from the page, and re-running the installer **reuses** the existing key. If the key may have been exposed (for example it was used over HTTP before), rotate it:
  1. `rm ~/.claude/localai-chat/mac.key`
  2. Re-run `host/claude-chat/install.sh`. It creates a new key and pushes its hash to the appliance; the old key is rejected from then on.
  3. Restart (or resume) your `claude-chat` sessions so their bridges read the new key; running bridges keep the old one and log `mac key rejected`.
  4. Review **Paired devices** (or `localai-chat devices`) and revoke any device you do not recognise.
- Web messages act with **the session's own permissions**. A session in bypass-permissions mode will act on a web message without prompts. They cannot change settings or approve a permission prompt.
- Known limitation: anyone on the LAN can request pairing codes and hold the (up to 5) pending slots, delaying your own pairing. They cannot approve one without the Mac key.

## Configuration

Mac side, read from the environment of the Claude Code session (hooks and bridge) or your shell (CLI):

| Variable | Default | Used by |
|---|---|---|
| `LOCALAI_CHAT` | unset | Hook: does nothing unless `1` (set by `claude-chat`) |
| `LOCALAI_URL` | `url` in `~/.claude/localai-chat/config.json`, else `http://10.0.0.21:3080` | Hook, bridge, CLI. Overrides `config.json`; an `https://` URL is still verified with the `ca` from `config.json` |
| `LOCALAI_HTTPS_URL` | `https://10.0.0.21` | Installer: the HTTPS address it tries and writes to `config.json` |
| `LOCALAI_CHAT_HOME` | `~/.claude/localai-chat` | Hook, bridge, CLI |
| `LOCALAI_CHAT_BRIDGE_CMD` | `node ~/.claude/localai-chat/bridge.mjs` | Hook (tests) |
| `LOCALAI_CHAT_INJECT_GAP_MS` | `1000` | Bridge: gap between injections |
| `LOCALAI_CHAT_BACKOFF_MS` | `1000` | Bridge: first retry delay (doubles to 30 s) |
| `LOCALAI_CHAT_WRITE_TIMEOUT_MS` | `5000` | Bridge: socket write timeout |

Appliance side (`app/claude-chat.js`): `LOCALAI_CHAT_ONLINE_MS` (45 s), `LOCALAI_CHAT_LEASE_MS` (60 s) and
`LOCALAI_CHAT_PAIR_TTL_MS` (10 minutes).

## Troubleshooting

Start with `localai-chat status`. It prints the key state, relay reachability, whether the relay accepts the key, and each running bridge with its last successful injection.

`~/.claude/localai-chat/bridge.log` lines:

| Line | Meaning |
|---|---|
| `started session <id>` / `announced` | Bridge is up and the relay knows the session |
| `announce failed <status>` | The relay refused the announce (not 401); the bridge backs off and retries |
| `mac key missing; exiting` | No `~/.claude/localai-chat/mac.key`; run the installer |
| `messaging socket/token missing; exiting` | The session did not export `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN` (Claude Code too old, or the hook ran outside a session) |
| `missing session id` | The hook started the bridge without a session id (should not happen; check the hook entries) |
| `replacing bridge <pid> for session <id> on this socket` | `/clear` (or a resume) started a new session in the same Claude Code process; the old bridge is stopped |
| `SIGTERM` | This bridge was stopped, normally by the bridge that replaced it |
| `socket lock busy; exiting` | Could not take the per-socket lock after repeated tries; restart the session |
| `received <n>` | Inbox call returned n web messages |
| `acked <n>/<m>` | The relay confirmed n of the m received messages; only those are injected |
| `ack missing <id>` | The relay did not confirm this message (ack failed, or its 60 s reservation had already run out); it is not injected now and is sent again on a later poll |
| `ack failed <status>` / `ack error ...` | The ack call failed; every message from that poll is skipped and normally re-sent after 60 s. If the relay had already recorded the ack and only its response was lost (timeout, dropped connection), the message shows `delivered` without ever having been injected and is not re-sent: the cost of never injecting a message twice |
| `injected <id>` | Message written to the session's socket |
| `inject failed <id> attempt <n> ...` | A write failed; it retries up to 3 times |
| `lost <id>` | All tries failed; the message was acknowledged (marked delivered) but never reached Claude |
| `socket gone; exiting` / `socket unreachable; exiting` | The session ended; the bridge stops |
| `mac key rejected` | Relay 401; re-run the installer to push the key hash again |
| `relay error tls <code>: the certificate of <url> is not trusted (CA: <path>)` | HTTPS certificate check failed: the CA file is not the appliance's (Caddy's CA was recreated), none is configured, or the URL's host is not in the certificate. Nothing was sent. Re-run the installer |
| `relay error config.json unreadable: <path> (...)` | `~/.claude/localai-chat/config.json` exists but is not valid JSON (or not an object). Nothing is sent (no fallback to plain HTTP) until it is fixed; re-run the installer. The hook logs the same line to `hook.log`, and `localai-chat` refuses with it |
| `relay error CA file unreadable: <path>` | `config.json` names a CA file that is missing or not a certificate; re-run the installer |
| `relay error ...` / `inbox failed <status>` | Appliance unreachable or erroring; the bridge backs off and retries |

Common problems:

- **Session not listed.** It must be started or resumed with `claude-chat` (not `claude`). The bridge starts on `SessionStart` and announces itself; check `localai-chat status` for a bridge and `bridge.log` for `announced`. `mac key missing; exiting` means the installer has not run (or the key was removed); `messaging socket/token missing; exiting` means this Claude Code session does not expose the inbox socket. Resuming or restarting the session retries the announce.
- **Message stays `sending`, or goes back to `queued`.** The bridge fetched it but its acknowledgement did not reach the appliance (Mac asleep, network drop). After 60 s it is queued again and the next poll sends it; look for `ack missing` or `ack failed` in `bridge.log`. If it keeps happening, check the appliance is reachable (`localai-chat status`).
- **Message `delivered` but Claude does nothing.** Claude Code may be holding it behind an approval dialog in the terminal (the own-child check failed). Look at the terminal and answer the dialog.
- **Injected lines in the log but messages stop arriving, or `lost` appears.** A Claude Code update may have changed the undocumented inbox format. This is the main maintenance risk; compare `last injection` in `status` with the Claude Code version and adjust `bridge.mjs`.
- **Certificate errors** (`relay error tls ...` in `bridge.log`, the same line in `~/.claude/localai-chat/hook.log`, `Relay: certificate not trusted` in `localai-chat status`). The Mac does not trust the server it reached. Usually Caddy's CA changed (its `localai-caddy-data` volume was recreated) or `LOCALAI_URL` points at a name the certificate does not cover (`https://10.0.0.21` and `https://localai.home.arpa` are covered). Re-run `host/claude-chat/install.sh` to fetch the current CA, then restart the sessions. Check by hand with `curl --cacert ~/.claude/localai-chat/localai-ca.crt https://10.0.0.21/healthz`. Never work around it by disabling verification; to go back to plain HTTP temporarily, set `LOCALAI_URL=http://10.0.0.21:3080` (the key then crosses the Wi-Fi in clear).
- **Installer exits with `config.json uses HTTPS ... left unchanged`.** HTTPS worked before but the CA fetch or the HTTPS check failed now. Your existing HTTPS setup is untouched and keeps working if the appliance is fine. Fix the cause and re-run, or run `install.sh --allow-http` to switch to plain HTTP on purpose.
- **Re-pairing a phone over `http://` does nothing.** Once a browser holds the `Secure` cookie from pairing on `https://10.0.0.21`, a later pairing on `http://10.0.0.21:3080` looks approved but the page stays unpaired: browsers refuse to overwrite a `Secure` cookie from an insecure origin. Pair over HTTPS.
- **Installer says it kept plain HTTP.** `could not get a valid LocalAI CA certificate over ssh`: run `deploy/Install-LocalAI-HTTPS.ps1` on the host (it exports `C:\LocalAI\https\localai-ca.crt`) and check `ssh windows-ai type C:\LocalAI\https\localai-ca.crt` prints a certificate. `HTTPS at ... is not reachable or not trusted`: check `local-ai-https` is running on the host and port 443 is open on the private network.
- **`mac key rejected` or key `rejected` in status.** Re-run `host/claude-chat/install.sh`; it reuses the same key and re-pushes the hash (to replace the key, see the rotation steps under Security notes). Check `ssh windows-ai` works if the push fails.
- **Re-running the installer** is always safe: files are overwritten, hooks and the `.zshrc` block are not duplicated, a new settings backup is made.

## Uninstall

1. In `~/.claude/settings.json`, remove the three hook entries that run `hook.py` (or restore a `settings.json.bak-localai-chat-*` backup, which loses later settings changes).
2. Delete the `# >>> localai-chat >>>` ... `# <<< localai-chat <<<` block from `~/.zshrc`.
3. Remove `~/.claude/localai-chat` (key, CA copy, `config.json`, logs) and the `~/.local/bin/localai-chat` symlink. Stop running bridges first (`pkill -f localai-chat/bridge.mjs`), or let them exit with their sessions.
4. Remove the appliance's key file, which makes the Mac side inert:

   ```sh
   ssh windows-ai docker exec local-ai-appliance rm /data/claude-chat-mac-key.sha256
   ```
