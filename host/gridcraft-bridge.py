from __future__ import annotations

import json
import logging
import logging.handlers
import os
import re
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
GRIDCRAFT_EXE = Path(os.environ.get('GRIDCRAFT_EXE', r'C:\Program Files\GridCraft\gridcraft.exe'))
WORKBOOKS_DIR = Path(os.environ.get('GRIDCRAFT_WORKBOOKS_DIR', USERPROFILE / 'Documents' / 'GridCraft'))
WORKBOOK = Path(os.environ.get('GRIDCRAFT_WORKBOOK', WORKBOOKS_DIR / 'Quarterly-Sales-Dashboard.xlsx'))
RUN_TIMEOUT = int(os.environ.get('GRIDCRAFT_RUN_TIMEOUT', '300'))
# Workbook view (System > Spreadsheets): one direct MCP tool call, no model.
TOOL_TIMEOUT = int(os.environ.get('GRIDCRAFT_TOOL_TIMEOUT', '30'))
WORKBOOK_EXTENSIONS = {'.xlsx', '.xlsm', '.xls', '.csv', '.ods'}
MAX_ROWS, MAX_COLS = 200, 30
ALLOWED_ORIGINS = {
    x.strip() for x in os.environ.get(
        'GRIDCRAFT_ALLOWED_ORIGINS',
        'http://10.0.0.21:3080,http://127.0.0.1:3080,http://localhost:3080'
    ).split(',') if x.strip()
}

# Held by /run and by each workbook read, so a read never races a request that is changing the workbook.
run_lock = threading.Lock()
request_running = threading.Event()

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


FINAL_MARKER = '[agent] model returned final text.'


# Windows limits a command line to about 32K characters.
MAX_PROMPT_CHARS = 20000


def run_agent(prompt: str) -> subprocess.CompletedProcess:
    # '--once=<prompt>' keeps argparse from reading a prompt that starts with '-' as an option.
    return _run([str(PYTHON), str(AGENT), '--model', MODEL, f'--once={prompt}'], RUN_TIMEOUT)


def _run(args: list, timeout: int) -> subprocess.CompletedProcess:
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
        stdout, stderr = proc.communicate(timeout=timeout)
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


def failure_reason(stdout: str, stderr: str) -> str:
    # The agent's last error line (a traceback ends with it), so the page can say why rather than just "failed".
    for text in (stderr, stdout):
        lines = [x.strip() for x in (text or '').splitlines() if x.strip()]
        for line in reversed(lines):
            if 'error' in line.lower() or 'exception' in line.lower():
                return line[:300]
        if lines:
            return lines[-1][:300]
    return ''


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


# ---- Workbook view: read-only MCP calls through the agent's --tool mode ----

class ToolError(Exception):
    def __init__(self, status: int, error: str, reason: str = ''):
        super().__init__(error)
        self.status, self.error, self.reason = status, error, reason


def valid_workbook_name(name) -> bool:
    # A plain file name in the GridCraft folder: no folders, no '..', no drive, a spreadsheet extension.
    if not isinstance(name, str) or not name or len(name) > 200 or name != name.strip():
        return False
    if any(ch in name for ch in '/\\:') or '..' in name or name.startswith('.') or any(ord(ch) < 32 for ch in name):
        return False
    return Path(name).suffix.lower() in WORKBOOK_EXTENSIONS


def list_workbooks(folder: Path = None) -> list:
    folder = folder or WORKBOOKS_DIR
    out = []
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return out
    for entry in entries:
        # '~$Book.xlsx' is Excel's lock file, not a workbook.
        if entry.name.startswith('~$') or not valid_workbook_name(entry.name):
            continue
        try:
            if not entry.is_file(follow_symlinks=False):
                continue
            st = entry.stat()
        except OSError:
            continue
        out.append({'name': entry.name, 'size': st.st_size, 'modified': round(st.st_mtime)})
    return sorted(out, key=lambda x: x['name'].lower())


_CELL = re.compile(r'^([A-Z]{1,3})([0-9]{1,7})$')
_RANGE = re.compile(r'^([A-Z]{1,3}[0-9]{1,7})(?::([A-Z]{1,3}[0-9]{1,7}))?$')


