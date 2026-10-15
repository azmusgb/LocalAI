'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.LISTEN_HOST || '0.0.0.0';
const PORT = Number(process.env.LISTEN_PORT || 8080);
const UPSTREAM = (process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434').replace(/\/+$/, '');
const CACHE_FILE = process.env.CACHE_FILE || '/data/cache.json';
const MAX_RESPONSES = Math.max(20, Number(process.env.CACHE_MAX_RESPONSES || 250));
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

function log(...args) {
  if (LOG_LEVEL !== 'silent') console.log(new Date().toISOString(), ...args);
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

let cache = {
  version: 1,
  responses: {},
  responseOrder: [],
  items: {}
};

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (parsed && parsed.version === 1) {
      cache = {
        version: 1,
        responses: parsed.responses || {},
        responseOrder: Array.isArray(parsed.responseOrder) ? parsed.responseOrder : [],
        items: parsed.items || {}
      };
      log(
        `cache loaded responses=${Object.keys(cache.responses).length}`,
        `items=${Object.keys(cache.items).length}`
      );
    }
  } catch (err) {
    console.error('Cache load warning:', err.message);
  }
}

function persistCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });

    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch (err) {
    console.error('Cache persist warning:', err.message);
  }
}

function rebuildItems() {
  const items = {};

  for (const responseId of cache.responseOrder) {
    const response = cache.responses[responseId];
    if (!response || !Array.isArray(response.output)) continue;

    for (const item of response.output) {
      if (item && item.id) {
        items[item.id] = item;
      }
    }
  }

  cache.items = items;
}

function cacheResponse(response) {
  if (!response || typeof response !== 'object' || !response.id) return;

  cache.responses[response.id] = response;

  cache.responseOrder = cache.responseOrder.filter(id => id !== response.id);
  cache.responseOrder.push(response.id);

  while (cache.responseOrder.length > MAX_RESPONSES) {
    const old = cache.responseOrder.shift();
    delete cache.responses[old];
  }

  rebuildItems();
  persistCache();

  log(
    `cached response=${response.id}`,
    `outputItems=${Array.isArray(response.output) ? response.output.length : 0}`
  );
}

function cacheOutputItem(item) {
  if (!item || !item.id) return;
  cache.items[item.id] = item;
}

function inputArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return [{ role: 'user', content: value }];
  }
  if (value == null) return [];
  return [value];
}

function expandRequest(body) {
  const original = clone(body);
  let input = inputArray(body.input);
  let expandedCount = 0;

  if (body.previous_response_id) {
    const previous = cache.responses[body.previous_response_id];

    if (!previous) {
      const err = new Error(
        `Unknown previous_response_id '${body.previous_response_id}'. ` +
        `The proxy only knows responses created through this proxy.`
      );
      err.statusCode = 400;
      throw err;
    }

    const previousOutput = Array.isArray(previous.output)
      ? clone(previous.output)
      : [];

    input = [...previousOutput, ...input];
    delete body.previous_response_id;
    expandedCount += previousOutput.length;
  }

  const expanded = [];

  for (const item of input) {
    if (item && item.type === 'item_reference') {
      const id = item.id || item.item_id;
      const cached = id ? cache.items[id] : null;

      if (!cached) {
        const err = new Error(
          `Unknown item_reference '${id || '(missing id)'}'. ` +
          `Start a new Assistant conversation or clear the proxy cache if the prior response was not created through this proxy.`
        );
        err.statusCode = 400;
        throw err;
      }

      expanded.push(clone(cached));
      expandedCount++;
      continue;
    }

    expanded.push(item);
  }

  body.input = expanded;

  // Ollama's Responses API is stateless. If a client supplies a conversation
  // object/id, do not forward it; the proxy has already materialized known
  // history above from previous_response_id/item_reference.
  if (body.conversation != null) {
    delete body.conversation;
  }

  return {
    original,
    body,
    expandedCount
  };
}

function copyResponseHeaders(upstreamHeaders, res) {
  const skip = new Set([
    'content-length',
    'content-encoding',
    'transfer-encoding',
    'connection',
    'keep-alive'
  ]);

  for (const [key, value] of upstreamHeaders.entries()) {
    if (!skip.has(key.toLowerCase())) {
      try {
        res.setHeader(key, value);
      } catch {}
    }
  }
}

function proxyError(res, status, message) {
  const payload = JSON.stringify({
    error: {
      message,
      type: 'invalid_request_error',
      param: null,
      code: null
    }
  });

  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });

  res.end(payload);
}

function parseSseBlock(block, state) {
  const lines = block.split(/\r?\n/);
  const dataLines = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart());

  if (!dataLines.length) return;

  const dataText = dataLines.join('\n');
  if (!dataText || dataText === '[DONE]') return;

  let event;
  try {
    event = JSON.parse(dataText);
  } catch {
    return;
  }

  if (event.type === 'response.created' && event.response?.id) {
    state.responseId = event.response.id;
  }

  if (event.type === 'response.output_item.done' && event.item) {
    cacheOutputItem(event.item);
    state.outputItems.push(event.item);
  }

  if (event.type === 'response.completed' && event.response) {
    cacheResponse(event.response);
    state.completedResponse = event.response;
  }
}

