// The two scenes the benches draw. Behaviours extend the engine's own classes, so they are made after the engine
// has loaded. Scene code here is the bench's, not a game's: it may use the real clock where the game has none.

import type { Game, Node } from 'hull';
import type { Animator } from 'hull/anim';
import type { Engine } from './engine.ts';

export interface CharacterScene {
  /** Replaces the character on the turntable. Returns its animator. */
  setCharacter(id: string | null): Animator | null;
  animator(): Animator | null;
  /** Radians a second; 0 stops the turntable. */
  setTurn(rate: number): void;
  /** Where the look-at target sits (world); null hides it. */
  setTarget(p: { x: number; y: number; z: number } | null): void;
}

/** A turntable: the character in the middle of a dark floor, a sun, and a camera that keeps its height in frame. */
export function buildCharacterScene(eng: Engine, game: Game): CharacterScene {
  const { Behaviour, config } = eng.hull;
  const { Camera, Light, Mesh } = eng.render;
  const { Animator: A } = eng.anim;
  const w = game.world;

  class Turn extends Behaviour {
    rate = 0.6;
    override fixedUpdate(dt: number): void { this.node.rotation.y += this.rate * dt; }
  }
  // The shot is framed by the character's bounds, read from its skeleton every frame, so a 1.8 m soldier and a 60 m
  // titan both fill the picture and an edit to the body reframes it as it lands.
  class Frame extends Behaviour {
    id: string | null = null;
    anim: Animator | null = null;
    /** Bone positions at rest, model space (3 numbers a bone). Reused between frames. */
    private pos = new Float64Array(0);
    override update(): void {
      const sk = this.anim?.skeleton as { n: number; parent: Int16Array; rest: Float64Array } | undefined;
      let top = 1.78, half = 0.5;
      if (this.id && sk && sk.n > 0) {
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
      this.node.position.set(0, top * 0.5, fit + half);
      this.node.rotation.set(0, 0, 0);
    }
  }

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
  const marker = w.spawn('target');
  marker.add(Mesh, { shape: 'sphere', color: '#ffb340', castShadow: false });
  marker.scale.set(0.12, 0.12, 0.12);
  marker.position.set(0, -50, 0);

  let node: Node | null = null;
  let anim: Animator | null = null;
  let rate = 0.6;
  return {
    setCharacter(id) {
      node?.destroy();
      node = null;
      anim = null;
      frame.id = id;
      frame.anim = null;
      if (!id) return null;
      node = w.spawn('character');
      anim = node.add(A, { character: id });
      frame.anim = anim;
      anim.ground = () => 0;
      node.add(Turn, { rate });
      return anim;
    },
    animator: () => anim,
    setTurn(r) {
      rate = r;
      const t = node?.get(Turn);
      if (t) t.rate = r;
    },
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
