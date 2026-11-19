// A supply depot without the pickup node: a zone you stand in until it resupplies you, then not again for a while.
// For a game whose player is not a node (a counter is a plain number on its own object), so Stock does not fit.

/** How long to stand there, and how long the depot is spent afterwards. */
export interface DepotRules {
  dwell: number;
  cooldown: number;
}

export interface DepotState {
  /** Seconds spent inside while something needed filling; negative during the cooldown. */
  t: number;
}

export function newDepotState(): DepotState { return { t: 0 }; }

/**
 * One step. `inside`: the player is within the depot's radius; `needs`: something is below full. Returns true on the
 * step the depot gives its supplies. Leaving the zone starts the wait over; nothing is counted while nothing is needed.
 */
export function stepDepot(s: DepotState, dt: number, inside: boolean, needs: boolean, r: DepotRules): boolean {
  if (!inside) { s.t = 0; return false; }
  if (!needs) return false;
  s.t += dt;
  if (s.t > r.dwell) { s.t = -r.cooldown; return true; }
  return false;
}

/** Fills `current` toward `max`: `fraction` 1 fills it, 0.5 brings it up to half; never lowers it. */
export function fillTo(current: number, max: number, fraction: number): number {
  return Math.max(current, max * fraction);
}
