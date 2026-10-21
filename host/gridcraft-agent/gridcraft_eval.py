"""Score models on spreadsheet tasks with known answers, before changing the model the bridge uses.

Each task in eval/tasks.json runs on a fresh copy of GridCraft's 'sales' sample (headless: no window, nothing on disk),
through the same agent loop, tools and modes the bridge uses (gridcraft_ai.run_agent_turn). The answer and the cells
afterwards are checked against what the task expects.

Usage (on the Windows host, in the agent's venv):
  python gridcraft_eval.py --models qwen3:4b-instruct,qwen2.5-coder:7b-16k [--tasks sum-q1,north-q1] [--out results.json]
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import json
import os
import re
import statistics
import sys
import time
from pathlib import Path
from typing import Any

from mcp import Client, StdioServerParameters
from openai import AsyncOpenAI

from gridcraft_ai import (DEFAULT_GRIDCRAFT_CLI, DEFAULT_OLLAMA_BASE_URL, list_all_tools, mcp_tool_to_openai,
                          run_agent_turn, select_tools, system_prompt)
from gridcraft_answer import _same, numbers_in
from gridcraft_journal import Journal, payload, split_sheet

TASKS = Path(__file__).resolve().parent / "eval" / "tasks.json"


def number_stated(answer: str, forms: list[float]) -> bool:
    written = numbers_in(answer)
    return any(_same(w, d, float(f)) for w, d in written for f in forms)


def same_value(got: Any, want: Any) -> bool:
    if want is None:
        return got in (None, "")
    if isinstance(want, (int, float)) and not isinstance(want, bool):
        try:
            return abs(float(got) - float(want)) <= max(0.01, abs(float(want)) * 1e-6)
        except (TypeError, ValueError):
            return False
    return str(got or "").strip().lower() == str(want).strip().lower()


async def cell(call: Any, ref: str, formulas: bool) -> Any:
    sheet, addr = split_sheet(ref)
    data = payload(await call("read_range", {"sheet": sheet or "Sales", "range": addr, "formulas": formulas}))
    values = (data or {}).get("values") or [[None]]
    return values[0][0] if values and values[0] else None


def check(task: dict[str, Any], answer: str, cells: dict[str, Any], formulas: dict[str, Any],
          journal: dict[str, Any]) -> list[str]:
    """What the result got wrong; empty when it passed."""
    misses = []
    for forms in task.get("answer_numbers", []):
        if not number_stated(answer, forms):
            misses.append(f"answer lacks {forms[0]}")
    if task.get("answer_any") and not any(x.lower() in answer.lower() for x in task["answer_any"]):
        misses.append(f"answer lacks {task['answer_any'][0]}")
    for ref, want in (task.get("cells") or {}).items():
        if not same_value(cells.get(ref), want):
            misses.append(f"{ref} is {cells.get(ref)!r}, not {want!r}")
    for ref in task.get("formulas", []):
        if not str(formulas.get(ref) or "").startswith("="):
            misses.append(f"{ref} holds no formula")
    if task.get("change_summary"):
        summaries = " | ".join(c.get("summary", "") for c in journal.get("changes", []))
        if not re.search(task["change_summary"], summaries):
            misses.append(f"no change matching {task['change_summary']}")
    if task["mode"] == "read" and journal.get("undoSteps"):
        misses.append("a read-only request changed the workbook")
    if task["mode"] == "review" and journal.get("saved"):
        misses.append("a Review request saved")
    return misses


async def run_task(llm: AsyncOpenAI, cli: str, model: str, task: dict[str, Any], limit: float) -> dict[str, Any]:
    server = StdioServerParameters(command=cli, args=["mcp", "--sample", "sales"])
    started = time.monotonic()
    log = io.StringIO()
    result: dict[str, Any] = {"id": task["id"], "kind": task["kind"], "model": model}
    async with Client(server, mode="auto") as client:
        tools, allowed = select_tools(await list_all_tools(client), task["mode"])
        journal = Journal(task["mode"], client.call_tool, allowed)
        history = [{"role": "system", "content": system_prompt(task["mode"])}]
        models = {"current": model, "long": None, "long_at": 10 ** 9, "deadline": time.monotonic() + limit}
        answer, error = "", ""
        with contextlib.redirect_stdout(log):
            try:
                answer = await run_agent_turn(llm, journal, [mcp_tool_to_openai(t) for t in tools], history,
                                              task["prompt"], models)
            except Exception as exc:  # a failed task is a result, not a crash
                error = f"{type(exc).__name__}: {exc}"
        refs = list(task.get("cells") or {}) + list(task.get("formulas") or [])
        cells = {ref: await cell(client.call_tool, ref, False) for ref in refs}
        formulas = {ref: await cell(client.call_tool, ref, True) for ref in task.get("formulas", [])}
        record = await journal.finish()
    lines = log.getvalue().splitlines()
    misses = ([error] if error else []) + check(task, answer, cells, formulas, record)
    result.update(passed=not misses, misses=misses, seconds=round(time.monotonic() - started, 1),
                  turns=sum(1 for x in lines if x.startswith("[agent] model turn")),
                  toolCalls=sum(1 for x in lines if x.startswith("[agent] tool call:")),
                  answer=answer[:400])
    return result


def summary(results: list[dict[str, Any]]) -> list[str]:
    out = []
    for model in dict.fromkeys(r["model"] for r in results):
        mine = [r for r in results if r["model"] == model]
        parts = []
        for kind in ("read", "change"):
            k = [r for r in mine if r["kind"] == kind]
            if k:
                parts.append(f"{kind} {sum(r['passed'] for r in k)}/{len(k)}")
        secs = [r["seconds"] for r in mine]
        out.append(f"{model}: {sum(r['passed'] for r in mine)}/{len(mine)} passed ({', '.join(parts)}); "
                   f"median {statistics.median(secs):.1f}s, slowest {max(secs):.1f}s")
    return out


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--models", required=True, help="Comma-separated Ollama models")
    parser.add_argument("--tasks", default="", help="Comma-separated task ids (default: all)")
    parser.add_argument("--base-url", default=os.environ.get("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL))
    parser.add_argument("--gridcraft-cli", default=os.environ.get("GRIDCRAFT_CLI", DEFAULT_GRIDCRAFT_CLI))
    parser.add_argument("--time-limit", type=float, default=240, help="Seconds per task")
    parser.add_argument("--out", default="", help="Write every result as JSON here")
    args = parser.parse_args()
    tasks = json.loads(TASKS.read_text(encoding="utf-8"))["tasks"]
    if args.tasks:
        wanted = set(args.tasks.split(","))
        tasks = [t for t in tasks if t["id"] in wanted]
    llm = AsyncOpenAI(base_url=args.base_url.rstrip("/"), api_key="ollama", timeout=180.0, max_retries=0)
    results = []
    for model in [m.strip() for m in args.models.split(",") if m.strip()]:
        for task in tasks:
            r = await run_task(llm, args.gridcraft_cli, model, task, args.time_limit)
            results.append(r)
            print(f"{'PASS' if r['passed'] else 'FAIL'} {model} {r['id']} {r['seconds']}s "
                  f"{r['toolCalls']} tools{'' if r['passed'] else ' - ' + '; '.join(r['misses'])}", flush=True)
    for line in summary(results):
        print(line)
    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=1, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(asyncio.run(main()))
