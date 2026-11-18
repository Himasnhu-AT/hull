// hull core: the loop, the world, nodes, behaviours, signals, timers, random. Runs in Node and the browser.
//
// CONTRACT STUB. These declarations are the public API agreed in the build design; the core worker replaces
// `declare` with the implementation and may add to it, but changes a signature only with a note in its report.
import type { Euler, Matrix4, Object3D, Quaternion, Vector3 } from 'three';

/** Event names and payloads, declared by the game through module augmentation, so a typo does not compile. */
export interface HullEvents {}

export interface GameDef {
  readonly ready: (game: Game) => void | Promise<void>;
  /** Fixed steps per second (30, 60 or 120). Comes from hull.json; 60 if unset. */
  readonly stepRate?: number;
  /** Seed for every random stream. Same seed, same inputs, same checksum. */
  readonly seed?: number;
}

export declare function defineGame(def: { ready(game: Game): void | Promise<void>; stepRate?: number; seed?: number }): GameDef;

/** Builds a game from its definition and runs `ready`. Tests, the dev page and the Studio all start games this way. */
export declare function startGame(def: GameDef, opts?: { seed?: number; stepRate?: number }): Promise<Game>;

export interface Game {
  readonly world: World;
  /** Exactly n fixed steps (default 1), no real time involved. */
  step(n?: number): void;
  /** What the browser loop calls with real seconds; clamps, scales by timeScale, runs whole steps. */
  frame(realDt: number): void;
  timeScale: number;
  paused: boolean;
  /** Render, audio and UI read state here and never write it. Returns an unsubscribe. */
  onFrame(fn: (alpha: number) => void): () => void;
  dispose(): void;
}

export interface Timer { cancel(): void; readonly active: boolean }

export interface Random {
  next(): number;
  range(a: number, b: number): number;
  int(a: number, b: number): number;
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
}

export interface Events {
  emit<K extends keyof HullEvents>(name: K, payload: HullEvents[K]): void;
  on<K extends keyof HullEvents>(name: K, fn: (payload: HullEvents[K]) => void, owner?: Node): () => void;
}

export interface SystemDef {
  fixedUpdate?(dt: number): void;
  update?(dt: number, alpha: number): void;
}

export declare class World {
  readonly time: number;
  readonly tick: number;
  readonly dt: number;
  readonly root: Node;
  readonly events: Events;
  spawn(name?: string, parent?: Node): Node;
  /** 'player', 'squad/ana' */
  find(path: string): Node | undefined;
  /** Kept as an array: looping over it allocates nothing. */
  group(name: string): readonly Node[];
  system(name: string, s: SystemDef): void;
  after(seconds: number, fn: () => void): Timer;
  every(seconds: number, fn: () => void): Timer;
  /** One seeded stream per name. 'cosmetic' is left out of the checksum. */
  random(stream: string): Random;
  /** Hash of time, transforms, declared behaviour state and random states. */
  checksum(): string;
}

export declare class Node {
  name: string;
  readonly world: World;
  readonly object3d: Object3D;
  readonly position: Vector3;
  readonly rotation: Euler;
  readonly scale: Vector3;
  readonly parent: Node | null;
  readonly children: readonly Node[];
  readonly destroyed: boolean;
  add<B extends Behaviour>(type: new () => B, init?: Partial<B>): B;
  get<B extends Behaviour>(type: new () => B): B | undefined;
  addTo(group: string): this;
  removeFrom(group: string): this;
  /** Takes effect at the end of the current step; its signal connections end with it. */
  destroy(): void;
}

export declare abstract class Behaviour {
  readonly node: Node;
  readonly world: World;
  /** Field names that are gameplay state: in the checksum and in saves. */
  static state?: readonly string[];
  ready?(): void;
  fixedUpdate?(dt: number): void;
  update?(dt: number, alpha: number): void;
  dispose?(): void;
}

export interface Signal<A extends unknown[] = []> {
  connect(fn: (...a: A) => void, owner?: Node): () => void;
  emit(...a: A): void;
}
export declare function signal<A extends unknown[] = []>(): Signal<A>;

/** Pooled maths objects, reset every step, so engine and game code need not allocate per frame. */
export declare const scratch: { v3(): Vector3; q(): Quaternion; m4(): Matrix4 };
