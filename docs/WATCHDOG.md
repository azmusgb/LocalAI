# Watchdog

Local AI looks out for trouble around it before something breaks, and tells you once per problem. A problem has to
last 2 minutes before it counts, so one slow check never notifies anyone. When it clears, it leaves Home on its own.

## What it watches

| Problem | Seen by | On Home | Phone notification |
|---|---|---|---|
| A disk is 90% full or has under 15 GB free (Windows, Local AI's data, the Mac) | the appliance; the Mac's watcher for the Mac | yes | **Needs you**, after quiet hours |
| The Workshop display hasn't answered for 10 minutes | the printer status poller (`app/workshop.js`) | yes | **Needs you**, after quiet hours |
| The printer stopped with an error | the printer status poller | yes | **Failed**, even in quiet hours |
| A print finished on its own | the printer status poller | no | **Finished** |
| The printer camera bridge isn't running on the Mac | the Mac's watcher | yes | **Needs you**, after quiet hours |
| The Mac hasn't checked in for 15 minutes | the appliance | yes | none: a Mac sleeps every night |
| Local AI (the Windows computer) isn't answering | the Mac's watcher | n/a | a Mac notification after about 15 minutes, and one when it's back |

The last row is the Mac's job because Local AI runs on the Windows computer: when that computer is off, nothing on it
can say so.

"What needs me?" from Siri, and `GET /api/glance`, add the open problems after the usual sentence ("Also: Mac disk is
97% full.").

## The Mac's watcher

`host/mac-watch/watch.py` runs every 5 minutes as the launchd agent `com.localai.mac-watch`:

- It reports the Mac's free disk space and whether the camera bridge agent (`com.bambuhelper.x2d-camera-bridge`) is
  running, as `POST /api/watch/heartbeat`.
- It signs the report with the Mac key and checks the appliance's certificate against Local AI's CA. Both come from
  `host/claude-chat/install.sh`.
- When three reports in a row get no answer, it shows a Mac notification once. It shows another when Local AI answers
  again.

Install it once: run `host/claude-chat/install.sh` first, then

```
bash host/mac-watch/install.sh
```

Logs are in `~/Library/Logs/localai-mac-watch.log`. Remove it with `bash host/mac-watch/install.sh --uninstall`.

## API

- `POST /api/watch/heartbeat` `{name, disk:{freeBytes,totalBytes}, bridge:{installed,running}}` needs the
  `X-LocalAI-Mac-Key` header and answers `401` without it. Unknown fields are dropped.
- `GET /api/watch` returns `{checkedAt, findings:[{id, severity, title, detail, since}], mac, hostDisks}`.
- `GET /api/capabilities` carries the same findings as `watch`, which Home's Needs you reads.

## How it works

`app/watchdog.js` runs once a minute (`HEALTH_TICK_MS`):

- `evaluate()` is pure: the same inputs always give the same findings.
- `tick()` settles each finding and notifies once through `app/notify.js`. It keeps its state in the setting
  `watchdog:state`, and the last heartbeat in `watchdog:mac`.
- Disks are measured with `statfs` on `/workspace/projects` (the Windows C: drive) and the data folder. Bind mounts of
  one drive are counted once.
