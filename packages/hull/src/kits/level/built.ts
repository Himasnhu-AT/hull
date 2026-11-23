import { Behaviour, type Node } from '../../core/index.ts';
import { config } from '../../config/index.ts';
import { Mesh, Model } from '../../render/index.ts';
import { Collider } from '../../physics/index.ts';
import type { ShapeDesc } from '../../physics/index.ts';
import type { Level as LevelDef, Prefab } from '../../schema/index.ts';
import { applyLook, ensurePhysics, LAYER, type LevelBounds, type LevelLike, type LevelMarker } from '../common.ts';
import type { Block } from './level.ts';

const RAD = Math.PI / 180;
const SIDES = 12;
const NO_THINGS: readonly Node[] = Object.freeze([]);
const bare = (id: string): string => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id);

/** A cylinder standing on its flat end as a closed prism in the node's own space, for the static mesh collider (physics has no cylinder). */
function prismMesh(sx: number, sy: number, sz: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const put = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const top = put(0, sy / 2, 0);
  const bottom = put(0, -sy / 2, 0);
  const ring: number[] = [];
  for (let i = 0; i < SIDES; i++) {
    const a = (i / SIDES) * Math.PI * 2;
    ring.push(put(Math.cos(a) * sx / 2, sy / 2, Math.sin(a) * sz / 2), put(Math.cos(a) * sx / 2, -sy / 2, Math.sin(a) * sz / 2));
  }
  for (let i = 0; i < SIDES; i++) {
    const j = (i + 1) % SIDES;
    const t0 = ring[i * 2]!, b0 = ring[i * 2 + 1]!, t1 = ring[j * 2]!, b1 = ring[j * 2 + 1]!;
    indices.push(top, t1, t0, bottom, b0, b1, t0, t1, b1, t0, b1, b0);
  }
  return { positions, indices };
}

/**
 * A level built from a `config/level/<id>.json`: ground, optional walls, blocks (ramps are turned boxes), things made from
 * prefabs, named markers and scatter rules. Everything solid sits on physics layer `world`. Scatter and `freeSpot` draw
 * from the world's named random streams, so one seed gives one layout. Game code attaches behaviours to what it built:
 * `things('prefab/crate')`, `marker('start')`.
 */
export class Level extends Behaviour implements LevelLike {
  /** The level file, relative to config/level: 'yard' reads config/level/yard.json. Set it before the node starts. */
  level = '';
  /** The look the file names ('look/day'); undefined when the level names none. */
  look: string | undefined = undefined;
  /** The level puts the page in the look its file names. Set false (when adding) to choose the look yourself. */
  applyLook = true;
  private lookDone = false;

  /** The renderer mounts after `ready`, so the look is applied on the first frame that finds it. */
  override update(): void {
    if (this.lookDone) return;
    this.lookDone = !this.applyLook || !this.look || applyLook(this.look);
  }
  readonly bounds: LevelBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  /** Obstacles on the floor as boxes (solid blocks, solid things, walls), for `hits` and `freeSpot`. */
  readonly blocks: Block[] = [];
  private readonly byName = new Map<string, LevelMarker>();
  private readonly all: LevelMarker[] = [];
  private readonly byPrefix = new Map<string, readonly LevelMarker[]>();
  private readonly made = new Map<string, Node[]>();

  /** The shorter half of the ground, the distance from the middle to the nearest edge. */
  get half(): number {
    return Math.min(this.bounds.maxX - this.bounds.minX, this.bounds.maxZ - this.bounds.minZ) / 2;
  }

