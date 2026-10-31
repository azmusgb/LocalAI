from __future__ import annotations

import sys
from pathlib import Path

MARKER = "atlas-investigation-hardening-v2"
BUDGET_MARKER = "atlas-model-evidence-budget-v1"

BUDGET_BLOCK = r'''# atlas-model-evidence-budget-v1
def _model_evidence_max_chars() -> int:
    raw = os.environ.get(
        "ATLAS_MODEL_EVIDENCE_MAX_CHARS",
        os.environ.get(
            "ATLAS_GOOSE_EVIDENCE_MAX_CHARS",
            "36000",
        ),
    ).strip()
    try:
        value = int(raw)
    except ValueError:
        value = 36000
    return max(12000, min(value, 90000))


def _ollama_timeout_seconds() -> float:
    raw = os.environ.get(
        "ATLAS_OLLAMA_TIMEOUT_SECONDS",
        "240",
    ).strip()
    try:
        value = int(raw)
    except ValueError:
        value = 240
    return float(max(30, min(value, 300)))


def _bounded_selected_node(value: Any, per_list: int = 8) -> Any:
    if not isinstance(value, dict):
        return value
    result: dict[str, Any] = {}
    for key, item in value.items():
        if key in {"dependencies", "dependents", "findings"} and isinstance(item, list):
            result[key] = item[:per_list]
        else:
            result[key] = item
    return result


def _bounded_json_value(
    value: Any,
    *,
    string_limit: int = 1200,
    list_limit: int = 8,
    depth: int = 0,
) -> Any:
    if depth > 8:
        text = str(value)
        return text[:string_limit]
    if isinstance(value, str):
        if len(value) <= string_limit:
            return value
        return value[:string_limit] + "…[truncated]"
    if isinstance(value, list):
        return [
            _bounded_json_value(
                item,
                string_limit=string_limit,
                list_limit=list_limit,
                depth=depth + 1,
            )
            for item in value[:list_limit]
        ]
    if isinstance(value, dict):
        return {
            str(key): _bounded_json_value(
                item,
                string_limit=string_limit,
                list_limit=list_limit,
                depth=depth + 1,
            )
            for key, item in value.items()
        }
    return value


def _bounded_model_evidence(
    graph: dict[str, Any],
    findings: list[dict[str, Any]],
    question: str,
    *,
    selected_node: str | None = None,
) -> dict[str, Any]:
    full = build_evidence_context(
        graph,
        findings,
        question,
        selected_node=selected_node,
    )
    caps = {
        "topFindings": 8,
        "findingGroups": 6,
        "matchingNodes": 8,
        "changedNodes": 10,
        "highestRisk": 8,
    }
    minimums = {
        "topFindings": 3,
        "findingGroups": 3,
        "matchingNodes": 3,
        "changedNodes": 3,
        "highestRisk": 3,
    }
    result: dict[str, Any] = {
        "atlasStats": full.get("atlasStats", {}),
    }
    available: dict[str, int] = {}
    for key, cap in caps.items():
        source = full.get(key, [])
        values = source if isinstance(source, list) else []
        available[key] = len(values)
        result[key] = values[:cap]

    if "selectedNode" in full:
        result["selectedNode"] = _bounded_selected_node(
            full.get("selectedNode"),
            8,
        )

    max_chars = _model_evidence_max_chars()
    result["evidenceBudget"] = {
        "maxSerializedChars": max_chars,
        "available": available,
        "included": {},
        "truncated": False,
        "serializedChars": 0,
    }

    def encoded_length() -> int:
        return len(
            json.dumps(
                result,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )

    trim_order = [
        "changedNodes",
        "highestRisk",
        "findingGroups",
        "topFindings",
        "matchingNodes",
    ]
    while encoded_length() > max_chars:
        changed = False
        for key in trim_order:
            values = result.get(key)
            if isinstance(values, list) and len(values) > minimums[key]:
                values.pop()
                changed = True
                if encoded_length() <= max_chars:
                    break
        if not changed:
            break

    if encoded_length() > max_chars and "selectedNode" in result:
        result["selectedNode"] = _bounded_selected_node(
            result["selectedNode"],
            3,
        )

    if encoded_length() > max_chars:
        compacted = _bounded_json_value(
            {
                key: value
                for key, value in result.items()
                if key != "evidenceBudget"
            },
            string_limit=800,
            list_limit=4,
        )
        result = dict(compacted) if isinstance(compacted, dict) else {"atlasStats": {}}
        result["evidenceBudget"] = {
            "maxSerializedChars": max_chars,
            "available": available,
            "included": {},
            "truncated": True,
            "serializedChars": 0,
        }

    if encoded_length() > max_chars:
        result = {
            "atlasStats": _bounded_json_value(
                full.get("atlasStats", {}),
                string_limit=400,
                list_limit=2,
            ),
            "selectedNode": _bounded_json_value(
                _bounded_selected_node(full.get("selectedNode"), 1),
                string_limit=400,
                list_limit=2,
            ) if "selectedNode" in full else None,
            "topFindings": _bounded_json_value(
                full.get("topFindings", [])[:1],
                string_limit=400,
                list_limit=2,
            ),
            "matchingNodes": _bounded_json_value(
                full.get("matchingNodes", [])[:1],
                string_limit=400,
                list_limit=2,
            ),
            "evidenceBudget": {
                "maxSerializedChars": max_chars,
                "available": available,
                "included": {},
                "truncated": True,
                "serializedChars": 0,
            },
        }

    included = {
        key: len(result.get(key, []))
        for key in caps
        if isinstance(result.get(key), list)
    }
    budget = result["evidenceBudget"]
    budget["included"] = included
    budget["truncated"] = bool(budget.get("truncated")) or any(
        included.get(key, 0) < available.get(key, 0)
        for key in caps
    )
    budget["serializedChars"] = encoded_length()
    budget["serializedChars"] = encoded_length()
    return result
'''


