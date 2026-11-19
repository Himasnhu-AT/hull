// The play tool's engine: runs a step script against a game in a headless browser. Time moves only by `step`, so the
// same script on the same project gives the same frames.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Problem } from 'hull';
import type { ControlOp, ControlShot, ControlState, NodeState } from 'hull/dev/protocol';
import { connectProject, type ProjectClient } from '../control/client.ts';
import { checkGolden, type Tolerance } from './golden.ts';

const exec = promisify(execFile);

export type PlayStep =
  | { step: number }
  | { press: string }
  | { release: string }
  | { hold: string; steps: number }
  | { read: string[] }
  | { check: { node: string; axis: 'x' | 'y' | 'z'; min?: number; max?: number } }
  | { screenshot: string; channel?: number; pixels?: number };

export interface PlayScript {
  viewport?: { width: number; height: number };
  /** Default tolerance for every screenshot in the script. */
  tolerance?: Partial<Tolerance>;
  steps: PlayStep[];
}

export interface StepReport {
  index: number;
  step: PlayStep;
  ok: boolean;
  /** Game tick after the step. */
  tick: number;
  detail?: string;
  state?: Record<string, NodeState>;
  golden?: { name: string; status: string; path: string; diffPixels?: number; maxDelta?: number; actual?: string; diff?: string };
}

export interface PlayReport { ok: boolean; problems: Problem[]; steps: StepReport[]; tick: number; checksum: string }

const KEYS = /^[A-Za-z0-9]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Problems with the script itself, named by pointer, before any browser starts. */
export function validateScript(file: string, s: unknown): Problem[] {
  const out: Problem[] = [];
  const bad = (pointer: string, message: string): void => { out.push({ file, pointer, rule: 'play', message }); };
  if (!isObj(s) || !Array.isArray(s['steps'])) return [{ file, pointer: '', rule: 'play', message: 'a play script is an object with a "steps" array' }];
  s['steps'].forEach((st: unknown, i) => {
    const at = `/steps/${i}`;
    if (!isObj(st)) return bad(at, 'a step is an object like {"step": 60} or {"press": "KeyW"}');
    const n = (k: string): boolean => typeof st[k] === 'number' && Number.isFinite(st[k]) && (st[k] as number) >= 0;
    const key = (k: string): boolean => typeof st[k] === 'string' && KEYS.test(st[k] as string);
    if ('step' in st) { if (!n('step')) bad(`${at}/step`, 'step needs a count of zero or more'); }
    else if ('press' in st) { if (!key('press')) bad(`${at}/press`, "press needs a key code like 'KeyW' or 'Space'"); }
    else if ('release' in st) { if (!key('release')) bad(`${at}/release`, "release needs a key code like 'KeyW'"); }
    else if ('hold' in st) { if (!key('hold')) bad(`${at}/hold`, "hold needs a key code like 'KeyW'"); if (!n('steps')) bad(`${at}/steps`, 'hold needs "steps": how many fixed steps to hold for'); }
    else if ('read' in st) { if (!Array.isArray(st['read']) || !st['read'].every((x) => typeof x === 'string')) bad(`${at}/read`, 'read needs a list of node names'); }
    else if ('check' in st) {
      const c = st['check'];
      if (!isObj(c) || typeof c['node'] !== 'string' || !['x', 'y', 'z'].includes(c['axis'] as string) || (c['min'] === undefined && c['max'] === undefined)) bad(`${at}/check`, 'check needs {"node", "axis": "x"|"y"|"z", "min" and/or "max"}');
    } else if ('screenshot' in st) { if (typeof st['screenshot'] !== 'string' || !st['screenshot']) bad(`${at}/screenshot`, 'screenshot needs the golden image name'); }
    else bad(at, `unknown step; use one of step, press, release, hold, read, check, screenshot (got keys: ${Object.keys(st).join(', ') || 'none'})`);
  });
  return out;
}

export interface RunOptions {
  root: string;
  file: string;
  script: PlayScript;
  server: { url: string; gameUrl: string };
  /** Rewrite goldens instead of comparing. */
  update: boolean;
  /** The agent-browser executable. */
  browser: string;
  signal: AbortSignal;
}

let sessions = 0;

