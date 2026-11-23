import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from './server/index.ts';

// C1, the control port, driven the way an agent drives it: a fresh arena project through the MCP stdio server, a headless
// page the server opens itself. Each fault from the brief is reproduced here first and then held fixed.
const bin = join(import.meta.dirname, '..', 'bin', 'hull-mcp.js');
const hasBrowser = spawnSync('agent-browser', ['--version']).status === 0;

class Mcp {
  private n = 0;
  private waiting = new Map<number, (m: any) => void>();
  readonly proc;
  constructor(dir: string, readonly name = 'sight') {
    this.proc = spawn(process.execPath, [bin, dir], { stdio: ['pipe', 'pipe', 'ignore'] });
    createInterface({ input: this.proc.stdout }).on('line', (l) => { const m = JSON.parse(l); this.waiting.get(m.id)?.(m); });
  }
  rpc(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.n;
    return new Promise((res) => { this.waiting.set(id, res); this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  }
  async init(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.name, version: '1' } });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }
  async tool(name: string, args: unknown = {}): Promise<any> { return (await this.rpc('tools/call', { name, arguments: args })).result; }
  /** game.run: the structured answer, or the failure text. */
  async run(control: unknown): Promise<any> {
    const r = await this.tool('game.run', { control });
    if (r.isError) return { failed: true, text: r.content.map((c: any) => c.text ?? '').join('\n') };
    return r.structuredContent;
  }
  exited(): Promise<void> { return new Promise((done) => { if (this.proc.exitCode !== null) done(); else this.proc.on('exit', () => done()); }); }
  close(): Promise<void> { const e = this.exited(); this.proc.stdin.end(); return e; }
}

const sessions = (): string => spawnSync('agent-browser', ['session', 'list'], { encoding: 'utf8' }).stdout;
const gone = async (name: string, ms = 15_000): Promise<boolean> => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 300))) if (!sessions().includes(name)) return true;
  return false;
};

const lineOf = (text: string, needle: string): number => text.slice(0, text.indexOf(needle)).split('\n').length;

