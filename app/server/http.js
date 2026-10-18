'use strict';

// HTTP helpers every area of the server uses (moved from server.js unchanged; docs/superpowers/specs/2026-10-18-server-split-design.md).

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(res, status, value) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(value));
}

function storageError(res, error, defaultStatus = 400) {
  return json(res, error.statusCode || defaultStatus, { error: String(error.message || error), ...(error.code ? { code: error.code } : {}) });
}

function text(res, status, value, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...extraHeaders });
  res.end(value);
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', chunk => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Keep draining instead of destroying the socket so the handler can still answer 413.
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });
    req.on('error', reject);
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const externalSignal = options?.signal || null;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  const done = () => {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  };
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    done();
    throw error;
  }
  // fetch resolves at the headers; keep the deadline armed until the body has been read too.
  if (!response.body) done();
  else for (const method of ['text', 'json', 'arrayBuffer', 'blob', 'formData']) {
    const read = response[method].bind(response);
    response[method] = () => read().finally(done);
  }
  return response;
}

// Another site open in the browser could otherwise post here (a text/plain form needs no preflight).
function sameOriginJson(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) { json(res, 403, { error: 'Origin not allowed' }); return false; }
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') { json(res, 415, { error: 'Content-Type must be application/json' }); return false; }
  return true;
}

module.exports = { JSON_HEADERS, json, storageError, text, readBody, fetchWithTimeout, sameOriginJson };
