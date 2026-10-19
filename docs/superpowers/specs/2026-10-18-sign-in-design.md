# Sign-in for every page and API

Date: 2026-10-18. Status: proposed (for the owner's approval). From the Docker review: "No user authentication on port
443" in `docs/SECURITY.md` › Known gaps.

## Why

Anyone who can reach `https://10.0.0.21` (the home Wi-Fi, or the tailnet) can read every conversation and project,
start runs, write files under `WORKSPACE_ROOT` and run `node`/`npm`/`npx` in the container. The cross-site guard only
stops other websites from using a browser that is already here. Port 3080 is now host-only (#328), so HTTPS through
Caddy is the one way in, and it is the one place a sign-in check has to go.

## What exists to build on

Claude chat already pairs devices (`app/claude-chat.js`): a phone asks for a 6-character code (10 minutes, at most 5
pending), the Mac approves it (`localai-chat pair <code>`), and the phone gets an HttpOnly device cookie (180 days,
`Secure` over HTTPS) whose hash is stored. Devices can be listed and revoked. Today that cookie only covers
`/api/claude/chat`.

## Decisions (each is a recommendation)

- **A1 One device sign-in for everything.** The chat device becomes *the* device: the cookie's path widens to `/`, and
  the router checks it before any route except the ones below. A phone paired for chat today needs nothing redone: its
  old cookie still reaches `/api/claude/chat`, so before showing the pairing screen the app calls a chat route once,
  and the appliance re-issues the cookie for `/`.
- **A2 What stays open without a device:** `/healthz` (Caddy, Safe Deploy, monitoring), the app shell and its static
  files (so the pairing screen can show), `/api/claude/chat/pair-request` and `pair-status`, and Caddy's
  `/localai-ca.crt`. An API call without a device gets `401 {"error":"Sign in on this device first","signIn":true}`;
  the app shows the pairing screen instead of the page.
- **A3 Who can approve a new device:** the Mac (as today), **any signed-in device** (System › Devices › "Approve a
  code"), or the PC itself. Owner-only, so any approved device may approve; the Inbox records every approval and
  sign-in from a new device.
- **A4 The PC is trusted directly.** A request that did not come through Caddy (no `X-Forwarded-For`) reached port 3080
  on the host's loopback or the Docker network, so it needs no device: host scripts, Safe Deploy, backups, the
  PowerShell runner. Recovery when every device is lost: open `http://127.0.0.1:3080` on the PC and approve a code. The
  catch: other containers on the shared network (n8n, search, the model proxy) also count as direct. The sandbox is
  already off that network (#329); n8n is the remaining risk and is noted under Known gaps.
- **A5 The Mac and Claude Code sign in with the Mac key** (`X-LocalAI-Mac-Key`, already held by the chat hook and
  bridge). The board progress hook and the board instructions in `CLAUDE.md` send it too.
- **A6 Cookie:** `SameSite=Lax` (Strict would drop it when a push notification or another app opens a link), HttpOnly,
  Secure, 180 days, renewed on use. Revoking a device signs it out at once.
- **A7 Rollout in two PRs.** First *report only*: every request that would be refused is counted and listed on
  System › Devices ("3 requests from 10.0.0.37 without a device, last at 14:02"), nothing is blocked. After a few days
  with only expected callers, `LOCALAI_SIGN_IN=required` in `stack.env` turns it on; removing the line turns it off.

## Not in this work

Passwords or accounts (one owner, devices only), per-device permissions, signing in the Workshop display (the appliance
calls it, never the other way round).

## Risks

- Locking yourself out: A4 (the PC is always trusted) and A7 (report-only first, then a one-line switch).
- A caller nobody remembered (a shortcut, an Apple Watch complication, a script on another machine): report-only mode
  lists them before anything is refused.
- The PWA on the phone keeps working: it runs on `https://10.0.0.21` and already holds the chat cookie, which A1 widens.
