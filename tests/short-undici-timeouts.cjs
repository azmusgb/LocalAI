'use strict';

// Preload (node --require) that shortens the global fetch's built-in timeouts, standing in for undici's 300 s
// headersTimeout and bodyTimeout so a test can show a call does not depend on them. UNDICI_TIMEOUT_MS sets the limit.
// Node keeps the dispatcher behind these symbols (undici.globalDispatcher.1 on Node 22; .2 with a wrapper in .1 on
// later ones); the first fetch creates it.
fetch('http://127.0.0.1:9').catch(() => {});
const ms = Number(process.env.UNDICI_TIMEOUT_MS) || 1000;
for (const key of ['undici.globalDispatcher.2', 'undici.globalDispatcher.1']) {
  const s = Symbol.for(key), agent = globalThis[s];
  if (agent?.constructor?.name === 'Agent') globalThis[s] = new agent.constructor({ headersTimeout: ms, bodyTimeout: ms });
}
