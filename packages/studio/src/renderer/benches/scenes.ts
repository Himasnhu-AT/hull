// The two scenes the benches draw. Behaviours extend the engine's own classes, so they are made after the engine
// has loaded. Scene code here is the bench's, not a game's: it may use the real clock where the game has none.

import type { Game, Node } from 'hull';
import type { Animator, BenchModel, BenchModelBuilder } from 'hull/anim';
import type { Engine } from './engine.ts';

export interface CharacterScene {
  /** Replaces the character on the turntable, drawn by the project's builder when it gave one. Returns its animator. */
  setCharacter(id: string | null, build?: BenchModelBuilder | null): Animator | null;
  /** Where the body on show comes from, and what went wrong with the project's builder. */
  source(): { kind: 'project' | 'stand-in'; error: string | null };
  /** The clip the bench is holding (null in State graph mode) and whether it is playing: what a project model's update sees. */
  setView(clip: string | null, playing: boolean): void;
  animator(): Animator | null;
  /** Radians a second; 0 stops the turntable. */
  setTurn(rate: number): void;
  /** Where the look-at target sits (world); null hides it. */
  setTarget(p: { x: number; y: number; z: number } | null): void;
  /**
   * Shows the character where root motion has carried it (metres and radians, in its own frame). The turntable stops and
   * the camera follows; null puts everything back.
   */
  setRoot(o: { x: number; y: number; z: number; yaw: number } | null): void;
  /** Moves the character back to the middle (after root motion has walked it off). */
  recentre(): void;
}

