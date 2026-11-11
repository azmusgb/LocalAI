from __future__ import annotations

import hashlib
import importlib.util
import json
import logging
import logging.handlers
import os
import re
import socket
import subprocess
import sys
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
        'http://10.0.0.81:3080,http://127.0.0.1:3080,http://localhost:3080'
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
    # ArtCraft is unsigned and talks to cloud services, so it must never get an admin token, and a bridge installed before
    # 19 Oct 2026 still runs elevated until the installer is re-run. explorer.exe hands the launch to the signed-in user's
    # normal, non-admin shell either way. It returns at
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

# What the running request is doing, for GET /progress: the agent logs each model turn and tool call on stdout as it
# goes ("[agent] model turn 2 ...", "[agent] tool call: read_range {...}"), and the bridge turns those lines into steps
# in the owner's words while the request runs. Only the newest request is kept, and only its newest MAX_STEPS steps.
MAX_STEPS = 40
progress_lock = threading.Lock()
progress = {'running': False, 'startedAt': None, 'turn': 0, 'steps': []}


def _short(value, limit: int = 60) -> str:
    text = ' '.join(str(value or '').split())
    return text if len(text) <= limit else text[:limit - 1] + '…'


def describe_tool(name: str, args) -> str:
    args = args if isinstance(args, dict) else {}
    where = _short(args.get('range') or args.get('cell') or args.get('ref') or '')
    sheet = _short(args.get('sheet') or '')
    if sheet and where and '!' not in where:
        where = f'{sheet}!{where}'
    where = where or sheet
    texts = {
        'inspect_workbook': 'Looking over the workbook',
        'list_functions': 'Looking up spreadsheet functions',
        'read_range': f'Reading {where}' if where else 'Reading cells',
        'get_cell': f'Reading {where}' if where else 'Reading a cell',
        'evaluate_formula': f'Calculating {_short(args.get("formula"))}' if args.get('formula') else 'Calculating',
        'set_cell': f'Changing {where}' if where else 'Changing a cell',
        'write_range': f'Writing {where}' if where else 'Writing cells',
        'save_workbook': 'Saving the workbook',
        'open_workbook': 'Opening a workbook',
        'new_workbook': 'Starting a new workbook',
    }
    return texts.get(name) or (f'Using {name} on {where}' if where else f'Using {name}')


def step_from_line(line: str):
    # One agent log line -> ('turn', n), ('step', {...}), ('failed', None) for the last step, or None.
    line = line.strip()
    if line.startswith('[agent] model turn '):
        try:
            return 'turn', int(line.split()[3])
        except (IndexError, ValueError):
            return None
    if line.startswith('[agent] tool call: '):
        name, _, raw = line[len('[agent] tool call: '):].partition(' ')
        try:
            args = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            # The agent cuts long arguments (a big write_range) at 500 characters: keep the short fields before the cut.
            args = {k: v for k, v in re.findall(r'"(range|cell|ref|sheet|formula)"\s*:\s*"((?:[^"\\]|\\.)*)"', raw)}
        return 'step', {'tool': name, 'text': describe_tool(name, args), 'at': round(time.time(), 1)}
    if line.startswith('[agent] tool result: ') and ' -> ERROR' in line:  # summarize_tool_result marks failures
        return 'failed', None
    return None


def note_progress(line: str) -> None:
    found = step_from_line(line)
    if not found:
        return
    kind, value = found
    with progress_lock:
        if kind == 'turn':
            progress['turn'] = value
        elif kind == 'step':
            progress['steps'] = (progress['steps'] + [value])[-MAX_STEPS:]
        elif progress['steps']:
            progress['steps'][-1]['failed'] = True


def set_running(running: bool) -> None:
    with progress_lock:
        if running:
            progress.update(running=True, startedAt=round(time.time(), 1), turn=0, steps=[])
        else:
            progress['running'] = False


def progress_snapshot() -> dict:
    with progress_lock:
        return {**progress, 'steps': [dict(x) for x in progress['steps']]}


def _pump(stream, sink: list, on_line=None) -> None:
    for line in iter(stream.readline, ''):
        sink.append(line)
        if on_line:
            try:
                on_line(line)
            except Exception:  # progress is a nicety; never let it break the request
                log.exception('Could not read a progress line')
    stream.close()


