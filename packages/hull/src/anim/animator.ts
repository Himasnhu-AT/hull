// The Animator behaviour. State (graph, parameters, event times) advances in `fixedUpdate` on game time, so events
// and the checksum are the same on every machine. Poses are built in `update`, from the state a fraction `alpha`
// of the way between the last two steps, then IK, then written into the bone objects. Nothing here allocates per
// frame; the scratch arrays are made once when the character is built.
import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { config } from '../config/index.ts';
import { Behaviour, signal, type Node, type Signal } from '../core/index.ts';
import { stateFor } from '../render/interp.ts';
import type { AnimGraph } from '../schema/anim-graph.ts';
import type { AnimSet } from '../schema/anim-set.ts';
import type { Character } from '../schema/character.ts';
import { Body } from './body.ts';
import { compileClip, type Clip } from './clip.ts';
import './generators.ts';
import { Graph } from './graph.ts';
import { lookAt, twoBone } from './ik.ts';
import { clamp, qMulInv, qRotate, smoothstep } from './math.ts';
import { HitReact, Springs } from './secondary.ts';
import { buildBody, Pose, REF_HEIGHT, Skeleton } from './skeleton.ts';

interface Vec3 { x: number; y: number; z: number }

const _m = new Matrix4();
const _inv = new Matrix4();
const _p = new Vector3();
const _q0 = new Float64Array(4);

/** Sits on a cut-off branch's node and lets go of its shared geometry and materials when the node is destroyed. */
export class Limb extends Behaviour {
  release: (() => void)[] = [];
  /** The bone this was cut at, and the character it came from. */
  bone = '';
  override dispose(): void {
    for (const r of this.release) r();
    this.release = [];
  }
}

interface Reach { a: number; b: number; c: number; on: boolean; x: number; y: number; z: number; weight: number }

const bare = (kind: string, id: string): string => (id.startsWith(`${kind}/`) ? id.slice(kind.length + 1) : id);

export class Animator extends Behaviour {
  /** Gameplay state for the checksum: parameters, and every layer's states, times and weights. */
  static override state = ['animState'];

  /** 'character/soldier', or a character value directly (tests and tools). */
  character: string | Character = '';
  /** Overrides the character's own anim-set / anim-graph. */
  animSet: string | AnimSet | undefined = undefined;
  graph: string | AnimGraph | undefined = undefined;
  /** Game-time speed of this character's animation: 1 normal, 0.2 slow, 0 holds it (its windows and events stop too). */
  timeScale = 1;
  /** Moves the node by the playing clips' root motion each fixed step. Leave it off when something else (a character controller) moves the node and reads `rootMotion` itself. */
  applyRootMotion = false;
  /** Height of the ground at a world x, z. Without it feet are not placed on the ground. */
  ground: ((x: number, z: number) => number) | null = null;

  /** Clip events: (event name, clip name, layer). Fired on the fixed step. */
  readonly events: Signal<[name: string, clip: string, layer: string]> = signal<[string, string, string]>();
  /** A named window of the playing clip opens (`entering` true) or closes: (window, entering, clip, layer). Fired on the fixed step. */
  readonly windows: Signal<[name: string, entering: boolean, clip: string, layer: string]> = signal<[string, boolean, string, string]>();
  /** Fired when a part is cut off, with the bone's name and the node that now carries it. */
  readonly cut: Signal<[bone: string, limb: Node]> = signal<[string, Node]>();

  /** Things that were wrong in the files, by place. Each one is also warned once on the console. */
  readonly problems: string[] = [];

  skeleton!: Skeleton;
  private body: Body | null = null;
  private clips = new Map<string, Clip>();
  private graphRt: Graph | null = null;
  private pose!: Pose;
  private mq!: Float64Array;
  private mp!: Float64Array;
  private sockets = new Map<string, Object3D>();
  private severed = new Set<string>();
  private unwatch: (() => void)[] = [];
  private dirty = false;
  private built = false;
  private frozen = false;
  private preview: { clip: Clip; t: number } | null = null;
  private warned = new Set<string>();
  private readonly emitEvent = (name: string, clip: string, layer: string): void => this.events.emit(name, clip, layer);
  private readonly emitWindow = (name: string, entering: boolean, clip: string, layer: string): void => this.windows.emit(name, entering, clip, layer);
  private freezeLeft = 0;
  private freezeScale = 0;
  private springs: Springs | null = null;
  private flinch: HitReact | null = null;
  private socketDefs = new Map<string, { bone: number; x: number; y: number; z: number }>();
  private grips: { a: number; b: number; c: number; sb: number; ox: number; oy: number; oz: number; weight: number; wParam: number }[] = [];

