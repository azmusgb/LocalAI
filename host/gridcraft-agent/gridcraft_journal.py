"""What a GridCraft request may do, and a record of what it did.

Shared by gridcraft_ai.py (the agent) and gridcraft_ops.py (workbook view, keep, discard). No MCP import here: the
client is passed in, so tests drive it with a fake.
"""
from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable

MODES = ("read", "review", "apply")
MODE_LABELS = {"read": "Read only", "review": "Review", "apply": "Apply"}

# Tools that never change the workbook. Read only mode gets exactly these (the ones GridCraft offers).
READ_TOOLS = frozenset({"inspect_workbook", "read_range", "get_cell", "evaluate_formula", "list_functions"})
# Also harmless, but not offered in Read only mode: list_commands only helps with execute_command, which can do anything.
NON_WRITE_TOOLS = READ_TOOLS | {"list_commands", "select", "screenshot"}
# Review mode leaves saving to the owner (Keep) and stays on the open workbook.
REVIEW_BLOCKED = frozenset({"save_workbook", "open_workbook", "new_workbook"})
# Tools that make one undo step when they succeed, even if the visible undo list can't show it.
ONE_STEP_TOOLS = frozenset({"set_cell", "write_range", "sort_range", "create_table", "insert_chart", "filter"})

MAX_JOURNAL_CELLS = 2000
UNDO_TOP = 5
WINDOW_ROWS = 100
WINDOW_COLS = 40


class ToolRefused(Exception):
    pass


def allowed_tools(mode: str, names: set[str]) -> set[str]:
    """The tools a request in `mode` may use, out of the profile `names` the agent would otherwise offer."""
    if mode == "read":
        return {n for n in names if n in READ_TOOLS}
    if mode == "review":
        return {n for n in names if n not in REVIEW_BLOCKED}
    return set(names)


def is_write(name: str) -> bool:
    return name not in NON_WRITE_TOOLS


# ---- A1 references ----

def col_to_num(col: str) -> int:
    n = 0
    for ch in col.upper():
        n = n * 26 + (ord(ch) - 64)
    return n


def num_to_col(n: int) -> str:
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


_CELL = re.compile(r"^\$?([A-Za-z]{1,3})\$?(\d+)$")


def split_sheet(ref: str) -> tuple[str | None, str]:
    """'Sheet 2'!B3 or Sales!B3 -> (sheet, 'B3'); B3 -> (None, 'B3')."""
    ref = (ref or "").strip()
    if "!" not in ref:
        return None, ref
    sheet, _, rest = ref.rpartition("!")
    if len(sheet) >= 2 and sheet[0] == sheet[-1] == "'":
        sheet = sheet[1:-1].replace("''", "'")
    return sheet or None, rest


def parse_cell(cell: str) -> tuple[int, int] | None:
    m = _CELL.match(cell.strip())
    return (int(m.group(2)), col_to_num(m.group(1))) if m else None


def parse_range(rng: str) -> tuple[int, int, int, int] | None:
    """'B2:D9' -> (row1, col1, row2, col2); a single cell is a 1x1 range."""
    parts = (rng or "").split(":")
    cells = [parse_cell(p) for p in parts]
    if not cells or None in cells or len(cells) > 2:
        return None
    (r1, c1), (r2, c2) = cells[0], cells[-1]
    return min(r1, r2), min(c1, c2), max(r1, r2), max(c1, c2)


def make_range(r1: int, c1: int, r2: int, c2: int) -> str:
    a, b = f"{num_to_col(c1)}{r1}", f"{num_to_col(c2)}{r2}"
    return a if a == b else f"{a}:{b}"


def write_target(name: str, args: dict[str, Any]) -> tuple[str | None, str] | None:
    """The cells a set_cell / write_range call will change, as (sheet, A1 range)."""
    if name == "set_cell":
        sheet, cell = split_sheet(str(args.get("cell", "")))
        return (sheet, cell) if parse_cell(cell) else None
    if name == "write_range":
        sheet, rng = split_sheet(str(args.get("range", "")))
        bounds = parse_range(rng)
        values = args.get("values")
        if not bounds or not isinstance(values, list) or not values:
            return None
        rows, cols = len(values), max((len(r) for r in values if isinstance(r, list)), default=1) or 1
        r1, c1 = bounds[0], bounds[1]
        return sheet, make_range(r1, c1, r1 + rows - 1, c1 + cols - 1)
    return None


def window_range(used: str | None, rows: int = WINDOW_ROWS, cols: int = WINDOW_COLS) -> tuple[str | None, bool]:
    """The part of a sheet the page shows first: from A1 to the used range's end, at most rows x cols."""
    bounds = parse_range(used or "")
    if not bounds:
        return None, False
    last_row, last_col = bounds[2], bounds[3]
    r2, c2 = min(last_row, rows), min(last_col, cols)
    return make_range(1, 1, r2, c2), (last_row > rows or last_col > cols)


def clamp_range(rng: str, rows: int = WINDOW_ROWS, cols: int = WINDOW_COLS) -> str | None:
    bounds = parse_range(rng)
    if not bounds:
        return None
    r1, c1, r2, c2 = bounds
    return make_range(r1, c1, min(r2, r1 + rows - 1), min(c2, c1 + cols - 1))


# ---- Undo history ----

def undo_delta(before: list[str], after: list[str]) -> int:
    """How many steps were added on top of `before` to give `after`. Both are newest-first and may be cut to the
    latest 20 labels, so this finds the smallest shift that lines the two lists up."""
    for n in range(len(after) + 1):
        tail = after[n:]
        if tail == before[:len(tail)]:
            return n
    return len(after)


