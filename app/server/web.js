'use strict';

// What the browser loads: config, the /go/ redirects and the static files (with the release stamped in).
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createWeb(ctx) {
  const { APP_VERSION, CAPABILITY_CACHE_MS, CHAT_MODEL_TIMEOUT_MS, ENGINEERING_MODEL_TIMEOUT_MS, LOCAL_UI_PORT, MODEL, PUBLIC_DIR, accessAddresses, changeStore, claudeFindings, crypto, engineeringRunStore, fs, json, listenPort, path, release, text } = ctx;
  function apiConfig(req, res) {
    json(res, 200, {
      appliance: 'Local AI',
      subtitle: 'Private Intelligence Hub',
      version: APP_VERSION,
      model: MODEL,
      localUiPort: LOCAL_UI_PORT || listenPort(),
      // An install that has used the Build tools keeps them in the menu by default; a new one starts without them.
      developerHistory: changeStore().length > 0 || engineeringRunStore().length > 0 || claudeFindings().length > 0,
      chatTimeoutMs: CHAT_MODEL_TIMEOUT_MS,
      engineeringTimeoutMs: ENGINEERING_MODEL_TIMEOUT_MS,
      capabilityCacheMs: CAPABILITY_CACHE_MS,
      links: {
        automationBuilder: '/go/n8n-assistant',
        workflows: '/go/n8n',
        imageAdvanced: '/go/comfy'
      }
    });
  }
  // The host a /go/ link points at. Behind the front gate the request's Host is 10.0.0.21 (the gate rewrites it) and the
  // name the owner typed is in X-Forwarded-Host, so that wins when it is a plain host name; LOCALAI_GO_HOST fixes it.
  const HOST_NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
  function goHost(req) {
    const fixed = String(process.env.LOCALAI_GO_HOST || '').trim();
    if (HOST_NAME.test(fixed)) return fixed;
    const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().replace(/:\d+$/, '');
    if (HOST_NAME.test(forwarded)) return forwarded;
    return (req.headers.host || '').split(':')[0] || '127.0.0.1';
  }
  function redirectFor(req, res, pathname) {
    const host = goHost(req);
    let target;
    if (pathname === '/go/n8n') target = `http://${host}:5678/`;
    else if (pathname === '/go/n8n-assistant') target = `http://${host}:5678/settings/assistant`;
    else if (pathname === '/go/comfy') target = `http://${host}:8188/mobile/`;
    else return false;
    res.writeHead(302, { Location: target });
    res.end();
    return true;
  }
  // index.html carries the build it came from, so a copy the service worker saved knows its release and a page from an
  // older build can see that /healthz now reports another one (app/public/offline-copy.js).
  function withBuildMeta(html) {
    const attr = v => String(v ?? '').replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));
    // The addresses ride along too, so a saved copy can offer the other one with no network at all.
    const meta = `<meta name="localai-version" content="${attr(APP_VERSION)}"><meta name="localai-release" content="${attr(release?.commit || '')}"><meta name="localai-addresses" content="${attr(JSON.stringify(accessAddresses()))}">`;
    return Buffer.from(String(html).replace('<head>', `<head>\n${meta}`));
  }
  function serveStatic(req, res, pathname) {
    const requested = pathname === '/' ? '/index.html' : pathname;
    const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, normalized);
    if (!file.startsWith(PUBLIC_DIR)) return text(res, 403, 'Forbidden');

    fs.readFile(file, (err, data) => {
      if (err) {
        if (pathname !== '/' && !pathname.includes('.')) {
          fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
            if (e2) return text(res, 404, 'Not found');
            text(res, 200, withBuildMeta(d2), 'text/html; charset=utf-8');
          });
          return;
        }
        return text(res, 404, 'Not found');
      }
      const ext = path.extname(file).toLowerCase();
      if (file === path.join(PUBLIC_DIR, 'index.html')) data = withBuildMeta(data);
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2'
      };
      // App code must update the moment a release is deployed: browsers revalidate with the ETag each load
      // and get a 304 when nothing changed. Images can be reused for a day.
      const etag = `"${crypto.createHash('sha1').update(data).digest('base64url').slice(0, 22)}"`;
      const headers = { 'Cache-Control': ['.png', '.ico', '.svg', '.woff2'].includes(ext) ? 'public, max-age=86400' : 'no-cache', ETag: etag };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      text(res, 200, data, types[ext] || 'application/octet-stream', headers);
    });
  }
  return { apiConfig, redirectFor, serveStatic };
}

module.exports = { createWeb };
