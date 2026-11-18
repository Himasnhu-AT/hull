// A page that shows the example soldier and titan side by side, each walking a circle through its graph.
// Drive it from a script through `window.hull`: pause, `step(n)`, pick a camera, set parameters, read the state.
import { Behaviour, config, defineGame, startGame, type Game } from '../../../index.ts';
import { Camera, Light, Mesh, mountRender } from '../../../render/index.ts';
import { Animator } from '../../index.ts';
import { exampleSources } from '../load.ts';

/** Walks its node around a circle at the speed it is told and keeps the animator's parameters in step. */
class Walker extends Behaviour {
  static override state = ['yaw', 'speed'];
  cx = 0; cz = 0; radius = 5;
  /** Titan speeds are in the titan graph's units; this maps a soldier-scale script speed to them. */
  speedScale = 1;
  yaw = 0;
  speed = 0;
  /** Seconds of script time; set `auto` false to drive `target` by hand. */
  auto = true;
  target = 0;
  private animator!: Animator;

  override ready(): void {
    this.animator = this.node.get(Animator)!;
  }

  override fixedUpdate(dt: number): void {
    const t = this.world.time;
    if (this.auto) this.target = script(t) * this.speedScale;
    // Speed follows the target with a little inertia, like a body would.
    this.speed += (this.target - this.speed) * Math.min(1, dt * 4);
    const v = this.speed;
    const sc = this.speedScale;
    this.yaw += (v / this.radius) * dt;
    const n = this.node;
    n.rotation.y = this.yaw;
    // Facing -Z at yaw 0; a circle counter-clockwise seen from above.
    n.position.x = this.cx + Math.cos(this.yaw) * this.radius - this.radius;
    n.position.z = this.cz - Math.sin(this.yaw) * this.radius;
    this.animator.set('speed', v);
    if (this.auto) {
      const c = t % 22;
      this.animator.set('grounded', !(c >= 16 && c < 16.8));
      if (Math.abs(c - 13) < dt / 2) this.animator.trigger('attack');
      if (Math.abs(c - 16) < dt / 2) this.animator.trigger('jump');
      void sc;
    }
  }
}

/** Soldier-scale ground speed over a 22 s loop: stand, walk, run, stop. */
function script(t: number): number {
  const c = t % 22;
  if (c < 2) return 0;
  if (c < 7) return 1.4;
  if (c < 12) return 5.3;
  return 0;
}

class Follow extends Behaviour {
  target: Animator | null = null;
  offset = { x: 0, y: 1.2, z: 5 };
  look = { x: 0, y: 1, z: 0 };
  override update(): void {
    const t = this.target;
    if (!t) return;
    const p = t.node.position;
    this.node.position.set(p.x + this.offset.x, p.y + this.offset.y, p.z + this.offset.z);
    this.node.object3d.lookAt(p.x + this.look.x, p.y + this.look.y, p.z + this.look.z);
    this.node.rotation.setFromQuaternion(this.node.object3d.quaternion);
  }
}

const params = new URLSearchParams(location.search);

const def = defineGame({
  ready(game: Game) {
    const w = game.world;
    const ground = w.spawn('ground');
    ground.add(Mesh, { shape: 'plane', color: '#5d6b52', castShadow: false });
    ground.scale.set(400, 1, 400);
    const sun = w.spawn('sun');
    sun.rotation.set(-0.85, 0.6, 0);
    sun.position.set(0, 40, 0);
    sun.add(Light, { type: 'sun', intensity: 2.6, castShadow: true, shadowSize: 45 });

    const soldier = w.spawn('soldier');
    soldier.position.set(-8, 0, 0);
    const sa = soldier.add(Animator, { character: 'character/soldier' });
    soldier.add(Walker, { cx: -8, cz: 0, radius: 3.5 });
    sa.ground = () => 0;

    const titan = w.spawn('titan');
    titan.position.set(14, 0, 0);
    const ta = titan.add(Animator, { character: 'character/titan' });
    titan.add(Walker, { cx: 14, cz: 0, radius: 7, speedScale: Math.sqrt(15 / 1.78) });
    ta.ground = () => 0;

    const cam = w.spawn('camera');
    cam.position.set(3, 9, 42);
    cam.add(Camera, { fov: 50, far: 600 });
    cam.add(Follow);
  },
});

const sources = exampleSources();
const loaded = config.load(sources);
for (const p of loaded.problems) console.error(`${p.file}${p.pointer ?? ''}: ${p.message}`);
const game = await startGame(def, { seed: 1 });
const el = document.getElementById('app')!;
const view = mountRender(game, el, { backend: 'webgl2' });
const w = game.world;
const find = (n: string) => w.find(n)!;
const soldierA = find('soldier').get(Animator)!;
const titanA = find('titan').get(Animator)!;
const camNode = find('camera');
const follow = camNode.get(Follow)!;

const cams: Record<string, () => void> = {
  both: () => { follow.target = null; camNode.position.set(3, 9, 42); camNode.rotation.set(0, 0, 0); },
  soldier: () => { follow.target = soldierA; follow.offset = { x: 2.6, y: 1.3, z: 4.2 }; follow.look = { x: 0, y: 0.9, z: 0 }; },
  soldierSide: () => { follow.target = soldierA; follow.offset = { x: 4.5, y: 1.0, z: 0 }; follow.look = { x: 0, y: 0.9, z: 0 }; },
  titan: () => { follow.target = titanA; follow.offset = { x: 22, y: 8, z: 26 }; follow.look = { x: 0, y: 6.5, z: 0 }; },
  titanSide: () => { follow.target = titanA; follow.offset = { x: 35, y: 7, z: 0 }; follow.look = { x: 0, y: 7, z: 0 }; },
};
cams[params.get('cam') ?? 'both']?.();

const hud = document.getElementById('hud')!;
game.onFrame(() => {
  const line = (n: string, a: Animator): string => {
    const wk = find(n).get(Walker)!;
    return `${n.padEnd(8)} base:${(a.stateOf('base') ?? '-').padEnd(5)} upper:${(a.stateOf('upper') ?? '-').padEnd(5)} speed ${wk.speed.toFixed(2).padStart(5)} m/s  slide ${a.footSlide.toFixed(2)} m/s`;
  };
  hud.textContent = `t ${w.time.toFixed(2)} s   ${view.backend}\n${line('soldier', soldierA)}\n${line('titan', titanA)}`;
});

if (params.get('paused') === '1') game.paused = true;

Object.assign(globalThis, {
  hull: {
    game, view, soldier: soldierA, titan: titanA, cams,
    /** Whole fixed steps, then a drawn frame. */
    step(n: number) { game.step(n); game.frame(0); },
    pause(p = true) { game.paused = p; },
    manual(on = true) { for (const n of ['soldier', 'titan']) find(n).get(Walker)!.auto = !on; },
    walker(n: string) { return find(n).get(Walker)!; },
    stats: () => view.stats(),
  },
});
