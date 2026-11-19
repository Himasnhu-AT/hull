// Per-frame post effects a game drives while it runs: a speed cue (the look's speedBlur, scaled by how fast the
// player moves) and an impact pulse (a short desaturate-and-punch on a hit). Pure: no three.js, so it is tested in Node.
// It runs on real frame time, not game time, because a hit-stop freezes the game while the pulse must still play out.
// Nothing here touches the simulation or its random streams.

export interface PostFx {
  /** 0 to 1: how strongly the look's speedBlur draws (already smoothed, so it never pops). */
  speed: number;
  /** 0 to 1: the impact pulse right now. */
  impact: number;
  /** World position the pulse radiates from, or null for the middle of the screen. */
  impactAt: readonly [number, number, number] | null;
  /** Seconds of real time, for streaks that flow. */
  time: number;
}

/** How long a pulse lasts, in real seconds. */
export const IMPACT_SECONDS = 0.22;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Full strength on the hit, then an eased release. `phase` is 0 at the hit and 1 when the pulse ends. */
export function impactEnvelope(phase: number): number {
  return phase < 0.15 ? 1 : 1 - smooth(0.15, 1, phase);
}

export class PostFxState {
  readonly value: PostFx = { speed: 0, impact: 0, impactAt: null, time: 0 };
  private target = 0;
  private t = -1;
  private frames = 0;
  private strength = 1;
  private at: [number, number, number] | null = null;
  private held: number | null = null;

  /** 0 to 1; the shown value eases towards it. */
  setSpeed(v: number): void {
    this.target = Math.min(1, Math.max(0, v || 0));
  }

  /** Starts a pulse. `at` is a world position (the cut), or null for the screen's middle. */
  impact(at: readonly [number, number, number] | null, strength = 1): void {
    this.t = 0;
    this.frames = 0;
    this.strength = Math.min(1, Math.max(0, strength));
    this.at = at ? [at[0], at[1], at[2]] : null;
  }

  cancel(): void {
    this.t = -1;
  }

  get active(): boolean {
    return this.t >= 0 || this.held !== null;
  }

  /** Freezes the pulse at `k` (0 to 1) until released with null: for screenshots and tests. */
  hold(k: number | null, at: readonly [number, number, number] | null = null): void {
    this.held = k;
    if (k !== null) this.at = at ? [at[0], at[1], at[2]] : null;
  }

  /** Advances by `dt` real seconds. */
  update(dt: number): void {
    const v = this.value;
    const d = Math.min(Math.max(dt, 0), 0.1);
    v.speed += (this.target - v.speed) * (1 - Math.exp(-(this.target > v.speed ? 6 : 4) * d));
    v.time += d;
    if (this.held !== null) {
      v.impact = this.held;
    } else if (this.t >= 0) {
      const phase = this.t / IMPACT_SECONDS;
      // Always show at least two frames, however slow the frame rate.
      if (phase >= 1 && this.frames >= 2) {
        this.t = -1;
        v.impact = 0;
      } else {
        v.impact = this.strength * impactEnvelope(phase);
        this.t += Math.min(dt, 0.05);
        this.frames++;
      }
    } else {
      v.impact = 0;
    }
    v.impactAt = this.at;
  }
}
