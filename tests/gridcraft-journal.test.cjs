'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// host/gridcraft-agent/gridcraft_journal.py and gridcraft_ops.py against a fake GridCraft: a dict of cells with an
// undo stack whose visible list is cut to 20 labels, like the real one.
const agentDir = path.resolve(__dirname, '../host/gridcraft-agent');
const python = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0);

const FAKE = String.raw`
import asyncio, json, sys
sys.path.insert(0, sys.argv[1])
import gridcraft_journal as J
import gridcraft_ops as O

class Block:
    def __init__(self, text): self.text = text
class Result:
    def __init__(self, data=None, error=None):
        self.is_error = error is not None
        self.content = [Block(error if error is not None else json.dumps(data))]

class Fake:
    def __init__(self):
        self.cells = {('Sales', 'B2'): 1, ('Sales', 'B3'): '=B2*2'}
        self.undo = ['Older'] * 25
        self.calls = []
        self.saved = False
    def value(self, sheet, ref, formulas):
        v = self.cells.get((sheet, ref))
        if isinstance(v, str) and v.startswith('=') and not formulas: return 99
        return v
    def grid(self, sheet, rng, formulas):
        r1, c1, r2, c2 = J.parse_range(rng)
        return [[self.value(sheet, J.num_to_col(c) + str(r), formulas) for c in range(c1, c2 + 1)] for r in range(r1, r2 + 1)]
    async def call(self, name, args):
        self.calls.append(name)
        sheet = args.get('sheet') or 'Sales'
        if name == 'inspect_workbook':
            return Result({'title': 'Q', 'path': 'C:\\Users\\x\\Q.xlsx', 'dirty': len(self.undo) > 25 and not self.saved, 'activeSheet': 0,
                           'undo': self.undo[:20], 'sheets': [{'name': 'Sales', 'usedRange': 'A1:C300', 'cells': 5, 'tables': [{}], 'charts': []}, {'name': 'Empty', 'usedRange': None, 'cells': 0}]})
        if name == 'read_range':
            if sheet not in ('Sales', 'Empty'): return Result(error='read_range: no sheet named ' + sheet)
            return Result({'sheet': sheet, 'range': args['range'], 'values': self.grid(sheet, args['range'], args.get('formulas'))})
        if name == 'set_cell':
            s, ref = J.split_sheet(args['cell'])
            if s not in (None, 'Sales', 'Empty'): return Result(error='set_cell: no sheet named ' + s)
            self.cells[(s or 'Sales', ref)] = args['input']; self.undo.insert(0, 'Enter Cell'); return Result({'ok': True})
        if name == 'write_range':
            s, ref = J.split_sheet(args['range']); r, c = J.parse_cell(ref)
            for i, row in enumerate(args['values']):
                for k, v in enumerate(row): self.cells[(s or 'Sales', J.num_to_col(c + k) + str(r + i))] = v
            self.undo.insert(0, 'Set Values'); return Result({'ok': True})
        if name == 'format_range':
            self.undo[0:0] = ['Fill Color', 'Bold']; return Result({'applied': ['home.bold', 'home.fillColor'], 'range': args['range']})
        if name == 'execute_command':
            if args['command'] != 'sheet.activate': self.undo.insert(0, 'Insert Rows')
            return Result({'ok': True})
        if name == 'undo':
            del self.undo[:args['steps']]; return Result({'undone': 'x'})
        if name == 'save_workbook':
            self.saved = True; return Result({'saved': True})
        return Result(error='unknown tool ' + name)

async def scenario(name):
    f = Fake()
    if name == 'review':
        j = J.Journal('review', f.call, J.allowed_tools('review', {'read_range', 'set_cell', 'write_range', 'format_range', 'execute_command', 'save_workbook', 'inspect_workbook'}))
        await j.call('set_cell', {'cell': 'Sales!B2', 'input': '5'})
        await j.call('write_range', {'range': 'C1', 'values': [['a', 'b'], ['=A1', None]]})
        await j.call('format_range', {'range': 'B2:B3', 'bold': True, 'fillColor': '#ff0'})
        await j.call('execute_command', {'command': 'sheet.activate', 'params': {'name': 'Sales'}})
        await j.call('execute_command', {'command': 'rows.insert', 'params': {'range': 'A5'}})
        refused = ''
        try: await j.call('save_workbook', {})
        except J.ToolRefused as e: refused = str(e)
        bad = await j.call('set_cell', {'cell': 'Nope!A1', 'input': '1'})
        out = await j.finish()
        out['refused'] = refused; out['saved_fake'] = f.saved
        return out
    if name == 'read':
        allowed = J.allowed_tools('read', {'read_range', 'set_cell', 'evaluate_formula', 'execute_command', 'list_commands', 'inspect_workbook'})
        j = J.Journal('read', f.call, allowed)
        try: await j.call('set_cell', {'cell': 'B2', 'input': '5'}); refused = ''
        except J.ToolRefused as e: refused = str(e)
        return {'allowed': sorted(allowed), 'refused': refused, 'calls': f.calls}
    if name == 'workbook':
        return {'default': await O.workbook(f.call, {}), 'paged': await O.workbook(f.call, {'sheet': 'Sales', 'range': 'A101:C900'}),
                'empty': await O.workbook(f.call, {'sheet': 'Empty'})}
    if name == 'missing-sheet':
        try: await O.workbook(f.call, {'sheet': 'Nope'})
        except O.OpError as e: return {'status': e.status, 'error': str(e)}
    if name == 'discard':
        j = J.Journal('review', f.call, {'set_cell', 'format_range'})
        await j.call('set_cell', {'cell': 'B2', 'input': '5'}); await j.call('format_range', {'range': 'B2'})
        info = await j.finish()
        ok = await O.discard(f.call, {'steps': info['undoSteps'], 'undoTop': info['undoTop']})
        # Someone changes the workbook in GridCraft afterwards: an older journal no longer matches.
        f.undo.insert(0, 'Typed in GridCraft')
        try: await O.discard(f.call, {'steps': 1, 'undoTop': info['undoTop']}); conflict = None
        except O.OpError as e: conflict = e.status
        return {'ok': ok, 'undo': f.undo[:3], 'conflict': conflict, 'steps': info['undoSteps']}
    if name == 'keep':
        return await O.keep(f.call, {})
    if name == 'set_cell':
        first = await O.set_cell(f.call, {'sheet': 'Sales', 'cell': 'B2', 'input': '=B3+1'})
        second = await O.set_cell(f.call, {'sheet': 'Sales', 'cell': 'C7', 'input': ''})
        # The appliance joins the two into one Direct edit: both steps, the newest undo labels.
        undone = await O.discard(f.call, {'steps': first['journal']['undoSteps'] + second['journal']['undoSteps'], 'undoTop': second['journal']['undoTop']})
        bad = {}
        for label, req in [('lower', {'cell': 'b2'}), ('row 0', {'cell': 'A0'}), ('4 letters', {'cell': 'AAAA1'}), ('8 digits', {'cell': 'A12345678'}),
                           ('range', {'cell': 'A1:B2'}), ('qualified', {'cell': 'Sales!B2'}), ('no cell', {'cell': None}), ('no sheet', {'sheet': ''}),
                           ('long sheet', {'sheet': 'x' * 101}), ('newline', {'sheet': 'a\nb'}), ('number', {'input': 5}), ('no input', {'input': None}),
                           ('long input', {'input': 'x' * 8193})]:
            calls = len(f.calls)
            try: await O.set_cell(f.call, {'sheet': 'Sales', 'cell': 'B2', 'input': '1', **req}); bad[label] = 'accepted'
            except O.OpError as e: bad[label] = [e.status, len(f.calls) - calls]
        try: await O.run('set_cell', {'sheet': 'Sales', 'cell': 'b2', 'input': '1'}); early = 'connected'
        except O.OpError as e: early = e.status
        calls = len(f.calls)
        try: await O.set_cell(f.call, {'sheet': 'Nope', 'cell': 'B2', 'input': '1'}); missing = None
        except O.OpError as e: missing = [e.status, str(e), f.calls[calls:]]
        return {'first': first, 'second': second, 'undone': undone, 'undo': f.undo[:3],
                'saved': f.saved, 'saves': f.calls.count('save_workbook'), 'bad': bad, 'early': early, 'missing': missing,
                'longest': len(O.cell_edit({'sheet': 'x' * 100, 'cell': 'XFD1048576', 'input': 'x' * 8192})[2]),
                'qualified': [O.qualified('Sales', 'B2'), O.qualified('Q1 Sales', 'B2'), O.qualified("Bob's", 'A1'), O.qualified('2024', 'A1')]}

pure = {
    'delta': [J.undo_delta(['a', 'b'], ['x', 'a', 'b']), J.undo_delta(['a'] * 20, ['n', 'm'] + ['a'] * 18), J.undo_delta([], ['x', 'y']), J.undo_delta(['a', 'b'], ['a', 'b'])],
    'target': [J.write_target('write_range', {'range': "'My Sheet'!B3", 'values': [[1, 2, 3], [4]]}), J.write_target('set_cell', {'cell': 'AA10'}), J.write_target('write_range', {'range': 'B3', 'values': []})],
    'window': [J.window_range('B2:I17'), J.window_range('A1:AZ250'), J.window_range(None)],
    'cols': [J.num_to_col(1), J.num_to_col(27), J.num_to_col(702), J.col_to_num('AA')],
}
print(json.dumps({'pure': pure, **{n: asyncio.run(scenario(n)) for n in sys.argv[2:]}}))
`;

