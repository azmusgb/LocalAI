from __future__ import annotations

import argparse
import hmac
import http.client
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

# atlas_snapshot_runner.py sits beside this file; loaded by path (tests, python -I) its folder isn't on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from atlas_snapshot_runner import MIRRORS, SnapshotRequestError, SnapshotRunner  # noqa: E402


ROOT = Path(__file__).resolve().parent
# quick_arch.py writes the graph here (a folder, so the container's read-only mount sees each rebuild).
ATLAS_HTML = Path(os.environ.get("ATLAS_GRAPH") or (ROOT / ".atlas" / "graph" / "system-atlas.html"))
INVESTIGATION_DIR = ROOT / ".atlas" / "investigations"
# Snapshots (plan PR 5): quick_arch.py writes <SNAPSHOTS>/<repo>/<commit>/graph.json. Questions about one are answered
# from a clean copy of its commit under <TREES>, beside the deploy checkout and never inside it.
SNAPSHOTS = Path(os.environ.get("ATLAS_SNAPSHOTS") or (ROOT / ".atlas" / "snapshots"))
TREES = Path(os.environ.get("ATLAS_TREES") or (ROOT.parent / "atlas-trees"))
SNAPSHOT_REPO = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
FULL_COMMIT = re.compile(r"^[0-9a-f]{40}$")
KEEP_TREES = 3
TREE_DONE = ".atlas-tree-complete"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

DEFAULT_OLLAMA_URL = os.environ.get(
    "ATLAS_OLLAMA_URL",
    "http://127.0.0.1:11434",
).rstrip("/")

DEFAULT_OLLAMA_MODEL = os.environ.get(
    "ATLAS_OLLAMA_MODEL",
    "",
).strip()

MAX_BODY_BYTES = 64 * 1024

# Who may call the service. Host names it answers to (a DNS-rebinding page arrives with its own name, so it is
# refused); ATLAS_ALLOWED_HOSTS adds more, comma-separated. ATLAS_TOKEN, when set, is a secret only Local AI's proxy
# sends (X-Atlas-Token) and every POST must carry it.
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]", "host.docker.internal"} | {
    h.strip().lower() for h in os.environ.get("ATLAS_ALLOWED_HOSTS", "").split(",") if h.strip()
}
ATLAS_TOKEN = os.environ.get("ATLAS_TOKEN", "").strip()


def host_name(value: str) -> str:
    value = (value or "").strip().lower()
    if value.startswith("["):
        return value.split("]", 1)[0] + "]"
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value
MAX_QUESTION_CHARS = 6000
ATLAS_INTELLIGENCE_VERSION = "1.1"

SEVERITY_RANK = {
    "critical": 0,
    "high": 1,
    "medium": 2,
    "low": 3,
    "info": 4,
}

BOUNDARY_DOMAINS = {
    "API",
    "Platform",
    "Claude",
    "Media",
    "Workshop",
    "Runtime",
    "Host",
}


def _as_int(value: Any, default: int = 0) -> int:
    """A graph number as an int: numbers and numeric strings ("85.5" is 85) read the same; anything else is default."""
    if isinstance(value, bool) or value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(str(value).strip()))
        except (TypeError, ValueError, OverflowError):
            return default
    except OverflowError:
        return default


class AtlasError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status: int = HTTPStatus.BAD_REQUEST,
        code: str = "atlas_error",
    ) -> None:
        super().__init__(message)
        self.status = int(status)
        self.code = code


def load_atlas_html(path: Path = ATLAS_HTML) -> str:
    if not path.is_file():
        raise AtlasError(
            f"System Atlas HTML was not found: {path}",
            status=HTTPStatus.NOT_FOUND,
            code="atlas_html_missing",
        )

    return path.read_text(
        encoding="utf-8",
        errors="strict",
    )


def extract_graph(html: str) -> dict[str, Any]:
    marker = "const DATA = "
    marker_index = html.find(marker)

    if marker_index < 0:
        raise AtlasError(
            "The System Atlas page does not contain its DATA graph.",
            status=HTTPStatus.INTERNAL_SERVER_ERROR,
            code="atlas_graph_missing",
        )

    payload = html[marker_index + len(marker):].lstrip()

    try:
        graph, _ = json.JSONDecoder().raw_decode(payload)
    except json.JSONDecodeError as error:
        raise AtlasError(
            f"Unable to decode the embedded Atlas graph: {error}",
            status=HTTPStatus.INTERNAL_SERVER_ERROR,
            code="atlas_graph_invalid",
        ) from error

    if not isinstance(graph, dict):
        raise AtlasError(
            "The embedded Atlas graph is not an object.",
            status=HTTPStatus.INTERNAL_SERVER_ERROR,
            code="atlas_graph_invalid",
        )

    nodes = graph.get("nodes")
    edges = graph.get("edges")

    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise AtlasError(
            "The embedded Atlas graph is missing nodes or edges.",
            status=HTTPStatus.INTERNAL_SERVER_ERROR,
            code="atlas_graph_invalid",
        )

    return graph


def finding(
    *,
    rule: str,
    severity: str,
    node: dict[str, Any],
    title: str,
    summary: str,
    confidence: float,
    evidence: list[str],
) -> dict[str, Any]:
    node_id = str(node.get("id", ""))

    return {
        "id": f"{rule}:{node_id}",
        "rule": rule,
        "severity": severity,
        "node": node_id,
        "domain": node.get("domain"),
        "title": title,
        "summary": summary,
        "confidence": round(max(0.0, min(1.0, confidence)), 2),
        "evidence": evidence,
    }


GENERIC_TEST_STEMS = {
    "app",
    "common",
    "config",
    "helpers",
    "images",
    "index",
    "main",
    "server",
    "service",
    "utils",
}

_TEST_EVIDENCE_CACHE_KEY: tuple[Any, ...] | None = None
_TEST_EVIDENCE_CACHE: dict[str, list[dict[str, str]]] = {}


def _path_tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(
            r"[A-Za-z0-9]+",
            value.lower(),
        )
        if len(token) >= 3
    }


def _test_aliases(node_id: str) -> list[str]:
    normalized = node_id.replace("\\", "/").strip("/")
    parts = normalized.split("/")

    aliases = {
        normalized,
        f"./{normalized}",
        f"../{normalized}",
    }

    if len(parts) >= 2:
        aliases.add("/".join(parts[-2:]))

    if len(parts) >= 3:
        aliases.add("/".join(parts[-3:]))

    basename = parts[-1]
    stem = Path(basename).stem.lower()

    if stem not in GENERIC_TEST_STEMS and len(stem) >= 5:
        aliases.add(basename)

    return sorted(
        aliases,
        key=lambda value: (-len(value), value),
    )


def _test_evidence_signature(
    production_nodes: list[str],
    test_nodes: list[str],
    root: Path | None = ROOT,
) -> tuple[Any, ...]:
    files: list[tuple[str, int, int]] = []

    for test_id in test_nodes:
        try:
            if root is None:
                raise OSError("no source")
            stat = (root / Path(test_id)).stat()
            files.append(
                (
                    test_id,
                    stat.st_mtime_ns,
                    stat.st_size,
                )
            )
        except OSError:
            files.append((test_id, -1, -1))

    return (
        str(root),
        tuple(production_nodes),
        tuple(files),
    )


def detect_test_evidence(
    graph: dict[str, Any],
    root: Path | None = ROOT,
) -> dict[str, list[dict[str, str]]]:
    """Detect deterministic test evidence beyond direct static imports.

    ``testRefs`` remains the direct-import signal generated by System Atlas.
    This augments it with repository evidence for tests that execute scripts,
    CLIs, or process boundaries without importing the production module.
    """

    production_nodes = [
        str(node.get("id", ""))
        for node in graph.get("nodes", [])
        if isinstance(node, dict)
        and node.get("id")
        and node.get("domain") != "Tests"
    ]

    test_nodes = [
        str(node.get("id", ""))
        for node in graph.get("nodes", [])
        if isinstance(node, dict)
        and node.get("id")
        and node.get("domain") == "Tests"
    ]

    cache_key = _test_evidence_signature(
        production_nodes,
        test_nodes,
        root,
    )

    global _TEST_EVIDENCE_CACHE_KEY
    global _TEST_EVIDENCE_CACHE

    if cache_key == _TEST_EVIDENCE_CACHE_KEY:
        return _TEST_EVIDENCE_CACHE

    result: dict[str, list[dict[str, str]]] = {
        node_id: []
        for node_id in production_nodes
    }

    production_meta: dict[
        str,
        tuple[list[str], set[str], str],
    ] = {}

    for node_id in production_nodes:
        production_meta[node_id] = (
            _test_aliases(node_id),
            _path_tokens(node_id),
            Path(node_id).stem.lower(),
        )

    for test_id in test_nodes:
        # Without a copy of the source, only the graph's names and paths count as evidence.
        test_path = root / Path(test_id) if root is not None else None
        text = ""

        if test_path is not None and test_path.is_file():
            try:
                text = test_path.read_text(
                    encoding="utf-8",
                    errors="replace",
                )
            except OSError:
                text = ""

        normalized_text = text.replace("\\", "/").lower()
        test_tokens = _path_tokens(test_id)

        for node_id, (
            aliases,
            node_tokens,
            stem,
        ) in production_meta.items():
            evidence_kind: str | None = None

            for alias in aliases:
                if alias.lower() in normalized_text:
                    evidence_kind = "path-reference"
                    break

            if evidence_kind is None:
                distinctive_stem = (
                    stem not in GENERIC_TEST_STEMS
                    and len(stem) >= 5
                    and stem in test_tokens
                )

                shared_context = (
                    node_tokens
                    & test_tokens
                    - {
                        stem,
                        "test",
                        "tests",
                        "app",
                        "host",
                        "server",
                        "public",
                        "street",
                    }
                )

                if distinctive_stem and shared_context:
                    evidence_kind = "test-name-affinity"

            if evidence_kind is None:
                continue

            result[node_id].append(
                {
                    "test": test_id,
                    "kind": evidence_kind,
                }
            )

    for node_id in result:
        unique: dict[
            tuple[str, str],
            dict[str, str],
        ] = {}

        for item in result[node_id]:
            unique[
                (
                    item["test"],
                    item["kind"],
                )
            ] = item

        result[node_id] = sorted(
            unique.values(),
            key=lambda item: (
                item["test"],
                item["kind"],
            ),
        )

    _TEST_EVIDENCE_CACHE_KEY = cache_key
    _TEST_EVIDENCE_CACHE = result

    return result


