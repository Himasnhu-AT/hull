import { Behaviour, type Node } from '../../core/index.ts';
import { num, tunables } from '../../config/index.ts';
import { Mesh } from '../../render/index.ts';
import { Collider } from '../../physics/index.ts';
import { applyLook, ensurePhysics, LAYER, type LevelBounds, type LevelLike, type LevelMarker } from '../common.ts';

// The layout is built once in `ready`, so these take effect on the next start, not live.
export const levelTuning = tunables('level', {
  size: num(40, { min: 10, max: 200, step: 2, unit: 'm', widget: 'dial', help: 'Width of the square floor.' }),
  wallHeight: num(2.5, { min: 0.5, max: 10, step: 0.25, unit: 'm' }),
  crateCount: num(14, { min: 0, max: 80, step: 1, widget: 'dial', help: 'Boxes to hide behind and jump over.' }),
  crateMin: num(1.2, { min: 0.4, max: 6, step: 0.1, unit: 'm' }),
  crateMax: num(2.6, { min: 0.6, max: 10, step: 0.1, unit: 'm' }),
  clearRadius: num(4, { min: 0, max: 20, step: 0.5, unit: 'm', help: 'Free space around the start.' }),
});

const NONE: readonly never[] = Object.freeze([]);

/** A solid box on the floor: centre, half sizes on the floor plane, and the height of its top. */
export interface Block { x: number; z: number; hx: number; hz: number; top: number }

/**
 * A square arena: a floor, four walls and random crates, all solid to the physics (layer `world`). The crates come
 * from the world's 'level' random stream, so one seed always gives the same arena. Other kits ask it where there is
 * free floor (`freeSpot`) and how big it is (`half`).
 */
export class ArenaLevel extends Behaviour implements LevelLike {
  readonly blocks: Block[] = [];
  half = 0;
  readonly bounds: LevelBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  floorMaterial = 'material/floor';
  wallMaterial = 'material/wall';
  crateMaterial = 'material/crate';
  /**
   * The look the arena puts the page in ('look/day' unless you say otherwise): sky, sun, fog and post effects. Use
   * another id for another time of day, or '' to leave the page's starting look alone. Set it when adding.
   */
  look = 'look/day';
  private lookDone = false;

  /** The renderer mounts after `ready`, so the look is applied on the first frame that finds it. */
  override update(): void {
    if (!this.lookDone) this.lookDone = applyLook(this.look);
  }

  override ready(): void {
    const size = levelTuning.size;
    this.half = size / 2;
    this.bounds.minX = this.bounds.minZ = -this.half;
    this.bounds.maxX = this.bounds.maxZ = this.half;
    const w = this.world;
    ensurePhysics(w).addGround(0, { layer: LAYER.world });

    const floor = w.spawn('floor', this.node);
    floor.scale.set(size, 1, size);
    floor.add(Mesh, { shape: 'plane', material: this.floorMaterial, castShadow: false });

    const wallH = levelTuning.wallHeight;
    const t = 0.6;
    const edge = this.half + t / 2;
    this.addBlock('wall', 0, -edge, size + t * 2, t, wallH, this.wallMaterial);
    this.addBlock('wall', 0, edge, size + t * 2, t, wallH, this.wallMaterial);
    this.addBlock('wall', -edge, 0, t, size, wallH, this.wallMaterial);
    this.addBlock('wall', edge, 0, t, size, wallH, this.wallMaterial);

    const rnd = w.random('level');
    const lo = levelTuning.crateMin;
    const hi = Math.max(lo, levelTuning.crateMax);
    const clear = levelTuning.clearRadius;
    const span = this.half - 2.5;
    for (let i = 0, tries = 0; i < levelTuning.crateCount && tries < 2000; tries++) {
      const cw = rnd.range(lo, hi);
      const cd = rnd.range(lo, hi);
      const ch = rnd.range(lo, hi * 0.8);
      const x = rnd.range(-span, span);
      const z = rnd.range(-span, span);
      // Keep the start free and leave a lane between crates, so nothing can trap anyone.
      if (Math.abs(x) < cw / 2 + clear && Math.abs(z) < cd / 2 + clear) continue;
      if (this.hits(x, z, cw / 2 + 1.5, cd / 2 + 1.5)) continue;
      this.addBlock('crate', x, z, cw, cd, ch, this.crateMaterial);
      i++;
    }
  }

  private readonly named = new Map<string, number>();

  private addBlock(name: string, x: number, z: number, w: number, d: number, h: number, material: string): Node {
    // wall0..wall3, crate0, crate1, ...: one name each, so a find, a save and the tree can tell them apart.
    const k = this.named.get(name) ?? 0;
    this.named.set(name, k + 1);
    const n = this.world.spawn(name + k, this.node);
    n.position.set(x, h / 2, z);
    n.add(Collider, { shape: { type: 'box', size: [w, h, d] }, static: true, layer: LAYER.world });
    const look = this.world.spawn('mesh', n);
    look.scale.set(w, h, d);
    look.add(Mesh, { shape: 'box', material });
    this.blocks.push({ x, z, hx: w / 2, hz: d / 2, top: h });
    return n;
  }

  /** The arena has no named points. */
  marker(_name: string): LevelMarker | null { return null; }
  markers(_prefix = ''): readonly LevelMarker[] { return NONE; }
  /** The arena is made of blocks, not prefabs. */
  things(_prefab: string): readonly Node[] { return NONE; }

  /** True when a box of these half sizes at (x, z) overlaps any block. */
  hits(x: number, z: number, hx: number, hz: number): boolean {
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i]!;
      if (Math.abs(x - b.x) < hx + b.hx && Math.abs(z - b.z) < hz + b.hz) return true;
    }
    return false;
  }

  /**
   * Writes a spot on the floor that is clear of blocks by `margin` and at least `awayFrom` metres from (ax, az)
   * into `out`, drawn from the named random stream. Returns false when none was found in 60 tries.
   */
  freeSpot(out: { x: number; z: number }, margin: number, stream: string, ax = 0, az = 0, awayFrom = 0): boolean {
    const rnd = this.world.random(stream);
    const span = this.half - margin - 0.5;
    for (let i = 0; i < 60; i++) {
      const x = rnd.range(-span, span);
      const z = rnd.range(-span, span);
      if (this.hits(x, z, margin, margin)) continue;
      if (Math.hypot(x - ax, z - az) < awayFrom) continue;
      out.x = x;
      out.z = z;
      return true;
    }
    return false;
  }
}
