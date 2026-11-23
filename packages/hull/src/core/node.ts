import { Object3D } from 'three';
import type { Euler, Vector3 } from 'three';
import type { Behaviour } from './behaviour.ts';
import type { Listener } from './signal.ts';
import type { World } from './world.ts';

/** A thing in the scene. Its transform and parent links are a three.js Object3D, so the scene graph is the render graph. */
export class Node {
  name: string;
  readonly world: World;
  readonly object3d: Object3D;
  readonly position: Vector3;
  readonly rotation: Euler;
  readonly scale: Vector3;

  /** @internal Engine state below: underscore names are for core's own files, not for games. */
  _parent: Node | null;
  _children: Node[] = [];
  _behaviours: Behaviour[] = [];
  /** Every behaviour on this node, in the order they were added. Saves and tools walk it; game code uses `get`. */
  get behaviours(): readonly Behaviour[] { return this._behaviours; }
  _groups: string[] = [];
  _links: Listener[] | null = null;
  _pending = false;
  _destroyed = false;

  constructor(world: World, name: string, parent: Node | null) {
    this.world = world;
    this.name = name;
    this._parent = parent;
    this.object3d = new Object3D();
    this.position = this.object3d.position;
    this.rotation = this.object3d.rotation;
    this.scale = this.object3d.scale;
    if (parent !== null) {
      parent._children.push(this);
      parent.object3d.add(this.object3d);
    }
  }

  get parent(): Node | null {
    return this._parent;
  }
  get children(): readonly Node[] {
    return this._children;
  }
  get destroyed(): boolean {
    return this._destroyed;
  }

  /** Adds a behaviour: builds it, sets its fields from `init`, then calls its `ready()`. Returns it. */
  add<B extends Behaviour>(type: new () => B, init?: Partial<B>): B {
    if (this._destroyed) throw new Error(`Node "${this.name}" is destroyed; cannot add a behaviour`);
    const b = new type();
    // node and world are readonly for games; core sets them before init and before ready().
    const m = b as unknown as { node: Node; world: World };
    m.node = this;
    m.world = this.world;
    if (init !== undefined) Object.assign(b, init);
    this._behaviours.push(b);
    this.world._register(b);
    b.ready?.();
    return b;
  }

  /** The first behaviour on this node that is a `type` (or a subclass of it), or undefined. */
  get<B extends Behaviour>(type: new () => B): B | undefined {
    const list = this._behaviours;
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      if (b instanceof type) return b;
    }
    return undefined;
  }

  /** Puts the node in a named group, which `world.group(name)` lists. Adding twice does nothing. */
  addTo(group: string): this {
    const arr = this.world._groupArray(group);
    if (arr.indexOf(this) < 0) {
      arr.push(this);
      this._groups.push(group);
    }
    return this;
  }

  /** Takes the node out of a named group. */
  removeFrom(group: string): this {
    const arr = this.world._groupArray(group);
    const i = arr.indexOf(this);
    if (i >= 0) arr.splice(i, 1);
    const j = this._groups.indexOf(group);
    if (j >= 0) this._groups.splice(j, 1);
    return this;
  }

  /** Removes the node, its children and its behaviours (this is how to remove a node). It takes effect at the end of the current step, and its signal connections end with it. */
  destroy(): void {
    if (this._pending || this._destroyed) return;
    this._pending = true;
    this.world._pendingDestroy.push(this);
  }

  /** @internal */
  _link(l: Listener): void {
    if (this._links === null) this._links = [];
    this._links.push(l);
  }

  /** @internal */
  _unlink(l: Listener): void {
    const links = this._links;
    if (links === null) return;
    const i = links.indexOf(l);
    if (i >= 0) links.splice(i, 1);
  }

  /** @internal Children first, then this node's behaviours, groups and connections, then the node leaves its parent. */
  _destroyNow(detach: boolean): void {
    if (this._destroyed) return;
    this._destroyed = true;
    const kids = this._children;
    for (let i = kids.length - 1; i >= 0; i--) kids[i]!._destroyNow(false);
    kids.length = 0;

    const bs = this._behaviours;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i]!;
      this.world._unregister(b);
      b.dispose?.();
    }
    bs.length = 0;

    const groups = this._groups;
    for (let i = 0; i < groups.length; i++) {
      const arr = this.world._groupArray(groups[i]!);
      const k = arr.indexOf(this);
      if (k >= 0) arr.splice(k, 1);
    }
    groups.length = 0;

    const links = this._links;
    if (links !== null) {
      for (let i = 0; i < links.length; i++) links[i]!.end(true);
      links.length = 0;
    }

    if (detach && this._parent !== null) {
      const sib = this._parent._children;
      const k = sib.indexOf(this);
      if (k >= 0) sib.splice(k, 1);
    }
    this.object3d.removeFromParent();
  }
}