describe.skipIf(!hasBrowser)('the control port (C1) on a fresh arena project', () => {
  let dir: string;
  let mcp: Mcp;
  beforeAll(async () => {
    dir = join(mkdtempSync(join(tmpdir(), 'hull-sight-')), 'game');
    await createProject({ template: 'arena', dir, title: 'Sight arena' });
    mcp = new Mcp(dir);
    await mcp.init();
    // A probe the way a game registers one: in ready.
    const main = await mcp.tool('code.edit', { path: 'src/main.ts', old: "import { defineGame } from 'hull';", new: "import { defineGame, probe } from 'hull';" });
    expect(main.structuredContent.written).toBe(true);
    const probeAdded = await mcp.tool('code.edit', { path: 'src/main.ts', old: "    const eye = w.spawn('camera');", new: "    probe('gemsLeft', () => w.group('gem').length);\n    probe('mood', () => 'calm');\n    const eye = w.spawn('camera');" });
    expect(probeAdded.structuredContent.written).toBe(true);
  }, 120_000);
  afterAll(async () => { await mcp.close(); rmSync(join(dir, '..'), { recursive: true, force: true }); });

  it('state carries probes and the unread error count; inspect and tree read the world', async () => {
    const s = await mcp.run({ op: 'state', nodes: ['player'] });
    expect(s.probes).toMatchObject({ mood: 'calm' });
    expect(typeof s.probes.gemsLeft).toBe('number');
    expect(s.errors).toBe(0);
    const ins = await mcp.run({ op: 'inspect', node: 'player' });
    expect(ins).toMatchObject({ found: true, path: 'player', scale: [1, 1, 1] });
    expect(ins.behaviours.map((b: any) => b.name)).toContain('Player');
    expect(ins.behaviours.find((b: any) => b.name === 'Player').state).toHaveProperty('vy');
    expect((await mcp.run({ op: 'inspect', node: 'nobody' })).found).toBe(false);
    const tree = await mcp.run({ op: 'tree', depth: 2 });
    expect(tree.lines).toEqual(expect.arrayContaining([expect.stringMatching(/^player  \[Player/), expect.stringMatching(/^level/)]));
    expect(tree.more).toBe(0);
  }, 180_000);

  it('until runs to a condition, and game.recent shows the footsteps of a run (the empty-feed fault)', async () => {
    await mcp.run({ op: 'restart' });
    await mcp.run({ op: 'press', key: 'KeyW' });
    const u = await mcp.run({ op: 'until', when: { node: 'player', field: 'z', cmp: '<', value: -3 }, max: 300 });
    expect(u).toMatchObject({ met: true });
    expect(u.steps).toBeGreaterThan(10);
    expect(u.steps).toBeLessThan(300);
    const never = await mcp.run({ op: 'until', when: { probe: 'gemsLeft', cmp: '>', value: 1000 }, max: 5 });
    expect(never).toMatchObject({ met: false, steps: 5 });
    await mcp.run({ op: 'step', n: 120 });
    const recent = (await mcp.tool('game.recent', { seconds: 10 })).structuredContent.items as { id: string }[];
    expect(recent.filter((e) => e.id === 'sound/footstep').length).toBeGreaterThan(2);
    const ev = await mcp.run({ op: 'until', when: { event: 'sound/footstep' }, max: 200 });
    expect(ev.met).toBe(true);
    await mcp.run({ op: 'release', key: 'KeyW' });
  }, 180_000);

  it('restart starts again from ready, paused at tick 0 with the same checksum', async () => {
    const first = await mcp.run({ op: 'restart' });
    expect(first).toMatchObject({ tick: 0, paused: true });
    await mcp.run({ op: 'step', n: 30 });
    const again = await mcp.run({ op: 'restart' });
    expect(again).toMatchObject({ tick: 0, paused: true, checksum: first.checksum });
  }, 180_000);

  it('perf, look and frames answer', async () => {
    const p = await mcp.run({ op: 'perf', steps: 30 });
    expect(p.stepMs.avg).toBeGreaterThan(0);
    expect(p.stepMs.max).toBeGreaterThanOrEqual(p.stepMs.p95);
    expect(p.frameMs.avg).toBeGreaterThan(0);
    expect(p.nodes).toBeGreaterThan(5);
    expect((await mcp.run({ op: 'look', dx: 30, dy: -10 })).failed).toBeUndefined();
    const f = await mcp.run({ op: 'frames', count: 4, every: 10 });
    expect(f.ticks).toHaveLength(4);
    expect(f.ticks[3] - f.ticks[0]).toBe(30);
    expect(f.width).toBeGreaterThan(300);
    expect((await mcp.run({ op: 'frames', count: 1, every: 5 })).text).toMatch(/count/);
  }, 180_000);

  it('a throw in game code fails the step at its place, keeps the error, and restart recovers', async () => {
    await mcp.run({ op: 'restart' });
    const file = readFileSync(join(dir, 'src/player.ts'), 'utf8');
    const edited = await mcp.tool('code.edit', { path: 'src/player.ts', old: '    const b = this.body;\n', new: "    if (p.z < -2) throw new Error('boom');\n    const b = this.body;\n" });
    expect(edited.structuredContent.written).toBe(true);
    const throwLine = lineOf(readFileSync(join(dir, 'src/player.ts'), 'utf8'), "throw new Error('boom')");
    expect(throwLine).toBeGreaterThan(lineOf(file, 'const b = this.body;') - 1);
    await mcp.run({ op: 'press', key: 'KeyW' });
    const r = await mcp.run({ op: 'step', n: 300 });
    expect(r.failed).toBe(true);
    expect(r.text).toMatch(new RegExp(`^(game\\.run: )?src/player\\.ts:${throwLine}:\\d+: Error: boom`));
    expect(r.text).not.toContain('runtime.ts');
    expect(r.text).toContain('  at ');
    expect(r.text).toContain('The world may be part-stepped: run {op:"restart"} before trusting state.');
    const errs = (await mcp.run({ op: 'errors' })).items;
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ level: 'error', message: 'Error: boom', file: 'src/player.ts', line: throwLine });
    expect(errs[0].stack.length).toBeLessThanOrEqual(6);
    expect(errs[0].stack[0]).toContain('src/player.ts');
    expect((await mcp.run({ op: 'state' })).errors).toBe(0);
    await mcp.run({ op: 'restart' });
  }, 180_000);

  it('play fails a script on a game error naming the place, and passes with allowErrors; its new steps work', async () => {
    const hold = { hold: 'KeyW', steps: 300 };
    const bad = (await mcp.tool('play', { script: { steps: [hold] } })).structuredContent;
    expect(bad.ok).toBe(false);
    expect(bad.problems[0].message).toMatch(/src\/player\.ts:\d+:\d+: Error: boom/);
    // Take the throw out again; the rest of the run uses the new steps.
    const fixed = await mcp.tool('code.edit', { path: 'src/player.ts', old: "    if (p.z < -2) throw new Error('boom');\n", new: '' });
    expect(fixed.structuredContent.written).toBe(true);
    const good = (await mcp.tool('play', { script: { steps: [
      { expect: { probe: 'mood', cmp: '==', value: 'calm' } },
      { look: [20, 0] },
      { press: 'KeyW' },
      { until: { node: 'player', field: 'z', cmp: '<', value: -2 }, max: 300 },
      { release: 'KeyW' },
      { inspect: 'player' },
      { expect: { node: 'player', field: 'z', cmp: '<', value: -2 } },
    ] } })).structuredContent;
    expect(good.problems).toEqual([]);
    expect(good.ok).toBe(true);
    expect(good.steps.at(-2).inspect.behaviours.map((b: any) => b.name)).toContain('Player');
    const unmet = (await mcp.tool('play', { script: { steps: [{ until: { probe: 'gemsLeft', cmp: '>', value: 999 }, max: 3 }] } })).structuredContent;
    expect(unmet.ok).toBe(false);
    expect(unmet.problems[0].message).toMatch(/did not hold within 3 ticks/);
  }, 240_000);

  it('a mistyped material shows up as a warning in the error ring (it was only a console.warn in the page)', async () => {
    const edit = await mcp.tool('code.edit', { path: 'src/player.ts', old: "material: 'material/player'", new: "material: 'material/playr'" });
    expect(edit.structuredContent.written).toBe(true);
    await mcp.run({ op: 'restart' });
    await mcp.run({ op: 'step', n: 2 });
    const items = (await mcp.run({ op: 'errors' })).items as { level: string; message: string }[];
    expect(items.some((i) => i.level === 'warn' && i.message.includes('material/playr'))).toBe(true);
  }, 180_000);
});

