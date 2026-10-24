// Builds the render budget figure: a camera at the end of a long range bench, rows of scenery at true
// distances, range markers that slide with the quality preset, a probe crate on a sled and one actor.
//   node src/figures/budget/build.mjs                 writes figure-svg.js, figure-data.js, budget.css
//   node src/figures/budget/build.mjs --page out.html also writes a standalone check page
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./kit/iso-kit.mjs";
import * as G from "./kit/lathe.mjs";
import { BASE, PRESETS, rangesAt, tierOf, looksOf, TIERS } from "./model.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const pageAt = process.argv.indexOf("--page");
const PAGE = pageAt > 0 ? process.argv[pageAt + 1] : null;

const W = 640;
const H = 210;
const U = 1.4; // world units per metre along the bench
const X = (m) => m * U;

// ---------- world plan ----------
const BENCH = { x: -46, y: -50, w: 432, d: 100, r: 6 };
const BENCH_H = 9;
const FOOT_H = 5;
const BACK_Y = -27; // tower row
const LANE_Y = -4; // probe track, camera axis, actor
const FRONT_Y = 18; // small prop row
const RULER = { x: -3, y: 31, w: 375, d: 7, r: 1 };
const SLOT = { x: -6, y: 41.5, w: 384, d: 6, r: 2.4 };
const SLOT_Y = 44.5;
const TRACK = { from: -1, to: X(154) };
const PROBE = { min: 6, max: 150, rest: 20 };
const ACTOR_M = 196;

const TOWERS = [
  [20, 34], [45, 26], [70, 40], [95, 30], [125, 44], [150, 28], [185, 36], [215, 32], [245, 38],
].map(([m, h], i) => ({ id: `t${i}`, m, h, small: false }));
const PROPS = [12, 28, 42, 54, 66, 84, 105, 130].map((m, i) => ({ id: `p${i}`, m, small: true, kind: ["crate", "barrel", "stack"][i % 3] }));
const PROBE_PIECE = { id: "probe", m: PROBE.rest, small: true, probe: true };
const ACTOR = { id: "actor", m: ACTOR_M, actor: true };

const P = k.fitProjection(
  [...k.boxCorners(BENCH, -BENCH_H - FOOT_H, 0), [X(125) + 9, BACK_Y - 8, 50], [X(245) + 9, BACK_Y - 8, 44], [-31, LANE_Y, 34], [X(20) - 9, BACK_Y - 8, 40]],
  W,
  H,
  { pad: 10, azimuth: 75, elevation: 30 },
);

const at = (p) => k.iso(p, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const r1 = (v) => Math.round(v * 10) / 10;
const byDepth = (pts) => [...pts].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));

// ---------- shadows: the footprint swept along the sun, flat on the bench ----------
const SUN = [0.5, 0.15]; // floor offset per unit of height
function hull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
const shadowOf = (ring, h) => {
  const flat = [...ring.map(([x, y]) => at([x, y, 0])), ...ring.map(([x, y]) => at([x + SUN[0] * h, y + SUN[1] * h, 0]))];
  return `<path class="bf-shadow" d="${k.pathOf(hull(flat), true)}"/>`;
};

// ---------- dither masks: a 4x4 ordered (Bayer) screen, 15 levels ----------
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const CELL = 0.9;
function ditherDefs() {
  const out = ["<defs>"];
  for (let level = 1; level < 16; level++) {
    const cells = BAYER.map((v, i) => (v < level ? `<rect x="${r1((i % 4) * CELL)}" y="${r1(Math.floor(i / 4) * CELL)}" width="${CELL}" height="${CELL}"/>` : "")).join("");
    out.push(`<pattern id="bf-d${level}" width="${CELL * 4}" height="${CELL * 4}" patternUnits="userSpaceOnUse"><g fill="#fff">${cells}</g></pattern>`);
    out.push(`<mask id="bf-m${level}" maskUnits="userSpaceOnUse" x="-40" y="-40" width="${W + 80}" height="${H + 80}"><rect x="-40" y="-40" width="${W + 80}" height="${H + 80}" fill="url(#bf-d${level})"/></mask>`);
  }
  out.push("</defs>");
  return out.join("");
}
// Initial (no-JS) state at High.
const HIGH = rangesAt(1);
const maskAttr = (a) => (a >= 1 ? "" : a <= 0 ? ` style="display:none"` : ` mask="url(#bf-m${Math.round(a * 16)})"`);