  override ready(): void {
    if (this.level === '') throw new Error(`Level on "${this.node.name}" needs its \`level\` set to a config/level id`);
    const def = config.lookup('level', bare(this.level)) as LevelDef;
    this.look = def.look;
    const phys = ensurePhysics(this.world);
    const [gw, gd] = def.ground.size;
    this.bounds.minX = -gw / 2; this.bounds.maxX = gw / 2; this.bounds.minZ = -gd / 2; this.bounds.maxZ = gd / 2;
    phys.addGround(0, { layer: LAYER.world });
    const floor = this.world.spawn('floor', this.node);
    floor.scale.set(gw, 1, gd);
    floor.add(Mesh, { shape: 'plane', material: def.ground.material, castShadow: false });

    if (def.walls) {
      const h = def.walls.height;
      const t = def.walls.thickness ?? 0.6;
      const ex = gw / 2 + t / 2;
      const ez = gd / 2 + t / 2;
      this.addBox('wall', 0, h / 2, -ez, gw + t * 2, h, t, def.walls.material);
      this.addBox('wall', 0, h / 2, ez, gw + t * 2, h, t, def.walls.material);
      this.addBox('wall', -ex, h / 2, 0, t, h, gd, def.walls.material);
      this.addBox('wall', ex, h / 2, 0, t, h, gd, def.walls.material);
    }
    for (const b of def.blocks ?? []) this.addBlock(b);

    for (const [name, m] of Object.entries(def.markers ?? {})) {
      const mk: LevelMarker = { name, x: m.at[0], y: m.at[1], z: m.at[2], yaw: (m.yawDeg ?? 0) * RAD };
      this.byName.set(name, mk);
      this.all.push(mk);
    }

    for (const t of def.things ?? []) this.addThing(t.prefab, t.at[0], t.at[1], t.at[2], (t.yawDeg ?? 0) * RAD, t.scale ?? 1);

    for (const s of def.scatter ?? []) {
      const rnd = this.world.random(s.stream);
      const prefab = config.lookup('prefab', bare(s.prefab)) as Prefab;
      const r = footprint(prefab);
      const gap = s.gap ?? 1;
      const away = s.avoidMarkers ?? 3;
      const [ax, az] = s.area.at;
      const [aw, ad] = s.area.size;
      for (let placed = 0, tries = 0; placed < s.count && tries < s.count * 40 + 40; tries++) {
        const x = rnd.range(ax - aw / 2, ax + aw / 2);
        const z = rnd.range(az - ad / 2, az + ad / 2);
        const yaw = (s.randomYaw ?? true) ? rnd.range(0, Math.PI * 2) : 0;
        if (x - r < this.bounds.minX || x + r > this.bounds.maxX || z - r < this.bounds.minZ || z + r > this.bounds.maxZ) continue;
        if (this.hits(x, z, r + gap, r + gap)) continue;
        if (this.nearMarker(x, z, away + r)) continue;
        this.addThing(s.prefab, x, 0, z, yaw, 1);
        placed++;
      }
    }
  }

  private nearMarker(x: number, z: number, d: number): boolean {
    for (let i = 0; i < this.all.length; i++) {
      const m = this.all[i]!;
      if (Math.hypot(m.x - x, m.z - z) < d) return true;
    }
    return false;
  }

  private addBox(name: string, x: number, y: number, z: number, w: number, h: number, d: number, material: string): void {
    const n = this.world.spawn(name, this.node);
    n.position.set(x, y, z);
    n.add(Collider, { shape: { type: 'box', size: [w, h, d] }, static: true, layer: LAYER.world });
    const look = this.world.spawn('mesh', n);
    look.scale.set(w, h, d);
    look.add(Mesh, { shape: 'box', material });
    this.blocks.push({ x, z, hx: w / 2, hz: d / 2, top: y + h / 2 });
  }

  private addBlock(b: NonNullable<LevelDef['blocks']>[number]): void {
    const [x, y, z] = b.at;
    const [w, h, d] = b.size;
    const cyl = b.shape === 'cylinder';
    const n = this.world.spawn(b.name ?? (cyl ? 'pillar' : 'block'), this.node);
    n.position.set(x, y, z);
    if (b.rotDeg) n.rotation.set(b.rotDeg[0] * RAD, b.rotDeg[1] * RAD, b.rotDeg[2] * RAD);
    const look = this.world.spawn('mesh', n);
    look.scale.set(w, h, d);
    look.add(Mesh, { shape: cyl ? 'cylinder' : 'box', material: b.material });
    if (b.solid === false) return;
    const shape: ShapeDesc = cyl ? { type: 'mesh', ...prismMesh(w, h, d) } : { type: 'box', size: [w, h, d] };
    n.add(Collider, { shape, static: true, layer: LAYER.world });
    this.obstacle(n, w / 2, h / 2, d / 2);
  }

  /** Records the floor box that an oriented box covers (its bounding box, so a ramp counts as its whole footprint). */
  private obstacle(n: Node, hx: number, hy: number, hz: number): void {
    n.object3d.updateWorldMatrix(true, false);
    const e = n.object3d.matrixWorld.elements;
    const ex = Math.abs(e[0]!) * hx + Math.abs(e[4]!) * hy + Math.abs(e[8]!) * hz;
    const ey = Math.abs(e[1]!) * hx + Math.abs(e[5]!) * hy + Math.abs(e[9]!) * hz;
    const ez = Math.abs(e[2]!) * hx + Math.abs(e[6]!) * hy + Math.abs(e[10]!) * hz;
    this.blocks.push({ x: e[12]!, z: e[14]!, hx: ex, hz: ez, top: e[13]! + ey });
  }

