// Live behaviour for the render budget figure. One clock: gsap.ticker. Returns a cleanup.
import { gsap } from "gsap";
import { data } from "./figure-data.js";
import { PRESETS, rangesAt, tierOf, looksOf, TIERS } from "./model.js";

const MARKS = ["shadow", "small_props", "far", "view"];
const FADE = 0.42; // seconds for a dithered cross-fade
const NAMES = { full: "full detail with a shadow", noshadow: "full detail, no shadow", faded: "dithered out", twin: "far twin", gone: "gone" };

export function mountBudget(root) {
  const stage = root.querySelector(".bf-stage");
  const svg = stage.querySelector("svg");
  const readout = root.querySelector("[data-readout]");
  const live = root.querySelector("[data-live]");
  const buttons = [...root.querySelectorAll("[data-preset]")];
  const countEls = Object.fromEntries(TIERS.map((t) => [t, root.querySelector(`[data-count="${t}"]`)]));
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const probeEl = svg.querySelector("[data-probe]");
  const marks = MARKS.map((name) => ({ name, els: [...svg.querySelectorAll(`[data-mark="${name}"],[data-mark-line="${name}"]`)] }));

  const pieces = data.pieces.map((p) => ({
    ...p,
    show: svg.querySelector(`[data-piece="${p.id}"]`),
    detail: svg.querySelector(`[data-detail="${p.id}"]`),
    twin: svg.querySelector(`[data-twin="${p.id}"]`),
    shadow: svg.querySelector(`[data-shadow="${p.id}"]`),
    a: null, // current looks
    lv: {},
  }));
  const probe = pieces.find((p) => p.probe);

  let scale = 1;
  let target = 1;
  let probeM = data.probe.rest;
  let probeTarget = probeM;
  let touring = !still.matches;
  let clock = 0;
  let visible = false;
  let running = false;
  let idle = 0;
  let lastText = "";

  const setLevel = (piece, key, el, a) => {
    if (!el) return;
    const level = Math.max(0, Math.min(16, Math.round(a * 16)));
    if (piece.lv[key] === level) return;
    piece.lv[key] = level;
    if (level === 0) { el.style.display = "none"; el.removeAttribute("mask"); return; }
    el.style.display = "";
    if (level === 16) el.removeAttribute("mask");
    else el.setAttribute("mask", `url(#bf-m${level})`);
  };

  const translate = (m) => `translate(${(data.axis[0] * m).toFixed(2)} ${(data.axis[1] * m).toFixed(2)})`;

  function draw(dt, calm) {
    const R = rangesAt(scale);
    for (const mark of marks) {
      const t = translate(R[mark.name]);
      for (const el of mark.els) el.setAttribute("transform", t);
    }
    probe.m = probeM;
    probeEl.setAttribute("transform", translate(probeM));
    const counts = Object.fromEntries(TIERS.map((t) => [t, 0]));
    let moving = false;
    for (const p of pieces) {
      const tier = tierOf(p, R);
      counts[tier]++;
      p.tier = tier;
      const want = looksOf(tier);
      if (!p.a || calm) p.a = { ...want };
      else {
        const step = dt / FADE;
        for (const key of ["shadow", "detail", "show"]) {
          const d = want[key] - p.a[key];
          if (Math.abs(d) <= step) p.a[key] = want[key];
          else { p.a[key] += Math.sign(d) * step; moving = true; }
        }
      }
      setLevel(p, "show", p.show, p.a.show);
      setLevel(p, "shadow", p.shadow, p.a.shadow * p.a.show);
      if (p.detail) {
        setLevel(p, "detail", p.detail, p.a.detail);
        setLevel(p, "twin", p.twin, p.a.detail < 1 ? 1 : 0);
      }
    }
    for (const t of TIERS) if (countEls[t] && countEls[t].textContent !== String(counts[t])) countEls[t].textContent = String(counts[t]);
    const text = `${Math.round(R.shadow)} · ${Math.round(R.small_props)} · ${Math.round(R.far)} · ${Math.round(R.view)} m`;
    if (text !== lastText) { readout.textContent = text; lastText = text; }
    return moving;
  }

  // Tour: the probe visits points either side of the shadow and small-prop ranges of the current preset.
  const TOUR = [0.4, 1.12, 1.32, 0.8];
  const tourAt = (t) => TOUR[Math.floor(t / 2.6) % TOUR.length] * 50 * target;
  const follow = (x, to, dt, tau, calm) => (calm ? to : Math.abs(to - x) < 0.01 ? to : x + (to - x) * (1 - Math.exp(-dt / tau)));

  function step(time, deltaMs) {
    const dt = Math.min(deltaMs / 1000, 1 / 30);
    const calm = still.matches;
    if (touring && !calm) { clock += dt; probeTarget = tourAt(clock); }
    scale = follow(scale, target, dt, 0.32, calm);
    probeM = follow(probeM, probeTarget, dt, 0.42, calm);
    const fading = draw(dt, calm);
    const settled = !touring && scale === target && probeM === probeTarget && !fading;
    if (settled || !visible) stop();
  }
  function start() {
    if (running || !visible) return;
    running = true;
    gsap.ticker.add(step);
  }
  function stop() {
    if (!running) return;
    running = false;
    gsap.ticker.remove(step);
  }

  function describe() {
    const p = pieces.find((x) => x.probe);
    const tier = tierOf({ ...p, m: probeTarget }, rangesAt(target));
    stage.setAttribute("aria-valuenow", String(Math.round(probeTarget)));
    stage.setAttribute("aria-valuetext", `Probe at ${Math.round(probeTarget)} m: ${NAMES[tier]}`);
  }
  function quiet() {
    touring = false;
    clearTimeout(idle);
    if (!still.matches) idle = setTimeout(() => { touring = true; clock = 0; start(); }, 3600);
  }
  function setProbe(m) {
    probeTarget = Math.max(data.probe.min, Math.min(data.probe.max, m));
    quiet();
    describe();
    start();
  }
  function setPreset(id) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    target = preset.scale;
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.preset === id));
    const R = rangesAt(target);
    const counts = Object.fromEntries(TIERS.map((t) => [t, 0]));
    for (const p of pieces) counts[tierOf(p.probe ? { ...p, m: probeTarget } : p, R)]++;
    live.textContent = `${preset.label}: shadows end at ${R.shadow} m, small props at ${R.small_props} m, far twins from ${R.far} m, view ends at ${R.view} m. ${counts.full} full, ${counts.noshadow} without shadow, ${counts.faded} dithered out, ${counts.twin} far twins, ${counts.gone} gone.`;
    describe();
    start();
  }

  // pointer: the probe follows the pointer along the bench (hover on mouse, drag on touch)
  const toMetres = (event) => {
    const box = svg.getBoundingClientRect();
    const sx = ((event.clientX - box.left) / box.width) * data.width;
    const sy = ((event.clientY - box.top) / box.height) * data.height;
    const [ax, ay] = data.axis;
    const dx = sx - data.laneOrigin[0];
    const dy = sy - data.laneOrigin[1];
    return (dx * ax + dy * ay) / (ax * ax + ay * ay);
  };
  let dragging = false;
  const onMove = (event) => {
    if (event.pointerType !== "mouse" && !dragging) return;
    setProbe(toMetres(event));
  };
  const onDown = (event) => {
    if (event.pointerType === "mouse") return;
    dragging = true;
    setProbe(toMetres(event));
  };
  const onUp = () => { dragging = false; };
  const onKey = (event) => {
    const by = event.shiftKey ? 20 : 5;
    let to = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") to = probeTarget + by;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") to = probeTarget - by;
    if (event.key === "Home") to = data.probe.min;
    if (event.key === "End") to = data.probe.max;
    if (to === null) return;
    event.preventDefault();
    setProbe(Math.round(to));
  };
  const onClick = (event) => {
    const b = event.target.closest("[data-preset]");
    if (b) setPreset(b.dataset.preset);
  };
  const onMotion = () => {
    if (still.matches) { touring = false; clearTimeout(idle); }
    else quiet();
    start();
  };

  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  stage.addEventListener("keydown", onKey);
  stage.addEventListener("focus", quiet);
  root.addEventListener("click", onClick);
  still.addEventListener("change", onMotion);
  const io = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (visible) start();
    else stop();
  }, { rootMargin: "120px 0px" });
  io.observe(root);

  draw(0, true);
  describe();

  return () => {
    stop();
    clearTimeout(idle);
    io.disconnect();
    stage.removeEventListener("pointermove", onMove);
    stage.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    stage.removeEventListener("keydown", onKey);
    stage.removeEventListener("focus", quiet);
    root.removeEventListener("click", onClick);
    still.removeEventListener("change", onMotion);
  };
}