def effective_test_signal(
    node: dict[str, Any],
    evidence_map: dict[
        str,
        list[dict[str, str]],
    ],
) -> tuple[int, list[dict[str, str]]]:
    node_id = str(node.get("id", ""))
    direct_refs = _as_int(node.get("testRefs"))
    indirect = evidence_map.get(node_id, [])

    return direct_refs + len(indirect), indirect


def build_findings(
    graph: dict[str, Any],
    root: Path | None = ROOT,
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    evidence_map = detect_test_evidence(graph, root)

    for node in graph.get("nodes", []):
        if not isinstance(node, dict):
            continue

        node_id = str(node.get("id", ""))
        domain = str(node.get("domain", ""))

        if not node_id or domain == "Tests":
            continue

        risk = _as_int(node.get("risk"))
        inbound = _as_int(node.get("inbound"))
        outbound = _as_int(node.get("outbound"))
        degree = _as_int(node.get("degree"))
        direct_test_refs = _as_int(node.get("testRefs"))
        test_signal, indirect_tests = effective_test_signal(
            node,
            evidence_map,
        )
        changed = bool(node.get("changed"))

        test_evidence_labels = [
            f"{item['test']} ({item['kind']})"
            for item in indirect_tests[:5]
        ]

        if risk >= 70:
            findings.append(
                finding(
                    rule="critical-risk",
                    severity="critical",
                    node=node,
                    title="Critical architectural risk",
                    summary=f"{node_id} has an Atlas risk score of {risk}/100.",
                    confidence=0.98,
                    evidence=[
                        f"risk={risk}",
                        f"inbound={inbound}",
                        f"outbound={outbound}",
                        f"degree={degree}",
                        f"directTestRefs={direct_test_refs}",
                        f"effectiveTestSignal={test_signal}",
                    ],
                )
            )
        elif risk >= 48:
            findings.append(
                finding(
                    rule="high-risk",
                    severity="high",
                    node=node,
                    title="High architectural risk",
                    summary=f"{node_id} has an Atlas risk score of {risk}/100.",
                    confidence=0.96,
                    evidence=[
                        f"risk={risk}",
                        f"inbound={inbound}",
                        f"outbound={outbound}",
                        f"degree={degree}",
                    ],
                )
            )

        if outbound >= 15:
            findings.append(
                finding(
                    rule="high-fanout",
                    severity="critical" if outbound >= 40 else "high",
                    node=node,
                    title="Large architectural blast radius",
                    summary=(
                        f"{node_id} directly depends on {outbound} detected "
                        "modules. High connectivity is evidence of blast "
                        "radius, not automatically an architectural defect."
                    ),
                    confidence=0.99,
                    evidence=[
                        f"outbound={outbound}",
                        f"domain={domain}",
                    ],
                )
            )

        if changed and test_signal == 0 and domain != "Root":
            findings.append(
                finding(
                    rule="changed-without-detected-test-evidence",
                    severity=(
                        "high"
                        if domain in BOUNDARY_DOMAINS
                        else "medium"
                    ),
                    node=node,
                    title="Changed module lacks detected test evidence",
                    summary=(
                        f"{node_id} is currently changed, but Atlas found "
                        "neither a direct static test import nor a deterministic "
                        "process/CLI test reference."
                    ),
                    confidence=0.88,
                    evidence=[
                        "changed=true",
                        f"directTestRefs={direct_test_refs}",
                        "indirectTestEvidence=0",
                        f"domain={domain}",
                        f"degree={degree}",
                    ],
                )
            )

        if (
            domain in BOUNDARY_DOMAINS
            and degree >= 2
            and test_signal == 0
        ):
            findings.append(
                finding(
                    rule="boundary-without-detected-test-evidence",
                    severity="medium",
                    node=node,
                    title="Boundary verification may be weak",
                    summary=(
                        f"{node_id} sits in the {domain} boundary, has "
                        f"{degree} detected relationships, and Atlas found "
                        "no deterministic test evidence."
                    ),
                    confidence=0.82,
                    evidence=[
                        f"domain={domain}",
                        f"degree={degree}",
                        f"directTestRefs={direct_test_refs}",
                        "indirectTestEvidence=0",
                    ],
                )
            )

        if (
            degree >= 6
            and test_signal == 0
            and domain not in {
                "UI",
                "Docs",
                "Root",
            }
        ):
            findings.append(
                finding(
                    rule="connected-without-detected-test-evidence",
                    severity="high",
                    node=node,
                    title="Highly connected module lacks detected test evidence",
                    summary=(
                        f"{node_id} participates in {degree} detected "
                        "relationships but Atlas found no deterministic "
                        "test evidence."
                    ),
                    confidence=0.86,
                    evidence=[
                        f"degree={degree}",
                        f"inbound={inbound}",
                        f"outbound={outbound}",
                        f"directTestRefs={direct_test_refs}",
                        "indirectTestEvidence=0",
                    ],
                )
            )

        if (
            changed
            and direct_test_refs == 0
            and indirect_tests
        ):
            findings.append(
                finding(
                    rule="changed-with-indirect-test-evidence",
                    severity="info",
                    node=node,
                    title="Changed module has process/CLI test evidence",
                    summary=(
                        f"{node_id} has no direct static test import, but Atlas "
                        f"detected {len(indirect_tests)} test reference(s) that "
                        "exercise or reference it indirectly."
                    ),
                    confidence=0.90,
                    evidence=[
                        f"directTestRefs={direct_test_refs}",
                        *test_evidence_labels,
                    ],
                )
            )

    node_risk = {
        str(node.get("id")): _as_int(node.get("risk"))
        for node in graph.get("nodes", [])
        if isinstance(node, dict) and node.get("id")
    }

    findings.sort(
        key=lambda item: (
            SEVERITY_RANK.get(
                str(item.get("severity")),
                99,
            ),
            -node_risk.get(
                str(item.get("node")),
                0,
            ),
            str(item.get("node", "")),
            str(item.get("rule", "")),
        )
    )

    return findings


def aggregate_findings(
    graph: dict[str, Any],
    findings: list[dict[str, Any]],
    root: Path | None = ROOT,
) -> list[dict[str, Any]]:
    nodes = node_index(graph)
    evidence_map = detect_test_evidence(graph, root)
    grouped: dict[str, dict[str, Any]] = {}

    for item in findings:
        node_id = str(item.get("node", ""))

        if not node_id:
            continue

        node = nodes.get(node_id, {})

        group = grouped.setdefault(
            node_id,
            {
                "node": node_id,
                "domain": item.get("domain"),
                "severity": "info",
                "risk": _as_int(node.get("risk")),
                "degree": _as_int(node.get("degree")),
                "outbound": _as_int(node.get("outbound")),
                "directTestRefs": _as_int(node.get("testRefs")),
                "testEvidence": evidence_map.get(
                    node_id,
                    [],
                ),
                "signals": [],
            },
        )

        group["signals"].append(
            {
                "rule": item.get("rule"),
                "severity": item.get("severity"),
                "title": item.get("title"),
                "summary": item.get("summary"),
                "confidence": item.get("confidence"),
                "evidence": item.get("evidence", []),
            }
        )

        current_rank = SEVERITY_RANK.get(
            str(group["severity"]),
            99,
        )
        item_rank = SEVERITY_RANK.get(
            str(item.get("severity")),
            99,
        )

        if item_rank < current_rank:
            group["severity"] = item.get(
                "severity",
                "info",
            )

    result = list(grouped.values())

    for group in result:
        signal_count = len(group["signals"])
        evidence_count = (
            group["directTestRefs"]
            + len(group["testEvidence"])
        )

        group["signalCount"] = signal_count
        group["testEvidenceCount"] = evidence_count
        group["summary"] = (
            f"{signal_count} deterministic signal"
            f"{'' if signal_count == 1 else 's'} · "
            f"risk {group['risk']}/100 · "
            f"{group['degree']} relationships · "
            f"{evidence_count} test signal"
            f"{'' if evidence_count == 1 else 's'}"
        )

    result.sort(
        key=lambda group: (
            SEVERITY_RANK.get(
                str(group.get("severity")),
                99,
            ),
            -_as_int(group.get("risk")),
            -_as_int(group.get("signalCount")),
            str(group.get("node", "")),
        )
    )

    return result


def node_index(
    graph: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    return {
        str(node["id"]): node
        for node in graph.get("nodes", [])
        if isinstance(node, dict) and node.get("id")
    }


def edge_indexes(
    graph: dict[str, Any],
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    outgoing: dict[str, list[str]] = {}
    incoming: dict[str, list[str]] = {}

    for edge in graph.get("edges", []):
        if not isinstance(edge, dict):
            continue

        source = str(edge.get("source", ""))
        target = str(edge.get("target", ""))

        if not source or not target:
            continue

        outgoing.setdefault(source, []).append(target)
        incoming.setdefault(target, []).append(source)

    return outgoing, incoming


def compact_node(
    node: dict[str, Any],
    *,
    test_evidence: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    keys = (
        "id",
        "label",
        "domain",
        "inbound",
        "outbound",
        "degree",
        "testRefs",
        "changed",
        "risk",
        "riskLevel",
    )

    result = {
        key: node.get(key)
        for key in keys
    }

    if test_evidence is not None:
        result["testEvidence"] = test_evidence
        result["effectiveTestSignal"] = (
            _as_int(node.get("testRefs"))
            + len(test_evidence)
        )

    return result


def get_node_details(
    graph: dict[str, Any],
    findings: list[dict[str, Any]],
    node_id: str,
    root: Path | None = ROOT,
) -> dict[str, Any] | None:
    nodes = node_index(graph)
    node = nodes.get(node_id)

    if node is None:
        return None

    outgoing, incoming = edge_indexes(graph)
    evidence_map = detect_test_evidence(graph, root)

    return {
        "node": compact_node(
            node,
            test_evidence=evidence_map.get(
                node_id,
                [],
            ),
        ),
        "dependencies": [
            compact_node(
                nodes[target],
                test_evidence=evidence_map.get(
                    target,
                    [],
                ),
            )
            for target in outgoing.get(
                node_id,
                [],
            )
            if target in nodes
        ],
        "dependents": [
            compact_node(
                nodes[source],
                test_evidence=evidence_map.get(
                    source,
                    [],
                ),
            )
            for source in incoming.get(
                node_id,
                [],
            )
            if source in nodes
        ],
        "findings": [
            item
            for item in findings
            if item.get("node") == node_id
        ],
    }


def question_tokens(question: str) -> list[str]:
    raw = re.findall(
        r"[A-Za-z0-9_./-]+",
        question.lower(),
    )

    ignored = {
        "what",
        "when",
        "where",
        "which",
        "why",
        "how",
        "does",
        "this",
        "that",
        "with",
        "from",
        "into",
        "about",
        "have",
        "show",
        "find",
        "atlas",
        "module",
        "file",
        "code",
    }

    return [
        token
        for token in raw
        if len(token) >= 3 and token not in ignored
    ]


def matching_nodes(
    graph: dict[str, Any],
    question: str,
    *,
    limit: int = 12,
) -> list[dict[str, Any]]:
    tokens = question_tokens(question)

    scored: list[
        tuple[int, int, str, dict[str, Any]]
    ] = []

    for node in graph.get("nodes", []):
        if not isinstance(node, dict):
            continue

        node_id = str(node.get("id", ""))
        label = str(node.get("label", ""))
        domain = str(node.get("domain", ""))

        haystack = f"{node_id} {label} {domain}".lower()

        score = sum(
            3 if token in node_id.lower() else 1
            for token in tokens
            if token in haystack
        )

        if score <= 0:
            continue

        scored.append(
            (
                score,
                _as_int(node.get("degree")),
                node_id,
                node,
            )
        )

    scored.sort(
        key=lambda item: (
            -item[0],
            -item[1],
            item[2],
        )
    )

    return [
        compact_node(item[3])
        for item in scored[:limit]
    ]


def build_evidence_context(
    graph: dict[str, Any],
    findings: list[dict[str, Any]],
    question: str,
    *,
    selected_node: str | None = None,
    root: Path | None = ROOT,
) -> dict[str, Any]:
    evidence_map = detect_test_evidence(graph, root)
    nodes = node_index(graph)

    def enriched(
        node: dict[str, Any],
    ) -> dict[str, Any]:
        node_id = str(node.get("id", ""))

        return compact_node(
            node,
            test_evidence=evidence_map.get(
                node_id,
                [],
            ),
        )

    matched = matching_nodes(
        graph,
        question,
    )

    context: dict[str, Any] = {
        "atlasStats": graph.get(
            "stats",
            {},
        ),
        "topFindings": findings[:16],
        "findingGroups": aggregate_findings(
            graph,
            findings,
            root,
        )[:12],
        "matchingNodes": [
            enriched(nodes[str(item.get("id"))])
            for item in matched
            if str(item.get("id")) in nodes
        ],
        "changedNodes": [
            enriched(node)
            for node in graph.get(
                "changedNodes",
                [],
            )[:20]
            if isinstance(node, dict)
        ],
        "highestRisk": [
            enriched(node)
            for node in graph.get(
                "highestRisk",
                [],
            )[:12]
            if isinstance(node, dict)
        ],
    }

    if selected_node:
        details = get_node_details(
            graph,
            findings,
            selected_node,
            root,
        )

        if details is not None:
            context["selectedNode"] = details

    return context


# ---------------------------------------------------------------------------
# Ask: a small packet about the selected module (Atlas redesign spec, PR 6)
# ---------------------------------------------------------------------------

ASK_TOKENS_SELECTED = 3000
ASK_TOKENS_REPO = 4000
ASK_ANSWER_TOKENS = 1000
ASK_DEFAULT_CTX = 8192
ASK_LIST_MAX = 40


def estimate_tokens(text: str) -> int:
    """A deliberately high estimate (3 characters a token): paths and JSON punctuation tokenize worse than prose."""
    return math.ceil(len(text) / 3)


def packet_json(packet: dict[str, Any]) -> str:
    return json.dumps(packet, ensure_ascii=False, separators=(",", ":"))


def _link_kind(edge: dict[str, Any], nodes: dict[str, dict[str, Any]]) -> str:
    kind = str(edge.get("kind") or "")
    if kind:
        return kind
    # A version 1 graph has no kinds: a link from a test module is a test link.
    return "test" if nodes.get(str(edge.get("source")), {}).get("domain") == "Tests" else "import"


def _fit(items: list[tuple[str, str, Any]], budget: int, shape) -> tuple[dict[str, Any], list[str]]:
    """Add (section, label, value) items in rank order until the next one would pass the budget; everything from that
    item on is left out, so the lowest-ranked go first. `shape(sections)` builds the packet in its reading order."""
    sections: dict[str, list[Any]] = {}
    cut = len(items)
    for i, (section, _label, value) in enumerate(items):
        sections.setdefault(section, []).append(value)
        if estimate_tokens(packet_json(shape(sections))) > budget:
            sections[section].pop()
            cut = i
            break
    counts: dict[str, int] = {}
    for _section, label, _value in items[cut:]:
        counts[label] = counts.get(label, 0) + 1
    return shape(sections), [f"{n} {label}" for label, n in counts.items()]


def build_ask_packet(
    graph: dict[str, Any],
    findings: list[dict[str, Any]],
    question: str,
    *,
    selected_node: str | None = None,
    root: Path | None = ROOT,
) -> dict[str, Any]:
    """{packet, leftOut, tokens}. With a module selected: the module, its neighbours ranked by distance then risk (graph-
    neighbour retrieval, as in LightRAG's local mode) and only the findings naming them, within 3,000 tokens. With none:
    what matches the question, then the repo-wide findings and lists, within 4,000."""
    nodes = node_index(graph)
    evidence_map = detect_test_evidence(graph, root)
    severity = lambda f: SEVERITY_RANK.get(str(f.get("severity")), len(SEVERITY_RANK))

    def brief(node: dict[str, Any], **more: Any) -> dict[str, Any]:
        node_id = str(node.get("id", ""))
        out = {k: node.get(k) for k in ("id", "domain", "risk", "riskLevel", "testRefs") if node.get(k) is not None}
        extra = len(evidence_map.get(node_id, []))
        if extra:
            out["testEvidence"] = extra
        return {**out, **more}

    if selected_node and selected_node in nodes:
        uses: dict[str, None] = {}
        used_by: dict[str, None] = {}
        tests: dict[str, None] = {}
        adjacent: dict[str, set[str]] = {}
        for edge in graph.get("edges", []):
            if not isinstance(edge, dict):
                continue
            src, dst = str(edge.get("source", "")), str(edge.get("target", ""))
            if src not in nodes or dst not in nodes or src == dst:
                continue
            if _link_kind(edge, nodes) == "test":
                if dst == selected_node:
                    tests[src] = None
                continue
            adjacent.setdefault(src, set()).add(dst)
            adjacent.setdefault(dst, set()).add(src)
            if src == selected_node:
                uses[dst] = None
            elif dst == selected_node:
                used_by[src] = None

        by_risk = lambda ids: sorted(ids, key=lambda i: (-_as_int(nodes[i].get("risk")), i))
        hop1 = by_risk(set(uses) | set(used_by))
        seen = {selected_node, *hop1}
        hop2: dict[str, str] = {}
        for via in hop1:
            for other in by_risk(adjacent.get(via, set()) - seen):
                hop2.setdefault(other, via)
        hop2_order = by_risk(hop2)
        rank = {node_id: i for i, node_id in enumerate([selected_node, *hop1, *hop2_order])}

        node = nodes[selected_node]
        lists = {"uses": by_risk(uses), "usedBy": by_risk(used_by), "tests": sorted(tests)}
        core = {
            **brief(node),
            "label": node.get("label"),
            "riskParts": node.get("riskParts"),
            "inbound": node.get("inbound"),
            "outbound": node.get("outbound"),
            "changed": node.get("changed"),
            **{k: v[:ASK_LIST_MAX] for k, v in lists.items()},
        }
        core = {k: v for k, v in core.items() if v is not None}
        trimmed = [f"{len(v) - ASK_LIST_MAX} of {len(v)} in its {k} list" for k, v in lists.items() if len(v) > ASK_LIST_MAX]

        def near(f: dict[str, Any]) -> tuple:
            return (rank.get(str(f.get("node")), len(rank)), severity(f))

        own = sorted((f for f in findings if f.get("node") == selected_node), key=severity)
        first = sorted((f for f in findings if f.get("node") in set(hop1)), key=near)
        second = sorted((f for f in findings if f.get("node") in hop2), key=near)
        items: list[tuple[str, str, Any]] = [
            *(("findings", "findings", f) for f in own),
            *(("findings", "findings", f) for f in first),
            *(("neighbours", "neighbours", brief(nodes[i], hop=1, via="uses" if i in uses else "usedBy")) for i in hop1),
            *(("neighbours", "neighbours", brief(nodes[i], hop=2, via=hop2[i])) for i in hop2_order),
            *(("findings", "findings", f) for f in second),
        ]

        def shape(sections: dict[str, list[Any]]) -> dict[str, Any]:
            out: dict[str, Any] = {"selected": core}
            for key in ("neighbours", "findings"):
                if sections.get(key):
                    out[key] = sections[key]
            return out

        packet, left = _fit(items, ASK_TOKENS_SELECTED, shape)
        left = trimmed + left
    else:
        enriched = lambda n: compact_node(n, test_evidence=evidence_map.get(str(n.get("id", "")), []))
        items = [
            *(("matchingNodes", "matching modules", enriched(nodes[str(n.get("id"))]))
              for n in matching_nodes(graph, question) if str(n.get("id")) in nodes),
            *(("topFindings", "findings", f) for f in sorted(findings, key=severity)[:16]),
            *(("findingGroups", "finding groups", g) for g in aggregate_findings(graph, findings, root)[:12]),
            *(("highestRisk", "high-risk modules", enriched(n)) for n in graph.get("highestRisk", [])[:12] if isinstance(n, dict)),
            *(("changedNodes", "changed modules", enriched(n)) for n in graph.get("changedNodes", [])[:20] if isinstance(n, dict)),
        ]
        stats = graph.get("stats", {})

        def shape(sections: dict[str, list[Any]]) -> dict[str, Any]:
            out: dict[str, Any] = {k: v for k, v in sections.items() if v}
            out["atlasStats"] = stats
            return out

        packet, left = _fit(items, ASK_TOKENS_REPO, shape)

    return {"packet": packet, "leftOut": left, "tokens": estimate_tokens(packet_json(packet))}


def model_context(base_url: str, model: str) -> tuple[int | None, int | None]:
    """(the model's configured num_ctx, its architecture's maximum), either None when Ollama doesn't say."""
    try:
        info = request_json(f"{base_url}/api/show", method="POST", payload={"model": model}, timeout=5.0)
    except AtlasError:
        return None, None
    configured = None
    for line in str(info.get("parameters") or "").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == "num_ctx" and parts[1].isdigit():
            configured = int(parts[1])
    maximum = next((v for k, v in (info.get("model_info") or {}).items()
                    if k.endswith(".context_length") and isinstance(v, int)), None)
    return configured, maximum


def ask_context(configured: int | None, maximum: int | None) -> int:
    """num_ctx to send: the model's own setting (so Ollama never reloads it), else 8,192 within what it supports."""
    if configured:
        return configured
    return min(ASK_DEFAULT_CTX, maximum) if maximum else ASK_DEFAULT_CTX


def request_json(
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: float = 8.0,
) -> dict[str, Any]:
    data: bytes | None = None

    headers = {
        "Accept": "application/json",
    }

    if payload is not None:
        data = json.dumps(
            payload,
            ensure_ascii=False,
        ).encode("utf-8")

        headers["Content-Type"] = (
            "application/json"
        )

    request = Request(
        url,
        data=data,
        headers=headers,
        method=method,
    )

    try:
        with urlopen(
            request,
            timeout=timeout,
        ) as response:
            body = response.read()

    except HTTPError as error:
        message = ""

        try:
            message = error.read().decode(
                "utf-8",
                errors="replace",
            )
        except Exception:
            message = ""

        raise AtlasError(
            (
                f"HTTP {error.code} from "
                f"{url}: {message[:500]}"
            ),
            status=HTTPStatus.BAD_GATEWAY,
            code="upstream_http_error",
        ) from error

    except URLError as error:
        raise AtlasError(
            f"Unable to reach {url}: {error.reason}",
            status=HTTPStatus.BAD_GATEWAY,
            code="upstream_unavailable",
        ) from error

    # A stalled or dropped read (a model still loading) is the same as unreachable: the caller degrades.
    except (TimeoutError, OSError, http.client.HTTPException) as error:
        raise AtlasError(
            f"No complete answer from {url}: {error}",
            status=HTTPStatus.BAD_GATEWAY,
            code="upstream_unavailable",
        ) from error

    try:
        decoded = json.loads(
            body.decode("utf-8")
        )
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
    ) as error:
        raise AtlasError(
            f"Invalid JSON returned by {url}",
            status=HTTPStatus.BAD_GATEWAY,
            code="upstream_invalid_json",
        ) from error

    if not isinstance(decoded, dict):
        raise AtlasError(
            f"Unexpected JSON returned by {url}",
            status=HTTPStatus.BAD_GATEWAY,
            code="upstream_invalid_json",
        )

    return decoded


def ollama_models(
    base_url: str = DEFAULT_OLLAMA_URL,
) -> list[str]:
    payload = request_json(
        f"{base_url}/api/tags",
        timeout=3.0,
    )

    result: list[str] = []

    for item in payload.get("models", []):
        if not isinstance(item, dict):
            continue

        name = (
            item.get("name")
            or item.get("model")
        )

        if isinstance(name, str) and name:
            result.append(name)

    return result


def choose_ollama_model(
    models: list[str],
    requested: str | None,
) -> str:
    candidates = [
        requested or "",
        DEFAULT_OLLAMA_MODEL,
    ]

    for candidate in candidates:
        candidate = candidate.strip()

        if not candidate:
            continue

        if not models or candidate in models:
            return candidate

    if models:
        return models[0]

    raise AtlasError(
        "Ollama is reachable but no local models were reported.",
        status=HTTPStatus.SERVICE_UNAVAILABLE,
        code="ollama_no_models",
    )


OLLAMA_SYSTEM_PROMPT = """You are Atlas Intelligence, a repository architecture analyst.

The supplied ATLAS EVIDENCE is authoritative for topology, risk values,
Git-change state, dependency counts, and direct test-import signals.

Rules:
1. Never invent a dependency, route, test, runtime relationship, or file.
2. Clearly distinguish deterministic Atlas evidence from your interpretation.
3. Use exact repository paths in backticks whenever possible.
4. "testRefs" means direct static test-import evidence. "testEvidence" adds
   deterministic path/name evidence for tests that exercise scripts or process
   boundaries without importing them. Neither metric is executed line coverage.
5. If the evidence is insufficient, explicitly say what additional evidence
   would be required.
6. Prefer concrete engineering observations over generic advice.
7. Do not propose destructive actions.
8. Keep answers concise unless the question explicitly asks for depth.
9. The evidence was cut to fit. When "LEFT OUT TO FIT" names something your
   answer depends on, say so.
"""


def ask_ollama(
    *,
    graph: dict[str, Any],
    findings: list[dict[str, Any]],
    question: str,
    selected_node: str | None = None,
    requested_model: str | None = None,
    base_url: str = DEFAULT_OLLAMA_URL,
    root: Path | None = ROOT,
    scope: dict[str, Any] | None = None,
) -> dict[str, Any]:
    models = ollama_models(base_url)

    model = choose_ollama_model(
        models,
        requested_model,
    )

    built = build_ask_packet(
        graph,
        findings,
        question,
        selected_node=selected_node,
        root=root,
    )
    evidence = built["packet"]
    left_out = built["leftOut"]

    user_prompt = (
        f"QUESTION:\n{question}\n\n"
        + (f"REPOSITORY: {scope['repo']} at commit {scope['commit']}\n\n" if scope else "")
        + f"LEFT OUT TO FIT: {'; '.join(left_out) if left_out else 'nothing'}\n\n"
        "ATLAS EVIDENCE (compact JSON):\n"
        + packet_json(evidence)
    )

    # Send num_ctx every time, and refuse rather than let Ollama silently cut the prompt.
    num_ctx = ask_context(*model_context(base_url, model))
    needed = estimate_tokens(OLLAMA_SYSTEM_PROMPT) + estimate_tokens(user_prompt) + ASK_ANSWER_TOKENS
    if needed > num_ctx:
        # The smallest model that fits, preferring one whose context is set in its Modelfile.
        others = {m: model_context(base_url, m) for m in models if m != model}
        fits = sorted((ask_context(*c), c[0] is None, m) for m, c in others.items())
        better = next((m for ctx, _unset, m in fits if ctx >= needed), None)
        raise AtlasError(
            f"{model} holds {num_ctx:,} tokens; this question needs about {needed:,} with its answer."
            + (f" Pick {better} instead." if better else " No installed model has a large enough context."),
            status=HTTPStatus.UNPROCESSABLE_ENTITY,
            code="ollama_context_too_small",
        )

    response = request_json(
        f"{base_url}/api/chat",
        method="POST",
        payload={
            "model": model,
            "stream": False,
            "messages": [
                {
                    "role": "system",
                    "content": OLLAMA_SYSTEM_PROMPT,
                },
                {
                    "role": "user",
                    "content": user_prompt,
                },
            ],
            "options": {
                "temperature": 0.15,
                "num_ctx": num_ctx,
            },
        },
        timeout=120.0,
    )

    message = response.get("message")

    if not isinstance(message, dict):
        raise AtlasError(
            "Ollama returned no message.",
            status=HTTPStatus.BAD_GATEWAY,
            code="ollama_invalid_response",
        )

    content = message.get("content")

    if not isinstance(content, str):
        raise AtlasError(
            "Ollama returned no textual answer.",
            status=HTTPStatus.BAD_GATEWAY,
            code="ollama_invalid_response",
        )

    evidence_path_set = {
        str(node.get("id"))
        for key in ("matchingNodes", "neighbours")
        for node in evidence.get(key, [])
        if isinstance(node, dict) and node.get("id")
    }

    if selected_node:
        evidence_path_set.add(
            selected_node
        )

    evidence_paths = sorted(
        evidence_path_set
    )

    return {
        "answer": content.strip(),
        "model": model,
        "provider": "ollama",
        "evidencePaths": evidence_paths,
        "evidence": evidence,
        "leftOut": left_out,
        "contextTokens": num_ctx,
    }


def goose_status() -> dict[str, Any]:
    executable = shutil.which("goose")

    if executable is None:
        return {
            "available": False,
            "executable": None,
            "version": None,
        }

    version: str | None = None

    try:
        result = subprocess.run(
            [
                executable,
                "--version",
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=3,
        )

        value = (
            result.stdout.strip()
            or result.stderr.strip()
        )

        if value:
            version = value.splitlines()[0][:200]

    except (
        OSError,
        subprocess.SubprocessError,
    ):
        pass

    return {
        "available": True,
        "executable": executable,
        "version": version,
    }


def build_goose_brief(
    *,
    graph: dict[str, Any],
    findings: list[dict[str, Any]],
    question: str,
    selected_node: str | None = None,
    root: Path | None = ROOT,
    scope: dict[str, Any] | None = None,
) -> dict[str, Any]:
    evidence = build_evidence_context(
        graph,
        findings,
        question,
        selected_node=selected_node,
        root=root,
    )

    if scope is None:
        subject = "You are investigating the Local AI repository."
    elif root is not None:
        subject = (
            f"You are investigating the {scope['repo']} repository at commit {scope['commit']}.\n"
            f"Its source is the clean copy at `{root}`. Read files there only, never in any other checkout."
        )
    else:
        subject = (
            f"You are investigating the {scope['repo']} repository at commit {scope['commit']}.\n"
            f"Its source is not available on this PC ({scope.get('reason')}); work from the Atlas evidence below."
        )

    prompt = f"""# Atlas Investigation

{subject}

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

    INVESTIGATION_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    timestamp = datetime.now(
        timezone.utc
    ).strftime("%Y%m%dT%H%M%SZ")

    path = (
        INVESTIGATION_DIR
        / f"atlas-investigation-{timestamp}.md"
    )

    path.write_text(
        prompt,
        encoding="utf-8",
        newline="\n",
    )

    return {
        "prompt": prompt,
        "briefPath": path.relative_to(
            ROOT
        ).as_posix(),
        "goose": goose_status(),
    }


def ollama_status() -> dict[str, Any]:
    try:
        models = ollama_models(
            DEFAULT_OLLAMA_URL
        )

        return {
            "available": True,
            "url": DEFAULT_OLLAMA_URL,
            "models": models,
            "defaultModel": (
                DEFAULT_OLLAMA_MODEL
                or (
                    models[0]
                    if models
                    else None
                )
            ),
        }

    except AtlasError as error:
        return {
            "available": False,
            "url": DEFAULT_OLLAMA_URL,
            "models": [],
            "defaultModel": None,
            "error": str(error),
        }


INTELLIGENCE_STYLE = r"""
<style id="atlas-intelligence-style">
.atlas-ai-toggle {
    position: fixed;
    z-index: 120;
    top: 90px;
    right: calc(var(--inspector) + 16px);
    min-height: 38px;
    padding: 0 13px;
    border: 1px solid rgba(87,221,255,.24);
    border-radius: 10px;
    color: #dff8ff;
    cursor: pointer;
    background: linear-gradient(180deg, rgba(19,38,52,.96), rgba(11,22,32,.96));
    box-shadow: 0 12px 35px rgba(0,0,0,.32), inset 0 0 24px rgba(87,221,255,.04);
    backdrop-filter: blur(18px);
}
.atlas-ai-toggle:hover {
    border-color: rgba(87,221,255,.5);
}
.atlas-ai-toggle-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 7px;
    border-radius: 50%;
    background: #57ddff;
    box-shadow: 0 0 12px rgba(87,221,255,.8);
}
.atlas-ai-drawer {
    position: fixed;
    z-index: 130;
    top: 138px;
    right: calc(var(--inspector) + 16px);
    width: min(440px, calc(100vw - 32px));
    max-height: calc(100vh - 158px);
    overflow: auto;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 14px;
    background: linear-gradient(180deg, rgba(13,19,29,.98), rgba(7,11,17,.98));
    box-shadow: 0 30px 90px rgba(0,0,0,.48);
    backdrop-filter: blur(26px);
}
.atlas-ai-drawer[hidden] {
    display: none;
}
.atlas-ai-head {
    position: sticky;
    z-index: 2;
    top: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 15px;
    border-bottom: 1px solid rgba(255,255,255,.075);
    background: rgba(12,17,25,.96);
}
.atlas-ai-head-copy {
    min-width: 0;
    flex: 1;
}
.atlas-ai-eyebrow {
    color: #57ddff;
    font-size: 9px;
    font-weight: 850;
    letter-spacing: .14em;
    text-transform: uppercase;
}
.atlas-ai-title {
    margin-top: 2px;
    font-size: 13px;
    font-weight: 720;
}
.atlas-ai-close {
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 7px;
    cursor: pointer;
    color: #8793a6;
    background: rgba(255,255,255,.035);
}
.atlas-ai-body {
    padding: 14px;
}
.atlas-ai-provider-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 12px;
}
.atlas-ai-provider {
    padding: 5px 7px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 999px;
    color: #8490a2;
    font-size: 8px;
    background: rgba(255,255,255,.025);
}
.atlas-ai-provider.ok {
    color: #5ce6a4;
    border-color: rgba(92,230,164,.2);
}
.atlas-ai-provider.warn {
    color: #f4bd63;
    border-color: rgba(244,189,99,.22);
}
.atlas-ai-quick {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
}
.atlas-ai-chip {
    min-height: 29px;
    padding: 0 9px;
    border: 1px solid rgba(255,255,255,.075);
    border-radius: 8px;
    color: #aeb8c7;
    cursor: pointer;
    font-size: 9px;
    background: rgba(255,255,255,.03);
}
.atlas-ai-chip:hover {
    border-color: rgba(87,221,255,.3);
    color: white;
}
#atlasAiQuestion {
    width: 100%;
    min-height: 92px;
    resize: vertical;
    padding: 11px;
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 9px;
    outline: none;
    color: #f4f7fb;
    font: inherit;
    font-size: 11px;
    line-height: 1.55;
    background: rgba(255,255,255,.035);
}
#atlasAiQuestion:focus {
    border-color: rgba(87,221,255,.42);
    box-shadow: 0 0 0 3px rgba(87,221,255,.06);
}
.atlas-ai-actions {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 7px;
    margin-top: 8px;
}
.atlas-ai-action {
    min-height: 35px;
    padding: 0 11px;
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 8px;
    color: #d5dde9;
    cursor: pointer;
    font-size: 9px;
    font-weight: 650;
    background: rgba(255,255,255,.04);
}
.atlas-ai-action.primary {
    border-color: rgba(87,221,255,.24);
    color: #e5fbff;
    background: linear-gradient(180deg, rgba(36,89,112,.55), rgba(19,49,67,.55));
}
.atlas-ai-action:disabled {
    cursor: wait;
    opacity: .5;
}
.atlas-ai-answer,
.atlas-ai-findings {
    margin-top: 13px;
}
.atlas-ai-label {
    margin-bottom: 7px;
    color: #596579;
    font-size: 8px;
    font-weight: 850;
    letter-spacing: .14em;
    text-transform: uppercase;
}
.atlas-ai-answer-box {
    padding: 11px;
    border: 1px solid rgba(255,255,255,.07);
    border-radius: 9px;
    color: #bcc7d6;
    font-size: 10px;
    line-height: 1.65;
    white-space: pre-wrap;
    background: rgba(255,255,255,.025);
}
.atlas-ai-answer-box.error {
    color: #ff8798;
    border-color: rgba(255,107,129,.18);
}
.atlas-ai-finding {
    width: 100%;
    margin-bottom: 5px;
    padding: 8px 9px;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    color: #b3bdcc;
    background: rgba(255,255,255,.02);
}
.atlas-ai-finding:hover {
    border-color: rgba(87,221,255,.22);
}
.atlas-ai-finding strong {
    display: block;
    font-size: 9px;
}
.atlas-ai-finding span {
    display: block;
    margin-top: 3px;
    color: #667286;
    font-size: 8px;
}
.atlas-ai-severity-critical strong {
    color: #ff6b81;
}
.atlas-ai-severity-high strong {
    color: #ff9171;
}
.atlas-ai-severity-medium strong {
    color: #f4bd63;
}
.atlas-ai-footnote {
    margin-top: 11px;
    color: #566174;
    font-size: 8px;
    line-height: 1.5;
}
.atlas-ai-context {
    margin: 0 0 10px;
    padding: 9px 10px;
    border: 1px solid rgba(87,221,255,.14);
    border-radius: 9px;
    background: rgba(87,221,255,.045);
}
.atlas-ai-context[hidden] {
    display: none;
}
.atlas-ai-context span {
    display: block;
    color: #5f6c7f;
    font-size: 8px;
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
}
.atlas-ai-context strong {
    display: block;
    margin-top: 4px;
    overflow: hidden;
    color: #dff8ff;
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.atlas-ai-model-row {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
}
.atlas-ai-model-row label {
    color: #596579;
    font-size: 8px;
    font-weight: 850;
    letter-spacing: .12em;
    text-transform: uppercase;
}
#atlasAiModel {
    width: 100%;
    min-width: 0;
    height: 30px;
    padding: 0 8px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 8px;
    outline: none;
    color: #cbd5e2;
    font: inherit;
    font-size: 9px;
    background: rgba(255,255,255,.035);
}
#atlasAiModel:focus {
    border-color: rgba(87,221,255,.38);
    box-shadow: 0 0 0 3px rgba(87,221,255,.05);
}
.atlas-ai-finding-head {
    display: flex;
    align-items: center;
    gap: 7px;
}
.atlas-ai-finding-head strong {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.atlas-ai-severity {
    flex: 0 0 auto;
    padding: 2px 5px;
    border: 1px solid currentColor;
    border-radius: 999px;
    opacity: .82;
    font-size: 7px;
    font-weight: 850;
    letter-spacing: .08em;
}
.atlas-ai-signal-summary {
    display: block;
    margin-top: 4px;
    color: #647084;
    font-size: 8px;
}
.atlas-ai-signal-list {
    display: block;
    margin-top: 5px;
    color: #8d98a9;
    font-size: 8px;
    line-height: 1.45;
}
@media (max-width: 1150px) {
    .atlas-ai-toggle,
    .atlas-ai-drawer {
        right: 14px;
    }
}
@media (prefers-reduced-motion: reduce) {
    .atlas-ai-toggle-dot {
        box-shadow: none;
    }
}
</style>
"""


INTELLIGENCE_HTML = r"""
<button
    id="atlasAiToggle"
    class="atlas-ai-toggle"
    type="button"
    aria-expanded="false"
    aria-controls="atlasAiDrawer"
>
    <span class="atlas-ai-toggle-dot"></span>
    Ask Atlas
</button>

<section
    id="atlasAiDrawer"
    class="atlas-ai-drawer"
    aria-label="Atlas Intelligence"
    hidden
>
    <div class="atlas-ai-head">
        <div class="atlas-ai-head-copy">
            <div class="atlas-ai-eyebrow">
                Atlas Intelligence
            </div>
            <div class="atlas-ai-title">
                Evidence-bounded architecture analyst
            </div>
        </div>
        <button
            id="atlasAiClose"
            class="atlas-ai-close"
            type="button"
            aria-label="Close Atlas Intelligence"
        >
            ×
        </button>
    </div>

    <div class="atlas-ai-body">
        <div
            id="atlasAiProviders"
            class="atlas-ai-provider-row"
        >
            <span class="atlas-ai-provider">
                Checking providers…
            </span>
        </div>

        <div
            id="atlasAiContext"
            class="atlas-ai-context"
            hidden
        >
            <span>Selected node</span>
            <strong id="atlasAiContextPath"></strong>
        </div>

        <div class="atlas-ai-model-row">
            <label for="atlasAiModel">
                Model
            </label>
            <select
                id="atlasAiModel"
                aria-label="Ollama model"
            >
                <option value="">
                    Auto-detect
                </option>
            </select>
        </div>

        <div class="atlas-ai-quick">
            <button
                class="atlas-ai-chip"
                type="button"
                data-atlas-question="What are the most important architectural gaps right now?"
            >
                Find gaps
            </button>
            <button
                class="atlas-ai-chip"
                type="button"
                data-atlas-question="Which changed production files have the greatest blast radius, and why?"
            >
                Change risk
            </button>
            <button
                class="atlas-ai-chip"
                type="button"
                data-atlas-question="Which production boundaries have the weakest deterministic test evidence?"
            >
                Test gaps
            </button>
            <button
                class="atlas-ai-chip"
                type="button"
                data-atlas-question="What would you refactor first based only on Atlas evidence?"
            >
                Refactor
            </button>
        </div>

        <textarea
            id="atlasAiQuestion"
            placeholder="Ask about architecture, changes, coupling, risk, test gaps…"
            aria-label="Ask Atlas a question"
        ></textarea>

        <div class="atlas-ai-actions">
            <button
                id="atlasAiAsk"
                class="atlas-ai-action primary"
                type="button"
            >
                Ask local Ollama
            </button>
            <button
                id="atlasAiGoose"
                class="atlas-ai-action"
                type="button"
            >
                Goose brief
            </button>
        </div>

        <div
            id="atlasAiAnswer"
            class="atlas-ai-answer"
            hidden
        >
            <div class="atlas-ai-label">
                Analysis
            </div>
            <div
                id="atlasAiAnswerBox"
                class="atlas-ai-answer-box"
            ></div>
        </div>

        <div class="atlas-ai-findings">
            <div class="atlas-ai-label">
                Deterministic findings
            </div>
            <div id="atlasAiFindingList"></div>
        </div>

        <div class="atlas-ai-footnote">
            Atlas topology and risk are deterministic.
            Ollama interprets evidence; it does not define repository truth.
            Test signal combines direct static imports with deterministic
            path/name evidence for process and CLI tests. It is not executed
            line coverage.
        </div>
    </div>
</section>
"""


INTELLIGENCE_SCRIPT = r"""
<script id="atlas-intelligence-script">
(() => {
    "use strict";

    const toggle = document.getElementById("atlasAiToggle");
    const drawer = document.getElementById("atlasAiDrawer");
    const close = document.getElementById("atlasAiClose");
    const question = document.getElementById("atlasAiQuestion");
    const ask = document.getElementById("atlasAiAsk");
    const goose = document.getElementById("atlasAiGoose");
    const providers = document.getElementById("atlasAiProviders");
    const answer = document.getElementById("atlasAiAnswer");
    const answerBox = document.getElementById("atlasAiAnswerBox");
    const findingList = document.getElementById("atlasAiFindingList");
    const modelSelect = document.getElementById("atlasAiModel");
    const contextBox = document.getElementById("atlasAiContext");
    const contextPath = document.getElementById("atlasAiContextPath");

    let summaryCache = null;
    let activeNodeOverride = null;

    function currentSelectedNode() {
        try {
            if (
                typeof state !== "undefined"
                && typeof state.selected === "string"
                && state.selected
            ) {
                return state.selected;
            }
        } catch {
            // Existing Atlas state is optional integration context.
        }

        return null;
    }

    function requestNode() {
        return (
            activeNodeOverride
            || currentSelectedNode()
            || null
        );
    }

    function updateNodeContext() {
        const node = requestNode();

        contextBox.hidden = !node;
        contextPath.textContent = node || "";
    }

    function setOpen(value) {
        drawer.hidden = !value;
        toggle.setAttribute("aria-expanded", String(value));

        if (value) {
            updateNodeContext();
            question.focus();
        }
    }

    toggle.addEventListener(
        "click",
        () => setOpen(drawer.hidden)
    );

    close.addEventListener(
        "click",
        () => {
            activeNodeOverride = null;
            updateNodeContext();
            setOpen(false);
        }
    );

    document.addEventListener(
        "keydown",
        event => {
            if (
                event.key === "Escape"
                && !drawer.hidden
            ) {
                activeNodeOverride = null;
                updateNodeContext();
                setOpen(false);
            }
        }
    );

    document.addEventListener(
        "click",
        () => {
            window.setTimeout(
                () => {
                    if (!activeNodeOverride) {
                        updateNodeContext();
                    }
                },
                0
            );
        },
        true
    );

    function showAnswer(
        value,
        isError = false
    ) {
        answer.hidden = false;
        answerBox.classList.toggle(
            "error",
            isError
        );
        answerBox.textContent = value;
    }

    async function readJson(response) {
        const payload = await response.json();

        if (!response.ok) {
            const message =
                payload?.error?.message
                || payload?.message
                || `HTTP ${response.status}`;

            throw new Error(message);
        }

        return payload;
    }

    function chosenModel() {
        return modelSelect.value || null;
    }

    function savedModel() {
        try {
            return localStorage.getItem(
                "atlas-ai-model"
            );
        } catch {
            return null;
        }
    }

    function saveModel(value) {
        try {
            if (value) {
                localStorage.setItem(
                    "atlas-ai-model",
                    value
                );
            } else {
                localStorage.removeItem(
                    "atlas-ai-model"
                );
            }
        } catch {
            // Storage is a convenience, not a requirement.
        }
    }

    async function askAtlas(
        nodeOverride = null
    ) {
        const value = question.value.trim();

        if (!value) {
            question.focus();
            return;
        }

        activeNodeOverride =
            nodeOverride || null;
        updateNodeContext();

        ask.disabled = true;
        goose.disabled = true;
        modelSelect.disabled = true;

        const selectedNode = requestNode();

        showAnswer(
            selectedNode
            ? (
                "Analyzing Atlas evidence for "
                + `${selectedNode} with local Ollama…`
            )
            : "Analyzing deterministic Atlas evidence with local Ollama…"
        );

        try {
            const response = await fetch(
                "/api/atlas/ask",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                    },
                    body: JSON.stringify({
                        question: value,
                        node: selectedNode,
                        model: chosenModel(),
                    }),
                }
            );

            const payload = await readJson(response);

            showAnswer(
                `${payload.answer}\n\n`
                + `Model: ${payload.model}`
                + (
                    selectedNode
                    ? `\nNode: ${selectedNode}`
                    : ""
                )
            );

        } catch (error) {
            showAnswer(
                String(error?.message || error),
                true
            );

        } finally {
            ask.disabled = false;
            goose.disabled = false;
            modelSelect.disabled = false;
        }
    }

    async function createGooseBrief(
        nodeOverride = null
    ) {
        const value =
            question.value.trim()
            || (
                "Investigate the highest-priority Atlas architecture "
                + "findings and identify the most actionable engineering gap."
            );

        activeNodeOverride =
            nodeOverride || null;
        updateNodeContext();

        ask.disabled = true;
        goose.disabled = true;
        modelSelect.disabled = true;

        try {
            const response = await fetch(
                "/api/atlas/goose",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                    },
                    body: JSON.stringify({
                        question: value,
                        node: requestNode(),
                    }),
                }
            );

            const payload = await readJson(response);

            let copied = false;

            try {
                await navigator.clipboard.writeText(
                    payload.prompt
                );
                copied = true;
            } catch {
                copied = false;
            }

            const gooseState =
                payload.goose?.available
                ? (
                    payload.goose.version
                    || "Goose CLI detected"
                )
                : "Goose CLI not detected on PATH";

            showAnswer(
                `Investigation brief created:\n`
                + `${payload.briefPath}\n\n`
                + `${gooseState}\n\n`
                + (
                    copied
                    ? "The investigation prompt was copied to the clipboard."
                    : "The brief contains the complete investigation prompt."
                )
            );

        } catch (error) {
            showAnswer(
                String(error?.message || error),
                true
            );

        } finally {
            ask.disabled = false;
            goose.disabled = false;
            modelSelect.disabled = false;
        }
    }

    ask.addEventListener(
        "click",
        () => askAtlas()
    );

    goose.addEventListener(
        "click",
        () => createGooseBrief()
    );

    modelSelect.addEventListener(
        "change",
        () => {
            saveModel(
                modelSelect.value
            );
        }
    );

    question.addEventListener(
        "keydown",
        event => {
            if (
                event.key === "Enter"
                && (
                    event.ctrlKey
                    || event.metaKey
                )
            ) {
                event.preventDefault();
                askAtlas();
            }
        }
    );

    for (
        const button
        of document.querySelectorAll(
            "[data-atlas-question]"
        )
    ) {
        button.addEventListener(
            "click",
            () => {
                activeNodeOverride = null;
                updateNodeContext();

                question.value =
                    button.dataset.atlasQuestion
                    || "";

                askAtlas();
            }
        );
    }

    function populateModels(summary) {
        const ollama =
            summary.providers?.ollama;

        const models = Array.isArray(
            ollama?.models
        )
            ? ollama.models
            : [];

        const preferred =
            savedModel()
            || ollama?.defaultModel
            || "";

        modelSelect.replaceChildren();

        const automatic =
            document.createElement("option");

        automatic.value = "";
        automatic.textContent =
            "Auto-detect";

        modelSelect.appendChild(
            automatic
        );

        for (const model of models) {
            const option =
                document.createElement("option");

            option.value = model;
            option.textContent = model;

            modelSelect.appendChild(
                option
            );
        }

        if (
            preferred
            && models.includes(preferred)
        ) {
            modelSelect.value = preferred;
        }

        modelSelect.disabled =
            !ollama?.available;
    }

    function renderProviders(summary) {
        providers.replaceChildren();

        const ollama =
            document.createElement("span");

        ollama.className =
            "atlas-ai-provider "
            + (
                summary.providers?.ollama?.available
                ? "ok"
                : "warn"
            );

        const model =
            summary.providers?.ollama?.defaultModel;

        ollama.textContent =
            summary.providers?.ollama?.available
            ? `● Ollama · ${model || "ready"}`
            : "○ Ollama unavailable";

        providers.appendChild(ollama);

        const gooseBadge =
            document.createElement("span");

        gooseBadge.className =
            "atlas-ai-provider "
            + (
                summary.providers?.goose?.available
                ? "ok"
                : ""
            );

        gooseBadge.textContent =
            summary.providers?.goose?.available
            ? "● Goose detected"
            : "○ Goose optional";

        providers.appendChild(gooseBadge);

        populateModels(summary);
    }

    function renderFindings(groups) {
        findingList.replaceChildren();

        for (const item of groups.slice(0, 9)) {
            const button =
                document.createElement("button");

            button.type = "button";

            button.className =
                "atlas-ai-finding "
                + `atlas-ai-severity-${item.severity}`;

            const head =
                document.createElement("span");

            head.className =
                "atlas-ai-finding-head";

            const title =
                document.createElement("strong");

            title.textContent = item.node;

            const severity =
                document.createElement("span");

            severity.className =
                "atlas-ai-severity";

            severity.textContent =
                String(
                    item.severity || "info"
                ).toUpperCase();

            head.append(
                title,
                severity
            );

            const summary =
                document.createElement("span");

            summary.className =
                "atlas-ai-signal-summary";

            summary.textContent =
                item.summary || "";

            const signals =
                document.createElement("span");

            signals.className =
                "atlas-ai-signal-list";

            signals.textContent = (
                item.signals || []
            )
                .slice(0, 3)
                .map(signal => signal.title)
                .join(" • ");

            button.append(
                head,
                summary,
                signals
            );

            button.addEventListener(
                "click",
                () => {
                    activeNodeOverride =
                        item.node;

                    updateNodeContext();
                    setOpen(true);

                    const signalText = (
                        item.signals || []
                    )
                        .map(
                            signal =>
                                `- ${signal.title}: ${signal.summary}`
                        )
                        .join("\n");

                    question.value =
                        "Interpret these deterministic Atlas signals. "
                        + "Separate architecture facts from interpretation, "
                        + "explain what is expected versus concerning, and "
                        + "tell me what to verify next.\n\n"
                        + `Node: ${item.node}\n`
                        + `${signalText}`;

                    askAtlas(
                        item.node
                    );
                }
            );

            findingList.appendChild(
                button
            );
        }
    }

    async function loadSummary() {
        try {
            const response = await fetch(
                "/api/atlas/summary"
            );

            const summary =
                await readJson(response);

            summaryCache = summary;

            renderProviders(summary);
            renderFindings(
                summary.findingGroups
                || summary.findings
                || []
            );

            updateNodeContext();

        } catch (error) {
            providers.innerHTML =
                '<span class="atlas-ai-provider warn">'
                + 'Atlas Intelligence API unavailable'
                + '</span>';

            showAnswer(
                String(error?.message || error),
                true
            );
        }
    }

    void summaryCache;
    loadSummary();
})();
</script>
"""


def instrument_html(html: str) -> str:
    if "atlas-intelligence-script" in html:
        return html

    if "</head>" not in html or "</body>" not in html:
        raise AtlasError(
            "System Atlas HTML does not contain normal head/body closing tags.",
            status=HTTPStatus.INTERNAL_SERVER_ERROR,
            code="atlas_html_invalid",
        )

    html = html.replace(
        "</head>",
        INTELLIGENCE_STYLE
        + "\n</head>",
        1,
    )

    html = html.replace(
        "</body>",
        INTELLIGENCE_HTML
        + "\n"
        + INTELLIGENCE_SCRIPT
        + "\n</body>",
        1,
    )

    return html


def snapshot_git_dir(repo: str, mirrors: Path = MIRRORS) -> Path | None:
    """Where a snapshot's commit can be read: the repository's fetch-only mirror, or for Local AI its own .git."""
    for candidate in (mirrors / f"{repo}.git", ROOT / ".git" if repo == "localai" else None):
        if candidate is not None and candidate.is_dir():
            return candidate
    return None


def export_tree(git_dir: Path, commit: str, target: Path) -> None:
    """A clean copy of one commit: git archive, unpacked with tarfile's "data" filter, which refuses absolute paths,
    links out of the folder and special files. Unpacked beside the target and renamed, so a half copy is never used."""
    result = subprocess.run(
        ["git", f"--git-dir={git_dir}", "archive", "--format=tar", commit],
        check=False, capture_output=True, timeout=300, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", "replace").strip()[:240] or "git archive failed")
    partial = target.with_name(target.name + ".partial")
    shutil.rmtree(partial, ignore_errors=True)
    partial.mkdir(parents=True)
    try:
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as tar:
            tar.extractall(partial, filter="data")
        (partial / TREE_DONE).write_text(commit, encoding="utf-8")
        partial.rename(target)
    finally:
        shutil.rmtree(partial, ignore_errors=True)


class SnapshotTrees:
    """Clean copies of snapshot commits, made on first use and kept for the newest KEEP_TREES used."""

    def __init__(self, trees: Path = TREES, mirrors: Path = MIRRORS, keep: int = KEEP_TREES) -> None:
        self.trees = Path(trees)
        self.mirrors = Path(mirrors)
        self.keep = keep
        self._lock = threading.Lock()

    def get(self, repo: str, commit: str) -> tuple[Path | None, str | None]:
        """The copy's folder, or None and the reason there is none. Never raises for a missing source."""
        with self._lock:
            target = self.trees / repo / commit
            if not (target / TREE_DONE).is_file():
                git_dir = snapshot_git_dir(repo, self.mirrors)
                if git_dir is None:
                    return None, f"there is no mirror of {repo} on this PC"
                shutil.rmtree(target, ignore_errors=True)
                try:
                    export_tree(git_dir, commit, target)
                except (OSError, RuntimeError, subprocess.SubprocessError, tarfile.TarError) as error:
                    return None, f"the commit could not be copied: {str(error)[:200]}"
            os.utime(target / TREE_DONE)
            self._prune()
            return target, None

    def _prune(self) -> None:
        done = sorted(self.trees.glob(f"*/*/{TREE_DONE}"), key=lambda m: m.stat().st_mtime, reverse=True)
        for marker in done[self.keep:]:
            shutil.rmtree(marker.parent, ignore_errors=True)


