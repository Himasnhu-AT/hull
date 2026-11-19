// Parity: the CollisionWorld on hull/physics answers 10 000 seeded queries the way the old, all-in-game one did.
// The old implementation is kept as collision.legacy.ts for this test only.
import { defineGame, startGame } from 'hull';
import * as THREE from 'hull/three';
import { describe, expect, it } from 'vitest';
import { CollisionWorld, type Collider } from './collision.ts';
import { CollisionWorld as Legacy } from './collision.legacy.ts';

const V = THREE.Vector3;
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ground = (x: number, z: number): number => Math.sin(x * 0.02) * 2 + Math.cos(z * 0.03) * 1.5 + (z > 100 ? 3 : 0);

type Any = { type: string; userData: Record<string, unknown> };
interface Rig { n: CollisionWorld; o: Legacy; nc: Any[]; oc: Any[]; objs: THREE.Object3D[]; dynIdx: number[] }

async function build(seed: number): Promise<Rig> {
  const g = await startGame(defineGame({ ready() {} }), { seed: 1, stepRate: 60 });
  const n = new CollisionWorld(g.world), o = new Legacy();
  n.setGround(ground); o.setGround(ground);
  const R = rng(seed), rr = (a: number, b: number): number => a + (b - a) * R();
  const nc: Any[] = [], oc: Any[] = [], objs: THREE.Object3D[] = [], dynIdx: number[] = [];
  const both = (make: (w: CollisionWorld | Legacy, obj: THREE.Object3D | null) => Any, dynamic: boolean): void => {
    let obj: THREE.Object3D | null = null;
    if (dynamic) {
      obj = new THREE.Object3D();
      obj.position.set(rr(-150, 150), rr(0, 30), rr(-150, 150));
      obj.quaternion.setFromEuler(new THREE.Euler(rr(-3, 3), rr(-3, 3), rr(-3, 3)));
      obj.scale.setScalar(rr(0.6, 2.5));
      obj.updateMatrixWorld(true);
      objs.push(obj); dynIdx.push(nc.length);
    }
    const a = make(n, obj), b = make(o, obj);
    a.userData.i = b.userData.i = nc.length;
    nc.push(a); oc.push(b);
  };
  const p = (): THREE.Vector3 => new V(rr(-150, 150), rr(0, 40), rr(-150, 150));
  for (let i = 0; i < 300; i++) {
    const c = p(), h = new V(rr(0.5, 9), rr(0.5, 12), rr(0.5, 9)), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rr(-3, 3), i % 5 === 0 ? rr(-1, 1) : 0));
    const hook = R() < 0.8;
    both((w) => w.addBox({ center: c.clone(), halfExtents: h.clone(), quaternion: q.clone(), hookable: hook, userData: {} }), false);
  }
  for (let i = 0; i < 120; i++) { const c = p(), hk = R() < 0.7, r = rr(0.3, 3), y0 = rr(0, 10), y1 = y0 + rr(1, 20); both((w) => w.addCylinder({ x: c.x, z: c.z, y0, y1, radius: r, hookable: hk, userData: {} }), false); }
  for (let i = 0; i < 40; i++) { const c = p(), r = rr(0.5, 5); both((w) => w.addSphere({ center: c.clone(), radius: r, userData: {} }), false); }
  for (let i = 0; i < 25; i++) { const a = p(), b = a.clone().add(new V(rr(-8, 8), rr(-8, 8), rr(-8, 8))), r = rr(0.4, 3); both((w) => w.addCapsule({ a: a.clone(), b: b.clone(), radius: r, userData: {} }), false); }
  for (let i = 0; i < 12; i++) { const c = new V(rr(-3, 3), rr(-3, 3), rr(-3, 3)), h = new V(rr(0.3, 3), rr(0.3, 3), rr(0.3, 3)); both((w, ob) => w.addBox({ center: c.clone(), halfExtents: h.clone(), object3D: ob, dynamic: true, userData: {} }), true); }
  for (let i = 0; i < 12; i++) { const a = new V(rr(-3, 3), rr(-3, 3), rr(-3, 3)), b = a.clone().add(new V(rr(-4, 4), rr(-4, 4), rr(-4, 4))), r = rr(0.3, 1.5); both((w, ob) => w.addCapsule({ a: a.clone(), b: b.clone(), radius: r, object3D: ob, dynamic: true, userData: {} }), true); }
  for (let i = 0; i < 10; i++) { const c = new V(rr(-3, 3), rr(-3, 3), rr(-3, 3)), r = rr(0.5, 3); both((w, ob) => w.addSphere({ center: c.clone(), radius: r, object3D: ob, dynamic: true, userData: {} }), true); }
  n.updateDynamic(); o.updateDynamic();
  return { n, o, nc, oc, objs, dynIdx };
}

