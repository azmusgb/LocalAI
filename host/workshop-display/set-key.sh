#!/usr/bin/env bash
# Makes the Workshop display's Local AI key (docs/WORKSHOP-DISPLAY.md › Local AI cards). Safe to re-run: it reuses
# the key in the Mac's Keychain unless --new is given.
#   1. the key lives in the login Keychain (account ws350, service localai-display-key), never in a file or the repo;
#   2. its SHA-256 goes to the appliance (/data/workshop-display-key.sha256) over ssh, as the Mac key does;
#   3. the display gets the key itself from the portal setting (Workshop OS 12.3.10+), set by the firmware tools.
set -euo pipefail
SSH_HOST="${LOCALAI_SSH_HOST:-windows}"
SERVICE="localai-display-key"
if [ "${1:-}" = "--new" ] || ! security find-generic-password -a ws350 -s "$SERVICE" >/dev/null 2>&1; then
  key="wsd_$(openssl rand -hex 24)"
  security add-generic-password -U -a ws350 -s "$SERVICE" -w "$key"
  echo "Made a new display key (in the Keychain as $SERVICE)."
fi
hash="$(security find-generic-password -a ws350 -s "$SERVICE" -w | tr -d '\r\n' | shasum -a 256 | cut -d' ' -f1)"
if ! printf '%s' "$hash" | ssh "$SSH_HOST" docker exec -i local-ai-appliance tee /data/workshop-display-key.sha256 >/dev/null; then
  echo "set-key.sh: could not write the key's hash to the appliance (ssh $SSH_HOST). Fix ssh and re-run." >&2
  exit 1
fi
echo "The appliance accepts the display key for GET /api/display/feed."
