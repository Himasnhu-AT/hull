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
}

/** A turntable: the character in the middle of a dark floor, a sun, and a camera that keeps its height in frame. */
export function buildCharacterScene(eng: Engine, game: Game): CharacterScene {
  const { Behaviour, config } = eng.hull;
  const { Camera, Light, Mesh, SceneObject } = eng.render;
  const { Animator: A } = eng.anim;
  const { Box3, Vector3 } = eng.three;
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
