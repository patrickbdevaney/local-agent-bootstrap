#!/usr/bin/env python3
"""Tool-call battery for the local llama-server endpoint.

Fires N prompts that each should produce exactly one well-formed tool call, and
checks: a tool call was emitted, the tool name is one we defined, the arguments
parse as JSON and satisfy the declared required fields, and generation did not
run away (a proxy for looping).
"""

import json
import os
import sys
import urllib.request

API = os.environ.get("AGENT_API", "http://127.0.0.1:8090/v1")
RUNAWAY_TOKENS = int(os.environ.get("RUNAWAY_TOKENS", "1500"))

TOOLS = [
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


def call(prompt):
    body = json.dumps(
        {
            "messages": [{"role": "user", "content": prompt}],
            "tools": TOOLS,
            "tool_choice": "auto",
            "max_tokens": 2048,
            "temperature": 0,
        }
    ).encode()
    req = urllib.request.Request(
        f"{API}/chat/completions",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def main():
    passed = 0
    failures = []
    for i, (prompt, want_tool, required) in enumerate(CASES, 1):
        try:
            d = call(prompt)
        except Exception as e:
            failures.append(f"{i}. request failed: {e}")
            print(f"{i:2}. ERROR   {e}")
            continue

        choice = d["choices"][0]
        msg = choice["message"]
        used = d.get("usage", {}).get("completion_tokens", 0)
        calls = msg.get("tool_calls") or []

        problems = []
        if not calls:
            problems.append("no tool_call emitted")
        elif len(calls) > 1:
            problems.append(f"{len(calls)} tool calls emitted (expected 1)")
        else:
            fn = calls[0].get("function", {})
            name = fn.get("name")
            if name != want_tool:
                problems.append(f"wrong tool: got {name!r}, expected {want_tool!r}")
            raw = fn.get("arguments", "")
            try:
                args = json.loads(raw) if isinstance(raw, str) else raw
                if not isinstance(args, dict):
                    problems.append("arguments are not a JSON object")
                else:
                    for k in required:
                        if k not in args or args[k] in (None, ""):
                            problems.append(f"missing required arg {k!r}")
            except json.JSONDecodeError as e:
                problems.append(f"arguments are not valid JSON ({e})")

        if used > RUNAWAY_TOKENS:
            problems.append(f"runaway generation: {used} tokens > {RUNAWAY_TOKENS}")

        if problems:
            failures.append(f"{i}. {prompt!r}: " + "; ".join(problems))
            print(f"{i:2}. FAIL    {used:5} tok  {'; '.join(problems)}")
        else:
            passed += 1
            fn = calls[0]["function"]
            args_preview = fn["arguments"]
            if len(args_preview) > 60:
                args_preview = args_preview[:60] + "..."
            print(f"{i:2}. ok      {used:5} tok  {fn['name']}({args_preview})")

    print()
    print(f"tool-call battery: {passed}/{len(CASES)} passed")
    if failures:
        print("\nfailures:")
        for f in failures:
            print("  -", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
