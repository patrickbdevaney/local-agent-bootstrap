#!/usr/bin/env python3
"""Tool-call battery for the local llama-server endpoint.

Two modes:

  (default)     fire 10 prompts against 3 real tools and check every call is
                well-formed, correctly selected, and does not run away.

  --sweep       measure THIS model's tool-count cliff by padding the tool list
                with plausible decoys and re-running the same 10 prompts at each
                size. Published numbers put ~8B models at a peak near 19 tools and
                failure near 46, with a cliff rather than a slope - but that is
                someone else's benchmark on someone else's model. This measures
                ours, which is what actually bounds how many MCP tools we can add.

Usage:
  toolcall-battery.py
  toolcall-battery.py --sweep 3,10,20,30,40
"""

import argparse
import json
import os
import sys
import urllib.request

API = os.environ.get("AGENT_API", "http://127.0.0.1:8090/v1")
RUNAWAY_TOKENS = int(os.environ.get("RUNAWAY_TOKENS", "1500"))

REAL_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a city.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "City name"},
                    "unit": {"type": "string", "enum": ["c", "f"]},
                },
                "required": ["city"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file from disk.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_sql",
            "description": "Run a read-only SQL query.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["query"],
            },
        },
    },
]

# Decoys are deliberately plausible and partially overlapping with the real tools.
# A decoy list of obviously-irrelevant tools would understate the interference that
# real MCP suites cause, where many tools genuinely sound applicable.
DECOY_SPECS = [
    ("search_documents", "Search indexed documents by keyword.", {"query": "string"}),
    ("send_email", "Send an email to a recipient.", {"to": "string", "body": "string"}),
    ("create_ticket", "Create an issue ticket in the tracker.", {"title": "string"}),
    ("list_files", "List files in a directory.", {"path": "string"}),
    ("write_file", "Write contents to a file on disk.", {"path": "string", "content": "string"}),
    ("get_forecast", "Get a multi-day weather forecast for a location.", {"location": "string"}),
    ("run_shell", "Execute a shell command.", {"command": "string"}),
    ("query_metrics", "Query time-series metrics from the monitoring system.", {"metric": "string"}),
    ("translate_text", "Translate text between languages.", {"text": "string", "target": "string"}),
    ("summarize_text", "Summarize a block of text.", {"text": "string"}),
    ("fetch_url", "Fetch the contents of a URL.", {"url": "string"}),
    ("get_calendar", "Get calendar events for a date.", {"date": "string"}),
    ("update_record", "Update a database record by id.", {"id": "string", "fields": "string"}),
    ("delete_record", "Delete a database record by id.", {"id": "string"}),
    ("list_tables", "List tables available in the database.", {}),
    ("describe_table", "Describe the schema of a database table.", {"table": "string"}),
    ("get_stock_price", "Get the current price of a stock ticker.", {"ticker": "string"}),
    ("convert_currency", "Convert an amount between currencies.", {"amount": "string", "to": "string"}),
    ("geocode_address", "Convert a street address to coordinates.", {"address": "string"}),
    ("get_timezone", "Get the timezone for a location.", {"location": "string"}),
    ("compress_archive", "Create a compressed archive from a path.", {"path": "string"}),
    ("extract_archive", "Extract a compressed archive.", {"path": "string"}),
    ("render_chart", "Render a chart from a data series.", {"series": "string"}),
    ("spell_check", "Check spelling in a block of text.", {"text": "string"}),
    ("diff_files", "Show the difference between two files.", {"a": "string", "b": "string"}),
    ("git_status", "Show the working tree status of a git repository.", {"repo": "string"}),
    ("git_log", "Show the commit log of a git repository.", {"repo": "string"}),
    ("run_tests", "Run the test suite for a project.", {"path": "string"}),
    ("lint_code", "Run a linter over a source file.", {"path": "string"}),
    ("format_code", "Format a source file.", {"path": "string"}),
    ("build_project", "Build a project from source.", {"path": "string"}),
    ("deploy_service", "Deploy a service to an environment.", {"service": "string"}),
    ("scale_service", "Change the replica count of a service.", {"service": "string"}),
    ("read_logs", "Read recent logs for a service.", {"service": "string"}),
    ("create_branch", "Create a git branch.", {"name": "string"}),
    ("merge_branch", "Merge a git branch into another.", {"source": "string"}),
    ("open_pull_request", "Open a pull request.", {"title": "string"}),
    ("review_pull_request", "Post a review on a pull request.", {"number": "string"}),
    ("search_web", "Search the public web for a query.", {"query": "string"}),
    ("take_screenshot", "Capture a screenshot of a web page.", {"url": "string"}),
    ("transcribe_audio", "Transcribe an audio file to text.", {"path": "string"}),
    ("generate_image", "Generate an image from a text prompt.", {"prompt": "string"}),
    ("classify_text", "Classify text into a category.", {"text": "string"}),
    ("extract_entities", "Extract named entities from text.", {"text": "string"}),
    ("schedule_job", "Schedule a job to run at a time.", {"job": "string", "when": "string"}),
    ("cancel_job", "Cancel a scheduled job.", {"job": "string"}),
    ("list_containers", "List running containers.", {}),
    ("restart_container", "Restart a container by name.", {"name": "string"}),
    ("get_secret", "Retrieve a secret from the vault.", {"key": "string"}),
    ("rotate_secret", "Rotate a secret in the vault.", {"key": "string"}),
]