def read_text(path: Path):
    raw = path.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    if bom:
        raw = raw[3:]
    text = raw.decode("utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"
    return text, newline, bom


def write_text(path: Path, text: str, newline: str, bom: bool):
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if newline == "\r\n":
        normalized = normalized.replace("\n", "\r\n")
    raw = normalized.encode("utf-8")
    if bom:
        raw = b"\xef\xbb\xbf" + raw
    path.write_bytes(raw)


def _replace_evidence_call(text: str, function_name: str, next_function: str) -> str:
    start = text.find(f"def {function_name}(")
    end = text.find(f"\ndef {next_function}", start)
    if start < 0 or end < 0:
        raise RuntimeError(f"Could not isolate {function_name} for evidence budgeting.")
    block = text[start:end]
    old = '''    evidence = build_evidence_context(
        graph,
        findings,
        question,
        selected_node=selected_node,
    )'''
    new = '''    evidence = _bounded_model_evidence(
        graph,
        findings,
        question,
        selected_node=selected_node,
    )'''
    if new in block:
        return text
    if old not in block:
        raise RuntimeError(f"Could not locate evidence builder call inside {function_name}.")
    block = block.replace(old, new, 1)
    return text[:start] + block + text[end:]


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: harden.py REPO_ROOT")
    root = Path(sys.argv[1]).resolve()
    path = root / "atlas_intelligence.py"
    text, newline, bom = read_text(path)

    if "# atlas-investigations-v1" not in text:
        raise RuntimeError("Atlas Investigations v1 must be applied before hardening.")

    if BUDGET_MARKER not in text:
        marker = "def build_goose_brief("
        at = text.find(marker)
        if at < 0:
            raise RuntimeError("Could not locate build_goose_brief for context budgeting.")
        text = text[:at] + BUDGET_BLOCK.rstrip() + "\n\n\n" + text[at:]
        print("PASS: deterministic model evidence budget added")
    else:
        print("INFO: model evidence budget already present")

    before = text
    text = _replace_evidence_call(text, "ask_ollama", "goose_status")
    if text != before:
        print("PASS: Ask Atlas now uses bounded deterministic evidence")
    before = text
    text = _replace_evidence_call(text, "build_goose_brief", "ollama_status")
    if text != before:
        print("PASS: Goose now uses bounded deterministic evidence")

    ask_at = text.find("def ask_ollama(")
    ask_end = text.find("\ndef goose_status", ask_at)
    ask_block = text[ask_at:ask_end]
    if "timeout=_ollama_timeout_seconds()" not in ask_block:
        if "timeout=120.0" not in ask_block:
            raise RuntimeError("Could not locate Ask Atlas Ollama timeout.")
        ask_block = ask_block.replace("timeout=120.0", "timeout=_ollama_timeout_seconds()", 1)
        text = text[:ask_at] + ask_block + text[ask_end:]
        print("PASS: Ask Atlas Ollama timeout is configurable and bounded")

    if "ATLAS_GOOSE_BIN" not in text:
        old = '    executable = shutil.which("goose")\n\n    if executable is None:'
        new = '''    configured = os.environ.get("ATLAS_GOOSE_BIN", "").strip()
    executable = configured if configured and Path(configured).is_file() else shutil.which("goose")
    if executable is None and os.name == "nt":
        local_tool = ROOT.parent / "tools" / "goose" / "goose.exe"
        if local_tool.is_file():
            executable = str(local_tool)

    if executable is None:'''
        if old not in text:
            raise RuntimeError("Could not locate goose_status executable discovery.")
        text = text.replace(old, new, 1)
        print("PASS: Goose discovery supports ATLAS_GOOSE_BIN and C:\\LocalAI\\tools fallback")
    else:
        print("INFO: explicit Goose binary discovery already present")

    env_anchor = '    env["NO_COLOR"] = "1"\n    return env'
    if 'env["GOOSE_MODE"] = "smart_approve"' not in text:
        replacement = '''    env["NO_COLOR"] = "1"
    env["GOOSE_MODE"] = "smart_approve"
    env["GOOSE_MAX_TURNS"] = os.environ.get("ATLAS_GOOSE_MAX_TURNS", "24")
    return env'''
        if env_anchor not in text:
            raise RuntimeError("Could not locate Goose child environment return.")
        text = text.replace(env_anchor, replacement, 1)
        print("PASS: Goose child uses smart approval and bounded turns")

    old_command = '[executable, "run", "--text", prompt]'
    new_command = '''[
                executable,
                "run",
                "--no-session",
                "--no-profile",
                "--with-builtin",
                "developer",
                "--max-turns",
                os.environ.get("ATLAS_GOOSE_MAX_TURNS", "24"),
                "--max-tool-repetitions",
                "3",
                "--system",
                (
                    "Read-only architecture investigation. Never write, edit, "
                    "delete, rename, create, install, commit, or change "
                    "configuration. Use tools only to inspect existing "
                    "repository evidence."
                ),
                "--text",
                prompt,
            ]'''
    if '"--no-session"' not in text:
        if old_command not in text:
            raise RuntimeError("Could not locate Goose run command for restricted profile.")
        text = text.replace(old_command, new_command, 1)
        print("PASS: Goose run is stateless, restricted-profile, and system-prompted read-only")
    elif '"--system"' not in text:
        raise RuntimeError("Restricted Goose command exists without the required read-only system instruction.")
    else:
        print("INFO: restricted Goose run command already present")

    if MARKER not in text:
        text += f"\n# {MARKER}\n"

    write_text(path, text, newline, bom)
    print("HARDENING COMPLETE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