  // IK
  private legs: [number, number, number][] = [];
  private hips = -1;
  private lookChain = new Int16Array(0);
  private lookWeights = new Float64Array(0);
  private lookOn = false;
  private lookT = { x: 0, y: 0, z: 0 };
  private lookStrength = 0;
  private reaches: Reach[] = [];
  private pelvisDy = 0;
  private liftS = new Float64Array(2);
  private lastDt = 1 / 60;

  override ready(): void {
    stateFor(this.world).interp.track(this.node);
    this.build();
  }

  override dispose(): void {
    this.teardown();
  }

  // ---- building ----

  private report(msg: string): void {
    this.problems.push(msg);
    if (!this.warned.has(msg)) {
      this.warned.add(msg);
      console.warn(`[hull] anim: ${msg}`);
    }
  }

  private resolve<K extends 'character' | 'anim-set' | 'anim-graph', V>(kind: K, ref: string | V | undefined, watch: boolean): V | undefined {
    if (ref === undefined || ref === '') return undefined;
    if (typeof ref !== 'string') return ref;
    const id = bare(kind, ref);
    try {
      const v = config.lookup(kind, id) as unknown as V;
      if (watch) this.unwatch.push(config.watch(`${kind}/${id}`, () => { this.dirty = true; }));
      return v;
    } catch {
      this.report(`${kind}/${id} does not exist.`);
      return undefined;
    }
  }

  private teardown(): void {
    for (const u of this.unwatch) u();
    this.unwatch.length = 0;
    this.body?.dispose();
    this.body = null;
    this.sockets.clear();
    this.socketDefs.clear();
  }

  /** (Re)builds everything from the files. Parameters and layer states that still exist are kept. */
  private build(): void {
    const oldParams = new Map<string, number>();
    const oldStates: [string, string][] = [];
    const old = this.graphRt;
    if (old) {
      old.paramNames.forEach((n, i) => oldParams.set(n, old.params[i]!));
      for (const l of old.layers) { const s = old.stateName(l.name); if (s) oldStates.push([l.name, s]); }
    }
    this.teardown();
    this.problems.length = 0;
    this.dirty = false;
    this.built = false;
    this.graphRt = null;
    this.clips = new Map();

    const def = this.resolve<'character', Character>('character', this.character, true);
    if (!def) { this.report(`the animator on "${this.node.name}" has no character, so it draws nothing.`); return; }
    const where = typeof this.character === 'string' ? `character/${bare('character', this.character)}` : 'character';
    let built;
    try {
      if (def.body.type === 'gltf') throw new Error(`${where}#/body/type: glTF bodies are not supported yet`);
      built = buildBody(def.body, `${where}#/body`);
    } catch (e) {
      this.report(e instanceof Error ? e.message : String(e));
      return;
    }
    this.skeleton = built.skeleton;
    const sk = built.skeleton;
    this.pose = new Pose(sk.n);
    this.mq = new Float64Array(sk.n * 4);
    this.mp = new Float64Array(sk.n * 3);
    this.body = new Body(this.node.object3d, sk, built.parts, def.materials, this.severed);

    for (const [name, s] of Object.entries(def.sockets ?? {})) {
      const bi = sk.index(s.joint);
      if (bi < 0) { this.report(`${where}#/sockets/${name}/joint: the body has no bone "${s.joint}".`); continue; }
      const o = new Object3D();
      o.name = `socket:${name}`;
      if (s.offset) o.position.set(s.offset[0], s.offset[1], s.offset[2]);
      this.socketDefs.set(name, { bone: bi, x: s.offset?.[0] ?? 0, y: s.offset?.[1] ?? 0, z: s.offset?.[2] ?? 0 });
      this.body.bones[bi]!.add(o);
      this.sockets.set(name, o);
    }

    const setRef = this.animSet ?? def.animSet;
    const set = this.resolve<'anim-set', AnimSet>('anim-set', setRef, true);
    if (set) {
      const setWhere = typeof setRef === 'string' ? `anim-set/${bare('anim-set', setRef)}` : 'anim-set';
      for (const [name, cd] of Object.entries(set.clips)) {
        const c = compileClip(name, cd, sk, `${setWhere}#/clips/${name}`, (m) => this.report(m));
        if (c) this.clips.set(name, c);
      }
    }
    const gRef = this.graph ?? def.animGraph;
    const gdef = this.resolve<'anim-graph', AnimGraph>('anim-graph', gRef, true);
    if (gdef) {
      const gWhere = typeof gRef === 'string' ? `anim-graph/${bare('anim-graph', gRef)}` : 'anim-graph';
      this.graphRt = new Graph(gdef, this.clips, sk, `${gWhere}#`, (m) => this.report(m));
      for (const [n, v] of oldParams) { const i = this.graphRt.paramIndexOf(n); if (i >= 0) this.graphRt.setParam(i, v); }
      for (const [l, s] of oldStates) this.graphRt.setState(l, s);
    }
    this.setupIk();
    this.built = true;
    this.render(1, 0);
  }