// ---------- bench ----------
function bench() {
  const out = [`<path class="iso-halo" d="${k.haloOf(BENCH, -BENCH_H - FOOT_H, BENCH_H, P)}"/>`];
  const feet = [...k.corners(BENCH, 20), [BENCH.x + BENCH.w / 2, BENCH.y + 20], [BENCH.x + BENCH.w / 2, BENCH.y + BENCH.d - 20]];
  for (const [x, y] of byDepth(feet)) {
    out.push(S(k.cylinder(x, y, 7, -BENCH_H - FOOT_H, 1.6, P, 28), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 5.2, -BENCH_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: "mid" }));
  }
  out.push(S(k.slabOf(BENCH, -BENCH_H, BENCH_H, P, 8, 1.4), { tone: "mid", inner: L(k.sideSeam(BENCH, -BENCH_H + 3, P, 8), { tone: "faint" }) }));
  out.push(L(k.planOutline(k.insetPlan(BENCH, 4.5), 0, P), { tone: "lo" }));
  const screws = k.corners(BENCH, 9.5);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
  // label plate under the camera, rule lines stand for printed text
  const plate = { x: -40, y: 26, w: 26, d: 13, r: 1 };
  out.push(S(k.slabOf(plate, 0, 0.8, P, 3), { tone: "lo", crease: "none" }));
  out.push(L(k.planOutline(k.insetPlan(plate, 1.6), 0.8, P, 3), { tone: "faint" }));
  out.push(L([[-36, 30.5, 14], [-36, 33.5, 10], [-36, 36, 12]].map(([x, y, w]) => k.lineOnTop([x, y], [x + w, y], 0.8, P)).join(""), { tone: "lo", free: true }));
  out.push(D([at([plate.x + 2.2, plate.y + 2.2, 0.8]), at([plate.x + plate.w - 2.2, plate.y + 2.2, 0.8]), at([plate.x + 2.2, plate.y + plate.d - 2.2, 0.8]), at([plate.x + plate.w - 2.2, plate.y + plate.d - 2.2, 0.8])], { size: 0.42 }));
  // ruler strip in metres: a tick every 5 m, a major every 50 m
  out.push(S(k.slabOf(RULER, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const minor = k.topTicks(0, X(260) + 0.01, X(5), 10, RULER.y + 0.6, 0.6, [2.2, 4.4], P);
  out.push(L(minor.minor, { tone: "lo" }), L(minor.major, { tone: "mid" }));
  out.push(L(k.lineOnTop([0, RULER.y + 0.6], [0, RULER.y + 5.6], 0.6, P), { tone: "hi" }));
  out.push(D([at([RULER.x + 1.6, RULER.y + 3.5, 0.6]), at([RULER.x + RULER.w - 1.6, RULER.y + 3.5, 0.6])], { size: 0.42 }));
  // marker slot along the front edge
  out.push(S(k.slabOf(SLOT, -0.6, 0.6, P, 6), { tone: "faint", crease: "none" }));
  out.push(L(k.planOutline(k.insetPlan(SLOT, 1.4), 0, P, 6), { tone: "faint" }));
  // probe track: two rails with end stops
  for (const y of [LANE_Y - 4.6, LANE_Y + 3.4]) {
    out.push(S(k.slabOf({ x: TRACK.from, y, w: TRACK.to - TRACK.from, d: 1.2, r: 0.4 }, 0, 1, P, 2), { tone: "mid", crease: "none" }));
  }
  for (const x of [TRACK.from - 3, TRACK.to]) {
    out.push(S(k.slabOf({ x, y: LANE_Y - 6, w: 3, d: 12, r: 0.8 }, 0, 3.2, P, 3, 0.4), { tone: "mid" }));
    out.push(D([at([x + 1.5, LANE_Y - 3.6, 3.2]), at([x + 1.5, LANE_Y + 3.6, 3.2])], { size: 0.42 }));
  }
  return out.join("");
}

// ---------- marker lines on the bench top (under everything) and the sliders (in front) ----------
const MARKS = ["shadow", "small_props", "far", "view"];
const markLine = (name) =>
  `<g data-mark-line="${name}" transform="${k.translateAlong(P, [X(HIGH[name]), 0, 0])}">${L(k.lineOnTop([0, BENCH.y], [0, SLOT.y], 0, P), { className: "bf-mark-line" })}</g>`;
function markSlider(name, index) {
  const tab = 5.5 + index * 3;
  const out = [];
  out.push(S(k.slabOf({ x: -3.6, y: SLOT_Y - 2.4, w: 7.2, d: 4.8, r: 1 }, -0.6, 2.4, P, 3, 0.4), { tone: "mid" }));
  out.push(D([at([-2, SLOT_Y, 1.8]), at([2, SLOT_Y, 1.8])], { size: 0.4 }));
  out.push(S(k.slabOf({ x: -0.7, y: SLOT_Y - 2, w: 1.4, d: 4, r: 0.3 }, 1.8, tab, P, 2), { tone: "hi", lit: true, className: "bf-mark" }));
  return `<g data-mark="${name}" transform="${k.translateAlong(P, [X(HIGH[name]), 0, 0])}">${out.join("")}</g>`;
}

// ---------- towers (big pieces): detailed and far twin ----------
function towerSolids(t, twin) {
  const x0 = X(t.m);
  const plan = { x: x0 - 9, y: BACK_Y - 8, w: 18, d: 16, r: 1 };
  const plinth = k.insetPlan(plan, -1.2);
  const cap = k.insetPlan(plan, -0.4);
  const unit = { x: x0 - 5, y: BACK_Y - 5, w: 7, d: 6, r: 0.8 };
  const z0 = 2.4;
  const out = [];
  if (twin) {
    const style = { tone: "mid", crease: "none", className: "bf-twin" };
    out.push(S(k.slabOf(plinth, 0, z0, P, 3), style));
    out.push(S(k.slabOf(plan, z0, t.h - z0, P, 3), style));
    out.push(S(k.slabOf(cap, t.h, 1.6, P, 3), style));
    out.push(S(k.slabOf(unit, t.h + 1.6, 3.4, P, 3), style));
    return out.join("");
  }
  out.push(S(k.slabOf(plinth, 0, z0, P, 3, 0.4), { tone: "mid" }));
  const y1 = plan.y + plan.d;
  const x1 = plan.x + plan.w;
  const front = [];
  for (let x = plan.x + 3; x < x1 - 1; x += 3) front.push(k.segment([x, y1, z0], [x, y1, t.h], P));
  const side = [];
  for (let y = plan.y + 2.8; y < y1 - 1; y += 3.4) side.push(k.segment([x1, y, z0], [x1, y, t.h], P));
  const floors = [];
  for (let z = z0 + 4.2; z < t.h - 1.5; z += 4.2) floors.push(k.sideSeam(plan, z, P, 3));
  const inner = L(front.join("") + side.join(""), { tone: "faint" }) + L(floors.join(""), { tone: "lo" });
  out.push(S(k.slabOf(plan, z0, t.h - z0, P, 3), { tone: "hi", crease: "lo", inner }));
  out.push(S(k.slabOf(cap, t.h, 1.6, P, 3, 0.4), { tone: "hi", crease: "lo" }));
  out.push(L(k.planOutline(k.insetPlan(cap, 1.4), t.h + 1.6, P, 3), { tone: "faint" }));
  out.push(S(k.slabOf(unit, t.h + 1.6, 3.4, P, 3, 0.3), { tone: "mid" }));
  out.push(L(k.sideSeam(unit, t.h + 3.3, P, 3), { tone: "faint" }));
  out.push(D([at([x0 + 5, BACK_Y + 4, t.h + 1.6]), at([x0 + 5, BACK_Y - 4, t.h + 1.6])], { size: 0.42 }));
  return out.join("");
}
const towerRing = (t) => k.ringOf(k.insetPlan({ x: X(t.m) - 9, y: BACK_Y - 8, w: 18, d: 16, r: 1 }, -1.2), 3);

function tower(t) {
  const look = looksOf(tierOf(t, HIGH));
  return `<g data-piece="${t.id}"${maskAttr(look.show)}><g data-twin="${t.id}"${look.detail >= 1 ? ` style="display:none"` : ""}>${towerSolids(t, true)}</g><g data-detail="${t.id}"${maskAttr(look.detail)}>${towerSolids(t, false)}</g></g>`;
}

// ---------- small props ----------
function propSolids(kind, x0, y0) {
  const out = [];
  if (kind === "crate") {
    const plan = { x: x0 - 4.5, y: y0 - 4.5, w: 9, d: 9, r: 0.6 };
    out.push(S(k.slabOf(plan, 0, 9, P, 3, 0.5), { tone: "hi", crease: "lo", inner: L(k.sideSeam(plan, 3, P, 3) + k.sideSeam(plan, 6, P, 3), { tone: "lo" }) }));
    out.push(L(k.planOutline(k.insetPlan(plan, 1.4), 9, P, 3), { tone: "faint" }));
    out.push(D(k.corners(plan, 1.4).map(([x, y]) => at([x, y, 9])), { size: 0.4 }));
    return { svg: out.join(""), ring: k.ringOf(plan, 3), h: 9 };
  }
  if (kind === "barrel") {
    out.push(S(k.cylinder(x0, y0, 4.4, 0, 10, P, 40, 0.4), { tone: "hi", crease: "lo", inner: L(k.sideArc(x0, y0, 4.4, 2.4, P, 28) + k.sideArc(x0, y0, 4.4, 7.6, P, 28), { tone: "lo" }) }));
    out.push(L(k.ring(x0, y0, 3.3, 10, P, 32), { tone: "faint" }));
    out.push(D([at([x0 + 1.6, y0 + 1, 10])], { size: 0.55 }));
    return { svg: out.join(""), ring: k.circleRing(x0, y0, 4.4, 24), h: 10 };
  }
  const base = { x: x0 - 5, y: y0 - 4.5, w: 10, d: 9, r: 0.6 };
  const top = { x: x0 - 4.2, y: y0 - 3.6, w: 6, d: 6, r: 0.5 };
  out.push(S(k.slabOf(base, 0, 5, P, 3, 0.4), { tone: "hi", crease: "lo", inner: L(k.sideSeam(base, 2.5, P, 3), { tone: "lo" }) }));
  out.push(S(k.slabOf(top, 5, 4, P, 3, 0.4), { tone: "hi", crease: "lo" }));
  out.push(L(k.planOutline(k.insetPlan(top, 1.2), 9, P, 3), { tone: "faint" }));
  return { svg: out.join(""), ring: k.ringOf(base, 3), h: 9 };
}
function prop(p) {
  const look = looksOf(tierOf(p, HIGH));
  const solid = propSolids(p.kind, X(p.m), FRONT_Y);
  return `<g data-piece="${p.id}"${maskAttr(look.show)}>${solid.svg}</g>`;
}
const propShadow = (p) => {
  const look = looksOf(tierOf(p, HIGH));
  const solid = propSolids(p.kind, X(p.m), FRONT_Y);
  return `<g data-shadow="${p.id}"${maskAttr(look.shadow * look.show)}>${shadowOf(solid.ring, solid.h)}</g>`;
};
const towerShadow = (t) => {
  const look = looksOf(tierOf(t, HIGH));
  return `<g data-shadow="${t.id}"${maskAttr(look.shadow * look.show)}>${shadowOf(towerRing(t), t.h + 5)}</g>`;
};

// ---------- probe: a small crate on a sled, built at x = 0 and moved along the track ----------
function probe() {
  const look = looksOf(tierOf(PROBE_PIECE, HIGH));
  const sled = { x: -7, y: LANE_Y - 5.2, w: 14, d: 10.4, r: 1.2 };
  const crate = { x: -4, y: LANE_Y - 4, w: 8, d: 8, r: 0.6 };
  const ring = k.ringOf(crate, 3);
  const shadow = `<g data-shadow="probe"${maskAttr(look.shadow)}>${shadowOf(ring.map(([x, y]) => [x, y]), 10.2)}</g>`;
  const out = [];
  out.push(S(k.slabOf(sled, 1, 2, P, 3, 0.4), { tone: "mid" }));
  out.push(D(k.corners(sled, 1.6).map(([x, y]) => at([x, y, 3])), { size: 0.4 }));
  const handle = { x: sled.x + sled.w - 0.2, y: LANE_Y - 1.5, w: 2.4, d: 3, r: 0.6 };
  out.push(S(k.slabOf(handle, 1.2, 1.6, P, 2), { tone: "mid", crease: "none" }));
  out.push(S(k.slabOf(crate, 3, 8, P, 3, 0.5), { tone: "hi", crease: "lo", inner: L(k.sideSeam(crate, 5.6, P, 3) + k.sideSeam(crate, 8.4, P, 3), { tone: "lo" }) }));
  out.push(L(k.planOutline(k.insetPlan(crate, 1.3), 11, P, 3), { tone: "faint" }));
  return `<g data-probe transform="${k.translateAlong(P, [X(PROBE.rest), 0, 0])}">${collider(ring)}${shadow}<g data-piece="probe"${maskAttr(look.show)}>${out.join("")}</g></g>`;
}

// ---------- the camera at distance zero, lens pointing down the bench ----------
function camera() {
  const out = [];
  const cx = -20;
  out.push(`<path class="iso-halo" d="${k.haloOf({ x: cx - 8, y: LANE_Y - 8, w: 16, d: 16, r: 8 }, 0, 0.1, P)}" style="filter:blur(4px)"/>`);
  out.push(S(k.cylinder(cx, LANE_Y, 7, 0, 1.6, P, 36, 0.4), { tone: "lo" }));
  out.push(D([0, 1, 2, 3, 4, 5].map((i) => at([cx + 5.6 * Math.cos(i * 1.047 + 0.3), LANE_Y + 5.6 * Math.sin(i * 1.047 + 0.3), 1.6])), { size: 0.38 }));
  out.push(S(k.cylinder(cx, LANE_Y, 2.8, 1.6, 8.4, P, 24), { tone: "mid", inner: L(k.sideArc(cx, LANE_Y, 2.8, 6, P, 16), { tone: "faint" }) }));
  out.push(S(k.slabOf({ x: cx - 6, y: LANE_Y - 5, w: 12, d: 10, r: 1.2 }, 10, 3, P, 3, 0.4), { tone: "mid" }));
  const knob = [cx + 1, LANE_Y + 6.4];
  out.push(S(k.slabOf({ x: knob[0] - 0.8, y: LANE_Y + 4.8, w: 1.6, d: 1.4, r: 0.4 }, 10.8, 1.4, P, 2), { tone: "mid", crease: "none" }));
  out.push(S(k.cylinder(knob[0], knob[1], 1.6, 10.2, 2.6, P, 18), { tone: "mid", inner: L(k.knurl(knob[0], knob[1], 1.6, 10.2, 12.8, 14, P), { tone: "lo" }) }));
  const body = { x: -31, y: LANE_Y - 6, w: 23, d: 12, r: 1.6 };
  out.push(S(k.slabOf(body, 13, 14, P, 4, 0.6), { tone: "hi", crease: "lo", inner: L(k.sideSeam(body, 16, P, 4), { tone: "faint" }) }));
  // side door panel on the near face, a vent as closed slots
  out.push(L(k.pathOf([at([-28, body.y + body.d, 18.6]), at([-14, body.y + body.d, 18.6]), at([-14, body.y + body.d, 25.4]), at([-28, body.y + body.d, 25.4])], true), { tone: "faint" }));
  for (let i = 0; i < 4; i++) {
    const x = -26 + i * 3;
    out.push(L(k.pathOf([at([x, body.y + body.d, 20.2]), at([x + 1.6, body.y + body.d, 20.2]), at([x + 1.6, body.y + body.d, 23.8]), at([x, body.y + body.d, 23.8])], true), { tone: "lo" }));
  }
  out.push(D([at([-11, body.y + body.d, 24.6])], { size: 0.7, tone: "hi" }));
  // viewfinder and top handle
  out.push(S(k.slabOf({ x: -30, y: LANE_Y - 4, w: 6, d: 5, r: 1 }, 27, 3, P, 3, 0.3), { tone: "mid" }));
  out.push(S(k.cylinder(-30.6, LANE_Y - 1.5, 1.8, 27.6, 1.8, P, 16), { tone: "lo" }));
  for (const x of [-21, -13]) out.push(S(k.cylinder(x, LANE_Y, 0.8, 27, 4, P, 12), { tone: "mid", crease: "none" }));
  out.push(S(k.slabOf({ x: -22.4, y: LANE_Y - 1.2, w: 10.8, d: 2.4, r: 1 }, 31, 1.8, P, 3, 0.3), { tone: "mid" }));
  // lens along +x: mount, barrel, ribbed focus ring, hood, glass
  const F = G.frameAlong([-8, LANE_Y, 20], [1, 0, 0]);
  out.push(S(G.disc(0, 1.6, 5.4, F, P), { tone: "mid" }));
  out.push(S(G.disc(1.6, 4.4, 4.4, F, P), { tone: "hi", crease: "lo" }));
  const ribs = G.ribsOf(F, 4.4, 6.4, 4.8, 36, P, { fade: [0.1, 0.55], seams: true });
  out.push(S(G.disc(4.4, 6.4, 4.8, F, P), { tone: "mid", inner: k.fadedSvg(ribs, { tone: "lo" }) }));
  out.push(S(G.disc(6.4, 8, 5.4, F, P), { tone: "hi", crease: "lo" }));
  out.push(`<path class="bf-glass" d="${G.circleOf(F, 8, 4.3, P)}"/>`);
  out.push(L(G.circleOf(F, 8, 2.6, P), { tone: "faint" }));
  return out.join("");
}

// ---------- the actor: moves, animates, has physics, so it is never touched ----------
function actor() {
  const ax = X(ACTOR_M);
  const out = [];
  out.push(S(k.cylinder(ax, LANE_Y, 5, 0, 1.6, P, 36, 0.4), { tone: "mid" }));
  out.push(S(k.cylinder(ax, LANE_Y - 1.9, 1.2, 1.6, 10.4, P, 16), { tone: "hi", crease: "lo" }));
  out.push(S(k.cylinder(ax, LANE_Y - 4.9, 0.95, 12.4, 7.2, P, 14), { tone: "hi", crease: "lo" }));
  out.push(S(k.cylinder(ax, LANE_Y + 1.9, 1.2, 1.6, 10.4, P, 16), { tone: "hi", crease: "lo" }));
  const torso = { x: ax - 2.4, y: LANE_Y - 3.9, w: 4.8, d: 7.8, r: 1.8 };
  out.push(S(k.slabOf(torso, 11.4, 8.6, P, 5, 0.4), { tone: "hi", crease: "lo", inner: L(k.sideSeam(torso, 14.4, P, 5), { tone: "faint" }) }));
  out.push(S(k.cylinder(ax, LANE_Y + 4.9, 0.95, 12.4, 7.2, P, 14), { tone: "hi", crease: "lo" }));
  out.push(S(k.cylinder(ax, LANE_Y, 0.9, 20, 1.6, P, 12), { tone: "mid", crease: "none" }));
  out.push(S(G.sphereOf([ax, LANE_Y, 23.8], 2.7, P), { tone: "hi" }));
  return out.join("");
}
const actorShadow = () => shadowOf(k.circleRing(X(ACTOR_M), LANE_Y, 4, 20), 24);

// ---------- colliders: the footprint physics and AI keep, whatever is drawn ----------
const collider = (ring) => L(k.pathOf(ring.map(([x, y]) => at([x, y, 0])), true), { className: "bf-collider" });
function colliders() {
  const out = [];
  for (const t of TOWERS) out.push(collider(towerRing(t)));
  for (const p of PROPS) out.push(collider(propSolids(p.kind, X(p.m), FRONT_Y).ring));
  return `<g class="bf-colliders">${out.join("")}</g>`;
}

// ---------- assemble ----------
const towersByDepth = [...TOWERS].sort((a, b) => k.depthOf([X(a.m), BACK_Y, 0], P) - k.depthOf([X(b.m), BACK_Y, 0], P));
const propsByDepth = [...PROPS].sort((a, b) => k.depthOf([X(a.m), FRONT_Y, 0], P) - k.depthOf([X(b.m), FRONT_Y, 0], P));

const body = [
  ditherDefs(),
  bench(),
  MARKS.map(markLine).join(""),
  colliders(),
  `<g class="bf-shadows">${towersByDepth.map(towerShadow).join("")}${propsByDepth.map(propShadow).join("")}${actorShadow()}</g>`,
  camera(),
  towersByDepth.map(tower).join(""),
  probe(),
  `<g data-actor>${actor()}</g>`,
  propsByDepth.map(prop).join(""),
  MARKS.map(markSlider).join(""),
];

const label =
  "A cine camera at the end of a long range bench with a metre ruler. Range markers slide along the front edge at 50, 60, 80 and 170 metres at High quality. " +
  "Small crates and barrels nearer than 50 m cast shadows, lose them past 50 m and dither out past 60 m. Towers switch to a flat far twin past 80 m and vanish past 170 m. " +
  "A probe crate rides a sled down the bench, and a figure standing at 196 m keeps full detail and its shadow.";
const svg = k
  .figureSvg({ width: W, height: H, label, body })
  .replace(/^<svg([^>]*)role="img"([^>]*)aria-label="[^"]*"/, `<svg$1role="img"$2aria-labelledby="bf-title bf-desc"`)
  .replace(/(<svg[^>]*>)/, `$1<title id="bf-title">Distance detail on a range bench</title><desc id="bf-desc">${label}</desc>`);

// ---------- data for the live script ----------
const pieces = [...TOWERS, ...PROPS, PROBE_PIECE].map(({ id, m, small, probe: isProbe }) => ({ id, m, small: !!small, probe: !!isProbe }));
const origin = k.iso([0, LANE_Y, 0], P);
const data = {
  width: W,
  height: H,
  unit: U,
  axis: k.axisVector(P, [U, 0, 0]), // screen offset of one metre along the bench
  laneOrigin: origin, // screen point of 0 m on the probe lane
  probe: PROBE,
  actor: ACTOR_M,
  pieces,
  base: BASE,
  presets: PRESETS,
  tiers: TIERS,
};

// initial counts at High (the static page shows these)
const counts = Object.fromEntries(TIERS.map((t) => [t, 0]));
for (const p of pieces) counts[tierOf(p, HIGH)]++;

writeFileSync(join(HERE, "figure-svg.js"), `// Generated by build.mjs. Do not edit.\nexport const svg = ${JSON.stringify(svg)};\nexport const counts = ${JSON.stringify(counts)};\n`);
writeFileSync(join(HERE, "figure-data.js"), `// Generated by build.mjs. Do not edit.\nexport const data = ${JSON.stringify(data)};\n`);

// ---------- CSS: the kit's styles scoped under .budget-fig, then the figure's own ----------
function scope(css, prefix) {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const head = css.slice(i, open).trim();
    if (head.startsWith("@keyframes")) {
      let depth = 1, j = open + 1;
      while (depth && j < css.length) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; j++; }
      out += `${head.replace(/iso-/, "bf-iso-")}${css.slice(open, j)}\n`;
      i = j;
      continue;
    }
    if (head.startsWith("@media")) {
      let depth = 1, j = open + 1;
      while (depth && j < css.length) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; j++; }
      out += `${head}{${scope(css.slice(open + 1, j - 1), prefix)}}\n`;
      i = j;
      continue;
    }
    const close = css.indexOf("}", open);
    const sel = head
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith(".iso[") || s === ".iso" ? `${prefix}${s}` : `${prefix} ${s}`))
      .join(",");
    out += `${sel}{${css.slice(open + 1, close)}}\n`;
    i = close + 1;
  }
  return out;
}
const kitCss = scope(k.ISO_CSS.replace(/animation:iso-/g, "animation:bf-iso-"), ".budget-fig").replace(/^\.budget-fig\.iso\[data-theme="light"\]\{[^}]*\}\n/m, "");
const figureCss = readFileSync(join(HERE, "figure.css"), "utf8");
writeFileSync(join(HERE, "budget.css"), `/* Generated by build.mjs from kit/iso-kit.mjs and figure.css. Do not edit. */\n${kitCss}\n${figureCss}`);

