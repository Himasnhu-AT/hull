import type { Node } from './node.ts';
import type { World } from './world.ts';

export abstract class Behaviour {
  /** Set by `node.add` right after construction (before `init` is assigned and before `ready()`), so a constructor cannot use it. */
  declare readonly node: Node;
  declare readonly world: World;
  /** Field names that are gameplay state: in the checksum and in saves. */
  static state?: readonly string[];
  ready?(): void;
  fixedUpdate?(dt: number): void;
  update?(dt: number, alpha: number): void;
  dispose?(): void;
}
