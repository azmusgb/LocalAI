from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

MARKER = "atlas-investigations-v1"

ATLAS_BLOCK = r'''# atlas-investigations-v1
_INVESTIGATION_META_PREFIX = "<!-- atlas-investigation-meta "
_INVESTIGATION_ID_RE = re.compile(
    r"^atlas-investigation-\d{8}T\d{6}(?:\d{6})?Z$"
)
_ANSI_RE = re.compile(
    r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])"
)


def _goose_timeout_seconds() -> int:
    raw = os.environ.get(
        "ATLAS_GOOSE_TIMEOUT_SECONDS",
        "420",
    ).strip()
    try:
        value = int(raw)
    except ValueError:
        value = 420
    return max(30, min(value, 900))


def _goose_client_env() -> dict[str, str]:
    env = os.environ.copy()
    host = os.environ.get(
        "ATLAS_GOOSE_OLLAMA_HOST",
        "http://127.0.0.1:11434",
    ).strip()
    env["OLLAMA_HOST"] = (
        host
        or "http://127.0.0.1:11434"
    )
    env["NO_COLOR"] = "1"
    return env


def _clean_process_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode(
            "utf-8",
            errors="replace",
        )
    return _ANSI_RE.sub(
        "",
        str(value),
    ).strip()


def _investigation_path(
    investigation_id: str,
) -> Path:
    value = str(
        investigation_id or ""
    ).strip()
    if value.endswith(".md"):
        value = value[:-3]
    if not _INVESTIGATION_ID_RE.fullmatch(
        value
    ):
        raise AtlasError(
            "Invalid Atlas investigation id.",
            status=HTTPStatus.BAD_REQUEST,
            code="investigation_id_invalid",
        )
    path = (
        INVESTIGATION_DIR
        / f"{value}.md"
    ).resolve()
    root = INVESTIGATION_DIR.resolve()
    if path.parent != root:
        raise AtlasError(
            "Investigation path escaped its store.",
            status=HTTPStatus.BAD_REQUEST,
            code="investigation_path_invalid",
        )
    return path


def _parse_investigation_meta(
    path: Path,
    content: str | None = None,
) -> dict[str, Any]:
    if content is None:
        try:
            with path.open(
                "r",
                encoding="utf-8",
                errors="replace",
            ) as handle:
                first = handle.readline().strip()
        except OSError:
            first = ""
    else:
        first = content.splitlines()[0].strip() if content else ""

    metadata: dict[str, Any] = {}
    suffix = " -->"
    if (
        first.startswith(
            _INVESTIGATION_META_PREFIX
        )
        and first.endswith(suffix)
    ):
        raw = first[
            len(_INVESTIGATION_META_PREFIX):
            -len(suffix)
        ]
        try:
            decoded = json.loads(raw)
            if isinstance(decoded, dict):
                metadata = decoded
        except json.JSONDecodeError:
            metadata = {}

    stat = path.stat()
    metadata.setdefault("id", path.stem)
    metadata.setdefault("status", "legacy")
    metadata.setdefault("objective", "Legacy Atlas investigation prompt")
    metadata.setdefault("node", None)
    metadata.setdefault(
        "createdAt",
        datetime.fromtimestamp(
            stat.st_mtime,
            timezone.utc,
        ).isoformat(),
    )
    metadata["size"] = stat.st_size
    metadata["briefPath"] = path.relative_to(ROOT).as_posix()
    return metadata


def list_investigations(
    limit: int = 50,
) -> list[dict[str, Any]]:
    if not INVESTIGATION_DIR.is_dir():
        return []
    safe_limit = max(1, min(int(limit), 100))
    items: list[dict[str, Any]] = []
    for path in sorted(
        INVESTIGATION_DIR.glob("atlas-investigation-*.md"),
        reverse=True,
    ):
        try:
            if path.is_file():
                items.append(_parse_investigation_meta(path))
        except OSError:
            continue
        if len(items) >= safe_limit:
            break
    return items


def read_investigation(
    investigation_id: str,
) -> dict[str, Any]:
    path = _investigation_path(investigation_id)
    if not path.is_file():
        raise AtlasError(
            "Atlas investigation was not found.",
            status=HTTPStatus.NOT_FOUND,
            code="investigation_not_found",
        )
    stat = path.stat()
    if stat.st_size > 2 * 1024 * 1024:
        raise AtlasError(
            "Atlas investigation is too large to display.",
            status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            code="investigation_too_large",
        )
    content = path.read_text(
        encoding="utf-8",
        errors="replace",
    )
    return {
        "investigation": _parse_investigation_meta(path, content),
        "content": content,
    }


def _write_investigation_report(
    *,
    path: Path,
    metadata: dict[str, Any],
    evidence: dict[str, Any],
    prompt: str,
    result: str = "",
    error: str = "",
    diagnostics: str = "",
) -> None:
    compact_meta = json.dumps(
        metadata,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    status = str(metadata.get("status", "unknown")).capitalize()
    objective = str(metadata.get("objective", ""))
    node = metadata.get("node")
    goose_version = metadata.get("gooseVersion") or "unavailable"

    parts = [
        f"{_INVESTIGATION_META_PREFIX}{compact_meta} -->",
        "# Atlas Investigation",
        "",
        f"**Status:** {status}",
        f"**Created:** {metadata.get('createdAt', '')}",
    ]
    if metadata.get("finishedAt"):
        parts.append(f"**Completed:** {metadata.get('finishedAt')}")
    if metadata.get("durationMs") is not None:
        parts.append(f"**Duration:** {metadata.get('durationMs')} ms")
    parts.append(f"**Goose:** {goose_version}")
    if node:
        parts.append(f"**Node:** `{node}`")
    parts.extend(["", "## Objective", "", objective, ""])

    if result:
        parts.extend(["## Executive result", "", result, ""])
    if error:
        parts.extend(["## Error", "", error, ""])
    if diagnostics:
        parts.extend([
            "## Execution diagnostics", "", "```text",
            diagnostics[:12000], "```", "",
        ])

    parts.extend([
        "## Evidence snapshot", "", "```json",
        json.dumps(evidence, ensure_ascii=False, indent=2),
        "```", "", "## Prompt sent to Goose", "", prompt, "",
    ])
    path.write_text(
        "\n".join(parts).rstrip() + "\n",
        encoding="utf-8",
        newline="\n",
    )


def build_goose_brief(
    *,
    graph: dict[str, Any],
    findings: list[dict[str, Any]],
    question: str,
    selected_node: str | None = None,
) -> dict[str, Any]:
    evidence = build_evidence_context(
        graph,
        findings,
        question,
        selected_node=selected_node,
    )

    prompt = f"""# Atlas Investigation

You are investigating the Local AI repository.

## Operating mode

READ-ONLY INVESTIGATION.

Do not modify files, create commits, change configuration, install packages,
or execute destructive commands.

## Objective

{question}

## Requirements

1. Validate or challenge the deterministic Atlas finding using source evidence.
2. Inspect the smallest relevant set of files.
3. Distinguish confirmed facts from inference.
4. Identify hidden coupling, missing verification, boundary bypasses, error-path
   gaps, portability risks, or architectural debt when supported by evidence.
5. Cite exact repository paths and line numbers where practical.
6. If Atlas is wrong or incomplete, explain precisely why.
7. Return:
   - Executive finding
   - Evidence
   - Risk
   - Recommended next action
   - Tests/verification that should exist
8. Do not make changes.

## Deterministic Atlas evidence

```json
{json.dumps(evidence, ensure_ascii=False, indent=2)}
```
"""

    INVESTIGATION_DIR.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc)
    timestamp = started.strftime("%Y%m%dT%H%M%S%fZ")
    investigation_id = f"atlas-investigation-{timestamp}"
    path = INVESTIGATION_DIR / f"{investigation_id}.md"

    goose = goose_status()
    metadata: dict[str, Any] = {
        "schemaVersion": 1,
        "id": investigation_id,
        "status": "running" if goose.get("available") else "prepared",
        "objective": question,
        "node": selected_node,
        "createdAt": started.isoformat(),
        "finishedAt": None,
        "durationMs": None,
        "gooseVersion": goose.get("version") or ("detected" if goose.get("available") else None),
    }
    _write_investigation_report(path=path,metadata=metadata,evidence=evidence,prompt=prompt)

    if not goose.get("available"):
        metadata["finishedAt"] = datetime.now(timezone.utc).isoformat()
        error = "Goose CLI is not available. The investigation prompt was prepared but not executed."
        _write_investigation_report(path=path,metadata=metadata,evidence=evidence,prompt=prompt,error=error)
        return {"status":"prepared","investigationId":investigation_id,"briefPath":path.relative_to(ROOT).as_posix(),"result":"","error":"Goose CLI is not available.","goose":goose,"durationMs":None}

    executable = str(goose.get("executable") or "goose")
    timeout_seconds = _goose_timeout_seconds()

    try:
        completed = subprocess.run(
            [executable, "run", "--text", prompt],
            cwd=ROOT,
            env=_goose_client_env(),
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
        stdout = _clean_process_text(completed.stdout)
        stderr = _clean_process_text(completed.stderr)
        finished = datetime.now(timezone.utc)
        duration_ms = int((finished - started).total_seconds() * 1000)

        if completed.returncode == 0:
            status = "completed"
            error = ""
            result = stdout or "Goose completed without returning text."
        else:
            status = "failed"
            result = stdout
            error = stderr or f"Goose exited with code {completed.returncode}."

        metadata.update({"status":status,"finishedAt":finished.isoformat(),"durationMs":duration_ms})
        _write_investigation_report(path=path,metadata=metadata,evidence=evidence,prompt=prompt,result=result,error=error,diagnostics=stderr if status=="failed" else "")
        return {"status":status,"investigationId":investigation_id,"briefPath":path.relative_to(ROOT).as_posix(),"result":result,"error":error,"goose":goose,"durationMs":duration_ms}

    except subprocess.TimeoutExpired as timeout_error:
        finished = datetime.now(timezone.utc)
        duration_ms = int((finished - started).total_seconds() * 1000)
        stdout = _clean_process_text(timeout_error.stdout)
        stderr = _clean_process_text(timeout_error.stderr)
        error = f"Goose investigation timed out after {timeout_seconds} seconds."
        metadata.update({"status":"failed","finishedAt":finished.isoformat(),"durationMs":duration_ms})
        diagnostics = "\n".join(value for value in [stdout,stderr] if value)
        _write_investigation_report(path=path,metadata=metadata,evidence=evidence,prompt=prompt,result=stdout,error=error,diagnostics=diagnostics)
        return {"status":"failed","investigationId":investigation_id,"briefPath":path.relative_to(ROOT).as_posix(),"result":stdout,"error":error,"goose":goose,"durationMs":duration_ms}
'''

