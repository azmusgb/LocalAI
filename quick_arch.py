from __future__ import annotations

import argparse
import ast
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import webbrowser
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
# A folder of its own: the appliance container mounts it read-only, and a folder mount sees each atomic rebuild.
OUTPUT = Path(os.environ.get("ATLAS_OUTPUT") or (ROOT / ".atlas" / "graph" / "system-atlas.html"))
# Snapshots (platform baseline 6.4): one repository at one commit, scanned from a clean copy made with git archive,
# never a working tree. Each lands in <SNAPSHOTS>/<repo>/<commit>/graph.json and is listed in <SNAPSHOTS>/index.json.
SNAPSHOTS = Path(os.environ.get("ATLAS_SNAPSHOTS") or (ROOT / ".atlas" / "snapshots"))
KEEP_SNAPSHOTS = 5
REPO_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
# Set by main() for a snapshot run: repo, gitDir, commit, committedAt, changedSince.
SNAPSHOT: dict = {}

SOURCE_EXTENSIONS = {
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
}

IGNORE_DIRS = {
    ".git",
    ".idea",
    ".vscode",
    "__pycache__",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".venv",
    "venv",
    ".atlas",  # its own backups and briefs: scanning them doubles modules like app/server.js
    ".claude",
    ".worktrees",
}

MAX_FILES = 900

# What the last scan could not see, reported in the graph's stats so a partial diagram says so.
SCAN: dict = {"truncated": False, "gitError": None}

JS_IMPORT_RE = re.compile(
    r"""
    (?:
        import\s+(?:[^'"]*?\s+from\s+)? |
        export\s+[^'"]*?\s+from\s+ |
        require\s*\( |
        import\s*\(
    )
    \s*['"]([^'"]+)['"]
    """,
    re.VERBOSE,
)


DOMAIN_ORDER = [
    "UI",
    "API",
    "Platform",
    "Core",
    "AI",
    "Data",
    "Media",
    "Claude",
    "GridCraft",
    "Workshop",
    "Host",
    "Runtime",
    "Tooling",
    "Docs",
    "Root",
    "Tests",
]


DOMAIN_DESCRIPTIONS = {
    "UI": "Browser experience, views and interaction",
    "API": "HTTP/API boundary and server modules",
    "Platform": "Application composition and bootstrap",
    "Core": "Shared application capabilities",
    "AI": "Models, missions, agents and orchestration",
    "Data": "Storage, journal, library and run history",
    "Media": "Image and media generation",
    "Claude": "Claude Code relay and bridge integration",
    "GridCraft": "GridCraft agent and host integration",
    "Workshop": "Workshop, Print Lab and Pi integrations",
    "Host": "Host-machine runtime helpers",
    "Runtime": "Deployment and runtime infrastructure",
    "Tooling": "Build, CI and repository tooling",
    "Docs": "Generated and executable documentation",
    "Root": "Repository-level configuration",
    "Tests": "Automated verification surface",
}


# ---------------------------------------------------------------------------
# Repository scan
# ---------------------------------------------------------------------------


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def collect_files() -> list[Path]:
    """Source files under ROOT in a stable order. Ignored folders are pruned before descending, symlinks are never
    followed (they can point outside the repo), and SCAN["truncated"] says when MAX_FILES cut the list short."""
    root = ROOT.resolve()
    found: list[Path] = []
    for current, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in IGNORE_DIRS and not (Path(current) / d).is_symlink())
        for name in sorted(names):
            path = Path(current) / name
            if path.suffix.lower() in SOURCE_EXTENSIONS and not path.is_symlink() and path.is_file():
                found.append(path)
    found.sort(key=lambda p: p.relative_to(root).as_posix())
    SCAN["truncated"] = len(found) > MAX_FILES
    return found[:MAX_FILES]



def resolve_js_import(
    source: Path,
    target: str,
    known: set[Path],
) -> Path | None:
    if not target.startswith("."):
        return None

    candidate = (source.parent / target).resolve()

    possibilities: list[Path] = [candidate]

    # './foo' and './foo.service' (a suffix that isn't a source extension) both get each source extension added.
    if candidate.suffix.lower() not in SOURCE_EXTENSIONS:
        possibilities.extend(
            candidate.with_name(candidate.name + extension)
            for extension in SOURCE_EXTENSIONS
        )

    possibilities.extend(
        candidate / f"index{extension}"
        for extension in SOURCE_EXTENSIONS
    )

    for possibility in possibilities:
        resolved = possibility.resolve()

        if resolved in known:
            return resolved

    return None


def parse_javascript(
    path: Path,
    known: set[Path],
) -> set[Path]:
    try:
        source = path.read_text(
            encoding="utf-8",
            errors="replace",
        )
    except OSError:
        return set()

    dependencies: set[Path] = set()

    for match in JS_IMPORT_RE.finditer(source):
        resolved = resolve_js_import(
            path,
            match.group(1),
            known,
        )

        if resolved:
            dependencies.add(resolved)

    return dependencies


def module_candidates(module: str) -> list[Path]:
    base = ROOT.joinpath(*module.split("."))

    return [
        base.with_suffix(".py"),
        base / "__init__.py",
    ]


def parse_python(
    path: Path,
    known: set[Path],
) -> set[Path]:
    try:
        source = path.read_text(
            encoding="utf-8",
            errors="replace",
        )
        tree = ast.parse(
            source,
            filename=str(path),
        )
    except (OSError, SyntaxError, ValueError):
        return set()

    dependencies: set[Path] = set()

    def link(candidates: list[Path]) -> None:
        for candidate in candidates:
            resolved = candidate.resolve()
            if resolved in known:
                dependencies.add(resolved)

    def submodules(base: Path, names) -> list[Path]:
        # 'from pkg import sub': each imported name may be a module of its own.
        return [p for a in names if a.name != "*" for p in (base / f"{a.name}.py", base / a.name / "__init__.py")]

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                link(module_candidates(alias.name))
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = path.parent
                for _ in range(max(0, node.level - 1)):
                    base = base.parent
                if node.module:
                    base = base.joinpath(*node.module.split("."))
                    link([base.with_suffix(".py"), base / "__init__.py"])
                else:
                    # 'from . import x' names the package itself, never a same-named sibling module.
                    link([base / "__init__.py"])
                link(submodules(base, node.names))
            elif node.module:
                link(module_candidates(node.module))
                link(submodules(ROOT.joinpath(*node.module.split(".")), node.names))

    return dependencies



# ---------------------------------------------------------------------------
# Architecture classification
# ---------------------------------------------------------------------------


# Domains for repositories other than Local AI, first match wins; each uses the DOMAIN_ORDER names. Anything
# unmatched falls to the shared rules in classify_other.
REPO_DOMAINS: dict[str, list[tuple[str, str]]] = {
    "pi-hub": [
        ("hub/static/", "UI"),
        ("hub/app.py", "Platform"),
        ("hub/lab", "Workshop"), ("hub/printer", "Workshop"), ("hub/bambuddy", "Workshop"),
        ("hub/filament", "Workshop"), ("hub/display", "Workshop"),
        ("hub/db.py", "Data"), ("hub/records", "Data"),
        ("hub/", "API"),
    ],
    "print-lab": [
        ("lab/page", "UI"),
        ("lab/cli", "Platform"),
        ("lab/printer", "Workshop"), ("lab/bambuddy", "Workshop"), ("lab/sync", "Workshop"), ("lab/pull", "Workshop"),
        ("lab/records", "Data"), ("lab/history", "Data"), ("lab/index", "Data"),
        ("lab/", "Core"),
    ],
}


def classify_other(repo: str, p: str) -> str:
    for prefix, domain in REPO_DOMAINS.get(repo, []):
        if p.startswith(prefix):
            return domain
    for prefix, domain in (("tests/", "Tests"), ("test/", "Tests"), ("docs/", "Docs"), ("deploy/", "Runtime"),
                           ("scripts/", "Tooling"), ("tools/", "Tooling")):
        if p.startswith(prefix):
            return domain
    return "Root"


def classify(path: Path) -> str:
    p = rel(path).lower()
    name = path.name.lower()

    if SNAPSHOT and SNAPSHOT["repo"] != "localai":
        return classify_other(SNAPSHOT["repo"], p)

    if p.startswith("tests/"):
        return "Tests"

    if p.startswith("app/public/"):
        return "UI"

    if p.startswith("app/server/"):
        return "API"

    if p == "app/server.js":
        return "Platform"

    if p.startswith("host/claude-chat/"):
        return "Claude"

    if p.startswith("host/gridcraft"):
        return "GridCraft"

    if p.startswith("deploy/"):
        return "Runtime"

    if p.startswith("scripts/"):
        return "Tooling"

    if p.startswith("docs/"):
        return "Docs"

    if any(
        token in p
        for token in (
            "workshop",
            "print-lab",
            "pi-hub",
            "bambuddy",
            "materials",
        )
    ):
        return "Workshop"

    if any(
        token in p
        for token in (
            "image-engine",
            "/images",
            "comfy",
            "artcraft",
        )
    ):
        return "Media"

    if any(
        token in name
        for token in (
            "storage",
            "journal",
            "library",
            "ledger",
        )
    ):
        return "Data"

    if any(
        token in name
        for token in (
            "agent",
            "mission",
            "model",
            "ollama",
        )
    ):
        return "AI"

    if p.startswith("host/"):
        return "Host"

    if p.startswith("app/"):
        return "Core"

    return "Root"


def domain_sort_key(domain: str) -> int:
    try:
        return DOMAIN_ORDER.index(domain)
    except ValueError:
        return len(DOMAIN_ORDER)


# ---------------------------------------------------------------------------
# Git awareness
# ---------------------------------------------------------------------------