export async function runScript(o: RunOptions): Promise<PlayReport> {
  const id = `play${process.pid}x${++sessions}`;
  const session = `hull-${id}`;
  const vp = o.script.viewport ?? { width: 640, height: 360 };
  const tol: Tolerance = { channel: o.script.tolerance?.channel ?? 8, pixels: o.script.tolerance?.pixels ?? 0 };
  const ab = (...args: string[]): Promise<unknown> => exec(o.browser, ['--session', session, ...args], { timeout: 60_000, signal: o.signal });
  const steps: StepReport[] = [];
  const problems: Problem[] = [];
  let client: ProjectClient | undefined;
  let last: ControlState = { tick: 0, time: 0, checksum: '', paused: true, nodes: {}, held: [] };
  try {
    client = await connectProject(o.server.url);
    // Viewport first, then the page: the canvas sizes itself once, at its final size.
    await ab('set', 'viewport', String(vp.width), String(vp.height));
    await ab('open', `${o.server.gameUrl}?hull-paused&hull-client=${id}`);
    // The game connects once its modules have loaded; wait for it by asking for its state.
    const start = Date.now();
    for (;;) {
      try { last = (await client.call('game.run', { control: { op: 'state' }, client: id })) as ControlState; break; } catch (e) {
        if (Date.now() - start > 60_000) throw new Error(`the game did not connect within 60 s (${(e as Error).message})`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const run = async <T>(control: ControlOp): Promise<T> =>
      (await client!.call('game.run', { control, client: id })) as T;

    for (let i = 0; i < o.script.steps.length; i++) {
      const step = o.script.steps[i]!;
      const rep: StepReport = { index: i, step, ok: true, tick: last.tick };
      const fail = (message: string, pointer = `/steps/${i}`): void => { rep.ok = false; rep.detail = message; problems.push({ file: o.file, pointer, rule: 'play', message: `step ${i} (${JSON.stringify(step)}): ${message}` }); };
      try {
        if ('step' in step) last = await run<ControlState>({ op: 'step', n: step.step });
        else if ('press' in step) await run({ op: 'press', key: step.press });
        else if ('release' in step) await run({ op: 'release', key: step.release });
        else if ('hold' in step) {
          await run({ op: 'press', key: step.hold });
          last = await run<ControlState>({ op: 'step', n: step.steps });
          await run({ op: 'release', key: step.hold });
        } else if ('read' in step) {
          last = await run<ControlState>({ op: 'state', nodes: step.read });
          rep.state = last.nodes;
        } else if ('check' in step) {
          const c = step.check;
          last = await run<ControlState>({ op: 'state', nodes: [c.node] });
          const n = last.nodes[c.node];
          rep.state = last.nodes;
          if (!n?.found) fail(`there is no node "${c.node}"`);
          else {
            const v = n[c.axis];
            if (c.min !== undefined && v < c.min) fail(`${c.node}.${c.axis} is ${v.toFixed(3)}, below the minimum ${c.min} at tick ${last.tick}`);
            else if (c.max !== undefined && v > c.max) fail(`${c.node}.${c.axis} is ${v.toFixed(3)}, above the maximum ${c.max} at tick ${last.tick}`);
            else rep.detail = `${c.node}.${c.axis} = ${v.toFixed(3)}`;
          }
        } else {
          const shot = await run<ControlShot>({ op: 'screenshot' });
          const png = Buffer.from(shot.png, 'base64');
          const t: Tolerance = { channel: step.channel ?? tol.channel, pixels: step.pixels ?? tol.pixels };
          const g = checkGolden(o.root, step.screenshot, png, t, o.update);
          rep.golden = { name: step.screenshot, status: g.status, path: g.path };
          if (g.status === 'differs') {
            const c = g.comparison;
            rep.golden.diffPixels = c.diffPixels; rep.golden.maxDelta = c.maxDelta; rep.golden.actual = g.actualPath;
            if (g.diffPath) rep.golden.diff = g.diffPath;
            const what = c.sizeMismatch
              ? `the picture is ${c.sizeMismatch.actual.join('x')} but the golden is ${c.sizeMismatch.golden.join('x')}`
              : `${c.diffPixels} of ${c.width * c.height} pixels differ (${((100 * c.diffPixels) / (c.width * c.height)).toFixed(2)}%), largest channel difference ${c.maxDelta}`;
            fail(`golden "${step.screenshot}" at tick ${last.tick}: ${what} (tolerance: ${t.channel} per channel, ${t.pixels} pixels). Actual: ${g.actualPath}${g.diffPath ? `, diff: ${g.diffPath}` : ''}; golden: ${g.path}`, `/steps/${i}/screenshot`);
          } else if (g.status === 'match') { rep.detail = `matches ${g.path} (largest channel difference ${g.comparison.maxDelta})`; rep.golden.maxDelta = g.comparison.maxDelta; rep.golden.diffPixels = g.comparison.diffPixels; }
          else rep.detail = `${g.status === 'new' ? 'saved new' : 'updated'} golden ${g.path}`;
        }
      } catch (e) { fail((e as Error).message); }
      rep.tick = last.tick;
      steps.push(rep);
      // A failed step stops the script: the steps after it would run from a state the author did not plan for.
      if (!rep.ok) break;
    }
  } catch (e) {
    problems.push({ file: o.file, rule: 'play', message: (e as Error).message });
  } finally {
    client?.close();
    await ab('close').catch(() => {});
  }
  return { ok: problems.length === 0, problems, steps, tick: last.tick, checksum: last.checksum };
}
