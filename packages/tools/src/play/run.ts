// The play tool's engine: runs a step script against a game in a headless browser. Time moves only by `step`, so the
// same script on the same project gives the same frames.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Problem } from 'hull';
import type { ControlCmp, ControlCond, ControlErrors, ControlInspect, ControlOp, ControlShot, ControlState, ControlUntil, NodeState } from 'hull/dev/protocol';
import { connectProject, type ProjectClient } from '../control/client.ts';
import { checkGolden, type Tolerance } from './golden.ts';
import { closeOnExit, reapDeadSessions } from './session.ts';

const exec = promisify(execFile);

export type PlayStep =
  | { step: number }
  | { press: string }
  | { release: string }
  | { hold: string; steps: number }
  | { read: string[] }
  | { check: { node: string; axis: 'x' | 'y' | 'z'; min?: number; max?: number } }
  | { screenshot: string; channel?: number; pixels?: number }
  /** Step one tick at a time until the condition holds; fails when it does not within `max` ticks. */
  | { until: ControlCond; max: number }
  /** Fails unless the node's field (x, y, z or "Behaviour.field") or the probe compares true. */
  | { expect: ExpectCond }
  /** Mouse movement, as under pointer lock. */
  | { look: [number, number] }
  /** Reads one node in full (transform, groups, behaviour state) into the report. */
  | { inspect: string };

export type ExpectCond =
  | { node: string; field: string; cmp: ControlCmp; value: number | string | boolean }
  | { probe: string; cmp: ControlCmp; value: number | string | boolean };

export interface PlayScript {
  viewport?: { width: number; height: number };
  /** Default tolerance for every screenshot in the script. */
  tolerance?: Partial<Tolerance>;
  /** Errors the game logs during the script fail it, unless this is true. */
  allowErrors?: boolean;
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
  inspect?: ControlInspect;
  golden?: { name: string; status: string; path: string; diffPixels?: number; maxDelta?: number; actual?: string; diff?: string };
}

export interface PlayReport {
  ok: boolean; problems: Problem[]; steps: StepReport[]; tick: number; checksum: string;
  /** Warnings the game logged during the script (they do not fail it). */
  warnings?: string[];
}

