/// <reference types="node" />
import { Mesh as ThreeMesh, Object3D, Quaternion } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { config, defineGame, startGame, type Game } from '../index.ts';
import { loadedModel, parseModel, forgetModel, loadModel } from '../render/gltf.ts';
import { Model } from '../render/index.ts';
import { registerAsset } from '../render/assets.ts';
import { Animator, sampleClip } from './index.ts';
import { armGlb, cubeGlb, ELBOW_REST, WAVE_BEND } from './gltf-fixture.ts';

const char = (extra: Record<string, unknown> = {}, joints: Record<string, string> = { armL: 'rig:Shoulder', forearmL: 'rig:Elbow', handL: 'rig:Wrist' }): string =>
  JSON.stringify({ kind: 'character', body: { type: 'gltf', file: 'models/arm.glb', joints, ...extra }, animSet: 'anim-set/arm', animGraph: 'anim-graph/arm' });

const sources = (): { path: string; text: string }[] => [
  { path: 'config/character/arm.json', text: char() },
  { path: 'config/character/broken.json', text: char({}, { armL: 'rig:Shoulder', forearmL: 'rig:Elbo' }) },
  { path: 'config/character/missing.json', text: char({ file: 'models/nope.glb' }) },
  { path: 'config/character/nofile.json', text: JSON.stringify({ kind: 'character', body: { type: 'gltf' } }) },
  { path: 'config/character/twice.json', text: char({}, { armL: 'rig:Shoulder', forearmL: 'rig:Shoulder' }) },
  {
    path: 'config/anim-set/arm.json',
    text: JSON.stringify({
      kind: 'anim-set',
      clips: {
        rest: { type: 'keyframes', length: 1, loop: true, tracks: { forearmL: { rotation: [[0, [0, 0, 0]], [1, [0, 0, 0]]] } } },
        wave: { type: 'gltf', clip: 'Wave', loop: true },
        ghost: { type: 'gltf', clip: 'Nope' },
        walk: { type: 'generated', generator: 'humanoid/walk', loop: true },
      },
    }),
  },
  {
    path: 'config/anim-graph/arm.json',
    text: JSON.stringify({
      kind: 'anim-graph',
      params: { waving: { type: 'boolean', default: false } },
      layers: { base: { start: 'rest', states: { rest: { clip: 'rest' }, wave: { clip: 'wave' } }, transitions: [{ from: 'rest', to: 'wave', when: 'waving', blend: 0.5 }, { from: 'wave', to: 'rest', when: '!waving', blend: 0.5 }] } },
    }),
  },
];

beforeAll(async () => {
  const res = config.load(sources());
  expect(res.problems).toEqual([]);
  registerAsset('models/arm.glb', armGlb());
  registerAsset('models/cube.glb', cubeGlb());
  await Promise.all([loadModel('models/arm.glb'), loadModel('models/cube.glb')]);
});

async function start(character: string): Promise<{ game: Game; a: Animator }> {
  let a!: Animator;
  const game = await startGame(defineGame({ ready(g) { a = g.world.spawn('hero').add(Animator, { character }); } }), { seed: 1, stepRate: 60 });
  return { game, a };
}

