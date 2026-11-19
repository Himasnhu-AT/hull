import { describe, expect, it } from 'vitest';
import { diffFiles, summarize, type FileMap } from './diff.ts';
import { merge3Lines } from './lines.ts';

const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
const tuning = (v: unknown): string => JSON.stringify({ kind: 'tuning', ...(v as object) }, null, 2);
const tun = (n: number, extra = ''): string => `import { num, tunables } from 'hull';\nexport const player = tunables('player', {\n  runSpeed: num(${n}, { min: 0, max: 99 }),\n${extra}});\n`;

describe('the diff in plain words', () => {
  it('names JSON values by path', () => {
    const a = files({ 'config/sound/sword/hit.json': tuning({ level: -6, layers: [{ freq: 440 }, { freq: 880 }] }) });
    const b = files({ 'config/sound/sword/hit.json': tuning({ level: -3, layers: [{ freq: 440 }, { freq: 900 }], pan: 0.5 }) });
    expect(diffFiles(a, b).map((d) => d.text)).toEqual([
      'sound/sword/hit: level −6 → −3',
      'sound/sword/hit: layers[1].freq 880 → 900',
      'sound/sword/hit: pan added (0.5)',
    ]);
  });

  it('names tunables by block and key, and shows removals', () => {
    const a = files({ 'src/player.ts': tun(12.5, '  jump: num(2, {}),\n') });
    const b = files({ 'src/player.ts': tun(14) });
    const d = diffFiles(a, b);
    expect(d.map((x) => x.text)).toEqual(['player.runSpeed 12.5 → 14', 'player.jump removed (was 2)', 'src/player.ts: +1 −2 lines']);
    expect(d[0]).toMatchObject({ kind: 'tunable', target: 'tunables:player', path: 'runSpeed', from: 12.5, to: 14 });
  });

  it('falls back to lines for other code, and sizes for assets', () => {
    const a = files({ 'src/a.ts': 'one\ntwo\nthree\n', 'assets/rock.glb': 'x'.repeat(2048) });
    const b = files({ 'src/a.ts': 'one\n2\nthree\nfour\n', 'assets/rock.glb': 'x'.repeat(1024) });
    expect(diffFiles(a, b).map((d) => d.text)).toEqual(['assets/rock.glb replaced (2.0 KB → 1.0 KB)', 'src/a.ts: +2 −1 lines']);
  });

  it('describes a change in one line', () => {
    const a = files({ 'config/tuning/x.json': tuning({ a: 1, b: 2, c: 3, d: 4 }) });
    const b = files({ 'config/tuning/x.json': tuning({ a: 2, b: 3, c: 4, d: 5 }) });
    expect(summarize(diffFiles(a, b))).toBe('tuning/x: a 1 → 2; tuning/x: b 2 → 3; +2 more');
  });

  it('does not report a tunable change as a code change', () => {
    const d = diffFiles(files({ 'src/p.ts': tun(1) }), files({ 'src/p.ts': tun(2) }));
    expect(d).toHaveLength(1);
    expect(d[0]!.kind).toBe('tunable');
  });
});

describe('line merge', () => {
  it('combines separate edits and reports the same line changed twice', () => {
    const base = ['a', 'b', 'c', 'd', 'e'];
    expect(merge3Lines(base, ['A', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'E']).lines).toEqual(['A', 'b', 'c', 'd', 'E']);
    const r = merge3Lines(base, ['a', 'X', 'c', 'd', 'e'], ['a', 'Y', 'c', 'd', 'e']);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ ours: ['X'], theirs: ['Y'], base: ['b'] });
  });
});
