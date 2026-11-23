import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Change } from 'hull/dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAuthorship } from './authors.ts';
import { History } from './history.ts';
import { atomicWrite, writeTracked } from './store.ts';

const dirs: string[] = [];
const opened: History[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TUNING = (spin: number, extra = ''): string => `{\n  "kind": "tuning",\n  "spin": ${spin},\n  "list": [1, 2, 3]${extra}\n}\n`;
const TS = (run: number): string => `import { num, tunables } from 'hull';\nexport const player = tunables('player', {\n  runSpeed: num(${run}, { min: 0, max: 99 }),\n});\n`;

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hull-hist-'));
  dirs.push(root);
  const all = { 'hull.json': '{\n  "kind": "game",\n  "id": "t",\n  "title": "T",\n  "version": "0.1.0",\n  "entry": "src/main.ts",\n  "step": 60\n}\n', 'config/tuning/t.json': TUNING(1), 'src/tuning.ts': TS(10), ...files };
  for (const [p, t] of Object.entries(all)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
  return root;
}
const open = async (root: string, extra: Partial<Parameters<typeof History.open>[0]> = {}): Promise<History> => {
  const h = await History.open({ root, quietMs: 0, ...extra });
  opened.push(h);
  return h;
};
const edit = async (h: History, root: string, by: Parameters<History['touch']>[0], path: string, text: string, line = 'main'): Promise<void> => {
  await h.settle(by, line);
  writeFileSync(join(line === 'main' ? root : join(root, '.hull', 'exp', line), path), text);
  h.touch(by, line);
  await h.flush(line);
};

describe('journal replay', () => {
  it('turns the M1 journal into the first commits, with authors and plain-words messages', async () => {
    const root = project({ 'config/tuning/t.json': TUNING(3), 'src/tuning.ts': TS(14) });
    const journal: Change[] = [
      { at: '2026-01-01T10:00:00.000Z', by: 'you', target: 'tuning/t', path: '/spin', from: 1, to: 2 },
      { at: '2026-01-01T10:01:00.000Z', by: 'ai:claude', target: 'tunables:player', path: 'runSpeed', from: 10, to: 14 },
      { at: '2026-01-01T10:02:00.000Z', by: 'you', target: 'tuning/t', path: '/spin', from: 2, to: 3 },
    ];
    mkdirSync(join(root, '.hull'), { recursive: true });
    writeFileSync(join(root, '.hull', 'journal.jsonl'), `${journal.map((c) => JSON.stringify(c)).join('\n')}\n`);
    const h = await open(root);
    const list = await h.list();
    expect(list.map((c) => [c.by, c.message])).toEqual([
      ['you', 'tuning/t: spin 2 → 3'],
      ['ai:claude', 'player.runSpeed 10 → 14'],
      ['you', 'tuning/t: spin 1 → 2'],
      ['you', 'start of history'],
    ]);
    expect(list[3]!.kind).toBe('start');
    // The state the journal led to is what is on disk, so no extra "disk" change was needed.
    expect(list.some((c) => c.by === 'disk')).toBe(false);
    expect(list[0]!.at).toBe('2026-01-01T10:02:00.000Z');
  });

  it('records edits made while Hull was off as the disk\'s', async () => {
    const root = project();
    (await open(root)).close();
    writeFileSync(join(root, 'config/tuning/t.json'), TUNING(9));
    const h = await open(root);
    const [newest] = await h.list();
    expect(newest).toMatchObject({ by: 'disk', message: 'tuning/t: spin 1 → 9' });
  });
});

describe('changes', () => {
  it('commits a burst with the author and the plain-words diff, and never records "nothing changed"', async () => {
    const root = project();
    const added: string[] = [];
    const h = await open(root, { onAdded: (c) => added.push(c.message) });
    await edit(h, root, 'ai:claude', 'config/tuning/t.json', TUNING(2));
    await h.flush();
    const [c] = await h.list();
    expect(c).toMatchObject({ by: 'ai:claude', message: 'tuning/t: spin 1 → 2', line: 'main', kind: 'change' });
    expect(added).toEqual(['tuning/t: spin 1 → 2']);
    h.touch('you');
    await h.flush();
    expect(await h.list()).toHaveLength(2);
  });

  it('never tracks .hull or dist', async () => {
    const root = project({ 'dist/game.js': 'x' });
    const h = await open(root);
    writeFileSync(join(root, '.hull', 'scratch.txt'), 'x');
    h.touch('disk');
    await h.flush();
    expect(await h.list()).toHaveLength(1);
  });
});

describe('authorship', () => {
  it('flags an AI change over a value you set, naming file#pointer, and clears it when you set it again', async () => {
    const root = project();
    const h = await open(root);
    await edit(h, root, 'you', 'config/tuning/t.json', TUNING(2));
    expect(await h.authorshipProblems()).toEqual([]);
    await edit(h, root, 'ai:claude', 'config/tuning/t.json', TUNING(5));
    const flags = await h.authorshipProblems();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ file: 'config/tuning/t.json', pointer: '/spin', rule: 'authorship' });
    expect(flags[0]!.message).toContain('ai:claude');
    expect(flags[0]!.message).toContain('set by you');
    await edit(h, root, 'you', 'config/tuning/t.json', TUNING(4));
    expect(await h.authorshipProblems()).toEqual([]);
  });

  it('flags tunables, ignores AI changes over values nobody set, and is rebuilt from history when authors.json is lost', async () => {
    const root = project();
    const h = await open(root);
    await edit(h, root, 'ai:claude', 'config/tuning/t.json', TUNING(2));
    expect(await h.authorshipProblems()).toEqual([]);
    await edit(h, root, 'you', 'src/tuning.ts', TS(12));
    await edit(h, root, 'ai:claude', 'src/tuning.ts', TS(20));
    rmSync(join(root, '.hull', 'authors.json'));
    const problems = await checkAuthorship(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: 'src/tuning.ts', pointer: '/player/runSpeed', rule: 'authorship' });
    expect(JSON.parse(readFileSync(join(root, '.hull', 'authors.json'), 'utf8')).entries['tunables:player#runSpeed'].by).toBe('ai:claude');
  });
});

