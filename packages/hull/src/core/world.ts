import { Behaviour } from './behaviour.ts';
import { Hasher } from './checksum.ts';
import type { HullEvents } from './index.ts';
import { Node } from './node.ts';
import { RandomStream } from './random.ts';
import { resetScratch } from './scratch.ts';
import { ListenerList } from './signal.ts';
import { Timers } from './timers.ts';
import type { Events, Random, SystemDef, Timer } from './types.ts';

class EventsImpl implements Events {
  private readonly lists = new Map<string, ListenerList>();

  emit<K extends keyof HullEvents>(name: K, payload: HullEvents[K]): void {
    this.lists.get(name as string)?.fire1(payload);
  }

  on<K extends keyof HullEvents>(name: K, fn: (payload: HullEvents[K]) => void, owner?: Node): () => void {
    if (owner !== undefined && owner.destroyed) return () => {};
    let list = this.lists.get(name as string);
    if (list === undefined) {
      list = new ListenerList();
      this.lists.set(name as string, list);
    }
    const l = list.add(fn, owner ?? null);
    return () => l.end();
  }
}

interface NamedSystem {
  readonly name: string;
  def: SystemDef;
}

export class World {
  readonly dt: number;
  readonly root: Node;
  readonly events: Events = new EventsImpl();
  readonly seed: number;
  readonly stepRate: number;

  private _tick = 0;
  private readonly timers = new Timers();
  private readonly systems: NamedSystem[] = [];
  private readonly streams = new Map<string, RandomStream>();
  private readonly groups = new Map<string, Node[]>();
  /** Behaviours that define fixedUpdate / update, in the order they were added. The rest are in no list. */
  private readonly fixedList: Behaviour[] = [];
  private readonly updateList: Behaviour[] = [];
  /** @internal */
  readonly _pendingDestroy: Node[] = [];

  constructor(opts: { seed?: number; stepRate?: number } = {}) {
    const rate = opts.stepRate ?? 60;
    if (!(rate > 0) || !Number.isFinite(rate)) throw new Error(`stepRate must be a positive number, got ${rate}`);
    this.stepRate = rate;
    this.dt = 1 / rate;
    this.seed = opts.seed ?? 1;
    this.root = new Node(this, 'root', null);
  }

  /** Game time in seconds: steps taken times dt. Advances only inside `step`. */
  get time(): number {
    return this._tick * this.dt;
  }
  get tick(): number {
    return this._tick;
  }

  /** Makes a new empty node under `parent` (the world's root by default); give it behaviours with `node.add`. */
  spawn(name = 'node', parent: Node = this.root): Node {
    if (parent.destroyed) throw new Error(`Cannot spawn "${name}" under destroyed node "${parent.name}"`);
    return new Node(this, name, parent);
  }

