// The input logic, with no DOM: devices push raw events in, the game reads actions out. dom.ts feeds it from a page;
// tests feed it directly.
//
// How edges are kept (the part that must never lose a press):
//   * Devices write raw state as events arrive: a key goes into `held` and `tapped`, a release into `released`.
//   * `sample()` runs once per frame in game.onBeforeSteps, before any fixed step. It folds the raw events of the frame
//     into each action: `down`, and the edges `pressed` / `released`, and the frame's mouse movement and wheel.
//   * Edges and mouse movement are LATCHED for the fixed step: they are visible to the first fixed step that runs after
//     the sample (world.tick == base + 1) and to no later step of that frame. If the frame runs no step at all (a fast
//     monitor, a paused game), the next sample keeps them and adds the new ones, so a press is never lost and a
//     movement is never dropped. With 3 steps in a frame, step 1 sees the press, steps 2 and 3 see `down` only.
//   * A tap shorter than the frame (down and up between two samples) still gives `pressed` and `released`, and
//     counts as `down` for that one step.
//   * `framePressed` / `frameReleased` are the edges of the last frame, for code that reads in onFrame (menus).
// Everything a step sees is a function of (sampled state, world.tick), so the order of systems and behaviours inside a
// step cannot change what they read.
import type { InputMap } from '../schema/input-map.ts';
import { PAD_SOURCES, expandSource } from './keys.ts';
import { type ActionDef, type ActionType, type CompiledMap, type Overrides, SLOT_NAMES, compileMap } from './map.ts';

export interface ActionView {
  readonly name: string;
  readonly type: ActionType;
  /** Held now. A tap shorter than a frame counts as down for the one step that sees `pressed`. */
  readonly down: boolean;
  /** Went down since the previous fixed step saw the input: true for exactly one step. */
  readonly pressed: boolean;
  readonly released: boolean;
  /** button: 0..1 (a trigger is analog). axis: -1..1 (mouse and wheel axes are not limited). axis2: the length. */
  readonly value: number;
  /** axis2 only: up is negative y, like the screen, a stick and the mouse. */
  readonly x: number;
  readonly y: number;
  /** The edges of the last frame, still set in onFrame after several steps have run. */
  readonly framePressed: boolean;
  readonly frameReleased: boolean;
}

/** What one step saw of one action. Only the non-zero fields are written. */
export interface ActionSnap { d?: 1; p?: 1; r?: 1; v?: number; x?: number; y?: number }
/** What one step saw: the busy actions by name. An idle step is `{}`. */
export type StepSnapshot = Record<string, ActionSnap>;

export interface Recorder {
  /** Stops recording and returns one snapshot per fixed step since `record()`. */
  stop(): StepSnapshot[];
  readonly steps: number;
}
export interface Player {
  /** True once every snapshot has been given to a step. */
  readonly done: boolean;
  stop(): void;
}

export interface BindingRow {
  action: string;
  type: ActionType;
  slot: string;
  sources: readonly string[];
  /** false when the map says `rebind: false`. */
  rebind: boolean;
}

export interface InputView {
  /** Never undefined: an unknown or not yet loaded action reads as idle, so game code needs no checks. */
  action(name: string): ActionView;
  /** Two axis actions as a vector. `out` is written, nothing is allocated. */
  axis2(x: string, y: string, out: { x: number; y: number }): void;
  /** An axis2 action as a vector. */
  vec2(name: string, out: { x: number; y: number }): void;
  /** false: devices are ignored and every action reads idle (a menu or a text field has the keyboard). */
  enabled: boolean;

  readonly pointerLocked: boolean;
  /** Mouse look. Must be called from a click or key press. `lockDenied` says if the browser refused. */
  lockPointer(): void;
  unlockPointer(): void;
  readonly lockDenied: boolean;
  /** Mouse look without the lock (embedded frames that refuse it): movement counts while the cursor is over the page. */
  freeLook: boolean;

