import { describe, expect, it } from 'vitest';
import { createRegistry } from 'hull';
import { expandMoves, findRefs, freeId, planDelete, planDuplicate, planMoves, planNew, STARTERS, usesOf, type Sources } from './assets.ts';
import { thumbOf } from './thumbs.ts';

const cfg = (id: string, v: unknown): { path: string; text: string } => ({ path: `config/${id}.json`, text: JSON.stringify(v, null, 2) + '\n' });
const src = (): Sources => ({
  configs: [
    cfg('material/jacket', { kind: 'material', color: '#445566', roughness: 0.5, metalness: 0 }),
    cfg('material/boot', { kind: 'material', color: '#222222', roughness: 0.9, metalness: 0 }),
    cfg('character/soldier', { kind: 'character', materials: { jacket: 'material/jacket', boot: 'material/boot' }, again: ['material/jacket'] }),
    cfg('sound/hit', { kind: 'sound', note: 'material/jacket is only a note', level: -3 }),
  ],
  code: [{ path: 'src/game.ts', text: "const a = 'material/jacket'; const b = `material/boot`; // 'sound/hit'\nconst c = 'material/jacketx';\nconst d = config.lookup('material', 'jacket');\nconst e = 'jacket';\nplay('combat/x');\n" }],
});

describe('references', () => {
  it('finds a config value by pointer and a code literal, not a key, not a longer id', () => {
    const refs = findRefs(src(), new Set(['material/jacket'])).get('material/jacket')!;
    expect(refs.map((r) => `${r.file}${r.pointer ?? ''}`)).toEqual(['config/character/soldier.json/materials/jacket', 'config/character/soldier.json/again/0', 'src/game.ts', 'src/game.ts']);
    expect(refs[0]).toMatchObject({ kind: 'config', id: 'character/soldier', line: 4 });
  });
  it('lists what an asset uses', () => {
    expect(usesOf(src(), 'character/soldier').map((u) => u.id)).toEqual(['material/jacket', 'material/jacket', 'material/boot']);
  });
});

describe('rename and move', () => {
  it('rewrites every reference in configs and code, keeps formatting, moves the file', () => {
    const plan = planMoves(src(), [{ from: 'material/jacket', to: 'material/cloth/jacket' }]);
    expect(plan.ok).toBe(true);
    expect(plan.removes).toEqual(['config/material/jacket.json']);
    const w = Object.fromEntries(plan.writes.map((x) => [x.path, x.text]));
    expect(Object.keys(w).sort()).toEqual(['config/character/soldier.json', 'config/material/cloth/jacket.json', 'src/game.ts']);
    expect(w['config/character/soldier.json']).toContain('"jacket": "material/cloth/jacket"');
    expect(w['config/character/soldier.json']).toContain('"material/cloth/jacket"\n  ]');
    expect(w['src/game.ts']).toContain("'material/cloth/jacket'");
    expect(w['src/game.ts']).toContain("'material/jacketx'");
    expect(w['src/game.ts']).toContain("'sound/hit'");
    expect(w['src/game.ts']).toContain("config.lookup('material', 'cloth/jacket')");
    expect(w['src/game.ts']).toContain("const e = 'jacket';"); // a short form with no kind on its line is not a reference
    expect(plan.refs).toHaveLength(4);
    // the notes that merely mention the id are not references
    expect(plan.writes.some((x) => x.path === 'config/sound/hit.json')).toBe(false);
  });
  it('refuses a target that exists, a kind change and a bad id', () => {
    expect(planMoves(src(), [{ from: 'material/jacket', to: 'material/boot' }]).problems[0]!.message).toContain('already exists');
    expect(planMoves(src(), [{ from: 'material/jacket', to: 'sound/jacket' }]).problems[0]!.message).toContain('cannot move into');
    expect(planMoves(src(), [{ from: 'material/jacket', to: 'material/a b' }]).ok).toBe(false);
    expect(planMoves(src(), [{ from: 'material/nope', to: 'material/x' }]).ok).toBe(false);
  });
  it('moves several at once, and a swap is allowed', () => {
    const plan = planMoves(src(), [{ from: 'material/jacket', to: 'material/boot' }, { from: 'material/boot', to: 'material/jacket' }]);
    expect(plan.ok).toBe(true);
    const soldier = plan.writes.find((x) => x.path === 'config/character/soldier.json')!.text;
    expect(soldier).toContain('"jacket": "material/boot"');
    expect(soldier).toContain('"boot": "material/jacket"');
  });
  it('expands a folder into its assets', () => {
    const all = ['sound/a/x', 'sound/a/y', 'sound/b'];
    expect(expandMoves(all, ['sound/a', 'sound/b'], 'sound/z')).toEqual([{ from: 'sound/a/x', to: 'sound/z/a/x' }, { from: 'sound/a/y', to: 'sound/z/a/y' }, { from: 'sound/b', to: 'sound/z/b' }]);
    expect(expandMoves(all, ['sound/q'], 'sound/z')).toContain('neither');
  });
});