def decoy_tools(n):
    out = []
    for i in range(n):
        name, desc, props = DECOY_SPECS[i % len(DECOY_SPECS)]
        if i >= len(DECOY_SPECS):
            name = f"{name}_{i // len(DECOY_SPECS) + 1}"
        out.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": desc,
                    "parameters": {
                        "type": "object",
                        "properties": {k: {"type": v} for k, v in props.items()},
                        "required": list(props.keys())[:1],
                    },
                },
            }
        )
    return out


CASES = [
    ("What's the weather in Tokyo?", "get_weather", ["city"]),
    ("Weather in Reykjavik, in fahrenheit please.", "get_weather", ["city"]),
    ("Show me the contents of /etc/hostname", "read_file", ["path"]),
    ("Open the file src/main.rs and show it to me.", "read_file", ["path"]),
    ("Query the users table for everyone signed up this year.", "run_sql", ["query"]),
    ("How many orders are in the orders table? Use SQL.", "run_sql", ["query"]),
    ("Is it raining in Sao Paulo right now?", "get_weather", ["city"]),
    ("Read package.json for me.", "read_file", ["path"]),
    ("Get the top 10 rows from the events table.", "run_sql", ["query"]),
    ("Tell me the temperature in Oslo in celsius.", "get_weather", ["city"]),
]


def call(prompt, tools):
    body = json.dumps(
        {
            "messages": [{"role": "user", "content": prompt}],
            "tools": tools,
            "tool_choice": "auto",
            "max_tokens": 2048,
            "temperature": 0,
        }
    ).encode()
    req = urllib.request.Request(
        f"{API}/chat/completions", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def check(prompt, want_tool, required, tools):
    """Returns (ok, tokens, problem_string_or_None)."""
    try:
        d = call(prompt, tools)
    except Exception as e:
        return False, 0, f"request failed: {e}"

    msg = d["choices"][0]["message"]
    used = d.get("usage", {}).get("completion_tokens", 0)
    calls = msg.get("tool_calls") or []

    problems = []
    if not calls:
        problems.append("no tool_call emitted")
    elif len(calls) > 1:
        problems.append(f"{len(calls)} tool calls (expected 1)")
    else:
        fn = calls[0].get("function", {})
        if fn.get("name") != want_tool:
            problems.append(f"wrong tool: {fn.get('name')!r} != {want_tool!r}")
        raw = fn.get("arguments", "")
        try:
            args = json.loads(raw) if isinstance(raw, str) else raw
            if not isinstance(args, dict):
                problems.append("arguments not a JSON object")
            else:
                for k in required:
                    if k not in args or args[k] in (None, ""):
                        problems.append(f"missing required arg {k!r}")
        except json.JSONDecodeError as e:
            problems.append(f"arguments not valid JSON ({e})")

    if used > RUNAWAY_TOKENS:
        problems.append(f"runaway: {used} tokens")

    return (not problems), used, ("; ".join(problems) if problems else None)


def run_battery(tools, verbose=True):
    passed, total_tokens = 0, 0
    for i, (prompt, want, required) in enumerate(CASES, 1):
        ok, used, problem = check(prompt, want, required, tools)
        total_tokens += used
        if ok:
            passed += 1
            if verbose:
                print(f"{i:2}. ok      {used:5} tok")
        else:
            if verbose:
                print(f"{i:2}. FAIL    {used:5} tok  {problem}")
    return passed, total_tokens


def approx_tool_tokens(tools):
    """Rough token cost of the tool block: ~4 chars/token over the serialized JSON."""
    return len(json.dumps(tools)) // 4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--sweep",
        help="comma-separated tool counts to sweep, e.g. 3,10,20,30,40",
    )
    args = ap.parse_args()

    if not args.sweep:
        passed, _ = run_battery(REAL_TOOLS)
        print(f"\ntool-call battery: {passed}/{len(CASES)} passed")
        return 0 if passed == len(CASES) else 1

    sizes = [int(x) for x in args.sweep.split(",") if x.strip()]
    print(f"{'TOOLS':>6} {'PASSED':>8} {'RATE':>7} {'TOOL_TOK':>9} {'GEN_TOK':>8}")
    print("-" * 44)
    rows = []
    for n in sizes:
        if n < len(REAL_TOOLS):
            print(f"  skip {n}: fewer than the {len(REAL_TOOLS)} real tools")
            continue
        tools = REAL_TOOLS + decoy_tools(n - len(REAL_TOOLS))
        passed, gen = run_battery(tools, verbose=False)
        rate = passed / len(CASES)
        rows.append((n, passed, rate, approx_tool_tokens(tools), gen))
        print(f"{n:>6} {passed:>5}/{len(CASES)} {rate:>6.0%} {approx_tool_tokens(tools):>9} {gen:>8}")

    print()
    best = max(rows, key=lambda r: (r[2], -r[0]))
    print(f"peak accuracy {best[2]:.0%} at {best[0]} tools")
    cliff = next((r for r in rows if r[2] < 0.8), None)
    if cliff:
        print(f"first drop below 80%: {cliff[0]} tools ({cliff[2]:.0%})")
    else:
        print("no drop below 80% within the swept range")
    return 0


if __name__ == "__main__":
    sys.exit(main())