  /** Starts recording what every fixed step sees. */
  record(): Recorder;
  /** Replaces the devices with the list, one snapshot per fixed step, starting with the next step. */
  play(list: readonly StepSnapshot[]): Player;

  /** The map's bindings with the player's changes applied, grouped by action and slot. */
  bindings(): BindingRow[];
  /** Replaces one source of an action: `rebind('jump', 'main', 0, 'KeyJ')`. Returns the other actions that use it. */
  rebind(action: string, slot: string, index: number, source: string): string[];
  /** Removes one source. */
  unbind(action: string, slot: string, index: number): void;
  /** Adds a source to a slot. */
  addBinding(action: string, slot: string, source: string): string[];
  /** The next key, mouse button or gamepad button the player presses, or null if they press Escape or `cancel()`. */
  capture(): Promise<string | null>;
  cancelCapture(): void;
  resetBindings(action?: string): void;
  /** What the player changed, as plain JSON for the game to save; give it back to `setOverrides` on start. */
  overrides(): Overrides;
  setOverrides(o: Overrides): void;
  /** Called after any change to the bindings, including a live change of the map. */
  onBindingsChanged(fn: () => void): () => void;
  /** Problems found in the map, each naming its place. */
  readonly problems: readonly string[];
  dispose(): void;
}

const IDLE_THRESHOLD = 0.5;

class ActionImpl implements ActionView {
  def: ActionDef | null = null;
  // Sampled (see the header).
  held = false;
  analog = 0;
  kx = 0;
  ky = 0;
  latchP = false;
  latchR = false;
  ax = 0;
  ay = 0;
  fp = false;
  fr = false;
  // What the current step sees.
  vDown = false;
  vP = false;
  vR = false;
  vValue = 0;
  vX = 0;
  vY = 0;

  constructor(readonly name: string, private readonly core: InputCore) {}

  get type(): ActionType { return this.def?.type ?? 'button'; }
  get down(): boolean { this.core.sync(); return this.vDown; }
  get pressed(): boolean { this.core.sync(); return this.vP; }
  get released(): boolean { this.core.sync(); return this.vR; }
  get value(): number { this.core.sync(); return this.vValue; }
  get x(): number { this.core.sync(); return this.vX; }
  get y(): number { this.core.sync(); return this.vY; }
  get framePressed(): boolean { this.core.sync(); return this.fp; }
  get frameReleased(): boolean { this.core.sync(); return this.fr; }

  clearVisible(): void {
    this.vDown = this.vP = this.vR = false;
    this.vValue = this.vX = this.vY = 0;
  }
}

export class InputCore implements InputView {
  enabled = true;
  freeLook = false;
  lockDenied = false;
  problems: readonly string[] = [];

  // Raw device state. Source name -> analog value (1 for keys); absent means up.
  private held = new Map<string, number>();
  private tapped = new Set<string>();
  private releasedSet = new Set<string>();
  private mdx = 0;
  private mdy = 0;
  private wheelY = 0;
  private padAxes = new Float64Array(4);

  private actions = new Map<string, ActionImpl>();
  private list: ActionImpl[] = [];
  private compiled: CompiledMap = { actions: [], groups: {}, problems: [] };
  private map: InputMap | undefined;
  private mapId = 'input-map';
  private ov: Overrides = {};
  private listeners: (() => void)[] = [];
  private boundSet = new Set<string>();

  private baseTick = -1;
  private syncTick = -1;
  private recording: StepSnapshot[] | null = null;
  private recStart = 0;
  private playList: readonly StepSnapshot[] | null = null;
  private playStart = 0;
  private playDone = false;
  private capturing: ((s: string | null) => void) | null = null;

  /** Set by dom.ts so the view can lock the pointer without the core knowing about the DOM. */
  host: { lock(): void; unlock(): void; locked: boolean; dispose(): void } | null = null;