const KEYS = /^[A-Za-z0-9]+$/;
const CMPS = ['<', '<=', '>', '>=', '==', '!='];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Problems with the script itself, named by pointer, before any browser starts. */
export function validateScript(file: string, s: unknown): Problem[] {
  const out: Problem[] = [];
  const bad = (pointer: string, message: string): void => { out.push({ file, pointer, rule: 'play', message }); };
  if (!isObj(s) || !Array.isArray(s['steps'])) return [{ file, pointer: '', rule: 'play', message: 'a play script is an object with a "steps" array' }];
  if (s['allowErrors'] !== undefined && typeof s['allowErrors'] !== 'boolean') bad('/allowErrors', 'allowErrors is true or false');
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
    else if ('until' in st) {
      const c = st['until'];
      if (!isObj(c) || !(typeof c['event'] === 'string' || typeof c['probe'] === 'string' || (typeof c['node'] === 'string' && typeof c['field'] === 'string')) || (!('event' in c) && (!CMPS.includes(c['cmp'] as string) || c['value'] === undefined))) bad(`${at}/until`, 'until needs {"node","field","cmp","value"} | {"probe","cmp","value"} | {"event"}, and "cmp" is one of < <= > >= == !=');
      if (!n('max')) bad(`${at}/max`, 'until needs "max": the most ticks to wait');
    } else if ('expect' in st) {
      const c = st['expect'];
      if (!isObj(c) || !(typeof c['probe'] === 'string' || (typeof c['node'] === 'string' && typeof c['field'] === 'string')) || !CMPS.includes(c['cmp'] as string) || c['value'] === undefined) bad(`${at}/expect`, 'expect needs {"node","field","cmp","value"} | {"probe","cmp","value"}, and "cmp" is one of < <= > >= == !=');
    } else if ('look' in st) {
      const l = st['look'];
      if (!Array.isArray(l) || l.length !== 2 || !l.every((x) => typeof x === 'number' && Number.isFinite(x))) bad(`${at}/look`, 'look needs [dx, dy]: mouse movement in pixels');
    } else if ('inspect' in st) { if (typeof st['inspect'] !== 'string' || !st['inspect']) bad(`${at}/inspect`, 'inspect needs a node name'); }
    else bad(at, `unknown step; use one of step, press, release, hold, read, check, screenshot, until, expect, look, inspect (got keys: ${Object.keys(st).join(', ') || 'none'})`);
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

const compares = (a: unknown, cmp: ControlCmp, b: unknown): boolean => {
  if (cmp === '==') return a === b;
  if (cmp === '!=') return a !== b;
  if (typeof a !== typeof b || (typeof a !== 'number' && typeof a !== 'string')) return false;
  const x = a as number, y = b as number;
  return cmp === '<' ? x < y : cmp === '<=' ? x <= y : cmp === '>' ? x > y : x >= y;
};

/** "src/player.ts:40:5: " for an error the server could place, else nothing. */
const placeOf = (e: { file?: string; line?: number; col?: number }): string => (e.file ? `${e.file}:${e.line ?? 0}:${e.col ?? 0}: ` : '');

export async function runScript(o: RunOptions): Promise<PlayReport> {
  const id = `play${process.pid}x${++sessions}`;
  const session = `hull-${id}`;
  const vp = o.script.viewport ?? { width: 640, height: 360 };
  const tol: Tolerance = { channel: o.script.tolerance?.channel ?? 8, pixels: o.script.tolerance?.pixels ?? 0 };
  const ab = (...args: string[]): Promise<unknown> => exec(o.browser, ['--session', session, ...args], { timeout: 60_000, signal: o.signal });
  const steps: StepReport[] = [];
  const problems: Problem[] = [];
  let client: ProjectClient | undefined;
  let last: ControlState = { tick: 0, time: 0, checksum: '', paused: true, nodes: {}, held: [], probes: {}, errors: 0 };
  const warnings: string[] = [];
  let guard: ReturnType<typeof closeOnExit> | undefined;
  try {
    client = await connectProject(o.server.url);
    // The session exists from the first browser command: guard it from here, and clear what a dead process left behind.
    await reapDeadSessions(o.browser);
    guard = closeOnExit(o.browser, session);
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
        } else if ('until' in step) {
          const u = await run<ControlUntil>({ op: 'until', when: step.until, max: step.max });
          last = u;
          if (!u.met) fail(`${JSON.stringify(step.until)} did not hold within ${step.max} ticks (stopped at tick ${u.tick})`);
          else rep.detail = `held after ${u.steps} ticks`;
        } else if ('expect' in step) {
          const c = step.expect;
          let got: unknown;
          if ('probe' in c) {
            last = await run<ControlState>({ op: 'state' });
            got = last.probes[c.probe];
            if (got === undefined) fail(`there is no probe "${c.probe}" (probes: ${Object.keys(last.probes).join(', ') || 'none'})`);
          } else {
            const ins = await run<ControlInspect>({ op: 'inspect', node: c.node });
            last = await run<ControlState>({ op: 'state' });
            if (!ins.found) fail(`there is no node "${c.node}"`);
            else if (c.field === 'x' || c.field === 'y' || c.field === 'z') got = ins.position![c.field === 'x' ? 0 : c.field === 'y' ? 1 : 2];
            else {
              const [bname, ...rest] = c.field.split('.');
              const b = ins.behaviours!.find((x) => x.name === bname);
              got = b?.state[rest.join('.')];
              if (got === undefined) fail(`"${c.node}" has no field "${c.field}" (behaviours: ${ins.behaviours!.map((x) => x.name).join(', ') || 'none'}; use inspect to see their fields)`);
            }
          }
          if (rep.ok) {
            const name = 'probe' in c ? `probe ${c.probe}` : `${c.node}.${c.field}`;
            if (!compares(got, c.cmp, c.value)) fail(`expected ${name} ${c.cmp} ${JSON.stringify(c.value)}, but it is ${JSON.stringify(got)} at tick ${last.tick}`);
            else rep.detail = `${name} = ${JSON.stringify(got)}`;
          }
        } else if ('look' in step) {
          await run({ op: 'look', dx: step.look[0], dy: step.look[1] });
        } else if ('inspect' in step) {
          rep.inspect = await run<ControlInspect>({ op: 'inspect', node: step.inspect });
          if (!rep.inspect.found) fail(`there is no node "${step.inspect}"`);
          else rep.detail = JSON.stringify({ position: rep.inspect.position, behaviours: rep.inspect.behaviours });
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
      // An error the game logged while the step ran fails the script, naming where it came from (a throw inside the step
      // already failed it above, and the script stops there, so it is not reported twice).
      if (rep.ok) {
        try {
          const logged = ((await run<ControlErrors>({ op: 'errors', clear: true })).items);
          for (const w of logged.filter((x) => x.level === 'warn')) warnings.push(`${placeOf(w)}${w.message}${w.count > 1 ? ` (x${w.count})` : ''}`);
          const errs = logged.filter((x) => x.level === 'error');
          if (errs.length && !o.script.allowErrors) fail(`the game logged ${errs.length === 1 ? 'an error' : `${errs.length} errors`}: ${errs.map((x) => `${placeOf(x)}${x.message}${x.count > 1 ? ` (x${x.count})` : ''}`).join('; ')}. Set "allowErrors": true on the script if this is expected.`);
        } catch (e) { fail(`could not read the game's errors: ${(e as Error).message}`); }
      }
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
    guard?.close();
  }
  return { ok: problems.length === 0, problems, steps, tick: last.tick, checksum: last.checksum, ...(warnings.length ? { warnings } : {}) };
}