function run(...scenarios) {
  const r = spawnSync(python, ['-I', '-c', FAKE, agentDir, ...scenarios], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const skip = !python && 'no python';

test('A1 helpers, target extents and the undo-list shift', { skip }, () => {
  const { pure } = run();
  assert.deepEqual(pure.delta, [1, 2, 2, 0]);
  assert.deepEqual(pure.target, [['My Sheet', 'B3:D4'], [null, 'AA10'], null]);
  assert.deepEqual(pure.window, [['A1:I17', false], ['A1:AN100', true], [null, false]]);
  assert.deepEqual(pure.cols, ['A', 'AA', 'ZZ', 27]);
});

test('Review mode records every edit cell by cell, counts undo steps, and refuses to save', { skip }, () => {
  const { review } = run('review');
  assert.equal(review.mode, 'review');
  assert.deepEqual(review.edits[0], { tool: 'set_cell', sheet: 'Sales', range: 'B2', before: [[1]], after: [['5']], afterValues: [['5']] });
  assert.deepEqual(review.edits[1], { tool: 'write_range', sheet: 'Sales', range: 'C1:D2', before: [[null, null], [null, null]], after: [['a', 'b'], ['=A1', null]], afterValues: [['a', 'b'], [99, null]] });
  assert.equal(review.edits.length, 2, 'a write GridCraft rejected is not an edit');
  assert.deepEqual(review.changes.map(c => c.summary), ['Formatted B2:B3: bold, fillColor', 'Ran sheet.activate on Sales', 'Ran rows.insert on A5']);
  // set_cell 1 + write_range 1 + format_range 2 + sheet.activate 0 + rows.insert 1
  assert.equal(review.undoSteps, 5);
  assert.deepEqual(review.undoTop, ['Insert Rows', 'Fill Color', 'Bold', 'Set Values', 'Enter Cell']);
  assert.match(review.refused, /owner reviews the changes/);
  assert.equal(review.saved_fake, false);
  assert.equal(review.saved, false);
});

test('Read only mode offers only reading tools and never forwards a write', { skip }, () => {
  const { read } = run('read');
  assert.deepEqual(read.allowed, ['evaluate_formula', 'inspect_workbook', 'read_range']);
  assert.match(read.refused, /not available in Read only mode/);
  assert.deepEqual(read.calls, []);
});

test('The workbook view shows a window from A1, pages, and hides the host path', { skip }, () => {
  const { workbook } = run('workbook');
  const d = workbook.default;
  assert.equal(d.file, 'Q.xlsx');
  assert.equal(d.sheet, 'Sales');
  assert.equal(d.range, 'A1:C100');
  assert.equal(d.truncated, true);
  assert.equal(d.values.length, 100);
  assert.equal(d.formulas[2][1], '=B2*2');
  assert.equal(d.raw[2][1], 99);
  assert.deepEqual(d.sheets[0], { name: 'Sales', usedRange: 'A1:C300', cells: 5, tables: 1, charts: 0 });
  assert.equal(workbook.paged.range, 'A101:C200', 'a requested page is clamped to 100 rows');
  assert.deepEqual(workbook.empty.values, []);
  assert.equal(JSON.stringify(workbook).includes('Users'), false);
  const { 'missing-sheet': missing } = run('missing-sheet');
  assert.deepEqual(missing, { status: 404, error: 'No sheet named Nope' });
});

test('Discard undoes exactly the request\'s steps, and refuses once GridCraft has moved on', { skip }, () => {
  const { discard } = run('discard');
  assert.equal(discard.steps, 3);
  assert.equal(discard.ok.undone, 3);
  assert.deepEqual(discard.undo.slice(1), ['Older', 'Older']);
  assert.equal(discard.conflict, 409);
  const { keep } = run('keep');
  assert.deepEqual(keep, { dirty: false });
});

test('A cell changed by hand is journaled like a Review request, never saved, and its input is checked', { skip }, () => {
  const { set_cell: r } = run('set_cell');
  assert.deepEqual(r.first.journal.edits, [{ tool: 'set_cell', sheet: 'Sales', range: 'B2', before: [[1]], after: [['=B3+1']], afterValues: [[99]] }]);
  assert.equal(r.first.journal.mode, 'review');
  assert.equal(r.first.journal.undoSteps, 1);
  assert.equal(r.first.journal.saved, false);
  assert.deepEqual(r.first.undoBefore, ['Older', 'Older', 'Older', 'Older', 'Older'], 'the undo list before the edit, so the appliance can tell nothing came between');
  assert.deepEqual(r.second.undoBefore, r.first.journal.undoTop, 'a second edit sits right on top of the first');
  assert.deepEqual(r.second.journal.edits[0].after, [['']], 'an empty input clears the cell');
  assert.deepEqual(r.undone, { dirty: false, undone: 2 }, 'Discard undoes exactly both edits');
  assert.deepEqual(r.undo, ['Older', 'Older', 'Older'], 'and only those: the undo list is back where it was');
  assert.equal(r.saved, false);
  assert.equal(r.saves, 0, 'a cell edit never saves the workbook');
  for (const [label, v] of Object.entries(r.bad)) assert.deepEqual(v, [400, 0], `${label}: refused before GridCraft is asked anything`);
  assert.equal(r.early, 400, 'the op refuses a bad cell before it connects to GridCraft');
  assert.deepEqual(r.missing, [404, 'No sheet named Nope', ['inspect_workbook']], 'an unknown sheet is never written');
  assert.equal(r.longest, 8192);
  assert.deepEqual(r.qualified, ['Sales!B2', "'Q1 Sales'!B2", "'Bob''s'!A1", "'2024'!A1"]);
});