  /** `tick` is the world's fixed-step count: edges are tied to it, never to a clock. */
  constructor(private readonly tick: () => number) {}

  // ---- the map -------------------------------------------------------------------------------------------------

  setMap(map: InputMap | undefined, id = 'input-map'): void {
    this.map = map;
    this.mapId = id;
    this.recompile();
  }

  private recompile(): void {
    this.compiled = compileMap(this.map, this.mapId, this.ov);
    this.problems = this.compiled.problems;
    const live = new Set<string>();
    for (const def of this.compiled.actions) {
      live.add(def.name);
      this.impl(def.name).def = def;
    }
    for (const a of this.list) {
      if (!live.has(a.name)) { a.def = null; a.clearVisible(); }
    }
    this.boundSet.clear();
    for (const def of this.compiled.actions) for (const l of Object.values(def.slots)) for (const src of l) this.boundSet.add(src);
    this.syncTick = -1;
    for (const fn of this.listeners.slice()) fn();
  }

  private impl(name: string): ActionImpl {
    let a = this.actions.get(name);
    if (!a) {
      a = new ActionImpl(name, this);
      this.actions.set(name, a);
      this.list.push(a);
    }
    return a;
  }

  action(name: string): ActionView { return this.impl(name); }

  axis2(x: string, y: string, out: { x: number; y: number }): void {
    out.x = this.impl(x).value;
    out.y = this.impl(y).value;
  }

  vec2(name: string, out: { x: number; y: number }): void {
    const a = this.impl(name);
    out.x = a.x;
    out.y = a.y;
  }

  // ---- devices push --------------------------------------------------------------------------------------------

  keyDown(source: string): void { this.press(source, 1); }
  keyUp(source: string): void { this.release(source); }
  mouseDown(button: number): void { this.press(`Mouse${button}`, 1); }
  mouseUp(button: number): void { this.release(`Mouse${button}`); }

  private press(source: string, value: number): void {
    if (this.capturing) {
      const done = this.capturing;
      this.capturing = null;
      done(source === 'Escape' ? null : source);
      return;
    }
    if (!this.enabled) return;
    if (!this.held.has(source)) this.tapped.add(source);
    this.held.set(source, value);
  }

  private release(source: string): void {
    if (!this.held.has(source)) return;
    this.held.delete(source);
    this.releasedSet.add(source);
  }

  /** Mouse movement in pixels. dom.ts only calls this while the pointer is locked or free look is on. */
  mouseMove(dx: number, dy: number): void {
    if (!this.enabled) return;
    this.mdx += dx;
    this.mdy += dy;
  }

  /** One wheel event: positive is scrolling down, as in the browser. A notch is also a tap of WheelUp / WheelDown. */
  wheel(deltaY: number): void {
    if (!this.enabled || deltaY === 0) return;
    const dir = deltaY > 0 ? 1 : -1;
    this.wheelY += dir;
    const s = dir > 0 ? 'WheelDown' : 'WheelUp';
    // A notch has no duration: it is a tap that is released at once, so it can be a `pressed` and nothing more.
    this.tapped.add(s);
    this.releasedSet.add(s);
  }

  /** The state of a gamepad, standard mapping. Call once per frame before `sample`; edges come from the change. */
  setPad(buttons: ArrayLike<number>, axes: ArrayLike<number>): void {
    for (let i = 0; i < PAD_SOURCES.length; i++) {
      const v = buttons[i] ?? 0;
      const s = PAD_SOURCES[i]!;
      if (v > IDLE_THRESHOLD) {
        // Already held: only the analog value moves, so capture() is not triggered by a button that stays down.
        if (this.held.has(s)) this.held.set(s, v); else this.press(s, v);
      } else this.release(s);
    }
    for (let i = 0; i < 4; i++) this.padAxes[i] = axes[i] ?? 0;
  }

  /** Everything is up (the window lost focus): releases are recorded so no action stays stuck down. */
  releaseAll(): void {
    for (const s of this.held.keys()) this.releasedSet.add(s);
    this.held.clear();
    this.padAxes.fill(0);
  }