  private addThing(prefabId: string, x: number, y: number, z: number, yaw: number, scale: number): void {
    const p = config.lookup('prefab', bare(prefabId)) as Prefab;
    const n = this.world.spawn(bare(prefabId), this.node);
    n.position.set(x, y, z);
    n.rotation.y = yaw;
    for (const tag of p.tags ?? []) n.addTo(tag);
    for (const part of p.parts) {
      const c = this.world.spawn(part.name ?? (part.model !== undefined ? 'model' : part.shape ?? 'box'), n);
      c.position.set(part.at[0] * scale, part.at[1] * scale, part.at[2] * scale);
      if (part.rotDeg) c.rotation.set(part.rotDeg[0] * RAD, part.rotDeg[1] * RAD, part.rotDeg[2] * RAD);
      c.scale.set(part.size[0] * scale, part.size[1] * scale, part.size[2] * scale);
      // A model keeps the materials of its file unless the part names one; a shape always has one (checkPrefab says so).
      if (part.model !== undefined) c.add(Model, part.material !== undefined ? { file: part.model, material: part.material } : { file: part.model });
      else c.add(Mesh, { shape: part.shape ?? 'box', material: part.material ?? '' });
    }
    if (p.collider) {
      const k = p.collider;
      const c = this.world.spawn('collider', n);
      const at = k.at ?? [0, 0, 0];
      c.position.set(at[0] * scale, at[1] * scale, at[2] * scale);
      const [sx, sy, sz] = [k.size[0] * scale, k.size[1] * scale, k.size[2] * scale];
      const shape: ShapeDesc = k.shape === 'sphere' ? { type: 'sphere', radius: sx / 2 }
        : k.shape === 'capsule' ? { type: 'capsule', radius: sx / 2, height: sy }
        : { type: 'box', size: [sx, sy, sz] };
      c.add(Collider, { shape, static: true, layer: LAYER.world });
      if (k.shape === 'box') this.obstacle(c, sx / 2, sy / 2, sz / 2);
      else this.blocks.push({ x: x + at[0] * scale, z: z + at[2] * scale, hx: sx / 2, hz: sx / 2, top: y + at[1] * scale + sy / 2 });
    }
    let list = this.made.get(`prefab/${bare(prefabId)}`);
    if (!list) { list = []; this.made.set(`prefab/${bare(prefabId)}`, list); }
    list.push(n);
  }

  /** The nodes built from a prefab ('prefab/crate' or 'crate'), placed things and scattered ones alike, in build order. */
  things(prefab: string): readonly Node[] {
    return this.made.get(`prefab/${bare(prefab)}`) ?? NO_THINGS;
  }

  /** The named marker, or null. The object is the level's own: read it, do not change it. */
  marker(name: string): LevelMarker | null {
    return this.byName.get(name) ?? null;
  }

  /** Every marker whose name starts with `prefix` ('' for all), in file order. The list is built once per prefix. */
  markers(prefix = ''): readonly LevelMarker[] {
    let list = this.byPrefix.get(prefix);
    if (!list) { list = this.all.filter((m) => m.name.startsWith(prefix)); this.byPrefix.set(prefix, list); }
    return list;
  }

  /** True when a box of these half sizes at (x, z) overlaps any obstacle, or reaches past the ground. */
  hits(x: number, z: number, hx: number, hz: number): boolean {
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i]!;
      if (Math.abs(x - b.x) < hx + b.hx && Math.abs(z - b.z) < hz + b.hz) return true;
    }
    return false;
  }

  /**
   * Writes a spot on the floor that is clear of obstacles by `margin` and at least `awayFrom` metres from (ax, az) into
   * `out`, drawn from the named random stream. Returns false when none was found in 60 tries.
   */
  freeSpot(out: { x: number; z: number }, margin: number, stream: string, ax = 0, az = 0, awayFrom = 0): boolean {
    const rnd = this.world.random(stream);
    const b = this.bounds;
    const x0 = b.minX + margin + 0.5, x1 = b.maxX - margin - 0.5, z0 = b.minZ + margin + 0.5, z1 = b.maxZ - margin - 0.5;
    if (x1 <= x0 || z1 <= z0) return false;
    for (let i = 0; i < 60; i++) {
      const x = rnd.range(x0, x1);
      const z = rnd.range(z0, z1);
      if (this.hits(x, z, margin, margin)) continue;
      if (Math.hypot(x - ax, z - az) < awayFrom) continue;
      out.x = x;
      out.z = z;
      return true;
    }
    return false;
  }
}

/** Radius of the circle on the floor that holds a prefab (its collider if it has one, else its parts). */
function footprint(p: Prefab): number {
  let r = 0;
  if (p.collider) {
    const a = p.collider.at ?? [0, 0, 0];
    r = Math.hypot(Math.abs(a[0]) + p.collider.size[0] / 2, Math.abs(a[2]) + (p.collider.shape === 'box' ? p.collider.size[2] : p.collider.size[0]) / 2);
  } else for (const q of p.parts) r = Math.max(r, Math.hypot(Math.abs(q.at[0]) + q.size[0] / 2, Math.abs(q.at[2]) + q.size[2] / 2));
  return r;
}
