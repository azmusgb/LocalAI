#!/usr/bin/env python3
"""Mac side of the Local AI watchdog (docs/WATCHDOG.md). launchd runs it every 5 minutes.

1. Reports this Mac's disk and the printer camera bridge to POST /api/watch/heartbeat, with the Mac key
   (~/.claude/localai-chat/mac.key, set up by host/claude-chat/install.sh) over HTTPS verified by Local AI's CA.
2. Local AI runs on the Windows computer, so it can't report that computer going away. When the appliance hasn't
   answered for three runs in a row (about 15 minutes), this shows a Mac notification once, and another when it is
   back.

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


def notify(title, text):
    if os.environ.get("MAC_WATCH_PRINT_NOTICES"):  # tests
        print(f"NOTICE {title}: {text}")
        return
    script = f'display notification {json.dumps(text)} with title {json.dumps(title)}'
    subprocess.run(["osascript", "-e", script], capture_output=True, timeout=10)


def main():
    config = load_json(os.path.join(CHAT_DIR, "config.json"), {})
    url = os.environ.get("LOCALAI_URL") or config.get("url") or "https://10.0.0.21"
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
    ctx = ssl.create_default_context(cafile=ca) if url.startswith("https://") and os.path.exists(ca) else None
    state = load_json(STATE, {"misses": 0, "notified": False})
    try:
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            ok = resp.status == 200
    except urllib.error.HTTPError as e:
        ok = True  # the appliance answered; a 401 is a key problem, not an outage
        print(f"mac-watch: heartbeat refused (HTTP {e.code})", file=sys.stderr)
    except (urllib.error.URLError, OSError):
        ok = False

    if ok:
        if state.get("notified"):
            notify("Local AI is back", "The Windows computer is answering again.")
        state = {"misses": 0, "notified": False, "lastOkAt": int(time.time())}
    else:
        state["misses"] = int(state.get("misses", 0)) + 1
        if state["misses"] >= OUTAGE_RUNS and not state.get("notified"):
            notify("Local AI isn't answering", "The Windows computer may be off, asleep or off the network.")
            state["notified"] = True
    save_state(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
