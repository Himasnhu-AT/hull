#!/usr/bin/env python3
"""Scene benchmarks: run the example scenes offscreen at full speed, sample the engine's
metrics, write one report per scene, and compare with the previous run.

  python3 -I scripts/perf_suite.py run [--scenes a,b] [--secs 20] [--warmup 8] [--out DIR]
        [--features F] [--no-build] [--threshold 15] [--base DIR|none]
  python3 -I scripts/perf_suite.py list

run: builds the examples once (through memgate), then for each scene launches the binary with
`--control 0 --offscreen --uncapped --play --mute --seed 1` (+ the scene's own args), waits
until it is in game, runs the scene's setup commands, waits --warmup seconds, then reads
`metrics.dump` once a second for --secs seconds. Each key's 1 s samples become one stat
({n,min,avg,p50,p95,p99,max}); `perf.stats` adds the last ~600 frames' percentiles as
`frame.ring_ms`. Reports go to DIR/<commit>[-dirty]/scene.<name>.json (default DIR:
target-bench), in the shape `scripts/bench.py` reads (it also holds the headless CPU benches).

After the run it prints a table and compares with --base (default: the newest other run in
DIR that has scene reports) on the keys that matter (frame time, GPU time per frame, main
thread CPU, memory), and exits 1 if any p95 got worse by more than --threshold percent.
Numbers come from a shared, busy machine: re-run a scene before trusting a small change.
"""
import json, os, re, shutil, socket, subprocess, sys, time

# name: (example, args, setup commands, description)
SCENES = {
    "look_low": ("look_showcase", ["--quality", "low", "--pose", "outdoor"], [], "lighting showcase, Low tier, clear day"),
    "look_high": ("look_showcase", ["--quality", "high", "--pose", "outdoor"], [], "lighting showcase, High tier, clear day"),
    "look_ultra": ("look_showcase", ["--quality", "ultra", "--pose", "outdoor"], [], "lighting showcase, Ultra tier (SSR, realtime probe)"),
    "look_dusk": ("look_showcase", ["--quality", "high", "--pose", "outdoor", "--look", "dusk"], [], "dusk look (low sun, volumetrics, grading)"),
    "open_world": ("open_world", ["--pose", "fly"], [], "4x4 km terrain, scatter, streaming while flying"),
    "render_budget": ("render_budget", [], [], "4000-prop town, culling / LOD budget"),
    "ai_crowd": ("ai_crowd", [], [], "navmesh crowd with behaviour trees and perception"),
    "anim_demo": ("anim_demo", [], [], "animated characters: state machines, IK, LOD"),
    "vfx_gallery": ("vfx_gallery", [], [], "every particle preset looping"),
    "vfx_stress": ("vfx_gallery", ["--stress", "100000"], [], "100k CPU particles"),
    "sound_demo": ("sound_demo", [], [], "mixer, 3D voices, occlusion, music"),
    "ui_gallery": ("ui_gallery", [], [], "UI kit screens"),
}

# Keys compared across runs (lower is better).
WATCH = ["frame.ms", "frame.p95_ms", "frame.p99_ms", "gpu.frame_ms", "cpu.main_pct", "cpu.render_pct", "mem.footprint_mb"]


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def git(*a):
    try:
        return subprocess.check_output(["git", *a], stderr=subprocess.DEVNULL, text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def stats(xs):
    xs = sorted(x for x in xs if isinstance(x, (int, float)))
    if not xs:
        return None
    pick = lambda q: xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]
    r = lambda v: round(float(v), 4)
    return {"n": len(xs), "min": r(xs[0]), "avg": r(sum(xs) / len(xs)), "p50": r(pick(0.5)), "p95": r(pick(0.95)), "p99": r(pick(0.99)), "max": r(xs[-1])}


def build(examples, features):
    cmd = ["memgate", "--", "cargo", "build", "--message-format=json-render-diagnostics"]
    if features:
        cmd += ["--features", features]
    for e in examples:
        cmd += ["--example", e]
    print("+", " ".join(cmd), file=sys.stderr)
    out = subprocess.run(cmd, stdout=subprocess.PIPE, text=True)
    if out.returncode != 0:
        sys.exit(f"build failed ({out.returncode})")
    exes = {}
    for line in out.stdout.splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("reason") == "compiler-artifact" and m.get("executable"):
            exes[m["target"]["name"]] = m["executable"]
    return exes


def prebuilt(examples):
    meta = json.loads(subprocess.check_output(["cargo", "metadata", "--format-version", "1", "--no-deps"]))
    return {e: os.path.join(meta["target_directory"], "debug", "examples", e) for e in examples}


class Port:
    def __init__(self, port, key):
        self.f = socket.create_connection(("127.0.0.1", port)).makefile("rw")
        self.key, self.n = key, 0

    def call(self, command, params=None):
        self.n += 1
        self.f.write(json.dumps({"id": self.n, "key": self.key, "method": "engine.execute",
                                 "params": {"command": command, "params": params or {}}}) + "\n")
        self.f.flush()
        return json.loads(self.f.readline())


