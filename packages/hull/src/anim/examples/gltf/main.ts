// A page that shows a static glTF Model (with and without a material override) and a skinned glTF character whose
// "Wave" clip plays through the state graph. The files are written in code (gltf-fixture.ts), so no assets/ folder is needed.
// Drive it through `window.hull`: `step(n)` runs whole fixed steps and draws; `wave(true)` asks for the wave.
import { config, defineGame, startGame, type Game } from '../../../index.ts';
import { Camera, Light, Mesh, Model, mountRender, preloadModels, registerAsset } from '../../../render/index.ts';
import { Animator } from '../../index.ts';
import { armGlb, cubeGlb } from '../../gltf-fixture.ts';

const params = new URLSearchParams(location.search);
const joints = { armL: 'rig:Shoulder', forearmL: 'rig:Elbow', handL: 'rig:Wrist' };
const loaded = config.load([
  { path: 'config/character/arm.json', text: JSON.stringify({ kind: 'character', body: { type: 'gltf', file: 'models/arm.glb', joints }, animSet: 'anim-set/arm', animGraph: 'anim-graph/arm' }) },
  { path: 'config/anim-set/arm.json', text: JSON.stringify({ kind: 'anim-set', clips: { rest: { type: 'keyframes', length: 1, loop: true, tracks: { forearmL: { rotation: [[0, [0, 0, 0]], [1, [0, 0, 0]]] } } }, wave: { type: 'gltf', clip: 'Wave', loop: true } } }) },
  { path: 'config/anim-graph/arm.json', text: JSON.stringify({ kind: 'anim-graph', params: { waving: { type: 'boolean', default: false } }, layers: { base: { start: 'rest', states: { rest: { clip: 'rest' }, wave: { clip: 'wave' } }, transitions: [{ from: 'rest', to: 'wave', when: 'waving', blend: 0.4 }, { from: 'wave', to: 'rest', when: '!waving', blend: 0.4 }] } } }) },
  { path: 'config/material/steel.json', text: JSON.stringify({ kind: 'material', color: '#8fa3b8', roughness: 0.3, metalness: 0.9 }) },
]);
for (const p of loaded.problems) console.error(`${p.file}${p.pointer ?? ''}: ${p.message}`);
registerAsset('models/arm.glb', armGlb());
registerAsset('models/cube.glb', cubeGlb());
await preloadModels(['models/arm.glb', 'models/cube.glb']);

const def = defineGame({
  ready(game: Game) {
    const w = game.world;
    const ground = w.spawn('ground');
    ground.add(Mesh, { shape: 'plane', color: '#5d6b52', castShadow: false });
    ground.scale.set(40, 1, 40);
    const sun = w.spawn('sun');
    sun.rotation.set(-0.85, 0.6, 0);
    sun.position.set(0, 20, 0);
    sun.add(Light, { type: 'sun', intensity: 2.6, castShadow: true, shadowSize: 20 });
    w.spawn('arm').add(Animator, { character: 'character/arm' });
    const plain = w.spawn('cube-plain'); plain.position.set(-2.2, 0.5, 0); plain.add(Model, { file: 'models/cube.glb' });
    const steel = w.spawn('cube-steel'); steel.position.set(2.2, 0.5, 0); steel.add(Model, { file: 'models/cube.glb', material: 'material/steel' });
    const cam = w.spawn('camera');
    cam.position.set(0, 1.6, 7);
    cam.add(Camera, { fov: 45 });
  },
});

const game = await startGame(def, { seed: 1 });
const view = mountRender(game, document.getElementById('app')!, { backend: (params.get('backend') as 'webgl2' | 'webgpu' | null) ?? 'webgl2' });
const arm = game.world.find('arm')!.get(Animator)!;
game.paused = true;
// The page can be driven by its address alone: ?wave=1&steps=40 asks for the wave and runs 40 fixed steps before the first look.
if (params.get('wave') === '1') arm.set('waving', true);
game.step(Number(params.get('steps') ?? 0));
game.frame(0);
const hud = document.getElementById('hud')!;
game.onFrame(() => { hud.textContent = `t ${game.world.time.toFixed(2)} s  ${view.backend}  state ${arm.stateOf()}  elbow ${arm.bone('forearmL')!.quaternion.toArray().map((v) => v.toFixed(2)).join(' ')}  wave weight ${(arm.weights().wave ?? 0).toFixed(2)}\n${arm.problems.join('\n')}`; });
Object.assign(globalThis, {
  hull: {
    game, view, arm,
    wave(on: boolean) { arm.set('waving', on); },
    step(n: number) { game.step(n); game.frame(0); },
    stats: () => view.stats(),
    elbow: () => arm.bone('forearmL')!.quaternion.toArray(),
  },
});