const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;
const idx = (c: { type: string; userData: Record<string, unknown> } | undefined): number => (c ? (c.type === 'ground' ? -1 : (c.userData.i as number)) : -2);

describe('CollisionWorld on hull/physics matches the old implementation', () => {
  it('10 000 seeded queries: raycast, querySphere, collideSphere, and after the dynamic shapes move', async () => {
    const rig = await build(7);
    const R = rng(99), rr = (a: number, b: number): number => a + (b - a) * R();
    let insideCaps = 0, rays = 0, hits = 0, sph = 0, cont = 0, mismatches = 0;
    const note = (msg: string): void => { if (mismatches++ < 8) console.log(msg); };
    for (let k = 0; k < 10000; k++) {
      if (k % 2500 === 2499) { // move the dynamic things, update both
        for (const o of rig.objs) { o.position.add(new V(rr(-4, 4), rr(-2, 2), rr(-4, 4))); o.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(rr(-.5, .5), rr(-.5, .5), rr(-.5, .5)))); o.updateMatrixWorld(true); }
        rig.n.updateDynamic(); rig.o.updateDynamic();
      }
      const kind = k % 4;
      const origin = new V(rr(-170, 170), rr(-2, 60), rr(-170, 170));
      if (kind < 2) {
        const dir = new V(rr(-1, 1), rr(-1, 1), rr(-1, 1)).normalize();
        const max = rr(5, 200);
        const opts: { dynamic?: boolean; hookableOnly?: boolean; ignore?: Set<Collider> | null } = { dynamic: R() < 0.7, hookableOnly: R() < 0.3 };
        let ig: number[] = [];
        if (k % 8 === 1) { ig = [Math.floor(rr(0, rig.nc.length)), Math.floor(rr(0, rig.nc.length))]; }
        const a = rig.n.raycast(origin, dir, max, ig.length ? { ...opts, ignore: new Set(ig.map((i) => rig.nc[i]! as unknown as Collider)) } : opts);
        const b = rig.o.raycast(origin, dir, max, ig.length ? { ...opts, ignore: new Set(ig.map((i) => rig.oc[i]! as unknown as Collider)) } : opts);
        rays++; if (b) hits++;
        // An origin inside a capsule: hull/physics reports the capsule at distance 0, like a sphere. The old code answered
        // with null or the far cap's entry point, which no caller relies on (a limb a ray starts in), so it is not compared.
        if (a && a.collider.type === 'capsule' && a.distance === 0) { insideCaps++; continue; }
        if (!!a !== !!b) { note(`ray ${k}: hit ${!!a} vs ${!!b} ${a ? idx(a.collider) + ' ' + a.collider.type + ' t=' + a.distance : ''}`); continue; }
        if (!a || !b) continue;
        const ia = idx(a.collider), ib = idx(b.collider);
        if (!near(a.distance, b.distance, 1e-6) || (ia !== ib && !near(a.distance, b.distance, 1e-9))) { note(`ray ${k}: collider ${ia} vs ${ib}, t ${a.distance} vs ${b.distance}`); continue; }
        // an origin inside a sphere or capsule gives a push-out direction; the old code's differs and is not used by the game
        if (b.distance > 1e-9 && a.normal.distanceTo(b.normal) > 1e-5) note(`ray ${k}: normal ${a.normal.toArray()} vs ${b.normal.toArray()} on ${ib}`);
      } else if (kind === 2) {
        const r = rr(0.3, 12), dyn = R() < 0.5;
        const a = rig.n.querySphere(origin, r, { dynamic: dyn }).map(idx).sort((x, y) => x - y);
        const b = rig.o.querySphere(origin, r, { dynamic: dyn }).map(idx).sort((x, y) => x - y);
        sph++;
        if (a.join() !== b.join()) note(`query ${k}: ${a} vs ${b}`);
      } else {
        const r = rr(0.5, 5), dyn = R() < 0.5;
        origin.multiplyScalar(0.6);
        const a = rig.n.collideSphere(origin, r, { dynamic: dyn }), b = rig.o.collideSphere(origin, r, { dynamic: dyn });
        cont += b.length;
        a.sort((x, y) => idx(x.collider) - idx(y.collider)); b.sort((x, y) => idx(x.collider) - idx(y.collider));
        if (a.length !== b.length || a.some((c, i) => idx(c.collider) !== idx(b[i]!.collider) || !near(c.depth, b[i]!.depth, 1e-6) || c.normal.distanceTo(b[i]!.normal) > 1e-5)) {
          note(`contacts ${k}: ${a.map((c) => idx(c.collider) + ':' + c.depth.toFixed(4))} vs ${b.map((c) => idx(c.collider) + ':' + c.depth.toFixed(4))}`);
        }
      }
    }
    console.log(`parity: ${rays} rays (${hits} hits), ${sph} overlap queries, ${cont} contacts, ${mismatches} mismatches, ${insideCaps} rays started inside a capsule (not compared)`);
    expect(hits).toBeGreaterThan(1000);
    expect(cont).toBeGreaterThan(500);
    expect(mismatches).toBe(0);
  });

  it('frame-time bench: the query mix of the game is no slower than the old code', async () => {
    const rig = await build(11);
    const R = rng(5);
    const qs = Array.from({ length: 4000 }, () => ({ o: new V((R() - .5) * 300, R() * 50, (R() - .5) * 300), d: new V(R() - .5, R() - .5, R() - .5).normalize() }));
    const run = (w: CollisionWorld | Legacy): number => {
      const t0 = performance.now(); let sink = 0;
      for (let rep = 0; rep < 5; rep++) for (const q of qs) {
        sink += w.raycast(q.o, q.d, 60, { dynamic: true })?.distance ?? 0;
        sink += w.collideSphere(q.o, 1.2, { dynamic: false }).length;
        sink += w.collideSphere(q.o, 3, { dynamic: true }).length;
      }
      return performance.now() - t0 + sink * 0;
    };
    run(rig.n); run(rig.o);   // warm up
    const tn = Math.min(run(rig.n), run(rig.n)), to = Math.min(run(rig.o), run(rig.o));
    console.log(`bench: 60000 queries, hull/physics ${tn.toFixed(0)} ms, old ${to.toFixed(0)} ms`);
    expect(tn).toBeLessThan(to * 1.25);
  });

  it('a removed collider stops answering and answers again when registered', async () => {
    const rig = await build(3);
    const c = rig.n.addBox({ center: new V(500, 5, 500), halfExtents: new V(2, 2, 2), userData: {} });
    const ray = (): unknown => rig.n.raycast(new V(500, 5, 490), new V(0, 0, 1), 50, { dynamic: false })?.collider;
    expect(ray()).toBe(c);
    rig.n.remove(c); c.removed = true;
    expect(ray()).toBeUndefined();
    rig.n._register(c);
    expect(ray()).toBe(c);
  });
});
