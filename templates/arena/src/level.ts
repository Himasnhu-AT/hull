import { Behaviour, type Node } from 'hull';
import { Mesh } from 'hull/render';
import { arena } from './tuning.ts';

/** A solid box standing on the floor: centre, half sizes on the floor plane, and the height of its top. */
export interface Block { x: number; z: number; hx: number; hz: number; top: number }

/**
 * The floor, the walls and the crates. The crates are placed from the world's 'layout' random stream, so one seed
 * always gives the same arena. Everything about the layout comes from config/tuning/arena.json.
 */
export class Level extends Behaviour {
  readonly blocks: Block[] = [];
  /** Half the width of the floor. */
  half = 0;

  override ready(): void {
    const size = arena('size');
    this.half = size / 2;
    const w = this.world;

    const floor = w.spawn('floor', this.node);
    floor.scale.set(size, 1, size);
    floor.add(Mesh, { shape: 'plane', material: 'material/floor', castShadow: false });

    const wallH = arena('wallHeight');
    const wallT = arena('wallThickness');
    const edge = this.half + wallT / 2;
    this.addBlock('wall', 0, -edge, size + wallT * 2, wallT, wallH, 'material/wall');
    this.addBlock('wall', 0, edge, size + wallT * 2, wallT, wallH, 'material/wall');
    this.addBlock('wall', -edge, 0, wallT, size, wallH, 'material/wall');
    this.addBlock('wall', edge, 0, wallT, size, wallH, 'material/wall');

    const rnd = w.random('layout');
    const clear = arena('spawnClearRadius');
    const lo = arena('crateMin');
    const hi = arena('crateMax');
    const span = this.half - 2.5;
    for (let i = 0, tries = 0; i < arena('crateCount') && tries < 2000; tries++) {
      const cw = rnd.range(lo, hi);
      const cd = rnd.range(lo, hi);
      const ch = rnd.range(lo, hi * 0.8);
      const x = rnd.range(-span, span);
      const z = rnd.range(-span, span);
      // Keep the start free and leave a lane between crates, so nothing can trap the player.
      if (Math.abs(x) < cw / 2 + clear && Math.abs(z) < cd / 2 + clear) continue;
      if (this.hits(x, z, cw / 2 + 1.5, cd / 2 + 1.5)) continue;
      this.addBlock('crate', x, z, cw, cd, ch, 'material/crate');
      i++;
    }
  }

  private addBlock(name: string, x: number, z: number, w: number, d: number, h: number, material: string): Node {
    const n = this.world.spawn(name, this.node);
    n.position.set(x, h / 2, z);
    n.scale.set(w, h, d);
    n.add(Mesh, { shape: 'box', material });
    this.blocks.push({ x, z, hx: w / 2, hz: d / 2, top: h });
    return n;
  }

  /** True when a box of these half sizes at (x, z) overlaps any block. */
  hits(x: number, z: number, hx: number, hz: number): boolean {
    for (const b of this.blocks) {
      if (Math.abs(x - b.x) < hx + b.hx && Math.abs(z - b.z) < hz + b.hz) return true;
    }
    return false;
  }
}