GET_ROUTES = r'''        # atlas-investigation-read-api-v1
        if path == "/api/atlas/investigations":
            query = parse_qs(parsed.query)
            raw_limit = query.get("limit", ["50"])[0]
            try:
                limit = int(raw_limit)
            except ValueError:
                limit = 50
            self.send_json({"items": list_investigations(limit)})
            return

        if path == "/api/atlas/investigation":
            query = parse_qs(parsed.query)
            investigation_id = query.get("id", [""])[0].strip()
            if not investigation_id:
                raise AtlasError("Missing Atlas investigation id.",code="investigation_id_required")
            self.send_json(read_investigation(investigation_id))
            return

'''


def read_text(path: Path):
    raw = path.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    if bom: raw = raw[3:]
    text = raw.decode("utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"
    return text,newline,bom


def write_text(path: Path,text: str,newline: str,bom: bool):
    normalized = text.replace("\r\n","\n").replace("\r","\n")
    if newline == "\r\n": normalized = normalized.replace("\n","\r\n")
    raw = normalized.encode("utf-8")
    if bom: raw = b"\xef\xbb\xbf" + raw
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(raw)


def patch_atlas(path: Path):
    text,nl,bom = read_text(path)
    if MARKER not in text:
        start=text.find("def build_goose_brief("); end=text.find("\ndef ollama_status",start)
        if start<0 or end<0: raise RuntimeError("Could not locate build_goose_brief/ollama_status boundary.")
        text=text[:start]+ATLAS_BLOCK.rstrip()+"\n\n"+text[end+1:]
        print("PASS: Atlas now executes Goose and persists actual result reports")
    else: print("INFO: Atlas Goose execution layer already present")
    if "# atlas-investigation-read-api-v1" not in text:
        marker="        html, graph, findings = (\n            self.atlas_state.snapshot()\n        )"
        if text.count(marker)!=1: raise RuntimeError(f"Expected exactly one Atlas GET snapshot marker, found {text.count(marker)}.")
        text=text.replace(marker,GET_ROUTES.rstrip()+"\n\n"+marker,1)
        print("PASS: Atlas investigation list/read APIs added")
    else: print("INFO: Atlas investigation read APIs already present")
    if 'ATLAS_INTELLIGENCE_VERSION = "1.1"' in text: text=text.replace('ATLAS_INTELLIGENCE_VERSION = "1.1"','ATLAS_INTELLIGENCE_VERSION = "1.2"',1)
    write_text(path,text,nl,bom)


def patch_server(path: Path):
    text,nl,bom=read_text(path)
    if "'/api/atlas/investigations'" not in text:
        needle="    ['/api/atlas/goose', '/api/atlas/goose']"
        if needle not in text: raise RuntimeError("Could not locate Atlas upstream goose route.")
        replacement="    ['/api/atlas/goose', '/api/atlas/goose'],\n    ['/api/atlas/investigations', '/api/atlas/investigations'],\n    ['/api/atlas/investigation', '/api/atlas/investigation']"
        text=text.replace(needle,replacement,1); print("PASS: Local AI proxies Atlas investigation history")
    else: print("INFO: Atlas investigation proxy routes already present")
    if "const isGoose =" not in text:
        old="    const isAsk = localPath === '/api/atlas/ask';\n    const timeoutMs = isAsk ? 315000 : 10000;"
        new="    const isAsk = localPath === '/api/atlas/ask';\n    const isGoose = localPath === '/api/atlas/goose';\n    const timeoutMs = isGoose ? 450000 : isAsk ? 315000 : 10000;"
        if old not in text: raise RuntimeError("Could not locate Atlas proxy timeout block.")
        text=text.replace(old,new,1); print("PASS: Goose proxy timeout raised to 450 seconds")
    else: print("INFO: Goose proxy timeout already extended")
    write_text(path,text,nl,bom)


def patch_index(path: Path):
    text,nl,bom=read_text(path)
    if "/atlas-investigations.css" not in text:
        architecture_css='<link rel="stylesheet" href="/architecture.css">'
        if architecture_css in text: text=text.replace(architecture_css,architecture_css+'<link rel="stylesheet" href="/atlas-investigations.css">',1)
        elif "</head>" in text: text=text.replace("</head>",'<link rel="stylesheet" href="/atlas-investigations.css">\n</head>',1)
        else: raise RuntimeError("Could not locate index stylesheet insertion point.")
        print("PASS: investigation viewer stylesheet wired")
    if "/atlas-investigations.js" not in text:
        architecture_js='<script src="/architecture.js"></script>'
        if architecture_js not in text: raise RuntimeError("Could not locate architecture.js in index.")
        text=text.replace(architecture_js,architecture_js+'<script src="/atlas-investigations.js"></script>',1); print("PASS: investigation viewer script wired")
    write_text(path,text,nl,bom)


def patch_sw(path: Path):
    text,nl,bom=read_text(path)
    shell=re.search(r"(const\s+SHELL\s*=\s*\[)(.*?)(\];)",text,re.S)
    if not shell: raise RuntimeError("Could not locate service-worker SHELL array.")
    body=shell.group(2); assets=[a for a in ("/atlas-investigations.js","/atlas-investigations.css") if a not in body]
    if assets:
        body=body.rstrip()+"".join(f",'{a}'" for a in assets); text=text[:shell.start(2)]+body+text[shell.end(2):]; print("PASS: investigation viewer assets added to offline shell")
    cache=re.search(r"(const\s+CACHE\s*=\s*['\"])([^'\"]+)(['\"])",text)
    if not cache: raise RuntimeError("Could not locate service-worker CACHE declaration.")
    current=cache.group(2)
    if "investigations1-atlas1" not in current:
        base=re.sub(r"-atlas1$","",current); base=re.sub(r"-investigations\d+$","",base); updated=base+"-investigations1-atlas1"
        text=text[:cache.start(2)]+updated+text[cache.end(2):]; print(f"PASS: service-worker cache bumped: {current} -> {updated}")
    write_text(path,text,nl,bom)


def copy_managed(source: Path,dest: Path):
    if dest.exists():
        existing,_,_=read_text(dest)
        if MARKER not in existing: raise RuntimeError(f"Refusing to overwrite unrelated existing file: {dest}")
    dest.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(source,dest)


def main() -> int:
    if len(sys.argv)!=3: raise SystemExit("usage: patch.py REPO_ROOT PAYLOAD_ROOT")
    root=Path(sys.argv[1]).resolve(); payload=Path(sys.argv[2]).resolve()
    patch_atlas(root/"atlas_intelligence.py")
    patch_server(root/"app"/"server"/"atlas.js")
    patch_index(root/"app"/"public"/"index.html")
    patch_sw(root/"app"/"public"/"sw.js")
    copy_managed(payload/"atlas-investigations.js",root/"app"/"public"/"atlas-investigations.js")
    copy_managed(payload/"atlas-investigations.css",root/"app"/"public"/"atlas-investigations.css")
    copy_managed(payload/"atlas-investigations.test.cjs",root/"tests"/"atlas-investigations.test.cjs")
    print("PATCH COMPLETE")
    return 0

if __name__=="__main__": raise SystemExit(main())
