// Where the LocalAI relay is and how to reach it, shared by bridge.mjs and cli.mjs.
// URL: LOCALAI_URL, else config.json "url" (written by install.sh), else plain HTTP on 3080.
// HTTPS is verified against config.json "ca" (the LocalAI CA install.sh fetched over ssh) passed as the `ca` option of
// node:https, so it works however the process was started (global fetch ignores NODE_EXTRA_CA_CERTS set after start).
// Verification is never turned off. HTTP(S)_PROXY is ignored: the Mac key only ever goes to the appliance itself.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

export const DEFAULT_URL = 'https://10.0.0.81';
const INSTALL_HINT = 're-run host/claude-chat/install.sh';

export function loadConfig(home, env = process.env) {
  // A config.json that exists but cannot be used stops all sending: falling back to the HTTP default would quietly
  // undo an HTTPS setup. A missing file is a pre-HTTPS install and uses the defaults.
  let file = {};
  let configError = null;
  const configPath = path.join(home, 'config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    file = parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      configError = Object.assign(new Error(`config.json unreadable: ${configPath} (${e.message}); nothing is sent until it is fixed; ${INSTALL_HINT}`), { code: 'LOCALAI_CONFIG_UNREADABLE' });
    }
  }
  const base = String(env.LOCALAI_URL || file.url || DEFAULT_URL).replace(/\/+$/, '');
  const caPath = typeof file.ca === 'string' && file.ca ? path.resolve(home, file.ca) : '';
  let ca = null;
  let caError = null;
  if (caPath && base.startsWith('https:')) {
    try { ca = fs.readFileSync(caPath, 'utf8'); } catch (e) {
      caError = Object.assign(new Error(`CA file unreadable: ${caPath} (${e.code || e.message}); ${INSTALL_HINT}`), { code: 'LOCALAI_CA_UNREADABLE' });
    }
  }
  return { base, caPath, ca, caError, configError };
}

const TLS_CODE = /CERT|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL|HOSTNAME|ALTNAME/;
export const isTlsError = (e) => TLS_CODE.test(String(e?.code || e?.cause?.code || ''));

// One line for logs and CLI errors. Certificate failures name the URL and the CA so the fix is obvious.
export function describeError(cfg, e) {
  const code = String(e?.code || e?.cause?.code || '');
  if (code === 'LOCALAI_CA_UNREADABLE' || code === 'LOCALAI_CONFIG_UNREADABLE') return e.message;
  if (isTlsError(e)) {
    return `tls ${code}: the certificate of ${cfg.base} is not trusted (CA: ${cfg.caPath || 'none configured'}); ${INSTALL_HINT}`;
  }
  return `${e?.name || ''} ${code}`.trim();
}

// A small fetch stand-in: resolves { status, ok, text, json() } once the whole body has arrived.
export function request(cfg, method, route, { headers = {}, body, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (cfg.configError) { reject(cfg.configError); return; }
    if (cfg.caError) { reject(cfg.caError); return; }
    let url;
    try { url = new URL(cfg.base + route); } catch (e) { reject(e); return; }
    const secure = url.protocol === 'https:';
    const options = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (secure && cfg.ca) options.ca = cfg.ca;
    if (body !== undefined) options.headers['Content-Length'] = Buffer.byteLength(body);
    const req = (secure ? https : http).request(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('aborted', () => reject(Object.assign(new Error('response aborted'), { code: 'ECONNRESET' })));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
