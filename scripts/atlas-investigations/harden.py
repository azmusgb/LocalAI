from __future__ import annotations

import sys
from pathlib import Path

MARKER = "atlas-investigation-hardening-v1"
BUDGET_MARKER = "atlas-investigation-context-budget-v1"

BUDGET_BLOCK = r'''# atlas-investigation-context-budget-v1
def _goose_evidence_max_chars() -> int:
    raw = os.environ.get(
        "ATLAS_GOOSE_EVIDENCE_MAX_CHARS",
        "36000",
    ).strip()
    try:
        value = int(raw)
    except ValueError:
        value = 36000
    return max(12000, min(value, 90000))


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


def _investigation_evidence_context(
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

    max_chars = _goose_evidence_max_chars()
    result["evidenceBudget"] = {
        "maxSerializedChars": max_chars,
        "available": available,
        "included": {},
        "truncated": False,
    }

    def encoded_length() -> int:
        return len(json.dumps(result, ensure_ascii=False, separators=(",", ":")))

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

    # Final defensive bound. This path should be rare, but it prevents an
    # unexpectedly verbose finding or node from defeating the model budget.
    if encoded_length() > max_chars:
        for key in trim_order:
            values = result.get(key)
            if isinstance(values, list):
                result[key] = values[:1]
        result["selectedNode"] = _bounded_selected_node(
            result.get("selectedNode"),
            1,
        )

    included = {
        key: len(result.get(key, []))
        for key in caps
        if isinstance(result.get(key), list)
    }
    result["evidenceBudget"]["included"] = included
    result["evidenceBudget"]["serializedChars"] = encoded_length()
    result["evidenceBudget"]["truncated"] = any(
        included.get(key, 0) < available.get(key, 0)
        for key in caps
    )
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
        print("PASS: deterministic Goose evidence budget added")
    else:
        print("INFO: Goose evidence budget already present")

    old_evidence = '''    evidence = build_evidence_context(
        graph,
        findings,
        question,
        selected_node=selected_node,
    )'''
    new_evidence = '''    evidence = _investigation_evidence_context(
        graph,
        findings,
        question,
        selected_node=selected_node,
    )'''
    build_at = text.find("def build_goose_brief(")
    next_def = text.find("\ndef ollama_status", build_at)
    if build_at < 0 or next_def < 0:
        raise RuntimeError("Could not isolate build_goose_brief for evidence replacement.")
    build_block = text[build_at:next_def]
    if new_evidence not in build_block:
        if old_evidence not in build_block:
            raise RuntimeError("Could not locate Goose evidence builder call.")
        build_block = build_block.replace(old_evidence, new_evidence, 1)
        text = text[:build_at] + build_block + text[next_def:]
        print("PASS: Goose now uses bounded deterministic evidence")
    else:
        print("INFO: Goose already uses bounded deterministic evidence")

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
        print("PASS: Goose discovery now supports ATLAS_GOOSE_BIN and C:\\LocalAI\\tools fallback")
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
        print("PASS: Goose child runs in smart-approval mode with bounded turns")

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
                "--text",
                prompt,
            ]'''
    if '"--no-session"' not in text:
        if old_command not in text:
            raise RuntimeError("Could not locate Goose run command for restricted profile.")
        text = text.replace(old_command, new_command, 1)
        print("PASS: Goose run is stateless and limited to the Developer builtin")
    else:
        print("INFO: restricted Goose run command already present")

    if MARKER not in text:
        text += f"\n# {MARKER}\n"

    write_text(path, text, newline, bom)
    print("HARDENING COMPLETE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