  private setupIk(): void {
    const sk = this.skeleton;
    const i = (n: string): number => sk.index(n);
    this.hips = i('hips');
    this.legs = [];
    for (const s of ['L', 'R']) {
      const a = i(`leg${s}`), b = i(`shin${s}`), c = i(`foot${s}`);
      if (a >= 0 && b >= 0 && c >= 0) this.legs.push([a, b, c]);
    }
    const look = this.graphRt?.ik.look;
    const w = look?.weights ?? { spine: 0.1, chest: 0.25, neck: 0.25, head: 0.4 };
    const chain: number[] = [], ws: number[] = [];
    for (const [n, v] of Object.entries(w)) {
      const bi = i(n);
      if (bi >= 0) { chain.push(bi); ws.push(v); }
    }
    const order = chain.map((_, k) => k).sort((a, b) => chain[a]! - chain[b]!);
    this.lookChain = Int16Array.from(order.map((k) => chain[k]!));
    this.lookWeights = Float64Array.from(order.map((k) => ws[k]!));
    this.reaches = [];

    // Hands that hold a socket (the off-hand on the hilt).
    this.grips = [];
    const g = this.graphRt;
    for (const [hand, gd] of Object.entries(g?.ik.grips ?? {})) {
      const c = i(hand);
      const b = c >= 0 ? sk.parent[c]! : -1;
      const a = b >= 0 ? sk.parent[b]! : -1;
      const sd = this.socketDefs.get(gd.socket);
      if (a < 0) { this.report(`anim-graph#/ik/grips/${hand}: "${hand}" needs two bones above it.`); continue; }
      if (!sd) { this.report(`anim-graph#/ik/grips/${hand}/socket: the character has no socket "${gd.socket}".`); continue; }
      const wParam = gd.weightFrom !== undefined && g ? g.paramIndexOf(gd.weightFrom) : -1;
      if (gd.weightFrom !== undefined && wParam < 0) this.report(`anim-graph#/ik/grips/${hand}/weightFrom: no parameter "${gd.weightFrom}"; the weight stays fixed.`);
      this.grips.push({ a, b, c, sb: sd.bone, ox: sd.x, oy: sd.y, oz: sd.z, weight: gd.weight ?? 1, wParam });
    }
    // Secondary motion and the flinch, from the graph (a character with no graph still flinches with the defaults).
    this.springs = g?.def.springs ? new Springs(sk, g.def.springs, 'anim-graph#', (m) => this.report(m)) : null;
    this.flinch = new HitReact(sk, g?.def.hitReact, 'anim-graph#', (m) => this.report(m));
  }

  // ---- parameters ----