/** A turntable: the character in the middle of a dark floor, a sun, and a camera that keeps its height in frame. */
export function buildCharacterScene(eng: Engine, game: Game): CharacterScene {
  const { Behaviour, config } = eng.hull;
  const { Camera, Light, Mesh, SceneObject } = eng.render;
  const { Animator: A } = eng.anim;
  const { Box3, Vector3, GridHelper } = eng.three;
  const { SceneObject: SO } = eng.render;
  const w = game.world;

  /** Puts a project's body on the character: its own update, then the skeleton's pose copied onto its joints. */
  class Drive extends Behaviour {
    model: BenchModel | null = null;
    anim: Animator | null = null;
    clip: string | null = null;
    playing = true;
    private t = 0;
    override update(dt: number): void {
      const m = this.model, a = this.anim;
      if (!m || !a) return;
      this.t += dt;
      // The bench's own rigid stand-in stays out of sight; the Animator rebuilds it when its files change.
      for (const c of this.node.object3d.children) if (c !== m.object) c.visible = false;
      m.update?.(dt, { animator: a, clip: this.clip, playing: this.playing, time: this.t });
      if (m.bones) {
        const turned = m.turned !== false;
        for (const name in m.bones) {
          const src = a.bone(name), dst = m.bones[name]!;
          if (!src) continue;
          const q = src.quaternion;
          if (turned) dst.quaternion.set(-q.x, q.y, -q.z, q.w); else dst.quaternion.copy(q);
          if (m.offsets) { if (turned) dst.position.set(-src.position.x, src.position.y, -src.position.z); else dst.position.copy(src.position); }
        }
      }
      m.posed?.();
    }
  }

  class Turn extends Behaviour {
    rate = 0.6;
    override fixedUpdate(dt: number): void { this.node.rotation.y += this.rate * dt; }
  }
  // The shot is framed by the character's bounds, read from its skeleton every frame, so a 1.8 m soldier and a 60 m
  // titan both fill the picture and an edit to the body reframes it as it lands.
  class Frame extends Behaviour {
    id: string | null = null;
    anim: Animator | null = null;
    /** The project's body, when there is one: it is framed by its own box (metres), not by the skeleton's rest numbers. */
    model: BenchModel | null = null;
    private box = new Box3();
    private size = new Vector3();
    private age = 0;
    private top0 = 0;
    private half0 = 0;
    /** Bone positions at rest, model space (3 numbers a bone). Reused between frames. */
    private pos = new Float64Array(0);
    override update(): void {
      const sk = this.anim?.skeleton as { n: number; parent: Int16Array; rest: Float64Array } | undefined;
      let top = 1.78, half = 0.5;
      if (this.id && this.model) {
        // Measured now and then, not every frame: the box of a posed body moves a little, and the shot should not breathe.
        if (this.age++ % 45 === 0) {
          const b = this.model.bounds?.() ?? null;
          if (b) this.box.set(this.size.set(b.min[0], b.min[1], b.min[2]), new Vector3(b.max[0], b.max[1], b.max[2]));
          else this.box.setFromObject(this.model.object);
          if (!this.box.isEmpty()) {
            this.box.getSize(this.size);
            this.top0 = Math.max(this.box.max.y, this.size.y);
            this.half0 = Math.max(Math.abs(this.box.min.x), Math.abs(this.box.max.x), Math.abs(this.box.min.z), Math.abs(this.box.max.z));
          }
        }
        if (this.top0 > 0) { top = this.top0; half = Math.max(this.half0 * 1.1, top * 0.2); }
      } else if (this.id && sk && sk.n > 0) {
        if (this.pos.length < sk.n * 3) this.pos = new Float64Array(sk.n * 3);
        const p = this.pos;
        let maxY = 0, reach = 0;
        for (let i = 0; i < sk.n; i++) {
          const q = sk.parent[i]!;
          const o = q < 0 ? 0 : q * 3;
          p[i * 3] = (q < 0 ? 0 : p[o]!) + sk.rest[i * 3]!;
          p[i * 3 + 1] = (q < 0 ? 0 : p[o + 1]!) + sk.rest[i * 3 + 1]!;
          p[i * 3 + 2] = (q < 0 ? 0 : p[o + 2]!) + sk.rest[i * 3 + 2]!;
          maxY = Math.max(maxY, p[i * 3 + 1]!);
          reach = Math.max(reach, Math.abs(p[i * 3]!), Math.abs(p[i * 3 + 2]!));
        }
        // Bones are joints: the head and the hands reach a little past the last one.
        top = maxY * 1.12;
        half = Math.max(reach * 1.15, top * 0.2);
      } else if (this.id) {
        try { top = config.lookup('character', this.id.replace(/^character\//, '')).body.proportions?.height ?? 1.78; } catch { /* the file is being edited */ }
        half = top * 0.3;
      }
      // Distance at which the height (and, on a wide picture, the width) fits in a 40 degree view, with a margin.
      const fit = Math.max(top * 0.5, half * 0.8) / Math.tan(0.349) * 1.18;
      // The shot follows the character when root motion has moved it.
      const n = this.anim?.node;
      this.node.position.set(n ? n.position.x : 0, top * 0.5, (n ? n.position.z : 0) + fit + half);
      this.node.rotation.set(0, 0, 0);
    }
  }

  // A grid on the floor and a line along the way the character faces, so travel can be read off the ground.
  const grid = w.spawn('grid');
  const gh = new GridHelper(80, 80, 0x59616f, 0x39404b);
  gh.position.y = 0.002;
  grid.add(SO, { object: gh });
  const way = w.spawn('way');
  way.add(Mesh, { shape: 'box', color: '#ffb340', castShadow: false });
  way.scale.set(0.03, 0.01, 40);
  way.position.set(0, 0.006, 0);
  const floor = w.spawn('floor');
  floor.scale.set(400, 1, 400);
  floor.add(Mesh, { shape: 'plane', color: '#2b2f37', castShadow: false });
  const sun = w.spawn('sun');
  sun.rotation.set(-0.9, 0.5, 0);
  sun.position.set(0, 30, 0);
  sun.add(Light, { type: 'sun', intensity: 2.4, castShadow: true, shadowSize: 30 });
  sun.add(Light, { type: 'ambient', intensity: 0.5, color: '#9db2d6' });
  const cam = w.spawn('camera');
  cam.add(Camera, { fov: 40, far: 800 });
  const frame = cam.add(Frame);
  const framed = (): void => { frame.model = driver?.model ?? null; };
  const marker = w.spawn('target');
  marker.add(Mesh, { shape: 'sphere', color: '#ffb340', castShadow: false });
  marker.scale.set(0.12, 0.12, 0.12);
  marker.position.set(0, -50, 0);

  let node: Node | null = null;
  let anim: Animator | null = null;
  let driver: Drive | null = null;
  let src: { kind: 'project' | 'stand-in'; error: string | null } = { kind: 'stand-in', error: null };
  let rate = 0.6;
  return {
    setCharacter(id, build) {
      driver?.model?.dispose?.();
      node?.destroy();
      node = null;
      anim = null;
      driver = null;
      frame.id = id;
      frame.anim = null;
      src = { kind: 'stand-in', error: null };
      if (!id) { framed(); return null; }
      node = w.spawn('character');
      anim = node.add(A, { character: id });
      frame.anim = anim;
      anim.ground = () => 0;
      node.add(Turn, { rate });
      if (build) {
        try {
          const model = build(id);
          node.add(SceneObject, { object: model.object });
          driver = node.add(Drive, { model, anim });
          src = { kind: 'project', error: null };
        } catch (e) {
          // A builder that throws leaves the stand-in on show, with the reason beside it.
          src = { kind: 'stand-in', error: e instanceof Error ? e.message : String(e) };
        }
      }
      framed();
      return anim;
    },
    source: () => src,
    setView(clip, playing) { if (driver) { driver.clip = clip; driver.playing = playing; } },
    animator: () => anim,
    setTurn(r) {
      rate = r;
      const t = node?.get(Turn);
      if (t) t.rate = r;
    },
    setRoot(o) {
      if (!node) return;
      const t = node.get(Turn);
      if (!o) {
        if (t) t.rate = rate;
        node.position.set(0, 0, 0);
        return;
      }
      if (t) t.rate = 0;
      // A three-quarter view from the front, held while root motion is shown.
      node.rotation.y = 2.6;
      const cs = Math.cos(node.rotation.y), sn = Math.sin(node.rotation.y);
      node.position.set(o.x * cs + o.z * sn, o.y, -o.x * sn + o.z * cs);
      node.rotation.y += o.yaw;
    },
    recentre() { node?.position.set(0, 0, 0); },
    setTarget(p) {
      if (p) marker.position.set(p.x, p.y, p.z);
      else marker.position.set(0, -50, 0);
    },
  };
}

export interface YardScene {
  /** Where effects go off. */
  at: { x: number; y: number; z: number };
  /** A node that circles, for trails to follow. */
  mover: Node;
}

/** Dusk yard for effects and looks: metal spheres, a wall, a crate and (when there is one) a character. */
export function buildYard(eng: Engine, game: Game, characterId: string | null): YardScene {
  const { Behaviour } = eng.hull;
  const { Camera, Light, Mesh } = eng.render;
  const { Animator: A } = eng.anim;
  const w = game.world;

  class Orbit extends Behaviour {
    static override state = ['angle'];
    angle = 0;
    override fixedUpdate(dt: number): void {
      this.angle += dt * 0.9;
      this.node.position.set(Math.cos(this.angle) * 4, 1.5 + Math.sin(this.angle * 2) * 0.4, -3 + Math.sin(this.angle) * 2);
    }
  }

  const floor = w.spawn('floor');
  floor.scale.set(120, 0.2, 120);
  floor.position.set(0, -0.1, 0);
  floor.add(Mesh, { shape: 'box', material: 'material/floor' });
  const wall = w.spawn('wall');
  wall.scale.set(60, 7, 1.2);
  wall.position.set(0, 3.5, -12);
  wall.add(Mesh, { shape: 'box', material: 'material/wall' });
  const sun = w.spawn('sun');
  sun.rotation.set(-0.7, 0.6, 0);
  sun.position.set(0, 30, 0);
  sun.add(Light, { type: 'sun', intensity: 2, castShadow: true, shadowSize: 25 });
  const mats = ['material/steel', 'material/gem', 'material/crate'];
  for (let i = 0; i < 3; i++) {
    const s = w.spawn(`sphere${i}`);
    s.scale.set(1.8, 1.8, 1.8);
    s.position.set(-3 + i * 3, 0.9, -7);
    s.add(Mesh, { shape: 'sphere', material: mats[i] });
  }
  if (characterId) {
    const c = w.spawn('character');
    c.position.set(2.4, 0, -1.8);
    c.rotation.y = -0.5;
    const a = c.add(A, { character: characterId });
    a.ground = () => 0;
  }
  const mover = w.spawn('mover');
  mover.scale.set(0.35, 0.2, 0.55);
  mover.add(Mesh, { shape: 'box', material: 'material/steel' });
  mover.add(Orbit);
  const cam = w.spawn('camera');
  cam.position.set(0, 1.9, 4.6);
  cam.rotation.x = -0.14;
  cam.add(Camera, { fov: 48, far: 400 });
  return { at: { x: 0, y: 0.4, z: -2 }, mover };
}

export interface FxScene {
  /** Where effects go off. The bench moves it between the floor and the air. */
  at: { x: number; y: number; z: number };
  /** A node that circles, for trails to follow. */
  mover: Node;
  /** Which effect the camera frames (a config id such as vfx/chip-dirt), null for none. */
  setEffect(id: string | null): void;
  /** true: the effect goes off on the floor, as an impact does; false: in the air at a third of its reach. */
  setOnFloor(on: boolean): void;
  /** Shows the node that circles, for a trail to follow. */
  setMoverShown(on: boolean): void;
  /** Metres the effect reaches, as the camera last framed it. */
  reach(): number;
}

/** What the camera needs to know about an effect: how far its particles travel, in metres. A rough bound, not a simulation. */
export function effectReach(eng: Engine, id: string | null): number {
  if (!id) return 3;
  try {
    const v = eng.hull.config.lookup('vfx', id.replace(/^vfx\//, '')) as { emit?: { shape?: Record<string, unknown> }; particle: { life: [number, number]; speed: [number, number]; gravity?: number; drag?: number; size?: [number, number][]; sizeScale?: [number, number] } };
    const p = v.particle;
    const life = p.life[1], speed = p.speed[1];
    const drag = p.drag ?? 0;
    // With drag the particle stops after speed/drag metres; without, it runs for the whole life. Gravity bends it down, so it never goes far above the bound.
    let run = drag > 0.01 ? Math.min(speed * life, speed / drag) : speed * life;
    // A heavy particle falls back after v^2/g metres, so grit that is thrown at 5 m/s lands within two metres.
    const g = p.gravity ?? 0;
    if (g < -1) run = Math.min(run, (speed * speed) / -g * 1.2);
    const sh = v.emit?.shape ?? {};
    const spread = Math.max(0, ...Object.values(sh).flatMap((x) => (typeof x === 'number' ? [x] : Array.isArray(x) ? x.filter((n): n is number => typeof n === 'number') : [])));
    const size = Math.max(0, ...(p.size ?? []).map((k) => k[1])) * (p.sizeScale?.[1] ?? 1);
    // Small particles need the camera close: a 7 cm chip is a speck beyond four metres, whatever the burst's reach.
    return Math.min(40, Math.max(1.2, Math.min(run * 0.8 + spread + size * 0.5, size * 14)));
  } catch { return 3; }
}

/**
 * A stage for effects of any size: a floor with a one-metre grid and a person-high post for scale, and a camera that
 * stands back far enough to see the effect's reach, so a speck of grit and a plume of steam both fill the picture.
 */
export function buildFxScene(eng: Engine, game: Game): FxScene {
  const { Behaviour, config } = eng.hull;
  const { Camera, Light, Mesh } = eng.render;
  const w = game.world;
  let reach = 3;
  let effect: string | null = null;
  const at = { x: 0, y: 0.02, z: 0 };
  let onFloor = true;
  let showMover = false;

  class Orbit extends Behaviour {
    static override state = ['angle'];
    angle = 0;
    override fixedUpdate(dt: number): void {
      this.angle += dt * 0.9;
      // Out of sight until a trail follows it.
      if (!showMover) { this.node.position.set(0, -50, 0); return; }
      const r = Math.max(1.5, reach * 0.8);
      this.node.position.set(Math.cos(this.angle) * r, 0.5 + reach * 0.15 + Math.sin(this.angle * 2) * reach * 0.05, Math.sin(this.angle) * r * 0.5);
    }
  }
  // Eased, and read every frame, so an edit to the effect's speed or life reframes the shot as it lands.
  class Frame extends Behaviour {
    private dist = 0;
    override update(dt: number): void {
      reach = effectReach(eng, effect);
      at.y = onFloor ? 0.02 : Math.max(1, reach * 0.35);
      const want = reach * 1.8 + 1;
      this.dist = this.dist === 0 ? want : this.dist + (want - this.dist) * Math.min(1, dt * 4);
      const look = Math.max(0.3, reach * 0.3) + (onFloor ? 0 : at.y * 0.6);
      const h = Math.max(0.8, reach * 0.55);
      this.node.position.set(0, h, this.dist);
      this.node.rotation.set(-Math.atan2(h - look, this.dist), 0, 0);
    }
  }

  const floor = w.spawn('floor');
  floor.scale.set(400, 1, 400);
  floor.add(Mesh, { shape: 'plane', color: '#555b66', castShadow: false });
  // Grid every metre out to 24 m: thin boxes, laid just above the floor.
  for (let i = -24; i <= 24; i++) {
    const heavy = i % 5 === 0;
    const a = w.spawn('grid');
    a.scale.set(48, 0.004, heavy ? 0.05 : 0.02);
    a.position.set(0, 0.003, i);
    a.add(Mesh, { shape: 'box', color: heavy ? '#8a93a3' : '#6b7280', castShadow: false });
    const b = w.spawn('grid');
    b.scale.set(heavy ? 0.05 : 0.02, 0.004, 48);
    b.position.set(i, 0.003, 0);
    b.add(Mesh, { shape: 'box', color: heavy ? '#8a93a3' : '#6b7280', castShadow: false });
  }
  const post = w.spawn('post');
  post.scale.set(0.12, 1.8, 0.12);
  post.position.set(-1.6, 0.9, -0.6);
  post.add(Mesh, { shape: 'box', color: '#d9a441' });
  const sun = w.spawn('sun');
  sun.rotation.set(-0.9, 0.5, 0);
  sun.position.set(0, 30, 0);
  sun.add(Light, { type: 'sun', intensity: 2.2, castShadow: true, shadowSize: 30 });
  sun.add(Light, { type: 'ambient', intensity: 0.6, color: '#b4c2dc' });
  const mover = w.spawn('mover');
  mover.scale.set(0.35, 0.2, 0.55);
  mover.add(Mesh, { shape: 'box', color: '#9fb4d6' });
  mover.add(Orbit);
  const cam = w.spawn('camera');
  cam.add(Camera, { fov: 45, far: 600 });
  cam.add(Frame);
  void config;
  return {
    at, mover,
    setEffect(id) { effect = id; },
    setOnFloor(on) { onFloor = on; },
    setMoverShown(on) { showMover = on; },
    reach: () => reach,
  };
}
