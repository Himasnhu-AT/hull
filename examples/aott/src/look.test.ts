/// <reference types="node" />
// The looks carry what the game's own scene used to: the sun, the hemisphere light and the shadows. These checks keep
// that true: no light of the game's own in its scene, and each look's sun points where the world's sky shader says it is.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, startGame } from 'hull';
import { resolveLook } from 'hull/render';
import { InputCore, wireInput } from 'hull/input';
import { projectSources } from 'hull/kits/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import def from './main.ts';
import { aottOf, hub } from './host.ts';
import { SUN_DIR } from './world/common.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const lookFile = (n: string) => JSON.parse(readFileSync(root + 'config/look/' + n + '.json', 'utf8'));

describe('looks', () => {
  for (const name of ['day', 'varn', 'dawn']) {
    it(name + ': the sun points along SUN_DIR, casts shadows ahead of the camera, and the post has a speed cue', () => {
      const r = resolveLook(lookFile(name));
      expect(r.sun.dir[0]).toBeCloseTo(SUN_DIR.x, 3);
      expect(r.sun.dir[1]).toBeCloseTo(SUN_DIR.y, 3);
      expect(r.sun.dir[2]).toBeCloseTo(SUN_DIR.z, 3);
      expect(r.sun.shadows).toBe(true);
      expect(r.sun.shadowLead).toBeGreaterThan(0);
      expect(r.sun.intensity).toBeGreaterThan(2);
      expect(r.ambient.hemisphere).toBe(true);
      expect(r.skyColor).toBeNull();
      expect(r.post!.speedBlur).toBeGreaterThan(0);
    });
  }
});

describe('the game scene', () => {
  beforeAll(() => {
    expect(config.load(projectSources(root)).problems).toEqual([]);
  });
  it('holds no light of its own', async () => {
    const core = new InputCore(() => 0);
    hub.view = core;
    hub.options = { allies: 0, noTitans: true };
    const g = await startGame(def, { seed: 1 });
    core.setMap(config.lookup('input-map', 'play'), 'input-map/play');
    wireInput(g, core);
    const a = aottOf(g);
    const lights: string[] = [];
    a.scene.traverse((o) => { if ((o as { isLight?: boolean }).isLight) lights.push(o.type); });
    expect(lights).toEqual([]);
    expect(a.world.sunDirection!.distanceTo(SUN_DIR)).toBeLessThan(1e-6);
  });
});