def changed_files() -> set[str]:
    """Paths git reports as changed, relative to ROOT. A git failure is recorded in SCAN["gitError"] (and the graph's
    stats), so the page can say "changes unknown" instead of "nothing changed"."""
    SCAN["gitError"] = None
    if SNAPSHOT:
        return snapshot_changed_files()
    try:
        result = subprocess.run(
            # -z: paths unquoted and NUL-separated, so spaces and non-ASCII names match the scanned files.
            ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        prefix = subprocess.run(
            ["git", "rev-parse", "--show-prefix"],
            cwd=ROOT, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError) as error:
        SCAN["gitError"] = f"git did not run: {error}"[:300]
        return set()
    if result.returncode != 0:
        SCAN["gitError"] = (result.stderr.strip() or f"git exited {result.returncode}")[:300]
        return set()

    changed: set[str] = set()
    entries = result.stdout.split("\0")
    i = 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        status, value = entry[:2], entry[3:]
        if "R" in status or "C" in status:
            i += 1  # -z puts a rename's old path in the next field
        value = value.replace("\\", "/")
        # Porcelain paths are relative to the repository top; the graph's are relative to ROOT.
        if prefix and value.startswith(prefix):
            value = value[len(prefix):]
        if value:
            changed.add(value)
    return changed



def git(git_dir: str, *args: str, binary: bool = False, timeout: int = 60):
    """Run git against a repository's git folder (a bare mirror or a .git); raise with git's own message on failure."""
    result = subprocess.run(["git", f"--git-dir={git_dir}", *args], check=False, capture_output=True, timeout=timeout,
                            **({} if binary else {"text": True, "encoding": "utf-8", "errors": "replace"}))
    if result.returncode != 0:
        err = result.stderr.decode("utf-8", "replace") if binary else result.stderr
        raise RuntimeError(f"git {args[0]} failed: {err.strip()[:300]}")
    return result.stdout


def snapshot_changed_files() -> set[str]:
    """In a snapshot, "changed" means changed since this repository's previous snapshot. The first snapshot has none."""
    prev = SNAPSHOT.get("changedSince")
    if not prev:
        return set()
    try:
        out = git(SNAPSHOT["gitDir"], "diff", "--name-only", "-z", prev, SNAPSHOT["commit"])
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        SCAN["gitError"] = str(error)[:300]
        return set()
    return {name.replace("\\", "/") for name in out.split("\0") if name}


def export_commit(git_dir: str, commit: str, target: Path) -> None:
    """A clean copy of one commit: git archive, unpacked with tarfile's "data" filter, which refuses absolute paths,
    links out of the folder and special files."""
    data = git(git_dir, "archive", "--format=tar", commit, binary=True, timeout=300)
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        tar.extractall(target, filter="data")


def read_index() -> dict:
    try:
        index = json.loads((SNAPSHOTS / "index.json").read_text(encoding="utf-8"))
        if isinstance(index, dict) and isinstance(index.get("snapshots"), list):
            return index
    except (OSError, ValueError):
        pass
    return {"snapshots": []}


def previous_snapshot(repo: str, commit: str) -> str | None:
    rows = [r for r in read_index()["snapshots"] if r.get("repo") == repo and r.get("commit") != commit]
    rows.sort(key=lambda r: r.get("generatedAt") or "")
    return rows[-1]["commit"] if rows else None


def record_snapshot(graph: dict) -> Path:
    """Write the graph and update the index atomically, keeping the newest KEEP_SNAPSHOTS per repository."""
    repo, commit = SNAPSHOT["repo"], SNAPSHOT["commit"]
    target = SNAPSHOTS / repo / commit / "graph.json"
    write_output(target, json.dumps(graph, ensure_ascii=False, separators=(",", ":")))
    index = read_index()
    rows = [r for r in index["snapshots"] if not (r.get("repo") == repo and r.get("commit") == commit)]
    rows.append({"repo": repo, "commit": commit, "committedAt": SNAPSHOT["committedAt"],
                 "generatedAt": graph["generatedAt"], "changedSince": SNAPSHOT.get("changedSince"),
                 "stats": {k: graph["stats"].get(k) for k in ("files", "productionFiles", "tests", "relationships",
                                                               "changed", "truncated")}})
    mine = sorted((r for r in rows if r.get("repo") == repo), key=lambda r: r.get("generatedAt") or "", reverse=True)
    dropped = {r["commit"] for r in mine[KEEP_SNAPSHOTS:]}
    rows = [r for r in rows if not (r.get("repo") == repo and r.get("commit") in dropped)]
    rows.sort(key=lambda r: (r.get("repo") or "", r.get("generatedAt") or ""))
    write_output(SNAPSHOTS / "index.json", json.dumps({"snapshots": rows}, ensure_ascii=False, indent=1))
    for old in dropped:
        shutil.rmtree(SNAPSHOTS / repo / old, ignore_errors=True)
    return target


# ---------------------------------------------------------------------------
# Graph model
# ---------------------------------------------------------------------------


def risk_score(
    *,
    inbound: int,
    outbound: int,
    test_refs: int,
    changed: bool,
    domain: str,
) -> int:
    degree = inbound + outbound

    score = 0.0

    score += min(
        42,
        degree * 2.1,
    )

    score += min(
        18,
        inbound * 1.15,
    )

    score += min(
        12,
        outbound * 0.7,
    )

    if domain in {
        "Platform",
        "Data",
        "AI",
        "API",
    }:
        score += 8

    if changed:
        score += 16

    if degree >= 3 and test_refs == 0:
        score += 14
    elif test_refs == 1:
        score += 7
    elif test_refs >= 4:
        score -= 5

    return max(
        0,
        min(
            100,
            round(score),
        ),
    )


def risk_level(score: int) -> str:
    if score >= 70:
        return "critical"

    if score >= 48:
        return "high"

    if score >= 28:
        return "medium"

    return "low"


def build_story(
    *,
    story_id: str,
    label: str,
    subtitle: str,
    node_ids: list[str],
    edge_pairs: list[tuple[str, str]],
    valid_ids: set[str],
    valid_edges: set[tuple[str, str]],
) -> dict:
    nodes = [
        node_id
        for node_id in node_ids
        if node_id in valid_ids
    ]

    edges = [
        {
            "source": source,
            "target": target,
        }
        for source, target in edge_pairs
        if (
            source in valid_ids
            and target in valid_ids
            and (source, target) in valid_edges
        )
    ]

    return {
        "id": story_id,
        "label": label,
        "subtitle": subtitle,
        "nodes": nodes,
        "edges": edges,
    }


# ---------------------------------------------------------------------------
# HTTP links (graph schema 2): browser modules to the server modules that serve their paths
# ---------------------------------------------------------------------------
#
# LocalAI rules only: browser = app/public/**/*.js(m); server = app/server.js and app/server/*.js. Matching rules:
#  * Browser side: every string literal that starts "/api/" (fetch, api(), EventSource, anything else). The query
#    (?..) and fragment are dropped. A literal cut by "${" (template), followed by "+" (concatenation) or ending in
#    "/" is "dynamic": only its prefix is known. Lines that are comments are skipped.
#  * Server side, a route is only a literal the server compares the request path with: `=== '/api/x'` (either
#    side), `case '/api/x':`, an object key `'/api/x':`, a table row `['/api/x', ...]`, `['/api/x', ...].includes(p)` (exact), `startsWith('/api/x/')`
#    (prefix) and a regex literal `/^\/api\/x\/(\w+)\/keep$/` (pattern: a segment with regex syntax is a "*"
#    wildcard). Literals a server only sends or returns (`fetch('/api/x')`, `endpoint: '/api/x'`) are not routes, and
#    a prefix of "/api/" alone is ignored because it would serve every path. Routes built from variables or
#    constants are not seen, so a path served that way is reported dangling (documented, not guessed).
#  * A path matches the longest route that fits: exact (or pattern, by segments) for a complete path, a prefix
#    route for any path starting with it. A dynamic path is covered by a prefix route that starts it, else by the
#    routes that extend it. Ties go to app/server.js (the router), then to the path name. A path no route fits is
#    "dangling"; a dynamic path is dangling only when no route could still complete it.

HTTP_BROWSER_RE = re.compile(r"""(['"`])(/api/[^\n]*?)\1""")
HTTP_CONST_RE = re.compile(r"""\b([A-Za-z_$][\w$]*)\s*=(?![=>])\s*(['"`])(/api/[\w./~%:@-]*)\2""")
HTTP_PATH_CHARS = re.compile(r"^/api/[\w.~%:@/*-]*")
SERVER_EXACT_RE = [
    re.compile(r"""={2,3}\s*(['"`])(/api/[^'"`\n]*)\1"""),
    re.compile(r"""(['"`])(/api/[^'"`\n]*)\1\s*={2,3}"""),
    re.compile(r"""\bcase\s+(['"`])(/api/[^'"`\n]*)\1\s*:"""),
    re.compile(r"""^\s*(['"`])(/api/[^'"`\n]*)\1\s*:"""),
    re.compile(r"""^\s*\[\s*(['"`])(/api/[^'"`\n]*)\1\s*,"""),  # a route table row: ['/api/x', handler]
]
SERVER_PREFIX_RE = re.compile(r"""\.startsWith\(\s*(['"`])(/api/[^'"`\n]*)\1""")
SERVER_LIST_RE = re.compile(r"""\[([^\]\n]*)\]\s*\.includes\(""")
SERVER_LITERAL_RE = re.compile(r"""(['"`])(/api/[^'"`\n]*)\1""")


def is_comment_line(line: str) -> bool:
    return line.lstrip().startswith(("//", "/*", "*"))


def http_browser_files(files: list[Path]) -> list[Path]:
    out = []
    for path in files:
        parts = path.relative_to(ROOT).parts
        if path.suffix.lower() in (".js", ".mjs") and len(parts) > 2 and parts[:2] == ("app", "public"):
            out.append(path)
    return out


def http_server_files(files: list[Path]) -> list[Path]:
    out = []
    for path in files:
        parts = path.relative_to(ROOT).parts
        if path.suffix.lower() == ".js" and (parts == ("app", "server.js") or (len(parts) == 3 and parts[:2] == ("app", "server"))):
            out.append(path)
    return out


def clean_route(path: str) -> str:
    return re.split(r"[?#]", path, maxsplit=1)[0].strip()


def regex_route(source: str) -> str | None:
    """A /^\\/api\\/x\\/(\\w+)$/ regex body to a path with "*" for each segment that uses regex syntax, or None."""
    body = source.replace("\\/", "/")
    body = re.sub(r"\(\?:\\\?\|\$\)$", "", body)  # an optional query tail: (?:\?|$)
    body = body.rstrip("$")
    segments = []
    for seg in body.split("/"):
        if re.search(r"[()\[\]{}+*?|\\^$]", seg):
            segments.append("*")
        else:
            segments.append(seg)
    path = "/".join(segments)
    return path if path.startswith("/api/") and len(path) > len("/api/") and path != "/api/*" else None


def server_regex_literals(line: str) -> list[str]:
    """Bodies of regex literals that start /^\\/api\\/ (scanned to the first unescaped slash outside a class)."""
    found = []
    start = 0
    marker = "/^\\/api\\/"
    while (at := line.find(marker, start)) != -1:
        i, in_class = at + 1, False
        while i < len(line):
            ch = line[i]
            if ch == "\\":
                i += 2
                continue
            if ch == "[":
                in_class = True
            elif ch == "]":
                in_class = False
            elif ch == "/" and not in_class:
                break
            i += 1
        body = line[at + 2:i]
        route = regex_route(body)
        if route:
            found.append(route)
        start = max(i, at + len(marker))
    return found


def collect_server_routes(files: list[Path]) -> list[dict]:
    routes: dict[tuple[str, str, str], dict] = {}

    def add(path: str, match: str, module: str, line: int) -> None:
        path = clean_route(path)
        if len(path) <= len("/api/"):
            return  # "/api/" alone would claim every path
        routes.setdefault((path, match, module), {"path": path, "match": match, "module": module, "line": line})

    for file in http_server_files(files):
        module = rel(file)
        try:
            lines = file.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        for number, line in enumerate(lines, 1):
            if is_comment_line(line):
                continue
            for rx in SERVER_EXACT_RE:
                for m in rx.finditer(line):
                    add(m.group(2), "exact", module, number)
            for m in SERVER_PREFIX_RE.finditer(line):
                add(m.group(2), "prefix", module, number)
            for m in SERVER_LIST_RE.finditer(line):
                for lit in SERVER_LITERAL_RE.finditer(m.group(1)):
                    add(lit.group(2), "exact", module, number)
            for route in server_regex_literals(line):
                add(route, "pattern" if "*" in route else "exact", module, number)
    return sorted(routes.values(), key=lambda r: (r["path"], r["match"], r["module"]))


def browser_path(raw: str, after: str, base: bool = False) -> tuple[str, bool] | None:
    """(path, dynamic) for the text of a browser literal that starts "/api/", or None when it is not a usable path.
    `after` is the code following the literal; `base` is a literal kept in a constant that other code extends."""
    m = HTTP_PATH_CHARS.match(raw)
    path = m.group(0) if m else ""
    rest = raw[len(path):]
    dynamic = base
    if rest.startswith(("?", "#")):
        pass
    elif rest.startswith("$") or path.endswith("/"):
        dynamic = True
    elif rest == "" and re.match(r"\s*\+", after):
        dynamic = True
    if len(path) <= len("/api/") or "*" in path:
        return None
    return path, dynamic


def collect_browser_paths(files: list[Path]) -> list[dict]:
    found: dict[tuple[str, str, bool], dict] = {}
    for file in http_browser_files(files):
        source = rel(file)
        try:
            lines = file.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        # A path kept in a constant (API = '/api/gridcraft') is a base: `${API}/runs` and API + '/runs' extend it,
        # and the constant itself only says "starts with", so it is dynamic.
        bases = {m.group(1): m.group(3) for line in lines if not is_comment_line(line)
                 for m in HTTP_CONST_RE.finditer(line)}

        def add(entry: tuple[str, bool] | None, number: int) -> None:
            if entry:
                found.setdefault((source, entry[0], entry[1]), {"source": source, "path": entry[0], "dynamic": entry[1], "line": number})

        for number, line in enumerate(lines, 1):
            if is_comment_line(line):
                continue
            for m in HTTP_BROWSER_RE.finditer(line):
                is_base = any(c.start(2) == m.start(1) for c in HTTP_CONST_RE.finditer(line))
                add(browser_path(m.group(2), line[m.end():], base=is_base), number)
            for name, base in bases.items():
                for m in re.finditer(r"`\$\{" + re.escape(name) + r"\}([^`\n]*)`", line):
                    add(browser_path(base + m.group(1), ""), number)
                for m in re.finditer(r"\b" + re.escape(name) + r"\s*\+\s*(['\"`])(.*?)\1", line):
                    add(browser_path(base + m.group(2), line[m.end():]), number)
    return list(found.values())


def segments_fit(route_path: str, path: str, dynamic: bool) -> bool:
    """Does a pattern route (with "*" segments) fit the path, or still fit it once a dynamic path is completed?"""
    want = route_path.split("/")
    have = path.split("/")
    if dynamic:
        if path.endswith("/"):
            have = have[:-1]  # the trailing empty segment is the part still to come
        elif len(have) > len(want):
            return False
        else:
            tail = have[-1]
            have = have[:-1]
            if len(have) >= len(want) or not (want[len(have)] == "*" or want[len(have)].startswith(tail)):
                return False
        return len(have) < len(want) and all(w == "*" or w == h for w, h in zip(want, have))
    return len(want) == len(have) and all(w == "*" or w == h for w, h in zip(want, have))


def route_order(route: dict) -> tuple:
    return (-len(route["path"].replace("*", "")), route["match"] != "exact", route["module"] != "app/server.js", route["module"])


def match_http_path(path: str, dynamic: bool, routes: list[dict]) -> list[dict]:
    """The routes serving this browser path, best first: the owner(s) of the longest fit (see the rules above)."""
    covering = []
    for r in routes:
        if r["match"] == "prefix":
            if path.startswith(r["path"]):
                covering.append(r)
        elif "*" in r["path"]:
            if segments_fit(r["path"], path, dynamic):
                covering.append(r)
        elif not dynamic and path == r["path"]:
            covering.append(r)
    if not dynamic:
        return sorted(covering, key=route_order)[:1]
    # A dynamic path: the longest prefix route that starts it; else the routes that extend it, any of which may serve it.
    prefixed = sorted((r for r in covering if r["match"] == "prefix"), key=route_order)
    if prefixed:
        return prefixed[:1]
    extending = [r for r in routes if r["match"] != "prefix" and "*" not in r["path"] and r["path"].startswith(path)]
    return sorted(covering + [r for r in extending if r not in covering], key=route_order)


def scan_http(files: list[Path]) -> tuple[list[dict], list[dict], list[dict]]:
    """(http edges, dangling browser paths, server routes) for the repository, or nothing if it has no such layout."""
    routes = collect_server_routes(files)
    browser = collect_browser_paths(files)
    node_ids = {rel(f) for f in files}
    links: dict[tuple[str, str], set[str]] = {}
    dangling = []
    for entry in browser:
        owners = match_http_path(entry["path"], entry["dynamic"], routes)
        if not owners:
            dangling.append({"source": entry["source"], "path": entry["path"], "line": entry["line"]})
            continue
        for owner in {o["module"] for o in owners}:
            if owner in node_ids and owner != entry["source"]:
                links.setdefault((entry["source"], owner), set()).add(entry["path"])
    edges = [
        {"source": s, "target": t, "kind": "http", "paths": sorted(paths)}
        for (s, t), paths in sorted(links.items())
    ]
    dangling.sort(key=lambda d: (d["source"], d["path"], d["line"]))
    return edges, dangling, [{k: r[k] for k in ("path", "match", "module")} for r in routes]


def build_graph(files: list[Path]) -> dict:
    known = {
        path.resolve()
        for path in files
    }

    file_domains = {
        path: classify(path)
        for path in files
    }

    dependencies: dict[
        Path,
        set[Path],
    ] = {}

    for path in files:
        if path.suffix.lower() == ".py":
            parsed = parse_python(
                path,
                known,
            )
        else:
            parsed = parse_javascript(
                path,
                known,
            )

        dependencies[path] = {
            dependency
            for dependency in parsed
            if dependency != path
        }

    inbound = Counter()
    outbound = Counter()

    edges: list[dict] = []

    for source, targets in dependencies.items():
        source_id = rel(source)

        for target in targets:
            target_id = rel(target)

            inbound[target_id] += 1
            outbound[source_id] += 1

            edges.append(
                {
                    "source": source_id,
                    "target": target_id,
                    # An edge from a test is a test link (kept apart so a page can count tests without drawing them).
                    "kind": "test" if file_domains.get(source) == "Tests" else "import",
                }
            )

    # HTTP links are added to the graph's edges at the end. Everything below (counts, risk, domain links, the
    # relationship total) is computed from the import and test edges only, so schema 2 changes no score.
    http_edges, dangling_http, http_routes = scan_http(files)

    git_changed = changed_files()

    test_refs = Counter()

    for edge in edges:
        source_path = ROOT / edge["source"]
        target_path = ROOT / edge["target"]

        source_domain = file_domains.get(
            source_path.resolve()
        )

        target_domain = file_domains.get(
            target_path.resolve()
        )

        if (
            source_domain == "Tests"
            and target_domain != "Tests"
        ):
            test_refs[
                edge["target"]
            ] += 1

    nodes: list[dict] = []

    for path in files:
        node_id = rel(path)

        domain = file_domains[path]

        incoming = inbound[node_id]
        outgoing = outbound[node_id]

        changed = (
            node_id in git_changed
        )

        coverage = test_refs[node_id]

        risk = risk_score(
            inbound=incoming,
            outbound=outgoing,
            test_refs=coverage,
            changed=changed,
            domain=domain,
        )

        nodes.append(
            {
                "id": node_id,
                "label": path.name,
                "path": node_id,
                "domain": domain,
                "extension": path.suffix.lower(),
                "inbound": incoming,
                "outbound": outgoing,
                "degree": incoming + outgoing,
                "testRefs": coverage,
                "changed": changed,
                "risk": risk,
                "riskLevel": risk_level(risk),
            }
        )

    node_by_id = {
        node["id"]: node
        for node in nodes
    }

    domain_counts = Counter()
    domain_changed = Counter()
    domain_risk_total = Counter()
    domain_tested = Counter()

    for node in nodes:
        domain = node["domain"]

        domain_counts[domain] += 1
        domain_risk_total[
            domain
        ] += node["risk"]

        if node["changed"]:
            domain_changed[
                domain
            ] += 1

        if node["testRefs"] > 0:
            domain_tested[
                domain
            ] += 1

    domains: list[dict] = []

    for domain in sorted(
        domain_counts,
        key=domain_sort_key,
    ):
        count = domain_counts[domain]

        domains.append(
            {
                "id": domain,
                "description": DOMAIN_DESCRIPTIONS.get(
                    domain,
                    "",
                ),
                "count": count,
                "changed": domain_changed[
                    domain
                ],
                "averageRisk": round(
                    domain_risk_total[
                        domain
                    ]
                    / max(1, count)
                ),
                "tested": domain_tested[
                    domain
                ],
            }
        )

    domain_edge_counts: Counter[
        tuple[str, str]
    ] = Counter()

    for edge in edges:
        source = node_by_id[
            edge["source"]
        ]["domain"]

        target = node_by_id[
            edge["target"]
        ]["domain"]

        if source != target:
            domain_edge_counts[
                (source, target)
            ] += 1

    domain_edges = [
        {
            "source": source,
            "target": target,
            "count": count,
        }
        for (
            source,
            target,
        ), count in sorted(
            domain_edge_counts.items()
        )
    ]

    hotspots = sorted(
        (
            node
            for node in nodes
            if node["domain"] != "Tests"
        ),
        key=lambda node: (
            -node["degree"],
            -node["risk"],
            node["path"],
        ),
    )[:20]

    highest_risk = sorted(
        (
            node
            for node in nodes
            if node["domain"] != "Tests"
        ),
        key=lambda node: (
            -node["risk"],
            -node["degree"],
            node["path"],
        ),
    )[:20]

    changed_nodes = sorted(
        (
            node
            for node in nodes
            if node["changed"]
        ),
        key=lambda node: (
            -node["risk"],
            node["path"],
        ),
    )

    valid_ids = set(node_by_id)

    valid_edges = {
        (
            edge["source"],
            edge["target"],
        )
        for edge in edges
    }

    stories = [
        build_story(
            story_id="mission",
            label="Mission Execution",
            subtitle="Server → agents → orchestration → model coordination",
            node_ids=[
                "app/server.js",
                "app/server/agents.js",
                "app/agent-orchestrator.js",
                "app/model-coordinator.js",
            ],
            edge_pairs=[
                (
                    "app/server.js",
                    "app/server/agents.js",
                ),
                (
                    "app/server/agents.js",
                    "app/agent-orchestrator.js",
                ),
                (
                    "app/agent-orchestrator.js",
                    "app/model-coordinator.js",
                ),
            ],
            valid_ids=valid_ids,
            valid_edges=valid_edges,
        ),
        build_story(
            story_id="chat",
            label="Chat Routing",
            subtitle="Platform → chat API → model routing",
            node_ids=[
                "app/server.js",
                "app/server/chat.js",
                "app/model-router.js",
                "app/model-coordinator.js",
            ],
            edge_pairs=[
                (
                    "app/server.js",
                    "app/server/chat.js",
                ),
                (
                    "app/server/chat.js",
                    "app/model-router.js",
                ),
                (
                    "app/server/chat.js",
                    "app/model-coordinator.js",
                ),
            ],
            valid_ids=valid_ids,
            valid_edges=valid_edges,
        ),
        build_story(
            story_id="workshop",
            label="Workshop Command",
            subtitle="Platform → Workshop → model transport",
            node_ids=[
                "app/server.js",
                "app/workshop.js",
                "app/model-http.js",
            ],
            edge_pairs=[
                (
                    "app/server.js",
                    "app/workshop.js",
                ),
                (
                    "app/workshop.js",
                    "app/model-http.js",
                ),
            ],
            valid_ids=valid_ids,
            valid_edges=valid_edges,
        ),
        build_story(
            story_id="images",
            label="Image Generation",
            subtitle="Platform image surfaces and generation engines",
            node_ids=[
                "app/server.js",
                "app/server/images.js",
                "app/image-engines.js",
            ],
            edge_pairs=[
                (
                    "app/server.js",
                    "app/server/images.js",
                ),
                (
                    "app/server.js",
                    "app/image-engines.js",
                ),
            ],
            valid_ids=valid_ids,
            valid_edges=valid_edges,
        ),
        build_story(
            story_id="claude",
            label="Claude Bridge",
            subtitle="Claude bridge and CLI converge on relay",
            node_ids=[
                "host/claude-chat/bridge.mjs",
                "host/claude-chat/cli.mjs",
                "host/claude-chat/relay.mjs",
            ],
            edge_pairs=[
                (
                    "host/claude-chat/bridge.mjs",
                    "host/claude-chat/relay.mjs",
                ),
                (
                    "host/claude-chat/cli.mjs",
                    "host/claude-chat/relay.mjs",
                ),
            ],
            valid_ids=valid_ids,
            valid_edges=valid_edges,
        ),
    ]

    non_test_nodes = [
        node
        for node in nodes
        if node["domain"] != "Tests"
    ]

    tested_nodes = sum(
        1
        for node in non_test_nodes
        if node["testRefs"] > 0
    )

    stats = {
        "files": len(nodes),
        "productionFiles": len(
            non_test_nodes
        ),
        "tests": sum(
            1
            for node in nodes
            if node["domain"] == "Tests"
        ),
        "relationships": len(
            edges
        ),
        "domains": len(domains),
        "changed": len(
            changed_nodes
        ),
        "testedProduction": tested_nodes,
        "truncated": SCAN["truncated"],
        "maxFiles": MAX_FILES,
        "gitError": SCAN["gitError"],
        "coverageRatio": round(
            (
                tested_nodes
                / max(
                    1,
                    len(non_test_nodes),
                )
            )
            * 100
        ),
    }

    stats["httpLinks"] = len(http_edges)
    stats["danglingHttp"] = len(dangling_http)

    return {
        "schemaVersion": 2,
        "root": f"{SNAPSHOT['repo']}@{SNAPSHOT['commit']}" if SNAPSHOT else str(ROOT),
        "generatedAt": datetime.now(
            timezone.utc
        ).isoformat(),
        "nodes": nodes,
        "edges": edges + http_edges,
        "danglingHttp": dangling_http,
        "httpRoutes": http_routes,
        "domains": domains,
        "domainEdges": domain_edges,
        "hotspots": hotspots,
        "highestRisk": highest_risk,
        "changedNodes": changed_nodes,
        "stories": stories,
        "stats": stats,
    }


# ---------------------------------------------------------------------------
# HTML application
# ---------------------------------------------------------------------------


HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
>

<title>Local AI · System Atlas</title>

<style>
:root {
    color-scheme: dark;

    --bg: #05070b;
    --surface: rgba(12, 16, 24, .88);
    --surface-strong: rgba(17, 22, 32, .97);
    --surface-soft: rgba(255,255,255,.035);

    --line: rgba(255,255,255,.075);
    --line-strong: rgba(255,255,255,.15);

    --text: #f4f7fb;
    --muted: #8993a5;
    --faint: #596273;

    --cyan: #57ddff;
    --blue: #6d91ff;
    --violet: #a57dff;
    --pink: #ff70dc;
    --green: #5ce6a4;
    --amber: #f4bd63;
    --red: #ff6b81;

    --sidebar: 274px;
    --inspector: 350px;
    --header: 76px;
}

* {
    box-sizing: border-box;
}

html,
body {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
}

body {
    color: var(--text);

    font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;

    background:
        radial-gradient(
            circle at 22% -10%,
            rgba(50, 127, 255, .20),
            transparent 34rem
        ),
        radial-gradient(
            circle at 85% 0%,
            rgba(227, 75, 210, .105),
            transparent 30rem
        ),
        #05070b;
}

button,
input,
select {
    font: inherit;
}

button {
    color: inherit;
}

button:focus-visible,
input:focus-visible,
select:focus-visible {
    outline: 2px solid var(--cyan);
    outline-offset: 2px;
}

.shell {
    display: grid;

    grid-template-columns:
        var(--sidebar)
        minmax(0,1fr)
        var(--inspector);

    grid-template-rows:
        var(--header)
        minmax(0,1fr);

    width: 100%;
    height: 100%;
}

/* -------------------------------------------------------------
   Header
------------------------------------------------------------- */

.header {
    z-index: 40;

    grid-column: 1 / -1;

    display: flex;
    align-items: center;
    gap: 20px;

    padding: 0 20px;

    border-bottom:
        1px solid var(--line);

    background:
        linear-gradient(
            180deg,
            rgba(12,16,23,.98),
            rgba(8,11,17,.93)
        );

    backdrop-filter: blur(24px);
}

.brand {
    width: 252px;
    min-width: 252px;
}

.brand-eyebrow {
    color: var(--cyan);

    font-size: 9px;
    font-weight: 850;
    letter-spacing: .18em;
    text-transform: uppercase;
}

.brand-title {
    margin-top: 3px;

    font-size: 16px;
    font-weight: 760;
    letter-spacing: -.02em;
}

.brand-title span {
    color: var(--muted);
    font-weight: 500;
}

.search {
    position: relative;

    flex: 1;
    max-width: 650px;
}

.search input {
    width: 100%;

    padding:
        11px
        42px
        11px
        14px;

    border:
        1px solid var(--line);

    border-radius: 10px;

    color: var(--text);

    background:
        rgba(255,255,255,.042);
}

.search input::placeholder {
    color: #657084;
}

.search-key {
    position: absolute;
    top: 8px;
    right: 9px;

    padding: 3px 6px;

    border:
        1px solid var(--line);

    border-radius: 5px;

    color: var(--faint);
    font-size: 10px;
}

.header-metrics {
    display: flex;
    gap: 22px;

    margin-left: auto;
}

.header-metric {
    text-align: right;
}

.header-metric strong {
    display: block;

    font-size: 13px;
}

.header-metric span {
    color: var(--muted);
    font-size: 9px;
}

/* -------------------------------------------------------------
   Side panels
------------------------------------------------------------- */

.sidebar,
.inspector {
    overflow: auto;

    background:
        rgba(7,10,15,.75);

    backdrop-filter: blur(20px);
}

.sidebar {
    border-right:
        1px solid var(--line);
}

.inspector {
    border-left:
        1px solid var(--line);
}

.section {
    padding: 15px 14px;

    border-bottom:
        1px solid var(--line);
}

.section-title {
    margin:
        0
        0
        9px;

    color: var(--faint);

    font-size: 9px;
    font-weight: 850;
    letter-spacing: .15em;
    text-transform: uppercase;
}

.stack {
    display: grid;
    gap: 3px;
}

.view-btn,
.domain-btn,
.story-btn,
.hotspot-btn {
    width: 100%;

    border: 0;
    border-radius: 8px;

    cursor: pointer;

    text-align: left;

    background: transparent;

    transition:
        background .15s ease,
        opacity .15s ease,
        transform .15s ease;
}

.view-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;

    padding: 8px 9px;

    color: var(--muted);
}

