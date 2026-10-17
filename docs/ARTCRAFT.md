# ArtCraft

ArtCraft is an image and video studio installed on the Windows host (`%LOCALAPPDATA%\ArtCraft\artcraft.exe`,
0.41.0 when this was written). It has no API: it is a desktop app that generates through cloud providers (ArtCraft's
own service, Grok, Midjourney, Sora) with an ArtCraft account, and keeps results in that account, not on disk.

LocalAI does not drive it. **System › Services** has an ArtCraft card that says whether it is installed and open on
the Windows computer, with **Open on the Windows computer** to start it there. Prompts and pictures used in ArtCraft
leave your network; for anything private use **Images**, which runs on ComfyUI on this computer.

## How it works

```text
Services card  ->  GET /api/artcraft/status, POST /api/artcraft/open   (appliance, app/server.js)
                     |
                     v  host.docker.internal:8787
GridCraft bridge (host/gridcraft-bridge.py)  GET /artcraft, POST /artcraft/open
                     |
                     v
%LOCALAPPDATA%\ArtCraft\artcraft.exe
```

ArtCraft rides on the existing GridCraft bridge (see [GridCraft](GRIDCRAFT.md) for installing it); there is no
second host service.

| Route | Answer |
|---|---|
| `GET /artcraft` (appliance: `GET /api/artcraft/status`) | `{ok, installed, running, version}`. `running` comes from `tasklist`; `version` is the exe's product version, read once per file change through PowerShell. |
| `POST /artcraft/open` (appliance: `POST /api/artcraft/open`) | Starts the fixed exe with no arguments and answers `{ok, alreadyRunning}`; 404 if it isn't installed. Nothing from the request body is used. Same Origin and JSON rules as the bridge's `/run`; the appliance also requires same-origin JSON and records "ArtCraft opened" in the Audit log. |

Bridge setting: `ARTCRAFT_EXE` (default `%LOCALAPPDATA%\ArtCraft\artcraft.exe`).

The bridge's scheduled task runs with highest privileges at logon, so ArtCraft opened from LocalAI runs with them
too, in the signed-in user's session (as GridCraft does).