def undo_top_matches(current: list[str], expected: list[str]) -> bool:
    return bool(expected) and current[:len(expected)] == list(expected)


# ---- Tool results ----

def payload(result: Any) -> Any:
    """The JSON a GridCraft tool returned in its first text block (None when it isn't JSON)."""
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        if text:
            try:
                return json.loads(text)
            except ValueError:
                return None
    return None


def is_error(result: Any) -> bool:
    return bool(getattr(result, "is_error", False))


def describe(name: str, args: dict[str, Any], data: Any) -> str:
    rng = args.get("range") or args.get("cell") or ""
    if name == "format_range":
        applied = data.get("applied") if isinstance(data, dict) else None
        what = ", ".join(a.split(".")[-1] for a in applied) if applied else "formatting"
        return f"Formatted {rng}: {what}" if rng else f"Formatted: {what}"
    if name == "execute_command":
        params = args.get("params") if isinstance(args.get("params"), dict) else {}
        where = params.get("range") or params.get("cell") or params.get("name") or ""
        return f"Ran {args.get('command', 'a command')}" + (f" on {where}" if where else "")
    if name == "sort_range":
        return f"Sorted {rng}" if rng else "Sorted the current region"
    if name == "create_table":
        return f"Made {rng} a table" if rng else "Made a table"
    if name == "insert_chart":
        return f"Inserted a chart from {rng}" if rng else "Inserted a chart"
    if name == "filter":
        return "Changed a filter" + (f" on {rng}" if rng else "")
    if name == "save_workbook":
        return "Saved the workbook"
    return f"{name} {rng}".strip()


class Journal:
    """Wraps a GridCraft MCP client: refuses tools the mode doesn't allow and records what writes changed."""

    def __init__(self, mode: str, call: Callable[[str, dict[str, Any]], Awaitable[Any]], allowed: set[str]):
        self.mode = mode
        self._call = call
        self.allowed = allowed
        self.edits: list[dict[str, Any]] = []
        self.changes: list[dict[str, Any]] = []
        self.undo_steps = 0
        self.cells_left = MAX_JOURNAL_CELLS
        self.saved = False

    async def _undo_list(self) -> list[str]:
        try:
            data = payload(await self._call("inspect_workbook", {}))
        except Exception:
            return []
        return list(data.get("undo") or []) if isinstance(data, dict) else []

    async def _read(self, sheet: str | None, rng: str, formulas: bool) -> dict[str, Any] | None:
        args: dict[str, Any] = {"range": rng}
        if sheet:
            args["sheet"] = sheet
        if formulas:
            args["formulas"] = True
        try:
            result = await self._call("read_range", args)
        except Exception:
            return None
        data = payload(result)
        return data if not is_error(result) and isinstance(data, dict) else None

    async def call(self, name: str, args: dict[str, Any]) -> Any:
        if name not in self.allowed:
            if self.mode == "review" and name == "save_workbook":
                raise ToolRefused("Saving is off for this request: the owner reviews the changes and saves them. "
                                  "Do not try to save; finish the request and describe what changed.")
            raise ToolRefused(f"{name} is not available in {MODE_LABELS.get(self.mode, self.mode)} mode. "
                              "Use only the tools you were given.")
        if not is_write(name):
            return await self._call(name, args)

        target = write_target(name, args)
        size = 0
        if target:
            b = parse_range(target[1])
            size = (b[2] - b[0] + 1) * (b[3] - b[1] + 1) if b else 0
        diff = bool(target) and size * 3 <= self.cells_left  # before, after, computed after
        before = await self._read(target[0], target[1], True) if diff else None
        undo_before = await self._undo_list() if name not in ONE_STEP_TOOLS and name != "format_range" else None

        result = await self._call(name, args)
        if is_error(result):
            return result
        data = payload(result)

        if name in ONE_STEP_TOOLS:
            steps = 1
        elif name == "format_range":
            applied = data.get("applied") if isinstance(data, dict) else None
            steps = len(applied) if isinstance(applied, list) else 1
        else:
            steps = undo_delta(undo_before or [], await self._undo_list())
        self.undo_steps += steps
        if name == "save_workbook":
            self.saved = True

        if target:
            entry: dict[str, Any] = {"tool": name, "sheet": target[0], "range": target[1]}
            if diff:
                after = await self._read(target[0], target[1], True)
                values = await self._read(target[0], target[1], False)
                self.cells_left -= size * 3
                entry["sheet"] = (after or before or {}).get("sheet") or target[0]
                entry["before"] = (before or {}).get("values")
                entry["after"] = (after or {}).get("values")
                entry["afterValues"] = (values or {}).get("values")
            else:
                entry["truncated"] = True
            self.edits.append(entry)
        else:
            sheet, rng = split_sheet(str(args.get("range") or args.get("cell") or ""))
            change = {"tool": name, "summary": describe(name, args, data)}
            if sheet:
                change["sheet"] = sheet
            if rng:
                change["range"] = rng
            self.changes.append(change)
        return result

    async def finish(self) -> dict[str, Any]:
        info: Any = None
        try:
            info = payload(await self._call("inspect_workbook", {}))
        except Exception:
            pass
        info = info if isinstance(info, dict) else {}
        return {
            "mode": self.mode,
            "edits": self.edits,
            "changes": self.changes,
            "undoSteps": self.undo_steps,
            "undoTop": list(info.get("undo") or [])[:UNDO_TOP],
            "dirty": info.get("dirty"),
            "saved": self.saved,
        }
