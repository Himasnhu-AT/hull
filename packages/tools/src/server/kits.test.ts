// Which kit ships what, which import names belong to which kit, and the kit-config rule of check.
import { describe, expect, it } from 'vitest';
import { scanKitConfig } from '../tools/kitConfig.ts';
import { exportOwners, kitImports, listKits, planKitAdd } from './kits.ts';

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
