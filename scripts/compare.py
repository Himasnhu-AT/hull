#!/usr/bin/env python3
"""Run matched benchmark scenes in this engine and in Godot, measured the same way.

  python3 -I scripts/compare.py [--scenes cubes,lights,physics] [--secs 10] [--warmup 3] [--release] [--fps 60]
        [--godot /Applications/Godot_4.4.app/Contents/MacOS/Godot] [--no-build] [--out DIR]

Scenes: examples/bench_compare.rs (ours) and bench/godot/main.gd (Godot) build the same thing:
1920x1080, vsync off, no post effects. Each engine reports its own frame times (BENCH line);
this script measures both processes from outside with the same tools:
- GPU: this process's accumulated GPU time from IOKit (`ioreg`, AGX user clients' AppUsage),
  sampled every 0.5 s: GPU ms per frame = GPU time in the window / frames in the window.
- Memory: peak resident size (`ps -o rss`) during the measured window.
- Startup: launch -> first frame (READY line), wall clock.
Both open a 1920x1080 window at scale factor 1. Ours is built like a shipped game (no devtools).
macOS holds a window to the display refresh whatever the app asks (Godot shows 120 Hz), so
frame rates aren't comparable: compare the work per frame, CPU ms (all threads, `ps cputime`)
and GPU ms, measured the same way for both.
Runs directly (not through memgate): it measures performance.
"""
import json, os, re, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def gpu_ns(pid):
    """Accumulated GPU time (ns) of `pid` from the IOAccelerator user clients."""
    try:
        out = subprocess.check_output(["ioreg", "-r", "-c", "IOAccelerator", "-l", "-w0", "-d", "3"], text=True, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError):
        return None
    total, found = 0, False
    for block in out.split("+-o"):
        m = re.search(r'"IOUserClientCreator" = "pid (\d+),', block)
        if not m or int(m.group(1)) != pid:
            continue
        for v in re.findall(r'"accumulatedGPUTime"=(\d+)', block):
            total += int(v)
            found = True
    return total if found else None


def cpu_s(pid):
    """Total CPU time (all threads) of `pid`, seconds."""
    try:
        t = subprocess.check_output(["ps", "-o", "cputime=", "-p", str(pid)], text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    parts = [float(x) for x in re.split("[:]", t.replace("-", ":")) if x]
    s = 0.0
    for x in parts:
        s = s * 60 + x
    return s


def rss_mb(pid):
    try:
        return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(pid)], text=True).strip() or 0) / 1024.0
    except (OSError, subprocess.CalledProcessError, ValueError):
        return None


def run(cmd, warmup, cwd):
    t0 = time.time()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=cwd)
    samples = []  # (t, gpu_ns, rss, cpu_s)
    stop = threading.Event()
    ready = [None]
    bench = [None]

    def sampler():
        while not stop.is_set():
            samples.append((time.time(), gpu_ns(p.pid), rss_mb(p.pid), cpu_s(p.pid)))
            stop.wait(0.5)

    th = threading.Thread(target=sampler, daemon=True)
    th.start()
    for line in p.stdout:
        line = line.strip()
        if line == "READY" and ready[0] is None:
            ready[0] = time.time()
        elif line.startswith("BENCH "):
            bench[0] = (time.time(), json.loads(line[6:]))
    p.wait()
    stop.set()
    th.join()
    if not bench[0] or not ready[0]:
        return None
    t_end, b = bench[0]
    # The measured window: from warm-up end to the BENCH line.
    win = [s for s in samples if ready[0] + warmup <= s[0] <= t_end and s[1] is not None]
    if len(win) >= 2:
        dt = win[-1][0] - win[0][0]
        busy = (win[-1][1] - win[0][1]) / 1e9 / dt if dt > 0 else 0.0
        b["gpu_busy_pct"] = round(busy * 100.0, 1)
        b["gpu_ms"] = round(busy * b["avg_ms"], 3)
        if win[0][3] is not None and win[-1][3] is not None and dt > 0:
            cores = (win[-1][3] - win[0][3]) / dt
            b["cpu_cores"] = round(cores, 2)
            b["cpu_ms"] = round(cores * b["avg_ms"], 3)
    rs = [s[2] for s in win if s[2]]
    if rs:
        b["rss_mb"] = round(max(rs), 1)
    b["startup_s"] = round(ready[0] - t0, 3)
    return b


def main():
    args = sys.argv[1:]
    scenes = opt(args, "--scenes", "cubes,lights,physics").split(",")
    secs, warmup = opt(args, "--secs", "10"), opt(args, "--warmup", "3")
    godot = opt(args, "--godot", "/Applications/Godot_4.4.app/Contents/MacOS/Godot")
    out_dir = opt(args, "--out", os.path.join(ROOT, "bench", "results"))
    os.makedirs(out_dir, exist_ok=True)
    release = "--release" in args
    if "--no-build" not in args:
        build = ["memgate", "--profile", "release", "--", "cargo", "build", "-q", "--release"] if release else ["memgate", "--", "cargo", "build", "-q"]
        # Like a shipped game: no devtools (perf sampler, control port).
        subprocess.run([*build, "--example", "bench_compare", "--no-default-features", "--features", "physics"], cwd=ROOT, check=True)
    target = subprocess.check_output(["cargo", "metadata", "--format-version", "1", "--no-deps"], cwd=ROOT, text=True)
    ours = os.path.join(json.loads(target)["target_directory"], "release" if release else "debug", "examples", "bench_compare")
    fps = opt(args, "--fps", "0")
    common = ["--scene", None, "--secs", secs, "--warmup", warmup]
    results = []
    for scene in scenes:
        a = list(common)
        a[1] = scene
        for name, cmd, cwd in [
            ("ours", [ours, *a, "--fps", fps], ROOT),
            ("godot", [godot, "--disable-vsync", "--max-fps", fps, "--path", os.path.join(ROOT, "bench", "godot"), "--", *a], ROOT),
        ]:
            print(f"== {scene} / {name}", file=sys.stderr, flush=True)
            r = run(cmd, float(warmup), cwd)
            print(json.dumps(r), flush=True)
            if r:
                results.append(r)
            time.sleep(2)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    with open(os.path.join(out_dir, f"compare-{stamp}.json"), "w") as f:
        json.dump(results, f, indent=1)
    rows = ["| scene | engine | frame ms (avg / p95) | CPU cores busy | CPU ms/frame (all threads) | GPU ms/frame | RSS MB | startup s |", "|---|---|---|---|---|---|---|---|"]
    for r in results:
        rows.append(f"| {r['scene']} | {r['engine']} | {r['avg_ms']} / {r['p95_ms']} | {r.get('cpu_cores', '-')} | {r.get('cpu_ms', '-')} | {r.get('gpu_ms', '-')} | {r.get('rss_mb', '-')} | {r['startup_s']} |")
    table = "\n".join(rows)
    with open(os.path.join(out_dir, f"compare-{stamp}.md"), "w") as f:
        f.write(table + "\n")
    print(table)


main()
