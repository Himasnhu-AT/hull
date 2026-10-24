#!/usr/bin/env python3
"""Launch a game built on the engine under memgate with the control port, run a script of
commands, save screenshots, quit. For tests and visual checks; never grabs the mouse, never
plays sound (unless --sound).

  python3 -I scripts/play.py steps.json [--bin NAME | --example NAME] [--manifest PATH]
        [--package P] [--features F] [--headless | --onscreen] [--menu] [--out DIR] [--seed N]
        [--no-build] [--id GAME_ID] [--ready CMD:FIELD=VALUE] [--sound] [-- GAME ARGS...]

Builds the target first (via memgate) and runs a private copy of the binary (the shared target
dir means another worktree's build can overwrite it at any moment).

Target: --bin / --example in the package at --manifest (default ./Cargo.toml). Without either,
the one executable the build produces, or the one named like the manifest's folder (Shroud's
old `play.py steps.json` keeps working from its repo root), or $PLAY_BIN.

Default is --offscreen: hidden window, cameras render to an image, so screenshots work even
when another app is fullscreen. --onscreen shows the window; --headless has no window (no
screenshots). Runs pass --play (skip the main menu) unless --menu.

The data dir is DIR/data through <ID>_DATA_DIR (ID = --id, else the binary name, uppercased).

Before the steps it waits until the game is ready: --ready CMD:FIELD=VALUE, default
`engine.state:state=InGame` (or `MainMenu` with --menu). Builds without the engine commands
(e.g. Shroud before its port) fall back to `game.state:state=Playing`, `capture.screenshot`
and `game.quit`.

steps.json: a list of steps, each one of
  {"sleep": 2.5}
  {"cmd": "input.key", "params": {"key": "w", "action": "down"}}
  {"shot": "name"}            -> DIR/name.png (windowed / offscreen only)
  {"shot": "name", "cmd": "metrics.screenshot"}  -> same through another screenshot command
Every reply is printed as one JSON line.
"""
import json, os, re, shutil, socket, subprocess, sys, tempfile, time


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def find_exe(args, root, manifest):
    """Build (unless --no-build) and return the executable's path."""
    sel, name = None, None
    if "--bin" in args:
        sel, name = ["--bin", opt(args, "--bin")], opt(args, "--bin")
    elif "--example" in args:
        sel, name = ["--example", opt(args, "--example")], opt(args, "--example")
    cmd = ["cargo", "build", "--message-format=json-render-diagnostics", "--manifest-path", manifest]
    if "--package" in args:
        cmd += ["-p", opt(args, "--package")]
    if "--features" in args:
        cmd += ["--features", opt(args, "--features")]
    cmd += sel or []
    if "--no-build" in args:
        meta = json.loads(subprocess.check_output(
            ["cargo", "metadata", "--format-version", "1", "--no-deps", "--manifest-path", manifest], cwd=root))
        name = name or os.environ.get("PLAY_BIN") or os.path.basename(os.path.dirname(os.path.abspath(manifest)))
        sub = "examples" if "--example" in args else ""
        return os.path.join(meta["target_directory"], "debug", sub, name)
    out = subprocess.run(["memgate", "--"] + cmd, cwd=root, stdout=subprocess.PIPE, text=True)
    if out.returncode != 0:
        sys.exit(f"build failed ({out.returncode})")
    exes = {}
    for line in out.stdout.splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("reason") == "compiler-artifact" and msg.get("executable"):
            kinds = msg["target"]["kind"]
            if "bin" in kinds or "example" in kinds:
                exes[msg["target"]["name"]] = msg["executable"]
    if name:
        if name not in exes:
            sys.exit(f"build produced no executable `{name}` (got {sorted(exes)})")
        return exes[name]
    if len(exes) == 1:
        return next(iter(exes.values()))
    for guess in (os.environ.get("PLAY_BIN"), os.path.basename(os.path.dirname(os.path.abspath(manifest)))):
        if guess in exes:
            return exes[guess]
    sys.exit(f"several executables {sorted(exes)}: pick one with --bin / --example (or $PLAY_BIN)")


