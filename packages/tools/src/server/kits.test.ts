// Which kit ships what, which import names belong to which kit, and the kit-config rule of check.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanKitActions, scanKitConfig } from '../tools/kitConfig.ts';
import { hullDir } from '../create/docs.ts';
import { exportOwners, kitFileText, kitImports, listKits, planKitAdd } from './kits.ts';

describe('kits', () => {
  it('kit.list gives each kit its summary and the config it ships', () => {
    const kits = listKits();
    const level = kits.find((k) => k.kit === 'level')!;
    expect(level.summary.length).toBeGreaterThan(10);
    expect(level.config).toEqual(expect.arrayContaining(['level/yard', 'prefab/crate', 'material/floor']));
    expect(level.exports).toEqual(expect.arrayContaining(['ArenaLevel', 'Level']));
    expect(kits.find((k) => k.kit === 'menu')!.config).toEqual(['ui-screen/result', 'ui-screen/title']);
  });

  it('maps an exported name to its kit, following export * into a folder', () => {
    const o = exportOwners();
    expect(o.get('TitleScreen')?.kit).toBe('menu');
    expect(o.get('Combatant')?.kit).toBe('combat');
    expect(o.get('kitIO')).toBeUndefined();
  });

  it('kit.add writes the files the project lacks and keeps the ones it has', () => {
    const plan = planKitAdd('menu', new Set(['ui-screen/title']));
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.created).toEqual(['ui-screen/result']);
    expect(plan.kept).toEqual(['ui-screen/title']);
    expect(plan.writes.map((w) => w.path)).toEqual(['config/ui-screen/result.json']);
    expect(JSON.parse(plan.writes[0]!.text).kind).toBe('ui-screen');
    const bad = planKitAdd('nope', new Set());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('menu');
  });

  it('ignores type-only imports and pure helpers', () => {
    const text = "import type { Block } from 'hull/kits';\nimport { newWaveState, stepWaves, type Goal } from 'hull/kits';\n";
    expect(kitImports(text)).toEqual([expect.objectContaining({ kit: 'spawner', uses: new Set() })]);
  });
});

describe('check rule kit-config', () => {
  const src = [{ file: 'src/main.ts', text: "import { Hud }\n  from 'x';\n\nimport { TitleScreen, ResultScreen } from 'hull/kits';\n" }];
  it('names the import, the missing ids and the kit.add call', () => {
    const p = scanKitConfig(src, new Set());
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ file: 'src/main.ts', line: 4, col: 1, rule: 'kit-config' });
    expect(p[0]!.message).toContain('ui-screen/title');
    expect(p[0]!.message).toContain('kit.add {"kit":"menu"}');
  });
  it('is quiet once the project has the files', () => {
    expect(scanKitConfig(src, new Set(['ui-screen/title', 'ui-screen/result']))).toEqual([]);
  });
  it('reports only what is missing', () => {
    const p = scanKitConfig(src, new Set(['ui-screen/result']));
    expect(p[0]!.message).toContain('ui-screen/title');
    expect(p[0]!.message).not.toContain('ui-screen/result');
  });
});

describe('templates keep up with the kits', () => {
  const templates = join(hullDir(), '..', '..', 'templates');
  const actionsOf = (text: string): string[] => Object.keys(JSON.parse(text).actions);
  it.each(['arena', 'cube', 'fps', 'third-person', 'yard'])('template %s has every action of the kit input map with the same id', (name) => {
    for (const kit of listKits()) for (const id of kit.config.filter((c) => c.startsWith('input-map/'))) {
      let mine: string;
      try { mine = readFileSync(join(templates, name, 'config', id + '.json'), 'utf8'); } catch { continue; }
      const missing = actionsOf(kitFileText(kit.kit, id)).filter((a) => !actionsOf(mine).includes(a));
      expect(missing, name + ' ' + id).toEqual([]);
    }
  });
});

describe('kit.add on a file the project already has', () => {
  const stale = JSON.stringify({ kind: 'input-map', actions: { move: { type: 'axis2', keys: { up: ['Z'], down: ['S'], left: ['A'], right: ['D'] } }, fire: { type: 'button', keys: ['Space'] } }, groups: { Move: ['move'] } });
  it('says a kept file differs, and adds the actions its input map lacks without changing the ones it has', () => {
    const plan = planKitAdd('fps', new Set(['input-map/fps']), (id) => (id === 'input-map/fps' ? stale : undefined));
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.differs).toContain('input-map/fps');
    expect(plan.merged['input-map/fps']).toContain('interact');
    expect(plan.merged['input-map/fps']).not.toContain('fire');
    const w = plan.writes.find((x) => x.path === 'config/input-map/fps.json')!;
    const doc = JSON.parse(w.text);
    expect(doc.actions.interact.keys).toEqual(['E']);
    expect(doc.actions.move.keys.up).toEqual(['Z']);
    expect(doc.actions.fire.keys).toEqual(['Space']);
    expect(doc.groups.Move).toContain('interact');
  });
  it('reports nothing for a file that is the kit\'s own', () => {
    const own = kitFileText('fps', 'input-map/fps');
    const plan = planKitAdd('fps', new Set(['input-map/fps']), () => own);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.differs).toEqual([]);
    expect(plan.merged).toEqual({});
    expect(plan.writes.filter((x) => x.path.includes('input-map'))).toEqual([]);
  });
});

describe('check rule kit-input', () => {
  const src = [{ file: 'src/main.ts', text: "import { Hud }\n  from 'x';\n\nimport { Interactor } from 'hull/kits';\n" }];
  it('names the action, the import and the kit.add call when no input map defines it', () => {
    const p = scanKitActions(src, new Set(['move', 'jump']));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ file: 'src/main.ts', line: 4, col: 1, rule: 'kit-input' });
    expect(p[0]!.message).toContain('"interact"');
    expect(p[0]!.message).toMatch(/kit\.add \{"kit":"(fps|third-person)"\}/);
  });
  it('is quiet once an input map defines the action', () => {
    expect(scanKitActions(src, new Set(['interact']))).toEqual([]);
  });
});
