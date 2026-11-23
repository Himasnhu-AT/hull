import type { Node } from './node.ts';
import type { World } from './world.ts';

export abstract class Behaviour {
  /** Set by `node.add` right after construction (before `init` is assigned and before `ready()`), so a constructor cannot use it. */
  declare readonly node: Node;
  /** The world this behaviour's node lives in. */
  declare readonly world: World;
  /** Field names that are gameplay state: in the checksum and in saves. */
  static state?: readonly string[];
  /** Called once, right after `node.add` has set the fields. Find other nodes and connect signals here. */
  ready?(): void;
  /** Called every fixed step with the step length in seconds: the simulation lives here (movement, rules, timers). */
  fixedUpdate?(dt: number): void;
  /** Called every drawn frame; `alpha` (0 to 1) is how far the frame is between two fixed steps. Only the picture changes here, never the game state. */
  update?(dt: number, alpha: number): void;
  /** Called when the node is destroyed: release what `ready` made (listeners, scene objects). */
  dispose?(): void;
}
