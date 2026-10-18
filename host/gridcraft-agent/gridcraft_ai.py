from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from typing import Any

from mcp import Client, StdioServerParameters
from openai import AsyncOpenAI

from gridcraft_answer import Reads, check_answer
from gridcraft_journal import MODES, Journal, ToolRefused, allowed_tools, is_write


DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1"
DEFAULT_MODEL = "qwen3:4b-instruct-32k"
# The bridge runs the fast 4k-context model and switches a request to this one only when the prompt nears
# the 4k window, where Ollama would otherwise drop the start of the conversation without saying so.
DEFAULT_LONG_MODEL = "qwen3:4b-instruct-32k"
DEFAULT_LONG_CONTEXT_AT = 3500
DEFAULT_GRIDCRAFT_CLI = r"C:\Program Files\GridCraft\gridcraft-cli.exe"
DEFAULT_GRIDCRAFT_PORT = 7979
MAX_TOOL_ROUNDS = 12


CORE_TOOL_NAMES = {
    "inspect_workbook",
    "read_range",
    "get_cell",
    "evaluate_formula",
    "write_range",
    "set_cell",
    "format_range",
    "execute_command",
    "list_commands",
    "save_workbook",
}


ACTION_WORDS = (
    "create", "add", "write", "set", "change", "update", "modify", "format",
    "insert", "delete", "remove", "rename", "move", "copy", "sort", "filter",
    "calculate", "populate", "fill", "clear", "save", "make"
)


def looks_like_action_request(text: str) -> bool:
    lowered = text.lower()
    return any(re.search(rf"\b{re.escape(word)}\b", lowered) for word in ACTION_WORDS)


SYSTEM_PROMPT = """You are a local spreadsheet agent controlling GridCraft through MCP tools.

Rules:
- Use GridCraft tools whenever the user's request requires reading or changing the workbook.
- Inspect the workbook before making destructive or broad changes.
- Prefer targeted edits over unnecessary rewrites.
- Preserve existing workbook content unless the user explicitly asks to replace it.
- When creating tables, charts, formulas, or formatting, use the tools' documented schemas exactly.
- After making changes, verify the result by reading relevant ranges or workbook metadata when practical.
- If a tool call fails, read the error, correct the arguments, and retry when reasonable.
- Never claim a workbook change succeeded unless the tool result indicates success.
- Keep the final answer concise. It must contain the actual information the user asked for (names, values, counts, findings) taken from the tool results, plus what changed, if anything.
- Never reply only that the request is complete; the user cannot see tool results, so restate them.
- For a total, sum, average, count, minimum or maximum, compute it without changing the workbook: use evaluate_formula
  with a formula such as =SUM(Sales!D2:D17) (or AVERAGE, COUNT, MIN, MAX) and state the number it returns in your
  answer. Find the column and its rows with inspect_workbook or read_range first.
"""

