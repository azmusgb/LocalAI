#!/usr/bin/env python3
"""Mac side of the Local AI watchdog (docs/WATCHDOG.md). launchd runs it every 5 minutes.

1. Reports this Mac's disk and the printer camera bridge to POST /api/watch/heartbeat, with the Mac key
   (~/.claude/localai-chat/mac.key, set up by host/claude-chat/install.sh) over HTTPS verified by Local AI's CA.
2. Local AI runs on the Windows computer, so it can't report that computer going away. When the appliance hasn't
   answered for three runs in a row (about 15 minutes), this sends a phone notice once, and another when it is back.
   Pi Hub is the one phone channel (platform step 5, D2): the notice goes to its /api/notify/mac-watch with the mac
   deploy key, waiting in notice-outbox.json while Pi Hub can't take it, for up to an hour.
3. Sends the Mac agents' release reports (platform step 3: Pi Hub's release:mac-watch, release:x2d-bridge-mac and,
   since amendment A3, release:print-lab) that their installers, or print-lab's lab pull, queued in release-outbox.json, oldest first, with the mac deploy key from the login Keychain
   (service pi-hub-deploy-key, put there by pi-hub's deploy/deploy-key.sh mac). A report Pi Hub didn't take waits for
   the next run; one it refuses as invalid (400) is dropped.

Standard library only. Never prints or logs the key.
"""
import json
import os
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")
CHAT_DIR = os.path.join(HOME, ".claude", "localai-chat")
STATE = os.path.join(HOME, "Library", "Application Support", "LocalAI", "mac-watch.json")
BRIDGE_LABEL = "com.bambuhelper.x2d-camera-bridge"
OUTAGE_RUNS = 3
OUTBOX = os.path.join(CHAT_DIR, "release-outbox.json")
# target -> its mechanism: the installers, and print-lab's lab pull (it runs from its checkout, so a new commit is its deploy)
RELEASE_TARGETS = {"mac-watch": "mac-install", "x2d-bridge-mac": "mac-install", "print-lab": "lab-pull"}
OUTBOX_KEEP = 20
NOTICES = os.path.join(CHAT_DIR, "notice-outbox.json")
NOTICE_MAX_AGE = 3600  # seconds a notice Pi Hub hasn't taken is still worth sending


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE)


def disk():
    # The Data volume holds everything that fills up; "/" is the small sealed system volume.
    path = "/System/Volumes/Data" if os.path.isdir("/System/Volumes/Data") else "/"
    u = shutil.disk_usage(path)
    return {"freeBytes": u.free, "totalBytes": u.total}


