#!/usr/bin/env python3
"""Metrics history you can read with the game closed: one HTML page from a game's data dir.

  python3 -I scripts/metrics_report.py GAME [--data DIR] [--out FILE] [--no-open] [--last N]

GAME is the data-dir name (e.g. pacenote, shroud). The data dir defaults to the engine's
(macOS ~/Library/Application Support/GAME, Linux ~/.local/share/GAME, Windows %APPDATA%/GAME),
or GAME_DATA_DIR (upper-case) when set, or --data.

Reads what every run already writes:
- metrics/sessions.jsonl: one summary per run (each metric's n/min/avg/p50/p95/max),
- logs/session-<id>.jsonl: the run's perf samples (about one a second) and events (state
  changes, quality governor steps, hitches, pause).

Writes metrics/report.html (self-contained, no network) and opens it. The page has:
- a table of runs, newest first, with the change from the previous comparable run (same
  profile and quality),
- per run: frame time (p50 / p95 / slowest of each second), CPU, GPU and memory over time,
  with state changes and governor steps marked. Runs whose log was pruned show the summary only.
Standard library only.
"""
import html, json, os, platform, subprocess, sys
from datetime import datetime, timezone


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def data_dir(game):
    env = os.environ.get(f"{game.upper()}_DATA_DIR")
    if env:
        return env
    home = os.path.expanduser("~")
    if platform.system() == "Darwin":
        return os.path.join(home, "Library", "Application Support", game)
    if platform.system() == "Windows":
        return os.path.join(os.environ.get("APPDATA", home), game)
    return os.path.join(os.environ.get("XDG_DATA_HOME", os.path.join(home, ".local", "share")), game)


def read_jsonl(path):
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass  # a run killed mid-write leaves a torn last line
    except OSError:
        pass
    return out


def now_of(v):
    """A sample value: plain number, or {"now": ..} from the perf monitor."""
    if isinstance(v, dict):
        v = v.get("now", v.get("ema"))
    return round(v, 3) if isinstance(v, (int, float)) else None


def get(d, *path):
    for p in path:
        if not isinstance(d, dict):
            return None
        d = d.get(p)
    return d


# Per-second series taken from each perf sample: (name, path into the sample).
SERIES = [
    ("frame_p50", ("frame_ms", "p50")),
    ("frame_p95", ("frame_ms", "p95")),
    ("frame_max", ("frame_ms", "max")),
    ("fps", ("fps",)),
    ("cpu", ("cpu", "process")),
    ("gpu_ms", ("gpu", "frame_ms")),
    ("gpu_busy", ("gpu", "process")),
    ("mem", ("ram", "footprint_mb")),
    ("entities", ("game", "entities")),
]
MAX_POINTS = 1500


def session_detail(log_path):
    rows = read_jsonl(log_path)
    if not rows:
        return None
    samples, events = [], []
    for r in rows:
        if r.get("kind") == "perf":
            s = {"t": r.get("t")}
            for name, path in SERIES:
                s[name] = now_of(get(r, *path))
            s["state"] = get(r, "game", "state")
            samples.append(s)
        elif r.get("kind") == "event":
            e = r.get("event")
            t = r.get("t")
            if e == "state" and r.get("to"):
                events.append({"t": t, "kind": "state", "text": r["to"]})
            elif e == "quality":
                events.append({"t": t, "kind": "quality", "text": f'{r.get("step", "quality")} ({r.get("reason", "")})'})
            elif e == "perf.hitch":
                events.append({"t": t, "kind": "hitch", "text": f'hitch {r.get("ms", 0):.0f} ms', "ms": r.get("ms")})
            elif e in ("paused", "resumed"):
                events.append({"t": t, "kind": "pause", "text": e})
    if len(samples) > MAX_POINTS:
        # Keep the shape and the spikes: bucket, average the rest, keep each bucket's worst frame.
        k = len(samples) / MAX_POINTS
        out = []
        for i in range(MAX_POINTS):
            b = samples[int(i * k): max(int((i + 1) * k), int(i * k) + 1)]
            m = dict(b[-1])
            for name, _ in SERIES:
                vals = [x[name] for x in b if x[name] is not None]
                if vals:
                    m[name] = round(max(vals) if name == "frame_max" else sum(vals) / len(vals), 3)
            out.append(m)
        samples = out
    # Hitches are many in a long run: keep the 200 worst.
    hitches = sorted((e for e in events if e["kind"] == "hitch"), key=lambda e: -(e.get("ms") or 0))[:200]
    events = [e for e in events if e["kind"] != "hitch"] + hitches
    return {"samples": samples, "events": events}