describe('delete', () => {
  it('refuses while referenced and says where', () => {
    const plan = planDelete(src(), ['material/jacket']);
    expect(plan.ok).toBe(false);
    expect(plan.refs).toHaveLength(4);
    expect(plan.problems[0]!.message).toContain('config/character/soldier.json#/materials/jacket:4:15');
    expect(plan.problems[0]!.message).toContain('src/game.ts');
  });
  it('deletes an unreferenced asset, and references from files deleted together do not count', () => {
    expect(planDelete(src(), ['sound/hit'])).toMatchObject({ ok: false });   // named in a code comment literal
    expect(planDelete(src(), ['character/soldier'])).toMatchObject({ ok: true, removes: ['config/character/soldier.json'] });
    const s = src();
    s.code = [];
    expect(planDelete(s, ['material/jacket', 'material/boot', 'character/soldier']).ok).toBe(true);
    expect(planDelete(s, ['material/jacket']).ok).toBe(false);
  });
});

describe('new and duplicate', () => {
  it('duplicates to the first free copy id', () => {
    const s = src();
    expect(freeId(s, 'material/jacket')).toBe('material/jacket-copy');
    s.configs.push(cfg('material/jacket-copy', {}));
    const plan = planDuplicate(s, 'material/jacket');
    expect(plan.created).toEqual(['material/jacket-copy-2']);
    expect(plan.writes[0]!.text).toBe(s.configs[0]!.text);
    expect(planDuplicate(s, 'material/jacket', 'material/boot').ok).toBe(false);
  });
  it('every starter is a valid document of its kind', () => {
    for (const kind of Object.keys(STARTERS)) {
      const plan = planNew({ configs: [], code: [] }, kind, `${kind}/fresh`);
      expect(plan.ok, kind).toBe(true);
      const r = createRegistry().load([{ path: plan.writes[0]!.path, text: plan.writes[0]!.text }]);
      expect(r.problems, kind).toEqual([]);
    }
    expect(Object.keys(STARTERS)).toEqual(expect.arrayContaining(['ui-screen', 'ui-theme']));
    expect(planNew(src(), 'character', 'character/x').ok).toBe(false);
    expect(planNew(src(), 'material', 'sound/x').ok).toBe(false);
  });
});

describe('thumbnails', () => {
  it('reads a few numbers or colours per kind', () => {
    expect(thumbOf('m', { kind: 'material', color: '#445566', roughness: 0.5 }, () => null)).toEqual({ type: 'material', color: '#445566', roughness: 0.5, metalness: 0 });
    expect(thumbOf('m', { kind: 'material', color: '#ff9a3a', emissive: '#ff6a00', emissiveIntensity: 3 }, () => null)).toMatchObject({ emissive: '#ff6a00' });
    expect(thumbOf('m', { kind: 'material', color: '#ff9a3a', emissive: '#ff6a00', emissiveIntensity: 0 }, () => null)).not.toHaveProperty('emissive');
    expect(thumbOf('l', { kind: 'look', sky: { horizon: '#111', mid: '#222', zenith: '#333' }, fog: { color: '#444' } }, () => null)).toMatchObject({ type: 'look', fog: '#444' });
    expect(thumbOf('v', { kind: 'vfx', particle: { color: [[0, '#ff0000'], [1, '#00ff00']] } }, () => null)).toEqual({ type: 'vfx', colors: ['#ff0000', '#00ff00'] });
    const snd = thumbOf('s', STARTERS['sound'], () => null);
    expect(snd).toMatchObject({ type: 'sound' });
    expect((snd as { bars: number[] }).bars).toHaveLength(28);
    expect(Math.max(...(snd as { bars: number[] }).bars)).toBe(1);
    const ch = thumbOf('c', { kind: 'character', materials: { a: 'material/jacket' } }, (id) => (id === 'material/jacket' ? { color: '#445566' } : null));
    expect(ch).toEqual({ type: 'character', colors: ['#445566'] });
    expect(thumbOf('x', { kind: 'mixer' }, () => null)).toBeNull();
  });
});