async function proxyRequest(req, res) {
  const upstreamUrl = UPSTREAM + req.url;

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      value !== undefined &&
      !['host', 'content-length', 'connection'].includes(key.toLowerCase())
    ) {
      headers[key] = value;
    }
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  let bodyBuffer = Buffer.concat(chunks);

  const isResponsesCreate =
    req.method === 'POST' &&
    (req.url === '/v1/responses' || req.url.startsWith('/v1/responses?'));

  if (isResponsesCreate) {
    let body;

    try {
      body = bodyBuffer.length
        ? JSON.parse(bodyBuffer.toString('utf8'))
        : {};
    } catch {
      proxyError(res, 400, 'Request body is not valid JSON');
      return;
    }

    try {
      const transformed = expandRequest(body);
      body = transformed.body;

      log(
        `POST /v1/responses model=${body.model || '?'}`,
        `stream=${body.stream === true}`,
        `expandedRefs=${transformed.expandedCount}`
      );
    } catch (err) {
      proxyError(res, err.statusCode || 400, err.message);
      return;
    }

    bodyBuffer = Buffer.from(JSON.stringify(body), 'utf8');
    headers['content-type'] = 'application/json';
  }

  let upstreamRes;

  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuffer,
      redirect: 'manual'
    });
  } catch (err) {
    proxyError(res, 502, `Cannot reach Ollama upstream: ${err.message}`);
    return;
  }

  copyResponseHeaders(upstreamRes.headers, res);
  res.statusCode = upstreamRes.status;

  if (!upstreamRes.body) {
    res.end();
    return;
  }

  const contentType = upstreamRes.headers.get('content-type') || '';

  if (
    isResponsesCreate &&
    upstreamRes.ok &&
    contentType.includes('text/event-stream')
  ) {
    const decoder = new TextDecoder();
    let sseBuffer = '';
    const state = {
      responseId: null,
      outputItems: [],
      completedResponse: null
    };

    try {
      for await (const rawChunk of upstreamRes.body) {
        const chunk = Buffer.from(rawChunk);
        res.write(chunk);

        sseBuffer += decoder.decode(rawChunk, { stream: true });

        let idx;
        while ((idx = sseBuffer.search(/\r?\n\r?\n/)) >= 0) {
          const match = sseBuffer.match(/\r?\n\r?\n/);
          const sepLen = match ? match[0].length : 2;
          const block = sseBuffer.slice(0, idx);
          sseBuffer = sseBuffer.slice(idx + sepLen);
          parseSseBlock(block, state);
        }
      }

      sseBuffer += decoder.decode();
      if (sseBuffer.trim()) parseSseBlock(sseBuffer, state);

      // Fallback cache if the stream exposed output_item.done events but did
      // not include a full response.completed object.
      if (
        !state.completedResponse &&
        state.responseId &&
        state.outputItems.length
      ) {
        cacheResponse({
          id: state.responseId,
          object: 'response',
          status: 'completed',
          output: state.outputItems
        });
      }

      persistCache();
      res.end();
    } catch (err) {
      console.error('Streaming proxy error:', err);
      if (!res.writableEnded) res.end();
    }

    return;
  }

  const responseBuffer = Buffer.from(await upstreamRes.arrayBuffer());

  if (isResponsesCreate && upstreamRes.ok) {
    try {
      const parsed = JSON.parse(responseBuffer.toString('utf8'));
      cacheResponse(parsed);
    } catch {}
  }

  res.end(responseBuffer);
}

loadCache();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      const payload = JSON.stringify({
        status: 'ok',
        upstream: UPSTREAM,
        cachedResponses: Object.keys(cache.responses).length,
        cachedItems: Object.keys(cache.items).length
      });

      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      });
      res.end(payload);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/_proxy/cache') {
      const payload = JSON.stringify({
        responses: cache.responseOrder.length,
        items: Object.keys(cache.items).length,
        newestResponseId: cache.responseOrder.at(-1) || null
      });

      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      });
      res.end(payload);
      return;
    }

    const retrieveMatch = url.pathname.match(/^\/v1\/responses\/([^/]+)$/);

    if (req.method === 'GET' && retrieveMatch) {
      const id = decodeURIComponent(retrieveMatch[1]);
      const response = cache.responses[id];

      if (response) {
        const payload = JSON.stringify(response);
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        });
        res.end(payload);
        return;
      }
    }

    await proxyRequest(req, res);
  } catch (err) {
    console.error(err.stack || err);
    if (!res.headersSent) {
      proxyError(res, 500, err.message || 'Proxy error');
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  log(`Ollama Responses compatibility proxy listening on ${HOST}:${PORT}`);
  log(`Upstream: ${UPSTREAM}`);
});