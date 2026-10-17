"""Workbook operations the bridge runs without a model: show the workbook, keep (save) or discard (undo) a request.

Usage: python gridcraft_ops.py workbook|keep|discard < request.json   ->  one JSON object on stdout.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import PureWindowsPath
from typing import Any, Awaitable, Callable

from gridcraft_journal import clamp_range, is_error, payload, undo_top_matches, window_range

DEFAULT_GRIDCRAFT_CLI = r"C:\Program Files\GridCraft\gridcraft-cli.exe"
Call = Callable[[str, dict[str, Any]], Awaitable[Any]]


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
    info = await _json(call, "inspect_workbook", {})
    if not undo_top_matches(list(info.get("undo") or []), expected):
        raise OpError("The workbook changed in GridCraft after this request, so undoing it could remove other work.", 409)
    await _json(call, "undo", {"steps": steps})
    info = await _json(call, "inspect_workbook", {})
    return {"dirty": bool(info.get("dirty")), "undone": steps}


OPS = {"workbook": workbook, "keep": keep, "discard": discard}


async def run(op: str, req: dict[str, Any]) -> dict[str, Any]:
    from mcp import Client, StdioServerParameters

    cli = os.environ.get("GRIDCRAFT_CLI", DEFAULT_GRIDCRAFT_CLI)
    port = os.environ.get("GRIDCRAFT_PORT", os.environ.get("GRIDCRAFT_CONTROL_PORT", "7979"))
    server = StdioServerParameters(command=cli, args=["mcp", "--connect", str(port)])
    async with Client(server, mode="auto") as client:
        return await OPS[op](client.call_tool, req)


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
