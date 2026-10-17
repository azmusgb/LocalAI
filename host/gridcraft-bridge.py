from __future__ import annotations

import json
import logging
import logging.handlers
import os
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# Loopback only: the appliance container reaches it through host.docker.internal (Docker Desktop forwards that to the
# host's loopback), and browsers go through the appliance's /api/gridcraft routes. Nothing else needs the port.
HOST = os.environ.get('GRIDCRAFT_BRIDGE_HOST', '127.0.0.1')
PORT = int(os.environ.get('GRIDCRAFT_BRIDGE_PORT', '8787'))
CONTROL_PORT = int(os.environ.get('GRIDCRAFT_CONTROL_PORT', '7979'))
MODEL = os.environ.get('GRIDCRAFT_MODEL', 'qwen3:4b-instruct')
USERPROFILE = Path(os.environ.get('USERPROFILE', str(Path.home())))
PROJECT_DIR = Path(os.environ.get('GRIDCRAFT_AGENT_DIR', USERPROFILE / 'gridcraft-local-ai'))
PYTHON = Path(os.environ.get('GRIDCRAFT_AGENT_PYTHON', PROJECT_DIR / '.venv' / 'Scripts' / 'python.exe'))
AGENT = Path(os.environ.get('GRIDCRAFT_AGENT_SCRIPT', Path(__file__).resolve().parent / 'gridcraft-agent' / 'gridcraft_ai.py'))
OPS = AGENT.parent / 'gridcraft_ops.py'
GRIDCRAFT_EXE = Path(os.environ.get('GRIDCRAFT_EXE', r'C:\Program Files\GridCraft\gridcraft.exe'))
WORKBOOK = Path(os.environ.get('GRIDCRAFT_WORKBOOK', USERPROFILE / 'Documents' / 'GridCraft' / 'Quarterly-Sales-Dashboard.xlsx'))
# The workbook menu lists and opens files directly in this folder (gridcraft_ops.py checks every name against it).
WORKBOOKS_DIR = Path(os.environ.get('GRIDCRAFT_WORKBOOKS_DIR') or WORKBOOK.parent)
RUN_TIMEOUT = int(os.environ.get('GRIDCRAFT_RUN_TIMEOUT', '300'))
ALLOWED_ORIGINS = {
    x.strip() for x in os.environ.get(
        'GRIDCRAFT_ALLOWED_ORIGINS',
        'http://10.0.0.21:3080,http://127.0.0.1:3080,http://localhost:3080'
    ).split(',') if x.strip()
}

# ArtCraft (an image and video studio that works through cloud services) is only reported on and opened, never driven.
LOCALAPPDATA = Path(os.environ.get('LOCALAPPDATA', USERPROFILE / 'AppData' / 'Local'))
ARTCRAFT_EXE = Path(os.environ.get('ARTCRAFT_EXE', LOCALAPPDATA / 'ArtCraft' / 'artcraft.exe'))
ON_WINDOWS = os.name == 'nt'

run_lock = threading.Lock()
launch_lock = threading.Lock()
MODES = ('read', 'review', 'apply')
OPS_TIMEOUT = 60

# Bridge log: rotated by size when GRIDCRAFT_BRIDGE_LOG is set (the installer sets it), otherwise stdout.
log = logging.getLogger('gridcraft-bridge')
log.setLevel(logging.INFO)
_log_path = os.environ.get('GRIDCRAFT_BRIDGE_LOG')
_handler = logging.handlers.RotatingFileHandler(_log_path, maxBytes=2 * 1024 * 1024, backupCount=3, encoding='utf-8') if _log_path else logging.StreamHandler()
_handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
log.addHandler(_handler)


def tcp_open(port: int) -> bool:
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.6):
            return True
    except OSError:
        return False


def ensure_gridcraft() -> bool:
    with launch_lock:  # the workbook view and a run can both find GridCraft closed; start it once
        return _ensure_gridcraft()


def _ensure_gridcraft() -> bool:
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


