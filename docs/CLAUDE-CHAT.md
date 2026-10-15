# Claude page chat

The **Claude** page of LocalAI can talk to a Claude Code session that is already running in a terminal on your Mac, from a phone or any browser on the LAN, and shows that session's whole conversation (terminal prompts, web messages, replies).

It is a second window onto a session you started yourself. It is **not** a runner: nothing on the appliance starts, resumes or stops Claude Code, and the session keeps its own permission mode. Sessions started with plain `claude` are never visible to it; the existing progress board is unchanged.

## How it works

```text
 phone / browser --(paired-device cookie)--> LocalAI appliance (10.0.0.21:3080)
                                               chat relay: messages, sessions, devices
                                                   ^                    ^
                     long-poll inbox (Mac key) ----+                    +---- mirror posts (Mac key)
                                                   |                    |
 Mac:  claude-chat  (= LOCALAI_CHAT=1 claude ...)
         |-- SessionStart hook ---- starts --> bridge (one per session; writes to the session's inbox socket)
         '-- mirror hook (UserPromptSubmit, Stop)
```

- **Opt-in.** `claude-chat` is a shell function, `LOCALAI_CHAT=1 claude "$@"`. Hooks inherit the variable and do nothing without it.
- **Hook** (`~/.claude/localai-chat/hook.py`, async, 10 s timeout, swallows every error). `SessionStart` starts the bridge. `UserPromptSubmit` posts your terminal prompt to the relay. `Stop` posts Claude's reply text from the transcript.
- **Bridge** (`~/.claude/localai-chat/bridge.mjs`, one per session, detached). Announces the session, long-polls the relay's inbox, and injects each web message into the session. Only one bridge runs per session (pidfile in `~/.claude/localai-chat/run/`). It exits when the session's socket disappears.
- **Relay** (`app/claude-chat.js` in the appliance). Stores sessions, messages, devices and pairing requests; authenticates the Mac (key) and devices (cookie). Nothing on the Mac listens on the network; the appliance is the only rendezvous point.
- **Panel** (Claude page). Pairing, session picker, conversation, composer, devices.

### Injection: spike findings (Claude Code 2.1.300, macOS)

Each Claude Code session binds a Unix inbox socket and exports `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` to hooks and Bash. The bridge writes two lines to it: an auth line with the token, then a `user` message line, prefixed `[LocalAI web · <device name>] `.

- The message format is **undocumented**: it comes from Claude Code's own diagnostics. The socket and token are documented. This is the main maintenance risk (see Troubleshooting).
- Claude sees web messages as "Another Claude session sent a message". It acts within the session's own permissions, will not change permissions, `CLAUDE.md` or config because of one, and cannot answer a permission prompt.
- A message from the session's own child process (the bridge, with the token) is delivered even in bypass-permissions mode. An idle session starts a turn; a busy one reads it between tool calls.
- `UserPromptSubmit` also fires for injected messages, so the hook skips prompts starting with `[LocalAI web · ` (the relay already has them).
- The inbox drops messages past a burst limit and queues at most 50; the bridge injects at most one message per second.

Channels were the first design. They are disabled for the Claude Team org (`channelsEnabled`), hence the inbox socket.

## Setup

On the Mac, from the repo checkout (needs `ssh windows-ai` to work, Node 22+, Python 3 at `/opt/homebrew/bin/python3`):

```sh
host/claude-chat/install.sh
source ~/.zshrc
localai-chat status
```

The installer is safe to re-run. It:

1. Copies `bridge.mjs`, `cli.mjs`, `hook.py` and `localai-chat` to `~/.claude/localai-chat/` and symlinks `localai-chat` into `~/.local/bin` (it tells you if that directory does not exist).
2. Creates the Mac key, 32 random bytes as hex, at `~/.claude/localai-chat/mac.key` (mode 600), unless one already exists.
3. Pushes the key's SHA-256 to the appliance over `ssh windows-ai docker exec -i local-ai-appliance tee /data/claude-chat-mac-key.sha256`.
4. Backs up `~/.claude/settings.json` to `settings.json.bak-localai-chat-<timestamp>` and adds `SessionStart`, `UserPromptSubmit` and `Stop` hook entries (`/opt/homebrew/bin/python3 -I ~/.claude/localai-chat/hook.py`, async, 10 s), skipping any already present.
5. Adds a marked block to `~/.zshrc` defining `claude-chat`.

`localai-chat status` should show the key present, the relay reachable and the key `accepted`. Until the key hash is on the appliance, the feature is inert.

## Daily use

