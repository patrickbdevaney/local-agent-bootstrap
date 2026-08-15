#!/usr/bin/env python3
"""Prefix-cache instrumentation for llama-server.

Measured on this box: a 21k-token prompt costs 11,651 ms of prefill cold and
843 ms when the prefix is cached — 13.8x. So the single most useful thing to
watch in a long agent session is how often the prefix cache actually hits, and
what breaks it when it doesn't.

llama-server logs both signals:

    slot get_availabl: ... selected slot by LCP similarity, f_sim_best = 0.998 ... f_keep = 0.994
    slot print_timing: ... prompt eval time = 281.88 ms / 22 tokens (...)

`f_sim_best` is how much of the incoming prompt matched the cached one; the
prompt-eval token count is what actually had to be reprocessed. A healthy agent
turn reprocesses tens of tokens. A turn that reprocesses thousands means
something rewrote the prefix, and that is worth hunting down.

Usage:
  cache-stats.py                 # summarise the whole log
  cache-stats.py --last 50       # only the most recent 50 requests
  cache-stats.py --cold          # list the expensive reprocesses, newest last
"""

import argparse
import os
import re
import sys

DEFAULT_LOG = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs", "llama-server.log"
)

# Reprocessing more than this many tokens means the prefix was broken, not extended.
COLD_TOKENS = int(os.environ.get("CACHE_COLD_TOKENS", "500"))

RE_SIM = re.compile(r"^(\S+).*selected slot by LCP similarity, f_sim_best = ([\d.]+).*f_keep = ([\d.]+)")
RE_PROMPT = re.compile(
    r"^(\S+).*task (\d+) \| prompt eval time =\s*([\d.]+) ms /\s*(\d+) tokens"
)


def parse(path, last=None):
    """Pair each prompt-eval with the similarity line that preceded it."""
    events = []
    pending_sim = None
    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError as e:
        print(f"cannot read {path}: {e}", file=sys.stderr)
        return []
    with fh:
        for line in fh:
            m = RE_SIM.match(line)
            if m:
                pending_sim = (float(m.group(2)), float(m.group(3)))
                continue
            m = RE_PROMPT.match(line)
            if m:
                ts, task, ms, toks = m.group(1), int(m.group(2)), float(m.group(3)), int(m.group(4))
                sim, keep = pending_sim if pending_sim else (None, None)
                events.append(
                    {"ts": ts, "task": task, "ms": ms, "tokens": toks, "sim": sim, "keep": keep}
                )
                pending_sim = None
    return events[-last:] if last else events


def pct(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    i = max(0, min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1)))))
    return s[i]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--last", type=int, help="only the most recent N requests")
    ap.add_argument("--cold", action="store_true", help="list expensive reprocesses")
    args = ap.parse_args()

    ev = parse(args.log, args.last)
    if not ev:
        print("no prompt-eval events found — has the server served any requests?")
        return 1

    toks = [e["tokens"] for e in ev]
    mss = [e["ms"] for e in ev]
    sims = [e["sim"] for e in ev if e["sim"] is not None]
    cold = [e for e in ev if e["tokens"] >= COLD_TOKENS]

    print(f"requests analysed        {len(ev)}")
    print(f"reprocessed tokens       median {pct(toks,50):.0f}  p90 {pct(toks,90):.0f}  max {max(toks)}")
    print(f"prefill ms               median {pct(mss,50):.0f}  p90 {pct(mss,90):.0f}  max {max(mss):.0f}")
    if sims:
        print(f"prefix similarity        median {pct(sims,50):.3f}  p10 {pct(sims,10):.3f}")
    print(f"total prefill            {sum(mss)/1000:.1f} s over {sum(toks):,} reprocessed tokens")
    print()

    warm = len(ev) - len(cold)
    print(f"warm turns (<{COLD_TOKENS} tok)  {warm}/{len(ev)}  ({warm/len(ev):.0%})")
    print(f"cold turns (>={COLD_TOKENS} tok) {len(cold)}/{len(ev)}  ({len(cold)/len(ev):.0%})", end="")
    if cold:
        print(f"  costing {sum(e['ms'] for e in cold)/1000:.1f} s")
    else:
        print()

    if cold and not args.cold:
        print(f"\n{len(cold)} cold reprocess(es) — run with --cold to list them")

    if args.cold:
        print("\ncold reprocesses (prefix was broken, not extended):")
        print(f"  {'time':<16} {'task':>6} {'tokens':>8} {'ms':>8} {'sim':>6}")
        for e in cold:
            sim = f"{e['sim']:.3f}" if e["sim"] is not None else "  -  "
            print(f"  {e['ts']:<16} {e['task']:>6} {e['tokens']:>8} {e['ms']:>8.0f} {sim:>6}")
        print(
            "\nA cold turn mid-session means something rewrote the prompt prefix —"
            "\nswitching agents, a changed system prompt, or injected context at the front."
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
