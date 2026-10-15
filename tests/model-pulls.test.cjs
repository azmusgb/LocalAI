const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelPulls, validModelName } = require('../app/model-pulls.js');

const ndjson = (lines, { split = false } = {}) => {
  const text = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  // Split mid-line to prove partial chunks are reassembled.
  const parts = split ? [text.slice(0, 17), text.slice(17, 60), text.slice(60)] : [text];
  return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } }));
};
const settle = () => new Promise(r => setTimeout(r, 20));

test('model names are validated', () => {
  for (const ok of ['qwen3:4b-instruct', 'llama3.2', 'library/gemma3:4b', 'hf.co/user/model:Q4_K_M']) assert.equal(validModelName(ok), ok);
  for (const bad of ['', ' ', '../etc', 'a b', 'x;rm -rf', ':tag', 'a'.repeat(121)]) assert.equal(validModelName(bad), null);
});

test('a download reports summed layer progress and finishes on success', async () => {
  const calls = [];
  let finished = null;
  const pulls = createModelPulls({ baseUrl: 'http://o', onFinish: p => { finished = p }, fetchImpl: async (url, opt) => { calls.push([url, JSON.parse(opt.body)]); return ndjson([
    { status: 'pulling manifest' },
    { status: 'pulling a', digest: 'a', total: 100, completed: 40 },
    { status: 'pulling b', digest: 'b', total: 50, completed: 50 },
    { status: 'pulling a', digest: 'a', total: 100, completed: 100 },
    { status: 'success' }], { split: true }) } });
  assert.equal(pulls.start('qwen3:4b').state, 'running');
  await settle();
  const [p] = pulls.list();
  assert.deepEqual([p.state, p.completed, p.total], ['done', 150, 150]);
  assert.equal(calls[0][0], 'http://o/api/pull');
  assert.equal(calls[0][1].model, 'qwen3:4b');
  assert.equal(finished.state, 'done');
});

test('an Ollama error or a cut-off stream marks the download failed', async () => {
  const errored = createModelPulls({ baseUrl: 'http://o', fetchImpl: async () => ndjson([{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }]) });
  errored.start('nope:1b'); await settle();
  assert.deepEqual([errored.list()[0].state, errored.list()[0].error], ['failed', 'pull model manifest: file does not exist']);
  const cut = createModelPulls({ baseUrl: 'http://o', fetchImpl: async () => ndjson([{ status: 'pulling a', digest: 'a', total: 9, completed: 3 }]) });
  cut.start('x:1b'); await settle();
  assert.equal(cut.list()[0].state, 'failed');
});

test('starting the same model twice reuses the running download; cancel stops it', async () => {
  let calls = 0, abortedWith = null;
  const pulls = createModelPulls({ baseUrl: 'http://o', fetchImpl: (url, opt) => { calls++; return new Promise((_, reject) => opt.signal.addEventListener('abort', () => { abortedWith = 'abort'; reject(new Error('aborted')) })) } });
  pulls.start('m:1'); pulls.start('m:1');
  assert.equal(calls, 1);
  assert.equal(pulls.cancel('m:1').state, 'cancelled');
  await settle();
  assert.equal(abortedWith, 'abort');
  assert.equal(pulls.list()[0].state, 'cancelled');
  assert.throws(() => pulls.cancel('m:1'), /No download/);
});

test('remove refuses protected and running models and maps Ollama answers', async () => {
  const seen = [];
  const pulls = createModelPulls({ baseUrl: 'http://o', protectedModels: () => ['main:4b'], fetchImpl: async (url, opt) => { seen.push([url, opt.method, JSON.parse(opt.body).model]); return new Response('', { status: JSON.parse(opt.body).model === 'gone:1' ? 404 : 200 }) } });
  await assert.rejects(pulls.remove('main:4b'), e => e.status === 409);
  await assert.rejects(pulls.remove('bad name'), e => e.status === 400);
  await assert.rejects(pulls.remove('gone:1'), e => e.status === 404);
  assert.deepEqual(await pulls.remove('old:1'), { name: 'old:1', removed: true });
  assert.deepEqual(seen.at(-1), ['http://o/api/delete', 'DELETE', 'old:1']);
});

test('a local context variant is made from its library model when the variant is not in the library', async () => {
  const calls = [];
  const pulls = createModelPulls({ baseUrl: 'http://o', fetchImpl: async (url, opt) => {
    const body = JSON.parse(opt.body); calls.push([url.replace('http://o', ''), body.model, body.from, body.parameters?.num_ctx]);
    if (url.endsWith('/api/create')) return new Response('{"status":"success"}');
    if (body.model === 'qwen3:4b-instruct-32k') return ndjson([{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }]);
    return ndjson([{ status: 'pulling a', digest: 'a', total: 10, completed: 10 }, { status: 'success' }]);
  } });
  pulls.start('qwen3:4b-instruct-32k'); await settle();
  assert.deepEqual(calls, [['/api/pull', 'qwen3:4b-instruct-32k', undefined, undefined], ['/api/pull', 'qwen3:4b-instruct', undefined, undefined], ['/api/create', 'qwen3:4b-instruct-32k', 'qwen3:4b-instruct', 32768]]);
  assert.equal(pulls.list()[0].state, 'done');
});

test('other pull errors are not retried as a variant', async () => {
  let calls = 0;
  const pulls = createModelPulls({ baseUrl: 'http://o', fetchImpl: async () => { calls++; return ndjson([{ error: 'disk full' }]) } });
  pulls.start('qwen3:4b-instruct-32k'); await settle();
  assert.deepEqual([calls, pulls.list()[0].error], [1, 'disk full']);
});
