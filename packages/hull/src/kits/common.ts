// What the kits share: collision layers, the pause flag, physics set-up and the base of a HUD behaviour.
import { Behaviour, type Node, type World } from '../core/index.ts';
import { physicsOf, usePhysics, type Physics } from '../physics/index.ts';
import type { UiView } from '../ui/index.ts';
import { kitIO } from './io.ts';

/** Collision layers (bits). A shape is on one; a mover or a query lists the ones it meets. */
export const LAYER = { world: 1, player: 2, enemy: 4, pickup: 8 } as const;
/** Group names the kits find each other by. */
export const GROUP = { player: 'player', enemy: 'enemy', pickup: 'pickup', save: 'save' } as const;

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