describe('checkpoints and restore', () => {
  it('restores a change or a checkpoint as a new change, so nothing is lost', async () => {
    const root = project();
    const h = await open(root);
    await edit(h, root, 'you', 'config/tuning/t.json', TUNING(2));
    const cp = await h.checkpoint('before the new camera');
    await edit(h, root, 'ai:claude', 'config/tuning/t.json', TUNING(7, ''));
    await edit(h, root, 'you', 'src/tuning.ts', TS(30));
    const before = await h.list();
    expect(before).toHaveLength(4);
    expect(before.find((c) => c.id === cp.id)!.checkpoints).toEqual(['before the new camera']);

    const r = await h.restore('before the new camera');
    expect(r.ok).toBe(true);
    expect(readFileSync(join(root, 'config/tuning/t.json'), 'utf8')).toBe(TUNING(2));
    expect(readFileSync(join(root, 'src/tuning.ts'), 'utf8')).toBe(TS(10));
    expect(r.change).toMatchObject({ kind: 'restore', by: 'you' });
    expect(r.change!.message).toContain('restore before the new camera');
    const after = await h.list();
    expect(after).toHaveLength(5);

    // Undo the restore: the work between is still there.
    await h.restore(before[0]!.id);
    expect(readFileSync(join(root, 'config/tuning/t.json'), 'utf8')).toBe(TUNING(7, ''));
    expect(readFileSync(join(root, 'src/tuning.ts'), 'utf8')).toBe(TS(30));
    const d = await h.diff({ to: before[0]!.id });
    expect(d.deltas.map((x) => x.text)).toEqual(['player.runSpeed 10 → 30']);
  });

  it('refuses a restore that would add config problems', async () => {
    const root = project();
    const h = await open(root);
    await edit(h, root, 'you', 'config/tuning/t.json', TUNING(2));
    const r = await h.restore('main');
    expect(r.ok).toBe(true);
    expect(r.change).toBeUndefined();
  });
});

