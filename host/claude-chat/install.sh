#!/usr/bin/env bash
# Installs the LocalAI Claude chat Mac side. Safe to re-run.
# --allow-http: allow switching an existing HTTPS config back to plain HTTP when HTTPS cannot be set up.
set -euo pipefail

ALLOW_HTTP=0
for arg in "$@"; do
  case "$arg" in
    --allow-http) ALLOW_HTTP=1 ;;
    *) echo "usage: install.sh [--allow-http]" >&2; exit 2 ;;
  esac
done

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.claude/localai-chat"
KEY="$DEST/mac.key"
SETTINGS="$HOME/.claude/settings.json"
HOOK_CMD='/opt/homebrew/bin/python3 -I ~/.claude/localai-chat/hook.py'
CA="$DEST/localai-ca.crt"
CONFIG="$DEST/config.json"
HTTP_URL='http://10.0.0.21:3080'
HTTPS_URL="${LOCALAI_HTTPS_URL:-https://10.0.0.21}"

# 1. files
mkdir -p "$DEST/run"
for f in bridge.mjs cli.mjs relay.mjs hook.py localai-chat; do cp "$SRC/$f" "$DEST/$f"; done
chmod +x "$DEST/localai-chat"
if [ -d "$HOME/.local/bin" ]; then
  ln -sf "$DEST/localai-chat" "$HOME/.local/bin/localai-chat"
else
  echo "Note: ~/.local/bin does not exist. Add $DEST to your PATH or symlink $DEST/localai-chat somewhere on it."
fi

# 2. Mac key (no trailing newline)
if [ ! -s "$KEY" ]; then
  if command -v openssl >/dev/null 2>&1; then
    newkey="$(openssl rand -hex 32)"
  else
    newkey="$(head -c 32 /dev/urandom | xxd -p -c 64)"
  fi
  (umask 077; printf '%s' "$newkey" > "$KEY")
fi
chmod 600 "$KEY"

# 3. push the key hash to the appliance (hash of the trimmed key, as the relay hashes the header value)
hash="$(tr -d '\r\n' < "$KEY" | shasum -a 256 | cut -d' ' -f1)"
if ! printf '%s' "$hash" | ssh windows-ai docker exec -i local-ai-appliance tee /data/claude-chat-mac-key.sha256 >/dev/null; then
  echo "install.sh: created $KEY but could not push its hash to the appliance (ssh windows-ai failed). Fix ssh access and re-run install.sh — it reuses the same key." >&2
  exit 1
fi

# 4. relay URL: HTTPS, verified with the LocalAI CA, when that works. The CA comes over ssh (authenticated), never
# over plain HTTP; only the PEM block is kept (ssh may print banners; Windows `type` uses CRLF). A config that already
# uses HTTPS is never downgraded without --allow-http. LOCALAI_URL in the environment still overrides config.json.
prev_url="$(CONFIG="$CONFIG" python3 -I -c 'import json, os
try:
    u = json.load(open(os.environ["CONFIG"], encoding="utf-8")).get("url")
    print(u if isinstance(u, str) else "")
except Exception:
    print("")' 2>/dev/null || true)"
url="$HTTP_URL"
ca_ok=0
why=''
hint=''
ca_tmp="$(mktemp "$DEST/localai-ca.XXXXXX")"
trap 'rm -f "$ca_tmp"' EXIT
if ssh windows-ai type 'C:\LocalAI\https\localai-ca.crt' </dev/null 2>/dev/null | tr -d '\r' \
     | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' > "$ca_tmp" \
   && [ -s "$ca_tmp" ] \
   && openssl x509 -noout -in "$ca_tmp" >/dev/null 2>&1; then
  ca_ok=1
  if curl -fsS --max-time 5 --noproxy '*' --cacert "$ca_tmp" -o /dev/null "$HTTPS_URL/healthz" 2>/dev/null; then
    url="$HTTPS_URL"
  else
    why="HTTPS at $HTTPS_URL is not reachable or not trusted with the LocalAI CA"
    hint="Check the appliance's HTTPS (Caddy) and re-run install.sh."
  fi