class AgentTimedOut(Exception):
    # The agent ran past RUN_TIMEOUT and was killed; stderr is what it wrote until then (its journal entries).
    def __init__(self, stderr: str):
        super().__init__(f'GridCraft request exceeded {RUN_TIMEOUT}s')
        self.stderr = stderr


def agent_time_limit() -> int:
    # The agent stops itself this long before the bridge would kill it, between tool calls, so it still prints its
    # journal; the kill at RUN_TIMEOUT is only for an agent stuck in GridCraft itself.
    return max(30, RUN_TIMEOUT - 30)


def run_agent(prompt: str, mode: str = 'apply') -> subprocess.CompletedProcess:
    # '--once=<prompt>' keeps argparse from reading a prompt that starts with '-' as an option.
    args = [str(PYTHON), str(AGENT), '--model', MODEL, '--mode', mode, '--time-limit', str(agent_time_limit()),
            f'--once={prompt}']
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
    # Read both pipes as the agent writes them (stdout line by line for progress), so neither fills up and blocks it.
    out: list = []
    err: list = []
    readers = [threading.Thread(target=_pump, args=(proc.stdout, out, note_progress), daemon=True),
               threading.Thread(target=_pump, args=(proc.stderr, err), daemon=True)]
    for reader in readers:
        reader.start()
    try:
        proc.wait(timeout=RUN_TIMEOUT)
    except subprocess.TimeoutExpired:
        # Kill the agent and its MCP child (gridcraft-cli); killing only the agent can leave the pipes open.
        if os.name == 'nt':
            subprocess.run(['taskkill', '/T', '/F', '/PID', str(proc.pid)], capture_output=True)
        else:
            proc.kill()
        for reader in readers:
            reader.join(timeout=10)
        raise AgentTimedOut(''.join(err)) from None
    for reader in readers:
        reader.join(timeout=10)
    return subprocess.CompletedProcess(args, proc.returncode, ''.join(out), ''.join(err))


JOURNAL_PREFIX = '[journal] '
ENTRY_PREFIX = '[journal-entry] '


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


def partial_journal(stderr: str, mode: str) -> dict | None:
    # The journal of a request that was killed before it printed its own: the agent prints each write as it starts
    # ({"pending"}) and as it is recorded ({"edit"} or {"change"}, with its undo steps). A write that started and never
    # got its record leaves the undo count unknown: uncertain, so Discard won't guess.
    edits, changes, steps, saved, pending, uncertain = [], [], 0, False, None, False
    for line in (stderr or '').splitlines():
        if not line.startswith(ENTRY_PREFIX):
            continue
        try:
            entry = json.loads(line[len(ENTRY_PREFIX):])
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if 'pending' in entry:
            uncertain = uncertain or pending is not None
            pending = entry['pending']
            continue
        pending = None
        if 'settled' in entry:
            continue
        if isinstance(entry.get('edit'), dict):
            edits.append(entry['edit'])
        elif isinstance(entry.get('change'), dict):
            changes.append(entry['change'])
        steps += int(entry.get('steps') or 0)
        saved = saved or entry.get('saved') is True
    uncertain = uncertain or pending is not None
    if not (edits or changes or uncertain):
        return None
    return {'mode': mode, 'edits': edits, 'changes': changes, 'undoSteps': steps, 'undoTop': [], 'saved': saved,
            'partial': True, 'uncertain': uncertain}


def without_journal(text: str) -> str:
    return '\n'.join(x for x in (text or '').splitlines() if not x.startswith((JOURNAL_PREFIX, ENTRY_PREFIX)))


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


# Ops run in this process on one GridCraft connection kept open (gridcraft_ops.Session) when the bridge's Python has
# the agent's packages (the installer runs it from the agent's venv); otherwise, or when that connection fails before
# changing anything, each op runs as its own process as before. GRIDCRAFT_OPS_SESSION=0 turns the session off.
_session_lock = threading.Lock()
_session = None  # a Session, False when unavailable, None until first use


