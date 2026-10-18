"""Make sure a spreadsheet answer states the values the request read.

The small local model sometimes ends a read-only request with "I have verified that the request was fully addressed"
and never says the number it found. gridcraft_ai.py records what each read tool returned (Reads) and, before it hands
the answer over, runs check_answer: an answer without any of those values gets one more model turn without tools,
and if that still has none, the values are appended so the owner always sees them.

Stdlib only, no MCP or OpenAI import, so tests drive it directly.
"""
from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable

# Tools whose results are workbook values the user asked about. inspect_workbook is metadata (paths, undo labels).
VALUE_TOOLS = frozenset({"read_range", "get_cell", "evaluate_formula"})
# Keys in a tool result that say where a value is, not what it is.
SKIP_KEYS = frozenset({"range", "sheet", "address", "cell", "ref", "type", "is_error", "formula", "formulas",
                       "formatted", "path", "file", "title"})
MAX_VALUES_PER_READ = 400
SUMMARY_VALUES_PER_READ = 12
SUMMARY_CHARS = 600

BOILERPLATE = re.compile(
    r"\b(verified|completed?|addressed|fulfilled|accomplished|has been (?:identified|handled|done|found|determined)"
    r"|request (?:is|was|has been) (?:complete|done|finished))\b",
    re.IGNORECASE,
)
# A number in prose, but not the row of a cell reference (D17) or part of a word.
NUMBER = re.compile(r"(?<![A-Za-z0-9_.$])-?\$?\d[\d,]*(?:\.\d+)?(?![A-Za-z0-9_])")
NUMERIC_TEXT = re.compile(r"^\s*[-+]?[$€£]?\s*\d[\d,]*(?:\.\d+)?\s*%?\s*$")

RETRY_PROMPT = ("Your answer must state the actual values you found. From these tool results: {summary}, answer the "
                "question in one or two sentences with the numbers.")


def fmt_number(v: float) -> str:
    if v == int(v) and abs(v) < 1e15:
        return str(int(v))
    return f"{v:.15g}"


def to_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and NUMERIC_TEXT.match(value):
        try:
            return float(re.sub(r"[^\d.\-]", "", value))
        except ValueError:
            return None
    return None


def _leaves(data: Any, out: list[Any], key: str | None = None) -> None:
    if len(out) >= MAX_VALUES_PER_READ or key in SKIP_KEYS:
        return
    if isinstance(data, dict):
        for k, v in data.items():
            _leaves(v, out, str(k))
    elif isinstance(data, list):
        for v in data:
            _leaves(v, out, key)
    elif isinstance(data, bool) or data is None:
        return
    elif isinstance(data, (int, float)):
        out.append(data)
    elif isinstance(data, str):
        text = data.strip()
        # Formula text is how a value was made, not the value.
        if text and not text.startswith("="):
            out.append(text)


def extract_values(tool_name: str, result_text: str) -> list[Any]:
    """The cell values or computed results in a read tool's result (the JSON gridcraft_ai.tool_result_to_text made)."""
    if tool_name not in VALUE_TOOLS:
        return []
    try:
        result = json.loads(result_text)
    except ValueError:
        return []
    if not isinstance(result, dict) or result.get("is_error"):
        return []
    values: list[Any] = []
    if result.get("structured_content") is not None:
        _leaves(result["structured_content"], values)
    if not values:
        for block in result.get("content") or []:
            text = block.get("text") if isinstance(block, dict) else None
            if not text:
                continue
            try:
                _leaves(json.loads(text), values)
            except ValueError:
                _leaves(text, values)
    return values[:MAX_VALUES_PER_READ]


def read_label(tool_name: str, args: dict[str, Any]) -> str:
    where = args.get("formula") or args.get("range") or args.get("cell") or args.get("ref") or ""
    sheet = args.get("sheet")
    if sheet and where and "!" not in str(where) and not str(where).startswith("="):
        where = f"{sheet}!{where}"
    return f"{tool_name} {where}".strip()


class Reads:
    """The values one request's read tools returned, and whether it changed the workbook."""

    def __init__(self) -> None:
        self.items: list[tuple[str, list[Any]]] = []
        self.wrote = False

    def add(self, tool_name: str, args: dict[str, Any], result_text: str) -> None:
        values = extract_values(tool_name, result_text)
        if values:
            self.items.append((read_label(tool_name, args if isinstance(args, dict) else {}), values))

    def values(self) -> list[Any]:
        return [v for _, vs in self.items for v in vs]

    def summary(self, max_chars: int = SUMMARY_CHARS) -> str:
        parts = []
        for label, values in self.items:
            shown = [fmt_number(v) if isinstance(v, (int, float)) else v for v in values[:SUMMARY_VALUES_PER_READ]]
            more = len(values) - len(shown)
            text = ", ".join(str(s) for s in shown) + (f" … ({more} more)" if more > 0 else "")
            parts.append(f"{label} → {text}")
        out = "; ".join(parts)
        return out if len(out) <= max_chars else out[:max_chars - 1].rstrip() + "…"


def numbers_in(text: str) -> list[tuple[float, int]]:
    """Each number written in `text`, with how many decimals it was written to."""
    found = []
    for m in NUMBER.finditer(text or ""):
        raw = m.group(0).replace(",", "").replace("$", "")
        try:
            found.append((float(raw), len(raw.split(".")[1]) if "." in raw else 0))
        except ValueError:
            pass
    return found


def _same(written: float, decimals: int, value: float) -> bool:
    # 48,250 for 48250.4, 3,400.5 for 3400.5: the value rounded to as many decimals as the answer wrote.
    return abs(written - value) <= 0.5 * 10 ** -decimals + 1e-9


def mentions_value(answer: str, values: list[Any], question: str = "") -> bool:
    """Whether the answer states one of the values read: a number (allowing rounding) or a text value that the
    question didn't already contain."""
    written = numbers_in(answer)
    lowered = (answer or "").lower()
    asked = (question or "").lower()
    for value in values:
        number = to_number(value)
        if number is not None:
            if any(_same(w, d, number) for w, d in written):
                return True
        elif isinstance(value, str) and len(value) >= 3 and value.lower() not in asked and value.lower() in lowered:
            return True
    return False


def answer_is_ok(answer: str, reads: Reads, question: str = "") -> bool:
    """False when the request read values but the answer states none of them. A number the model worked out itself
    (a sum of the cells it read) counts, unless the answer is "verified / addressed" boilerplate."""
    values = reads.values()
    if not values or reads.wrote:
        return True
    if mentions_value(answer, values, question):
        return True
    asked = {n for n, _ in numbers_in(question)}
    new_numbers = [n for n, _ in numbers_in(answer) if n not in asked]
    return bool(new_numbers) and not BOILERPLATE.search(answer or "")


async def check_answer(answer: str, question: str, reads: Reads,
                       ask: Callable[[str], Awaitable[str]]) -> str:
    """The answer to hand the owner. At most one extra model turn (`ask`, without tools)."""
    if answer_is_ok(answer, reads, question):
        return answer
    summary = reads.summary()
    print("[agent] answer states none of the values read; asking once more.", flush=True)
    try:
        second = (await ask(RETRY_PROMPT.format(summary=summary)) or "").strip()
    except Exception as exc:  # The values are appended below either way.
        print(f"[agent] answer retry failed: {type(exc).__name__}: {exc}", flush=True)
        second = ""
    if second and answer_is_ok(second, reads, question):
        return second
    base = second or (answer or "").strip()
    return (base + "\n\n" if base else "") + "Values read: " + summary
