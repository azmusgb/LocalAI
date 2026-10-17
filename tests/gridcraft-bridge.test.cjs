'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bridge = path.resolve(__dirname, '../host/gridcraft-bridge.py');
const python = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0);

// Loads the bridge as a module (its server only starts under __main__) and runs failure_reason on each case.
function reasons(cases) {
  const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.failure_reason(o, e) for o, e in json.loads(sys.stdin.read())]))`;
  const r = spawnSync(python, ['-I', '-c', code, bridge], { input: JSON.stringify(cases), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('a failed GridCraft run says why', { skip: !python && 'no python' }, () => {
  const traceback = 'Traceback (most recent call last):\n  File "gridcraft_ai.py", line 9\nhttpx.ConnectError: [WinError 10061] connection refused\n';
  assert.deepEqual(reasons([
    ['[agent] thinking\n', traceback],
    ['[agent] step 1\nModel returned no tool call\n', ''],
    ['', 'RuntimeError: ' + 'x'.repeat(500)],
    ['', ''],
  ]), [
    'httpx.ConnectError: [WinError 10061] connection refused',
    'Model returned no tool call',
    ('RuntimeError: ' + 'x'.repeat(500)).slice(0, 300),
    '',
  ]);
});

// Runs `expr` (Python, with the bridge module as m and the JSON input as data) and returns its JSON result.
function py(expr, data = null, env = {}) {
  const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
data = json.loads(sys.stdin.read())
print(json.dumps(${expr}))`;
  const r = spawnSync(python, ['-I', '-c', code, bridge], { input: JSON.stringify(data), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('Spreadsheets can only open a workbook file by name, never a path', { skip: !python && 'no python' }, () => {
  const names = ['Budget.xlsx', 'Q3 sales.XLSM', 'old.xls', 'list.csv', 'calc.ods',
    '..\\secret.xlsx', '../secret.xlsx', 'C:\\Users\\x\\Book.xlsx', 'sub/Book.xlsx', 'Book.xlsx.exe', 'notes.txt', '.hidden.xlsx',
    'a..b.xlsx', ' Book.xlsx', 'Book', '', 'x'.repeat(200) + '.xlsx', 'line\nbreak.xlsx'];
  assert.deepEqual(py('[m.valid_workbook_name(n) for n in data] + [m.valid_workbook_name(None), m.valid_workbook_name(5)]', names),
    [true, true, true, true, true, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false]);
});

test('workbook reads are capped at 200 rows and 30 columns', { skip: !python && 'no python' }, () => {
  assert.deepEqual(py('[m.clip_range(r) for r in data]', ['A1:F20', 'a1:zz5000', 'B3', 'C10:A1', 'A1:AD200', 'A1:AE201', 'Sheet1!A1', '', 'A0B']),
    [['A1:F20', false], ['A1:AD200', true], ['B3:B3', false], ['A1:C10', false], ['A1:AD200', false], ['A1:AD200', true], null, null, null]);
  const big = Array.from({ length: 250 }, (_, r) => Array.from({ length: 40 }, (_, c) => r * 100 + c));
  const shaped = py('m.shape_range(data, "A1:AN250", False)', big);
  assert.equal(shaped.rows.length, 200);
  assert.equal(shaped.rows[0].length, 30);
  assert.equal(shaped.truncated, true);
  assert.deepEqual(py('m.shape_range(data, None, False)', { range: 'Sheet1!$B$2:$D$3', values: [[1, 'x', null], [true, { error: '#DIV/0!' }, { value: 2, formatted: '$2.00' }]] }),
    { range: 'B2:D3', rows: [[1, 'x', null], [true, { error: '#DIV/0!' }, '$2.00']], truncated: false });
});

test('the workbook summary keeps file names, not host paths', { skip: !python && 'no python' }, () => {
  const book = py('m.shape_workbook(data)', {
    title: 'Quarterly Sales', path: 'C:\\Users\\owner\\Documents\\GridCraft\\Quarterly-Sales-Dashboard.xlsx', dirty: true,
    sheets: [{ name: 'Sales', used_range: 'A1:F20', cell_count: 120 }, { name: 'Notes', used_range: null, cell_count: 0 }],
    selection: { sheet: 'Sales', range: 'B2' }
  });
  assert.deepEqual(book, { title: 'Quarterly Sales', file: 'Quarterly-Sales-Dashboard.xlsx', dirty: true, activeSheet: 'Sales',
    sheets: [{ name: 'Sales', usedRange: 'A1:F20', cells: 120 }, { name: 'Notes', usedRange: null, cells: 0 }] });
  assert.doesNotMatch(JSON.stringify(book), /Users/);
});

test('the workbook list is only spreadsheet files in the GridCraft folder', { skip: !python && 'no python' }, () => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridcraft-books-'));
  try {
    for (const f of ['Budget.xlsx', 'b.csv', '~$Budget.xlsx', 'notes.txt']) fs.writeFileSync(path.join(dir, f), 'x');
    fs.mkdirSync(path.join(dir, 'Archive.xlsx'));
    fs.writeFileSync(path.join(dir, 'Archive.xlsx', 'Old.xlsx'), 'x');
    const list = py('m.list_workbooks()', null, { GRIDCRAFT_WORKBOOKS_DIR: dir });
    assert.deepEqual(list.map(w => w.name), ['b.csv', 'Budget.xlsx']);
    assert.equal(list[0].size, 1);
    assert.ok(list[0].modified > 1.7e9);
    assert.deepEqual(py('m.list_workbooks()', null, { GRIDCRAFT_WORKBOOKS_DIR: path.join(dir, 'missing') }), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