.view-btn:hover,
.view-btn.active {
    color: var(--text);

    background:
        rgba(255,255,255,.05);
}

.view-btn.active {
    box-shadow:
        inset 2px 0 0 var(--cyan);
}

.view-meta {
    color: var(--faint);

    font-size: 9px;
}

.domain-btn {
    display: grid;

    grid-template-columns:
        7px
        1fr
        auto;

    align-items: center;
    gap: 8px;

    padding: 6px 8px;

    color: var(--muted);
}

.domain-btn:hover {
    background:
        rgba(255,255,255,.04);
}

.domain-btn.off {
    opacity: .28;
}

.domain-dot {
    width: 7px;
    height: 7px;

    border-radius: 50%;
}

.domain-number {
    color: var(--faint);
    font-size: 9px;
}

.story-btn {
    padding: 8px 9px;
}

.story-btn:hover,
.story-btn.active {
    background:
        rgba(255,255,255,.045);
}

.story-btn strong {
    display: block;

    font-size: 10px;
    font-weight: 650;
}

.story-btn span {
    display: block;

    margin-top: 2px;

    color: var(--faint);

    font-size: 8px;
    line-height: 1.45;
}

.hotspot-btn {
    padding: 6px 8px;
}

.hotspot-btn:hover {
    background:
        rgba(255,255,255,.04);
}

