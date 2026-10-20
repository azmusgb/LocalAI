"""Workbook operations the bridge runs without a model: show the workbook, keep (save) or discard (undo) a request,
list the workbooks in the GridCraft folder and open one of them, and change one cell by hand (set_cell).

Usage: python gridcraft_ops.py workbook|keep|discard|workbooks|open|set_cell|state < request.json  ->  one JSON object on stdout.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import os
import re
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath
from typing import Any, Awaitable, Callable

from gridcraft_journal import NON_WRITE_TOOLS, UNDO_TOP, Journal, clamp_range, fingerprint, is_error, payload, undo_top_matches, window_range

DEFAULT_GRIDCRAFT_CLI = r"C:\Program Files\GridCraft\gridcraft-cli.exe"
Call = Callable[[str, dict[str, Any]], Awaitable[Any]]
# What the workbook menu lists and opens: files directly in the GridCraft folder with one of these extensions.
WORKBOOK_EXTENSIONS = (".xlsx", ".xlsm", ".xls", ".csv", ".ods")


class OpError(Exception):
    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


async def _json(call: Call, name: str, args: dict[str, Any]) -> Any:
    result = await call(name, args)
    data = payload(result)
    if is_error(result):
        text = next((getattr(b, "text", "") for b in getattr(result, "content", None) or []), "")
        raise OpError(text or f"{name} failed", 400 if name == "read_range" else 500)
    return data


def _sheet_summary(s: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": s.get("name"),
        "usedRange": s.get("usedRange"),
        "cells": s.get("cells") or 0,
        "tables": len(s.get("tables") or []),
        "charts": len(s.get("charts") or []),
    }


async def workbook(call: Call, req: dict[str, Any]) -> dict[str, Any]:
    info = await _json(call, "inspect_workbook", {})
    sheets = info.get("sheets") or []
    active = info.get("activeSheet")
    active_name = sheets[active]["name"] if isinstance(active, int) and 0 <= active < len(sheets) else None
    wanted = str(req.get("sheet") or "") or active_name or (sheets[0]["name"] if sheets else None)
    sheet = next((s for s in sheets if s.get("name") == wanted), None)
    if wanted and sheet is None:
        raise OpError(f"No sheet named {wanted}", 404)
    out: dict[str, Any] = {
        "title": info.get("title"),
        "file": PureWindowsPath(info["path"]).name if info.get("path") else None,
        "dirty": bool(info.get("dirty")),
        "activeSheet": active_name,
        "sheets": [_sheet_summary(s) for s in sheets],
        "sheet": wanted,
        "usedRange": sheet.get("usedRange") if sheet else None,
        "range": None,
        "truncated": False,
        "values": [],
        "formulas": [],
        "raw": [],
    }
    if not sheet:
        return out
    if req.get("range"):
        rng = clamp_range(str(req["range"]))
        if not rng:
            raise OpError("range must look like A1:D20", 400)
        truncated = False
    else:
        rng, truncated = window_range(sheet.get("usedRange"))
    if not rng:
        return out
    base = {"sheet": wanted, "range": rng}
    shown = await _json(call, "read_range", {**base, "formatted": True})
    formulas = await _json(call, "read_range", {**base, "formulas": True})
    raw = await _json(call, "read_range", base)
    out.update(range=shown.get("range") or rng, truncated=truncated, values=shown.get("values") or [],
               formulas=formulas.get("values") or [], raw=raw.get("values") or [])
    return out


async def keep(call: Call, req: dict[str, Any]) -> dict[str, Any]:
    await _json(call, "save_workbook", {})
    info = await _json(call, "inspect_workbook", {})
    return {"dirty": bool(info.get("dirty"))}


async def discard(call: Call, req: dict[str, Any]) -> dict[str, Any]:
    steps, expected = req.get("steps"), req.get("undoTop")
    if not isinstance(steps, int) or steps < 1 or steps > 1000:
        raise OpError("steps must be a whole number from 1 to 1000", 400)
    if not isinstance(expected, list) or not expected:
        raise OpError("undoTop is required", 400)
    prints = req.get("fingerprint")
    if prints is not None and not isinstance(prints, str):
        raise OpError("fingerprint must be text", 400)
    info = await _json(call, "inspect_workbook", {})
    changed = not undo_top_matches(list(info.get("undo") or []), expected)
    # The undo labels are generic ("Enter Cell"), so a cell typed in GridCraft since can leave them as they were; the
    # fingerprint of every cell can't. A workbook too large to fingerprint (None now) keeps the label check alone.
    if not changed and prints:
        now = await fingerprint(call, info)
        changed = now is not None and now != prints
    if changed:
        raise OpError("The workbook changed in GridCraft after this request, so undoing it could remove other work.", 409)
    await _json(call, "undo", {"steps": steps})
    info = await _json(call, "inspect_workbook", {})
    return {"dirty": bool(info.get("dirty")), "undone": steps}


def workbooks_dir() -> Path:
    # The bridge sets this from GRIDCRAFT_WORKBOOKS_DIR, or the folder of its GRIDCRAFT_WORKBOOK.
    default = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Documents" / "GridCraft"
    return Path(os.environ.get("GRIDCRAFT_WORKBOOKS_DIR") or default)


def _is_workbook(name: str) -> bool:
    return name.lower().endswith(WORKBOOK_EXTENSIONS) and not name.startswith("~$")  # ~$ is Excel's lock file


def workbook_name(name: Any) -> str:
    """A bare file name in the GridCraft folder, or OpError. Never a path: the page only ever names a file."""
    if not isinstance(name, str) or not name.strip() or len(name) > 255:
        raise OpError("Choose a workbook file", 400)
    if any(c in name for c in "/\\:\0") or ".." in name:
        raise OpError("A workbook is named by its file name only, not a path", 400)
    if not _is_workbook(name):
        raise OpError(f"GridCraft opens {', '.join(WORKBOOK_EXTENSIONS)} files", 400)
    if not (workbooks_dir() / name).is_file():
        raise OpError(f"{name} is not in the GridCraft folder", 404)
    return name


async def workbooks(call: Call | None, req: dict[str, Any]) -> dict[str, Any]:
    # Names, sizes and dates only: the page never sees a host path. No subfolders.
    items = []
    try:
        entries = list(os.scandir(workbooks_dir()))
    except OSError:
        entries = []
    for e in entries:
        try:
            if not _is_workbook(e.name) or not e.is_file():
                continue
            info = e.stat()
        except OSError:
            continue
        modified = datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(timespec="seconds")
        items.append({"name": e.name, "size": info.st_size, "modified": modified})
    items.sort(key=lambda x: x["name"].casefold())
    return {"items": items}


async def open_book(call: Call, req: dict[str, Any]) -> dict[str, Any]:
    name = workbook_name(req.get("name"))
    # Opening replaces the workbook: unsaved changes would be lost, or GridCraft would stop on a save dialog on the PC.
    info = await _json(call, "inspect_workbook", {})
    if info.get("dirty"):
        raise OpError("The open workbook has unsaved changes. Keep or discard them first, then open another workbook.", 409)
    await _json(call, "open_workbook", {"path": os.path.join(str(workbooks_dir()), name)})
    return {"file": name}


# A cell the owner changes by hand: one cell, A1 style, upper case (the page always sends it so); GridCraft's own limits
# on a sheet name and on what a cell holds are wider, these are what the page needs.
CELL_REF = re.compile(r"^[A-Z]{1,3}[1-9][0-9]{0,6}$")
MAX_SHEET_CHARS = 100
MAX_INPUT_CHARS = 8192


def cell_edit(req: dict[str, Any]) -> tuple[str, str, str]:
    """(sheet, cell, input) from a set_cell request, or OpError 400."""
    sheet, cell, text = req.get("sheet"), req.get("cell"), req.get("input")
    if not isinstance(sheet, str) or not sheet.strip() or len(sheet) > MAX_SHEET_CHARS or any(ord(c) < 32 for c in sheet):
        raise OpError(f"sheet must be a sheet name of 1 to {MAX_SHEET_CHARS} characters", 400)
    if not isinstance(cell, str) or not CELL_REF.match(cell):
        raise OpError("cell must look like B7", 400)
    if not isinstance(text, str) or len(text) > MAX_INPUT_CHARS:
        raise OpError(f"input must be text of at most {MAX_INPUT_CHARS} characters", 400)
    return sheet, cell, text


def qualified(sheet: str, cell: str) -> str:
    """Sales!B7, or 'Q1 Sales'!B7 when the name needs quotes (gridcraft_journal.split_sheet reads both)."""
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", sheet):
        return f"{sheet}!{cell}"
    return "'" + sheet.replace("'", "''") + f"'!{cell}"


async def set_cell(call: Call, req: dict[str, Any]) -> dict[str, Any]:
    """Changes one cell the way a Review request would: never saves, and returns the journal (before -> after and the
    undo steps) so the owner can keep or discard it. undoBefore is the undo list's top before the edit, so the appliance
    can tell whether this edit sits directly on top of the previous one."""
    sheet, cell, text = cell_edit(req)
    info = await _json(call, "inspect_workbook", {})
    if not any(s.get("name") == sheet for s in info.get("sheets") or []):
        raise OpError(f"No sheet named {sheet}", 404)
    undo_before = list(info.get("undo") or [])[:UNDO_TOP]
    prints_before = await fingerprint(call, info)
    journal = Journal("review", call, {"set_cell"})
    result = await journal.call("set_cell", {"cell": qualified(sheet, cell), "input": text})
    if is_error(result):
        reason = next((getattr(b, "text", "") for b in getattr(result, "content", None) or []), "")
        raise OpError(reason or "GridCraft did not change the cell", 400)
    return {"journal": await journal.finish(), "undoBefore": undo_before, "fingerprintBefore": prints_before}


async def state(call: Call, req: dict[str, Any]) -> dict[str, Any]:
    """Where the workbook stands now: for a request the bridge had to stop, whose agent never printed its journal."""
    info = await _json(call, "inspect_workbook", {})
    return {"undoTop": list(info.get("undo") or [])[:UNDO_TOP], "dirty": info.get("dirty"),
            "fingerprint": await fingerprint(call, info)}


OPS = {"workbook": workbook, "keep": keep, "discard": discard, "workbooks": workbooks, "open": open_book, "set_cell": set_cell,
       "state": state}
NO_GRIDCRAFT = {"workbooks"}  # reads the folder only


def check(op: str, req: dict[str, Any]) -> None:
    """Refuse a bad request before anything connects to GridCraft."""
    if op == "open":
        workbook_name(req.get("name"))
    if op == "set_cell":
        cell_edit(req)


def connect(port: Any = None) -> Any:
    """A GridCraft MCP client (an async context manager) on the control port."""
    from mcp import Client, StdioServerParameters

    cli = os.environ.get("GRIDCRAFT_CLI", DEFAULT_GRIDCRAFT_CLI)
    port = port or os.environ.get("GRIDCRAFT_PORT", os.environ.get("GRIDCRAFT_CONTROL_PORT", "7979"))
    return Client(StdioServerParameters(command=cli, args=["mcp", "--connect", str(port)]), mode="auto")


async def run(op: str, req: dict[str, Any]) -> dict[str, Any]:
    if op in NO_GRIDCRAFT:
        return await OPS[op](None, req)
    check(op, req)
    async with connect() as client:
        return await OPS[op](client.call_tool, req)


class Retry(Exception):
    """The connection failed before the op changed anything: run it again on a fresh connection."""


class Lost(Exception):
    """The connection failed after the op may have changed the workbook: running it again could do it twice."""


class Session:
    """One GridCraft MCP connection the bridge keeps open across ops, instead of a Python process and a gridcraft-cli
    process per grid view or cell edit. The connection lives in one task on its own event loop thread (the MCP client
    must be opened and closed by the same task); ops queue to it and run one at a time. It closes after `idle` seconds
    without an op, or when a call fails, and opens again for the next op."""

    def __init__(self, open_client: Callable[[], Any] = connect, idle: float = 120.0):
        self._open = open_client
        self._idle = idle
        self._loop = asyncio.new_event_loop()
        self._queue: asyncio.Queue | None = None
        self._task: asyncio.Task | None = None
        ready = threading.Event()
        threading.Thread(target=self._main, args=(ready,), daemon=True, name="gridcraft-ops").start()
        ready.wait()

    def _main(self, ready: threading.Event) -> None:
        asyncio.set_event_loop(self._loop)
        self._queue = asyncio.Queue()
        self._task = self._loop.create_task(self._serve())
        ready.set()
        self._loop.run_forever()

    def _restart(self) -> None:
        # After a time-out: drop the connection (cancelling closes it in its own task) and serve the queue anew.
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = self._loop.create_task(self._serve())

    async def _serve(self) -> None:
        while True:
            item = await self._queue.get()
            try:
                async with self._open() as client:
                    while item:
                        await self._do(client, *item)
                        try:
                            item = await asyncio.wait_for(self._queue.get(), self._idle)
                        except asyncio.TimeoutError:
                            item = None
            except asyncio.CancelledError:
                raise
            except BaseException as exc:  # connecting failed, or _do re-raised a broken connection
                op, req, fut, wrote = item if item else (None, None, None, None)
                if fut and not fut.done():
                    fut.set_exception(Lost(str(exc)) if wrote and wrote[0] else Retry(f"{type(exc).__name__}: {exc}"))

    async def _do(self, client: Any, op: str, req: dict[str, Any], fut: concurrent.futures.Future, wrote: list) -> None:
        async def call(name: str, args: dict[str, Any]) -> Any:
            if name not in NON_WRITE_TOOLS:
                wrote[0] = True
            return await client.call_tool(name, args)
        try:
            fut.set_result(await OPS[op](call, req))
        except OpError as exc:  # GridCraft answered: the connection is fine
            fut.set_exception(exc)
        # Anything else means the connection is in doubt: _serve reports it and the next op opens a new one.

    def run(self, op: str, req: dict[str, Any], timeout: float) -> dict[str, Any]:
        """The op's result; OpError as the ops raise it; Retry when nothing was changed and a new connection (or the
        one-process path) can safely run it again; Lost when the workbook may have changed; TimeoutError when GridCraft
        did not answer (the connection is dropped)."""
        if op in NO_GRIDCRAFT:
            return asyncio.run_coroutine_threadsafe(OPS[op](None, req), self._loop).result(timeout)
        check(op, req)
        fut: concurrent.futures.Future = concurrent.futures.Future()
        wrote = [False]
        self._loop.call_soon_threadsafe(self._queue.put_nowait, (op, req, fut, wrote))
        try:
            return fut.result(timeout)
        except concurrent.futures.TimeoutError:
            self._loop.call_soon_threadsafe(self._restart)
            raise TimeoutError(f"GridCraft did not answer within {timeout:g}s") from None


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    op = sys.argv[1] if len(sys.argv) > 1 else ""
    if op not in OPS:
        print(json.dumps({"ok": False, "status": 400, "error": f"unknown operation {op!r}"}))
        return 2
    try:
        req = json.loads(sys.stdin.read() or "{}")
        out = {"ok": True, **asyncio.run(run(op, req if isinstance(req, dict) else {}))}
    except OpError as exc:
        out = {"ok": False, "status": exc.status, "error": str(exc)}
    except Exception as exc:
        out = {"ok": False, "status": 502, "error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(out, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
