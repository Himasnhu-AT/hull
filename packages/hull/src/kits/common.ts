// What the kits share: collision layers, the pause flag, physics set-up and the base of a HUD behaviour.
import { Behaviour, type Node, type World } from '../core/index.ts';
import { physicsOf, usePhysics, type Physics } from '../physics/index.ts';
import type { UiView } from '../ui/index.ts';
import { kitIO } from './io.ts';

/** Collision layers (bits). A shape is on one; a mover or a query lists the ones it meets. */
export const LAYER = { world: 1, player: 2, enemy: 4, pickup: 8 } as const;
/** Group names the kits find each other by. */
export const GROUP = { player: 'player', enemy: 'enemy', pickup: 'pickup', save: 'save' } as const;

/** The floor box a level gives to kits that need free ground: its edges on x and z. */
export interface LevelBounds { minX: number; maxX: number; minZ: number; maxZ: number }
/** A named point in a level: where something starts. `yaw` is a camera yaw (0 faces -z). */
export interface LevelMarker { readonly name: string; readonly x: number; readonly y: number; readonly z: number; readonly yaw: number }
/**
 * What the pickups, spawner and nav kits ask of a level: how big it is, where it is free, the named points and the things
 * built from prefabs. `ArenaLevel` (code) and `Level` (a config/level file) both satisfy it, so a kit never names either.
 */
export interface LevelLike {
  /** Distance from the middle to the nearest edge of the floor. */
  readonly half: number;
  readonly bounds: LevelBounds;
  /** True when a box of these half sizes at (x, z) overlaps anything solid. */
  hits(x: number, z: number, hx: number, hz: number): boolean;
  /** Writes free floor into `out`: clear by `margin`, at least `awayFrom` from (awayX, awayZ), drawn from the random stream. */
  freeSpot(out: { x: number; z: number }, margin: number, stream: string, awayX?: number, awayZ?: number, awayFrom?: number): boolean;
  marker(name: string): LevelMarker | null;
  markers(prefix?: string): readonly LevelMarker[];
  /** Nodes built from a prefab id ('prefab/crate'); empty when the level has none. */
  things(prefab: string): readonly Node[];
}

export interface KitFlags { paused: boolean }
const flags = new WeakMap<World, KitFlags>();
/** One flag object per world. Gameplay behaviours skip their step while `paused` is true. */
export function flagsOf(world: World): KitFlags {
  let f = flags.get(world);
  if (!f) { f = { paused: false }; flags.set(world, f); }
  return f;
}

/** The world's physics, installing it first if no one has. */
export function ensurePhysics(world: World): Physics {
  try { return physicsOf(world); } catch { return usePhysics(world); }
}

/** First ancestor-or-self of `node` that has `type`. */
export function upFrom<B extends Behaviour>(node: Node | null, type: new () => B): B | undefined {
  for (let n = node; n !== null; n = n.parent) {
    const b = n.get(type);
    if (b) return b;
  }
  return undefined;
}

/** Facing as a yaw angle: forward is (-sin, -cos) on the floor, like a camera at that yaw. */
export const fwdX = (yaw: number): number => -Math.sin(yaw);
export const fwdZ = (yaw: number): number => -Math.cos(yaw);

/**
 * Base of a behaviour that draws UI. The page mounts the UI after `ready`, so the first frame that finds it builds
 * the widgets; in Node there is no UI and this does nothing.
 */
export abstract class KitUi extends Behaviour {
  private built: UiView | null = null;
  protected abstract build(ui: UiView): void;
  /** Takes the dt and alpha the world gives every behaviour, so a subclass reads them without a default. */
  override update(_dt: number, _alpha: number): void {
    const ui = kitIO.ui();
    if (!ui || ui === this.built) return;
    this.built = ui;
    this.build(ui);
  }
}

/**
 * Mouse look needs the pointer locked, and the browser only allows that from a click. Locks on the first click unless
 * the game is paused (a menu needs the cursor). Returns the function that removes the listener; in Node it does nothing.
 */
export function lockPointerOnClick(flags: KitFlags): () => void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return () => {};
  const on = (): void => { if (!flags.paused) kitIO.input.lockPointer(); };
  doc.addEventListener('click', on);
  return () => doc.removeEventListener('click', on);
}
