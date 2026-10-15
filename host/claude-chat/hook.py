#!/usr/bin/env python3
"""Claude Code hook for the LocalAI Claude page chat (SessionStart, UserPromptSubmit, Stop).

Does nothing unless LOCALAI_CHAT=1. SessionStart starts the bridge; UserPromptSubmit and Stop mirror
the conversation to the LocalAI relay. Never fails the hook: every error is swallowed.
"""
import json
import os
import shlex
import subprocess
import sys
import urllib.request

WEB_PREFIX = '[LocalAI web · '
MAX_TEXT = 50000
# Ignore HTTP(S)_PROXY and system proxy settings: the Mac key must only ever go to the appliance itself.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def chat_home():
    return os.environ.get('LOCALAI_CHAT_HOME') or os.path.expanduser('~/.claude/localai-chat')


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
    url = os.environ.get('LOCALAI_URL', 'http://10.0.0.21:3080').rstrip('/') + '/api/claude/chat/mirror'
    body = {'sessionId': session_id, 'role': role, 'source': source, 'text': text[:MAX_TEXT]}
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method='POST',
        headers={'Content-Type': 'application/json', 'X-LocalAI-Mac-Key': key})
    OPENER.open(req, timeout=3).read()


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
        path = data.get('transcript_path')
        if path:
            post(session_id, 'assistant', 'reply', last_reply(path))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
