param(
    [string]$RepoRoot = '',
    [string]$LiveRoot = 'C:\LocalAI\appliance\app',
    [switch]$NoPromote
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$Python = 'C:\Python312\python.exe'
if (-not (Test-Path -LiteralPath $Python)) {
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) { throw 'Python 3 is required but was not found.' }
    $Python = $py.Source
}

$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$ArchitectureJs = Join-Path $RepoRoot 'app\public\architecture.js'
$ArchitectureCss = Join-Path $RepoRoot 'app\public\architecture.css'
$ServiceWorker = Join-Path $RepoRoot 'app\public\sw.js'
$AtlasTest = Join-Path $RepoRoot 'tests\atlas-integration.test.cjs'
$UiTest = Join-Path $RepoRoot 'tests\atlas-ui-normalization.test.cjs'

foreach ($path in @($ArchitectureJs, $ArchitectureCss, $ServiceWorker, $AtlasTest)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required Atlas integration file is missing: $path"
    }
}

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$RepoBackup = Join-Path $RepoRoot ".atlas\repair-backups\$Stamp"
New-Item -ItemType Directory -Force -Path $RepoBackup | Out-Null

foreach ($path in @($ArchitectureJs, $ArchitectureCss, $ServiceWorker, $UiTest)) {
    if (Test-Path -LiteralPath $path) {
        $name = Split-Path -Leaf $path
        Copy-Item -LiteralPath $path -Destination (Join-Path $RepoBackup $name) -Force
    }
}

Write-Host "Repo backup: $RepoBackup"
Write-Host "`n=== Patch Atlas UI + Goose ===" -ForegroundColor Cyan

$patcher = @'
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
js_path = root / 'app' / 'public' / 'architecture.js'
css_path = root / 'app' / 'public' / 'architecture.css'
sw_path = root / 'app' / 'public' / 'sw.js'
test_path = root / 'tests' / 'atlas-ui-normalization.test.cjs'


def read(path: Path):
    raw = path.read_bytes()
    bom = raw.startswith(b'\xef\xbb\xbf')
    if bom:
        raw = raw[3:]
    text = raw.decode('utf-8')
    nl = '\r\n' if '\r\n' in text else '\n'
    return text, nl, bom


def write(path: Path, text: str, nl: str, bom: bool):
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    if nl == '\r\n':
        text = text.replace('\n', '\r\n')
    raw = text.encode('utf-8')
    if bom:
        raw = b'\xef\xbb\xbf' + raw
    path.write_bytes(raw)


js, js_nl, js_bom = read(js_path)
normalized = js.replace('\r\n', '\n')

# The first UI patch was browser-only and broke tests that require() this file in Node.
old_boot = """  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      boot,
      { once: true }
    );
  } else {
    boot();
  }
})();"""
new_boot = """  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener(
        'DOMContentLoaded',
        boot,
        { once: true }
      );
    } else {
      boot();
    }
  }
})();"""

if 'atlas-ui-normalization-v1' in normalized and "if (typeof document !== 'undefined')" not in normalized:
    count = normalized.count(old_boot)
    if count != 1:
        raise SystemExit(f'ERROR: expected one v1 Atlas boot block, found {count}; no change written')
    normalized = normalized.replace(old_boot, new_boot, 1)
    print('PASS: repaired Node/browser guard')