  /** Sets a graph parameter. A trigger is set by any true value and lasts until the next fixed step has seen it. */
  set(name: string, value: number | boolean): void {
    const g = this.graphRt;
    const i = g ? g.paramIndexOf(name) : -1;
    if (!g || i < 0) {
      if (!this.warned.has(`param:${name}`)) { this.warned.add(`param:${name}`); this.report(`there is no parameter "${name}" in the graph.`); }
      return;
    }
    g.setParam(i, typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }

  trigger(name: string): void {
    this.set(name, 1);
  }

  get(name: string): number {
    const g = this.graphRt;
    const i = g ? g.paramIndexOf(name) : -1;
    return g && i >= 0 ? g.params[i]! : 0;
  }

  /** Current state of a layer (the one it is heading to). */
  stateOf(layer = 'base'): string | undefined {
    return this.graphRt?.stateName(layer);
  }

  /** How much each state counts in a layer right now. */
  weights(layer = 'base'): Record<string, number> {
    return this.graphRt?.weights(layer) ?? {};
  }

  /** Foot slide in m/s: how far the game's ground speed is from what the playing clip's feet cover. */
  get footSlide(): number {
    return this.graphRt?.slide ?? 0;
  }
  get footStride(): number {
    return this.graphRt?.stride ?? 0;
  }
  get graphRuntime(): Graph | null {
    return this.graphRt;
  }

  get clipNames(): string[] {
    return [...this.clips.keys()];
  }
  clip(name: string): Clip | undefined {
    return this.clips.get(name);
  }

  get animState(): unknown[] {
    return [this.graphRt ? this.graphRt.snapshot() : [], [...this.severed].sort(), this.timeScale, this.freezeLeft];
  }

  // ---- windows, root motion, time ----

  /** True while the clip a layer is playing is inside the window `name` (as of the last fixed step). Any layer, or just `layer`. */
  inWindow(name: string, layer?: string): boolean {
    return this.graphRt ? this.graphRt.inWindow(name, layer) : false;
  }

  /** The windows that are open now (for tools and tests; it allocates). */
  get openWindows(): string[] {
    return this.graphRt ? this.graphRt.openWindows() : [];
  }

  /** Travel of the last fixed step from root motion: x, y, z in metres and yaw in radians, in the character's frame. Zero when no clip has root motion. */
  get rootMotion(): Readonly<Float64Array> {
    return this.graphRt ? this.graphRt.rootDelta : zero4;
  }

  /** Holds the animation (scale 0) or slows it for `seconds` of game time: the hit-stop. A longer one in progress wins. */
  hitStop(seconds: number, scale = 0): void {
    if (seconds > this.freezeLeft) { this.freezeLeft = seconds; this.freezeScale = scale; }
  }

  /** The speed the animation runs at now: the time scale, or the hit-stop's while one is on. */
  get speedNow(): number {
    return this.freezeLeft > 0 ? this.freezeScale : this.timeScale;
  }

  /**
   * A blow that pushes the body along a world direction (from the attacker to the victim): the body leans away from it
   * and springs back, whatever clip is playing. `strength` 1 is a firm hit; set the look in the graph's `hitReact`.
   */
  hitReact(dir: Vec3, strength = 1): void {
    if (!this.flinch || !this.built) return;
    this.node.object3d.getWorldQuaternion(_wq);
    _wqa[0] = -_wq.x; _wqa[1] = -_wq.y; _wqa[2] = -_wq.z; _wqa[3] = _wq.w;
    qRotate(_wqa, 0, dir.x, dir.y, dir.z, _wv, 0);
    this.flinch.kick(_wv[0]!, _wv[2]!, strength);
  }

  // ---- IK targets (world space) ----

  /** Look at a world point, or at nothing with null. Head and spine turn within the graph's limits. */
  look(target: Vec3 | null): void {
    if (target === null) { this.lookOn = false; return; }
    this.lookOn = true;
    this.lookT.x = target.x; this.lookT.y = target.y; this.lookT.z = target.z;
  }

  /** Reach an end bone (a hand) to a world point with two-bone IK from the bone two above it. Null releases it. */
  reach(endBone: string, target: Vec3 | null, weight = 1): void {
    const sk = this.skeleton;
    const c = sk.index(endBone);
    if (c < 0) { this.report(`reach: the body has no bone "${endBone}".`); return; }
    const b = sk.parent[c]!;
    const a = b >= 0 ? sk.parent[b]! : -1;
    if (a < 0) { this.report(`reach: "${endBone}" needs two bones above it.`); return; }
    let r = this.reaches.find((x) => x.c === c);
    if (!r) { r = { a, b, c, on: false, x: 0, y: 0, z: 0, weight: 1 }; this.reaches.push(r); }
    if (target === null) { r.on = false; return; }
    r.on = true; r.x = target.x; r.y = target.y; r.z = target.z; r.weight = weight;
  }

  // ---- the frame loop ----

  override fixedUpdate(dt: number): void {
    if (this.dirty) this.build();
    this.lastDt = dt;
    if (this.frozen || this.preview) return;
    let k = this.timeScale;
    if (this.freezeLeft > 0) {
      k = this.freezeScale;
      this.freezeLeft = Math.max(0, this.freezeLeft - dt);
    }
    // Held: nothing advances, and a trigger set now waits for the step that follows.
    if (k <= 0) return;
    const g = this.graphRt;
    if (!g) return;
    g.step(dt * k, this.emitEvent, this.emitWindow);
    if (this.applyRootMotion) this.moveByRoot(g.rootDelta);
  }

  private moveByRoot(d: Float64Array): void {
    if (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 0) return;
    const n = this.node;
    const ry = n.rotation.y;
    const cs = Math.cos(ry), sn = Math.sin(ry);
    n.position.x += d[0]! * cs + d[2]! * sn;
    n.position.z += -d[0]! * sn + d[2]! * cs;
    n.position.y += d[1]!;
    n.rotation.y += d[3]!;
  }

  override update(dt: number, alpha: number): void {
    if (this.dirty) this.build();
    if (!this.built) return;
    this.render(this.preview || this.frozen ? 1 : alpha, dt);
  }

  /** Builds the pose for `alpha`, runs IK and writes the bones. `update` calls this; tests and tools may too. */
  render(alpha: number, dt: number): void {
    const body = this.body;
    if (!body) return;
    const pose = this.pose;
    if (this.preview) {
      pose.setRest();
      const tmp = this.previewPose;
      tmp.clear();
      this.preview.clip.sample(this.preview.t, tmp);
      for (let i = 0; i < pose.n; i++) {
        const c = tmp.cov[i]!;
        if (c <= 0) continue;
        for (let k = 0; k < 4; k++) pose.rot[i * 4 + k] = tmp.rot[i * 4 + k]!;
        for (let k = 0; k < 3; k++) pose.off[i * 3 + k] = tmp.off[i * 3 + k]!;
      }
    } else if (this.graphRt) {
      this.graphRt.evaluate(alpha, pose);
    } else {
      pose.setRest();
    }
    // Secondary motion on frame time, held while the animation is held (a hit-stop).
    const sdt = dt > 0 ? dt * this.speedNow : 0;
    if (this.flinch) this.flinch.update(sdt, pose);
    if (this.springs) this.springs.update(sdt, pose, this.node.object3d);
    this.solveIk(dt > 0 ? dt : this.lastDt);
    body.apply(pose);
  }
  private previewPoseV: Pose | null = null;
  private get previewPose(): Pose {
    return (this.previewPoseV ??= new Pose(this.skeleton.n));
  }

  private solveIk(dt: number): void {
    const sk = this.skeleton;
    const g = this.graphRt;
    const feetOn = this.ground !== null && this.legs.length > 0 && (g === null || g.ik.feet?.enabled !== false) && sk.dims !== null;
    const lookCfg = g?.ik.look;
    const lookEnabled = lookCfg?.enabled !== false && this.lookChain.length > 0;
    let anyReach = false;
    for (let i = 0; i < this.reaches.length; i++) if (this.reaches[i]!.on) anyReach = true;
    const anyGrip = this.grips.length > 0;
    // Smoothing runs on frame time: it is a presentation detail, not game state.
    const k = Math.min(1, dt * (lookCfg?.speed ?? 8));
    this.lookStrength += ((this.lookOn && lookEnabled ? 1 : 0) - this.lookStrength) * k;
    const looking = lookEnabled && this.lookStrength > 0.001;
    if (!feetOn && !looking && !anyReach && !anyGrip) { this.pelvisDy = 0; return; }

    const node = this.node.object3d;
    node.updateWorldMatrix(true, false);
    _m.copy(node.matrixWorld);
    _inv.copy(_m).invert();
    const e = _m.elements;
    const sc = Math.hypot(e[4]!, e[5]!, e[6]!) || 1;
    const mq = this.mq, mp = this.mp, pose = this.pose;
    sk.fk(pose, mq, mp);

    if (feetOn) this.placeFeet(dt, sc);
    else this.pelvisDy = 0;

    if (looking) {
      const t = this.toModel(this.lookT.x, this.lookT.y, this.lookT.z);
      lookAt(sk, pose, mq, mp, this.lookChain, this.lookWeights, t[0]!, t[1]!, t[2]!, ((lookCfg?.yawDeg ?? 80) * Math.PI) / 180, ((lookCfg?.pitchDeg ?? 45) * Math.PI) / 180, this.lookStrength);
    }
    for (let ri = 0; ri < this.reaches.length; ri++) {
      const r = this.reaches[ri]!;
      if (!r.on) continue;
      const t = this.toModel(r.x, r.y, r.z);
      const out = mp[r.a * 3]! < 0 ? -1 : 1;
      const s = sk.scale;
      twoBone(sk, pose, mq, mp, r.a, r.b, r.c, t[0]!, t[1]!, t[2]!, mp[r.b * 3]! + out * 0.3 * s, mp[r.b * 3 + 1]!, mp[r.b * 3 + 2]! + 0.6 * s, r.weight);
    }
    // The off-hand goes to its socket on the other hand's bone, after everything else has moved that hand.
    for (let gi = 0; gi < this.grips.length; gi++) {
      const gr = this.grips[gi]!;
      const w = gr.weight * (gr.wParam >= 0 ? clamp(g!.params[gr.wParam]!, 0, 1) : 1);
      if (w <= 0.001) continue;
      qRotate(mq, gr.sb * 4, gr.ox, gr.oy, gr.oz, this.modelOut, 0);
      const tx = mp[gr.sb * 3]! + this.modelOut[0]!, ty = mp[gr.sb * 3 + 1]! + this.modelOut[1]!, tz = mp[gr.sb * 3 + 2]! + this.modelOut[2]!;
      const out = mp[gr.a * 3]! < 0 ? -1 : 1;
      const s = sk.scale;
      twoBone(sk, pose, mq, mp, gr.a, gr.b, gr.c, tx, ty, tz, mp[gr.b * 3]! + out * 0.3 * s, mp[gr.b * 3 + 1]!, mp[gr.b * 3 + 2]! + 0.6 * s, w);
    }
  }

  private readonly modelOut = new Float64Array(3);
  private toModel(x: number, y: number, z: number): Float64Array {
    _p.set(x, y, z).applyMatrix4(_inv);
    this.modelOut[0] = _p.x; this.modelOut[1] = _p.y; this.modelOut[2] = _p.z;
    return this.modelOut;
  }

  /**
   * Plants the feet on the ground. A foot that is near the floor in the animation is moved by the height difference
   * under it (up to `maxStep`); a foot in the air keeps its swing. The hips drop to let the lower foot reach.
   */
  private placeFeet(dt: number, sc: number): void {
    const sk = this.skeleton, d = sk.dims!;
    const mq = this.mq, mp = this.mp, pose = this.pose;
    const ground = this.ground!;
    const maxStep = (this.graphRt?.ik.feet?.maxStep ?? 0.35) * sk.scale;
    const floorY = _m.elements[13]!;
    const lifts = this.liftTarget;
    const k = Math.min(1, dt * 18);
    let dy = 0;
    for (let li = 0; li < this.legs.length; li++) {
      const c = this.legs[li]![2];
      _p.set(mp[c * 3]!, mp[c * 3 + 1]!, mp[c * 3 + 2]!).applyMatrix4(_m);
      const gy = ground(_p.x, _p.z);
      const lift = clamp((gy - floorY) / sc, -maxStep, maxStep);
      const above = mp[c * 3 + 1]! - d.footH;
      const plant = 1 - smoothstep(0.01 * d.height, 0.1 * d.height, above);
      lifts[li * 4] = mp[c * 3]!; lifts[li * 4 + 1] = mp[c * 3 + 1]!; lifts[li * 4 + 2] = mp[c * 3 + 2]!;
      const want = lift * plant;
      this.liftS[li] = this.liftS[li]! + (want - this.liftS[li]!) * k;
      if (this.liftS[li]! < dy) dy = this.liftS[li]!;
    }
    this.pelvisDy += (dy - this.pelvisDy) * k;
    if (this.hips >= 0) {
      pose.off[this.hips * 3 + 1] = pose.off[this.hips * 3 + 1]! + this.pelvisDy;
      sk.fk(pose, mq, mp, this.hips);
    }
    for (let li = 0; li < this.legs.length; li++) {
      const [a, b, c] = this.legs[li]!;
      // Keep the foot's orientation: the sole stays as animated while the leg changes around it.
      for (let q = 0; q < 4; q++) _q0[q] = mq[c * 4 + q]!;
      twoBone(sk, pose, mq, mp, a, b, c, lifts[li * 4]!, lifts[li * 4 + 1]! + this.liftS[li]!, lifts[li * 4 + 2]!, mp[b * 3]!, mp[b * 3 + 1]!, mp[b * 3 + 2]! - sk.scale, 1);
      qMulInv(pose.rot, c * 4, mq, b * 4, _q0, 0);
      sk.fk(pose, mq, mp, c);
    }
  }
  private readonly liftTarget = new Float64Array(8);

  // ---- bench / tools ----

  /** Shows one clip at time t (seconds) and holds it: the game's graph is paused until `stopPreview`. */
  previewClip(clip: string, t: number): boolean {
    const c = this.clips.get(clip);
    if (!c) { this.report(`previewClip: no clip "${clip}".`); return false; }
    this.preview = { clip: c, t };
    this.render(1, 0);
    return true;
  }

  /** Puts the graph in the state it settles into for these parameters (after `seconds` of game time, no events), and holds it. */
  previewGraph(params: Record<string, number | boolean>, seconds = 1.5): void {
    const g = this.graphRt;
    if (!g) return;
    this.preview = null;
    g.reset();
    for (const [n, v] of Object.entries(params)) this.set(n, v);
    const steps = Math.ceil(seconds / this.world.dt);
    for (let i = 0; i < steps; i++) g.step(this.world.dt, null);
    this.frozen = true;
    this.render(1, 0);
  }

  stopPreview(): void {
    this.preview = null;
    this.frozen = false;
  }

  // ---- parts ----

  /** The Object3D at a socket of the character, to hang a blade or a hook on. */
  socket(name: string): Object3D | undefined {
    return this.sockets.get(name);
  }

  /** A bone's Object3D (for effects and tests). Undefined for a bone that was cut off. */
  bone(name: string): Object3D | undefined {
    const i = this.skeleton.index(name);
    return i >= 0 && this.body && this.body.gone[i] === 0 ? this.body.bones[i] : undefined;
  }

  get severedBones(): readonly string[] {
    return [...this.severed];
  }

  /**
   * Cuts a bone and everything below it off the body. The part leaves the character at its current place and pose
   * and becomes a node of its own, in the world, for the game to throw (give it a velocity, gravity, a lifetime).
   * Returns null if the bone does not exist or is already gone.
   */
  detach(boneName: string): Node | null {
    const body = this.body;
    const bi = this.skeleton.index(boneName);
    if (!body || bi < 0) return null;
    this.render(1, 0);
    this.node.object3d.updateWorldMatrix(true, true);
    const branch = body.cut(bi);
    if (!branch) return null;
    const limb = this.world.spawn(`${this.node.name}.${boneName}`);
    branch.object.matrixWorld.decompose(_p, _qq, _sc);
    limb.position.copy(_p);
    limb.rotation.setFromQuaternion(_qq);
    limb.scale.copy(_sc);
    branch.object.position.set(0, 0, 0);
    branch.object.quaternion.identity();
    branch.object.scale.set(1, 1, 1);
    limb.object3d.add(branch.object);
    limb.add(Limb, { release: branch.release, bone: boneName });
    stateFor(this.world).interp.track(limb);
    this.severed.add(boneName);
    this.cut.emit(boneName, limb);
    return limb;
  }

  /** Reference height used by clips and gaits (m). */
  static readonly referenceHeight = REF_HEIGHT;
}

const _qq = new Quaternion();
const _wq = new Quaternion();
const _wqa = new Float64Array(4);
const _wv = new Float64Array(3);
const zero4 = new Float64Array(4);
const _sc = new Vector3();
