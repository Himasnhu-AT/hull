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
  // The character's height is read from its config every frame, so a height edit reframes the shot as it lands.
  class Frame extends Behaviour {
    id: string | null = null;
    override update(): void {
      let h = 1.78;
      if (this.id) {
        try { h = config.lookup('character', this.id.replace(/^character\//, '')).body.proportions?.height ?? 1.78; } catch { /* the file is being edited */ }
      }
      this.node.position.set(0, h * 0.58, h * 2.35 + 0.8);
      this.node.rotation.set(-0.06, 0, 0);
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
      if (!id) return null;
      node = w.spawn('character');
      anim = node.add(A, { character: id });
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
