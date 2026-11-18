// A bench page for the look and the particles: a dusk scene with metal spheres, a hazy wall, and one station per
// example effect. Dev only: it is not part of any game and never ships. `window.demo` is the handle the browser
// checks drive (they step the game instead of waiting on real time).
import { Behaviour, config, defineGame, startGame, type Game } from '../../index.ts';
import { Camera, Mesh, mountRender, type RenderView } from '../../render/index.ts';
import { mountVfx, vfx, type TrailHandle } from '../index.ts';

const raw = import.meta.glob('../examples/config/**/*.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const files = Object.entries(raw).map(([p, text]) => ({ path: p.replace('../examples/', ''), text }));

// 20,000 slow soft particles that live a long time, for the frame-time check.
const stress = {
  kind: 'vfx',
  emit: { count: [20000, 20000], shape: { sphere: 6 } },
  particle: { life: [60, 60], speed: [0.1, 0.4], direction: { outward: true }, size: [[0, 0.1], [1, 0.1]], color: [[0, '#ffd9a0']], alpha: [[0, 0.12]], sprite: 'soft' },
  budget: { max: 20000 },
};
files.push({ path: 'config/vfx/stress.json', text: JSON.stringify(stress) });

class Orbit extends Behaviour {
  static override state = ['angle'];
  angle = 0;
  override fixedUpdate(dt: number): void {
    this.angle += dt * 0.9;
    this.node.position.set(Math.cos(this.angle) * 4, 1.4 + Math.sin(this.angle * 2) * 0.4, -9 + Math.sin(this.angle) * 2);
  }
}

const stations: [string, number][] = [['dust', -5], ['sparks', -2.5], ['blood', 0], ['steam', 2.5], ['smoke', 5]];

const def = defineGame({
  ready(game) {
    const w = game.world;
    const ground = w.spawn('ground');
    ground.scale.set(240, 0.2, 240);
    ground.position.set(0, -0.1, 0);
    ground.add(Mesh, { shape: 'box', material: 'material/ground' });
    // A walled city in the haze: a long wall and blocks of different heights behind it.
    const wall = w.spawn('wall');
    wall.scale.set(120, 7, 1.5);
    wall.position.set(0, 3.5, -34);
    wall.add(Mesh, { shape: 'box', material: 'material/wall' });
    for (let i = 0; i < 24; i++) {
      const b = w.spawn(`block${i}`);
      const h = 4 + ((i * 37) % 11);
      b.scale.set(3 + (i % 4), h, 3 + ((i * 3) % 4));
      b.position.set(-44 + i * 4, h / 2, -42 - ((i * 13) % 9) * 3);
      b.add(Mesh, { shape: 'box', material: 'material/wall' });
    }
    const mats = ['material/steel', 'material/gold', 'material/copper'];
    for (let i = 0; i < 3; i++) {
      const s = w.spawn(`sphere${i}`);
      s.scale.set(2.4, 2.4, 2.4);
      s.position.set(-3.4 + i * 3.4, 1.2, -4);
      s.add(Mesh, { shape: 'sphere', material: mats[i] });
    }
    const ship = w.spawn('ship');
    ship.scale.set(0.5, 0.3, 0.9);
    ship.add(Mesh, { shape: 'box', material: 'material/steel' });
    ship.add(Orbit);

    const eye = w.spawn('camera');
    eye.position.set(0, 2.2, 7.5);
    eye.rotation.x = -0.1;
    eye.add(Camera, { fov: 48, far: 400 });
  },
});

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const res = config.load(files);
  if (!res.ok) console.error(res.problems);
  const game: Game = await startGame(def, { seed: 7 });
  const view: RenderView = mountRender(game, document.getElementById('view')!, { look: q.get('look') ?? 'dusk', quality: (q.get('quality') as 'low' | 'medium' | 'high' | null) ?? 'high' });
  mountVfx(game);
  const ship = game.world.find('ship')!;
  let trail: TrailHandle | null = vfx.trail('gas-trail', ship);

  const fire = (id: string, x: number): void => {
    if (id === 'blood') vfx.burst('blood', { x, y: 1, z: 1.5 }, { x: 0.4, y: 1, z: 0.2 });
    else vfx.burst(id, { x, y: id === 'sparks' || id === 'steam' ? 0.6 : 0.05, z: 1.5 });
  };
  const fireAll = (): void => { for (const [id, x] of stations) fire(id, x); };
  if (q.get('auto') === '1') game.world.every(1.6, fireAll);

  const demo = {
    game,
    view,
    vfx,
    fireAll,
    fire,
    /** Pause, run n fixed steps, draw one frame. For screenshots that must not depend on real time. */
    snap(n: number): void {
      game.paused = true;
      game.step(n);
      game.frame(0);
    },
    play(): void { game.paused = false; },
    toggleTrail(): void {
      if (trail?.active) trail.stop(); else trail = vfx.trail('gas-trail', ship);
    },
    /** 20,000 live particles, then the frame time over `frames` frames of real drawing. */
    async bench(frames = 120): Promise<{ particles: number; cpuFrameMs: number; renderCpuMs: number; fps: number; drawCalls: number }> {
      game.paused = false;
      vfx.clear();
      vfx.burst('stress', { x: 0, y: 3, z: -6 });
      game.step(2);
      const live = vfx.stats().live;
      // Real frames, driven by requestAnimationFrame, so fps is what a player would get on this machine.
      const t0 = performance.now();
      let cpu = 0, render = 0, n = 0;
      await new Promise<void>((done) => {
        const tick = (): void => {
          n++;
          if (n >= frames) { done(); return; }
          // The whole frame on the CPU: particle step, buffer fill, scene and post draw calls.
          const a = performance.now();
          game.frame(0);
          cpu += performance.now() - a;
          render += view.stats().ms;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const secs = (performance.now() - t0) / 1000;
      const st = view.stats();
      vfx.clear();
      return { particles: live, cpuFrameMs: cpu / n, renderCpuMs: render / n, fps: frames / secs, drawCalls: st.drawCalls };
    },
  };
  (window as unknown as { demo: typeof demo }).demo = demo;

  // Query-string actions, so a check can be driven by the URL alone: ?fire=1&snap=40&bench=1&notrail=1
  const out = document.createElement('pre');
  out.id = 'out';
  out.style.cssText = 'position:fixed;left:8px;top:8px;margin:0;color:#fff;font:12px monospace;text-shadow:0 0 3px #000;white-space:pre-wrap';
  document.body.appendChild(out);
  const say = (t: string): void => { out.textContent = t; };
  if (q.get('notrail') === '1') trail?.stop();
  if (q.get('fire') === '1') fireAll();
  const snap = Number(q.get('snap') ?? 0);
  if (snap > 0) demo.snap(snap);
  if (q.get('bench') === '1') {
    // let the shaders compile and the page settle first
    await new Promise((r) => setTimeout(r, 1500));
    const r = await demo.bench(Number(q.get('frames') ?? 180));
    say(`BENCH ${JSON.stringify(r)} quality=${q.get('quality') ?? 'high'} backend=${view.backend}`);
  } else if (q.get('hud') === '1') {
    say(`${view.backend} ${JSON.stringify(vfx.stats())}`);
  }
}

void main();