.hotspot-name {
    overflow: hidden;

    color: #cbd2de;

    font-size: 10px;

    text-overflow: ellipsis;
    white-space: nowrap;
}

.hotspot-meta {
    margin-top: 2px;

    color: var(--faint);

    font-size: 8px;
}

/* -------------------------------------------------------------
   Path finder
------------------------------------------------------------- */

.path-box {
    display: grid;
    gap: 7px;
}

.path-box input {
    width: 100%;

    padding: 8px 9px;

    border:
        1px solid var(--line);

    border-radius: 7px;

    color: var(--text);

    font-size: 9px;

    background:
        rgba(255,255,255,.035);
}

.path-actions {
    display: grid;

    grid-template-columns:
        1fr
        auto;

    gap: 6px;
}

.small-btn {
    min-height: 32px;

    padding: 0 10px;

    border:
        1px solid var(--line);

    border-radius: 7px;

    cursor: pointer;

    color: #c9d1df;

    font-size: 9px;

    background:
        rgba(255,255,255,.035);
}

.small-btn:hover {
    border-color:
        var(--line-strong);

    background:
        rgba(255,255,255,.06);
}

/* -------------------------------------------------------------
   Stage
------------------------------------------------------------- */

.stage {
    position: relative;

    min-width: 0;

    overflow: hidden;
}

.stage::before {
    position: absolute;
    inset: 0;

    content: "";

    pointer-events: none;

    background-image:
        linear-gradient(
            rgba(255,255,255,.02)
            1px,
            transparent
            1px
        ),
        linear-gradient(
            90deg,
            rgba(255,255,255,.02)
            1px,
            transparent
            1px
        );

    background-size:
        32px
        32px;

    mask-image:
        linear-gradient(
            to bottom,
            rgba(0,0,0,.7),
            transparent 100%
        );
}

.stage::after {
    position: absolute;
    inset: 0;

    content: "";

    pointer-events: none;

    box-shadow:
        inset 0 0 120px
        rgba(0,0,0,.45);
}

#graph {
    display: block;

    width: 100%;
    height: 100%;

    cursor: grab;

    user-select: none;
}

#graph.dragging {
    cursor: grabbing;
}

.toolbar {
    position: absolute;
    z-index: 20;

    top: 14px;
    left: 14px;

    display: flex;
    gap: 5px;
}

.toolbar button {
    width: 34px;
    height: 34px;

    border:
        1px solid var(--line);

    border-radius: 8px;

    cursor: pointer;

    background:
        rgba(11,15,22,.92);

    backdrop-filter:
        blur(16px);
}

.toolbar button:hover {
    border-color:
        var(--line-strong);

    background:
        rgba(27,33,45,.96);
}

.snapshot {
    position: absolute;
    z-index: 18;

    top: 14px;
    right: 14px;

    display: flex;
    gap: 8px;
}

.snapshot-card {
    min-width: 90px;

    padding: 8px 10px;

    border:
        1px solid var(--line);

    border-radius: 9px;

    background:
        rgba(10,14,21,.88);

    backdrop-filter:
        blur(15px);
}

.snapshot-card strong {
    display: block;

    font-size: 13px;
}

.snapshot-card span {
    color: var(--faint);

    font-size: 8px;
}

.legend {
    position: absolute;
    z-index: 15;

    bottom: 14px;
    left: 14px;

    padding: 7px 9px;

    border:
        1px solid var(--line);

    border-radius: 8px;

    color: var(--muted);

    font-size: 9px;

    background:
        rgba(9,13,20,.87);

    backdrop-filter:
        blur(14px);
}

/* -------------------------------------------------------------
   SVG
------------------------------------------------------------- */

.edge {
    fill: none;

    stroke:
        rgba(110,144,190,.17);

    stroke-width: 1;

    vector-effect:
        non-scaling-stroke;

    transition:
        opacity .15s ease,
        stroke .15s ease;
}

.edge.dim {
    opacity: .035;
}

.edge.active,
.edge.path {
    stroke: var(--cyan);
    stroke-width: 1.8;
    opacity: .95;
}

.domain-edge {
    fill: none;

    stroke:
        rgba(103,139,187,.20);

    vector-effect:
        non-scaling-stroke;
}

.domain-edge.flow {
    stroke-dasharray: 8 11;

    animation:
        edgeFlow
        2s linear
        infinite;
}

@keyframes edgeFlow {
    to {
        stroke-dashoffset: -38;
    }
}

.node {
    cursor: pointer;
}

.node rect {
    fill:
        rgba(16,22,32,.96);

    stroke:
        rgba(255,255,255,.105);

    stroke-width: 1;

    vector-effect:
        non-scaling-stroke;

    transition:
        opacity .15s ease,
        fill .15s ease,
        stroke .15s ease;
}

.node:hover rect {
    fill: #182332;

    stroke:
        rgba(255,255,255,.28);
}

.node.selected rect,
.node.path-node rect {
    fill: #132536;

    stroke: var(--cyan);

    stroke-width: 1.8;
}

.node.related rect {
    stroke:
        rgba(87,221,255,.58);
}

.node.dim {
    opacity: .075;
}

.node.changed rect {
    filter:
        drop-shadow(
            0 0 6px
            rgba(244,189,99,.28)
        );
}

.node-title {
    fill: var(--text);

    font-size: 10px;
    font-weight: 650;

    pointer-events: none;
}

.node-subtitle {
    fill: #737f93;

    font-size: 7px;

    pointer-events: none;
}

.changed-mark {
    fill: var(--amber);

    pointer-events: none;
}

.risk-low {
    stroke: #637287 !important;
}

.risk-medium {
    stroke: var(--amber) !important;
}

.risk-high {
    stroke: #ff9171 !important;
}

.risk-critical {
    stroke: var(--red) !important;
}

.domain-node {
    cursor: pointer;
}

.domain-node rect {
    fill:
        rgba(15,21,31,.97);

    stroke-width: 1.7;

    vector-effect:
        non-scaling-stroke;

    filter:
        drop-shadow(
            0 14px 24px
            rgba(0,0,0,.32)
        );
}

.domain-node:hover rect {
    fill: #182333;
}

.domain-title {
    fill: white;

    font-size: 14px;
    font-weight: 760;

    pointer-events: none;
}

.domain-description {
    fill: #7f899b;

    font-size: 8px;

    pointer-events: none;
}

.domain-count {
    fill: #aeb7c5;

    font-size: 9px;

    pointer-events: none;
}

.domain-status {
    fill: #636d7e;

    font-size: 8px;

    pointer-events: none;
}

/* -------------------------------------------------------------
   Inspector
------------------------------------------------------------- */

.inspector-home {
    padding: 19px;
}

.inspector-eyebrow {
    margin-bottom: 6px;

    color: var(--cyan);

    font-size: 9px;
    font-weight: 850;
    letter-spacing: .13em;
    text-transform: uppercase;
}

