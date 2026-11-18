/// <reference types="vite/client" />
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

// 200,000 soft particles alive at once: the WebGPU compute budget (a CPU pool this size would not hold 60 fps).
const stress200k = {
  kind: 'vfx',
  emit: { count: [200000, 200000], shape: { sphere: 7 } },
  particle: { life: [600, 600], speed: [0.1, 0.5], direction: { outward: true }, size: [[0, 0.06], [1, 0.06]], color: [[0, '#ffd9a0'], [1, '#a0c4ff']], alpha: [[0, 0.1]], sprite: 'soft', blend: 'additive' },
  budget: { max: 200000 },
};
files.push({ path: 'config/vfx/stress200k.json', text: JSON.stringify(stress200k) });

// The sparks effect with a budget big enough that WebGPU simulates it with compute; the CPU path on WebGL2.
// It stands beside the others so one picture can show both simulations.
const gpuSparks = {
  kind: 'vfx',
  emit: { count: [1800, 1800], shape: 'point' },
  particle: {
    life: [0.4, 1.1], speed: [3, 10], direction: { cone: [0, 1, 0], angleDeg: 55 }, gravity: -14, drag: 0.8,
    size: [[0, 0.08], [1, 0.02]], color: [[0, '#fff2c2'], [0.4, '#ffae42'], [1, '#d8441a']], alpha: [[0, 1], [0.7, 1], [1, 0]],
    glow: 4, stretch: 0.05, sprite: 'spark', blend: 'additive',
  },
  budget: { max: 4096 },
};
files.push({ path: 'config/vfx/gpu-sparks.json', text: JSON.stringify(gpuSparks) });

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
  // `?hullBackend=webgl2|webgpu` forces a backend; without it the engine picks one for this machine.
  const view: RenderView = mountRender(game, document.getElementById('view')!, { look: q.get('look') ?? 'dusk', quality: (q.get('quality') as 'low' | 'medium' | 'high' | null) ?? 'high' });
  // WebGPU needs an adapter and a device first; everything below waits for the backend to be chosen.
  await view.ready;
  const vv = mountVfx(game);
  const ship = game.world.find('ship')!;
  let trail: TrailHandle | null = vfx.trail('gas-trail', ship);

  const fire = (id: string, x: number): void => {
    if (id === 'blood') vfx.burst('blood', { x, y: 1, z: 1.5 }, { x: 0.4, y: 1, z: 0.2 });
    else vfx.burst(id, { x, y: id === 'sparks' || id === 'steam' ? 0.6 : 0.05, z: 1.5 });
  };
  const fireAll = (): void => { for (const [id, x] of stations) fire(id, x); if (q.get('gpu') === '1') vfx.burst('gpu-sparks', { x: -1.2, y: 0.6, z: 3 }); };
  if (q.get('auto') === '1') game.world.every(1.6, fireAll);

  /** The frame time of `frames` real frames with whatever is alive, from requestAnimationFrame and the GPU's own timer. */
  async function measure(frames: number): Promise<{ backend: string; fps: number; frameMsMean: number; frameMsP95: number; frameMsMax: number; renderCpuMs: number; gpuMs: number | null; drawCalls: number }> {
    game.paused = false;
    const dts: number[] = [];
    let cpu = 0;
    let gpu = 0;
    let gpuN = 0;
    await new Promise<void>((done) => {
      let last = -1;
      let n = 0;
      const tick = (now: number): void => {
        if (last >= 0) dts.push(now - last);
        last = now;
        cpu += view.stats().ms;
        const g = view.stats().gpuMs;
        if (g !== undefined && g > 0) { gpu += g; gpuN++; }
        if (++n > frames) { done(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    dts.sort((a, b) => a - b);
    const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
    return {
      backend: view.backend, fps: 1000 / mean, frameMsMean: mean, frameMsP95: dts[Math.floor(dts.length * 0.95)]!, frameMsMax: dts[dts.length - 1]!,
      renderCpuMs: cpu / dts.length, gpuMs: gpuN > 0 ? gpu / gpuN : null, drawCalls: view.stats().drawCalls,
    };
  }

  /**
   * Frame time with no display refresh in the way: each frame is drawn and then waited for until the GPU has finished
   * it, so the number is what the machine can really do (rAF is capped at the display rate, which hides headroom).
   */
  async function measureBound(frames: number): Promise<{ backend: string; frames: number; meanMs: number; p95Ms: number; maxMs: number; fpsPossible: number }> {
    const rt = (await import('../../render/runtime.ts')).renderRuntime();
    const device = (rt?.renderer as { backend?: { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } } } | undefined)?.backend?.device;
    const gl = (rt?.renderer as { getContext?: () => WebGL2RenderingContext } | undefined)?.getContext?.();
    game.paused = false;
    const ms: number[] = [];
    for (let i = 0; i < frames + 10; i++) {
      const t0 = performance.now();
      game.frame(1 / 60);
      if (device) await device.queue.onSubmittedWorkDone();
      else if (gl) gl.finish();
      if (i >= 10) ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
    return { backend: view.backend, frames, meanMs: mean, p95Ms: ms[Math.floor(ms.length * 0.95)]!, maxMs: ms[ms.length - 1]!, fpsPossible: 1000 / mean };
  }

  const demo = {
    game,
    view,
    measure,
    measureBound,
    /** 200,000 live particles (the effect has a 200,000 budget, so WebGPU simulates it with compute), then `measure`. */
    async bench200k(frames = 240): Promise<Awaited<ReturnType<typeof measure>> & { bound: Awaited<ReturnType<typeof measureBound>>; particles: number; onGpu: boolean }> {
      vfx.clear();
      vfx.burst('stress200k', { x: 0, y: 3, z: -6 });
      game.step(2);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const st = vfx.stats();
      const r = await measure(frames);
      const bound = await measureBound(120);
      return { ...r, bound, particles: st.live, onGpu: st.effects['vfx/stress200k']?.gpu === true };
    },
    /** Reads back the first particles of a GPU effect, to check the kernels did what they should. */
    async gpuRead(id: string, n = 8): Promise<unknown> {
      const sys = vv.system as unknown as { effects?: Map<string, { gpu: { debugRead(r: unknown, n: number): Promise<unknown> } | null }> };
      const fx = sys?.effects?.get(id.startsWith('vfx/') ? id : `vfx/${id}`);
      const rt = (await import('../../render/runtime.ts')).renderRuntime();
      return fx?.gpu && rt ? fx.gpu.debugRead(rt.renderer, n) : null;
    },
    /** The picture as a PNG data URL: the backend's own `shot`, so it is exactly the canvas that was drawn. */
    async capture(): Promise<string> {
      const blob = await view.shot();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `data:image/png;base64,${btoa(s)}`;
    },
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
  (window as unknown as { demoReady: boolean }).demoReady = true;
  if (q.get('bench') === '1') {
    // let the shaders compile and the page settle first
    await new Promise((r) => setTimeout(r, 1500));
    const r = await demo.bench(Number(q.get('frames') ?? 180));
    say(`BENCH ${JSON.stringify(r)} quality=${q.get('quality') ?? 'high'} backend=${view.backend}`);
  } else if (q.get('hud') === '1') {
    say(`${view.backend} ${JSON.stringify(vfx.stats())}`);
  }
  if (q.get('bench200k') === '1') {
    await new Promise((r) => setTimeout(r, 800));
    const r = await demo.bench200k(Number(q.get('frames') ?? 240));
    (window as unknown as { benchResult: unknown }).benchResult = r;
    say(`BENCH200K ${JSON.stringify(r)}`);
  }
}

void main();