MODE_PROMPTS = {
    "read": "This request is READ ONLY: you cannot change the workbook. If the user asks for a change, describe "
            "exactly what you would change and say they can run the request again in Review or Apply mode.",
    "review": "Changes you make are shown to the user for review before they are kept. Do not save the workbook; "
              "the user saves it when they keep your changes. Say clearly which cells you changed.",
    "apply": "",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Local Ollama + GridCraft MCP spreadsheet agent"
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL),
        help=f"Ollama OpenAI-compatible base URL (default: {DEFAULT_OLLAMA_BASE_URL})",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("OLLAMA_MODEL", DEFAULT_MODEL),
        help=f"Ollama model name (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--long-model",
        default=os.environ.get("OLLAMA_LONG_MODEL", DEFAULT_LONG_MODEL),
        help="Model to switch to when the prompt nears the main model's context window (empty to disable)",
    )
    parser.add_argument(
        "--long-context-at",
        type=int,
        default=int(os.environ.get("OLLAMA_LONG_CONTEXT_AT", DEFAULT_LONG_CONTEXT_AT)),
        help=f"Prompt tokens at which to switch to --long-model (default: {DEFAULT_LONG_CONTEXT_AT})",
    )
    parser.add_argument(
        "--gridcraft-cli",
        default=os.environ.get("GRIDCRAFT_CLI", DEFAULT_GRIDCRAFT_CLI),
        help="Path to gridcraft-cli.exe",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("GRIDCRAFT_PORT", DEFAULT_GRIDCRAFT_PORT)),
        help=f"GridCraft control-channel port (default: {DEFAULT_GRIDCRAFT_PORT})",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Use GridCraft's in-process headless MCP engine instead of connecting to the GUI.",
    )
    parser.add_argument(
        "--workbook",
        help="Optional workbook path for headless mode. Ignored for GUI-connected mode.",
    )
    parser.add_argument(
        "--sample",
        help="Optional GridCraft sample name for headless mode, e.g. sales.",
    )
    parser.add_argument(
        "--once",
        help="Run one request and exit instead of opening an interactive prompt.",
    )
    parser.add_argument(
        "--mode",
        choices=MODES,
        default=os.environ.get("GRIDCRAFT_MODE", "apply"),
        help="read: no changes; review: changes but never saves (the owner keeps or discards them); apply: changes and saves.",
    )
    parser.add_argument(
        "--list-tools",
        action="store_true",
        help="List the GridCraft MCP tools exposed to the model and exit.",
    )
    parser.add_argument(
        "--all-tools",
        action="store_true",
        help="Expose all GridCraft MCP tools instead of the compact core tool set.",
    )
    return parser.parse_args()


def mcp_tool_to_openai(tool: Any) -> dict[str, Any]:
    schema = getattr(tool, "input_schema", None) or {
        "type": "object",
        "properties": {},
    }
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description or tool.title or f"GridCraft tool: {tool.name}",
            "parameters": schema,
        },
    }


def tool_result_to_text(result: Any) -> str:
    payload: dict[str, Any] = {
        "is_error": bool(getattr(result, "is_error", False)),
    }

    structured = getattr(result, "structured_content", None)
    if structured is not None:
        payload["structured_content"] = structured

    blocks: list[Any] = []
    for block in getattr(result, "content", []) or []:
        if hasattr(block, "model_dump"):
            blocks.append(block.model_dump(mode="json"))
        elif hasattr(block, "dict"):
            blocks.append(block.dict())
        else:
            blocks.append(str(block))

    if blocks:
        payload["content"] = blocks

    return json.dumps(payload, ensure_ascii=False, default=str)


def summarize_tool_result(tool_name: str, result_text: str, max_chars: int = 1200) -> str:
    """Return a compact human-readable preview for console observability."""
    try:
        data = json.loads(result_text)
    except Exception:
        preview = result_text.replace("\r", " ").replace("\n", " ").strip()
        return preview[:max_chars] + ("..." if len(preview) > max_chars else "")

    parts: list[str] = []
    if data.get("is_error"):
        parts.append("ERROR")

    structured = data.get("structured_content")
    if structured is not None:
        try:
            s = json.dumps(structured, ensure_ascii=False, default=str)
        except Exception:
            s = str(structured)
        parts.append(s)

    for block in data.get("content", []) or []:
        if isinstance(block, dict):
            if "text" in block and block["text"]:
                parts.append(str(block["text"]))
            elif "data" in block:
                parts.append(str(block["data"]))
            else:
                parts.append(json.dumps(block, ensure_ascii=False, default=str))
        else:
            parts.append(str(block))

    preview = " | ".join(p.strip() for p in parts if p and str(p).strip())
    preview = preview.replace("\r", " ").replace("\n", " ").strip()

    if not preview:
        preview = "(no printable result)"

    if len(preview) > max_chars:
        preview = preview[:max_chars] + "..."

    return preview


def assistant_message_dict(message: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "role": "assistant",
        "content": message.content or "",
    }

    if message.tool_calls:
        data["tool_calls"] = []
        for call in message.tool_calls:
            data["tool_calls"].append(
                {
                    "id": call.id,
                    "type": "function",
                    "function": {
                        "name": call.function.name,
                        "arguments": call.function.arguments,
                    },
                }
            )

    return data


