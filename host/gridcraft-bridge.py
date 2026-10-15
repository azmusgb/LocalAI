from __future__ import annotations

import json
import os
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.environ.get('GRIDCRAFT_BRIDGE_HOST', '0.0.0.0')
PORT = int(os.environ.get('GRIDCRAFT_BRIDGE_PORT', '8787'))
CONTROL_PORT = int(os.environ.get('GRIDCRAFT_CONTROL_PORT', '7979'))
MODEL = os.environ.get('GRIDCRAFT_MODEL', 'qwen3:4b-instruct')
USERPROFILE = Path(os.environ.get('USERPROFILE', str(Path.home())))
PROJECT_DIR = Path(os.environ.get('GRIDCRAFT_AGENT_DIR', USERPROFILE / 'gridcraft-local-ai'))
PYTHON = Path(os.environ.get('GRIDCRAFT_AGENT_PYTHON', PROJECT_DIR / '.venv' / 'Scripts' / 'python.exe'))
AGENT = Path(os.environ.get('GRIDCRAFT_AGENT_SCRIPT', PROJECT_DIR / 'gridcraft_ai.py'))
GRIDCRAFT_EXE = Path(os.environ.get('GRIDCRAFT_EXE', r'C:\Program Files\GridCraft\gridcraft.exe'))
WORKBOOK = Path(os.environ.get('GRIDCRAFT_WORKBOOK', USERPROFILE / 'Documents' / 'GridCraft' / 'Quarterly-Sales-Dashboard.xlsx'))
RUN_TIMEOUT = int(os.environ.get('GRIDCRAFT_RUN_TIMEOUT', '300'))
ALLOWED_ORIGINS = {
    x.strip() for x in os.environ.get(
        'GRIDCRAFT_ALLOWED_ORIGINS',
        'http://10.0.0.21:3080,http://127.0.0.1:3080,http://localhost:3080'
    ).split(',') if x.strip()
}

run_lock = threading.Lock()


def tcp_open(port: int) -> bool:
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.6):
            return True
    except OSError:
        return False


def ensure_gridcraft() -> bool:
    if tcp_open(CONTROL_PORT):
        return True
    if not GRIDCRAFT_EXE.exists():
        return False
    args = [str(GRIDCRAFT_EXE)]
    if WORKBOOK.exists():
        args.append(str(WORKBOOK))
    else:
        args.extend(['--sample', 'sales'])
    args.extend(['--control', str(CONTROL_PORT)])
    env = os.environ.copy()
    env['WGPU_BACKEND'] = 'vulkan'
    subprocess.Popen(args, env=env, creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0))
    for _ in range(30):
        if tcp_open(CONTROL_PORT):
            return True
        time.sleep(0.5)
    return False


def extract_answer(stdout: str) -> str:
    marker = 'ai> '
    idx = stdout.rfind(marker)
    if idx >= 0:
        return stdout[idx + len(marker):].strip()
    return stdout.strip()


class Handler(BaseHTTPRequestHandler):
    server_version = 'GridCraftBridge/1.0'

    def _origin(self):
        return self.headers.get('Origin', '')

    def _cors(self):
        origin = self._origin()
        if origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path != '/health':
            return self._json(404, {'ok': False, 'error': 'Not found'})
        return self._json(200, {
            'ok': PYTHON.exists() and AGENT.exists(),
            'gridcraftConnected': tcp_open(CONTROL_PORT),
            'model': MODEL,
            'controlPort': CONTROL_PORT,
            'agent': str(AGENT),
            'workbook': str(WORKBOOK),
        })

    def do_POST(self):
        if self.path != '/run':
            return self._json(404, {'ok': False, 'error': 'Not found'})
        try:
            length = min(int(self.headers.get('Content-Length', '0')), 1024 * 1024)
            payload = json.loads(self.rfile.read(length) or b'{}')
            prompt = str(payload.get('prompt', '')).strip()
        except Exception as exc:
            return self._json(400, {'ok': False, 'error': f'Invalid request: {exc}'})
        if not prompt:
            return self._json(400, {'ok': False, 'error': 'prompt is required'})
        if not PYTHON.exists() or not AGENT.exists():
            return self._json(503, {'ok': False, 'error': 'GridCraft local agent is not installed'})
        if not ensure_gridcraft():
            return self._json(503, {'ok': False, 'error': 'GridCraft control port 7979 is unavailable'})
        if not run_lock.acquire(blocking=False):
            return self._json(409, {'ok': False, 'error': 'Another GridCraft request is already running'})
        try:
            started = time.time()
            proc = subprocess.run(
                [str(PYTHON), str(AGENT), '--model', MODEL, '--once', prompt],
                cwd=str(PROJECT_DIR),
                capture_output=True,
                text=True,
                timeout=RUN_TIMEOUT,
                env=os.environ.copy(),
            )
            elapsed = round(time.time() - started, 2)
            if proc.returncode != 0:
                return self._json(500, {
                    'ok': False,
                    'error': 'GridCraft agent failed',
                    'exitCode': proc.returncode,
                    'stdout': proc.stdout[-12000:],
                    'stderr': proc.stderr[-12000:],
                    'durationSec': elapsed,
                })
            return self._json(200, {
                'ok': True,
                'answer': extract_answer(proc.stdout),
                'stdout': proc.stdout[-20000:],
                'durationSec': elapsed,
            })
        except subprocess.TimeoutExpired:
            return self._json(504, {'ok': False, 'error': f'GridCraft request exceeded {RUN_TIMEOUT}s'})
        finally:
            run_lock.release()

    def log_message(self, fmt, *args):
        print(f'{self.client_address[0]} - {fmt % args}', flush=True)


if __name__ == '__main__':
    print(f'GridCraft bridge listening on {HOST}:{PORT}', flush=True)
    print(f'Agent: {AGENT}', flush=True)
    print(f'Workbook: {WORKBOOK}', flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