describe('experiments', () => {
  it('start from one point, tune each, compare, adopt one by a three-way merge; the other stays in the timeline', async () => {
    const root = project();
    const h = await open(root);
    const a = await h.expStart('heavy', undefined, 'you');
    const b = await h.expStart('light');
    expect(a.from).toBe(b.from);
    await edit(h, root, 'you', 'config/tuning/t.json', TUNING(1).replace('[1, 2, 3]', '[5, 2, 3]'));
    await edit(h, root, 'you', 'config/tuning/t.json', TUNING(9).replace('[1, 2, 3]', '[1, 2, 7]'), 'heavy');
    await edit(h, root, 'ai:claude', 'src/tuning.ts', TS(3), 'light');

    const cmp = await h.expCompare('heavy', 'light');
    expect(cmp.deltas.map((d) => d.text).sort()).toEqual(['player.runSpeed 10 → 3', 'tuning/t: spin 9 → 1', 'tuning/t: list[2] 7 → 3'].sort());

    const res = await h.expAdopt('heavy');
    expect(res.ok).toBe(true);
    expect(res.conflicts).toEqual([]);
    const merged = JSON.parse(readFileSync(join(root, 'config/tuning/t.json'), 'utf8'));
    expect(merged).toMatchObject({ spin: 9, list: [5, 2, 7] });
    expect(res.change).toMatchObject({ kind: 'merge', line: 'main' });
    expect(res.change!.parents).toHaveLength(2);

    const exps = await h.expList();
    expect(exps.map((e) => [e.name, e.status, e.changes])).toEqual([['heavy', 'adopted', 1], ['light', 'active', 1]]);
    const lines = new Set((await h.list()).map((c) => c.line));
    expect(lines).toEqual(new Set(['main', 'heavy', 'light']));
    await h.expDiscard('light');
    expect((await h.expList()).map((e) => e.status)).toEqual(['adopted', 'discarded']);
    expect((await h.list({ line: 'light' })).length).toBe(1);
  });

  it('reports a conflict by path with both values and applies a decision', async () => {
    const root = project();
    const h = await open(root);
    await h.expStart('x');
    await edit(h, root, 'you', 'config/tuning/t.json', TUNING(5));
    await edit(h, root, 'you', 'config/tuning/t.json', TUNING(8), 'x');
    const r = await h.expAdopt('x');
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ file: 'config/tuning/t.json', kind: 'json', target: 'tuning/t', path: '/spin', base: 1, ours: 5, theirs: 8 }]);
    expect(JSON.parse(readFileSync(join(root, 'config/tuning/t.json'), 'utf8')).spin).toBe(5);
    const r2 = await h.expAdopt('x', 'you', { 'tuning/t#/spin': 'theirs' });
    expect(r2.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'config/tuning/t.json'), 'utf8')).spin).toBe(8);
  });

  it('credits adopted values to whoever set them inside the experiment', async () => {
    const root = project();
    const h = await open(root);
    await edit(h, root, 'you', 'config/tuning/t.json', TUNING(2));
    await h.expStart('ai-try');
    await edit(h, root, 'ai:claude', 'config/tuning/t.json', TUNING(6), 'ai-try');
    await h.expAdopt('ai-try');
    const flags = await h.authorshipProblems();
    expect(flags).toHaveLength(1);
    expect(flags[0]!.pointer).toBe('/spin');
  });
});

describe('patch and revert one file or field', () => {
  it('shows a compact line diff against a starting point', async () => {
    const root = project();
    const h = await open(root);
    const start = (await h.list())[0]!.id;
    await edit(h, root, 'you', 'src/tuning.ts', TS(14));
    const p = await h.patch({ from: start, to: 'main', file: 'src/tuning.ts' });
    expect(p.lines.filter((l) => l.op !== 'ctx').map((l) => [l.op, l.text.trim()])).toEqual([['del', 'runSpeed: num(10, { min: 0, max: 99 }),'], ['add', 'runSpeed: num(14, { min: 0, max: 99 }),']]);
  });
  it('puts one added row back by taking it out, leaving the rest as edited, and records it', async () => {
    const root = project();
    const h = await open(root);
    const start = (await h.list())[0]!.id;
    await edit(h, root, 'ai:test', 'config/tuning/t.json', TUNING(5).replace('[1, 2, 3]', '[1, 2, 3, 4]'));
    const r = await h.revert(start, 'config/tuning/t.json', 'you', '/list/3');
    expect(r.ok).toBe(true);
    const back = JSON.parse(readFileSync(join(root, 'config/tuning/t.json'), 'utf8'));
    expect(back.list).toEqual([1, 2, 3]);
    expect(back.spin).toBe(5);
    expect((await h.list())[0]!.kind).toBe('restore');
  });
  it('puts a whole file back, including one that was added', async () => {
    const root = project();
    const h = await open(root);
    const start = (await h.list())[0]!.id;
    await edit(h, root, 'you', 'src/tuning.ts', TS(99));
    await edit(h, root, 'you', 'src/extra.ts', 'export const x = 1;\n');
    expect((await h.revert(start, 'src/tuning.ts')).ok).toBe(true);
    expect((await h.revert(start, 'src/extra.ts')).ok).toBe(true);
    expect(readFileSync(join(root, 'src/tuning.ts'), 'utf8')).toBe(TS(10));
    expect((await h.diff({ from: start, to: 'main' })).deltas).toEqual([]);
  });
});
