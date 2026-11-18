import type { Game, GameDef } from './types.ts';
import { World } from './world.ts';

// Real frames longer than this (a tab in the background, a debugger stop) are cut, so the game never tries to
// catch up with seconds of steps at once.
const MAX_FRAME = 0.25;
// Float slack so 60 frames of 1/60 s give 60 steps, not 59 and a sliver.
const EPS = 1e-9;

class GameImpl implements Game {
  readonly world: World;
  timeScale = 1;
  paused = false;
  private acc = 0;
  private disposed = false;
  private frameFns: (((alpha: number) => void) | null)[] = [];
  // Few and registered once (input), so plain array removal is fine here.
  private beforeFns: (() => void)[] = [];
  private framing = 0;
  private frameDirty = false;

  constructor(world: World) {
    this.world = world;
  }

  step(n = 1): void {
    if (this.disposed) return;
    for (let i = 0; i < this.beforeFns.length; i++) this.beforeFns[i]!();
    for (let i = 0; i < n; i++) this.world.step();
  }

  /**
   * Paused is a time scale of 0 (ARCHITECTURE §2): no fixed steps, but update and onFrame still run, so a paused
   * view keeps drawing and the Studio can still move its camera over a frozen game.
   */
  frame(realDt: number): void {
    if (this.disposed) return;
    const world = this.world;
    const dt = world.dt;
    for (let i = 0; i < this.beforeFns.length; i++) this.beforeFns[i]!();
    const scaled = this.paused ? 0 : Math.min(Math.max(realDt, 0), MAX_FRAME) * this.timeScale;
    this.acc += scaled;
    while (this.acc >= dt - EPS) {
      world.step();
      this.acc -= dt;
    }
    if (this.acc < 0) this.acc = 0;
    const alpha = Math.min(this.acc / dt, 1);
    world.update(scaled, alpha);

    const fns = this.frameFns;
    const n = fns.length;
    this.framing++;
    try {
      for (let i = 0; i < n; i++) {
        const f = fns[i];
        if (f) f(alpha);
      }
    } finally {
      this.framing--;
      if (this.framing === 0 && this.frameDirty) this.sweep();
    }
  }

  onBeforeSteps(fn: () => void): () => void {
    this.beforeFns.push(fn);
    return () => {
      const i = this.beforeFns.indexOf(fn);
      if (i >= 0) this.beforeFns.splice(i, 1);
    };
  }

  onFrame(fn: (alpha: number) => void): () => void {
    this.frameFns.push(fn);
    return () => {
      const i = this.frameFns.indexOf(fn);
      if (i < 0) return;
      if (this.framing > 0) {
        this.frameFns[i] = null;
        this.frameDirty = true;
      } else {
        this.frameFns.splice(i, 1);
      }
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frameFns.length = 0;
    this.world.dispose();
  }

  private sweep(): void {
    const fns = this.frameFns;
    let w = 0;
    for (let r = 0; r < fns.length; r++) {
      const f = fns[r];
      if (f) fns[w++] = f;
    }
    fns.length = w;
    this.frameDirty = false;
  }
}

export function defineGame(def: {
  ready(game: Game): void | Promise<void>;
  stepRate?: number;
  seed?: number;
}): GameDef {
  return def;
}

/** Builds a game from its definition and runs `ready`. Tests, the dev page and the Studio all start games this way. */
export async function startGame(def: GameDef, opts: { seed?: number; stepRate?: number } = {}): Promise<Game> {
  const world = new World({
    seed: opts.seed ?? def.seed,
    stepRate: opts.stepRate ?? def.stepRate,
  });
  const game = new GameImpl(world);
  await def.ready(game);
  return game;
}
