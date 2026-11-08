#!/usr/bin/env python3
"""Co-op session test driver: builds `coop_demo` and the `relay` bin once, starts a relay, a host
(`--host-session`) and a guest (`--join <code from the host>`), runs steps against either, saves
screenshots, quits all.

  python3 -I scripts/coop_play.py steps.json [--out DIR] [--relay-port 7788] [--force-relay]

steps.json: like net_play.py, with "to" = "host" | "guest" (default "guest"; "all" = both):
  {"sleep": 1.5}
  {"to": "host", "cmd": "session.status"}
  {"to": "guest", "shot": "name"}                          -> DIR/guest-name.png
  {"wait": "guest", "cmd": "session.status", "field": "phase", "value": "InSession"}   (<= 30 s)
The build runs through memgate; the run itself is one more memgate job holding the relay, host and
guest (so it needs one free slot). Every reply is printed as one JSON line prefixed with the
process name. The guest starts after
the host reports its invite code (the `{"wait": "host", ...}` step is implicit).
"""
import json, os, re, shutil, socket, subprocess, sys, tempfile, time


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def build(args, root, sel):
    name = sel[1]
    cmd = ["cargo", "build", "--message-format=json-render-diagnostics"] + sel
    cmd += ["--features", "net"]
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
        cmd = [exe, "--control", "0", "--play", "--mute"] + game_args
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
    steps = json.load(open(args[0]))
    out = opt(args, "--out") or tempfile.mkdtemp(prefix="coop-play-")
    os.makedirs(out, exist_ok=True)
    root = os.getcwd()
    rport = opt(args, "--relay-port", "7788")
    if os.environ.get("COOP_PLAY_EXES"):
        demo, relay = os.environ["COOP_PLAY_EXES"].split("|")
    else:
        # Build through memgate, then re-run this script as ONE memgate job: relay, host and guest
        # share that slot (the game processes themselves are not queued, or the guest would wait
        # behind unrelated jobs while the host holds a slot).
        demo = build(args, root, ["--example", "coop_demo"])
        relay = build(args, root, ["--bin", "relay"])
        os.environ["COOP_PLAY_EXES"] = f"{demo}|{relay}"
        os.execvp("memgate", ["memgate", "--", sys.executable, "-I", os.path.abspath(__file__)] + sys.argv[1:] + ["--out", out])
    exe = os.path.join(out, "coop_demo")
    shutil.copy2(demo, exe)
    extra = ["--relay", f"127.0.0.1:{rport}"] + (["--force-relay"] if "--force-relay" in args else [])
    procs = {}
    relay_p = subprocess.Popen([relay, f"127.0.0.1:{rport}"], stdout=open(os.path.join(out, "relay.log"), "w"), stderr=subprocess.STDOUT)
    try:
        time.sleep(0.5)
        procs["host"] = Proc("host", exe, ["--host-session", "--name", "Host", "--offscreen"] + extra, out, root, "engine-coop-demo")
        code = None
        for _ in range(60):
            r = procs["host"].call("session.status")
            code = (r.get("result") or {}).get("code")
            if code:
                break
            time.sleep(0.25)
        if not code:
            sys.exit("host never got an invite code")
        print("invite code", code, flush=True)
        procs["guest"] = Proc("guest", exe, ["--join", code, "--name", "Guest", "--offscreen"] + extra, out, root, "engine-coop-demo")
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
            targets = list(procs.values()) if st.get("to") == "all" else [procs[st.get("to", "guest")]]
            for p in targets:
                if "shot" in st:
                    r = p.call(st.get("cmd", "screenshot"), {"path": os.path.join(out, f"{p.name}-{st['shot']}.png")})
                else:
                    r = p.call(st["cmd"], st.get("params", {}))
                print(p.name, json.dumps(r)[:2000], flush=True)
    finally:
        for p in reversed(list(procs.values())):
            p.quit()
        relay_p.kill()
    print(f"output: {out}")


main()
