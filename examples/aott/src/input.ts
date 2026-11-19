// What the game reads from the keyboard and mouse. The devices, the pointer lock and the key map are Hull's input
// (config/input-map/play.json); this class keeps AOTT's small vocabulary on top of it so the player and the flow read
// actions as before: `act('jump')` held, `actHit('jump')` pressed this step, `mouseDX` / `mouseDY` the look since the
// last step. Edges are Hull's: each is seen by exactly one fixed step, whether a frame ran none, one or several.
import type { InputView } from 'hull/input';

// The mouse buttons and Enter AOTT read by key name are actions of their own in the map.
const RAW: Record<string, string> = { Mouse0: 'primary', Mouse2: 'secondary', Enter: 'confirm' };
const _v = { x: 0, y: 0 };

export class Input {
  /** Hull's input view (the mounted one in a browser, a headless core in tests). */
  view: InputView;
  /** The look since the last step, pixels; the keyboard-and-edge fallback adds to it. */
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  freeLookEdge = true;
  enabled = true;
  capture = true;
  /** Free-cursor fallback: where the cursor is, to turn while it is pushed against a screen edge. */
  cx = 0;
  cy = 0;
  inside = false;
  onLockChange?: (locked: boolean) => void;
  onLockDenied?: () => void;
  private edgeX = 0;
  private edgeY = 0;
  private wasLocked = false;
  private deniedTold = false;

  constructor(view: InputView) {
    this.view = view;
  }

  get locked(): boolean { return this.view.pointerLocked; }
  get lockDenied(): boolean { return this.view.lockDenied; }
  get freeLook(): boolean { return this.view.freeLook; }
  set freeLook(v: boolean) { this.view.freeLook = v; }

  /** Once at the start of each step: reads the look the engine sampled for this step. */
  begin(): void {
    this.view.vec2('look', _v);
    this.mouseDX = _v.x + this.edgeX;
    this.mouseDY = _v.y + this.edgeY;
    this.edgeX = this.edgeY = 0;
    const locked = this.view.pointerLocked;
    if (locked !== this.wasLocked) { this.wasLocked = locked; this.onLockChange?.(locked); }
    if (this.view.lockDenied && !this.deniedTold) { this.deniedTold = true; this.onLockDenied?.(); }
  }

  lock(): void { this.view.lockPointer(); }
  unlock(): void { this.view.unlockPointer(); }

  /** Free-cursor fallback: keep turning while the cursor is pushed into a screen edge. */
  edgeTurn(dt: number, w: number, h: number): void {
    if (this.locked || !this.freeLook || !this.inside) return;
    const mx = w * 0.07, my = h * 0.07;
    if (this.cx < mx) this.edgeX -= ((mx - this.cx) / mx) * 900 * dt;
    else if (this.cx > w - mx) this.edgeX += ((this.cx - (w - mx)) / mx) * 900 * dt;
    if (this.cy < my) this.edgeY -= ((my - this.cy) / my) * 450 * dt;
    else if (this.cy > h - my) this.edgeY += ((this.cy - (h - my)) / my) * 450 * dt;
  }

  held(k: string): boolean { return this.view.action(RAW[k] ?? k).down; }
  hit(k: string): boolean { return this.view.action(RAW[k] ?? k).pressed; }
  up(k: string): boolean { return this.view.action(RAW[k] ?? k).released; }
  /** Actions (see keys.ts): any of the action's bound keys held this step. */
  act(a: string): boolean { return this.view.action(a).down; }
  actHit(a: string): boolean { return this.view.action(a).pressed; }
  /** Kept for callers that ended a frame by clearing edges: the engine clears them itself, so there is nothing to do. */
  consume(): void { /* the engine's edges last exactly one step */ }
}
