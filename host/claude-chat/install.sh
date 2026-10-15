#!/usr/bin/env bash
# Installs the LocalAI Claude chat Mac side. Safe to re-run.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.claude/localai-chat"
KEY="$DEST/mac.key"
SETTINGS="$HOME/.claude/settings.json"
HOOK_CMD='/opt/homebrew/bin/python3 -I ~/.claude/localai-chat/hook.py'

# 1. files
mkdir -p "$DEST/run"
for f in bridge.mjs cli.mjs hook.py localai-chat; do cp "$SRC/$f" "$DEST/$f"; done
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
printf '%s' "$hash" | ssh windows-ai docker exec -i local-ai-appliance tee /data/claude-chat-mac-key.sha256 >/dev/null

# 4. hooks in ~/.claude/settings.json
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

# 5. shell function
ZSHRC="$HOME/.zshrc"
touch "$ZSHRC"
if ! grep -qF '# >>> localai-chat >>>' "$ZSHRC"; then
  printf '\n# >>> localai-chat >>>\nclaude-chat() { LOCALAI_CHAT=1 claude "$@"; }\n# <<< localai-chat <<<\n' >> "$ZSHRC"
fi

# 6. next steps
cat <<MSG

LocalAI Claude chat installed.
Next steps:
  source ~/.zshrc
  localai-chat status
  claude-chat --resume <session>
Then open the Claude page on LocalAI, and pair a device with: localai-chat pair <code>
MSG