KEYS = [  # table columns: (label, key, stat, unit, lower is better)
    ("fps", "frame.fps", "avg", "", False),
    ("frame p50", "frame.ms", "p50", "ms", True),
    ("frame p95", "frame.ms", "p95", "ms", True),
    ("frame max", "frame.ms", "max", "ms", True),
    ("hitches", "frame.hitches", "max", "", True),
    ("CPU", "cpu.process_pct", "avg", "%", True),
    ("GPU", "gpu.frame_ms", "avg", "ms", True),
    ("memory", "mem.footprint_mb", "max", "MB", True),
]


def summary_row(s):
    keys = s.get("keys", {})
    vals = {}
    for label, key, stat, unit, _ in KEYS:
        v = get(keys, key, stat)
        if v is None and key == "mem.footprint_mb":
            v = get(keys, "ram.footprint_mb", stat)
        vals[label] = v
    start = s.get("start_ts")
    when = datetime.fromtimestamp(start / 1000, tz=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M") if start else "?"
    return {
        "id": s.get("id"),
        "when": when,
        "start": start,
        "seconds": s.get("seconds"),
        "commit": (s.get("commit") or "?") + ("*" if s.get("dirty") else ""),
        "profile": s.get("profile"),
        "mode": s.get("mode"),
        "quality": s.get("quality"),
        "ended": s.get("ended"),
        "labels": s.get("labels") or {},
        "vals": vals,
    }


def build(game, data, last):
    sessions = read_jsonl(os.path.join(data, "metrics", "sessions.jsonl"))
    sessions = [s for s in sessions if s.get("id")]
    # The same run can appear twice (a periodic summary, then the final one): keep the last.
    seen = {}
    for s in sessions:
        seen[s["id"]] = s
    sessions = sorted(seen.values(), key=lambda s: s.get("start_ts") or 0)[-last:]
    runs = []
    for s in sessions:
        row = summary_row(s)
        row["detail"] = session_detail(os.path.join(data, "logs", f"session-{s['id']}.jsonl"))
        runs.append(row)
    return {"game": game, "data": data, "generated": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M"), "keys": [[k[0], k[3], k[4]] for k in KEYS], "runs": runs}


PAGE = r"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root { --bg:#0e1013; --panel:#15181c; --line:#2a2f36; --grid:#22262c; --text:#e8e6e1; --muted:#9aa0a8; --dim:#6b717a;
        --s1:#5f8fd6; --s2:#d9a23a; --s3:#d0605e; --good:#5fb37a; --bad:#d0605e; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
header { padding:20px 28px 8px; } h1 { font-size:20px; margin:0 0 4px; letter-spacing:.02em; } .sub { color:var(--muted); font-size:13px; }
main { padding:8px 28px 40px; display:grid; gap:18px; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 10px; font-weight:600; }
table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
th, td { text-align:right; padding:6px 8px; border-bottom:1px solid var(--grid); white-space:nowrap; }
th { color:var(--muted); font-weight:500; font-size:12px; } th:first-child, td:first-child, th.l, td.l { text-align:left; }
tbody tr { cursor:pointer; } tbody tr:hover { background:#1b1f24; } tbody tr.sel { background:#1f2630; }
.d { font-size:11px; margin-left:4px; } .better { color:var(--good); } .worse { color:var(--bad); } .muted { color:var(--dim); }
.charts { display:grid; grid-template-columns:repeat(auto-fit, minmax(520px, 1fr)); gap:14px; }
.chart { position:relative; } .chart h3 { margin:0 0 4px; font-size:13px; font-weight:600; }
.legend { display:flex; gap:12px; font-size:12px; color:var(--muted); margin-bottom:4px; flex-wrap:wrap; }
.legend i { display:inline-block; width:14px; height:2px; vertical-align:middle; margin-right:5px; }
svg { display:block; width:100%; height:auto; } .axis { fill:var(--dim); font-size:10px; }
.tip { position:absolute; pointer-events:none; background:#0b0d10; border:1px solid var(--line); border-radius:6px; padding:6px 8px; font-size:12px; color:var(--text); display:none; white-space:nowrap; z-index:2; }
.events { font-size:12px; color:var(--muted); max-height:160px; overflow:auto; columns:2; }
.ev-state { color:var(--s1); } .ev-quality { color:var(--s2); } .ev-hitch { color:var(--s3); } .ev-pause { color:var(--muted); }
.note { color:var(--muted); font-size:13px; }
</style></head><body>
<header><h1>__TITLE__</h1><div class="sub" id="sub"></div></header>
<main>
<section class="panel"><h2>Runs</h2><div style="overflow:auto"><table id="runs"></table></div>
<div class="note" style="margin-top:8px">Change is against the previous run with the same profile and quality. Green = better, red = worse. Click a run for its charts.</div></section>
<section class="panel"><h2 id="dtitle">Run</h2><div id="detail"></div></section>
</main>
<script>
const D = __DATA__;
const $ = (s, e = document) => e.querySelector(s);
const fmt = (v, d = 1) => v == null ? "—" : (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : (+v).toFixed(d));
const dur = s => s == null ? "—" : (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
$("#sub").textContent = `${D.runs.length} runs · data: ${D.data} · made ${D.generated}`;

function prevComparable(i) {
  const r = D.runs[i];
  for (let j = i - 1; j >= 0; j--) { const p = D.runs[j]; if (p.profile === r.profile && p.quality === r.quality) return p; }
  return null;
}
function table() {
  const t = $("#runs");
  let h = `<thead><tr><th class="l">Run</th><th class="l">Length</th><th class="l">Build</th><th class="l">Quality</th><th class="l">Ended</th>`;
  for (const [label, unit] of D.keys) h += `<th>${label}${unit ? ` (${unit})` : ""}</th>`;
  h += `</tr></thead><tbody>`;
  for (let i = D.runs.length - 1; i >= 0; i--) {
    const r = D.runs[i], p = prevComparable(i);
    h += `<tr data-i="${i}"><td>${r.when}</td><td class="l">${dur(r.seconds)}</td><td class="l">${r.commit} <span class="muted">${r.profile || ""}</span></td><td class="l">${r.quality || "—"} <span class="muted">${r.mode || ""}</span></td><td class="l">${r.ended || "running?"}</td>`;
    for (const [label, , lowerBetter] of D.keys) {
      const v = r.vals[label], pv = p ? p.vals[label] : null;
      let delta = "";
      if (v != null && pv != null && pv !== 0) {
        const ch = (v - pv) / Math.abs(pv) * 100;
        if (Math.abs(ch) >= 3) {
          const better = lowerBetter ? ch < 0 : ch > 0;
          delta = `<span class="d ${better ? "better" : "worse"}">${ch > 0 ? "+" : ""}${ch.toFixed(0)}%</span>`;
        }
      }
      h += `<td>${fmt(v, label === "hitches" ? 0 : 1)}${delta}</td>`;
    }
    h += `</tr>`;
  }
  t.innerHTML = h + `</tbody>`;
  t.querySelectorAll("tbody tr").forEach(tr => tr.addEventListener("click", () => show(+tr.dataset.i)));
}

const W = 640, H = 200, PAD = { l: 44, r: 10, t: 8, b: 22 };
function chart(title, samples, series, unit, events) {
  const wrap = document.createElement("div"); wrap.className = "chart";
  const pts = samples.filter(s => s.t != null);
  const ys = series.flatMap(([k]) => pts.map(s => s[k]).filter(v => v != null));
  if (!pts.length || !ys.length) { wrap.innerHTML = `<h3>${title}</h3><div class="note">No samples.</div>`; return wrap; }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  let ymax = Math.max(...ys); ymax = ymax <= 0 ? 1 : ymax * 1.08;
  // A few huge spikes (loading) flatten everything: cap the scale at the 99th percentile x 1.5.
  const sorted = [...ys].sort((a, b) => a - b), p99 = sorted[Math.floor(sorted.length * 0.99)];
  if (ymax > p99 * 3 && p99 > 0) ymax = p99 * 1.5;
  const x = t => PAD.l + (t - t0) / Math.max(t1 - t0, 1e-6) * (W - PAD.l - PAD.r);
  const y = v => PAD.t + (1 - Math.min(v, ymax) / ymax) * (H - PAD.t - PAD.b);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">`;
  for (let g = 0; g <= 4; g++) { const v = ymax * g / 4, yy = y(v); svg += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${yy}" y2="${yy}" stroke="var(--grid)"/><text class="axis" x="${PAD.l - 6}" y="${yy + 3}" text-anchor="end">${fmt(v, v < 10 ? 1 : 0)}</text>`; }
  for (let g = 0; g <= 5; g++) { const t = t0 + (t1 - t0) * g / 5; svg += `<text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="middle">${dur(t)}</text>`; }
  for (const e of events.filter(e => e.kind === "state" || e.kind === "quality")) {
    const xx = x(e.t); if (xx < PAD.l || xx > W - PAD.r) continue;
    svg += `<line x1="${xx}" x2="${xx}" y1="${PAD.t}" y2="${H - PAD.b}" stroke="${e.kind === "state" ? "var(--s1)" : "var(--s2)"}" stroke-opacity=".35" stroke-dasharray="3 3"/>`;
  }
  series.forEach(([k, , color]) => {
    let d = "", on = false;
    for (const s of pts) { const v = s[k]; if (v == null) { on = false; continue; } d += `${on ? "L" : "M"}${x(s.t).toFixed(1)},${y(v).toFixed(1)}`; on = true; }
    svg += `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`;
  });
  svg += `<line class="cross" x1="0" x2="0" y1="${PAD.t}" y2="${H - PAD.b}" stroke="var(--muted)" visibility="hidden"/><rect x="${PAD.l}" y="${PAD.t}" width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}" fill="transparent"/></svg>`;
  const legend = series.length > 1 ? `<div class="legend">${series.map(([, l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join("")}</div>` : "";
  wrap.innerHTML = `<h3>${title}${unit ? ` <span class="muted">(${unit})</span>` : ""}</h3>${legend}${svg}<div class="tip"></div>`;
  const el = wrap.querySelector("svg"), tip = wrap.querySelector(".tip"), cross = wrap.querySelector(".cross");
  el.addEventListener("mousemove", ev => {
    const r = el.getBoundingClientRect(), mx = (ev.clientX - r.left) / r.width * W;
    const t = t0 + (mx - PAD.l) / (W - PAD.l - PAD.r) * (t1 - t0);
    let best = pts[0]; for (const s of pts) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    cross.setAttribute("x1", x(best.t)); cross.setAttribute("x2", x(best.t)); cross.setAttribute("visibility", "visible");
    tip.innerHTML = `<div class="muted">${dur(best.t)} · ${best.state || ""}</div>` + series.map(([k, l, c]) => `<div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:6px"></i>${l}: <b>${fmt(best[k])}</b> ${unit}</div>`).join("");
    tip.style.display = "block";
    const left = ev.clientX - wrap.getBoundingClientRect().left;
    tip.style.left = Math.min(left + 12, wrap.clientWidth - tip.offsetWidth - 4) + "px"; tip.style.top = "36px";
  });
  el.addEventListener("mouseleave", () => { tip.style.display = "none"; cross.setAttribute("visibility", "hidden"); });
  return wrap;
}

function show(i) {
  const r = D.runs[i];
  document.querySelectorAll("#runs tbody tr").forEach(tr => tr.classList.toggle("sel", +tr.dataset.i === i));
  $("#dtitle").textContent = `Run ${r.when} · ${dur(r.seconds)} · ${r.commit} · ${r.quality || ""}`;
  const box = $("#detail"); box.innerHTML = "";
  if (!r.detail) { box.innerHTML = `<div class="note">This run's log was pruned; only its summary (table above) is kept.</div>`; return; }
  const { samples, events } = r.detail;
  const grid = document.createElement("div"); grid.className = "charts";
  grid.append(
    chart("Frame time", samples, [["frame_p50", "median", "var(--s1)"], ["frame_p95", "slowest 5%", "var(--s2)"], ["frame_max", "slowest", "var(--s3)"]], "ms", events),
    chart("Frame rate", samples, [["fps", "fps", "var(--s1)"]], "fps", events),
    chart("CPU, this game", samples, [["cpu", "CPU", "var(--s1)"]], "% of a core", events),
    chart("GPU time per frame", samples, [["gpu_ms", "GPU", "var(--s1)"]], "ms", events),
    chart("Memory", samples, [["mem", "footprint", "var(--s1)"]], "MB", events),
    chart("Entities", samples, [["entities", "entities", "var(--s1)"]], "", events),
  );
  box.append(grid);
  if (events.length) {
    const ev = document.createElement("div"); ev.className = "events"; ev.style.marginTop = "12px";
    ev.innerHTML = events.sort((a, b) => a.t - b.t).map(e => `<div class="ev-${e.kind}">${dur(e.t)} · ${e.text}</div>`).join("");
    const h = document.createElement("h2"); h.textContent = "Events"; h.style.marginTop = "14px";
    box.append(h, ev);
  }
}
table();
if (D.runs.length) show(D.runs.length - 1); else $("#detail").innerHTML = `<div class="note">No runs recorded yet.</div>`;
</script></body></html>
"""


def main():
    args = sys.argv[1:]
    if not args or args[0].startswith("-"):
        sys.exit(__doc__)
    game = args[0]
    data = opt(args, "--data") or data_dir(game)
    if not os.path.isdir(data):
        sys.exit(f"no data dir at {data} (run the game once, or pass --data)")
    report = build(game, data, int(opt(args, "--last", "200")))
    out = opt(args, "--out") or os.path.join(data, "metrics", "report.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    title = html.escape(f"{game} · metrics history")
    # Keep the embedded JSON from closing the script tag.
    blob = json.dumps(report, separators=(",", ":")).replace("</", "<\\/")
    with open(out, "w", encoding="utf-8") as f:
        f.write(PAGE.replace("__TITLE__", title).replace("__DATA__", blob))
    print(f"{len(report['runs'])} runs -> {out}")
    if "--no-open" not in args:
        opener = {"Darwin": ["open"], "Windows": ["cmd", "/c", "start", ""]}.get(platform.system(), ["xdg-open"])
        subprocess.run(opener + [out], check=False)


if __name__ == "__main__":
    main()