v2 = r'''
/* atlas-ui-normalization-v2-goose1
 * UI-only normalization for the native Architecture workspace.
 * Atlas determines facts; Ollama interprets facts; Goose investigates facts.
 */
;(() => {
  'use strict';
  if (typeof document === 'undefined') return;

  const page = () => document.getElementById('architecture');
  const active = () => page()?.classList.contains('active') === true;
  const systemViews = new Set(['status','models','integrations','automations','actions','workbench','repoTools','powershell','activity','architecture']);

  function goArchitecture() {
    if (window.LocalAIRouter?.go) window.LocalAIRouter.go('#architecture');
    else window.location.hash = '#architecture';
  }

  function ensureSystemTab() {
    const strip = document.getElementById('uxPageStrip');
    if (!strip) return;
    const ids = [...strip.querySelectorAll('[data-strip-view]')].map(x => x.dataset.stripView).filter(Boolean);
    if (!ids.some(id => systemViews.has(id))) return;
    let b = strip.querySelector('[data-strip-view="architecture"]');
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.dataset.stripView = 'architecture';
      b.textContent = 'Architecture';
      b.addEventListener('click', goArchitecture);
      const services = strip.querySelector('[data-strip-view="integrations"]');
      if (services?.nextSibling) strip.insertBefore(b, services.nextSibling);
      else strip.appendChild(b);
    }
    if (active()) {
      strip.querySelectorAll('[aria-current="page"]').forEach(x => x.removeAttribute('aria-current'));
      b.setAttribute('aria-current', 'page');
    } else {
      b.removeAttribute('aria-current');
    }
  }

  function nodeFrom(el) {
    const hits = (el?.innerText || '').match(/\b(?:app|host|scripts)\/[A-Za-z0-9_.\/-]+\.(?:js|cjs|mjs|py|ps1)\b/g) || [];
    return hits.find(x => !x.startsWith('tests/')) || '';
  }

  function answerText(payload) {
    if (payload == null) return '';
    if (typeof payload === 'string') return payload;
    for (const key of ['answer','response','text','message','content','brief']) {
      if (typeof payload[key] === 'string' && payload[key].trim()) return payload[key].trim();
    }
    if (payload.result && typeof payload.result === 'object') return answerText(payload.result);
    return JSON.stringify(payload, null, 2);
  }

  async function post(endpoint, body) {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {'content-type':'application/json','accept':'application/json'},
      body: JSON.stringify(body)
    });
    let j = {};
    try { j = await r.json(); } catch { j = {error:`HTTP ${r.status} without JSON`}; }
    if (!r.ok) {
      const detail = j?.error?.message || j?.error?.detail || j?.error || j?.message || `HTTP ${r.status}`;
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return j;
  }

  function ensureComposer() {
    const root = page();
    if (!root || !active()) return;
    root.classList.add('atlas-ui-v2');

    const textarea = root.querySelector('textarea');
    if (!textarea) return;
    const composer = textarea.parentElement;
    if (!composer) return;
    composer.classList.add('atlas-composer-v2');

    const inspector = textarea.closest('aside, [class*="inspector"], [class*="detail"], [class*="panel"], [class*="card"]');
    inspector?.classList.add('atlas-inspector-v2');

    let dock = composer.querySelector('.atlas-action-dock-v2');
    if (dock) return;

    dock = document.createElement('div');
    dock.className = 'atlas-action-dock-v2';
    dock.dataset.atlasV2 = '1';

    const ask = document.createElement('button');
    ask.type = 'button';
    ask.className = 'btn-primary atlas-v2-ask';
    ask.textContent = 'Ask Atlas';

    const goose = document.createElement('button');
    goose.type = 'button';
    goose.className = 'atlas-v2-goose';
    goose.textContent = 'Goose brief';

    const hint = document.createElement('span');
    hint.className = 'atlas-v2-hint';
    hint.textContent = '⌘/Ctrl + Enter';

    const output = document.createElement('div');
    output.className = 'atlas-v2-output';
    output.hidden = true;
    output.setAttribute('role', 'status');
    output.setAttribute('aria-live', 'polite');

    dock.append(ask, goose, hint);
    textarea.insertAdjacentElement('afterend', dock);
    dock.insertAdjacentElement('afterend', output);

    const buildBody = (allowDefault) => {
      const question = textarea.value.trim();
      const node = nodeFrom(inspector || root);
      const model = String((inspector || root).querySelector('select')?.value || '').trim();
      const body = {};
      if (question) body.question = question;
      else if (allowDefault) body.question = node ? `Investigate ${node}. Produce a concise engineering brief with evidence, likely failure modes, and the next verification steps.` : 'Investigate the current Atlas context and produce a concise engineering brief with evidence and next verification steps.';
      if (node) body.node = node;
      if (model && !/^auto\b/i.test(model)) body.model = model;
      return body;
    };

    const run = async (kind) => {
      const body = buildBody(kind === 'goose');
      if (!body.question) {
        output.hidden = false;
        output.dataset.state = 'error';
        output.textContent = 'Enter a question for Atlas first.';
        textarea.focus();
        return;
      }
      ask.disabled = goose.disabled = true;
      output.hidden = false;
      output.dataset.state = 'loading';
      output.textContent = kind === 'goose' ? 'Starting Goose investigation…' : 'Asking Atlas…';
      try {
        const endpoint = kind === 'goose' ? '/api/atlas/goose' : '/api/atlas/ask';
        const result = await post(endpoint, body);
        output.dataset.state = 'success';
        output.textContent = answerText(result) || (kind === 'goose' ? 'Goose completed without returning text.' : 'Atlas returned no text.');
      } catch (e) {
        output.dataset.state = 'error';
        output.textContent = e?.message || `${kind === 'goose' ? 'Goose' : 'Atlas'} request failed.`;
      } finally {
        ask.disabled = goose.disabled = false;
      }
    };

    ask.addEventListener('click', () => run('ask'));
    goose.addEventListener('click', () => run('goose'));

    // v1 already owns the keyboard shortcut when present. Bind it only for installations without v1.
    if (!document.documentElement.innerHTML.includes('atlas-ui-normalization-v1')) {
      textarea.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          run('ask');
        }
      });
    }
  }

  function normalizeLayout() {
    const root = page();
    if (!root || !active()) return;
    const inspector = root.querySelector('.atlas-inspector-v2');
    if (!inspector) return;
    let parent = inspector.parentElement;
    while (parent && parent !== root) {
      const visible = [...parent.children].filter(x => !x.hidden);
      if (parent.getBoundingClientRect().width >= 850 && visible.length >= 2 && visible.length <= 4) {
        parent.classList.add('atlas-grid-v2');
        break;
      }
      parent = parent.parentElement;
    }
  }

  function normalize() {
    ensureSystemTab();
    ensureComposer();
    normalizeLayout();
  }

  function boot() {
    normalize();
    new MutationObserver(() => queueMicrotask(normalize)).observe(document.body, {childList:true, subtree:true, attributes:true, attributeFilter:['class']});
    window.addEventListener('hashchange', () => setTimeout(normalize, 0));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once:true});
  else boot();
})();
'''

