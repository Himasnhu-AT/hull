#!/usr/bin/env python3
"""Run the engine's / a game's bench tests and compare results across commits.

  python3 -I scripts/bench.py run [--test devkit] [--filter bench] [--out DIR]
        [--manifest PATH] [--package P] [--features F] [--release]
      Runs `cargo test --test <t> <filter> -- --ignored` (through memgate) with
      ENGINE_BENCH_DIR=DIR/<commit>[-dirty]. Each bench test writes one JSON report
      (engine::devkit::BenchReport). Default DIR: target-bench/ in the cwd.

  python3 -I scripts/bench.py compare BASE NEW [--threshold 10] [--keys frame.ms,alloc.per_frame]
      BASE / NEW: a report .json, a folder of them, or a metrics sessions.jsonl (last run, or
      FILE@<session id>). Prints p50 / p95 per report and key with the change, and exits 1 if
      any p95 got worse by more than --threshold percent (every key is lower-is-better).

  python3 -I scripts/bench.py show PATH
      Prints the reports in PATH as a table.

Reports share the metrics history's stat shape: {"n","min","avg","p50","p95","p99","max"}.
"""
import json, os, subprocess, sys


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def git(*a):
    try:
        return subprocess.check_output(["git", *a], stderr=subprocess.DEVNULL, text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def load(path):
    """{report name: {key: stats}} from a report, a folder of reports, or sessions.jsonl."""
    out = {}
    if os.path.isdir(path):
        for name in sorted(os.listdir(path)):
            if name.endswith(".json"):
                out.update(load(os.path.join(path, name)))
        return out
    session = None
    if "@" in path and not os.path.exists(path):
        path, session = path.rsplit("@", 1)
    if path.endswith(".jsonl"):
        runs = [json.loads(l) for l in open(path) if l.strip()]
        if session:
            runs = [r for r in runs if r.get("id") == session]
        if not runs:
            sys.exit(f"no session in {path}" + (f" with id {session}" if session else ""))
        r = runs[-1]
        labels = ",".join(f"{k}={v}" for k, v in sorted((r.get("labels") or {}).items()))
        name = f"{r.get('game', 'game')}[{r.get('mode', '')}{',' + labels if labels else ''}]"
        out[name] = r.get("keys", {})
        return out
    r = json.load(open(path))
    out[r.get("name") or os.path.basename(path)] = {**r.get("metrics", {}), **{k: {"p50": v, "p95": v} for k, v in r.get("values", {}).items()}}
    return out


def pct(a, b):
    return (b - a) / a * 100.0 if a else 0.0


def cmd_run(args):
    out = opt(args, "--out", "target-bench")
    commit = git("rev-parse", "--short", "HEAD") or "nogit"
    if git("status", "--porcelain", "--untracked-files=no"):
        commit += "-dirty"
    dest = os.path.abspath(os.path.join(out, commit))
    os.makedirs(dest, exist_ok=True)
    cmd = ["memgate", "--", "cargo", "test"]
    if "--manifest" in args:
        cmd += ["--manifest-path", opt(args, "--manifest")]
    if "--package" in args:
        cmd += ["-p", opt(args, "--package")]
    if "--features" in args:
        cmd += ["--features", opt(args, "--features")]
    if "--release" in args:
        cmd.append("--release")
    cmd += ["--test", opt(args, "--test", "devkit"), opt(args, "--filter", "bench"), "--", "--ignored", "--nocapture", "--test-threads=1"]
    env = dict(os.environ, ENGINE_BENCH_DIR=dest)
    print("+", " ".join(cmd), file=sys.stderr)
    rc = subprocess.call(cmd, env=env)
    if rc != 0:
        sys.exit(rc)
    print(f"reports: {dest}")
    cmd_show([dest])


def cmd_show(args):
    for name, keys in load(args[0]).items():
        print(name)
        for k, s in sorted(keys.items()):
            print(f"  {k:28} p50 {s.get('p50', 0):10.4f}  p95 {s.get('p95', 0):10.4f}  max {s.get('max', s.get('p95', 0)):10.4f}")


def cmd_compare(args):
    if len(args) < 2:
        sys.exit(__doc__)
    base, new = load(args[0]), load(args[1])
    threshold = float(opt(args, "--threshold", "10"))
    only = set(filter(None, (opt(args, "--keys", "") or "").split(",")))
    worse = []
    # A single report on each side compares even when names differ (e.g. two sessions).
    pairs = [(n, base[n], new[n]) for n in sorted(base) if n in new]
    if not pairs and len(base) == 1 and len(new) == 1:
        (bn, b), (nn, n) = next(iter(base.items())), next(iter(new.items()))
        pairs = [(f"{bn} -> {nn}", b, n)]
    if not pairs:
        sys.exit("nothing to compare (no report names in common)")
    for name, b, n in pairs:
        print(name)
        for k in sorted(set(b) & set(n)):
            if only and k not in only:
                continue
            b50, b95, n50, n95 = b[k].get("p50", 0), b[k].get("p95", 0), n[k].get("p50", 0), n[k].get("p95", 0)
            d95 = pct(b95, n95)
            mark = "  "
            if d95 > threshold:
                mark = "!!"
                worse.append(f"{name} {k} p95 {b95:.4f} -> {n95:.4f} (+{d95:.1f}%)")
            elif d95 < -threshold:
                mark = "++"
            print(f" {mark} {k:28} p50 {b50:10.4f} -> {n50:10.4f} ({pct(b50, n50):+6.1f}%)   p95 {b95:10.4f} -> {n95:10.4f} ({d95:+6.1f}%)")
    if worse:
        print(f"\n{len(worse)} regression(s) over {threshold}%:", *worse, sep="\n  ")
        sys.exit(1)
    print("\nno regressions over", f"{threshold}%")


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return
    {"run": cmd_run, "compare": cmd_compare, "show": cmd_show}.get(args[0], lambda _: sys.exit(__doc__))(args[1:])


main()