def process_running(exe_name: str) -> bool:
    name = exe_name.lower()
    try:
        if os.name == 'nt':
            out = subprocess.run(['tasklist', '/FI', f'IMAGENAME eq {exe_name}', '/NH', '/FO', 'CSV'],
                                 capture_output=True, text=True, timeout=10).stdout
            return f'"{name}"' in out.lower()
        out = subprocess.run(['ps', '-A', '-o', 'comm='], capture_output=True, text=True, timeout=10).stdout
        return any(Path(line.strip()).name.lower() == name for line in out.splitlines())
    except (OSError, subprocess.SubprocessError):
        return False


_version_cache: dict = {}


def file_version(path: Path):
    # The exe's product version (Windows only), cached until the file changes.
    if os.name != 'nt':
        return None
    try:
        key = (str(path), path.stat().st_mtime)
    except OSError:
        return None
    if key not in _version_cache:
        try:
            out = subprocess.run(
                ['powershell', '-NoProfile', '-NonInteractive', '-Command',
                 '(Get-Item -LiteralPath $env:LOCALAI_VERSION_OF).VersionInfo.ProductVersion'],
                capture_output=True, text=True, timeout=15, env={**os.environ, 'LOCALAI_VERSION_OF': str(path)},
            ).stdout.strip()
            _version_cache[key] = out[:40] or None
        except (OSError, subprocess.SubprocessError):
            return None
    return _version_cache[key]


def artcraft_status() -> dict:
    installed = ARTCRAFT_EXE.is_file()
    return {
        'ok': True,
        'installed': installed,
        'running': installed and process_running(ARTCRAFT_EXE.name),
        'version': file_version(ARTCRAFT_EXE) if installed else None,
    }


def artcraft_launch_args() -> list:
    # The bridge runs with the highest privileges, and ArtCraft is unsigned and talks to cloud services, so it must not
    # inherit that token. explorer.exe hands the launch to the signed-in user's normal, non-admin shell. It returns at
    # once and its exit code means nothing, so whether ArtCraft is running is still read from tasklist.
    if ON_WINDOWS:
        return ['explorer.exe', str(ARTCRAFT_EXE)]
    return [str(ARTCRAFT_EXE)]


def open_artcraft() -> tuple:
    # Only the configured exe, with no arguments: nothing from the request reaches the command line.
    if not ARTCRAFT_EXE.is_file():
        return 404, {'ok': False, 'error': "ArtCraft isn't installed on the Windows computer"}
    if process_running(ARTCRAFT_EXE.name):
        return 200, {'ok': True, 'alreadyRunning': True}
    subprocess.Popen(artcraft_launch_args(), cwd=str(ARTCRAFT_EXE.parent), creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0))
    log.info('Opened ArtCraft')
    return 200, {'ok': True, 'alreadyRunning': False}


FINAL_MARKER = '[agent] model returned final text.'


# Windows limits a command line to about 32K characters.
MAX_PROMPT_CHARS = 20000


def run_agent(prompt: str, mode: str = 'apply') -> subprocess.CompletedProcess:
    # '--once=<prompt>' keeps argparse from reading a prompt that starts with '-' as an option.
    args = [str(PYTHON), str(AGENT), '--model', MODEL, '--mode', mode, f'--once={prompt}']
    proc = subprocess.Popen(
        args,
        cwd=str(PROJECT_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding='utf-8',
        errors='replace',
        env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'},
        creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0),
    )
    try:
        stdout, stderr = proc.communicate(timeout=RUN_TIMEOUT)
    except subprocess.TimeoutExpired:
        # Kill the agent and its MCP child (gridcraft-cli); killing only the agent can leave the pipes open.
        if os.name == 'nt':
            subprocess.run(['taskkill', '/T', '/F', '/PID', str(proc.pid)], capture_output=True)
        else:
            proc.kill()
        try:
            proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        raise
    return subprocess.CompletedProcess(args, proc.returncode, stdout, stderr)


JOURNAL_PREFIX = '[journal] '


def parse_journal(stderr: str) -> dict | None:
    # The agent's record of what the request changed: one line on stderr, printed even when the request failed.
    for line in reversed((stderr or '').splitlines()):
        if line.startswith(JOURNAL_PREFIX):
            try:
                data = json.loads(line[len(JOURNAL_PREFIX):])
            except ValueError:
                return None
            return data if isinstance(data, dict) else None
    return None