async def verify_ollama(client: AsyncOpenAI, model: str) -> set[str]:
    try:
        models = await client.models.list()
    except Exception as exc:
        raise RuntimeError(
            "Could not reach Ollama's OpenAI-compatible API. "
            "Verify Ollama is running and the --base-url value is correct."
        ) from exc

    available = {item.id for item in models.data}
    if model not in available:
        available_text = ", ".join(sorted(available)) if available else "(none returned)"
        raise RuntimeError(
            f"Model '{model}' is not available in Ollama.\n"
            f"Available models: {available_text}"
        )
    return available


async def list_all_tools(mcp_client: Client) -> list[Any]:
    tools: list[Any] = []
    cursor: str | None = None

    while True:
        result = await mcp_client.list_tools(cursor=cursor)
        tools.extend(result.tools)
        cursor = getattr(result, "next_cursor", None)
        if not cursor:
            return tools


async def run_agent_turn(
    llm: AsyncOpenAI,
    journal: Journal,
    openai_tools: list[dict[str, Any]],
    history: list[dict[str, Any]],
    user_text: str,
    models: dict[str, Any],
) -> str:
    history.append({"role": "user", "content": user_text})
    # In Read only mode a change request is answered with what would change; there is nothing to complete.
    action_request = journal.mode != "read" and looks_like_action_request(user_text)
    completion_gate_used = False
    tool_calls_seen: list[str] = []
    reads = Reads()

    for round_index in range(1, MAX_TOOL_ROUNDS + 1):
        print(f"[agent] model turn {round_index} ...", flush=True)
        response = await llm.chat.completions.create(
            model=models["current"],
            messages=history,
            tools=openai_tools,
            tool_choice="auto",
            temperature=0.1,
        )

        if not response.choices:
            raise RuntimeError("Ollama returned no completion choices.")

        # Near the window the prompt may already be truncated: redo this turn on the long-context model.
        prompt_tokens = getattr(getattr(response, "usage", None), "prompt_tokens", 0) or 0
        long_model = models.get("long")
        if long_model and models["current"] != long_model and prompt_tokens >= models["long_at"]:
            print(f"[agent] prompt is {prompt_tokens} tokens; switching to {long_model}.", flush=True)
            models["current"] = long_model
            response = await llm.chat.completions.create(
                model=long_model,
                messages=history,
                tools=openai_tools,
                tool_choice="auto",
                temperature=0.1,
            )
            if not response.choices:
                raise RuntimeError("Ollama returned no completion choices.")

        message = response.choices[0].message
        history.append(assistant_message_dict(message))

        if not message.tool_calls:
            final_text = (message.content or "").strip()

            if action_request and not completion_gate_used:
                completion_gate_used = True
                print("[agent] action completion check ...", flush=True)
                history.append(
                    {
                        "role": "user",
                        "content": (
                            "ACTION COMPLETION CHECK: Re-read my original request. "
                            "Do not summarize yet. Confirm internally that EVERY requested "
                            "change has actually been executed and the result verified. "
                            "If anything remains, call the required GridCraft tools NOW. "
                            + (
                                "For workbook-changing requests, after verification call save_workbook "
                                "when the workbook has a writable path and that tool is available. "
                                if journal.mode == "apply" else "Do not save the workbook. "
                            ) +
                            "Useful fact: activate a sheet with execute_command command "
                            "'sheet.activate' and params containing the sheet name. "
                            f"Tools used so far: {', '.join(tool_calls_seen) or '(none)'}. "
                            "Once everything is complete, reply with your final answer to my original "
                            "request: include the actual results (names, values, findings from the tool "
                            "results) and what changed. Do not mention this check or merely say the "
                            "request is complete."
                        ),
                    }
                )
                continue

            print("[agent] model returned final text.", flush=True)

            async def ask_without_tools(prompt: str) -> str:
                # One short turn with no tools: the question, the values read, and the request to state them.
                response = await llm.chat.completions.create(
                    model=models["current"],
                    messages=[history[0], {"role": "user", "content": f"Question: {user_text}\n\n{prompt}"}],
                    temperature=0.1,
                )
                return (response.choices[0].message.content or "") if response.choices else ""

            answer = await check_answer(final_text, user_text, reads, ask_without_tools)
            if answer != final_text:
                history[-1]["content"] = answer
            return answer or "(The model returned no text.)"

        for call in message.tool_calls:
            tool_calls_seen.append(call.function.name)
            raw_args_preview = (call.function.arguments or "{}").replace("\r", " ").replace("\n", " ")
            if len(raw_args_preview) > 500:
                raw_args_preview = raw_args_preview[:500] + "..."
            print(f"[agent] tool call: {call.function.name} {raw_args_preview}", flush=True)
            tool_name = call.function.name
            raw_arguments = call.function.arguments or "{}"
            arguments: Any = None
            failed = True

            try:
                arguments = json.loads(raw_arguments)
            except json.JSONDecodeError as exc:
                result_text = json.dumps(
                    {
                        "is_error": True,
                        "content": [
                            {
                                "type": "text",
                                "text": (
                                    f"Invalid JSON arguments for {tool_name}: "
                                    f"{exc}. Raw arguments: {raw_arguments}"
                                ),
                            }
                        ],
                    }
                )
            else:
                try:
                    result = await journal.call(tool_name, arguments)
                    result_text = tool_result_to_text(result)
                    failed = bool(getattr(result, "is_error", False))
                except ToolRefused as exc:
                    result_text = json.dumps(
                        {"is_error": True, "content": [{"type": "text", "text": str(exc)}]},
                        ensure_ascii=False,
                    )
                except Exception as exc:
                    result_text = json.dumps(
                        {
                            "is_error": True,
                            "content": [
                                {
                                    "type": "text",
                                    "text": f"MCP call {tool_name} failed: {type(exc).__name__}: {exc}",
                                }
                            ],
                        },
                        ensure_ascii=False,
                    )

            # What the answer has to state (values read), and whether this was a change request after all.
            if isinstance(arguments, dict):
                reads.add(tool_name, arguments, result_text)
            if is_write(tool_name) and not failed:
                reads.wrote = True

            print(
                f"[agent] tool result: {call.function.name} -> "
                f"{summarize_tool_result(call.function.name, result_text)}",
                flush=True,
            )

            history.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": result_text,
                }
            )

    raise RuntimeError(
        f"Stopped after {MAX_TOOL_ROUNDS} tool rounds to prevent an infinite loop."
    )


