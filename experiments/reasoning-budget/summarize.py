#!/usr/bin/env python3
"""Aggregate the per-run meta files in results/ into a per-cell summary."""

import glob
import os
import sys

RESULTS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "results")
CELLS = ["A-thinking-loose", "B-thinking-specific", "C-nothinking-specific"]

rows = []
for cell in CELLS:
    toks, times, maxc, passed = [], [], [], 0
    for f in sorted(glob.glob(os.path.join(RESULTS, cell + "-*.meta.txt"))):
        d = dict(l.strip().split("=", 1) for l in open(f) if "=" in l)
        toks.append(int(d["decode_tokens_total"]))
        times.append(int(d["elapsed_seconds"]))
        maxc.append(int(d["largest_single_completion"]))
        passed += d["verify_exit"] == "0"
    if toks:
        rows.append((cell, len(toks), sum(toks) // len(toks), min(toks), max(toks),
                     sum(times) // len(times), max(maxc), passed))

if not rows:
    print("no results found in", RESULTS)
    sys.exit(1)

hdr = ("CELL", "RUNS", "MEAN_TOK", "MIN_TOK", "MAX_TOK", "MEAN_S", "MAX_COMPL", "PASSED")
print("%-24s %5s %9s %8s %8s %7s %10s %8s" % hdr)
print("-" * 84)
for r in rows:
    print("%-24s %5d %9d %8d %8d %6ds %10d %8s"
          % (r[0], r[1], r[2], r[3], r[4], r[5], r[6], "%d/%d" % (r[7], r[1])))

base = next((r for r in rows if r[0].startswith("C-")), None)
if base and base[2]:
    print()
    for r in rows:
        if r[0] != base[0]:
            print("  %-24s %5.1fx the tokens, %4.1fx the wall time of %s"
                  % (r[0], r[2] / base[2], r[5] / max(base[5], 1), base[0]))