def without_journal(text: str) -> str:
    return '\n'.join(x for x in (text or '').splitlines() if not x.startswith(JOURNAL_PREFIX))


def failure_reason(stdout: str, stderr: str) -> str:
    # The agent's last error line (a traceback ends with it), so the page can say why rather than just "failed".
    for text in (without_journal(stderr), stdout):
        lines = [x.strip() for x in (text or '').splitlines() if x.strip()]
        for line in reversed(lines):
            if 'error' in line.lower() or 'exception' in line.lower():
                return line[:300]
        if lines:
            return lines[-1][:300]
    return ''


def run_ops(op: str, payload: dict, gridcraft: bool = True) -> tuple[int, dict]:
    # Workbook view, keep, discard and open: gridcraft_ops.py talks to GridCraft directly, no model. JSON in, JSON out.
    # gridcraft=False for listing the folder, which doesn't need GridCraft running.
    if not PYTHON.exists() or not OPS.exists():
        return 503, {'ok': False, 'error': 'GridCraft local agent is not installed'}
    if gridcraft and not ensure_gridcraft():
        return 503, {'ok': False, 'error': f'GridCraft control port {CONTROL_PORT} is unavailable'}
    try:
        proc = subprocess.run(
            [str(PYTHON), str(OPS), op], input=json.dumps(payload), capture_output=True, text=True,
            encoding='utf-8', errors='replace', timeout=OPS_TIMEOUT, cwd=str(PROJECT_DIR),
            env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'GRIDCRAFT_PORT': str(CONTROL_PORT),
                 'GRIDCRAFT_WORKBOOKS_DIR': str(WORKBOOKS_DIR)},
        )
    except subprocess.TimeoutExpired:
        return 504, {'ok': False, 'error': f'GridCraft did not answer within {OPS_TIMEOUT}s'}
    lines = [x for x in proc.stdout.splitlines() if x.strip()]
    try:
        data = json.loads(lines[-1])
    except (IndexError, ValueError):
        return 502, {'ok': False, 'error': 'GridCraft operation failed', 'reason': failure_reason(proc.stdout, proc.stderr)}
    status = 200 if data.get('ok') else int(data.pop('status', 502) or 502)
    data.pop('status', None)
    return status, data


