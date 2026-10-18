# Workshop display

The Workshop display is the BambuHelper Workshop OS touchscreen beside the Bambu printer (a Waveshare ESP32-S3 3.5"
board; firmware repo `azmusgb/bambuhelper-smart-display`). It shows the printer's state and has its own web page, the
**Local Portal**, with the printer controls (Stop among them).

**System › Services** has a card for it. The card says whether the display is answering (`Online · Waveshare 3.5"`
or `Not answering`), and **Open Workshop portal** opens the display's own portal in a new tab. You sign in there with
the display's access code, which it shows on its System screen and changes from time to time; Local AI never sees it.

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
Open Workshop portal: a plain link, opened by the browser in a new tab --> http://10.0.0.124/ (the display itself)
```

`GET /api/workshop/status` (`app/workshop.js`) reads the display's one public route, `GET /hardware/health`, and
answers `{online, board, panel, screen, touchscreenConfigured, portalUrl}`, rebuilt field by field: Wi-Fi strength,
memory, uptime and printer state are dropped. Nothing from the browser's request is forwarded. A display that is off,
refuses the connection, sends something that isn't JSON or doesn't answer within 4 s is `online: false`. There is no
other `/api/workshop/` route.

The link opens as a top-level page with `rel="noopener noreferrer"`, so an `http://` address works from the
`https://` app and the portal can't reach back into Local AI.

## Why the portal isn't proxied

The portal protects the printer with its own session sign-in (a rotating access code), CSRF tokens and same-origin
checks on every change (see that repo's `docs/portal-auth-v11-20.md` and `docs/CONTROL_SAFETY.md`). Loading it
through Local AI would add a second way to the printer controls that sits outside those checks: Local AI has no
sign-in of its own (see [Security](SECURITY.md#known-gaps)), every request would come from the appliance's origin
rather than the display's, and a cookie for the display would end up scoped to Local AI. So Local AI only reads the
public health answer and links to the display; signing in and every printer action stay on the display's own page.