class Port:
    def __init__(self, port, key):
        self.f = socket.create_connection(("127.0.0.1", port)).makefile("rw")
        self.key, self.n = key, 0

    def call(self, command, params=None):
        self.n += 1
        req = {"id": self.n, "key": self.key, "method": "engine.execute",
               "params": {"command": command, "params": params or {}}}
        self.f.write(json.dumps(req) + "\n")
        self.f.flush()
        return json.loads(self.f.readline())


def main():
    args = sys.argv[1:]
    extra = args[args.index("--") + 1:] if "--" in args else []
    args = args[:args.index("--")] if "--" in args else args
    steps = json.load(open(args[0]))
    headless = "--headless" in args
    menu = "--menu" in args
    out = opt(args, "--out") or tempfile.mkdtemp(prefix="play-")
    seed = opt(args, "--seed", "1")
    os.makedirs(out, exist_ok=True)
    root = os.getcwd()
    manifest = opt(args, "--manifest", os.path.join(root, "Cargo.toml"))

    built = find_exe(args, root, manifest)
    exe = os.path.join(out, os.path.basename(built))
    shutil.copy2(built, exe)
    game_id = opt(args, "--id") or os.path.basename(built)
    env_id = re.sub(r"[^A-Za-z0-9]", "_", game_id).upper()

    cmd = ["memgate", "--", exe, "--control", "0", "--seed", seed]
    if headless:
        cmd.append("--headless")
    if not menu:
        cmd.append("--play")
    if "--sound" not in args:
        cmd.append("--mute")  # never make noise (the user may be in a meeting)
    if not headless and "--onscreen" not in args:
        cmd.append("--offscreen")
    cmd += extra
    env = dict(os.environ)
    env.setdefault(f"{env_id}_DATA_DIR", os.path.join(out, "data"))
    log = open(os.path.join(out, "game.log"), "w")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=log, text=True, cwd=root, env=env)
    port = key = None
    deadline = time.time() + 900  # memgate may queue us
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                sys.exit(f"game exited early; see {out}/game.log")
            continue
        m = re.search(r"control: port=(\d+) key=(.+)$", line)
        if m:
            port, key = int(m.group(1)), open(m.group(2).strip()).read().strip()
            break
    if port is None:
        proc.kill()
        sys.exit("no `control:` line from the game")

    c = Port(port, key)
    ready = opt(args, "--ready", "engine.state:state=" + ("MainMenu" if menu else "InGame"))
    shot_cmd, quit_cmd = "screenshot", "engine.quit"
    if not c.call("engine.state").get("ok"):
        # A build without the engine's commands (Shroud before its port).
        if "--ready" not in args:
            ready = "game.state:state=Playing"
        shot_cmd, quit_cmd = "capture.screenshot", "game.quit"
    ready_cmd, cond = ready.split(":", 1)
    field, want = cond.split("=", 1)
    try:
        # Wait until ready (first windowed frames can be slow while shaders compile; commands
        # sent before a round starts can get undone by its reset).
        for _ in range(240):
            st = c.call(ready_cmd).get("result") or {}
            if str(st.get(field)) == want and (st.get("frame") or 31) > 30:
                break
            time.sleep(0.5)
        else:
            print(f"warning: never saw {ready}", file=sys.stderr)
        time.sleep(1)
        for st in steps:
            if "sleep" in st:
                time.sleep(st["sleep"])
                continue
            if "shot" in st:
                r = c.call(st.get("cmd", shot_cmd), {"path": os.path.join(out, st["shot"] + ".png")})
            else:
                r = c.call(st["cmd"], st.get("params", {}))
            print(json.dumps(r)[:2000], flush=True)
        c.call(quit_cmd)
    finally:
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
    print(f"output: {out}")


main()