if 'atlas-ui-normalization-v2-goose1' not in normalized:
    normalized = normalized.rstrip() + '\n\n' + v2.strip() + '\n'
    print('PASS: added Atlas v2 visible actions + Goose brief')
else:
    print('INFO: Atlas v2 UI already present')

write(js_path, normalized, js_nl, js_bom)

css, css_nl, css_bom = read(css_path)
if 'atlas-ui-normalization-v2-goose1' not in css:
    css_add = r'''
/* atlas-ui-normalization-v2-goose1 */
#architecture.atlas-ui-v2{min-width:0}
#architecture .atlas-grid-v2{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(340px,400px)!important;gap:16px!important;align-items:start!important;min-width:0}
#architecture .atlas-grid-v2>*{min-width:0}
#architecture .atlas-inspector-v2{position:sticky!important;top:116px;align-self:start;max-height:calc(100vh - 136px);overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
#architecture .atlas-composer-v2{position:sticky;bottom:0;z-index:8;margin-top:14px;padding:12px 0 4px;background:linear-gradient(to bottom,transparent,var(--bg,#0b1118) 18px)}
#architecture .atlas-action-dock-v2{display:flex;align-items:center;gap:8px;margin-top:10px}
#architecture .atlas-action-dock-v2 button{min-height:44px;padding:0 14px}
#architecture .atlas-v2-goose{border:1px solid var(--line,rgba(255,255,255,.16));border-radius:9px;background:var(--panel,rgba(255,255,255,.04));color:inherit;font:inherit;cursor:pointer}
#architecture .atlas-v2-hint{margin-left:auto;color:var(--muted,#8b98aa);font-size:12px;white-space:nowrap}
#architecture .atlas-v2-output{margin-top:10px;padding:12px 14px;border:1px solid var(--line,rgba(255,255,255,.12));border-radius:10px;background:var(--panel,rgba(255,255,255,.03));white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;max-height:320px;overflow:auto}
#architecture .atlas-v2-output[data-state="error"]{border-color:color-mix(in srgb,var(--bad,#ff6b6b) 45%,var(--line,rgba(255,255,255,.12)))}
#architecture .atlas-v2-output[data-state="success"]{border-color:color-mix(in srgb,var(--good,#65d6a5) 40%,var(--line,rgba(255,255,255,.12)))}
#architecture .atlas-action-dock-v2 button:focus-visible,#uxPageStrip [data-strip-view="architecture"]:focus-visible{outline:2px solid currentColor;outline-offset:2px}
@media(max-width:1100px){#architecture .atlas-grid-v2{grid-template-columns:minmax(0,1fr)!important}#architecture .atlas-inspector-v2{position:static!important;max-height:none;overflow:visible}#architecture .atlas-composer-v2{position:static}}
@media(max-width:700px){#architecture .atlas-action-dock-v2{align-items:stretch;flex-direction:column}#architecture .atlas-action-dock-v2 button{width:100%}#architecture .atlas-v2-hint{margin-left:0;text-align:center}}
@media(prefers-reduced-motion:reduce){#architecture *{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}
'''
    css = css.rstrip() + css_nl + css_add.strip().replace('\n', css_nl) + css_nl
    write(css_path, css, css_nl, css_bom)
    print('PASS: added Atlas v2 layout/composer CSS')
