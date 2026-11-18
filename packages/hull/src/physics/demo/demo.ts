// A ball rolls through a box city. Colliders are drawn as lines (debugShapes), the ball and a few debris
// boxes are rigid bodies, and a raycast from the camera-side shows a hit marker. `?steps=N` runs N fixed steps
// first, so a screenshot is taken at a known game time. The simulation runs on game.step, never on real time.
import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, SphereGeometry, WebGLRenderer } from 'three';
import { defineGame, startGame } from '../../core/index.ts';
import { Body, debugShapes, usePhysics } from '../index.ts';
import type { Physics } from '../index.ts';

const params = new URLSearchParams(location.search);
const preSteps = Number(params.get('steps') ?? '0');

let phys!: Physics;
const game = await startGame(defineGame({
  ready(g) {
    phys = usePhysics(g.world);
    phys.addGround(0);
    // A deterministic city: a grid of blocks of varied height with streets between.
    let s = 99;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let gx = -4; gx <= 4; gx++) {
      for (let gz = -2; gz <= 8; gz++) {
        if (gz === 0 || gx === 0) continue; // streets
        const h = 3 + rnd() * 14;
        const w = 6 + rnd() * 3, d = 6 + rnd() * 3;
        phys.addBox({ x: gx * 14, y: h / 2, z: gz * 14 }, { x: w, y: h, z: d });
      }
    }
    // A ball set rolling down the z street, and some crates dropped in front of it.
    const ball = g.world.spawn('ball');
    ball.position.set(0.5, 1, -26);
    ball.add(Body, { shape: { type: 'sphere', radius: 1 }, mass: 4, restitution: 0.35, friction: 0.6 }).setVelocity(0, 0, 14);
    for (let i = 0; i < 8; i++) {
      const c = g.world.spawn(`crate${i}`);
      c.position.set(-1.5 + (i % 4) * 1.1, 0.6 + Math.floor(i / 4) * 1.1, 8 + (i % 3));
      c.add(Body, { shape: { type: 'box', size: [0.9, 0.9, 0.9] }, mass: 1 });
    }
  },
}), { seed: 1, stepRate: 60 });

const el = document.getElementById('view')!;
const hud = document.getElementById('hud')!;
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
el.appendChild(renderer.domElement);
const scene = new Scene();
scene.background = new Color(0x10131a);
const camera = new PerspectiveCamera(55, 1, 0.1, 400);

// Debug lines: a growing buffer refilled every frame.
let pos = new Float32Array(3 * 2 * 4096);
let col = new Float32Array(3 * 2 * 4096);
let count = 0;
const geo = new BufferGeometry();
const lines = new LineSegments(geo, new LineBasicMaterial({ vertexColors: true }));
lines.frustumCulled = false;
scene.add(lines);
const tint = new Color();
function line(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, c: number): void {
  if ((count + 1) * 6 > pos.length) {
    const np = new Float32Array(pos.length * 2); np.set(pos); pos = np;
    const nc = new Float32Array(col.length * 2); nc.set(col); col = nc;
  }
  tint.setHex(c);
  const o = count * 6;
  pos[o] = a.x; pos[o + 1] = a.y; pos[o + 2] = a.z; pos[o + 3] = b.x; pos[o + 4] = b.y; pos[o + 5] = b.z;
  col[o] = tint.r; col[o + 1] = tint.g; col[o + 2] = tint.b; col[o + 3] = tint.r; col[o + 4] = tint.g; col[o + 5] = tint.b;
  count++;
}

const marker = new Mesh(new SphereGeometry(0.4, 12, 8), new MeshBasicMaterial({ color: 0xff4d6d }));
scene.add(marker);
const ballMesh = new Mesh(new SphereGeometry(1, 24, 16), new MeshBasicMaterial({ color: 0xf0a43a, wireframe: true }));
scene.add(ballMesh);

function draw(): void {
  const ball = game.world.find('ball')!;
  count = 0;
  debugShapes(phys, line, ball.position, 90);
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('color', new BufferAttribute(col, 3));
  geo.setDrawRange(0, count * 2);
  ballMesh.position.copy(ball.position);
  ballMesh.quaternion.copy(ball.object3d.quaternion);
  // A ray from above and behind the ball, down at it: where does it land?
  const from = { x: ball.position.x + 6, y: 30, z: ball.position.z - 12 };
  const dir = { x: ball.position.x - from.x, y: ball.position.y - from.y, z: ball.position.z - from.z };
  const h = phys.raycast(from, dir, 200, { ignoreNode: null });
  if (h) marker.position.set(h.x, h.y, h.z);
  marker.visible = h !== null;
  camera.position.set(ball.position.x + 16, 22, ball.position.z - 26);
  camera.lookAt(ball.position.x - 4, 2, ball.position.z + 14);
  const w = el.clientWidth, hh = el.clientHeight;
  renderer.setSize(w, hh, false);
  camera.aspect = w / hh;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const b = ball.get(Body)!.rb;
  hud.textContent = `tick ${game.world.tick}  shapes ${phys.shapeCount}  lines ${count}\nball z ${ball.position.z.toFixed(1)}  speed ${Math.hypot(b.vx, b.vy, b.vz).toFixed(1)} m/s\nchecksum ${game.world.checksum()}\nray hit ${h ? h.distance.toFixed(2) + ' m' : 'none'}`;
}

game.step(preSteps);
draw();
(window as unknown as { hull: object }).hull = { game, phys, draw };
if (params.get('run') !== '0') {
  let last = performance.now();
  const loop = (t: number) => {
    game.frame((t - last) / 1000);
    last = t;
    draw();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
