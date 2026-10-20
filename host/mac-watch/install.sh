#!/usr/bin/env bash
# Installs the Mac side of the Local AI watchdog (docs/WATCHDOG.md) as a launchd agent that runs every 5 minutes.
# Needs the Mac key and CA from host/claude-chat/install.sh. Safe to re-run.
#   bash host/mac-watch/install.sh            install or update, run once now
#   bash host/mac-watch/install.sh --uninstall
set -euo pipefail

LABEL="com.localai.mac-watch"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.claude/localai-chat"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/localai-mac-watch.log"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$DEST/mac-watch.py"
  echo "Removed $LABEL"
  exit 0
fi
[ -s "$DEST/mac.key" ] || { echo "install.sh: no $DEST/mac.key; run host/claude-chat/install.sh first" >&2; exit 1; }

PYTHON="$(command -v python3)"
mkdir -p "$DEST" "$(dirname "$PLIST")" "$(dirname "$LOG")"
cp "$SRC/watch.py" "$DEST/mac-watch.py"
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PYTHON</string><string>-I</string><string>$DEST/mac-watch.py</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed $LABEL (every 5 min; log $LOG)"
