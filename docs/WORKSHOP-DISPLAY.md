# Workshop display

The Workshop display is the BambuHelper Workshop OS touchscreen beside the Bambu printer (a Waveshare ESP32-S3 3.5"
board; firmware repo `azmusgb/bambuhelper-smart-display`). It shows the printer's state and has its own web page, the
**Local Portal**, with the printer controls (Stop among them).

**System › Services** has a card for it. The card says whether the display is answering (`Online · Waveshare 3.5"`,
`Online · sign-in on` or `Not answering`), and **Open Workshop portal** opens the display's own portal in a new tab.
You sign in there with the code the display shows (System → Local Portal), which changes from time to time. With
the optional code key set up, **Show sign-in code** on the card shows that code on your phone, so you don't have to
walk to the touchscreen ([Sign-in code on the Services card](#sign-in-code-on-the-services-card)); otherwise Local AI
never sees it.

The card's wording follows what the display really answers, so it is right before and after the sign-in update:

| The display's health route | Card |
|---|---|
| answers without a sign-in (firmware of 18 Oct 2026) | `On your network · no sign-in yet` |
| answers `401` (Workshop OS 12.0.1 and later), or the printer-status token works | `On your network · its own sign-in`; the portal asks for the code shown on the display (System → Local Portal) |
| doesn't answer | `Not answering`; the sign-in words stay as last seen |

A `401` means the display is up and protected: the card shows it as online, never offline.

## Address

| | |
|---|---|
| Address | `http://10.0.0.124` (also `http://bambuhelper.local` on devices that resolve `.local` names) |
| Setting | `LOCALAI_WORKSHOP_URL` on the appliance, default `http://10.0.0.124`. Set it in `C:\LocalAI\stack\stack.env`; `deploy/stack/compose.yml` passes it through, and empty means the default |
| Accepted values | An `http://` or `https://` address with no path, on a private IPv4 address (`10.x`, `172.16-31.x`, `192.168.x`) or a `.local` name. Anything else makes the card say `Address not set up`, hides the button, and the appliance logs a warning at start |

**Give the display a DHCP reservation** in the router (its MAC address → `10.0.0.124`). Without one, the router can hand
it another address after a restart, and both the card and the Tailscale route below would point at nothing.

## Away from home

The display is only on the home network. Away from home, the phone reaches it through the Windows computer's
Tailscale connection, which advertises a route to just the display: `10.0.0.124/32`. Approve that route once in the
Tailscale admin console (Machines → the Windows computer → Edit route settings). With Tailscale on, **Open Workshop
portal** works from anywhere; with it off, the portal page won't load. The card's note says so: "Away from home,
Tailscale must be on."

If the reservation ever moves the display to another address, change both `LOCALAI_WORKSHOP_URL` and the advertised
route.

## How it works

```text
Services card --GET /api/workshop/status--> appliance --GET /hardware/health (4 s limit)--> display
appliance poller (only with a token) --GET /api/status/lite, Authorization: Bearer … (every 30 s, 4 s limit)--> display
Show sign-in code --POST /api/workshop/portal-code--> appliance (only with the code key) --GET /api/portal-code, Authorization: Bearer … (4 s limit)--> display
Home --GET /api/workshop/status?part=printer--> appliance (the poller's last read; nothing is sent to the display)
Agent World --GET /api/world--> appliance --GET /hardware/health (at most once a minute, 4 s limit)--> display
Open Workshop portal: a plain link, opened by the browser in a new tab --> http://10.0.0.124/ (the display itself)
```

`GET /api/workshop/status` (`app/workshop.js`) reads the display's `GET /hardware/health` and answers
`{online, board, panel, screen, touchscreenConfigured, signIn, portalUrl, printer}`, rebuilt field by field: Wi-Fi
strength, memory, uptime and printer state are dropped. `signIn` is `false` when the health route answered without a
sign-in, `true` when it answered `401` (then `online` is `true` and the board fields are `null`) or the printer-status
token works, and `null` when the display is offline. `codeAccess` is `true` when the code key is set (the card then
offers **Show sign-in code**); the key itself never leaves the server. Nothing from the browser's request is forwarded. A
display that is off, refuses the connection, sends something that isn't JSON or doesn't answer within 4 s is
`online: false`. The only other `/api/workshop/` route is `POST /api/workshop/portal-code` (below).

Local AI sends the display **only three requests, all `GET`**: `/hardware/health`, with the status token
`/api/status/lite`, and with the code key, only when you tap Show sign-in code, `/api/portal-code`.
It never sends `POST`, never calls a control route, and never sends the portal's `X-BambuHelper-Client` header.

**Agent World** (`GET /api/world`, `app/world.js`) adds no new request. Its kiosk billboard asks `/hardware/health` **at
most once a minute** while Agent World is open: one request at a time, however many tabs poll, and a slow or failing
display is not asked again sooner (the minute counts from when a request starts). Nothing is asked while Agent World is
closed. The printer and the firmware version it shows come from the poller's last `/api/status/lite` read (only the
`firmware.version` field, when it is a short plain version such as `12.1.0`), so they add nothing either. The answer
holds no token and no address. `tests/world.test.cjs` enforces the limit.

## Printer status (read-only token)

With Workshop OS 12.1.0 on the display, Home can show one line while a print runs or has stopped with an error, for
example `Printer · 42% · 1 h 10 min left`, `Printer · Paused · 42%` or `Printer · Stopped with an error (0700_8010)`.
Tapping it opens **System › Services** at the Workshop display card. Home shows nothing while the printer is idle, when
a print was stopped on purpose, when its status is unknown or stale, and when no token is set. The card shows a printer line too (`Printer · Idle`, or why
there's no status).

The display gives Local AI a **read-only status token**. It opens one route, `GET /api/status/lite`, and nothing else:
not the portal, not `/status`, not any control. It answers only the printer's state, progress, time left and error
code; no printer name, job name, IP, serial or camera.

### Set it up (once, after the display has 12.1.0)

1. On a phone or computer at home, open **System › Services › Open Workshop portal** and sign in with the code the
   display shows (System → Local Portal).
2. In the portal, open **More → Read-only status access** and choose **Create access**.
3. The display wakes and asks **"Allow Local AI to read printer status?"**. Tap **Allow** within 60 s.
4. The portal shows the token **once** (it starts with `wsl_`). Copy it. If you don't, choose **Create access** again;
   the old one stops working either way.
5. On the Windows computer, open `C:\LocalAI\stack\stack.env` and set `LOCALAI_WORKSHOP_STATUS_TOKEN=wsl_…`.
   Don't paste the token anywhere else: not in a chat, a note, a screenshot or the repo.
6. Restart the appliance so it reads the new value:
   `docker compose --env-file C:\LocalAI\stack\stack.env -f C:\LocalAI\repo\deploy\stack\compose.yml up -d appliance`.
7. Open **System › Services**. Within 30 s the Workshop display card shows `Printer · Idle` (or the print in progress).

What the card says when it can't read status:

| Card | Meaning | What to do |
|---|---|---|
| `Printer status: the display turned the token down.` | `401`: the token was revoked, replaced or mistyped | Create access again and replace the value in `stack.env` |
| `Printer status: update the display to see it here.` | `404`: the display's firmware is older than 12.1.0 (or it is on its own setup Wi-Fi) | Install the update |
| `Printer status: not answering.` | No answer within 4 s | Check the display is on and on Wi-Fi |

To **rotate** the token, create access again on the display (the old token stops working at once) and replace the
value in `stack.env`, then restart the appliance. To **revoke** it, choose **Revoke** in the portal; then empty the
value in `stack.env`.

### How the appliance uses it

- One poller on the server reads `GET /api/status/lite` every 30 s with `Authorization: Bearer <token>` and a 4 s
  limit. When the display doesn't answer, or turns the token down, it waits longer each time (1, 2, 4, then 5 min), so
  a wrong token never keeps tripping the display's lock-out. One `429` keeps the last answer and tries again in 30 s;
  a second in a row makes the printer `unknown` (`access: busy`). An answer more than 2 minutes old is reported as
  `unknown` (`access: stale`) whatever the polls did, so Home's line goes away rather than show old progress.
  Browser tabs read the poller's last answer and never add requests of their own.
- The answer is rebuilt field by field into `printer: {state, progress, minutesLeft, errorCode, access, seenAt}`:
  `state` is `printing`, `paused`, `error`, `cancelled`, `ended`, `idle` or `unknown` (stale or offline telemetry is `unknown`, so
  old progress is never shown as current). A print you stopped on purpose raises Bambu's cancel code (`0300_400C` "The
  task was canceled." or `0500_400E` "Printing was cancelled."; either spelling, `_` or `-`) and is `cancelled`, not
  `error`, even when the display doesn't flag it as a cancel: Home shows nothing and the card says `Printer · Print
  stopped`. A failed print with no code at all (the display restarted and lost it, say) could be either, so it is
  `ended`: Home shows nothing and the card says `Printer · Print ended — check the display`. Any other code is still an
  error; `access` is `ok`, `refused` (401), `unsupported` (404), `busy` (429), `offline` or `stale`. `printer` is `null` when no token is set.
- The token stays on the server. It is never sent to the browser, never logged, never put in an error message or an
  answer, never stored in the data folder, and child processes don't get it (`childEnv` drops every `*TOKEN*`
  variable). Tests check each of these against a fake display.
- It is only sent to the address in `LOCALAI_WORKSHOP_URL` (a private address or a `.local` name); with any other
  value the poller doesn't start.

The link opens as a top-level page with `rel="noopener noreferrer"`, so an `http://` address works from the
`https://` app and the portal can't reach back into Local AI.

## Sign-in code on the Services card

The portal's sign-in code is shown on the display (System → Local Portal) and changes from time to time. With firmware
that has the **code key** (`wsc_…`), the Workshop display card can show it: tap **Show sign-in code**, and the code
appears large in two groups of five (`ABCDE FGHJK`) with **Copy** and **Open portal ↗**. It hides itself after 60 s,
when the page goes to the background, or when you leave Services; tap again for a fresh read. Without the key, the card
shows one muted line instead: "To show the sign-in code here, add code access in the display's portal (More → Sign-in
code access)".

### Set it up (once)

1. On a phone or computer at home, open **System › Services › Open Workshop portal** and sign in with the code the
   display shows.
2. In the portal, open **More → Sign-in code access** and create access. Confirm on the display if it asks.
3. The portal shows the key **once** (it starts with `wsc_`). Copy it.
4. On the Windows computer, set `LOCALAI_WORKSHOP_CODE_TOKEN=wsc_…` in `C:\LocalAI\stack\stack.env`. Don't paste the
   key anywhere else: not in a chat, a note, a screenshot or the repo.
5. Restart the appliance:
   `docker compose --env-file C:\LocalAI\stack\stack.env -f C:\LocalAI\repo\deploy\stack\compose.yml up -d appliance`.
6. Open **System › Services**: the card has **Show sign-in code**.

### Revoke or replace it

- **Revoke:** in the portal, More → Sign-in code access → Revoke. The key stops working at once (the card then says
  "The display turned the key down"). Empty `LOCALAI_WORKSHOP_CODE_TOKEN` in `stack.env` and restart the appliance so
  the button goes away.
- **Replace:** create access again (the old key stops working), put the new key in `stack.env`, restart.

What the card says when it can't show the code:

| Card | Meaning | What to do |
|---|---|---|
| `Sign-in code access isn't set up…` | No key in `stack.env` | Set it up (above) |
| `The display turned the key down: it was revoked or replaced…` | `401` | Create access again and replace the value in `stack.env` |
| `The display's firmware can't share its sign-in code yet…` | `404`: firmware without the route | Install the update |
| `The display is busy. Try again in a few minutes.` | `429`: the display's rate limit | Wait, then tap again |
| `The display isn't answering.` | No answer within 4 s, or an odd answer | Check the display is on and on Wi-Fi |

### How the appliance uses it

- `POST /api/workshop/portal-code` (POST, so a prefetch or a link can't trigger it) with the same checks as every other
  change in Local AI: a browser request from another site is refused (`403`), and the body must be JSON (`415`).
- Requests are limited before they reach the display, which counts wrong keys toward its sign-in lock-out: one at a
  time (taps that arrive together share one answer), at most one every 5 s (inside that window the last answer is
  served again from memory, then dropped), and none for 2 minutes after a `429` or 5 minutes after a `401` (the
  answer then carries `Retry-After`).
- Otherwise it sends the display one `GET /api/portal-code` with `Authorization: Bearer <code key>` and a 4 s limit,
  and answers `{code, address}` with `Cache-Control: no-store`, or `{reason, error}` (`409` not set up, `502` refused or
  old firmware, `503` busy, `504` offline). Only a code of 10 letters or digits is passed on; nothing else from the
  display's answer is.
- Nothing is cached beyond those 5 s in memory, polled or stored. The code is never logged, never put in the data folder, and never in a `GET`
  answer. Each code shown adds one Activity entry, "Workshop sign-in code shown", without the code.
- The page keeps the code only in the card while it shows: never in browser storage, the address bar or the service
  worker's cache.
- The key is handled like the status token: `stack.env` only, never sent to the browser, logged or stored, and child
  processes don't get it. It is only sent to the address in `LOCALAI_WORKSHOP_URL`.
- Who can see the code: anyone who can use Local AI. See [Security](SECURITY.md#other-controls).

## Current state (18 Oct 2026): the portal has no sign-in

Workshop OS 12.0.1 (`azmusgb/bambuhelper-smart-display` PR #161) restores the sign-in; after it is installed,
`/hardware/health` and `/status` answer `401` without one, and the card switches to `On your network · its own
sign-in` by itself. 12.1.0 (PR #162) adds the read-only status token above.


On the firmware installed on the display (Workshop OS 12, source `48ddd58`) the Local Portal has **no sign-in**: an
unauthenticated `GET /status` returns full live printer status, and the firmware's same-origin check accepts a
request that simply carries the header `X-BambuHelper-Client: 1`, so any program on the home network can probably use
the printer controls, Stop included (not tested, to avoid stopping a print). This contradicts that repo's own
`SECURITY.md` and `docs/portal-auth-v11-20.md`. A firmware update that restores the sign-in is being prepared in
`azmusgb/bambuhelper-smart-display`; it needs the repo's physical acceptance on the display before it is installed.
Until then: Local AI still only reads `/hardware/health` and never sends anything else to the display; the Tailscale
route `10.0.0.124/32` reaches the display only from your own Tailscale devices.

## Why the portal isn't proxied

The portal is meant to protect the printer with its own session sign-in (a rotating access code), CSRF tokens and same-origin
checks on every change (see that repo's `docs/portal-auth-v11-20.md` and `docs/CONTROL_SAFETY.md`). Loading it
through Local AI would add a second way to the printer controls that sits outside those checks: Local AI has no
sign-in of its own (see [Security](SECURITY.md#known-gaps)), every request would come from the appliance's origin
rather than the display's, and a cookie for the display would end up scoped to Local AI. So Local AI only reads the
health answer (and, with the token, the read-only status) and links to the display; signing in and every printer
action stay on the display's own page.