else
  why="could not get a valid LocalAI CA certificate over ssh (C:\\LocalAI\\https\\localai-ca.crt on the host)"
  hint="Run deploy/Install-LocalAI-HTTPS.ps1 on the host, then re-run install.sh."
fi
if [ "$url" = "$HTTP_URL" ]; then
  case "$prev_url" in
    https:*)
      if [ "$ALLOW_HTTP" != 1 ]; then
        echo "install.sh: error: $why. $CONFIG uses HTTPS ($prev_url); it and $CA are left unchanged. $hint To switch to plain HTTP instead, re-run with --allow-http." >&2
        exit 1
      fi ;;
  esac
  echo "install.sh: warning: $why; using plain HTTP ($HTTP_URL), so the Mac key crosses the network unencrypted. $hint" >&2
fi
if [ "$ca_ok" = 1 ]; then
  chmod 644 "$ca_tmp"
  mv "$ca_tmp" "$CA"
else
  rm -f "$CA"
fi
CONFIG="$CONFIG" URL="$url" CA="$CA" CA_OK="$ca_ok" python3 -I - <<'PY'
import json, os
config = {'url': os.environ['URL']}
if os.environ['CA_OK'] == '1':
    config['ca'] = os.environ['CA']
tmp = os.environ['CONFIG'] + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    f.write(json.dumps(config, indent=2) + '\n')
os.replace(tmp, os.environ['CONFIG'])
PY

# 5. hooks in ~/.claude/settings.json
mkdir -p "$HOME/.claude"
[ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"
backup="$SETTINGS.bak-localai-chat-$(date +%Y%m%d-%H%M%S)"
[ -e "$backup" ] || cp "$SETTINGS" "$backup"
tmp="$(mktemp "$SETTINGS.XXXXXX")"
SETTINGS="$SETTINGS" TMP="$tmp" HOOK_CMD="$HOOK_CMD" python3 -I - <<'PY'
import json, os, re
src, tmp, cmd = os.environ['SETTINGS'], os.environ['TMP'], os.environ['HOOK_CMD']
text = open(src, encoding='utf-8').read()
data = json.loads(text)
m = re.search(r'^([ \t]+)\S', text, re.M)
indent = m.group(1) if m else 2 * ' '
hooks = data.setdefault('hooks', {})
for event in ('SessionStart', 'UserPromptSubmit', 'Stop'):
    groups = hooks.setdefault(event, [])
    if any(h.get('command') == cmd for g in groups for h in g.get('hooks', [])):
        continue
    groups.append({'hooks': [{'type': 'command', 'command': cmd, 'async': True, 'timeout': 10}]})
out = json.dumps(data, indent=indent, ensure_ascii=False) + '\n'
json.loads(out)
open(tmp, 'w', encoding='utf-8').write(out)
PY
mv "$tmp" "$SETTINGS"

# 6. shell function
ZSHRC="$HOME/.zshrc"
touch "$ZSHRC"
if ! grep -qF '# >>> localai-chat >>>' "$ZSHRC"; then
  printf '\n# >>> localai-chat >>>\nclaude-chat() { LOCALAI_CHAT=1 claude "$@"; }\n# <<< localai-chat <<<\n' >> "$ZSHRC"
fi

# 7. next steps
if [ "$url" = "$HTTP_URL" ]; then relay_note=" (plain HTTP)"; else relay_note=" (HTTPS, verified with the LocalAI CA)"; fi
cat <<MSG

LocalAI Claude chat installed.
Relay: $url$relay_note
Next steps:
  source ~/.zshrc
  localai-chat status
  claude-chat --resume <session>
Then open the Claude page on LocalAI, and pair a device with: localai-chat pair <code>
MSG
