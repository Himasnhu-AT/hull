#!/usr/bin/env python3
"""Multiplayer test driver: build an example/bin once, launch a server and N clients (each with
its own control port), run a script of steps against any of them, save screenshots, quit all.

  python3 -I scripts/net_play.py steps.json [--example net_demo | --bin NAME] [--features net]
        [--clients N] [--port 7777] [--listen] [--out DIR] [--no-build] [--id GAME_ID]
        [-- EXTRA GAME ARGS...]

The server runs `--server --port` (dedicated, headless) or, with --listen, `--host` offscreen.
Clients run `--connect 127.0.0.1:<port> --offscreen`. Every process gets `--control 0 --play
--mute` and its own data dir under DIR.

steps.json: a list of steps; "to" picks the process ("server", "client0", "client1", ...,
default "client0"; "all" = every process):
  {"sleep": 1.5}
  {"to": "server", "cmd": "net.clients"}
  {"to": "client0", "cmd": "net.conditioner", "params": {"latency_ms": 80, "loss": 0.1}}
  {"to": "client0", "cmd": "input.key", "params": {"key": "d", "action": "down"}}
  {"to": "client0", "shot": "name"}           -> DIR/client0-name.png
  {"wait": "client0", "cmd": "net.status", "field": "state", "value": "InGame"}  (≤ 30 s)
Every reply is printed as one JSON line prefixed with the process name.
"""
import json, os, re, shutil, socket, subprocess, sys, tempfile, time


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def build(args, root):
    sel = ["--example", opt(args, "--example")] if "--example" in args else ["--bin", opt(args, "--bin")]
    name = sel[1]
    cmd = ["cargo", "build", "--message-format=json-render-diagnostics"] + sel
    if "--features" in args:
        cmd += ["--features", opt(args, "--features")]
    if "--no-build" in args:
        meta = json.loads(subprocess.check_output(["cargo", "metadata", "--format-version", "1", "--no-deps"], cwd=root))
        return os.path.join(meta["target_directory"], "debug", "examples" if "--example" in args else "", name)
    out = subprocess.run(["memgate", "--"] + cmd, cwd=root, stdout=subprocess.PIPE, text=True)
    if out.returncode != 0:
        sys.exit(f"build failed ({out.returncode})")
    for line in out.stdout.splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("reason") == "compiler-artifact" and msg.get("executable") and msg["target"]["name"] == name:
            return msg["executable"]
    sys.exit(f"build produced no executable `{name}`")


class Proc:
    def __init__(self, name, exe, game_args, out, root, game_id):
        self.name = name
        data = os.path.join(out, name + "-data")
        os.makedirs(data, exist_ok=True)
        env = dict(os.environ)
        # The engine reads <ID>_DATA_DIR (ID = GameInfo id, uppercased, non-alnum -> _).
        env[re.sub(r"[^A-Za-z0-9]", "_", game_id).upper() + "_DATA_DIR"] = data
        self.log = open(os.path.join(out, name + ".log"), "w")
        cmd = ["memgate", "--", exe, "--control", "0", "--play", "--mute"] + game_args
        self.p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=self.log, text=True, cwd=root, env=env)
        self.port = self.key = None
        deadline = time.time() + 900
        while time.time() < deadline:
            line = self.p.stdout.readline()
            if not line:
                if self.p.poll() is not None:
                    sys.exit(f"{name} exited early; see {out}/{name}.log")
                continue
            m = re.search(r"control: port=(\d+) key=(.+)$", line)
            if m:
                self.port, self.key = int(m.group(1)), open(m.group(2).strip()).read().strip()
                break
        if self.port is None:
            self.p.kill()
            sys.exit(f"no `control:` line from {name}")
        self.f = socket.create_connection(("127.0.0.1", self.port)).makefile("rw")
        self.n = 0

    def call(self, command, params=None):
        self.n += 1
        req = {"id": self.n, "key": self.key, "method": "engine.execute", "params": {"command": command, "params": params or {}}}
        self.f.write(json.dumps(req) + "\n")
        self.f.flush()
        return json.loads(self.f.readline())

    def quit(self):
        try:
            self.call("engine.quit")
        except Exception:
            pass
        try:
            self.p.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.p.kill()


def main():
    args = sys.argv[1:]
    extra = args[args.index("--") + 1:] if "--" in args else []
    args = args[:args.index("--")] if "--" in args else args
    steps = json.load(open(args[0]))
    out = opt(args, "--out") or tempfile.mkdtemp(prefix="net-play-")
    os.makedirs(out, exist_ok=True)
    root = os.getcwd()
    port = opt(args, "--port", "7777")
    n = int(opt(args, "--clients", "1"))
    built = build(args, root)
    exe = os.path.join(out, os.path.basename(built))
    shutil.copy2(built, exe)

    game_id = opt(args, "--id") or ("engine-net-demo" if opt(args, "--example") == "net_demo" else os.path.basename(built))
    procs = {}
    try:
        if "--listen" in args:
            procs["server"] = Proc("server", exe, ["--host", port, "--offscreen"] + extra, out, root, game_id)
        else:
            procs["server"] = Proc("server", exe, ["--server", port] + extra, out, root, game_id)
        for i in range(n):
            procs[f"client{i}"] = Proc(f"client{i}", exe, ["--connect", f"127.0.0.1:{port}", "--offscreen"] + extra, out, root, game_id)
        for st in steps:
            if "sleep" in st:
                time.sleep(st["sleep"])
                continue
            if "wait" in st:
                p = procs[st["wait"]]
                for _ in range(120):
                    r = p.call(st["cmd"], st.get("params", {}))
                    if str((r.get("result") or {}).get(st["field"])) == str(st["value"]):
                        break
                    time.sleep(0.25)
                print(p.name, json.dumps(r)[:2000], flush=True)
                continue
            targets = list(procs.values()) if st.get("to") == "all" else [procs[st.get("to", "client0")]]
            for p in targets:
                if "shot" in st:
                    r = p.call(st.get("cmd", "screenshot"), {"path": os.path.join(out, f"{p.name}-{st['shot']}.png")})
                else:
                    r = p.call(st["cmd"], st.get("params", {}))
                print(p.name, json.dumps(r)[:2000], flush=True)
    finally:
        for p in reversed(list(procs.values())):
            p.quit()
    print(f"output: {out}")


main()