  // ---- sampling ------------------------------------------------------------------------------------------------

  /** Once per frame, before the fixed steps. dom.ts calls it from game.onBeforeSteps. */
  sample(): void {
    const t = this.tick();
    // A step has run since the last sample: whatever was latched has been seen. Otherwise keep it and add to it.
    const consumed = t > this.baseTick;
    this.baseTick = t;
    this.syncTick = -1;
    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i]!;
      const def = a.def;
      if (!def) continue;
      if (def.type === 'button') this.sampleButton(a, def, consumed);
      else this.sampleAxis(a, def, consumed);
    }
    this.mdx = 0;
    this.mdy = 0;
    this.wheelY = 0;
    this.tapped.clear();
    this.releasedSet.clear();
  }

  private sampleButton(a: ActionImpl, def: ActionDef, consumed: boolean): void {
    const src = def.slots['main']!;
    let heldNow = false;
    let tap = false;
    let rel = false;
    let analog = 0;
    for (let i = 0; i < src.length; i++) {
      const s = src[i]!;
      const v = this.held.get(s);
      if (v !== undefined) { heldNow = true; if (v > analog) analog = v; }
      if (this.tapped.has(s)) tap = true;
      if (this.releasedSet.has(s)) rel = true;
    }
    const was = a.held;
    const pressedEdge = !was && (heldNow || tap);
    const releasedEdge = (was || tap) && !heldNow && (rel || was);
    a.held = heldNow;
    a.analog = analog;
    a.fp = pressedEdge;
    a.fr = releasedEdge;
    if (consumed) { a.latchP = pressedEdge; a.latchR = releasedEdge; }
    else { a.latchP ||= pressedEdge; a.latchR ||= releasedEdge; }
  }

  private sampleAxis(a: ActionImpl, def: ActionDef, consumed: boolean): void {
    const slots = def.slots;
    let kx = 0;
    let ky = 0;
    let mx = 0;
    let my = 0;
    if (def.type === 'axis') {
      kx = this.count(slots['pos']!) - this.count(slots['neg']!);
      if (kx > 1) kx = 1; else if (kx < -1) kx = -1;
      if (def.padAxes.length) {
        const p = this.deadZone(this.padAxes[def.padAxes[0]!] ?? 0, def.deadzone);
        if (Math.abs(p) > Math.abs(kx)) kx = p;
      }
      if (def.mouse === 'deltaX') mx = this.mdx * def.sensitivity;
      else if (def.mouse === 'deltaY') mx = this.mdy * def.sensitivity * (def.invertY ? -1 : 1);
      else if (def.mouse === 'wheel') mx = this.wheelY * def.sensitivity;
    } else {
      kx = this.count(slots['right']!) - this.count(slots['left']!);
      ky = this.count(slots['down']!) - this.count(slots['up']!);
      const len = Math.hypot(kx, ky);
      if (len > 1) { kx /= len; ky /= len; }
      if (def.padAxes.length === 2) {
        const px = this.padAxes[def.padAxes[0]!] ?? 0;
        const py = this.padAxes[def.padAxes[1]!] ?? 0;
        const pl = Math.hypot(px, py);
        if (pl > def.deadzone) {
          // Radial dead zone: the stick's direction is kept, only the length is rescaled, so a diagonal is not bent.
          const scale = (Math.min(pl, 1) - def.deadzone) / (1 - def.deadzone) / pl;
          const sx = px * scale;
          const sy = py * scale * (def.invertY ? -1 : 1);
          if (Math.hypot(sx, sy) > len) { kx = sx; ky = sy; }
        }
      }
      if (def.mouse === 'delta') {
        mx = this.mdx * def.sensitivity;
        my = this.mdy * def.sensitivity * (def.invertY ? -1 : 1);
      }
    }
    a.kx = kx;
    a.ky = ky;
    if (consumed) { a.ax = mx; a.ay = my; } else { a.ax += mx; a.ay += my; }
  }

  private count(src: readonly string[]): number {
    for (let i = 0; i < src.length; i++) if (this.held.has(src[i]!)) return 1;
    return 0;
  }

  private deadZone(v: number, dz: number): number {
    const m = Math.abs(v);
    if (m <= dz) return 0;
    const s = (Math.min(m, 1) - dz) / (1 - dz);
    return v < 0 ? -s : s;
  }

  // ---- what a step sees ----------------------------------------------------------------------------------------

  /** Brings every action's visible fields up to date for the current tick. Cheap when nothing changed. */
  sync(): void {
    const t = this.tick();
    if (t === this.syncTick) return;
    this.syncTick = t;
    if (this.playList) { this.loadPlayback(t); return; }
    const first = t <= this.baseTick + 1;
    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i]!;
      const def = a.def;
      if (!def || !this.enabled) { a.clearVisible(); continue; }
      if (def.type === 'button') {
        a.vP = first && a.latchP;
        a.vR = first && a.latchR;
        a.vDown = a.held || a.vP;
        a.vValue = a.vDown ? (a.analog > 0 ? a.analog : 1) : 0;
        a.vX = a.vY = 0;
      } else {
        a.vDown = a.vP = a.vR = false;
        a.vX = a.kx + (first ? a.ax : 0);
        a.vY = a.ky + (first ? a.ay : 0);
        a.vValue = def.type === 'axis' ? a.vX : Math.hypot(a.vX, a.vY);
      }
    }
  }

  /** Called once per fixed step by dom.ts (a world system), so a recording gets one snapshot per step. */
  afterStep(): void {
    if (!this.recording) return;
    this.sync();
    const snap: StepSnapshot = {};
    for (const a of this.list) {
      if (!a.def) continue;
      if (!(a.vDown || a.vP || a.vR || a.vValue !== 0 || a.vX !== 0 || a.vY !== 0)) continue;
      const s: ActionSnap = {};
      if (a.vDown) s.d = 1;
      if (a.vP) s.p = 1;
      if (a.vR) s.r = 1;
      if (a.def.type === 'axis2') {
        if (a.vX !== 0) s.x = a.vX;
        if (a.vY !== 0) s.y = a.vY;
      } else if (a.vValue !== 0 && !(a.def.type === 'button' && a.vValue === 1)) s.v = a.vValue;
      snap[a.name] = s;
    }
    this.recording.push(snap);
  }

  record(): Recorder {
    const rec: StepSnapshot[] = [];
    this.recording = rec;
    this.recStart = this.tick();
    const core = this;
    return {
      get steps() { return rec.length; },
      stop() {
        if (core.recording === rec) core.recording = null;
        return rec;
      },
    };
  }

  play(list: readonly StepSnapshot[]): Player {
    this.playList = list;
    this.playStart = this.tick();
    this.playDone = list.length === 0;
    this.syncTick = -1;
    const core = this;
    const mine = list;
    return {
      get done() { return core.playList === mine ? core.playDone : true; },
      stop() {
        if (core.playList !== mine) return;
        core.playList = null;
        core.syncTick = -1;
      },
    };
  }

  private loadPlayback(t: number): void {
    const list = this.playList!;
    const idx = t - this.playStart - 1;
    const snap = idx >= 0 && idx < list.length ? list[idx]! : null;
    if (idx >= list.length - 1 && idx >= 0) this.playDone = true;
    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i]!;
      a.clearVisible();
      const s = snap?.[a.name];
      if (!s || !a.def) { a.fp = a.fr = false; continue; }
      a.vDown = s.d === 1;
      a.vP = s.p === 1;
      a.vR = s.r === 1;
      a.vX = s.x ?? 0;
      a.vY = s.y ?? 0;
      a.vValue = s.v ?? (a.def.type === 'axis2' ? Math.hypot(a.vX, a.vY) : a.vDown ? 1 : 0);
      a.fp = a.vP;
      a.fr = a.vR;
    }
  }

  // ---- pointer lock --------------------------------------------------------------------------------------------

  get pointerLocked(): boolean { return this.host?.locked ?? false; }
  lockPointer(): void { this.host?.lock(); }
  unlockPointer(): void { this.host?.unlock(); }

  // ---- rebinding -----------------------------------------------------------------------------------------------

  bindings(): BindingRow[] {
    const rows: BindingRow[] = [];
    for (const def of this.compiled.actions) {
      for (const slot of SLOT_NAMES[def.type]) {
        rows.push({ action: def.name, type: def.type, slot, sources: [...(def.slots[slot] ?? [])], rebind: def.rebind });
      }
    }
    return rows;
  }

  private slotOf(action: string, slot: string): { def: ActionDef; list: string[] } {
    const def = this.compiled.actions.find((d) => d.name === action);
    if (!def) throw new Error(`${this.mapId}#/actions/${action}: there is no such action`);
    if (!def.rebind) throw new Error(`${this.mapId}#/actions/${action}: has "rebind": false`);
    const list = def.slots[slot];
    if (!list) throw new Error(`${this.mapId}#/actions/${action}: a ${def.type} has the slots ${SLOT_NAMES[def.type].join(', ')}, not "${slot}"`);
    return { def, list: [...list] };
  }

  private store(action: string, slot: string, list: string[]): void {
    (this.ov[action] ??= {})[slot] = list;
    this.recompile();
  }

  private usedBy(source: string, except: string): string[] {
    const out: string[] = [];
    for (const def of this.compiled.actions) {
      if (def.name === except) continue;
      if (Object.values(def.slots).some((l) => l.includes(source))) out.push(def.name);
    }
    return out;
  }

  rebind(action: string, slot: string, index: number, source: string): string[] {
    const { list } = this.slotOf(action, slot);
    const ex = expandSource(source);
    if (!ex) throw new Error(`"${source}" is not a key, mouse button or gamepad button name`);
    list.splice(index, index < list.length ? 1 : 0, ...ex);
    this.store(action, slot, [...new Set(list)]);
    return this.usedBy(ex[0]!, action);
  }

  addBinding(action: string, slot: string, source: string): string[] {
    const { list } = this.slotOf(action, slot);
    return this.rebind(action, slot, list.length, source);
  }

  unbind(action: string, slot: string, index: number): void {
    const { list } = this.slotOf(action, slot);
    list.splice(index, 1);
    this.store(action, slot, list);
  }

  capture(): Promise<string | null> {
    this.cancelCapture();
    // Taps that arrived before this call belong to the click that opened the dialog, not to the new binding.
    this.tapped.clear();
    return new Promise((resolve) => { this.capturing = resolve; });
  }

  cancelCapture(): void {
    const c = this.capturing;
    this.capturing = null;
    c?.(null);
  }

  resetBindings(action?: string): void {
    if (action === undefined) this.ov = {};
    else delete this.ov[action];
    this.recompile();
  }

  overrides(): Overrides { return structuredClone(this.ov); }

  setOverrides(o: Overrides): void {
    this.ov = structuredClone(o);
    this.recompile();
  }

  onBindingsChanged(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Whether some action uses this source: dom.ts keeps such keys from scrolling the page or opening menus. */
  isBound(source: string): boolean { return this.boundSet.has(source); }

  /** True while `capture()` waits: dom.ts then keeps keys away from the game. */
  get capturingNow(): boolean { return this.capturing !== null; }

  /** Names of actions that code asked for but the map does not define: usually a typo. */
  missing(): string[] {
    return this.list.filter((a) => !a.def).map((a) => a.name);
  }

  dispose(): void {
    this.cancelCapture();
    this.host?.dispose();
    this.host = null;
    this.listeners.length = 0;
  }
}