describe.skipIf(!hasBrowser)('the headless page lifetime', () => {
  let dir: string;
  beforeAll(async () => {
    dir = join(mkdtempSync(join(tmpdir(), 'hull-sight-life-')), 'game');
    await createProject({ template: 'arena', dir, title: 'Lifetime' });
  }, 120_000);
  afterAll(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  for (const how of ['stdin end', 'SIGTERM', 'SIGINT'] as const) {
    it(`closes the page when the server ends by ${how}`, async () => {
      const mcp = new Mcp(dir, 'life');
      await mcp.init();
      expect((await mcp.run({ op: 'state' })).tick).toBe(0);
      const name = `hull-link-${mcp.proc.pid}`;
      expect(sessions()).toContain(name);
      if (how === 'stdin end') mcp.proc.stdin.end(); else mcp.proc.kill(how);
      await mcp.exited();
      expect(await gone(name)).toBe(true);
    }, 180_000);
  }

  it('reaps a session left behind by a dead pid on the next start', async () => {
    const stale = 'hull-link-2000000000';
    spawnSync('agent-browser', ['--session', stale, 'open', 'about:blank'], { timeout: 60_000 });
    expect(sessions()).toContain(stale);
    const mcp = new Mcp(dir, 'reap');
    try {
      await mcp.init();
      await mcp.run({ op: 'state' });
      expect(sessions()).not.toContain(stale);
    } finally { await mcp.close(); }
  }, 180_000);
});

describe.skipIf(!hasBrowser)('reach: UI, picture size, per-frame stats, problems and determinism (fps template)', () => {
  let dir: string;
  let mcp: Mcp;
  beforeAll(async () => {
    dir = join(mkdtempSync(join(tmpdir(), 'hull-reach-')), 'game');
    await createProject({ template: 'fps', dir, title: 'Reach fps' });
    mcp = new Mcp(dir, 'reach');
    await mcp.init();
  }, 120_000);
  afterAll(async () => { await mcp.close(); rmSync(join(dir, '..'), { recursive: true, force: true }); });

  const buttons = async (): Promise<string[]> => ((await mcp.run({ op: 'ui' })).items as { kind: string; text: string }[]).filter((i) => i.kind === 'button').map((i) => i.text);

  it('perf draw calls and triangles are one frame, the same for 1 step and 120 steps of a still scene', async () => {
    await mcp.run({ op: 'restart' });
    const one = await mcp.run({ op: 'perf', steps: 1 });
    await mcp.run({ op: 'restart' });
    const many = await mcp.run({ op: 'perf', steps: 120 });
    expect(one.drawCalls).toBeGreaterThan(5);
    expect(many.drawCalls).toBe(one.drawCalls);
    expect(many.triangles).toBe(one.triangles);
  }, 180_000);

  it('tree puts repeated siblings on one line', async () => {
    await mcp.run({ op: 'restart' });
    const lines = (await mcp.run({ op: 'tree', depth: 2 })).lines as string[];
    expect(lines.some((l) => /^level\/crate x\d+  \[/.test(l))).toBe(true);
    expect(lines.filter((l) => l.startsWith('level/crate')).length).toBe(1);
  }, 180_000);

  it('ui lists the HUD; a menu opened by Escape lists its buttons; click and Enter activate them; a miss names the buttons', async () => {
    await mcp.run({ op: 'restart' });
    await mcp.run({ op: 'step', n: 5 });
    const hud = await mcp.run({ op: 'ui' });
    expect(hud.items.some((i: any) => i.kind === 'bar')).toBe(true);
    expect(await buttons()).toEqual([]);
    await mcp.run({ op: 'press', key: 'Escape' });
    await mcp.run({ op: 'release', key: 'Escape' });
    await mcp.run({ op: 'step', n: 2 });
    expect(await buttons()).toContain('Resume');
    const resume = (await mcp.run({ op: 'ui' })).items.find((i: any) => i.text === 'Resume');
    expect(resume.focused).toBe(true);
    const miss = await mcp.run({ op: 'click', button: 'Nope' });
    expect(miss.failed).toBe(true);
    expect(miss.text).toMatch(/no button says "Nope"; the buttons showing are "Resume"/);
    // Enter on the focused button is a key a person presses.
    await mcp.run({ op: 'press', key: 'Enter' });
    await mcp.run({ op: 'release', key: 'Enter' });
    expect(await buttons()).not.toContain('Resume');
    // And again by clicking.
    await mcp.run({ op: 'press', key: 'Escape' });
    await mcp.run({ op: 'release', key: 'Escape' });
    await mcp.run({ op: 'step', n: 2 });
    expect(await buttons()).toContain('Resume');
    expect(await mcp.run({ op: 'click', button: 'resume' })).toMatchObject({ clicked: 'Resume' });
    expect(await buttons()).not.toContain('Resume');
  }, 180_000);

  it('play has click, expectUi and ui steps', async () => {
    const r = (await mcp.tool('play', { script: { steps: [
      { press: 'Escape' }, { release: 'Escape' }, { step: 2 },
      { expectUi: { text: 'resume', kind: 'button' } },
      { ui: true },
      { click: 'Resume' },
      { expectUi: { text: 'Health' } },
    ] } })).structuredContent;
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.steps[4].ui.items.some((i: any) => i.text === 'Resume')).toBe(true);
    const miss = (await mcp.tool('play', { script: { steps: [{ expectUi: { text: 'Victory' } }] } })).structuredContent;
    expect(miss.ok).toBe(false);
    expect(miss.problems[0].message).toMatch(/shows no item containing "Victory"/);
  }, 240_000);

  it('screenshot takes a width and height for one picture and puts the page back', async () => {
    const dims = (s: any): number[] => [s.width, s.height];
    expect(dims(await mcp.run({ op: 'screenshot' }))).toEqual([640, 360]);
    expect(dims(await mcp.run({ op: 'screenshot', width: 960, height: 540 }))).toEqual([960, 540]);
    expect(dims(await mcp.run({ op: 'screenshot' }))).toEqual([640, 360]);
    expect(dims(await mcp.run({ op: 'frames', count: 2, every: 1, width: 1920, height: 1080 })).join('x')).toBe('640x180');
    expect((await mcp.run({ op: 'screenshot', width: 5000 })).text).toMatch(/1920/);
    expect(dims(await mcp.run({ op: 'screenshot' }))).toEqual([640, 360]);
  }, 180_000);

  it('problems.list carries the game\'s unread errors and warnings with their place, and does not mark them read', async () => {
    await mcp.run({ op: 'restart' });
    const edit = await mcp.tool('code.edit', { path: 'src/main.ts', old: 'ready(game) {', new: "ready(game) {\n    game.world.after(0.01, () => console.warn('reach-test-warning'));" });
    expect(edit.structuredContent.written).toBe(true);
    await mcp.run({ op: 'restart' });
    await mcp.run({ op: 'step', n: 3 });
    const list = (await mcp.tool('problems.list')).structuredContent;
    const items = (Array.isArray(list) ? list : list.result ?? list.problems ?? []) as { rule: string; message: string }[];
    expect(items.some((p) => p.rule === 'runtime' && p.message.includes('reach-test-warning'))).toBe(true);
    expect((await mcp.run({ op: 'state' })).errors).toBeGreaterThan(0);
    await mcp.run({ op: 'errors' });
    const after = (await mcp.tool('problems.list')).structuredContent;
    expect(JSON.stringify(after)).not.toContain('reach-test-warning');
  }, 180_000);
});

describe.skipIf(!hasBrowser)('reach: an effect on screen is the same picture every run', () => {
  let dir: string;
  let mcp: Mcp;
  beforeAll(async () => {
    dir = join(mkdtempSync(join(tmpdir(), 'hull-reach-fx-')), 'game');
    await createProject({ template: 'arena', dir, title: 'Reach fx' });
    mcp = new Mcp(dir, 'reachfx');
    await mcp.init();
    const a = await mcp.tool('code.edit', { path: 'src/main.ts', old: "import { defineGame } from 'hull';", new: "import { defineGame, probe } from 'hull';\nimport { vfx } from 'hull/vfx';" });
    expect(a.structuredContent.written).toBe(true);
    const b = await mcp.tool('code.edit', { path: 'src/main.ts', old: "    const eye = w.spawn('camera');", new: "    w.after(0.2, () => vfx.burst('vfx/sparks', { x: 0, y: 1.2, z: 0 }, undefined, { count: 400, size: 3 }));\n    probe('fx', () => vfx.stats().live);\n    const eye = w.spawn('camera');" });
    expect(b.structuredContent.written).toBe(true);
  }, 120_000);
  afterAll(async () => { await mcp.close(); rmSync(join(dir, '..'), { recursive: true, force: true }); });

  it('stepping right after a restart, before the renderer has started, gives the same picture each time', async () => {
    const pics: string[] = [];
    for (let run = 0; run < 3; run++) {
      await mcp.run({ op: 'restart' });
      await mcp.run({ op: 'press', key: 'KeyW' });
      expect((await mcp.run({ op: 'step', n: 30 })).probes.fx).toBeGreaterThan(0);
      pics.push((await mcp.run({ op: 'screenshot' })).png);
      await mcp.run({ op: 'release', key: 'KeyW' });
    }
    expect(pics[1]).toBe(pics[0]);
    expect(pics[2]).toBe(pics[0]);
  }, 300_000);

  it('the same play script three times matches one golden with no pixel allowed to differ', async () => {
    const steps = [{ press: 'KeyW' }, { step: 30 }, { expect: { probe: 'fx', cmp: '>', value: 0 } }, { screenshot: 'sparks' }, { step: 2 }, { screenshot: 'sparks-later' }, { release: 'KeyW' }];
    const first = (await mcp.tool('play', { script: { steps }, update: true })).structuredContent;
    expect(first.problems).toEqual([]);
    for (let run = 0; run < 3; run++) {
      const r = (await mcp.tool('play', { script: { steps } })).structuredContent;
      expect(r.problems).toEqual([]);
      const goldens = r.steps.filter((s: any) => s.golden).map((s: any) => s.golden);
      expect(goldens).toHaveLength(2);
      for (const g of goldens) expect(g).toMatchObject({ status: 'match', diffPixels: 0, maxDelta: 0 });
    }
  }, 300_000);
});