.inspector-title {
    font-size: 17px;
    font-weight: 750;
    line-height: 1.3;

    overflow-wrap: anywhere;
}

.inspector-copy {
    margin-top: 8px;

    color: var(--muted);

    font-size: 10px;
    line-height: 1.65;
}

.inspector-header {
    padding: 18px;

    border-bottom:
        1px solid var(--line);
}

.path-label {
    margin-top: 8px;

    color: var(--muted);

    font-family:
        "Cascadia Code",
        Consolas,
        monospace;

    font-size: 9px;
    line-height: 1.5;

    overflow-wrap: anywhere;
}

.metric-grid {
    display: grid;

    grid-template-columns:
        repeat(3,1fr);

    gap: 6px;

    margin-top: 14px;
}

.metric {
    padding: 8px;

    border:
        1px solid var(--line);

    border-radius: 8px;

    background:
        var(--surface-soft);
}

.metric strong {
    display: block;

    font-size: 13px;
}

.metric span {
    color: var(--faint);

    font-size: 8px;
}

.risk-meter {
    margin-top: 13px;
}

.risk-track {
    height: 5px;

    overflow: hidden;

    border-radius: 999px;

    background:
        rgba(255,255,255,.06);
}

.risk-fill {
    height: 100%;

    border-radius: inherit;

    background:
        linear-gradient(
            90deg,
            var(--green),
            var(--amber),
            var(--red)
        );
}

.risk-caption {
    display: flex;
    justify-content: space-between;

    margin-top: 5px;

    color: var(--faint);

    font-size: 8px;
}

.relationships {
    display: grid;
    gap: 3px;
}

.relationship-btn {
    width: 100%;

    padding: 6px 7px;

    border: 0;
    border-radius: 7px;

    cursor: pointer;

    color: #abb5c5;

    text-align: left;

    background: transparent;
}

.relationship-btn:hover {
    color: white;

    background:
        rgba(255,255,255,.04);
}

.relationship-btn small {
    display: block;

    margin-top: 2px;

    color: var(--faint);
}

.badge-row {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;

    margin-top: 10px;
}

.badge {
    padding: 4px 6px;

    border:
        1px solid var(--line);

    border-radius: 999px;

    color: #99a4b5;

    font-size: 8px;

    background:
        rgba(255,255,255,.035);
}

.badge.changed {
    color: var(--amber);

    border-color:
        rgba(244,189,99,.25);
}

.badge.covered {
    color: var(--green);

    border-color:
        rgba(92,230,164,.2);
}

.story-steps {
    display: grid;
    gap: 7px;
}

.story-step {
    display: grid;

    grid-template-columns:
        20px
        1fr;

    gap: 8px;

    align-items: center;
}

.story-index {
    display: grid;
    place-items: center;

    width: 20px;
    height: 20px;

    border:
        1px solid
        rgba(87,221,255,.25);

    border-radius: 50%;

    color: var(--cyan);

    font-size: 8px;
}

.story-step strong {
    font-size: 9px;
}

.story-step span {
    display: block;

    margin-top: 2px;

    color: var(--faint);

    font-size: 8px;
}

/* -------------------------------------------------------------
   Responsive
------------------------------------------------------------- */

@media (max-width: 1150px) {
    :root {
        --sidebar: 220px;
        --inspector: 290px;
    }

    .header-metrics {
        display: none;
    }
}

@media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
        transition: none !important;
        animation: none !important;
    }
}
</style>
</head>

<body>

<div class="shell">

<header class="header">
    <div class="brand">
        <div class="brand-eyebrow">
            Local AI
        </div>

        <div class="brand-title">
            System Atlas
            <span>· live repository map</span>
        </div>
    </div>

    <div class="search">
        <input
            id="search"
            type="search"
            placeholder="Search modules, domains, services…"
            aria-label="Search system atlas"
            autocomplete="off"
        >

        <span class="search-key">/</span>
    </div>

    <div class="header-metrics">
        <div class="header-metric">
            <strong id="metricFiles">—</strong>
            <span>source files</span>
        </div>

        <div class="header-metric">
            <strong id="metricEdges">—</strong>
            <span>relationships</span>
        </div>

        <div class="header-metric">
            <strong id="metricChanges">—</strong>
            <span>changed now</span>
        </div>
    </div>
</header>

<aside class="sidebar">

    <section class="section">
        <div class="section-title">
            Lenses
        </div>

        <div
            id="views"
            class="stack"
        ></div>
    </section>

    <section class="section">
        <div class="section-title">
            Guided flows
        </div>

        <div
            id="stories"
            class="stack"
        ></div>
    </section>

    <section class="section">
        <div class="section-title">
            Path finder
        </div>

        <div class="path-box">
            <input
                id="pathFrom"
                list="nodePaths"
                placeholder="From…"
            >

            <input
                id="pathTo"
                list="nodePaths"
                placeholder="To…"
            >

            <datalist id="nodePaths"></datalist>

            <div class="path-actions">
                <button
                    type="button"
                    class="small-btn"
                    id="findPath"
                >
                    Trace dependency
                </button>

                <button
                    type="button"
                    class="small-btn"
                    id="clearPath"
                    aria-label="Clear dependency path"
                >
                    ×
                </button>
            </div>
        </div>
    </section>

    <section class="section">
        <div class="section-title">
            Domains
        </div>

        <div
            id="domains"
            class="stack"
        ></div>
    </section>

    <section class="section">
        <div class="section-title">
            Hotspots
        </div>

        <div id="hotspots"></div>
    </section>

</aside>

<main class="stage">

    <svg
        id="graph"
        role="img"
        aria-label="Local AI system architecture"
    >
        <defs>
            <marker
                id="arrow"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
                markerUnits="strokeWidth"
            >
                <path
                    d="M0,0 L7,3.5 L0,7 Z"
                    fill="rgba(87,221,255,.6)"
                ></path>
            </marker>
        </defs>

        <g id="viewport"></g>
    </svg>

    <div class="toolbar">
        <button
            id="zoomIn"
            type="button"
            title="Zoom in"
            aria-label="Zoom in"
        >+</button>

        <button
            id="zoomOut"
            type="button"
            title="Zoom out"
            aria-label="Zoom out"
        >−</button>

        <button
            id="fit"
            type="button"
            title="Fit graph"
            aria-label="Fit graph"
        >◎</button>
    </div>

    <div class="snapshot">
        <div class="snapshot-card">
            <strong id="snapshotProd">—</strong>
            <span>production modules</span>
        </div>

        <div class="snapshot-card">
            <strong id="snapshotCoverage">—</strong>
            <span>import-test signal</span>
        </div>
    </div>

    <div
        id="legend"
        class="legend"
    >
        Drag · wheel zoom · click inspect · double-click domain
    </div>

</main>

<aside
    id="inspector"
    class="inspector"
></aside>

</div>

<script>
"use strict";

const DATA = __GRAPH_JSON__;
const NS = "http://www.w3.org/2000/svg";

const COLORS = {
    UI: "#57ddff",
    API: "#6d91ff",
    Platform: "#a57dff",
    Core: "#8491a5",
    AI: "#ff70dc",
    Data: "#5ce6a4",
    Media: "#ff86b8",
    Claude: "#ef9c63",
    GridCraft: "#62d7bd",
    Workshop: "#f4bd63",
    Host: "#8fa8ff",
    Runtime: "#ff7184",
    Tooling: "#8093a9",
    Docs: "#697486",
    Root: "#9ca6b5",
    Tests: "#4f5969",
};

const VIEW_DEFINITIONS = [
    {
        id: "system",
        label: "System",
        meta: "architecture",
    },
    {
        id: "code",
        label: "Code",
        meta: "dependencies",
    },
    {
        id: "changes",
        label: "Changes",
        meta: "working tree",
    },
    {
        id: "risk",
        label: "Risk",
        meta: "blast radius",
    },
    {
        id: "coverage",
        label: "Coverage",
        meta: "test signal",
    },
];

const state = {
    view: "system",
    search: "",
    selected: null,
    selectedStory: null,
    selectedPath: [],
    pathMode: null,
    hiddenDomains: new Set(["Tests"]),
    scale: 1,
    x: 0,
    y: 0,
    dragging: false,
    pointerX: 0,
    pointerY: 0,
};

const graph =
    document.getElementById("graph");

const viewport =
    document.getElementById("viewport");

const inspector =
    document.getElementById("inspector");

const search =
    document.getElementById("search");

const nodeById = new Map(
    DATA.nodes.map(
        node => [
            node.id,
            node,
        ]
    )
);

const outgoing = new Map();
const incoming = new Map();

for (const edge of DATA.edges) {
    if (!outgoing.has(edge.source)) {
        outgoing.set(
            edge.source,
            []
        );
    }

    if (!incoming.has(edge.target)) {
        incoming.set(
            edge.target,
            []
        );
    }

    outgoing
        .get(edge.source)
        .push(edge.target);

    incoming
        .get(edge.target)
        .push(edge.source);
}