class AtlasState:
    def __init__(
        self,
        html_path: Path,
        snapshots: Path = SNAPSHOTS,
        trees: SnapshotTrees | None = None,
    ) -> None:
        self.html_path = html_path
        self.snapshots = Path(snapshots)
        self.trees = trees if trees is not None else SnapshotTrees()
        self._lock = threading.Lock()
        self._scoped: dict[tuple[str, str], tuple[tuple[int, int, str], dict[str, Any], list[dict[str, Any]]]] = {}

    def for_snapshot(
        self,
        repo: Any,
        commit: Any,
    ) -> tuple[dict[str, Any], list[dict[str, Any]], Path | None, dict[str, Any]]:
        """One snapshot's graph and findings, read from its own graph.json and a clean copy of its commit.

        Only a well-formed repository name and a full commit reach the file system; the app has already matched
        both against its snapshot list."""
        repo = str(repo or "").strip().lower()
        commit = str(commit or "").strip().lower()
        if not SNAPSHOT_REPO.match(repo) or not FULL_COMMIT.match(commit):
            raise AtlasError("A snapshot is a repository name and a full 40-character commit.",
                             code="atlas_snapshot_query")
        graph_file = self.snapshots / repo / commit / "graph.json"
        try:
            stat = graph_file.stat()
        except OSError:
            raise AtlasError(f"There is no snapshot of {repo} at {commit[:7]}.", status=HTTPStatus.NOT_FOUND,
                             code="atlas_snapshot_missing") from None
        root, reason = self.trees.get(repo, commit)
        key = (stat.st_mtime_ns, stat.st_size, str(root))
        with self._lock:
            hit = self._scoped.get((repo, commit))
            if hit is None or hit[0] != key:
                try:
                    graph = json.loads(graph_file.read_text(encoding="utf-8"))
                except (OSError, ValueError) as error:
                    raise AtlasError(f"That snapshot could not be read: {error}",
                                     status=HTTPStatus.INTERNAL_SERVER_ERROR, code="atlas_snapshot_invalid") from error
                if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list) \
                        or not isinstance(graph.get("edges"), list):
                    raise AtlasError("The snapshot graph is missing nodes or edges.",
                                     status=HTTPStatus.INTERNAL_SERVER_ERROR, code="atlas_snapshot_invalid")
                hit = (key, graph, build_findings(graph, root))
                self._scoped[(repo, commit)] = hit
                while len(self._scoped) > KEEP_TREES:
                    self._scoped.pop(next(iter(self._scoped)))
        scope = {"repo": repo, "commit": commit, "source": "available" if root is not None else "unavailable"}
        if reason:
            scope["reason"] = reason
        return hit[1], hit[2], root, scope

    def snapshot(
        self,
    ) -> tuple[
        str,
        dict[str, Any],
        list[dict[str, Any]],
    ]:
        with self._lock:
            html = load_atlas_html(
                self.html_path
            )

            graph = extract_graph(html)
            findings = build_findings(
                graph
            )

            return (
                html,
                graph,
                findings,
            )