def run_scene(name, exe, out, secs, warmup):
    example, args, setup, _ = SCENES[name]
    d = os.path.join(out, "runs", name)
    os.makedirs(d, exist_ok=True)
    local = os.path.join(d, os.path.basename(exe))
    shutil.copy2(exe, local)  # the shared target dir can be rebuilt under us
    env = dict(os.environ)
    env[re.sub(r"[^A-Za-z0-9]", "_", example).upper() + "_DATA_DIR"] = os.path.join(d, "data")
    cmd = ["memgate", "--", local, "--control", "0", "--offscreen", "--uncapped", "--play", "--mute", "--seed", "1", *args]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=open(os.path.join(d, "game.log"), "w"), text=True, env=env)
    try:
        port = None
        deadline = time.time() + 900  # memgate may queue us
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line and proc.poll() is not None:
                raise RuntimeError(f"exited early (see {d}/game.log)")
            m = re.search(r"control: port=(\d+) key=(.+)$", line or "")
            if m:
                port = Port(int(m.group(1)), open(m.group(2).strip()).read().strip())
                break
        if port is None:
            raise RuntimeError("no control line")
        for _ in range(240):
            st = port.call("engine.state").get("result") or {}
            if st.get("state") == "InGame" and (st.get("frame") or 0) > 30:
                break
            time.sleep(0.5)
        for c in setup:
            port.call(c["cmd"], c.get("params"))
        time.sleep(warmup)
        samples = {}
        t_end = time.time() + secs
        while time.time() < t_end:
            t0 = time.time()
            keys = (port.call("metrics.dump").get("result") or {}).get("keys", {})
            for k, v in keys.items():
                if isinstance(v.get("now"), (int, float)):
                    samples.setdefault(k, []).append(v["now"])
            time.sleep(max(0.0, 1.0 - (time.time() - t0)))
        ring = (port.call("perf.stats").get("result") or {}).get("frame_ms") or {}
        port.call("engine.quit")
    finally:
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
    metrics = {k: s for k, xs in samples.items() if (s := stats(xs))}
    if ring:
        metrics["frame.ring_ms"] = {"n": 600, **{k: round(v, 4) for k, v in ring.items() if isinstance(v, (int, float))}}
    return metrics


def table(reports):
    def g(m, k, f="p50"):
        v = m.get(k, {}).get(f)
        return "-" if v is None else f"{v:.1f}"
    hdr = f"{'scene':18} {'fps':>6} {'frame p50':>9} {'p95':>6} {'p99':>6} {'gpu ms':>7} {'main %':>7} {'render %':>8} {'mem MB':>7} {'entities':>8} {'hitches':>7}"
    print(hdr)
    print("-" * len(hdr))
    for name, m in reports.items():
        ring = m.get("frame.ring_ms", {})
        p = lambda k: "-" if ring.get(k) is None else f"{ring[k]:.1f}"
        print(f"{name:18} {g(m, 'frame.fps'):>6} {p('p50'):>9} {p('p95'):>6} {p('p99'):>6} {g(m, 'gpu.frame_ms'):>7} {g(m, 'cpu.main_pct'):>7} "
              f"{g(m, 'cpu.render_pct'):>8} {g(m, 'mem.footprint_mb'):>7} {g(m, 'ecs.entities'):>8} {g(m, 'frame.hitches', 'max'):>7}")


def previous_run(out, current):
    runs = []
    for name in os.listdir(out) if os.path.isdir(out) else []:
        p = os.path.join(out, name)
        if p != current and os.path.isdir(p) and any(f.startswith("scene.") for f in os.listdir(p)):
            runs.append((os.path.getmtime(p), p))
    return max(runs)[1] if runs else None


def cmd_run(args):
    names = (opt(args, "--scenes") or ",".join(SCENES)).split(",")
    for n in names:
        if n not in SCENES:
            sys.exit(f"unknown scene `{n}` (see `perf_suite.py list`)")
    secs, warmup = float(opt(args, "--secs", "20")), float(opt(args, "--warmup", "8"))
    root = os.path.abspath(opt(args, "--out", "target-bench"))
    commit = git("rev-parse", "--short", "HEAD") or "nogit"
    if git("status", "--porcelain", "--untracked-files=no"):
        commit += "-dirty"
    out = os.path.join(root, commit)
    os.makedirs(out, exist_ok=True)
    examples = sorted({SCENES[n][0] for n in names})
    exes = prebuilt(examples) if "--no-build" in args else build(examples, opt(args, "--features"))
    reports = {}
    for n in names:
        print(f"[{n}] {SCENES[n][3]}", file=sys.stderr, flush=True)
        try:
            metrics = run_scene(n, exes[SCENES[n][0]], out, secs, warmup)
        except Exception as e:  # keep going: one broken scene shouldn't hide the rest
            print(f"[{n}] FAILED: {e}", file=sys.stderr)
            continue
        report = {"name": f"scene.{n}", "commit": commit, "profile": "dev", "unix_time": int(time.time()),
                  "frames": 0, "metrics": metrics, "values": {},
                  "scene": {"example": SCENES[n][0], "args": SCENES[n][1], "secs": secs, "warmup": warmup}}
        with open(os.path.join(out, f"scene.{n}.json"), "w") as f:
            json.dump(report, f, indent=1)
        reports[f"scene.{n}"] = metrics
    print(f"\nreports: {out}\n")
    table(reports)
    base = opt(args, "--base")
    if base == "none":
        return
    base = base or previous_run(root, out)
    if not base:
        print("\nno earlier run to compare with (this one is the baseline)")
        return
    print(f"\ncompare with {base}:")
    rc = subprocess.call([sys.executable, "-I", os.path.join(os.path.dirname(os.path.abspath(__file__)), "bench.py"), "compare",
                          base, out, "--threshold", opt(args, "--threshold", "15"), "--keys", ",".join(WATCH)])
    sys.exit(rc)


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
    elif args[0] == "list":
        for n, (ex, a, _, desc) in SCENES.items():
            print(f"{n:15} {ex} {' '.join(a):40} {desc}")
    elif args[0] == "run":
        cmd_run(args[1:])
    else:
        sys.exit(__doc__)


main()