else:
    print('INFO: Atlas v2 CSS already present')

sw, sw_nl, sw_bom = read(sw_path)
m = re.search(r"(const\s+CACHE\s*=\s*['\"])([^'\"]+)(['\"])", sw)
if not m:
    raise SystemExit('ERROR: service-worker CACHE declaration not found')
cache = m.group(2)
if 'atlasui3-goose1' not in cache:
    updated = re.sub(r'-atlasui\d+(?:-goose\d+)?$', '', cache) + '-atlasui3-goose1'
    sw = sw[:m.start(2)] + updated + sw[m.end(2):]
    write(sw_path, sw, sw_nl, sw_bom)
    print(f'PASS: service-worker cache bumped to {updated}')
else:
    print('INFO: service-worker cache already current')

test = r'''\'use strict\';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Architecture UI is Node-safe and exposes Ask Atlas + Goose', () => {
  const js = read('app/public/architecture.js');
  assert.match(js, /atlas-ui-normalization-v2-goose1/);
  assert.match(js, /typeof document !== 'undefined'|typeof document === 'undefined'/);
  assert.match(js, /Ask Atlas/);
  assert.match(js, /Goose brief/);
  assert.match(js, /\/api\/atlas\/ask/);
  assert.match(js, /\/api\/atlas\/goose/);
});

test('Architecture UI keeps a stable responsive inspector and visible action dock', () => {
  const css = read('app/public/architecture.css');
  assert.match(css, /atlas-grid-v2/);
  assert.match(css, /atlas-inspector-v2/);
  assert.match(css, /atlas-action-dock-v2/);
  assert.match(css, /max-width:1100px/);
  assert.match(css, /max-width:700px/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('Architecture remains a System navigation destination', () => {
  const js = read('app/public/architecture.js');
  assert.match(js, /data-strip-view/);
  assert.match(js, /architecture/);
  assert.match(js, /aria-current/);
});

test('Architecture assets are service-worker managed with the Goose cache generation', () => {
  const sw = read('app/public/sw.js');
  assert.match(sw, /\/architecture\.js/);
  assert.match(sw, /\/architecture\.css/);
  assert.match(sw, /atlasui3-goose1/);
});
'''
write(test_path, test, '\n', False)
print('PASS: wrote focused Atlas UI regression tests')
'@

$patcher | & $Python - $RepoRoot
if ($LASTEXITCODE -ne 0) { throw 'Atlas UI patcher failed.' }

Write-Host "`n=== Validate ===" -ForegroundColor Cyan
& node --check $ArchitectureJs
if ($LASTEXITCODE -ne 0) { throw 'architecture.js syntax validation failed.' }

& node --test $AtlasTest $UiTest
if ($LASTEXITCODE -ne 0) { throw 'Atlas regression tests failed. Nothing was promoted.' }

Push-Location $RepoRoot
try {
    & git --no-pager diff --check
    if ($LASTEXITCODE -ne 0) { throw 'git diff --check failed. Nothing was promoted.' }
}
finally {
    Pop-Location
}