async def async_main() -> int:
    args = parse_args()

    if not os.path.isfile(args.gridcraft_cli):
        print(f"ERROR: GridCraft CLI not found: {args.gridcraft_cli}", file=sys.stderr)
        return 2

    llm = AsyncOpenAI(
        base_url=args.base_url.rstrip("/"),
        api_key="ollama",
        timeout=120.0,
        # Keep one model call (120s x 2 attempts) inside the bridge's 300s request budget.
        max_retries=1,
    )

    print(f"Checking Ollama at {args.base_url} ...")
    try:
        available = await verify_ollama(llm, args.model)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 3
    long_model = args.long_model if args.long_model and args.long_model != args.model else None
    if long_model and long_model not in available:
        print(f"Note: long-context model '{long_model}' is not installed; long workbooks may be truncated.")
        long_model = None
    # Shared across turns: once a conversation needs the long model it keeps using it.
    models = {"current": args.model, "long": long_model, "long_at": args.long_context_at}

    mcp_args = ["mcp"]
    if args.headless:
        if args.workbook and args.sample:
            print("ERROR: Use either --workbook or --sample in headless mode, not both.", file=sys.stderr)
            return 2
        if args.workbook:
            mcp_args += ["--in", os.path.abspath(args.workbook)]
        elif args.sample:
            mcp_args += ["--sample", args.sample]
    else:
        mcp_args += ["--connect", str(args.port)]

    server = StdioServerParameters(
        command=args.gridcraft_cli,
        args=mcp_args,
    )

    print(
        "Connecting to GridCraft MCP "
        + ("(headless) ..." if args.headless else f"(GUI control port {args.port}) ...")
    )

    try:
        async with Client(server, mode="auto") as mcp_client:
            all_tools = await list_all_tools(mcp_client)
            if not all_tools:
                print("ERROR: GridCraft MCP reported no tools.", file=sys.stderr)
                return 4

            if args.all_tools:
                tools = all_tools
                tool_profile = "all"
            else:
                tools = [tool for tool in all_tools if tool.name in CORE_TOOL_NAMES]
                tool_profile = "core"
            # Read only mode takes every read tool GridCraft has (list_functions is not in the core set).
            pool = all_tools if args.mode == "read" else tools
            allowed = allowed_tools(args.mode, {tool.name for tool in pool})
            tools = [tool for tool in pool if tool.name in allowed]
            tool_profile += f", {args.mode}"

            if not tools:
                print("ERROR: No GridCraft tools matched the selected tool profile.", file=sys.stderr)
                return 4

            print(
                f"Connected. Model: {args.model} | "
                f"MCP protocol: {mcp_client.protocol_version} | "
                f"GridCraft tools: {len(tools)}/{len(all_tools)} ({tool_profile})"
            )

            if args.list_tools:
                for tool in tools:
                    description = (tool.description or tool.title or "").replace("\n", " ").strip()
                    print(f"- {tool.name}: {description}")
                return 0

            openai_tools = [mcp_tool_to_openai(tool) for tool in tools]
            history: list[dict[str, Any]] = [
                {"role": "system", "content": SYSTEM_PROMPT + MODE_PROMPTS[args.mode]}
            ]
            journal = Journal(args.mode, mcp_client.call_tool, allowed)

            if args.once:
                # Report agent failures as such; the outer handler is only for MCP connection problems.
                try:
                    answer = await run_agent_turn(
                        llm, journal, openai_tools, history, args.once, models
                    )
                except Exception as exc:
                    print(f"ERROR: Agent request failed: {type(exc).__name__}: {exc}", file=sys.stderr)
                    return 6
                finally:
                    # What the request changed, for the bridge: also after a failure, which may have changed cells.
                    print("[journal] " + json.dumps(await journal.finish(), ensure_ascii=False, default=str),
                          file=sys.stderr, flush=True)
                print(answer)
                return 0

            print("\nGridCraft Local AI is ready.")
            print("Type a request, or /quit to exit. /tools lists tool names.\n")

            while True:
                try:
                    user_text = input("you> ").strip()
                except (EOFError, KeyboardInterrupt):
                    print()
                    break

                if not user_text:
                    continue
                if user_text.lower() in {"/quit", "/exit", "quit", "exit"}:
                    break
                if user_text.lower() == "/tools":
                    print("\n".join(tool.name for tool in tools))
                    continue

                try:
                    answer = await run_agent_turn(
                        llm,
                        journal,
                        openai_tools,
                        history,
                        user_text,
                        models,
                    )
                    print(f"\nai> {answer}\n")
                except Exception as exc:
                    print(f"\nERROR: {type(exc).__name__}: {exc}\n", file=sys.stderr)

            return 0

    except Exception as exc:
        print(
            "ERROR: Could not establish the GridCraft MCP connection.\n"
            f"{type(exc).__name__}: {exc}\n\n"
            "If using GUI mode, verify GridCraft is running with:\n"
            '  $env:WGPU_BACKEND="vulkan"\n'
            '  & "C:\\Program Files\\GridCraft\\gridcraft.exe" --sample sales --control 7979\n'
            "and verify:\n"
            "  Test-NetConnection 127.0.0.1 -Port 7979",
            file=sys.stderr,
        )
        return 5


def main() -> None:
    # Windows pipes default to the ANSI code page; workbook text and model output are often outside it.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    try:
        raise SystemExit(asyncio.run(async_main()))
    except KeyboardInterrupt:
        raise SystemExit(130)


if __name__ == "__main__":
    main()
