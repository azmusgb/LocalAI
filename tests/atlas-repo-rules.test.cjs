'use strict';

// Atlas redesign spec, PR 5: Pi Hub and Print lab get their own rules. Pi Hub's FastAPI routes (app decorators and
// APIRouter prefixes, {param} segments) are found, so its browser scripts link to the module serving each /api/ call and
// a call nothing serves is a finding. Print lab is a command-line package with no HTTP server; its modules sort into the
// same caller-to-data columns as Local AI. The page draws both repositories in those columns, not in generic ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const { buildModel, columnsFor } = require('../app/public/architecture.js');

const PIHUB = {
  'hub/app.py': [
    'from fastapi import FastAPI',
    'from . import lab, db',
    'app = FastAPI()',
    'app.include_router(lab.router)',
    '@app.get("/api/now")',
    'def now(): return db.read()',
    '@app.post("/api/lists/{list_id}/items")',
    'async def add(list_id: int): ...',
    '@app.api_route("/api/scan/{path:path}", methods=["GET", "POST"])',
    'def scan(path: str): ...',
    '@app.get("/healthz")',
    'def health(): ...',
    '# @app.get("/api/commented")',
  ].join('\n'),
  'hub/lab.py': [
    'from fastapi import APIRouter',
    'router = APIRouter(prefix="/api/lab")',
    '@router.get("")',
    'def index(): ...',
    '@router.get("/runs/{run_id}")',
    'def run(run_id: str): ...',
  ].join('\n'),
  'hub/db.py': 'def read(): ...\n',
  'hub/printer_control.py': 'def pause(): ...\n',
  'hub/now.py': 'def summary(): ...\n',
  'hub/plex.py': 'def recent(): ...\n',
  'hub/display_routes.py': 'from fastapi import APIRouter\nrouter = APIRouter(prefix="/api/display")\n@router.get("/feed")\ndef feed(): ...\n',
  'hub/display_feed.py': 'def build(): ...\n',
  'hub/static/js/main.js': [
    "fetch('/api/now');",
    "fetch(`/api/lists/${id}/items`, { method: 'POST' });",
    "fetch('/api/scan/folder/a.pdf');",
    "fetch('/api/nothing-here');",
  ].join('\n'),
  'hub/static/js/lab.js': [
    "fetch('/api/lab');",
    "fetch(`/api/lab/runs/${id}`);",
  ].join('\n'),
  'tests/test_now.py': 'from hub import app\n',
};

