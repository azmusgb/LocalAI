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
        if name == 'open_workbook':
            return Result({'opened': args['path']})
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

    if name == 'typed-between':
        # A Review request changes B2; then someone types C9 in GridCraft, which adds the same generic label on top of
        # a list of the same labels: the visible undo list looks exactly as the request left it.
        f.undo = ['Enter Cell'] * 25
        j = J.Journal('review', f.call, {'set_cell'})
        await j.call('set_cell', {'cell': 'B2', 'input': '5'})
        info = await j.finish()
        f.cells[('Sales', 'C9')] = 'typed'; f.undo.insert(0, 'Enter Cell')
        labels_only = await O.discard(f.call, {'steps': 1, 'undoTop': info['undoTop']})
        f.undo.insert(0, 'Enter Cell')  # put the step back for the second try
        try: await O.discard(f.call, {'steps': 1, 'undoTop': info['undoTop'], 'fingerprint': info['fingerprint']}); checked = None
        except O.OpError as e: checked = [e.status, str(e)]
        # Nothing typed in between: the fingerprint matches and Discard undoes the request.
        g = Fake(); k = J.Journal('review', g.call, {'set_cell'})
        await k.call('set_cell', {'cell': 'B2', 'input': '5'})
        same = await k.finish()
        clean = await O.discard(g.call, {'steps': 1, 'undoTop': same['undoTop'], 'fingerprint': same['fingerprint']})
        state = await O.state(g.call, {})
        read_only = await J.Journal('read', g.call, {'read_range'}).finish()
        return {'labels_only': labels_only, 'checked': checked, 'clean': clean, 'print': info['fingerprint'], 'cells': g.cells.get(('Sales', 'B2')),
                'state': state, 'read_print': read_only['fingerprint'], 'big': await J.fingerprint(BigFake().call)}
    if name == 'file-commands':
        out = {}
        for mode in ('review', 'apply'):
            j = J.Journal(mode, f.call, J.allowed_tools(mode, {'execute_command', 'save_workbook'}))
            for command in ('file.save', 'file.saveAs', 'saveAs', 'workbook.close', 'app.quit', 'file.open', 'export.pdf', 'file.saveBytes', 'link.open',
                            'data.fromTextCsv', 'edit.undo', 'edit.paste', 'automate.runScript', 'view.macros', 'Edit.Redo',
                            'sheet.activate', 'rows.insert', 'home.bold', 'cell.set', 'home.insertRows', 'data.sort', 'insert.chart'):
                try: await j.call('execute_command', {'command': command, 'params': {}}); out[f'{mode} {command}'] = 'ran'
                except J.ToolRefused as e: out[f'{mode} {command}'] = 'refused: ' + str(e)
        j = J.Journal('apply', f.call, {'save_workbook'})
        try: await j.call('save_workbook', {'path': 'C:/elsewhere.xlsx'}); out['save elsewhere'] = 'ran'
        except J.ToolRefused as e: out['save elsewhere'] = 'refused: ' + str(e)
        out['saved'] = f.saved
        return out
    if name == 'entries':
        told = []
        j = J.Journal('review', f.call, {'set_cell', 'format_range'}, told.append)
        await j.call('set_cell', {'cell': 'B2', 'input': '5'})
        await j.call('set_cell', {'cell': 'Nope!A1', 'input': '1'})
        await j.call('format_range', {'range': 'B2', 'bold': True})
        return [sorted(k for k in e if k != 'saved') + [e.get('steps')] for e in told]
    if name == 'open-dirty':
        import os, tempfile
        d = tempfile.mkdtemp(); open(os.path.join(d, 'Budget.xlsx'), 'w').close(); os.environ['GRIDCRAFT_WORKBOOKS_DIR'] = d
        clean = await O.open_book(f.call, {'name': 'Budget.xlsx'})
        f.undo.insert(0, 'Enter Cell')
        try: await O.open_book(f.call, {'name': 'Budget.xlsx'}); dirty = None
        except O.OpError as e: dirty = [e.status, str(e)]
        return {'clean': clean, 'dirty': dirty}

    if name == 'session':
        import contextlib, time
        opened, mode = [], {'fail': None, 'hang': False}
        @contextlib.asynccontextmanager
        async def open_client():
            if mode['fail'] == 'connect': raise OSError('control port refused')
            opened.append(1)
            class Client:
                async def call_tool(self, tool, args):
                    if mode['hang']: await asyncio.sleep(10)
                    if mode['fail'] == 'before' and tool == 'inspect_workbook': raise BrokenPipeError('pipe closed')
                    if mode['fail'] == 'after' and tool == 'set_cell':
                        await f.call(tool, args); raise BrokenPipeError('pipe closed')
                    return await f.call(tool, args)
            yield Client()
        session = O.Session(open_client, idle=0.3)
        def go(op, req, timeout=5):
            try: return ['ok', session.run(op, req, timeout)]
            except O.OpError as e: return ['OpError', e.status]
            except (O.Retry, O.Lost, TimeoutError) as e: return [type(e).__name__]
        out = {}
        out['view'] = go('workbook', {})[0]
        out['edit'] = go('set_cell', {'sheet': 'Sales', 'cell': 'B2', 'input': '7'})[0]
        out['missing'] = go('workbook', {'sheet': 'Nope'})
        out['bad'] = go('set_cell', {'sheet': 'Sales', 'cell': 'b2', 'input': '7'})
        out['reused'] = len(opened)
        mode['fail'] = 'before'; out['before'] = go('workbook', {})
        mode['fail'] = 'after'; out['after'] = go('set_cell', {'sheet': 'Sales', 'cell': 'B3', 'input': '8'})
        mode['fail'] = 'connect'; out['connect'] = go('workbook', {})
        mode['fail'] = None; out['again'] = go('workbook', {})[0]
        out['opened'] = len(opened)
        time.sleep(0.6); go('workbook', {}); out['after_idle'] = len(opened)
        mode['hang'] = True; out['hang'] = go('workbook', {}, timeout=0.3)
        mode['hang'] = False; out['recovered'] = go('workbook', {})[0]; out['last'] = len(opened)
        out['folder'] = 'items' in session.run('workbooks', {}, 5)
        return out