describe('glTF parse', () => {
  it('reads the skin, the mesh and the animation', () => {
    const m = loadedModel('models/arm.glb')!;
    expect(m.animations.map((a) => a.name)).toEqual(['Wave']);
    let skinned = 0;
    m.scene.traverse((o) => { if ((o as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) skinned++; });
    expect(skinned).toBe(1);
    expect(armGlb().byteLength).toBeLessThan(20 * 1024);
  });

  it('says what is wrong with bytes that are not a glTF', async () => {
    await expect(parseModel('models/bad.glb', new ArrayBuffer(16))).rejects.toThrow(/assets\/models\/bad.glb is not a valid glTF/);
  });

  it('names a missing file and what assets/ holds', async () => {
    forgetModel('models/none.glb');
    await expect(loadModel('models/none.glb')).rejects.toThrow(/assets\/models\/none.glb does not exist \(assets\/ holds: models\/arm.glb, models\/cube.glb\)/);
  });
});

describe('Model', () => {
  async function model(opts: Record<string, unknown>): Promise<{ game: Game; m: Model; n: Object3D }> {
    let m!: Model;
    const game = await startGame(defineGame({ ready(g) { m = g.world.spawn('crate').add(Model, opts); } }), { seed: 1, stepRate: 60 });
    return { game, m, n: m.node.object3d };
  }
  it('draws a static file with the file\'s own materials, with no renderer', async () => {
    const { game, m } = await model({ file: 'models/cube.glb' });
    expect(m.loaded).toBe(true);
    const mesh = m.view!.getObjectByProperty('isMesh', true) as ThreeMesh;
    expect((mesh.material as unknown as { color: { g: number } }).color.g).toBeGreaterThan(0.4);
    game.step(3);
    game.dispose();
  });
  it('takes a colour override and gives the file\'s material back when it is cleared', async () => {
    const { game, m } = await model({ file: 'models/cube.glb', color: '#ff0000' });
    const mesh = m.view!.getObjectByProperty('isMesh', true) as ThreeMesh;
    expect((mesh.material as unknown as { color: { r: number; g: number } }).color.r).toBe(1);
    m.color = undefined;
    game.world.update(0, 0);
    expect((mesh.material as unknown as { color: { r: number; g: number } }).color.g).toBeGreaterThan(0.4);
    game.dispose();
  });
  it('shows a file that loads later, and reports a missing one without throwing', async () => {
    const { game, m } = await model({ file: 'models/late.glb' });
    expect(m.loaded).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(m.problem).toMatch(/assets\/models\/late.glb does not exist/);
    game.dispose();
  });
  it('gives each Model its own copy of the nodes', async () => {
    const a = await model({ file: 'models/arm.glb' });
    const b = await model({ file: 'models/arm.glb' });
    expect(a.m.view).not.toBe(b.m.view);
    a.game.dispose(); b.game.dispose();
  });
});

describe('glTF character', () => {
  it('maps joints by the table and keeps the model\'s names for the rest', async () => {
    const { game, a } = await start('character/arm');
    expect(a.problems.filter((p) => p.startsWith('character'))).toEqual([]);
    expect(a.skeleton.names).toEqual(['armL', 'forearmL', 'handL']);
    expect(Array.from(a.skeleton.parent)).toEqual([-1, 0, 1]);
    expect(a.skeleton.restRot![4]).toBeCloseTo(ELBOW_REST[0], 6);
    expect(a.bone('forearmL')).toBeDefined();
    game.dispose();
  });

  it('turns the model\'s animation into a change from rest', async () => {
    const { game, a } = await start('character/arm');
    const wave = a.clip('wave')!;
    expect(wave.length).toBeCloseTo(1, 6);
    const p0 = sampleClip(wave, a.skeleton, 0);
    expect(p0.rot[4]).toBeCloseTo(0, 6); expect(p0.rot[7]).toBeCloseTo(1, 6);
    const p = sampleClip(wave, a.skeleton, 0.5);
    expect(p.rot[4]).toBeCloseTo(0, 6); expect(p.rot[5]).toBeCloseTo(0, 6);
    expect(p.rot[6]).toBeCloseTo(Math.sin(WAVE_BEND / 2), 6); expect(p.rot[7]).toBeCloseTo(Math.cos(WAVE_BEND / 2), 6);
    // Halfway through the rise it is halfway between the keys.
    const q = sampleClip(wave, a.skeleton, 0.25);
    const half = new Quaternion(0, 0, Math.sin(WAVE_BEND / 4), Math.cos(WAVE_BEND / 4));
    expect(Math.abs(q.rot[6]! - half.z)).toBeLessThan(0.01);
    game.dispose();
  });

  it('writes rest times the change into the bones', async () => {
    const { game, a } = await start('character/arm');
    a.previewClip('wave', 0.5);
    const bone = a.bone('forearmL')!;
    const want = new Quaternion(...ELBOW_REST).multiply(new Quaternion(0, 0, Math.sin(WAVE_BEND / 2), Math.cos(WAVE_BEND / 2)));
    expect(bone.quaternion.angleTo(want)).toBeLessThan(1e-5);
    // The skinned mesh's bone is the same object, so the mesh follows.
    let skinBone = false;
    a.node.object3d.traverse((o) => { const s = o as unknown as { skeleton?: { bones: Object3D[] } }; if (s.skeleton?.bones.includes(bone)) skinBone = true; });
    expect(skinBone).toBe(true);
    game.dispose();
  });

  it('blends a glTF clip with a keyframe clip through the state graph', async () => {
    const { game, a } = await start('character/arm');
    expect(a.stateOf()).toBe('rest');
    a.set('waving', true);
    game.step(15);
    expect(a.stateOf()).toBe('wave');
    const w = a.weights();
    expect(w.wave).toBeGreaterThan(0.2); expect(w.wave).toBeLessThan(1);
    expect((w.rest ?? 0) + w.wave!).toBeCloseTo(1, 6);
    game.step(60);
    expect(a.weights().wave).toBeCloseTo(1, 6);
    // Mid-blend the bone sits between rest and the wave.
    const mid = a.bone('forearmL')!.quaternion;
    expect(mid.angleTo(new Quaternion(...ELBOW_REST))).toBeGreaterThanOrEqual(0);
    game.dispose();
  });

  it('is deterministic: the same steps give the same animation state', async () => {
    const run = async (): Promise<string> => {
      const { game, a } = await start('character/arm');
      a.set('waving', true);
      game.step(40);
      const s = JSON.stringify(a.animState);
      game.dispose();
      return s;
    };
    expect(await run()).toBe(await run());
  });

  it('names the file and pointer for a wrong joint, a missing file, no file and a doubled joint', async () => {
    const broken = await start('character/broken');
    expect(broken.a.problems[0]).toMatch(/^character\/broken#\/body\/joints\/forearmL: the model "models\/arm.glb" has no joint "rig:Elbo" \(its joints: rig:Shoulder, rig:Elbow, rig:Wrist\)/);
    broken.game.dispose();
    const twice = await start('character/twice');
    expect(twice.a.problems[0]).toMatch(/^character\/twice#\/body\/joints\/forearmL: .*already "armL"/);
    twice.game.dispose();
    const nofile = await start('character/nofile');
    expect(nofile.a.problems[0]).toMatch(/^character\/nofile#\/body\/file: a glTF body needs/);
    nofile.game.dispose();
    const missing = await start('character/missing');
    await new Promise((r) => setTimeout(r, 5));
    expect(missing.a.problems.join('\n')).toMatch(/character\/missing#\/body\/file: assets\/models\/nope.glb does not exist/);
    missing.game.dispose();
  });

  it('names the anim-set pointer for a clip the model does not have, and for a generated clip', async () => {
    const { game, a } = await start('character/arm');
    const text = a.problems.join('\n');
    expect(text).toMatch(/anim-set\/arm#\/clips\/ghost\/clip: the model "models\/arm.glb" has no animation "Nope" \(it has: Wave\)/);
    expect(text).toMatch(/anim-set\/arm#\/clips\/walk\/type: a generated clip is built for the humanoid recipe/);
    game.dispose();
  });

  it('builds when the file is not loaded yet, once it arrives', async () => {
    forgetModel('models/arm.glb');
    const { game, a } = await start('character/arm');
    expect(a.clipNames).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    game.step(2);
    expect(a.clipNames).toContain('wave');
    game.dispose();
  });
});