def ops_session():
    global _session
    with _session_lock:
        if _session is None:
            _session = False
            if os.environ.get('GRIDCRAFT_OPS_SESSION', '1') != '0' and OPS.exists() and importlib.util.find_spec('mcp'):
                try:
                    sys.path.insert(0, str(OPS.parent))
                    spec = importlib.util.spec_from_file_location('gridcraft_ops', OPS)
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    if hasattr(module, 'Session'):
                        os.environ.update(GRIDCRAFT_PORT=str(CONTROL_PORT), GRIDCRAFT_WORKBOOKS_DIR=str(WORKBOOKS_DIR))
                        _session = (module, module.Session())
                        log.info('GridCraft ops use one kept connection')
                except Exception:
                    log.exception('GridCraft ops session unavailable; each op runs as its own process')
        return _session or None


def run_ops(op: str, payload: dict, gridcraft: bool = True) -> tuple[int, dict]:
    # Workbook view, keep, discard, open and cell edits: gridcraft_ops.py talks to GridCraft directly, no model. JSON in, JSON out.
    # gridcraft=False for listing the folder, which doesn't need GridCraft running.
    if not PYTHON.exists() or not OPS.exists():
        return 503, {'ok': False, 'error': 'GridCraft local agent is not installed'}
    if gridcraft and not ensure_gridcraft():
        return 503, {'ok': False, 'error': f'GridCraft control port {CONTROL_PORT} is unavailable'}
    session = ops_session()
    if session:
        module, runner = session
        try:
            return 200, {'ok': True, **runner.run(op, payload, OPS_TIMEOUT)}
        except module.OpError as exc:
            return exc.status, {'ok': False, 'error': str(exc)}
        except module.Lost as exc:
            log.warning('GridCraft connection lost during %s: %s', op, exc)
            return 502, {'ok': False, 'error': 'The connection to GridCraft broke during the change. Look at the workbook before you try again.'}
        except TimeoutError:
            return 504, {'ok': False, 'error': f'GridCraft did not answer within {OPS_TIMEOUT}s'}
        except module.Retry as exc:
            log.info('GridCraft connection failed before %s changed anything (%s); running it on its own', op, exc)
        except Exception:
            log.exception('GridCraft op %s failed in the kept connection; running it on its own', op)
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
        if url.path == '/download':
            query = {k: v[0] for k, v in parse_qs(url.query).items() if k == 'name' and v}
            return self._json(*run_ops('download', query, gridcraft='name' not in query))
        if url.path == '/progress':
            return self._json(200, {'ok': True, **progress_snapshot()})
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
            'code': CODE,
            'startedAt': STARTED_AT,
            'pid': os.getpid(),
        })

    def do_POST(self):
        if self.path not in ('/run', '/keep', '/discard', '/open', '/new', '/upload', '/cell', '/artcraft/open'):
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
            max_body = 15 * 1024 * 1024 if self.path == '/upload' else 1024 * 1024
            raw_len = int(self.headers.get('Content-Length', '0'))
            if raw_len > max_body:
                return self._json(413, {'ok': False, 'error': 'Workbook files can be at most 10 MB' if self.path == '/upload' else 'Request is too large'})
            payload = json.loads(self.rfile.read(raw_len) or b'{}')
            if not isinstance(payload, dict):
                raise ValueError('expected a JSON object')
            prompt = str(payload.get('prompt', '')).strip()
        except Exception as exc:
            return self._json(400, {'ok': False, 'error': f'Invalid request: {exc}'})
        if self.path != '/run':
            # Keep, discard, open, new, upload and a cell edit change the workbook, so they wait for no one: a running
            # request gets 409 like a second run.
            op = {'/cell': 'set_cell'}.get(self.path, self.path.strip('/'))
            if not run_lock.acquire(blocking=False):
                busy = {'open': 'GridCraft is busy with a request',
                        'new': 'GridCraft is busy with a request',
                        'upload': 'GridCraft is busy with a request',
                        'set_cell': 'GridCraft is busy with a request. Change the cell when it finishes.'}.get(
                    op, 'A GridCraft request is running; try again when it finishes')
                return self._json(409, {'ok': False, 'error': busy})
            try:
                keys = {'discard': ('steps', 'undoTop', 'fingerprint'), 'open': ('name',), 'new': ('name',),
                        'upload': ('name', 'data'), 'set_cell': ('sheet', 'cell', 'input')}.get(op, ())
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
            set_running(True)
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
        except AgentTimedOut as exc:
            log.warning('Agent timed out after %ss', RUN_TIMEOUT)
            journal = partial_journal(exc.stderr, mode)
            if journal:
                # Where the workbook stands now, so Keep and Discard can work on what the request got done.
                status, now = run_ops('state', {})
                if status == 200:
                    journal.update(undoTop=now.get('undoTop') or [], dirty=now.get('dirty'), fingerprint=now.get('fingerprint'))
                else:
                    journal['uncertain'] = True
            return self._json(504, {'ok': False, 'error': f'GridCraft request exceeded {RUN_TIMEOUT}s', 'mode': mode,
                                    'journal': journal})
        except Exception as exc:
            return self._json(500, {'ok': False, 'error': f'Bridge failed to run the agent: {type(exc).__name__}: {exc}'})
        finally:
            set_running(False)
            run_lock.release()

    def log_message(self, fmt, *args):
        log.info('%s - %s', self.client_address[0], fmt % args)