class AtlasHandler(
    BaseHTTPRequestHandler
):
    server_version = (
        "LocalAI-SystemAtlas/1.0"
    )

    def log_message(
        self,
        format: str,
        *args: Any,
    ) -> None:
        sys.stderr.write(
            "[atlas] "
            + format % args
            + "\n"
        )

    @property
    def atlas_state(
        self,
    ) -> AtlasState:
        server = self.server

        state = getattr(
            server,
            "atlas_state",
            None,
        )

        if not isinstance(
            state,
            AtlasState,
        ):
            raise RuntimeError(
                "Atlas server state is missing."
            )

        return state

    def send_json(
        self,
        payload: dict[str, Any],
        *,
        status: int = HTTPStatus.OK,
    ) -> None:
        body = json.dumps(
            payload,
            ensure_ascii=False,
        ).encode("utf-8")

        self.send_response(status)

        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8",
        )

        self.send_header(
            "Content-Length",
            str(len(body)),
        )

        self.send_header(
            "Cache-Control",
            "no-store",
        )

        self.send_header(
            "X-Content-Type-Options",
            "nosniff",
        )

        self.end_headers()
        self.wfile.write(body)

    def send_html(
        self,
        html: str,
    ) -> None:
        body = html.encode("utf-8")

        self.send_response(
            HTTPStatus.OK
        )

        self.send_header(
            "Content-Type",
            "text/html; charset=utf-8",
        )

        self.send_header(
            "Content-Length",
            str(len(body)),
        )

        self.send_header(
            "Cache-Control",
            "no-store",
        )

        self.send_header(
            "X-Content-Type-Options",
            "nosniff",
        )

        self.send_header(
            "Referrer-Policy",
            "no-referrer",
        )

        self.end_headers()
        self.wfile.write(body)

    def read_json_body(
        self,
    ) -> dict[str, Any]:
        raw_length = self.headers.get(
            "Content-Length",
            "",
        )

        try:
            length = int(
                raw_length or "0"
            )
        except ValueError as error:
            raise AtlasError(
                "Invalid Content-Length.",
                code="invalid_request",
            ) from error

        if length <= 0:
            return {}

        if length > MAX_BODY_BYTES:
            raise AtlasError(
                "Request body is too large.",
                status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                code="request_too_large",
            )

        raw = self.rfile.read(length)

        try:
            payload = json.loads(
                raw.decode("utf-8")
            )
        except (
            UnicodeDecodeError,
            json.JSONDecodeError,
        ) as error:
            raise AtlasError(
                "Request body must contain valid UTF-8 JSON.",
                code="invalid_json",
            ) from error

        if not isinstance(
            payload,
            dict,
        ):
            raise AtlasError(
                "Request JSON must be an object.",
                code="invalid_json",
            )

        return payload

    def handle_error(
        self,
        error: Exception,
    ) -> None:
        if isinstance(
            error,
            AtlasError,
        ):
            self.send_json(
                {
                    "error": {
                        "code": error.code,
                        "message": str(error),
                    }
                },
                status=error.status,
            )
            return

        self.send_json(
            {
                "error": {
                    "code": "internal_error",
                    "message": (
                        f"{type(error).__name__}: "
                        f"{error}"
                    ),
                }
            },
            status=HTTPStatus.INTERNAL_SERVER_ERROR,
        )

    def check_caller(self, post: bool) -> None:
        """Refuse what a browser page elsewhere could send: an unknown Host (DNS rebinding), a foreign Origin, a POST
        that isn't JSON (a CORS 'simple' request), or a POST without the proxy's token when one is configured."""
        host = host_name(self.headers.get("Host", ""))
        if host not in ALLOWED_HOSTS:
            raise AtlasError("Unknown Host.", status=HTTPStatus.FORBIDDEN, code="forbidden_host")
        origin = self.headers.get("Origin")
        if origin is not None and host_name(urlparse(origin).netloc) != host:
            raise AtlasError("Cross-origin request refused.", status=HTTPStatus.FORBIDDEN, code="forbidden_origin")
        if post:
            kind = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if kind != "application/json":
                raise AtlasError("POST must be application/json.", status=HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                                 code="unsupported_media_type")
            if ATLAS_TOKEN and not hmac.compare_digest(self.headers.get("X-Atlas-Token", ""), ATLAS_TOKEN):
                raise AtlasError("Missing or wrong Atlas token.", status=HTTPStatus.UNAUTHORIZED, code="unauthorized")

    def scoped(
        self,
        query: dict[str, list[Any]],
    ) -> tuple[dict[str, Any], list[dict[str, Any]], Path | None, dict[str, Any] | None]:
        """The chosen snapshot (repo and commit), or with neither the latest scan of the deploy checkout."""
        repo = (query.get("repo") or [""])[0]
        commit = (query.get("commit") or [""])[0]
        if repo or commit:
            if not (repo and commit):
                raise AtlasError("Give both repo and commit, or neither.", code="atlas_snapshot_query")
            # A snapshot's first question writes a clean copy of its commit, so even a GET needs the app's token.
            if ATLAS_TOKEN and not hmac.compare_digest(self.headers.get("X-Atlas-Token", ""), ATLAS_TOKEN):
                raise AtlasError("Missing or wrong Atlas token.", status=HTTPStatus.UNAUTHORIZED, code="unauthorized")
            return self.atlas_state.for_snapshot(repo, commit)
        _, graph, findings = self.atlas_state.snapshot()
        return graph, findings, ROOT, None

    def do_GET(self) -> None:
        try:
            self.check_caller(post=False)
            self._do_get()
        except Exception as error:
            self.handle_error(error)

    def _do_get(self) -> None:
        parsed = urlparse(
            self.path
        )

        path = parsed.path

        if path in {
            "/",
            "/system-atlas.html",
        }:
            html, _, _ = (
                self.atlas_state.snapshot()
            )

            self.send_html(
                instrument_html(html)
            )
            return

        # "Snapshot now" (plan PR 4): what is running, waiting and recently finished. Needs no graph.
        if path == "/api/atlas/snapshot":
            self.send_json(self.server.snapshot_runner.status())
            return

        if path == "/health":
            self.send_json(
                {
                    "ok": True,
                    "service": (
                        "atlas-intelligence"
                    ),
                    "version": (
                        ATLAS_INTELLIGENCE_VERSION
                    ),
                }
            )
            return

        graph, findings, root, scope = self.scoped(parse_qs(parsed.query))

        if path == "/api/atlas/summary":
            self.send_json(
                {
                    **({"snapshot": scope} if scope else {}),
                    "stats": graph.get(
                        "stats",
                        {},
                    ),
                    "findings": findings[:20],
                    "findingGroups": aggregate_findings(
                        graph,
                        findings,
                        root,
                    )[:20],
                    "providers": {
                        "ollama": ollama_status(),
                        "goose": goose_status(),
                    },
                }
            )
            return

        if path == "/api/atlas/findings":
            self.send_json(
                {
                    **({"snapshot": scope} if scope else {}),
                    "count": len(
                        findings
                    ),
                    "findings": findings,
                    "groups": aggregate_findings(
                        graph,
                        findings,
                        root,
                    ),
                }
            )
            return

        if path == "/api/atlas/node":
            query = parse_qs(
                parsed.query
            )

            node_id = (
                query.get(
                    "path",
                    [""],
                )[0]
            ).strip()

            if not node_id:
                raise AtlasError(
                    "Missing node path.",
                    code="node_path_required",
                )

            details = get_node_details(
                graph,
                findings,
                node_id,
                root,
            )

            if details is None:
                raise AtlasError(
                    f"Atlas node not found: {node_id}",
                    status=HTTPStatus.NOT_FOUND,
                    code="node_not_found",
                )

            self.send_json({**details, "snapshot": scope} if scope else details)
            return

        raise AtlasError(
            f"Route not found: {path}",
            status=HTTPStatus.NOT_FOUND,
            code="not_found",
        )

    def do_POST(self) -> None:
        try:
            self.check_caller(post=True)
            self._do_post()
        except Exception as error:
            self.handle_error(error)

    def _do_post(self) -> None:
        parsed = urlparse(
            self.path
        )

        body = self.read_json_body()

        if parsed.path == "/api/atlas/snapshot":
            try:
                job = self.server.snapshot_runner.request(body.get("repo"), body.get("ref") or "main")
            except SnapshotRequestError as error:
                raise AtlasError(str(error), status=error.status, code=error.code) from error
            self.send_json({"job": job}, status=HTTPStatus.ACCEPTED)
            return

        if parsed.path not in {"/api/atlas/ask", "/api/atlas/goose"}:
            raise AtlasError(
                f"Route not found: {parsed.path}",
                status=HTTPStatus.NOT_FOUND,
                code="not_found",
            )

        # The question is checked first: loading a snapshot can write a clean copy of its commit.
        question = str(
            body.get(
                "question",
                "",
            )
        ).strip()

        if not question:
            raise AtlasError(
                "A non-empty question is required.",
                code="question_required",
            )

        if len(question) > MAX_QUESTION_CHARS:
            raise AtlasError(
                (
                    "Question exceeds "
                    f"{MAX_QUESTION_CHARS} characters."
                ),
                code="question_too_long",
            )

        graph, findings, root, scope = self.scoped(
            {key: [body.get(key)] for key in ("repo", "commit") if body.get(key)}
        )

        selected_node_raw = body.get(
            "node"
        )

        selected_node = (
            str(selected_node_raw).strip()
            if selected_node_raw
            else None
        )

        if parsed.path == "/api/atlas/ask":
            requested_model_raw = body.get(
                "model"
            )

            requested_model = (
                str(
                    requested_model_raw
                ).strip()
                if requested_model_raw
                else None
            )

            result = ask_ollama(
                graph=graph,
                findings=findings,
                question=question,
                selected_node=selected_node,
                requested_model=requested_model,
                root=root,
                scope=scope,
            )

            self.send_json({**result, "snapshot": scope} if scope else result)
            return

        if parsed.path == "/api/atlas/goose":
            result = build_goose_brief(
                graph=graph,
                findings=findings,
                question=question,
                selected_node=selected_node,
                root=root,
                scope=scope,
            )

            self.send_json({**result, "snapshot": scope} if scope else result)
            return

        raise AtlasError(
            (
                "Route not found: "
                f"{parsed.path}"
            ),
            status=HTTPStatus.NOT_FOUND,
            code="not_found",
        )


