/// <reference types="node" />
// Maintainer script: the frame of a running game, measured in a browser over the DevTools protocol (plan-rust.md R0).
// perf-aott.ts times the step headless; this times what a player's machine pays for a frame, with the CPU as it is
// and throttled. It never ships.
//   1. pnpm project:dev examples/aott
//   2. open http://localhost:5173/?play=expedition&allies=2&scale=4 in a Chromium started with remote debugging
//   3. node --import tsx scripts/perf-frame.ts <browser websocket url> [seconds, default 95] [throttle rates, default 1,4]
// It pauses the game, restarts Holdout with the soldier at the spawn, steps `seconds` of game time (the point
// perf-aott.ts reports), and then for each
// throttle rate times 240 single steps, 120 paused frames (update and draw, no steps), and 5 s of the game running
// free: how many frames the browser presented and how late the late ones were. Last, the unthrottled steps and frames
// run again under the profiler, to say where each goes by subsystem. Prints one JSON line.
import { attribute, type CpuProfile } from './perf-where.ts';

const [url, secondsArg, ratesArg] = process.argv.slice(2);
if (!url) { console.error('usage: perf-frame.ts <browser websocket url> [seconds] [rates]'); process.exit(2); }
const seconds = Number(secondsArg ?? 95);
const rates = (ratesArg ?? '1,4').split(',').map(Number);

const ws = new WebSocket(url);
await new Promise<void>((ok, bad) => { ws.onopen = () => ok(); ws.onerror = () => bad(new Error('cannot reach ' + url)); });
let nextId = 1;
const waiting = new Map<number, { ok(v: unknown): void; bad(e: Error): void }>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } };
  const w = m.id === undefined ? undefined : waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id!);
  if (m.error) w.bad(new Error(m.error.message)); else w.ok(m.result);
};
function send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise<T>((ok, bad) => waiting.set(id, { ok: ok as (v: unknown) => void, bad }));
}

const { targetInfos } = await send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
const page = targetInfos.find((t) => t.type === 'page' && t.url.includes('scale=')) ?? targetInfos.find((t) => t.type === 'page');
if (!page) throw new Error('no page is open in that browser');
const { sessionId } = await send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true });

/** Runs an expression in the page and returns its value; a promise is awaited. */
async function evaluate<T>(expression: string): Promise<T> {
  const r = await send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
    'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

// The page's own handle on the game (examples/aott/src/host.ts sets window.game; its .hull is the Hull game).
const STATS = 'const st = (xs) => { const s = xs.slice().sort((a, b) => a - b); let sum = 0; for (const v of s) sum += v; const r = (v) => Math.round(v * 1000) / 1000; return { mean: r(sum / s.length), p50: r(s[s.length >> 1]), p95: r(s[Math.floor(s.length * 0.95)]), max: r(s[s.length - 1]) }; };';

// The run starts the way perf-aott.ts starts it: Holdout from the top, the soldier on the wall at the spawn. Left where
// the title card puts them, the soldier is killed within half a minute of a scaled wave and the field empties.
const start = await evaluate<number>('(() => { const g = game.hull; g.paused = true; game.flow.start("expedition"); game.player.reset(game.world.playerSpawn.position.clone(), 0); return g.world.tick; })()');
// Stepped in slices of about 2 s so no single protocol call runs long enough to time out.
const target = start + Math.round(seconds * 120);
for (;;) {
  const tick = await evaluate<number>(`(() => { const g = game.hull, t = performance.now(); while (g.world.tick < ${target} && performance.now() - t < 2000) g.step(1); return g.world.tick; })()`);
  if (tick >= target) break;
}

const out: Record<string, unknown> = { url: page.url, seconds };
out.load = await evaluate(`(() => ({ playerAlive: game.player.alive, wave: game.flow.wave, titans: game.titans?.alive.length ?? 0, comrades: game.allies.length, civilians: game.civilians?.list.length ?? 0, width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio }))()`);
const runs: Record<string, unknown>[] = [];
for (const rate of rates) {
  await send('Emulation.setCPUThrottlingRate', { rate }, sessionId);
  const timed = await evaluate<Record<string, unknown>>(`(() => { ${STATS}
    const g = game.hull; g.paused = true;
    const steps = [], frames = [];
    for (let i = 0; i < 240; i++) { const t = performance.now(); g.step(1); steps.push(performance.now() - t); }
    for (let i = 0; i < 120; i++) { const t = performance.now(); g.frame(0); frames.push(performance.now() - t); }
    const s = globalThis.hull?.render?.stats?.();
    return { stepMs: st(steps), drawMs: st(frames), drawCalls: s?.drawCalls ?? 0, triangles: s?.triangles ?? 0 };
  })()`);
  // Free running: the browser's own frame clock says whether the frame is held. An interval is the time between two
  // presented frames; at 60 Hz a held frame is 16.7 ms and a missed one is 33.3.
  const free = await evaluate<Record<string, unknown>>(`new Promise((done) => { ${STATS}
    const g = game.hull; g.paused = false;
    const gaps = []; let last = 0; const t0 = performance.now();
    const tick = (now) => {
      if (last) gaps.push(now - last);
      last = now;
      if (now - t0 < 5000) requestAnimationFrame(tick);
      else { g.paused = true; const late = gaps.filter((x) => x > 20).length; done({ frames: gaps.length, fps: Math.round(gaps.length / ((now - t0) / 1000) * 10) / 10, gapMs: st(gaps), lateShare: Math.round(late / gaps.length * 1000) / 1000 }); }
    };
    requestAnimationFrame(tick);
  })`);
  runs.push({ throttle: rate, ...timed, free });
}
await send('Emulation.setCPUThrottlingRate', { rate: 1 }, sessionId);
// Where the unthrottled step and draw go: the same 240 steps and 120 paused frames again, each under the profiler,
// turned into ms with the unprofiled means above.
async function profiled(body: string): Promise<CpuProfile> {
  await send('Profiler.enable', {}, sessionId);
  await send('Profiler.setSamplingInterval', { interval: 100 }, sessionId);
  await send('Profiler.start', {}, sessionId);
  await evaluate(`(() => { const g = game.hull; g.paused = true; ${body} return 0; })()`);
  return (await send<{ profile: CpuProfile }>('Profiler.stop', {}, sessionId)).profile;
}
const first = runs[0] as { stepMs: { mean: number }; drawMs: { mean: number } } | undefined;
if (first) {
  out.step = attribute(await profiled('for (let i = 0; i < 240; i++) g.step(1);'), first.stepMs.mean, true);
  out.draw = attribute(await profiled('for (let i = 0; i < 120; i++) g.frame(0);'), first.drawMs.mean, true);
}
out.runs = runs;
console.log(JSON.stringify(out));
ws.close();
