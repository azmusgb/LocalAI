# Workshop display

The Workshop display is the BambuHelper Workshop OS touchscreen beside the Bambu printer (a Waveshare ESP32-S3 3.5"
board; firmware repo `azmusgb/bambuhelper-smart-display`). It shows the printer's state and has its own web page, the
**Local Portal**, with the printer controls (Stop among them).

**System › Services** has a card for it. The card says whether the display is answering (`Online · Waveshare 3.5"`,
`Online · sign-in on` or `Not answering`), and **Open Workshop portal** opens the display's own portal in a new tab.
You sign in there with the code the display shows (System → Local Portal), which changes from time to time; Local AI
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
Home --GET /api/workshop/status?part=printer--> appliance (the poller's last read; nothing is sent to the display)
Open Workshop portal: a plain link, opened by the browser in a new tab --> http://10.0.0.124/ (the display itself)
```

`GET /api/workshop/status` (`app/workshop.js`) reads the display's `GET /hardware/health` and answers
`{online, board, panel, screen, touchscreenConfigured, signIn, portalUrl, printer}`, rebuilt field by field: Wi-Fi
strength, memory, uptime and printer state are dropped. `signIn` is `false` when the health route answered without a
sign-in, `true` when it answered `401` (then `online` is `true` and the board fields are `null`) or the printer-status
token works, and `null` when the display is offline. Nothing from the browser's request is forwarded. A display that is off,
refuses the connection, sends something that isn't JSON or doesn't answer within 4 s is `online: false`. There is no
other `/api/workshop/` route.

Local AI sends the display **only two requests, both `GET`**: `/hardware/health` and, with a token, `/api/status/lite`.
It never sends `POST`, never calls a control route, and never sends the portal's `X-BambuHelper-Client` header.

## Printer status (read-only token)

With Workshop OS 12.1.0 on the display, Home can show one line while a print runs or has stopped with an error, for
example `Printer · 42% · 1 h 10 min left`, `Printer · Paused · 42%` or `Printer · Stopped with an error (0300_400C)`.
Tapping it opens **System › Services** at the Workshop display card. Home shows nothing while the printer is idle, when
its status is unknown or stale, and when no token is set. The card shows a printer line too (`Printer · Idle`, or why
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
  a wrong token never keeps tripping the display's lock-out. A `429` keeps the last answer and tries again in 30 s.
  Browser tabs read the poller's last answer and never add requests of their own.
- The answer is rebuilt field by field into `printer: {state, progress, minutesLeft, errorCode, access, seenAt}`:
  `state` is `printing`, `paused`, `error`, `idle` or `unknown` (stale or offline telemetry is `unknown`, so old
  progress is never shown as current); `access` is `ok`, `refused` (401), `unsupported` (404), `busy` (429) or
  `offline`. `printer` is `null` when no token is set.
- The token stays on the server. It is never sent to the browser, never logged, never put in an error message or an
  answer, never stored in the data folder, and child processes don't get it (`childEnv` drops every `*TOKEN*`
  variable). Tests check each of these against a fake display.
- It is only sent to the address in `LOCALAI_WORKSHOP_URL` (a private address or a `.local` name); with any other
  value the poller doesn't start.

The link opens as a top-level page with `rel="noopener noreferrer"`, so an `http://` address works from the
`https://` app and the portal can't reach back into Local AI.

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