  /** 'player', 'squad/ana'. The first child with each name wins. Empty path finds nothing. */
  find(path: string): Node | undefined {
    if (path === '') return undefined;
    const parts = path.split('/');
    let cur: Node = this.root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      let hit: Node | undefined;
      const kids = cur._children;
      for (let k = 0; k < kids.length; k++) {
        if (kids[k]!.name === part) { hit = kids[k]; break; }
      }
      if (hit === undefined) return undefined;
      cur = hit;
    }
    return cur;
  }

  /** The live list of nodes in a named group (see `node.addTo`); do not keep it across steps if nodes may be destroyed. */
  group(name: string): readonly Node[] {
    return this._groupArray(name);
  }

  /** Registering a name twice replaces the system and keeps its place in the order. */
  system(name: string, s: SystemDef): void {
    for (let i = 0; i < this.systems.length; i++) {
      const e = this.systems[i]!;
      if (e.name === name) { e.def = s; return; }
    }
    this.systems.push({ name, def: s });
  }

  /** Calls `fn` once after this many seconds of game time. Cancel it with the returned timer. */
  after(seconds: number, fn: () => void): Timer {
    return this.timers.add(this._tick + this.ticksFor(seconds), 0, fn);
  }

  /** Calls `fn` every this many seconds of game time, until the returned timer is cancelled. */
  every(seconds: number, fn: () => void): Timer {
    const n = this.ticksFor(seconds);
    return this.timers.add(this._tick + n, n, fn);
  }

  /** A named random stream that a seed makes repeatable: use this, never Math.random, in the simulation. */
  random(stream: string): Random {
    let r = this.streams.get(stream);
    if (r === undefined) {
      r = new RandomStream(this.seed, stream);
      this.streams.set(stream, r);
    }
    return r;
  }

  /** 16 hex digits over tick, transforms in tree order, declared behaviour state, and every random stream but 'cosmetic'. */
  checksum(): string {
    const h = new Hasher();
    h.u32(this._tick);
    h.num(this.time);
    this.hashNode(h, this.root);
    const names = Array.from(this.streams.keys()).sort();
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      if (name === 'cosmetic') continue;
      const r = this.streams.get(name)!;
      h.str(name);
      h.u32(r.s0);
      h.u32(r.s1);
      h.u32(r.s2);
      h.u32(r.s3);
    }
    return h.hex();
  }

  /**
   * One fixed step, in this order:
   *   1. the tick advances, so `time` already shows the end of this step;
   *   2. timers due this tick fire, in creation order;
   *   3. behaviours' fixedUpdate, in the order they were added (ones added during the step start next step);
   *   4. systems' fixedUpdate, in registration order;
   *   5. destroys requested so far take effect (so a node destroyed in step 3 still ran this step);
   *   6. scratch objects are taken back.
   * @internal Called by the game loop.
   */
  step(): void {
    this._tick++;
    this.timers.run(this._tick);
    const dt = this.dt;
    const fl = this.fixedList;
    const fn = fl.length;
    for (let i = 0; i < fn; i++) fl[i]!.fixedUpdate!(dt);
    const sys = this.systems;
    const sn = sys.length;
    for (let i = 0; i < sn; i++) sys[i]!.def.fixedUpdate?.(dt);
    this.flushDestroys();
    resetScratch();
  }

  /** Per-frame work for drawing: behaviours' update, then systems' update. Must not change gameplay state. @internal */
  update(dt: number, alpha: number): void {
    const ul = this.updateList;
    const un = ul.length;
    for (let i = 0; i < un; i++) ul[i]!.update!(dt, alpha);
    const sys = this.systems;
    const sn = sys.length;
    for (let i = 0; i < sn; i++) sys[i]!.def.update?.(dt, alpha);
    this.flushDestroys();
    resetScratch();
  }

  /** Destroys everything and drops timers. @internal */
  dispose(): void {
    const kids = this.root._children;
    for (let i = kids.length - 1; i >= 0; i--) kids[i]!._destroyNow(true);
    this.root._destroyNow(false);
    this._pendingDestroy.length = 0;
    this.timers.clear();
    this.systems.length = 0;
  }

  /** @internal */
  _groupArray(name: string): Node[] {
    let a = this.groups.get(name);
    if (a === undefined) {
      a = [];
      this.groups.set(name, a);
    }
    return a;
  }

  /** @internal */
  _register(b: Behaviour): void {
    if (typeof b.fixedUpdate === 'function') this.fixedList.push(b);
    if (typeof b.update === 'function') this.updateList.push(b);
  }

  /** @internal */
  _unregister(b: Behaviour): void {
    let i = this.fixedList.indexOf(b);
    if (i >= 0) this.fixedList.splice(i, 1);
    i = this.updateList.indexOf(b);
    if (i >= 0) this.updateList.splice(i, 1);
  }

  private ticksFor(seconds: number): number {
    return Math.max(1, Math.ceil(seconds / this.dt - 1e-9));
  }

  private flushDestroys(): void {
    const q = this._pendingDestroy;
    // Index loop: dispose() may destroy more nodes, which join the queue and are handled in this same flush.
    for (let i = 0; i < q.length; i++) q[i]!._destroyNow(true);
    q.length = 0;
  }

  private hashNode(h: Hasher, n: Node): void {
    const p = n.position;
    const r = n.rotation;
    const s = n.scale;
    h.num(p.x); h.num(p.y); h.num(p.z);
    h.num(r.x); h.num(r.y); h.num(r.z);
    h.num(s.x); h.num(s.y); h.num(s.z);
    const bs = n._behaviours;
    h.u32(bs.length);
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i]!;
      const fields = (b.constructor as typeof Behaviour).state;
      if (fields === undefined) continue;
      const bag = b as unknown as Record<string, unknown>;
      for (let k = 0; k < fields.length; k++) {
        const f = fields[k]!;
        h.str(f);
        h.value(bag[f]);
      }
    }
    const kids = n._children;
    h.u32(kids.length);
    for (let i = 0; i < kids.length; i++) this.hashNode(h, kids[i]!);
  }
}