console.log(`wrote figure-svg.js (${(svg.length / 1024).toFixed(0)} KB), figure-data.js, budget.css; High counts`, counts);

// ---------- optional standalone check page ----------
if (PAGE) {
  const markup = readFileSync(join(HERE, "markup.html"), "utf8");
  const fill = markup
    .replace("<!--svg-->", svg)
    .replace(/<!--count:(\w+)-->/g, (_, t) => String(counts[t]));
  const gsapUmd = readFileSync(join(HERE, "..", "..", "..", "node_modules", "gsap", "dist", "gsap.min.js"), "utf8");
  const strip = (src) => src.replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "");
  const live =
    "const gsap = window.gsap;\n" +
    strip(readFileSync(join(HERE, "model.js"), "utf8")) +
    `const data = ${JSON.stringify(data)};\n` +
    strip(readFileSync(join(HERE, "live.js"), "utf8")) +
    `\nconst el = document.querySelector('[data-budget-figure]'); window.__stop = mountBudget(el);\n`;
  const css = readFileSync(join(HERE, "budget.css"), "utf8");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Budget figure check</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Barlow:wght@500;600&family=JetBrains+Mono&display=swap" rel="stylesheet">
<style>:root{--accent:#ffa838}html,body{margin:0;background:#090b0f;color:#edf1f6;font-family:Barlow,system-ui,sans-serif}main{width:min(860px,100% - 32px);margin:48px auto}${css}</style></head>
<body><main>${fill}</main><script>${gsapUmd}</script><script type="module">${live.replace(/<\/(script)/gi, "<\\/$1")}</script></body></html>`;
  writeFileSync(PAGE, html);
  console.log("wrote", PAGE);
}