function svgElement(
    name,
    attrs = {}
) {
    const element =
        document.createElementNS(
            NS,
            name
        );

    for (
        const [key, value]
        of Object.entries(attrs)
    ) {
        element.setAttribute(
            key,
            String(value)
        );
    }

    return element;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function colorFor(domain) {
    return COLORS[domain]
        || "#8190a5";
}

function truncate(
    value,
    length
) {
    if (value.length <= length) {
        return value;
    }

    return value.slice(
        0,
        length - 1
    ) + "…";
}

function riskColor(score) {
    if (score >= 70) {
        return "#ff6b81";
    }

    if (score >= 48) {
        return "#ff9171";
    }

    if (score >= 28) {
        return "#f4bd63";
    }

    return "#637287";
}

function clearGraph() {
    viewport.replaceChildren();
}

function updateTransform() {
    viewport.setAttribute(
        "transform",
        `translate(${state.x} ${state.y}) scale(${state.scale})`
    );
}

function fitGraph() {
    const bounds =
        graph.getBoundingClientRect();

    let box;

    try {
        box = viewport.getBBox();
    } catch {
        return;
    }

    if (
        !box.width
        || !box.height
        || !bounds.width
        || !bounds.height
    ) {
        return;
    }

    const padding = 80;

    state.scale = Math.max(
        .12,
        Math.min(
            1.18,
            (bounds.width - padding * 2)
                / box.width,
            (bounds.height - padding * 2)
                / box.height
        )
    );

    state.x =
        (
            bounds.width
            - box.width
            * state.scale
        ) / 2
        - box.x
        * state.scale;

    state.y =
        (
            bounds.height
            - box.height
            * state.scale
        ) / 2
        - box.y
        * state.scale;

    updateTransform();
}

function zoomBy(factor) {
    state.scale = Math.max(
        .08,
        Math.min(
            4,
            state.scale * factor
        )
    );

    updateTransform();
}

function drawCurve(
    parent,
    x1,
    y1,
    x2,
    y2,
    className,
    width = 1
) {
    const curve =
        Math.max(
            45,
            Math.abs(x2 - x1)
            * .35
        );

    const path =
        svgElement(
            "path",
            {
                d:
                    `M ${x1} ${y1} `
                    + `C ${x1 + curve} ${y1}, `
                    + `${x2 - curve} ${y2}, `
                    + `${x2} ${y2}`,
                class: className,
                "stroke-width": width,
            }
        );

    parent.appendChild(path);

    return path;
}

function pathEdges(path) {
    const result = new Set();

    for (
        let index = 0;
        index < path.length - 1;
        index += 1
    ) {
        result.add(
            `${path[index]}→${path[index + 1]}`
        );
    }

    return result;
}

function currentStory() {
    return DATA.stories.find(
        story =>
            story.id ===
            state.selectedStory
    ) || null;
}

function storyEdgeSet() {
    const story =
        currentStory();

    if (!story) {
        return new Set();
    }

    return new Set(
        story.edges.map(
            edge =>
                `${edge.source}→${edge.target}`
        )
    );
}

function storyNodeSet() {
    const story =
        currentStory();

    return new Set(
        story?.nodes || []
    );
}

function visibleNodes() {
    let nodes =
        DATA.nodes.filter(
            node =>
                !state.hiddenDomains.has(
                    node.domain
                )
        );

    if (state.view === "changes") {
        const changed =
            new Set(
                DATA.changedNodes.map(
                    node => node.id
                )
            );

        const expanded =
            new Set(changed);

        for (const id of changed) {
            for (
                const linked
                of outgoing.get(id) || []
            ) {
                expanded.add(linked);
            }

            for (
                const linked
                of incoming.get(id) || []
            ) {
                expanded.add(linked);
            }
        }

        nodes = nodes.filter(
            node =>
                expanded.has(node.id)
        );
    }

    if (state.view === "coverage") {
        nodes = nodes.filter(
            node =>
                node.domain !== "Tests"
        );
    }

    if (state.view === "risk") {
        nodes = nodes.filter(
            node =>
                node.domain !== "Tests"
        );
    }

    if (state.search) {
        nodes = nodes.filter(
            node =>
                (
                    `${node.label} `
                    + `${node.path} `
                    + `${node.domain}`
                )
                    .toLowerCase()
                    .includes(
                        state.search
                    )
        );
    }

    return nodes;
}

/* -------------------------------------------------------------
   System architecture
------------------------------------------------------------- */

const SYSTEM_POSITIONS = {
    UI: [90, 200],
    API: [390, 200],
    Platform: [680, 200],

    Core: [990, 90],
    AI: [990, 270],
    Data: [1290, 120],
    Media: [1290, 330],

    Claude: [370, 520],
    GridCraft: [660, 520],
    Workshop: [950, 520],

    Host: [1240, 520],
    Runtime: [1240, 690],
    Tooling: [650, 720],
    Docs: [90, 720],
    Root: [90, 520],
    Tests: [380, 720],
};

function renderSystem() {
    clearGraph();

    const domains =
        DATA.domains.filter(
            domain =>
                !state.hiddenDomains.has(
                    domain.id
                )
        );

    const allowed =
        new Set(
            domains.map(
                domain =>
                    domain.id
            )
        );

    const edgeLayer =
        svgElement("g");

    viewport.appendChild(
        edgeLayer
    );

    for (
        const edge
        of DATA.domainEdges
    ) {
        if (
            !allowed.has(edge.source)
            || !allowed.has(edge.target)
        ) {
            continue;
        }

        const source =
            SYSTEM_POSITIONS[
                edge.source
            ];

        const target =
            SYSTEM_POSITIONS[
                edge.target
            ];

        if (!source || !target) {
            continue;
        }

        const path =
            drawCurve(
                edgeLayer,
                source[0] + 110,
                source[1] + 41,
                target[0],
                target[1] + 41,
                "domain-edge flow",
                Math.min(
                    4.5,
                    .65
                    + Math.sqrt(
                        edge.count
                    )
                    * .23
                )
            );

        path.style.opacity =
            String(
                Math.min(
                    .55,
                    .13
                    + edge.count
                    / 60
                )
            );
    }

    const nodeLayer =
        svgElement("g");

    viewport.appendChild(
        nodeLayer
    );

    for (const domain of domains) {
        const position =
            SYSTEM_POSITIONS[
                domain.id
            ];

        if (!position) {
            continue;
        }

        const group =
            svgElement(
                "g",
                {
                    class:
                        "domain-node",
                    tabindex: "0",
                }
            );

        group.setAttribute(
            "transform",
            `translate(${position[0]} ${position[1]})`
        );

        const rect =
            svgElement(
                "rect",
                {
                    width: 220,
                    height: 82,
                    rx: 14,
                    stroke:
                        colorFor(
                            domain.id
                        ),
                }
            );

        const title =
            svgElement(
                "text",
                {
                    x: 14,
                    y: 24,
                    class:
                        "domain-title",
                }
            );

        title.textContent =
            domain.id;

        const description =
            svgElement(
                "text",
                {
                    x: 14,
                    y: 42,
                    class:
                        "domain-description",
                }
            );

        description.textContent =
            truncate(
                domain.description,
                35
            );

        const count =
            svgElement(
                "text",
                {
                    x: 14,
                    y: 64,
                    class:
                        "domain-count",
                }
            );

        count.textContent =
            `${domain.count} modules`;

        const status =
            svgElement(
                "text",
                {
                    x: 206,
                    y: 64,
                    class:
                        "domain-status",
                    "text-anchor":
                        "end",
                }
            );

        status.textContent =
            domain.changed
                ? `${domain.changed} changed`
                : `risk ${domain.averageRisk}`;

        group.append(
            rect,
            title,
            description,
            count,
            status
        );

        group.addEventListener(
            "click",
            event => {
                event.stopPropagation();
                showDomain(
                    domain.id
                );
            }
        );

        group.addEventListener(
            "dblclick",
            event => {
                event.stopPropagation();

                state.view =
                    "code";

                state.hiddenDomains =
                    new Set(
                        DATA.domains
                            .map(
                                item =>
                                    item.id
                            )
                            .filter(
                                id =>
                                    id !==
                                    domain.id
                            )
                    );

                renderAll();
            }
        );

        nodeLayer.appendChild(
            group
        );
    }
}

/* -------------------------------------------------------------
   Code graph
------------------------------------------------------------- */

function renderCode() {
    clearGraph();

    const nodes =
        visibleNodes();

    if (!nodes.length) {
        renderEmpty();
        return;
    }

    const domains = [
        ...new Set(
            nodes.map(
                node =>
                    node.domain
            )
        ),
    ].sort(
        (a, b) =>
            DATA.domains.findIndex(
                item =>
                    item.id === a
            )
            -
            DATA.domains.findIndex(
                item =>
                    item.id === b
            )
    );

    const width = 185;
    const height = 45;

    const columnGap = 232;
    const rowGap = 58;

    const positions =
        new Map();

    for (
        let column = 0;
        column < domains.length;
        column += 1
    ) {
        const domain =
            domains[column];

        const domainNodes =
            nodes
                .filter(
                    node =>
                        node.domain ===
                        domain
                )
                .sort(
                    (a, b) => {
                        if (
                            state.view ===
                            "risk"
                        ) {
                            return (
                                b.risk
                                - a.risk
                            );
                        }

                        if (
                            state.view ===
                            "coverage"
                        ) {
                            return (
                                a.testRefs
                                - b.testRefs
                                ||
                                b.degree
                                - a.degree
                            );
                        }

                        return (
                            b.degree
                            - a.degree
                            ||
                            a.path.localeCompare(
                                b.path
                            )
                        );
                    }
                );

        const x =
            60
            + column
            * columnGap;

        const heading =
            svgElement(
                "text",
                {
                    x,
                    y: 32,
                    fill:
                        colorFor(
                            domain
                        ),
                    "font-size": 10,
                    "font-weight": 800,
                    "letter-spacing":
                        ".11em",
                }
            );

        heading.textContent =
            domain.toUpperCase();

        viewport.appendChild(
            heading
        );

        domainNodes.forEach(
            (
                node,
                row
            ) => {
                positions.set(
                    node.id,
                    {
                        x,
                        y:
                            70
                            + row
                            * rowGap,
                    }
                );
            }
        );
    }

    const visibleIds =
        new Set(
            nodes.map(
                node =>
                    node.id
            )
        );

    const related =
        new Set();

    if (state.selected) {
        related.add(
            state.selected
        );

        for (
            const id
            of outgoing.get(
                state.selected
            ) || []
        ) {
            related.add(id);
        }

        for (
            const id
            of incoming.get(
                state.selected
            ) || []
        ) {
            related.add(id);
        }
    }

    const selectedPathSet =
        new Set(
            state.selectedPath
        );

    const selectedPathEdges =
        pathEdges(
            state.selectedPath
        );

    const storyNodes =
        storyNodeSet();

    const storyEdges =
        storyEdgeSet();

    const edgeLayer =
        svgElement("g");

    viewport.appendChild(
        edgeLayer
    );

    for (const edge of DATA.edges) {
        if (
            !visibleIds.has(
                edge.source
            )
            ||
            !visibleIds.has(
                edge.target
            )
        ) {
            continue;
        }

        const source =
            positions.get(
                edge.source
            );

        const target =
            positions.get(
                edge.target
            );

        if (!source || !target) {
            continue;
        }

        const key =
            `${edge.source}→${edge.target}`;

        const pathActive =
            selectedPathEdges.has(
                key
            );

        const storyActive =
            storyEdges.has(key);

        const selectedActive =
            state.selected
            &&
            (
                edge.source
                === state.selected
                ||
                edge.target
                === state.selected
            );

        const active =
            pathActive
            || storyActive
            || selectedActive;

        const anyFocus =
            state.selected
            || state.selectedPath.length
            || state.selectedStory;

        const className =
            "edge"
            + (
                active
                    ? " active"
                    : ""
            )
            + (
                pathActive
                    ? " path"
                    : ""
            )
            + (
                anyFocus
                && !active
                    ? " dim"
                    : ""
            );

        const curve =
            drawCurve(
                edgeLayer,
                source.x
                    + width,
                source.y
                    + height / 2,
                target.x,
                target.y
                    + height / 2,
                className
            );

        if (
            pathActive
            || storyActive
        ) {
            curve.setAttribute(
                "marker-end",
                "url(#arrow)"
            );
        }
    }

    const nodeLayer =
        svgElement("g");

    viewport.appendChild(
        nodeLayer
    );

    for (const node of nodes) {
        const position =
            positions.get(node.id);

        const selected =
            state.selected
            === node.id;

        const pathNode =
            selectedPathSet.has(
                node.id
            );

        const storyNode =
            storyNodes.has(
                node.id
            );

        const relatedNode =
            state.selected
            && related.has(
                node.id
            );

        const focusActive =
            state.selected
            || state.selectedPath.length
            || state.selectedStory;

        const relevant =
            selected
            || pathNode
            || storyNode
            || relatedNode;

        const group =
            svgElement(
                "g",
                {
                    tabindex: "0",
                    class:
                        "node"
                        + (
                            selected
                                ? " selected"
                                : ""
                        )
                        + (
                            pathNode
                                ? " path-node"
                                : ""
                        )
                        + (
                            relatedNode
                            && !selected
                                ? " related"
                                : ""
                        )
                        + (
                            node.changed
                                ? " changed"
                                : ""
                        )
                        + (
                            focusActive
                            && !relevant
                                ? " dim"
                                : ""
                        ),
                }
            );

        group.setAttribute(
            "transform",
            `translate(${position.x} ${position.y})`
        );

        const rect =
            svgElement(
                "rect",
                {
                    width,
                    height,
                    rx: 8,
                }
            );

        if (
            state.view ===
            "risk"
        ) {
            rect.style.stroke =
                riskColor(
                    node.risk
                );
        }

        if (
            state.view ===
            "coverage"
        ) {
            rect.style.stroke =
                node.testRefs > 0
                    ? "#5ce6a4"
                    : "#ff6b81";
        }

        const title =
            svgElement(
                "text",
                {
                    x: 10,
                    y: 18,
                    class:
                        "node-title",
                }
            );

        title.textContent =
            truncate(
                node.label,
                27
            );

        const subtitle =
            svgElement(
                "text",
                {
                    x: 10,
                    y: 34,
                    class:
                        "node-subtitle",
                }
            );

        if (
            state.view ===
            "risk"
        ) {
            subtitle.textContent =
                `risk ${node.risk} · ${node.degree} links`;
        } else if (
            state.view ===
            "coverage"
        ) {
            subtitle.textContent =
                `${node.testRefs} test imports`;
        } else {
            subtitle.textContent =
                `${node.inbound} in · ${node.outbound} out`;
        }

        group.append(
            rect,
            title,
            subtitle
        );

        if (node.changed) {
            const mark =
                svgElement(
                    "circle",
                    {
                        cx:
                            width - 10,
                        cy: 10,
                        r: 3,
                        class:
                            "changed-mark",
                    }
                );

            group.appendChild(
                mark
            );
        }

        const activate =
            event => {
                event.stopPropagation();

                state.selected =
                    node.id;

                showNode(
                    node.id
                );

                renderCode();
            };

        group.addEventListener(
            "click",
            activate
        );

        group.addEventListener(
            "keydown",
            event => {
                if (
                    event.key ===
                    "Enter"
                    ||
                    event.key ===
                    " "
                ) {
                    event.preventDefault();
                    activate(event);
                }
            }
        );

        nodeLayer.appendChild(
            group
        );
    }
}

/* -------------------------------------------------------------
   Inspector
------------------------------------------------------------- */

function renderHomeInspector() {
    inspector.innerHTML = `
        <div class="inspector-home">
            <div class="inspector-eyebrow">
                Repository snapshot
            </div>

            <div class="inspector-title">
                Local AI System Atlas
            </div>

            <div class="inspector-copy">
                Generated from actual repository structure,
                imports, Git working-tree state and test-to-module
                dependency evidence.
            </div>

            <div class="metric-grid">
                <div class="metric">
                    <strong>
                        ${DATA.stats.productionFiles}
                    </strong>
                    <span>
                        production
                    </span>
                </div>

                <div class="metric">
                    <strong>
                        ${DATA.stats.tests}
                    </strong>
                    <span>
                        test files
                    </span>
                </div>

                <div class="metric">
                    <strong>
                        ${DATA.stats.changed}
                    </strong>
                    <span>
                        changed
                    </span>
                </div>
            </div>

            <div class="badge-row">
                <span class="badge">
                    ${DATA.stats.relationships}
                    relationships
                </span>

                <span class="badge covered">
                    ${DATA.stats.coverageRatio}%
                    import-tested
                </span>
            </div>
        </div>

        <section class="section">
            <div class="section-title">
                Highest architectural risk
            </div>

            <div class="relationships">
                ${DATA.highestRisk
                    .slice(0,8)
                    .map(
                        node => `
                            <button
                                class="relationship-btn"
                                type="button"
                                data-node="${escapeHtml(node.id)}"
                            >
                                ${escapeHtml(node.label)}
                                <small>
                                    ${escapeHtml(node.domain)}
                                    · risk ${node.risk}
                                    · ${node.degree} relationships
                                </small>
                            </button>
                        `
                    )
                    .join("")}
            </div>
        </section>
    `;

    wireInspector();
}

function showNode(id) {
    const node =
        nodeById.get(id);

    if (!node) {
        return;
    }

    const out =
        outgoing.get(id) || [];

    const inc =
        incoming.get(id) || [];

    inspector.innerHTML = `
        <div class="inspector-header">
            <div class="inspector-eyebrow">
                ${escapeHtml(node.domain)}
            </div>

            <div class="inspector-title">
                ${escapeHtml(node.label)}
            </div>

            <div class="path-label">
                ${escapeHtml(node.path)}
            </div>

            <div class="badge-row">
                ${
                    node.changed
                        ? `
                            <span class="badge changed">
                                changed
                            </span>
                        `
                        : ""
                }

                ${
                    node.testRefs > 0
                        ? `
                            <span class="badge covered">
                                ${node.testRefs}
                                test imports
                            </span>
                        `
                        : `
                            <span class="badge">
                                no direct test import
                            </span>
                        `
                }

                <span class="badge">
                    ${escapeHtml(node.riskLevel)}
                    risk
                </span>
            </div>

            <div class="metric-grid">
                <div class="metric">
                    <strong>
                        ${node.inbound}
                    </strong>
                    <span>
                        incoming
                    </span>
                </div>

                <div class="metric">
                    <strong>
                        ${node.outbound}
                    </strong>
                    <span>
                        outgoing
                    </span>
                </div>

                <div class="metric">
                    <strong>
                        ${node.degree}
                    </strong>
                    <span>
                        total links
                    </span>
                </div>
            </div>

            <div class="risk-meter">
                <div class="risk-track">
                    <div
                        class="risk-fill"
                        style="width:${node.risk}%"
                    ></div>
                </div>

                <div class="risk-caption">
                    <span>
                        change risk
                    </span>

                    <span>
                        ${node.risk}/100
                    </span>
                </div>
            </div>
        </div>

        ${relationshipSection(
            "Depends on",
            out
        )}

        ${relationshipSection(
            "Used by",
            inc
        )}
    `;

    wireInspector();
}

function relationshipSection(
    title,
    ids
) {
    if (!ids.length) {
        return "";
    }

    return `
        <section class="section">
            <div class="section-title">
                ${escapeHtml(title)}
            </div>

            <div class="relationships">
                ${ids
                    .slice(0,25)
                    .map(id => {
                        const node =
                            nodeById.get(id);

                        if (!node) {
                            return "";
                        }

                        return `
                            <button
                                type="button"
                                class="relationship-btn"
                                data-node="${escapeHtml(id)}"
                            >
                                ${escapeHtml(node.label)}
                                <small>
                                    ${escapeHtml(node.domain)}
                                    · risk ${node.risk}
                                </small>
                            </button>
                        `;
                    })
                    .join("")}
            </div>
        </section>
    `;
}

function showDomain(domainId) {
    const domain =
        DATA.domains.find(
            item =>
                item.id ===
                domainId
        );

    if (!domain) {
        return;
    }

    const nodes =
        DATA.nodes
            .filter(
                node =>
                    node.domain ===
                    domainId
            )
            .sort(
                (a,b) =>
                    b.degree - a.degree
            );

    inspector.innerHTML = `
        <div class="inspector-header">
            <div class="inspector-eyebrow">
                Architecture domain
            </div>

            <div class="inspector-title">
                ${escapeHtml(domain.id)}
            </div>

            <div class="inspector-copy">
                ${escapeHtml(domain.description)}
            </div>

            <div class="metric-grid">
                <div class="metric">
                    <strong>
                        ${domain.count}
                    </strong>
                    <span>
                        modules
                    </span>
                </div>

                <div class="metric">
                    <strong>
                        ${domain.changed}
                    </strong>
                    <span>
                        changed
                    </span>
                </div>

                <div class="metric">
                    <strong>
                        ${domain.averageRisk}
                    </strong>
                    <span>
                        avg risk
                    </span>
                </div>
            </div>
        </div>

        <section class="section">
            <div class="section-title">
                Architecture leaders
            </div>

            <div class="relationships">
                ${nodes
                    .slice(0,10)
                    .map(
                        node => `
                            <button
                                type="button"
                                class="relationship-btn"
                                data-node="${escapeHtml(node.id)}"
                            >
                                ${escapeHtml(node.label)}
                                <small>
                                    ${node.degree}
                                    relationships
                                    · risk
                                    ${node.risk}
                                </small>
                            </button>
                        `
                    )
                    .join("")}
            </div>
        </section>
    `;

    wireInspector();
}

function showStory(story) {
    inspector.innerHTML = `
        <div class="inspector-header">
            <div class="inspector-eyebrow">
                Guided architecture flow
            </div>

            <div class="inspector-title">
                ${escapeHtml(story.label)}
            </div>

            <div class="inspector-copy">
                ${escapeHtml(story.subtitle)}
            </div>
        </div>

        <section class="section">
            <div class="section-title">
                Flow
            </div>

            <div class="story-steps">
                ${story.nodes
                    .map(
                        (id,index) => {
                            const node =
                                nodeById.get(id);

                            return `
                                <div class="story-step">
                                    <div class="story-index">
                                        ${index + 1}
                                    </div>

                                    <div>
                                        <strong>
                                            ${escapeHtml(node?.label || id)}
                                        </strong>

                                        <span>
                                            ${escapeHtml(node?.domain || "")}
                                        </span>
                                    </div>
                                </div>
                            `;
                        }
                    )
                    .join("")}
            </div>
        </section>
    `;
}

function showPath(
    path,
    mode
) {
    inspector.innerHTML = `
        <div class="inspector-header">
            <div class="inspector-eyebrow">
                Dependency trace
            </div>

            <div class="inspector-title">
                ${mode === "directed"
                    ? "Directed path"
                    : "Connected path"}
            </div>

            <div class="inspector-copy">
                ${path.length - 1}
                dependency hops across
                ${path.length}
                modules.
            </div>
        </div>

        <section class="section">
            <div class="story-steps">
                ${path
                    .map(
                        (id,index) => {
                            const node =
                                nodeById.get(id);

                            return `
                                <button
                                    type="button"
                                    class="relationship-btn"
                                    data-node="${escapeHtml(id)}"
                                >
                                    ${index + 1}.
                                    ${escapeHtml(node?.label || id)}

                                    <small>
                                        ${escapeHtml(node?.domain || "")}
                                    </small>
                                </button>
                            `;
                        }
                    )
                    .join("")}
            </div>
        </section>
    `;

    wireInspector();
}

function wireInspector() {
    for (
        const button
        of inspector.querySelectorAll(
            "[data-node]"
        )
    ) {
        button.addEventListener(
            "click",
            () => {
                state.view =
                    "code";

                state.selected =
                    button.dataset.node;

                state.selectedStory =
                    null;

                renderViews();
                renderStories();
                showNode(
                    state.selected
                );
                renderCode();

                requestAnimationFrame(
                    fitGraph
                );
            }
        );
    }
}

function renderEmpty() {
    const text =
        svgElement(
            "text",
            {
                x: 100,
                y: 100,
                fill: "#7c8799",
                "font-size": 15,
            }
        );

    text.textContent =
        "No modules match this lens.";

    viewport.appendChild(text);
}

/* -------------------------------------------------------------
   Sidebar
------------------------------------------------------------- */

function renderViews() {
    const root =
        document.getElementById(
            "views"
        );

    root.replaceChildren();

    for (
        const view
        of VIEW_DEFINITIONS
    ) {
        const button =
            document.createElement(
                "button"
            );

        button.type =
            "button";

        button.className =
            "view-btn"
            + (
                state.view ===
                view.id
                    ? " active"
                    : ""
            );

        button.innerHTML = `
            <span>
                ${view.label}
            </span>

            <span class="view-meta">
                ${view.meta}
            </span>
        `;

        button.addEventListener(
            "click",
            () => {
                state.view =
                    view.id;

                state.selected =
                    null;

                state.selectedStory =
                    null;

                state.selectedPath =
                    [];

                renderAll();
            }
        );

        root.appendChild(
            button
        );
    }
}

function renderDomains() {
    const root =
        document.getElementById(
            "domains"
        );

    root.replaceChildren();

    for (
        const domain
        of DATA.domains
    ) {
        const hidden =
            state.hiddenDomains.has(
                domain.id
            );

        const button =
            document.createElement(
                "button"
            );

        button.type =
            "button";

        button.className =
            "domain-btn"
            + (
                hidden
                    ? " off"
                    : ""
            );

        button.innerHTML = `
            <span
                class="domain-dot"
                style="background:${colorFor(domain.id)}"
            ></span>

            <span>
                ${escapeHtml(domain.id)}
            </span>

            <span class="domain-number">
                ${domain.count}
            </span>
        `;

        button.addEventListener(
            "click",
            () => {
                if (hidden) {
                    state.hiddenDomains.delete(
                        domain.id
                    );
                } else {
                    state.hiddenDomains.add(
                        domain.id
                    );
                }

                renderAll();
            }
        );

        root.appendChild(
            button
        );
    }
}

function renderStories() {
    const root =
        document.getElementById(
            "stories"
        );

    root.replaceChildren();

    for (
        const story
        of DATA.stories
    ) {
        const button =
            document.createElement(
                "button"
            );

        button.type =
            "button";

        button.className =
            "story-btn"
            + (
                state.selectedStory
                === story.id
                    ? " active"
                    : ""
            );

        button.innerHTML = `
            <strong>
                ${escapeHtml(story.label)}
            </strong>

            <span>
                ${escapeHtml(story.subtitle)}
            </span>
        `;

        button.addEventListener(
            "click",
            () => {
                state.view =
                    "code";

                state.selected =
                    null;

                state.selectedPath =
                    [];

                state.selectedStory =
                    story.id;

                renderViews();
                renderStories();
                renderCode();
                showStory(story);

                requestAnimationFrame(
                    fitGraph
                );
            }
        );

        root.appendChild(
            button
        );
    }
}

function renderHotspots() {
    const root =
        document.getElementById(
            "hotspots"
        );

    root.replaceChildren();

    for (
        const node
        of DATA.hotspots.slice(0,10)
    ) {
        const button =
            document.createElement(
                "button"
            );

        button.type =
            "button";

        button.className =
            "hotspot-btn";

        button.innerHTML = `
            <div class="hotspot-name">
                ${escapeHtml(node.label)}
            </div>

            <div class="hotspot-meta">
                ${escapeHtml(node.domain)}
                ·
                ${node.degree} links
                ·
                risk ${node.risk}
            </div>
        `;

        button.addEventListener(
            "click",
            () => {
                state.view =
                    "code";

                state.selected =
                    node.id;

                state.selectedStory =
                    null;

                state.selectedPath =
                    [];

                renderViews();
                renderStories();
                renderCode();
                showNode(
                    node.id
                );

                requestAnimationFrame(
                    fitGraph
                );
            }
        );

        root.appendChild(
            button
        );
    }
}

/* -------------------------------------------------------------
   Dependency path finder
------------------------------------------------------------- */

function exactOrFuzzyNode(value) {
    const text =
        value
            .trim()
            .toLowerCase();

    if (!text) {
        return null;
    }

    const exact =
        DATA.nodes.find(
            node =>
                node.id.toLowerCase()
                === text
        );

    if (exact) {
        return exact;
    }

    return DATA.nodes.find(
        node =>
            node.id
                .toLowerCase()
                .includes(text)
            ||
            node.label
                .toLowerCase()
                .includes(text)
    ) || null;
}

function bfs(
    start,
    end,
    undirected = false
) {
    const queue =
        new dequeShim();

    queue.push(start);

    const previous =
        new Map();

    previous.set(
        start,
        null
    );

    while (queue.length) {
        const current =
            queue.shift();

        if (current === end) {
            break;
        }

        const neighbors =
            [
                ...(outgoing.get(
                    current
                ) || []),
            ];

        if (undirected) {
            neighbors.push(
                ...(incoming.get(
                    current
                ) || [])
            );
        }

        for (
            const next
            of neighbors
        ) {
            if (
                previous.has(next)
            ) {
                continue;
            }

            previous.set(
                next,
                current
            );

            queue.push(next);
        }
    }

    if (
        !previous.has(end)
    ) {
        return [];
    }

    const path = [];

    let current = end;

    while (current !== null) {
        path.push(current);

        current =
            previous.get(
                current
            );
    }

    return path.reverse();
}

function dequeShim() {
    const values = [];

    return {
        push(value) {
            values.push(value);
        },

        shift() {
            return values.shift();
        },

        get length() {
            return values.length;
        },
    };
}

function tracePath() {
    const from =
        exactOrFuzzyNode(
            document
                .getElementById(
                    "pathFrom"
                )
                .value
        );

    const to =
        exactOrFuzzyNode(
            document
                .getElementById(
                    "pathTo"
                )
                .value
        );

    if (!from || !to) {
        inspector.innerHTML = `
            <div class="inspector-home">
                <div class="inspector-eyebrow">
                    Path finder
                </div>

                <div class="inspector-title">
                    Select two valid modules
                </div>

                <div class="inspector-copy">
                    Type part of a filename or repository path.
                </div>
            </div>
        `;

        return;
    }

    let path =
        bfs(
            from.id,
            to.id,
            false
        );

    let mode =
        "directed";

    if (!path.length) {
        path =
            bfs(
                from.id,
                to.id,
                true
            );

        mode =
            "connected";
    }

    if (!path.length) {
        inspector.innerHTML = `
            <div class="inspector-home">
                <div class="inspector-eyebrow">
                    Path finder
                </div>

                <div class="inspector-title">
                    No dependency path found
                </div>

                <div class="inspector-copy">
                    These modules are not connected by the currently
                    detected import graph.
                </div>
            </div>
        `;

        return;
    }

    state.view =
        "code";

    state.selected =
        null;

    state.selectedStory =
        null;

    state.selectedPath =
        path;

    state.pathMode =
        mode;

    renderViews();
    renderStories();
    renderCode();
    showPath(
        path,
        mode
    );

    requestAnimationFrame(
        fitGraph
    );
}

function clearPath() {
    state.selectedPath = [];
    state.pathMode = null;

    document
        .getElementById(
            "pathFrom"
        )
        .value = "";

    document
        .getElementById(
            "pathTo"
        )
        .value = "";

    renderAll();
}

/* -------------------------------------------------------------
   Main render
------------------------------------------------------------- */

function renderAll() {
    renderViews();
    renderDomains();
    renderStories();

    if (
        state.view ===
        "system"
    ) {
        state.selected =
            null;

        renderSystem();
    } else {
        renderCode();
    }

    if (
        !state.selected
        && !state.selectedStory
        && !state.selectedPath.length
    ) {
        renderHomeInspector();
    }

    requestAnimationFrame(
        () =>
            requestAnimationFrame(
                fitGraph
            )
    );
}

/* -------------------------------------------------------------
   Search
------------------------------------------------------------- */

search.addEventListener(
    "input",
    () => {
        state.search =
            search.value
                .trim()
                .toLowerCase();

        if (
            state.search
            && state.view ===
            "system"
        ) {
            state.view =
                "code";
        }

        state.selected =
            null;

        state.selectedStory =
            null;

        state.selectedPath =
            [];

        renderAll();
    }
);

/* -------------------------------------------------------------
   Pan + zoom
------------------------------------------------------------- */

graph.addEventListener(
    "wheel",
    event => {
        event.preventDefault();

        const rect =
            graph.getBoundingClientRect();

        const mx =
            event.clientX
            - rect.left;

        const my =
            event.clientY
            - rect.top;

        const old =
            state.scale;

        const next =
            Math.max(
                .08,
                Math.min(
                    4,
                    old
                    * (
                        event.deltaY < 0
                            ? 1.12
                            : .89
                    )
                )
            );

        const worldX =
            (
                mx
                - state.x
            ) / old;

        const worldY =
            (
                my
                - state.y
            ) / old;

        state.scale =
            next;

        state.x =
            mx
            - worldX
            * next;

        state.y =
            my
            - worldY
            * next;

        updateTransform();
    },
    {
        passive: false,
    }
);

graph.addEventListener(
    "pointerdown",
    event => {
        if (
            event.target.closest(
                ".node,.domain-node"
            )
        ) {
            return;
        }

        state.dragging = true;

        state.pointerX =
            event.clientX;

        state.pointerY =
            event.clientY;

        graph.classList.add(
            "dragging"
        );

        graph.setPointerCapture(
            event.pointerId
        );
    }
);

graph.addEventListener(
    "pointermove",
    event => {
        if (!state.dragging) {
            return;
        }

        state.x +=
            event.clientX
            - state.pointerX;

        state.y +=
            event.clientY
            - state.pointerY;

        state.pointerX =
            event.clientX;

        state.pointerY =
            event.clientY;

        updateTransform();
    }
);

graph.addEventListener(
    "pointerup",
    event => {
        state.dragging = false;

        graph.classList.remove(
            "dragging"
        );

        try {
            graph.releasePointerCapture(
                event.pointerId
            );
        } catch {
            // no-op
        }
    }
);

/* -------------------------------------------------------------
   Toolbar
------------------------------------------------------------- */

document
    .getElementById(
        "zoomIn"
    )
    .addEventListener(
        "click",
        () =>
            zoomBy(1.2)
    );

document
    .getElementById(
        "zoomOut"
    )
    .addEventListener(
        "click",
        () =>
            zoomBy(.82)
    );

document
    .getElementById(
        "fit"
    )
    .addEventListener(
        "click",
        fitGraph
    );

document
    .getElementById(
        "findPath"
    )
    .addEventListener(
        "click",
        tracePath
    );

document
    .getElementById(
        "clearPath"
    )
    .addEventListener(
        "click",
        clearPath
    );

/* -------------------------------------------------------------
   Keyboard
------------------------------------------------------------- */

document.addEventListener(
    "keydown",
    event => {
        if (
            event.key === "/"
            &&
            document.activeElement
            !== search
        ) {
            event.preventDefault();
            search.focus();
        }

        if (
            event.key ===
            "Escape"
        ) {
            search.value = "";

            state.search = "";
            state.selected = null;
            state.selectedStory = null;
            state.selectedPath = [];

            renderAll();
        }
    }
);

/* -------------------------------------------------------------
   Initial data
------------------------------------------------------------- */

document
    .getElementById(
        "metricFiles"
    )
    .textContent =
        DATA.stats.files
            .toLocaleString();

document
    .getElementById(
        "metricEdges"
    )
    .textContent =
        DATA.stats.relationships
            .toLocaleString();

document
    .getElementById(
        "metricChanges"
    )
    .textContent =
        DATA.stats.changed
            .toLocaleString();

document
    .getElementById(
        "snapshotProd"
    )
    .textContent =
        DATA.stats.productionFiles
            .toLocaleString();

document
    .getElementById(
        "snapshotCoverage"
    )
    .textContent =
        `${DATA.stats.coverageRatio}%`;

const datalist =
    document.getElementById(
        "nodePaths"
    );

for (
    const node
    of DATA.nodes
) {
    if (
        node.domain ===
        "Tests"
    ) {
        continue;
    }

    const option =
        document.createElement(
            "option"
        );

    option.value =
        node.id;

    datalist.appendChild(
        option
    );
}

renderHotspots();
renderAll();

window.addEventListener(
    "resize",
    () => {
        clearTimeout(
            window.__atlasResize
        );

        window.__atlasResize =
            setTimeout(
                fitGraph,
                120
            );
    }
);
</script>

</body>
</html>
"""


def build_html(graph: dict) -> str:
    payload = json.dumps(
        graph,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    # Safe inside <script>: no path can close the tag, open a comment or end a JS line early.
    for char, escaped in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"),
                          ("\u2028", "\\u2028"), ("\u2029", "\\u2029")):
        payload = payload.replace(char, escaped)

    return HTML.replace(
        "__GRAPH_JSON__",
        payload,
    )


def write_output(target: Path, html: str) -> None:
    """Write beside the target, then rename over it: a reader never sees half a graph."""
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(html, encoding="utf-8")
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            tmp.unlink()



def snapshot_main(repo: str, git_dir: str, ref: str) -> None:
    """One repository at one commit, from a clean copy; the deploy checkout and the single graph are never touched."""
    global ROOT
    repo = repo.strip().lower()
    if not REPO_NAME.match(repo):
        raise SystemExit(f"Not a repository name: {repo!r}")
    commit = git(git_dir, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()
    work = Path(tempfile.mkdtemp(prefix=f"atlas-{repo}-")).resolve()
    try:
        export_commit(git_dir, commit, work)
        SNAPSHOT.clear()
        SNAPSHOT.update(repo=repo, gitDir=git_dir, commit=commit,
                        committedAt=git(git_dir, "log", "-1", "--format=%cI", commit).strip(),
                        changedSince=previous_snapshot(repo, commit))
        ROOT = work
        files = collect_files()
        if not files:
            raise SystemExit(f"No supported source files in {repo} at {commit[:10]}.")
        graph = build_graph(files)
        graph["snapshot"] = {k: SNAPSHOT[k] for k in ("repo", "commit", "committedAt", "changedSince")}
        target = record_snapshot(graph)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print(f"Snapshot   : {repo} @ {commit[:10]} ({graph['stats']['files']} files)")
    print(f"Created    : {target}")


def main() -> None:
    parser = argparse.ArgumentParser(description="System Atlas: the module graph of a repository.")
    parser.add_argument("--repo", help="snapshot mode: the repository's name, e.g. pi-hub")
    parser.add_argument("--git-dir", help="snapshot mode: its git folder (a bare mirror or a .git)")
    parser.add_argument("--commit", help="snapshot mode: the commit, branch or tag to map")
    args = parser.parse_args()
    given = [a is not None for a in (args.repo, args.git_dir, args.commit)]
    if any(given):
        if not all(given):
            parser.error("--repo, --git-dir and --commit go together")
        snapshot_main(args.repo, args.git_dir, args.commit)
        return

    print()
    print(
        "LOCAL AI · SYSTEM ATLAS"
    )
    print(
        "=" * 30
    )
    print(
        f"Repository : {ROOT}"
    )
    print()

    files = collect_files()

    if not files:
        raise SystemExit(
            "No supported source files found."
        )

    graph = build_graph(files)

    write_output(OUTPUT, build_html(graph))

    stats = graph["stats"]

    print(
        f"Files      : "
        f"{stats['files']}"
    )

    print(
        f"Production : "
        f"{stats['productionFiles']}"
    )

    print(
        f"Tests      : "
        f"{stats['tests']}"
    )

    print(
        f"Relations  : "
        f"{stats['relationships']}"
    )

    print(
        f"Changed    : "
        f"{stats['changed']}"
    )

    print(
        f"Test signal: "
        f"{stats['coverageRatio']}%"
    )

    print()
    print(
        f"Created    : {OUTPUT}"
    )

    try:
        webbrowser.open(
            OUTPUT.as_uri()
        )
    except Exception as error:
        print(
            "Browser launch skipped: "
            f"{error}"
        )


if __name__ == "__main__":
    main()