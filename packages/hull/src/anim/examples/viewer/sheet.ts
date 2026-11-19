// A contact sheet of one clip: the character posed at evenly spaced times along a row, for judging a move at a glance.
// ?char=swordswoman&clip=light1&n=7&yaw=160&travel=1&dist=9&h=1.1 (yaw in degrees, 180 faces the camera; travel offsets each pose by root motion).
import { config, defineGame, startGame, type Game } from '../../../index.ts';
import { Camera, Light, Mesh, mountRender } from '../../../render/index.ts';
import { Animator } from '../../index.ts';
import { exampleSources } from '../load.ts';

const q = new URLSearchParams(location.search);
const charId = q.get('char') ?? 'swordswoman';
const clipName = q.get('clip') ?? 'idle';
const n = Number(q.get('n') ?? 7);
const yaw = (Number(q.get('yaw') ?? 160) * Math.PI) / 180;
const travel = q.get('travel') === '1';
const dist = Number(q.get('dist') ?? 9);
const height = Number(q.get('h') ?? 1.1);
const space = Number(q.get('space') ?? 1.4);

const anims: Animator[] = [];
const def = defineGame({
  ready(g: Game) {
    const w = g.world;
    w.spawn('ground').add(Mesh, { shape: 'plane', color: '#5d6b52', castShadow: false }).node.scale.set(60, 1, 60);
    const sun = w.spawn('sun');
    sun.rotation.set(-0.8, 0.4, 0);
    sun.add(Light, { type: 'sun', intensity: 2.6, castShadow: true, shadowSize: 20 });
    sun.add(Light, { type: 'ambient', intensity: 0.6, color: '#9db2d6' });
    for (let i = 0; i < n; i++) {
      const c = w.spawn(`c${i}`);
      c.rotation.y = yaw;
      const a = c.add(Animator, { character: charId });
      a.ground = () => 0;
      anims.push(a);
    }
    const cam = w.spawn('camera');
    cam.position.set(0, height, dist);
    cam.add(Camera, { fov: 32, far: 200 });
  },
});
config.load(exampleSources());
const game = await startGame(def, { seed: 1 });
const view = mountRender(game, document.getElementById('app')!, { backend: 'webgl2' });
game.paused = true;
const out = new Float64Array(4);
function pose(): void {
  anims.forEach((a, i) => {
    const c = a.clip(clipName);
    if (!c) return;
    const t = (i / Math.max(1, n - 1)) * c.length;
    a.previewClip(clipName, t);
    const node = a.node;
    let dx = 0, dz = 0;
    if (travel && c.root) { c.root.at(t, out); dx = out[0]!; dz = out[2]!; }
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    node.position.set((i - (n - 1) / 2) * space + dx * cs + dz * sn, 0, -dx * sn + dz * cs);
  });
  game.frame(0);
}
for (let i = 0; i < 6; i++) { game.step(1); pose(); }
Object.assign(globalThis, { sheet: { game, view, anims, pose, ready: true } });
void view;