def col_number(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def col_letters(n: int) -> str:
    s = ''
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def clip_range(rng: str):
    """'A1:AZ900' -> ('A1:AD200', True): at most MAX_ROWS x MAX_COLS from the top-left cell. None if not A1 style."""
    m = _RANGE.match((rng or '').strip().upper())
    if not m:
        return None
    a = _CELL.match(m.group(1))
    b = _CELL.match(m.group(2) or m.group(1))
    c1, r1, c2, r2 = col_number(a.group(1)), int(a.group(2)), col_number(b.group(1)), int(b.group(2))
    c1, c2, r1, r2 = min(c1, c2), max(c1, c2), min(r1, r2), max(r1, r2)
    truncated = c2 - c1 + 1 > MAX_COLS or r2 - r1 + 1 > MAX_ROWS
    c2, r2 = min(c2, c1 + MAX_COLS - 1), min(r2, r1 + MAX_ROWS - 1)
    return f'{col_letters(c1)}{r1}:{col_letters(c2)}{r2}', truncated


def _short_path(value):
    # Host paths stay on the host: an absolute path becomes its file name.
    if isinstance(value, str) and re.match(r'^(?:[A-Za-z]:[\\/]|\\\\|/)', value):
        return re.split(r'[\\/]', value.rstrip('\\/'))[-1]
    return value


def _pick(d: dict, *keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) is not None:
            return d[k]
    return None


def _used_range(value):
    if isinstance(value, str):
        return value.split('!')[-1].replace('$', '').upper() or None
    if isinstance(value, dict):
        a1 = _pick(value, 'range', 'a1', 'address', 'ref')
        if isinstance(a1, str):
            return _used_range(a1)
        start, end = _pick(value, 'start', 'from', 'top_left'), _pick(value, 'end', 'to', 'bottom_right')
        if isinstance(start, str) and isinstance(end, str):
            return f'{start}:{end}'.upper()
    return None


def shape_workbook(result) -> dict:
    """inspect_workbook's result in the fixed shape the page reads, with no host paths."""
    r = result if isinstance(result, dict) else {}
    r = r.get('workbook') if isinstance(r.get('workbook'), dict) else r
    path = _pick(r, 'path', 'file', 'file_path')
    sheets = []
    for s in _pick(r, 'sheets', 'worksheets') or []:
        if isinstance(s, str):
            sheets.append({'name': s, 'usedRange': None, 'cells': None})
        elif isinstance(s, dict) and _pick(s, 'name', 'title') is not None:
            cells = _pick(s, 'cell_count', 'cellCount', 'cells', 'non_empty_cells')
            sheets.append({
                'name': str(_pick(s, 'name', 'title')),
                'usedRange': _used_range(_pick(s, 'used_range', 'usedRange', 'used', 'dimensions')),
                'cells': cells if isinstance(cells, int) else None,
            })
    selection = _pick(r, 'selection')
    active = _pick(r, 'active_sheet', 'activeSheet') or _pick(selection if isinstance(selection, dict) else {}, 'sheet')
    file_name = _short_path(path) if isinstance(path, str) else None
    return {
        'title': str(_pick(r, 'title', 'name') or file_name or 'Workbook'),
        'file': file_name,
        'dirty': bool(_pick(r, 'dirty', 'is_dirty', 'modified', 'unsaved')),
        'activeSheet': str(active) if active is not None else None,
        'sheets': sheets,
    }


def _cell(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        if value.get('error') is not None:
            return {'error': str(value['error'])[:40]}
        inner = _pick(value, 'formatted', 'display', 'text', 'value')
        return _cell(inner) if not isinstance(inner, dict) else None
    return str(value)


def shape_range(result, used: str, truncated: bool) -> dict:
    r = result
    if isinstance(r, dict):
        used = _used_range(_pick(r, 'range', 'address')) or used
        r = _pick(r, 'values', 'rows', 'data', 'cells')
    rows = r if isinstance(r, list) else []
    rows = [row if isinstance(row, list) else [row] for row in rows]
    if len(rows) > MAX_ROWS or any(len(row) > MAX_COLS for row in rows):
        truncated = True
    rows = [[_cell(v) for v in row[:MAX_COLS]] for row in rows[:MAX_ROWS]]
    return {'range': used, 'rows': rows, 'truncated': truncated}


def call_tool(name: str, arguments: dict):
    """One GridCraft MCP call through the agent; raises ToolError. Caller holds run_lock."""
    if name not in ('inspect_workbook', 'read_range', 'open_workbook'):
        raise ToolError(400, 'Tool not allowed')
    if not PYTHON.exists() or not AGENT.exists():
        raise ToolError(503, 'GridCraft local agent is not installed')
    started = time.time()
    try:
        proc = _run([str(PYTHON), str(AGENT), '--tool', name, f'--args={json.dumps(arguments)}'], TOOL_TIMEOUT)
    except subprocess.TimeoutExpired:
        log.warning('%s timed out after %ss', name, TOOL_TIMEOUT)
        raise ToolError(504, f'GridCraft did not answer within {TOOL_TIMEOUT}s')
    try:
        payload = json.loads((proc.stdout or '').strip().splitlines()[-1])
    except (ValueError, IndexError):
        payload = None
    if proc.returncode != 0 or not isinstance(payload, dict) or not payload.get('ok'):
        reason = failure_reason(proc.stdout, proc.stderr)
        if isinstance(payload, dict) and isinstance(payload.get('result'), str):
            reason = payload['result'][:300] or reason
        log.warning('%s failed (exit %s after %.1fs): %s', name, proc.returncode, time.time() - started, reason or '(no output)')
        raise ToolError(502, 'GridCraft could not do that', reason)
    return payload.get('result')


def with_gridcraft(fn, launch: bool = False):
    """Runs fn under run_lock, unless a request is running; returns (status, payload)."""
    if request_running.is_set() or not run_lock.acquire(timeout=TOOL_TIMEOUT):
        return 409, {'ok': False, 'error': 'GridCraft is busy with a request'}
    try:
        if not (ensure_gridcraft() if launch else tcp_open(CONTROL_PORT)):
            return 503, {'ok': False, 'error': "GridCraft isn't open on the Windows computer", 'code': 'not_running'}
        return 200, {'ok': True, **fn()}
    except ToolError as exc:
        return exc.status, {'ok': False, 'error': exc.error, **({'reason': exc.reason} if exc.reason else {})}
    except Exception as exc:
        log.exception('Workbook view failed')
        return 500, {'ok': False, 'error': f'Bridge failed: {type(exc).__name__}: {exc}'}
    finally:
        run_lock.release()


def read_sheet(sheet: str, rng: str):
    args = {'formatted': True}
    used, truncated = None, False
    if sheet:
        args['sheet'] = sheet
    if rng:
        clipped = clip_range(rng)
        if not clipped:
            raise ToolError(400, 'range must look like A1:Z200')
        used, truncated = clipped
        args['range'] = used
    return shape_range(call_tool('read_range', args), used, truncated)


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
        url = urlsplit(self.path)
        if url.path == '/workbooks':
            return self._json(200, {'ok': True, 'folder': WORKBOOKS_DIR.name, 'workbooks': list_workbooks()})
        if url.path == '/workbook':
            return self._json(*with_gridcraft(lambda: shape_workbook(call_tool('inspect_workbook', {}))))
        if url.path == '/range':
            q = parse_qs(url.query)
            sheet, rng = (q.get('sheet') or [''])[0][:100], (q.get('range') or [''])[0]
            return self._json(*with_gridcraft(lambda: read_sheet(sheet, rng)))
        if url.path != '/health':
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
        if self.path not in ('/run', '/open'):
            return self._json(404, {'ok': False, 'error': 'Not found'})
        # CORS only hides responses; it does not stop a page on another site from firing a simple POST.
        # Require an allowed Origin when a browser sends one, and a JSON content type (which forces a preflight).
        origin = self._origin()
        if origin and origin not in ALLOWED_ORIGINS:
            return self._json(403, {'ok': False, 'error': 'Origin not allowed'})
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
            return self._json(415, {'ok': False, 'error': 'Content-Type must be application/json'})
        try:
            length = min(int(self.headers.get('Content-Length', '0')), 1024 * 1024)
            payload = json.loads(self.rfile.read(length) or b'{}')
            if not isinstance(payload, dict):
                raise ValueError('expected a JSON object')
            prompt = str(payload.get('prompt', '')).strip()
        except Exception as exc:
            return self._json(400, {'ok': False, 'error': f'Invalid request: {exc}'})
        if self.path == '/open':
            return self._open(payload.get('name'))
        return self._run_prompt(prompt)

    def _open(self, name):
        # Only a workbook file in the GridCraft folder, never a path from the request.
        if not valid_workbook_name(name) or name.startswith('~$'):
            return self._json(400, {'ok': False, 'error': 'name must be a workbook file name'})
        path = WORKBOOKS_DIR / name
        if not path.is_file():
            return self._json(404, {'ok': False, 'error': 'No such workbook'})

        def open_it():
            call_tool('open_workbook', {'path': str(path)})
            return {'name': name}
        return self._json(*with_gridcraft(open_it, launch=True))

    def _run_prompt(self, prompt: str):
        if not prompt:
            return self._json(400, {'ok': False, 'error': 'prompt is required'})
        if len(prompt) > MAX_PROMPT_CHARS:
            return self._json(413, {'ok': False, 'error': f'prompt is longer than {MAX_PROMPT_CHARS} characters'})
        if not PYTHON.exists() or not AGENT.exists():
            return self._json(503, {'ok': False, 'error': 'GridCraft local agent is not installed'})
        # Take the lock before possibly launching GridCraft so concurrent requests can't start two instances.
        # A workbook read holds it for a few seconds at most, so wait for that; another request is a 409.
        if request_running.is_set() or not run_lock.acquire(timeout=TOOL_TIMEOUT):
            return self._json(409, {'ok': False, 'error': 'Another GridCraft request is already running'})
        request_running.set()
        try:
            if not ensure_gridcraft():
                return self._json(503, {'ok': False, 'error': f'GridCraft control port {CONTROL_PORT} is unavailable'})
            started = time.time()
            proc = run_agent(prompt)
            elapsed = round(time.time() - started, 2)
            if proc.returncode != 0:
                reason = failure_reason(proc.stdout, proc.stderr)
                log.warning('Agent exited %s after %ss: %s', proc.returncode, elapsed, reason or '(no output)')
                return self._json(500, {
                    'ok': False,
                    'error': 'GridCraft agent failed',
                    'reason': reason,
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
            log.warning('Agent timed out after %ss', RUN_TIMEOUT)
            return self._json(504, {'ok': False, 'error': f'GridCraft request exceeded {RUN_TIMEOUT}s'})
        except Exception as exc:
            return self._json(500, {'ok': False, 'error': f'Bridge failed to run the agent: {type(exc).__name__}: {exc}'})
        finally:
            request_running.clear()
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
