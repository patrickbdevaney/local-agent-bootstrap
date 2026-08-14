# Agentic Engineering Projects

Short, self-contained software-engineering tasks run **by the local agent** to exercise the stack end to end. Results and analysis: [`../docs/AGENT_RUNS.md`](../docs/AGENT_RUNS.md).

## Running them

```bash
agent up                                    # llama-server must be live
./run-all.sh                                # all projects
./run-all.sh 02-bugfix-binary-search        # one project
```

Environment overrides:

```bash
AGENT_MODEL=local/qwen3.5-4b ./run-all.sh   # different model
AGENT_TIMEOUT=1800 ./run-all.sh             # longer per-project cap
```

## Layout

```
<NN>-<name>/
  seed/           starting state, copied into work/<name>/ before each run
  PROMPT.md       verbatim instruction given to the agent
  VERIFY.sh       checks run inside work/<name>/ afterwards; agent never sees it
run-all.sh        the harness
work/<name>/      the agent's working tree (recreated each run)
results/          per-project transcript, verify output, and metadata
```

## How the harness works

For each project it resets `work/<name>/` from `seed/`, `git init`s it so OpenCode can snapshot and diff, runs `opencode run` with `PROMPT.md` as the instruction, then runs `VERIFY.sh` inside the working tree and records wall time, exit codes, and per-check results.

## Writing a new project

1. `mkdir -p NN-name/seed` and put the starting files in `seed/` (may be empty).
2. Write `PROMPT.md` — the exact text handed to the agent.
3. Write `VERIFY.sh` — exits non-zero on failure, prints `  PASS  <label>` / `  FAIL  <label>` per check.

Two things learned the hard way, both from real failures:

- **Name what already exists and must not change.** A small model will invent missing context rather than ask. Project 01 initially overwrote its own input file because the prompt never said the file was already there.
- **Verify inputs as well as outputs.** Diff seed files that should be untouched. A suite that only checks outputs will pass a run that rewrote its fixtures — or that edited the tests instead of fixing the bug.

`VERIFY.sh` runs with `work/<name>/` as its working directory, so seed files are reachable at `../../<NN>-<name>/seed/`.
