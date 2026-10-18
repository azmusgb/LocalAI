'use strict';

// Model calls go over node:http, not the global fetch. Node's built-in fetch (undici) gives up when response headers
// take more than 300 s (headersTimeout) or the body is silent for 300 s (bodyTimeout), and neither can be changed
// without the undici package (the app has no runtime dependencies). Ollama sends no headers until it has read the
// whole prompt, which on the 6 GB GPU with other work queued can take longer than that, and the call died as
// "fetch failed" whatever the caller's own deadline was. node:http has no such limit, so the caller's deadline
// (signal, timeoutMs) is the only one. Returns a standard Response, so callers read it like a fetch.
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');

const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

function modelError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

// What went wrong on the wire, in words the run records keep: a refusal says Ollama wasn't answering.
function transportError(error, target) {
  const code = error?.code || '';
  if (UNREACHABLE.has(code)) return modelError('MODEL_UNREACHABLE', `Ollama wasn’t answering at ${target.host} (${code})`, error);
  return modelError('MODEL_CONNECTION_ERROR', `Ollama connection failed: ${code || error?.message || error}`, error);
}

function headersOf(raw) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw || {})) {
    for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) headers.append(name, String(v));
  }
  return headers;
}

function modelFetch(url, { method = 'GET', headers = {}, body, signal, timeoutMs } = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const controller = new AbortController();
  const fromCaller = () => controller.abort(signal.reason);
  let timer = null;
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', fromCaller); };
  if (signal?.aborted) fromCaller();
  else signal?.addEventListener('abort', fromCaller, { once: true });
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(modelError('MODEL_TIMEOUT', `The model took longer than ${Math.round(timeoutMs / 1000)} s (request timed out)`)), timeoutMs);
    timer.unref?.();
  }
  return new Promise((resolve, reject) => {
    if (controller.signal.aborted) { cleanup(); reject(controller.signal.reason); return; }
    let response = null;
    const req = transport.request(target, {
      method,
      headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
    }, res => {
      response = res;
      res.once('close', cleanup);
      const status = res.statusCode;
      // A Response can't carry a 1xx; anything outside 200-599 is a broken upstream.
      if (status < 200 || status > 599) { res.destroy(); reject(modelError('MODEL_CONNECTION_ERROR', `Ollama sent HTTP ${status}`)); return; }
      const noBody = method === 'HEAD' || status === 204 || status === 304;
      if (noBody) res.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(res), { status, statusText: res.statusMessage || '', headers: headersOf(res.headers) }));
    });
    controller.signal.addEventListener('abort', () => {
      const reason = controller.signal.reason;
      req.destroy(reason);
      response?.destroy(reason);
    }, { once: true });
    req.on('error', error => {
      if (response) return; // after the headers, errors surface through the body stream
      cleanup();
      reject(controller.signal.aborted ? controller.signal.reason : transportError(error, target));
    });
    req.end(payload || undefined);
  });
}

// The fetchWithTimeout signature (url, options, timeoutMs) over modelFetch: the deadline covers headers and body.
const modelFetchWithTimeout = (url, options = {}, timeoutMs) => modelFetch(url, { ...options, timeoutMs });

module.exports = { modelFetch, modelFetchWithTimeout, modelError };