# Deploys update C:\LocalAI\repo but never restart this process, and it imports the ops and journal modules (the kept
# connection). It watches its own code and, when an update changed it and nothing is running, starts itself again:
# the new process gets the port once this one has closed it. GRIDCRAFT_BRIDGE_RELOAD=0 turns that off;
# GRIDCRAFT_BRIDGE_RELOAD_EVERY sets how often it looks (seconds).
def code_files() -> list:
    return [Path(__file__).resolve(), OPS, AGENT.parent / 'gridcraft_journal.py']


def code_hash() -> str:
    h = hashlib.sha256()
    for path in code_files():
        try:
            h.update(path.read_bytes())
        except OSError:
            h.update(b'-')
    return h.hexdigest()[:16]


CODE = code_hash()
STARTED_AT = round(time.time(), 1)


def restart_command() -> list:
    return [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]


restarting = threading.Event()


def watch_code(server, every: float) -> None:
    while True:
        time.sleep(every)
        if code_hash() == CODE or not run_lock.acquire(blocking=False):
            continue  # unchanged, or a request is running: look again later
        log.info('Bridge code changed; starting the new version')
        restarting.set()  # serve() returns once the server stops: it waits here instead of ending the process
        try:
            server.shutdown()
            server.server_close()
            crash = Path(_log_path).with_suffix('.crash.log') if _log_path else None
            out = open(crash, 'ab') if crash else subprocess.DEVNULL
            subprocess.Popen(restart_command(), stdin=subprocess.DEVNULL, stdout=out, stderr=out, cwd=os.getcwd(),
                             creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) | getattr(subprocess, 'DETACHED_PROCESS', 0))
        except Exception:
            log.exception('Could not start the new bridge; this one stops so the scheduled task can')
        finally:
            for handler in log.handlers:
                handler.flush()
            os._exit(0)


def serve() -> None:
    log.info('GridCraft bridge listening on %s:%s (code %s)', HOST, PORT, CODE)
    log.info('Agent: %s', AGENT)
    log.info('Workbook: %s', WORKBOOK)
    server = None
    for attempt in range(40):  # a bridge that just restarted itself may still hold the port for a moment
        try:
            server = ThreadingHTTPServer((HOST, PORT), Handler)
            break
        except OSError:
            if attempt == 39:
                raise
            time.sleep(0.25)
    server.handle_error = lambda request, client_address: log.exception('Request from %s failed', client_address[0])
    if os.environ.get('GRIDCRAFT_BRIDGE_RELOAD', '1') != '0':
        every = float(os.environ.get('GRIDCRAFT_BRIDGE_RELOAD_EVERY') or 60)
        threading.Thread(target=watch_code, args=(server, every), daemon=True, name='code-watch').start()
    server.serve_forever()
    while restarting.is_set():
        time.sleep(1)  # the watcher starts the new bridge and ends this process


if __name__ == '__main__':
    serve()