- Start or resume a session with chat on: `claude-chat` or `claude-chat --resume <id>`. It then appears on the Claude page. Start the session with plain `claude` and it stays invisible.
- **Pair a phone** (once per device): open the Claude page, choose **Pair this device**, note the 6-character code (valid 10 minutes), then on the Mac run `localai-chat pair <code> "My iPhone"`. The page picks it up and stays paired for 180 days.
- **Send**: pick a session, type, press Send (Cmd/Ctrl+Enter also sends; Enter is a newline). The reply appears when Claude finishes its turn; there is no partial streaming. Replies are shown as plain text.
- **Statuses** under a web message: `queued` (relay has it, bridge has not fetched it), `delivered` (injected into the session), `answered` (Claude replied). A queued message on a session that has gone offline shows `not delivered` and can be deleted.
- **Offline**: a session is online while its bridge has polled in the last 45 s. When offline the composer is disabled ("Start or resume it on your Mac with `claude-chat`"); history stays readable and messages are never accepted for later.
- **The terminal keeps working** as normal. Typing there is mirrored to the page, and both sides' turns appear in the conversation. If the appliance is unreachable, hooks drop silently and the bridge retries with backoff (1 s up to 30 s); the terminal is unaffected.

## Managing devices

From the page, open **Devices** to see each paired device with last-seen and **Revoke** (any paired device may revoke any device, including itself). From the Mac:

```sh
localai-chat devices
localai-chat revoke <id>
```

Revoking takes effect immediately; the device's next request gets 401 and its page returns to the pairing screen.

## Security notes

- Nothing listens on the Mac. The bridge and hooks only make outbound HTTP calls to the appliance and talk to the session's own local socket.
- The Mac key lives at `~/.claude/localai-chat/mac.key` (mode 600). Only its SHA-256 is on the appliance, at `/data/claude-chat-mac-key.sha256`, and no network endpoint can set or change it; only the installer can, over ssh.
- The device cookie `localai_chat_device` is HttpOnly, SameSite=Strict, Path=`/api/claude/chat`, 180 days. The appliance stores only its hash.
- **Plain HTTP.** The appliance serves HTTP, so the cookie crosses the Wi-Fi unencrypted; anyone who sniffs it can send messages until the device is revoked. The pairing screen says so. The board item `prod-https` closes this.
- Web messages act with **the session's own permissions**. A session in bypass-permissions mode will act on a web message without prompts. They cannot change settings or approve a permission prompt.
- Known limitation: anyone on the LAN can request pairing codes and hold the (up to 5) pending slots, delaying your own pairing. They cannot approve one without the Mac key.

## Troubleshooting

Start with `localai-chat status`. It prints the key state, relay reachability, whether the relay accepts the key, and each running bridge with its last successful injection.

`~/.claude/localai-chat/bridge.log` lines:

| Line | Meaning |
|---|---|
| `started session <id>` / `announced` | Bridge is up and the relay knows the session |
| `received <n>` | Inbox call returned n web messages |
| `injected <id>` | Message written to the session's socket |
| `inject failed <id> attempt <n> ...` | A write failed; it retries up to 3 times |
| `lost <id>` | All tries failed; the message was marked delivered but never reached Claude |
| `socket gone; exiting` / `socket unreachable; exiting` | The session ended; the bridge stops |
| `mac key rejected` | Relay 401; re-run the installer to push the key hash again |
| `relay error ...` / `inbox failed <status>` | Appliance unreachable or erroring; the bridge backs off and retries |

Common problems:

- **Session not listed.** It must be started or resumed with `claude-chat` (not `claude`). The bridge starts on `SessionStart` and announces itself; check `localai-chat status` for a bridge and `bridge.log` for `announced`. Resuming or restarting the session retries the announce.
- **Message `delivered` but Claude does nothing.** Claude Code may be holding it behind an approval dialog in the terminal (the own-child check failed). Look at the terminal and answer the dialog.
- **Injected lines in the log but messages stop arriving, or `lost` appears.** A Claude Code update may have changed the undocumented inbox format. This is the main maintenance risk; compare `last injection` in `status` with the Claude Code version and adjust `bridge.mjs`.
- **`mac key rejected` or key `rejected` in status.** Re-run `host/claude-chat/install.sh`; it reuses the same key and re-pushes the hash. Check `ssh windows-ai` works if the push fails.
- **Re-running the installer** is always safe: files are overwritten, hooks and the `.zshrc` block are not duplicated, a new settings backup is made.

## Uninstall

1. In `~/.claude/settings.json`, remove the three hook entries that run `hook.py` (or restore a `settings.json.bak-localai-chat-*` backup, which loses later settings changes).
2. Delete the `# >>> localai-chat >>>` ... `# <<< localai-chat <<<` block from `~/.zshrc`.
3. Remove `~/.claude/localai-chat` and the `~/.local/bin/localai-chat` symlink. Stop running bridges first (`pkill -f localai-chat/bridge.mjs`), or let them exit with their sessions.
4. Remove the appliance's key file, which makes the Mac side inert:

   ```sh
   ssh windows-ai docker exec local-ai-appliance rm /data/claude-chat-mac-key.sha256
   ```