def bridge():
    """installed: the launchd agent exists; running: it has a live process."""
    uid = os.getuid()
    try:
        out = subprocess.run(["launchctl", "print", f"gui/{uid}/{BRIDGE_LABEL}"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return {"installed": False, "running": False}
    if out.returncode != 0:
        return {"installed": False, "running": False}
    return {"installed": True, "running": "state = running" in out.stdout}


def notify(kind, title, text):
    """A phone notice for Pi Hub, queued in notice-outbox.json and sent by flush_notices() later in this run. Its dedupe
    is the occurrence, so a retry after a lost answer isn't a second notice."""
    if os.environ.get("MAC_WATCH_PRINT_NOTICES"):  # tests
        print(f"NOTICE {title}: {text}")
    now = int(time.time())
    items = load_json(NOTICES, [])
    write_outbox((items if isinstance(items, list) else []) +
                 [{"kind": kind, "title": title, "body": text, "dedupe": f"{kind}-{now}", "at": now}], NOTICES)


def write_outbox(items, path=OUTBOX):
    if not items:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        return
    os.makedirs(CHAT_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items[-OUTBOX_KEEP:], f)
    os.replace(tmp, path)


def queue_release(target, commit, dirty, message=""):
    """An installer's (or lab pull's) report for Pi Hub, added to the outbox (sent by the next run). Returns an error,
    or None."""
    if target not in RELEASE_TARGETS:
        return f"not a Mac agent: {target}"
    commit = (commit or "").lower()
    if not (7 <= len(commit) <= 40 and all(c in "0123456789abcdef" for c in commit)):
        return "no commit: install from a git checkout"
    report = {"target": target, "commit": commit, "result": "deployed", "mechanism": RELEASE_TARGETS[target],
              "at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()), "dirty": dirty,
              "message": (message or (("running" if target == "print-lab" else "installed from") + " uncommitted changes"
                         if dirty else ""))[:200]}
    items = load_json(OUTBOX, [])
    write_outbox((items if isinstance(items, list) else []) + [report])
    return None


def deploy_key():
    """The mac deploy key from the login Keychain, or None. Never printed."""
    try:
        out = subprocess.run(["security", "find-generic-password", "-a", "pi-hub", "-s", "pi-hub-deploy-key", "-w"],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def flush_releases(hub):
    """Sends the outbox oldest first; stops at the first report Pi Hub didn't take, keeping it and the rest."""
    items = load_json(OUTBOX, [])
    if not isinstance(items, list) or not items:
        return
    key = deploy_key()
    if not key:
        print(f"mac-watch: no deploy key in the Keychain yet; {len(items)} release report(s) waiting", file=sys.stderr)
        return
    left = []
    for i, item in enumerate(items):
        target = item.get("target") if isinstance(item, dict) else None
        if target not in RELEASE_TARGETS:
            continue
        body = json.dumps({k: v for k, v in item.items() if k != "target"}).encode()
        req = urllib.request.Request(f"{hub.rstrip('/')}/api/releases/{target}", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "X-Hub-Deploy-Key": key})
        try:
            with urllib.request.urlopen(req, timeout=15):
                pass
            print(f"mac-watch: release report {target} {item.get('commit', '')[:7]} taken")
        except urllib.error.HTTPError as e:
            if e.code == 400:
                print(f"mac-watch: release report {target} refused as invalid; dropped", file=sys.stderr)
                continue
            print(f"mac-watch: Pi Hub didn't take the release report (HTTP {e.code}); kept", file=sys.stderr)
            left = items[i:]
            break
        except (urllib.error.URLError, OSError):
            print("mac-watch: Pi Hub isn't answering; release report kept", file=sys.stderr)
            left = items[i:]
            break
    write_outbox(left)


def flush_notices(hub, now=None):
    """Posts the queued phone notices to Pi Hub oldest first; stops at the first one it didn't take, keeping it and the
    rest. One it refuses as invalid (400), or older than NOTICE_MAX_AGE, is dropped."""
    items = load_json(NOTICES, [])
    if not isinstance(items, list) or not items:
        return
    now = now or time.time()
    fresh = [i for i in items if isinstance(i, dict) and now - (i.get("at") or 0) <= NOTICE_MAX_AGE]
    if len(fresh) < len(items):
        print(f"mac-watch: {len(items) - len(fresh)} phone notice(s) older than an hour dropped", file=sys.stderr)
    key = deploy_key() if fresh else None
    if fresh and not key:
        print(f"mac-watch: no deploy key in the Keychain yet; {len(fresh)} phone notice(s) waiting", file=sys.stderr)
    left = fresh if fresh and not key else []
    for i, item in enumerate(fresh if key else []):
        body = json.dumps({k: item.get(k) for k in ("kind", "title", "body", "dedupe")}).encode()
        req = urllib.request.Request(f"{hub.rstrip('/')}/api/notify/mac-watch", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "X-Hub-Deploy-Key": key})
        try:
            with urllib.request.urlopen(req, timeout=15):
                pass
            print(f"mac-watch: phone notice \"{item.get('title')}\" taken")
        except urllib.error.HTTPError as e:
            if e.code == 400:
                print("mac-watch: phone notice refused as invalid; dropped", file=sys.stderr)
                continue
            print(f"mac-watch: Pi Hub didn't take the phone notice (HTTP {e.code}); kept", file=sys.stderr)
            left = fresh[i:]
            break
        except (urllib.error.URLError, OSError):
            print("mac-watch: Pi Hub isn't answering; phone notice kept", file=sys.stderr)
            left = fresh[i:]
            break
    write_outbox(left, NOTICES)


def main():
    if sys.argv[1:2] == ["--queue-release"]:
        target, commit, dirty = (sys.argv[2:5] + ["", "", ""])[:3]
        error = queue_release(target, commit, dirty == "1")
        if error:
            print(f"mac-watch: {error}; no release report", file=sys.stderr)
            return 1
        return 0
    config = load_json(os.path.join(CHAT_DIR, "config.json"), {})
    url = os.environ.get("LOCALAI_URL") or config.get("url") or "https://10.0.0.81"
    ca = config.get("ca") or os.path.join(CHAT_DIR, "localai-ca.crt")
    try:
        with open(os.path.join(CHAT_DIR, "mac.key"), encoding="utf-8") as f:
            key = f.read().strip()
    except OSError:
        print("mac-watch: no Mac key; run host/claude-chat/install.sh first", file=sys.stderr)
        return 1

    body = json.dumps({"name": os.uname().nodename.split(".")[0], "disk": disk(), "bridge": bridge()}).encode()
    req = urllib.request.Request(url.rstrip("/") + "/api/watch/heartbeat", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-LocalAI-Mac-Key": key})
    ctx = None
    if url.startswith("https://"):
        if os.path.exists(ca):
            ctx = ssl.create_default_context(cafile=ca)
        else:
            print(f"mac-watch: CA file not found at {ca}; HTTPS verification will fail. Run host/claude-chat/install.sh", file=sys.stderr)
    state = load_json(STATE, {"misses": 0, "notified": False})
    try:
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            ok = resp.status == 200
    except urllib.error.HTTPError as e:
        if e.code >= 500:
            # A live proxy (Caddy) answers 502/503/504 while the appliance behind it is down: that is an outage.
            ok = False
            print(f"mac-watch: appliance not answering behind the proxy (HTTP {e.code})", file=sys.stderr)
        else:
            ok = True  # the appliance answered; a 401 is a key problem, not an outage
            print(f"mac-watch: heartbeat refused (HTTP {e.code})", file=sys.stderr)
    except (urllib.error.URLError, OSError):
        ok = False

    if ok:
        if state.get("notified"):
            notify("back", "Local AI is back", "The Windows computer is answering again.")
        state = {"misses": 0, "notified": False, "lastOkAt": int(time.time())}
    else:
        state["misses"] = int(state.get("misses", 0)) + 1
        if state["misses"] >= OUTAGE_RUNS and not state.get("notified"):
            notify("outage", "Local AI isn't answering", "The Windows computer may be off, asleep or off the network.")
            state["notified"] = True
    save_state(state)
    hub = os.environ.get("PI_HUB_URL") or config.get("hub") or "https://hub.rahe-home.duckdns.org"
    try:
        flush_notices(hub)
    except Exception as e:  # a phone notice never fails the watchdog
        print(f"mac-watch: phone notices skipped ({type(e).__name__})", file=sys.stderr)
    try:
        flush_releases(hub)
    except Exception as e:  # a release report never fails the watchdog
        print(f"mac-watch: release reports skipped ({type(e).__name__})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