def extract_answer(stdout: str) -> str:
    # In --once mode the agent prints its progress log, this marker, then only the answer.
    idx = stdout.rfind(FINAL_MARKER)
    if idx >= 0:
        return stdout[idx + len(FINAL_MARKER):].strip()
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
        if self.path == '/artcraft':
            return self._json(200, artcraft_status())
        url = urlsplit(self.path)
        if url.path == '/workbook':
            query = {k: v[0] for k, v in parse_qs(url.query).items() if k in ('sheet', 'range') and v}
            return self._json(*run_ops('workbook', query))
        if url.path == '/workbooks':
            return self._json(*run_ops('workbooks', {}, gridcraft=False))
        if url.path != '/health':
            return self._json(404, {'ok': False, 'error': 'Not found'})
        return self._json(200, {
            'ok': PYTHON.exists() and AGENT.exists(),
            'gridcraftConnected': tcp_open(CONTROL_PORT),
            'model': MODEL,
            'controlPort': CONTROL_PORT,
            'agent': str(AGENT),
            'workbook': str(WORKBOOK),
            'workbooksDir': str(WORKBOOKS_DIR),
        })

    def do_POST(self):
        if self.path not in ('/run', '/keep', '/discard', '/open', '/artcraft/open'):
            return self._json(404, {'ok': False, 'error': 'Not found'})
        # CORS only hides responses; it does not stop a page on another site from firing a simple POST.
        # Require an allowed Origin when a browser sends one, and a JSON content type (which forces a preflight).
        origin = self._origin()
        if origin and origin not in ALLOWED_ORIGINS:
            return self._json(403, {'ok': False, 'error': 'Origin not allowed'})
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
            return self._json(415, {'ok': False, 'error': 'Content-Type must be application/json'})
        if self.path == '/artcraft/open':
            try:
                return self._json(*open_artcraft())
            except OSError as exc:
                log.warning('Could not open ArtCraft: %s', exc)
                return self._json(500, {'ok': False, 'error': f'Could not open ArtCraft: {exc}'})
        try:
            length = min(int(self.headers.get('Content-Length', '0')), 1024 * 1024)
            payload = json.loads(self.rfile.read(length) or b'{}')
            if not isinstance(payload, dict):
                raise ValueError('expected a JSON object')
            prompt = str(payload.get('prompt', '')).strip()
        except Exception as exc:
            return self._json(400, {'ok': False, 'error': f'Invalid request: {exc}'})
        if self.path != '/run':
            # Keep, discard and open change the workbook, so they wait for no one: a running request gets 409 like a second run.
            op = self.path.strip('/')
            if not run_lock.acquire(blocking=False):
                busy = 'GridCraft is busy with a request' if op == 'open' else 'A GridCraft request is running; try again when it finishes'
                return self._json(409, {'ok': False, 'error': busy})
            try:
                keys = {'discard': ('steps', 'undoTop'), 'open': ('name',)}.get(op, ())
                return self._json(*run_ops(op, {k: payload.get(k) for k in keys}))
            finally:
                run_lock.release()
        # Older appliances send no mode: they get what /run always did.
        mode = str(payload.get('mode') or 'apply')
        if mode not in MODES:
            return self._json(400, {'ok': False, 'error': f'mode must be one of {", ".join(MODES)}'})
        if not prompt:
            return self._json(400, {'ok': False, 'error': 'prompt is required'})
        if len(prompt) > MAX_PROMPT_CHARS:
            return self._json(413, {'ok': False, 'error': f'prompt is longer than {MAX_PROMPT_CHARS} characters'})
        if not PYTHON.exists() or not AGENT.exists():
            return self._json(503, {'ok': False, 'error': 'GridCraft local agent is not installed'})
        # Take the lock before possibly launching GridCraft so concurrent requests can't start two instances.
        if not run_lock.acquire(blocking=False):
            return self._json(409, {'ok': False, 'error': 'Another GridCraft request is already running'})
        try:
            if not ensure_gridcraft():
                return self._json(503, {'ok': False, 'error': f'GridCraft control port {CONTROL_PORT} is unavailable'})
            started = time.time()
            proc = run_agent(prompt, mode)
            elapsed = round(time.time() - started, 2)
            journal = parse_journal(proc.stderr)
            if proc.returncode != 0:
                reason = failure_reason(proc.stdout, proc.stderr)
                log.warning('Agent exited %s after %ss: %s', proc.returncode, elapsed, reason or '(no output)')
                return self._json(500, {
                    'ok': False,
                    'error': 'GridCraft agent failed',
                    'reason': reason,
                    'exitCode': proc.returncode,
                    'stdout': proc.stdout[-12000:],
                    'stderr': without_journal(proc.stderr)[-12000:],
                    'durationSec': elapsed,
                    'mode': mode,
                    'journal': journal,
                })
            return self._json(200, {
                'ok': True,
                'answer': extract_answer(proc.stdout),
                'stdout': proc.stdout[-20000:],
                'durationSec': elapsed,
                'mode': mode,
                'journal': journal,
            })
        except subprocess.TimeoutExpired:
            log.warning('Agent timed out after %ss', RUN_TIMEOUT)
            return self._json(504, {'ok': False, 'error': f'GridCraft request exceeded {RUN_TIMEOUT}s'})
        except Exception as exc:
            return self._json(500, {'ok': False, 'error': f'Bridge failed to run the agent: {type(exc).__name__}: {exc}'})
        finally:
            run_lock.release()

    def log_message(self, fmt, *args):
        log.info('%s - %s', self.client_address[0], fmt % args)


if __name__ == '__main__':
    log.info('GridCraft bridge listening on %s:%s', HOST, PORT)
    log.info('Agent: %s', AGENT)
    log.info('Workbook: %s', WORKBOOK)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.handle_error = lambda request, client_address: log.exception('Request from %s failed', client_address[0])
    server.serve_forever()