class AtlasHTTPServer(
    ThreadingHTTPServer
):
    daemon_threads = True
    allow_reuse_address = True


def self_test() -> None:
    html = load_atlas_html()
    graph = extract_graph(html)

    assert graph["nodes"], (
        "Atlas has no nodes."
    )

    assert graph["edges"], (
        "Atlas has no edges."
    )

    findings = build_findings(
        graph
    )

    assert findings, (
        "Gap detector produced no findings."
    )

    groups = aggregate_findings(
        graph,
        findings,
    )

    assert groups, (
        "Finding aggregation produced no groups."
    )

    server_group = next(
        (
            group
            for group in groups
            if group.get("node")
            == "app/server.js"
        ),
        None,
    )

    assert server_group is not None
    assert (
        int(
            server_group.get(
                "signalCount",
                0,
            )
        )
        >= 2
    )

    indexed = node_index(
        graph
    )

    assert "app/server.js" in indexed, (
        "Expected app/server.js in Atlas."
    )

    server_details = get_node_details(
        graph,
        findings,
        "app/server.js",
    )

    assert server_details is not None
    assert (
        server_details["node"][
            "outbound"
        ]
        >= 1
    )

    page = instrument_html(html)

    assert (
        "atlas-intelligence-script"
        in page
    )

    assert "Ask Atlas" in page
    assert "atlasAiModel" in page
    assert "atlasAiContext" in page
    assert "findingGroups" in page

    print(
        "PASS: System Atlas graph parsed"
    )

    print(
        "PASS: deterministic findings generated "
        f"({len(findings)})"
    )

    print(
        "PASS: findings aggregated by module "
        f"({len(groups)} groups)"
    )

    print(
        "PASS: app/server.js graph evidence available"
    )

    print(
        "PASS: node-aware model-selector UI injected"
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Serve Local AI System Atlas "
            "with deterministic findings and "
            "local Ollama intelligence."
        )
    )

    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
    )

    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
    )

    parser.add_argument(
        "--no-browser",
        action="store_true",
    )

    parser.add_argument(
        "--self-test",
        action="store_true",
    )

    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0

    if not ATLAS_HTML.is_file():
        print(
            f"ERROR: {ATLAS_HTML} does not exist.",
            file=sys.stderr,
        )

        print(
            "Run quick_arch.py first to regenerate "
            "system-atlas.html.",
            file=sys.stderr,
        )

        return 2

    state = AtlasState(
        ATLAS_HTML
    )

    server = AtlasHTTPServer(
        (
            args.host,
            args.port,
        ),
        AtlasHandler,
    )

    server.atlas_state = state
    server.snapshot_runner = SnapshotRunner()

    url = (
        f"http://{args.host}:"
        f"{args.port}/"
    )

    print()
    print(
        "LOCAL AI · ATLAS INTELLIGENCE "
        f"v{ATLAS_INTELLIGENCE_VERSION}"
    )
    print(
        "=" * 35
    )

    print(
        f"Atlas  : {ATLAS_HTML}"
    )

    print(
        f"URL    : {url}"
    )

    print(
        f"Ollama : {DEFAULT_OLLAMA_URL}"
    )

    if DEFAULT_OLLAMA_MODEL:
        print(
            "Model  : "
            f"{DEFAULT_OLLAMA_MODEL}"
        )
    else:
        print(
            "Model  : auto-detect"
        )

    goose = goose_status()

    print(
        "Goose  : "
        + (
            goose.get("version")
            or (
                "detected"
                if goose["available"]
                else "optional / not on PATH"
            )
        )
    )

    if args.host not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        print()
        print(
            "WARNING: Atlas Intelligence is "
            "bound beyond loopback."
        )

    print()
    print(
        "Press Ctrl+C to stop."
    )
    print()

    if not args.no_browser:
        threading.Timer(
            0.35,
            lambda: webbrowser.open(url),
        ).start()

    try:
        server.serve_forever(
            poll_interval=0.25
        )

    except KeyboardInterrupt:
        print()
        print(
            "Stopping Atlas Intelligence."
        )

    finally:
        server.shutdown()
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