$Goose = Get-Command goose -ErrorAction SilentlyContinue
if ($Goose) {
    Write-Host "Goose CLI    READY ($($Goose.Source))"
}
else {
    Write-Warning 'Goose CLI is not on this PowerShell PATH. The UI action is installed; Atlas will report Goose unavailable until the CLI is installed/visible to the Atlas process.'
}

if ($NoPromote) {
    Write-Host "`nPASS: source repaired and validated; promotion skipped (-NoPromote)." -ForegroundColor Green
    exit 0
}

if (-not (Test-Path -LiteralPath $LiveRoot)) {
    throw "Live Local AI app root not found: $LiveRoot"
}

Write-Host "`n=== Promote validated UI ===" -ForegroundColor Cyan
$LiveBackup = "C:\LocalAI\.deploy\atlas-ui-repair-$Stamp"
New-Item -ItemType Directory -Force -Path (Join-Path $LiveBackup 'live\public') | Out-Null

foreach ($name in @('architecture.js','architecture.css','sw.js')) {
    $source = Join-Path $LiveRoot "public\$name"
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $LiveBackup "live\public\$name") -Force
    }
}

Copy-Item -LiteralPath $ArchitectureJs -Destination (Join-Path $LiveRoot 'public\architecture.js') -Force
Copy-Item -LiteralPath $ArchitectureCss -Destination (Join-Path $LiveRoot 'public\architecture.css') -Force
Copy-Item -LiteralPath $ServiceWorker -Destination (Join-Path $LiveRoot 'public\sw.js') -Force

$liveJs = Get-Content -LiteralPath (Join-Path $LiveRoot 'public\architecture.js') -Raw
$liveCss = Get-Content -LiteralPath (Join-Path $LiveRoot 'public\architecture.css') -Raw
$liveSw = Get-Content -LiteralPath (Join-Path $LiveRoot 'public\sw.js') -Raw
if ($liveJs -notmatch 'atlas-ui-normalization-v2-goose1') { throw 'Live architecture.js verification failed.' }
if ($liveCss -notmatch 'atlas-ui-normalization-v2-goose1') { throw 'Live architecture.css verification failed.' }
if ($liveSw -notmatch 'atlasui3-goose1') { throw 'Live service-worker verification failed.' }
Write-Host 'Host files    READY'

& docker restart local-ai-appliance | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to restart local-ai-appliance.' }

$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/healthz' -TimeoutSec 3
        if ($health.status -eq 'ok') { $ready = $true; break }
    }
    catch {}
    Start-Sleep -Seconds 2
}
if (-not $ready) { throw 'Local AI did not become healthy after restart.' }
Write-Host 'Appliance     READY'

& docker exec local-ai-appliance sh -lc "grep -q 'atlas-ui-normalization-v2-goose1' /app/public/architecture.js && grep -q 'atlasui3-goose1' /app/public/sw.js"
if ($LASTEXITCODE -ne 0) { throw 'Container does not see the repaired Atlas assets.' }
Write-Host 'Container     READY'

$directJs = & curl.exe -fsS http://127.0.0.1:3080/architecture.js
if ($LASTEXITCODE -ne 0 -or $directJs -notmatch 'atlas-ui-normalization-v2-goose1') { throw 'Direct appliance architecture.js is stale.' }
Write-Host 'Direct HTTP   READY'

$httpsJs = & curl.exe -kfsS https://localai.home.arpa/architecture.js
$httpsCss = & curl.exe -kfsS https://localai.home.arpa/architecture.css
$httpsSw = & curl.exe -kfsS https://localai.home.arpa/sw.js
if ($LASTEXITCODE -ne 0 -or $httpsJs -notmatch 'atlas-ui-normalization-v2-goose1') { throw 'HTTPS architecture.js is stale.' }
if ($httpsCss -notmatch 'atlas-ui-normalization-v2-goose1') { throw 'HTTPS architecture.css is stale.' }
if ($httpsSw -notmatch 'atlasui3-goose1') { throw 'HTTPS service worker is stale.' }
Write-Host 'HTTPS         READY'

Write-Host "`n=========================================" -ForegroundColor Green
Write-Host 'PASS: Atlas UI + Goose actions are live' -ForegroundColor Green
Write-Host '=========================================' -ForegroundColor Green
Write-Host 'Open https://localai.home.arpa/#architecture and hard-refresh once (Cmd+Shift+R on Mac).'