function scan(repo, files) {
  const code = `
import importlib.util, json, pathlib, tempfile
spec = importlib.util.spec_from_file_location('qa', ${JSON.stringify(path.join(ROOT, 'quick_arch.py'))})
qa = importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)
tmp = pathlib.Path(tempfile.mkdtemp()).resolve(); qa.ROOT = tmp
for name, text in json.loads(${JSON.stringify(JSON.stringify(files))}).items():
    f = tmp / name; f.parent.mkdir(parents=True, exist_ok=True); f.write_text(text, encoding='utf-8')
qa.SNAPSHOT.update(repo=${JSON.stringify(repo)}, gitDir='', commit='0' * 40, committedAt='', changedSince=None)
print(json.dumps(qa.build_graph(qa.collect_files())))`;
  const r = spawnSync(PY, ['-I', '-c', code], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const http = (g, source, target) => g.edges.find((e) => e.source === source && e.target === target && e.kind === 'http');

test("Pi Hub: FastAPI routes are found with their router prefix, and {param} segments match any value", { skip: !PY }, () => {
  const g = scan('pi-hub', PIHUB);
  const routes = g.httpRoutes.map((r) => `${r.match} ${r.path} ${r.module}`).sort();
  assert.deepEqual(routes, [
    'exact /api/lab hub/lab.py',
    'exact /api/now hub/app.py',
    'pattern /api/lab/runs/* hub/lab.py',
    'pattern /api/lists/*/items hub/app.py',
    'exact /api/display/feed hub/display_routes.py',
    'prefix /api/scan/ hub/app.py',
  ].sort(), 'only /api/ routes; /healthz and the commented decorator are not browser calls');
});

test('Pi Hub: each browser script links to the module that serves its calls', { skip: !PY }, () => {
  const g = scan('pi-hub', PIHUB);
  assert.deepEqual(http(g, 'hub/static/js/main.js', 'hub/app.py')?.paths, ['/api/lists/', '/api/now', '/api/scan/folder/a.pdf']);
  assert.deepEqual(http(g, 'hub/static/js/lab.js', 'hub/lab.py')?.paths, ['/api/lab', '/api/lab/runs/']);
  assert.deepEqual(g.danglingHttp.map((d) => d.path), ['/api/nothing-here']);
});

test("Pi Hub: modules sort into the caller-to-data domains", { skip: !PY }, () => {
  const g = scan('pi-hub', PIHUB);
  const domain = Object.fromEntries(g.nodes.map((n) => [n.id, n.domain]));
  assert.equal(domain['hub/static/js/main.js'], 'UI');
  assert.equal(domain['hub/app.py'], 'Platform');
  assert.equal(domain['hub/lab.py'], 'Workshop');
  assert.equal(domain['hub/printer_control.py'], 'Workshop');
  assert.equal(domain['hub/db.py'], 'Data');
  // Only modules that serve routes are the Server column; a feature module that serves none is Shared, not API.
  assert.equal(domain['hub/display_routes.py'], 'API');
  assert.equal(domain['hub/display_feed.py'], 'Workshop');
  assert.equal(domain['hub/now.py'], 'Core');
  assert.equal(domain['hub/plex.py'], 'Media');
});

test('Print lab: no HTTP server, so no routes and no findings; its package sorts by role', { skip: !PY }, () => {
  const g = scan('print-lab', {
    'lab/cli.py': 'from lab.loop import send\nfrom lab.records import store\n',
    'lab/page.py': 'from lab import findings\n',
    'lab/loop/send.py': 'from lab.checks import bed_fit\nfrom lab.printer import mqtt\n',
    'lab/printer/mqtt.py': '',
    'lab/checks/bed_fit.py': 'from lab.geometry import mesh\n',
    'lab/geometry/mesh.py': '',
    'lab/adapters/bambu.py': '',
    'lab/analysis/gcode.py': '',
    'lab/findings.py': '',
    'lab/records/store.py': '',
    'lab/history/lineage.py': '',
    'lab/watch.py': '',
  });
  assert.deepEqual(g.httpRoutes, []);
  assert.deepEqual(g.danglingHttp, []);
  const domain = Object.fromEntries(g.nodes.map((n) => [n.id, n.domain]));
  assert.deepEqual(
    ['lab/page.py', 'lab/cli.py', 'lab/watch.py', 'lab/loop/send.py', 'lab/printer/mqtt.py', 'lab/checks/bed_fit.py',
      'lab/geometry/mesh.py', 'lab/adapters/bambu.py', 'lab/analysis/gcode.py', 'lab/findings.py', 'lab/records/store.py',
      'lab/history/lineage.py'].map((id) => domain[id]),
    ['UI', 'Platform', 'Platform', 'Workshop', 'Workshop', 'Core', 'Core', 'Core', 'Core', 'Core', 'Data', 'Data']);
});

test('the page draws Pi Hub and Print lab in caller-to-data columns, and never drops a domain', () => {
  const node = (id, domain) => ({ id, domain });
  const pihub = buildModel({ nodes: [node('a.js', 'UI'), node('app.py', 'Platform'), node('x_routes.py', 'API'),
    node('lab.py', 'Workshop'), node('plex.py', 'Media'), node('now.py', 'Core'), node('db.py', 'Data'), node('odd', 'Claude')], edges: [] });
  const cols = columnsFor(pihub, 'pi-hub');
  assert.deepEqual(cols.map((c) => c.title), ['Browser', 'Entry', 'Server', 'Capabilities', 'Shared', 'Data']);
  assert.deepEqual(cols.find((c) => c.title === 'Capabilities').domains, ['Workshop', 'Media']);
  assert.ok(cols.find((c) => c.title === 'Shared').domains.includes('Claude'), 'a domain no rule names joins Shared');
  const lab = buildModel({ nodes: [node('page.py', 'UI'), node('cli.py', 'Platform'), node('send.py', 'Workshop'),
    node('mesh.py', 'Core'), node('store.py', 'Data')], edges: [] });
  assert.deepEqual(columnsFor(lab, 'print-lab').map((c) => c.title), ['Browser', 'Entry', 'Capabilities', 'Shared', 'Data'],
    'an empty column (Print lab has no server) is left out');
});