class BigFake(Fake):
    async def call(self, name, args):
        if name == 'inspect_workbook':
            return Result({'undo': [], 'sheets': [{'name': 'Big', 'usedRange': 'A1:Z5000'}]})
        return await super().call(name, args)

pure = {
    'words': [J.command_words('file.saveAs'), J.command_words('rows.insert')],
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

test('Discard refuses once a cell was typed in GridCraft, even when the undo labels look the same', { skip }, () => {
  const { 'typed-between': r } = run('typed-between');
  assert.equal(r.labels_only.undone, 1, 'the undo labels alone could not tell (why the fingerprint exists)');
  assert.deepEqual(r.checked, [409, 'The workbook changed in GridCraft after this request, so undoing it could remove other work.']);
  assert.match(r.print, /^[0-9a-f]{32}$/);
  assert.deepEqual(r.clean, { dirty: false, undone: 1 });
  assert.equal(r.state.fingerprint.length, 32);
  assert.deepEqual(r.state.undoTop, ['Older', 'Older', 'Older', 'Older', 'Older']);
  assert.equal(r.read_print, null, 'a request that left nothing to undo needs no fingerprint');
  assert.equal(r.big, null, 'a workbook too large to fingerprint falls back to the labels');
});

test('execute_command may not reach files, windows, scripts, the clipboard or undo history, and nothing saves elsewhere', { skip }, () => {
  const { 'file-commands': r, pure } = run('file-commands');
  assert.deepEqual(pure.words, [['file', 'save', 'as'], ['rows', 'insert']]);
  for (const mode of ['review', 'apply']) {
    for (const c of ['file.save', 'file.saveAs', 'saveAs', 'workbook.close', 'app.quit', 'file.open', 'export.pdf', 'file.saveBytes', 'link.open', 'data.fromTextCsv', 'edit.undo', 'edit.paste', 'automate.runScript', 'view.macros', 'Edit.Redo']) assert.match(r[`${mode} ${c}`], /^refused: The command .* is not available to requests/, `${mode} ${c}`);
    for (const c of ['sheet.activate', 'rows.insert', 'home.bold', 'cell.set', 'home.insertRows', 'data.sort', 'insert.chart']) assert.equal(r[`${mode} ${c}`], 'ran', `${mode} ${c}`);
  }
  assert.match(r['apply file.save'], /use save_workbook to save/);
  assert.doesNotMatch(r['review file.save'], /save_workbook/, 'Review is not told to save');
  assert.match(r['save elsewhere'], /^refused: save_workbook saves the open workbook to its own file/);
  assert.equal(r.saved, false);
});

test('each write is announced as it starts and as it is recorded, so a stopped request leaves a record', { skip }, () => {
  const { entries } = run('entries');
  assert.deepEqual(entries, [['pending', null], ['edit', 'steps', 1], ['pending', null], ['settled', null], ['pending', null], ['change', 'steps', 2]]);
});

test('opening another workbook waits until the open one has no unsaved changes', { skip }, () => {
  const { 'open-dirty': r } = run('open-dirty');
  assert.deepEqual(r.clean, { file: 'Budget.xlsx' });
  assert.deepEqual(r.dirty, [409, 'The open workbook has unsaved changes. Keep or discard them first, then open another workbook.']);
});

test('the bridge keeps one GridCraft connection for ops, and never repeats an op that may have changed the workbook', { skip, timeout: 30000 }, () => {
  const { session: r } = run('session');
  assert.equal(r.view, 'ok');
  assert.equal(r.edit, 'ok');
  assert.deepEqual(r.missing, ['OpError', 404]);
  assert.deepEqual(r.bad, ['OpError', 400], 'a bad cell is refused before GridCraft is asked');
  assert.equal(r.reused, 1, 'one connection for every op so far');
  assert.deepEqual(r.before, ['Retry'], 'broken before any write: safe to run again');
  assert.deepEqual(r.after, ['Lost'], 'broken after the write: never run twice');
  assert.deepEqual(r.connect, ['Retry']);
  assert.equal(r.again, 'ok');
  assert.equal(r.opened, 3, 'a new connection after each failure');
  assert.equal(r.after_idle, 4, 'an idle connection is closed and opened again');
  assert.deepEqual(r.hang, ['TimeoutError']);
  assert.equal(r.recovered, 'ok', 'a hung connection is dropped and the next op gets a new one');
  assert.equal(r.last, 5);
  assert.equal(r.folder, true, 'listing the folder needs no connection');
});
