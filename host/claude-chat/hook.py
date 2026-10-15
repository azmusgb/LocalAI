#!/usr/bin/env python3
"""Claude Code hook for the LocalAI Claude page chat (SessionStart, UserPromptSubmit, Stop).

Does nothing unless LOCALAI_CHAT=1. SessionStart starts the bridge; UserPromptSubmit and Stop mirror
the conversation to the LocalAI relay (Stop uses last_assistant_message, else the transcript). Never fails the hook: every error is swallowed.
The relay URL is LOCALAI_URL, else config.json "url" (written by install.sh), else plain HTTP on 3080. HTTPS is verified
against config.json "ca" (the LocalAI CA); verification is never turned off, and certificate problems go to hook.log.
"""
import json
import os
import shlex
import ssl
import subprocess
import sys
import time
import urllib.request

WEB_PREFIX = '[LocalAI web · '
MAX_TEXT = 50000
DEFAULT_URL = 'http://10.0.0.21:3080'
INSTALL_HINT = 're-run host/claude-chat/install.sh'


class CAUnreadable(Exception):
    pass


class ConfigUnreadable(Exception):
    pass


def chat_home():
    return os.environ.get('LOCALAI_CHAT_HOME') or os.path.expanduser('~/.claude/localai-chat')


def log(msg):
    try:
        with open(os.path.join(chat_home(), 'hook.log'), 'a', encoding='utf-8') as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}\n")
    except OSError:
        pass


def load_config():
    """(base URL, CA path or '') from LOCALAI_URL / config.json.

    A config.json that exists but cannot be used raises ConfigUnreadable: falling back to the HTTP default would quietly
    undo an HTTPS setup. A missing file is a pre-HTTPS install and uses the defaults."""
    path = os.path.join(chat_home(), 'config.json')
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        data = {}
    except (OSError, ValueError) as e:
        raise ConfigUnreadable(f'config.json unreadable: {path} ({e}); nothing is sent until it is fixed; {INSTALL_HINT}')
    if not isinstance(data, dict):
        raise ConfigUnreadable(f'config.json unreadable: {path} (not a JSON object); nothing is sent until it is fixed; {INSTALL_HINT}')
    base = str(os.environ.get('LOCALAI_URL') or data.get('url') or DEFAULT_URL).rstrip('/')
    ca = data.get('ca') if isinstance(data.get('ca'), str) else ''
    return base, (os.path.join(chat_home(), os.path.expanduser(ca)) if ca else '')


def opener_for(base, ca):
    # Ignore HTTP(S)_PROXY and system proxy settings: the Mac key must only ever go to the appliance itself.
    handlers = [urllib.request.ProxyHandler({})]
    if base.startswith('https:'):
        if ca:
            try:
                context = ssl.create_default_context(cafile=ca)
            except (OSError, ssl.SSLError) as e:
                raise CAUnreadable(f'CA file unreadable: {ca} ({e}); {INSTALL_HINT}')
        else:
            context = ssl.create_default_context()
        handlers.append(urllib.request.HTTPSHandler(context=context))
    return urllib.request.build_opener(*handlers)


def read_key():
    try:
        with open(os.path.join(chat_home(), 'mac.key'), encoding='utf-8') as f:
            return f.read().strip()
    except OSError:
        return ''


def post(session_id, role, source, text):
    key = read_key()
    if not key or not text:
        return
    try:
        base, ca = load_config()
    except ConfigUnreadable as e:
        log(str(e))
        return
    body = {'sessionId': session_id, 'role': role, 'source': source, 'text': text[:MAX_TEXT]}
    req = urllib.request.Request(
        base + '/api/claude/chat/mirror', data=json.dumps(body).encode(), method='POST',
        headers={'Content-Type': 'application/json', 'X-LocalAI-Mac-Key': key})
    try:
        opener_for(base, ca).open(req, timeout=3).read()
    except CAUnreadable as e:
        log(str(e))
    except Exception as e:
        reason = getattr(e, 'reason', e)
        if not isinstance(reason, ssl.SSLError):
            raise
        code = getattr(reason, 'reason', None) or type(reason).__name__
        detail = getattr(reason, 'verify_message', None)
        log(f"tls {code}{f' ({detail})' if detail else ''}: the certificate of {base} is not trusted "
            f"(CA: {ca or 'none configured'}); {INSTALL_HINT}")


def start_bridge(session_id, cwd):
    title = f"{os.path.basename(cwd.rstrip('/')) or 'home'} · {session_id[:8]}"
    cmd = os.environ.get('LOCALAI_CHAT_BRIDGE_CMD') or f"node {shlex.quote(os.path.join(chat_home(), 'bridge.mjs'))}"
    subprocess.Popen(shlex.split(cmd) + [session_id, title, cwd], start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     close_fds=True)


def block_text(content):
    """Text blocks of a message joined with blank lines (a plain string is returned as is)."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ''
    return '\n\n'.join(b['text'] for b in content
                       if isinstance(b, dict) and b.get('type') == 'text' and isinstance(b.get('text'), str) and b['text'].strip())


def is_real_prompt(content):
    if isinstance(content, str):
        return True
    return isinstance(content, list) and any(isinstance(b, dict) and b.get('type') == 'text' for b in content)


def last_reply(path):
    entries = []
    with open(path, encoding='utf-8') as f:
        for raw in f:
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            if isinstance(e, dict) and isinstance(e.get('message'), dict):
                entries.append(e)
    start = 0
    for i, e in enumerate(entries):
        if e.get('type') == 'user' and is_real_prompt(e['message'].get('content')):
            start = i + 1
    parts = [block_text(e['message'].get('content')) for e in entries[start:] if e.get('type') == 'assistant']
    return '\n\n'.join(p for p in parts if p)


def main():
    if os.environ.get('LOCALAI_CHAT') != '1':
        return
    data = json.load(sys.stdin)
    event = data.get('hook_event_name', '')
    session_id = str(data.get('session_id') or '')
    if not session_id or not read_key():
        return
    if event == 'SessionStart':
        start_bridge(session_id, str(data.get('cwd') or ''))
    elif event == 'UserPromptSubmit':
        prompt = data.get('prompt')
        if isinstance(prompt, str) and prompt.strip() and not prompt.startswith(WEB_PREFIX):
            post(session_id, 'user', 'terminal', prompt)
    elif event == 'Stop':
        # The transcript is written asynchronously and may not hold the turn's final text yet; Claude Code passes that
        # text as last_assistant_message. The transcript is only the fallback for versions that do not send it.
        final = data.get('last_assistant_message')
        if isinstance(final, str) and final.strip():
            post(session_id, 'assistant', 'reply', final)
            return
        path = data.get('transcript_path')
        if path:
            post(session_id, 'assistant', 'reply', last_reply(path))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
