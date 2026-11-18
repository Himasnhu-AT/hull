/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { config, startGame, defineGame } from '../index.ts';
import { lookSchema } from '../schema/look.ts';
import { Camera, Light, Mesh, activeCamera, instances } from './behaviours.ts';
import { Interp, lerp, stateFor, teleported } from './interp.ts';
import { defaultLook, resolveLook, sunDirection } from './look.ts';
import { acquireMaterial, cacheSizes, materialKey, materialParams, releaseMaterial } from './materials.ts';
import { validateAgainst } from '../config/validate.ts';

describe('look', () => {
  it('has a schema that accepts SCHEMAS.md section 9 and rejects strays', () => {
    const ok = {
      kind: 'look',
      sun: { color: '#ffeddb', strength: 3.2, elevationDeg: 48, azimuthDeg: 210, shadows: true },
      sky: { horizon: '#a9c6dc', mid: '#8fb2d6', zenith: '#3d6aa8' },
      fog: { color: '#a9c6dc', near: 140, far: 1500 },
      exposure: 1.0,
      post: { bloom: 0.6, contrast: 1.07, saturation: 1.1, vignette: 0.22, grain: 0.02, speedBlur: 0.085 },
    };
    expect(validateAgainst(lookSchema, ok)).toEqual([]);
    expect(validateAgainst(lookSchema, { ...ok, fog: { color: 'red' } }).length).toBeGreaterThan(0);
    expect(validateAgainst(lookSchema, { ...ok, sunn: {} }).length).toBeGreaterThan(0);
  });

  it('points the sun by compass bearing and elevation', () => {
    const [x, y, z] = sunDirection(0, 0);
    expect([x, y, z].map((n) => Math.round(n * 1000) / 1000)).toEqual([0, 0, -1]);
    const east = sunDirection(0, 90);
    expect(east[0]).toBeCloseTo(1);
    expect(sunDirection(90, 0)[1]).toBeCloseTo(1);
    const d = sunDirection(48, 210);
    expect(Math.hypot(...d)).toBeCloseTo(1);
  });

  it('fills gaps from the default and chooses flat or gradient sky', () => {
    const none = resolveLook(undefined);
    expect(none.skyColor).toBe('#14161b');
    expect(none.fog).toBeNull();
    expect(none.ambient.intensity).toBe(0.6);
    expect(none.sun.intensity).toBe(2.2);
    // The default sun is the M0 rig's (3, 5, 4) direction.
    const m0 = [3, 5, 4].map((n) => n / Math.hypot(3, 5, 4));
    none.sun.dir.forEach((n, i) => expect(n).toBeCloseTo(m0[i]!, 2));
    const grad = resolveLook({ kind: 'look', sky: { horizon: '#ffffff', zenith: '#000000' }, fog: { color: '#888888', density: 0.01 } });
    expect(grad.skyColor).toBeNull();
    expect(grad.mid).toBe('#ffffff');
    expect(grad.fog).toEqual({ color: '#888888', near: 0, far: 1000, density: 0.01, skyBlend: 0.35 });
    expect(defaultLook.kind).toBe('look');
  });
});

describe('materials', () => {
  it('keys by id, or by lower-cased colour', () => {
    expect(materialKey({ material: 'material/steel', color: '#fff' })).toBe('id:material/steel');
    expect(materialKey({ color: '#FFF000' })).toBe(materialKey({ color: '#fff000' }));
    expect(materialKey({})).toBe('color:#cccccc');
  });

  it('fills material defaults', () => {
    expect(materialParams({ color: '#123456' })).toEqual({ color: '#123456', roughness: 0.5, metalness: 0 });
    expect(materialParams({ color: '#123456', roughness: 0.1, metalness: 1 })).toEqual({ color: '#123456', roughness: 0.1, metalness: 1 });
  });

  it('shares one material per key and follows config changes live', () => {
    config.load([{ path: 'config/material/steel.json', text: '{ "kind": "material", "color": "#808080", "roughness": 0.3 }' }]);
    const a = acquireMaterial({ material: 'material/steel' });
    const b = acquireMaterial({ material: 'material/steel' });
    expect(a).toBe(b);
    expect(a.roughness).toBe(0.3);
    config.update({ path: 'config/material/steel.json', text: '{ "kind": "material", "color": "#ff0000", "roughness": 0.9, "metalness": 1 }' });
    expect(a.roughness).toBe(0.9);
    expect(a.metalness).toBe(1);
    expect(a.color.r).toBeCloseTo(1);
    releaseMaterial({ material: 'material/steel' });
    expect(cacheSizes().materials).toBe(1);
    releaseMaterial({ material: 'material/steel' });
    expect(cacheSizes().materials).toBe(0);
  });
});

describe('interpolation', () => {
  it('lerps', () => {
    expect(lerp(2, 6, 0.25)).toBe(3);
  });

  it('draws between the last two steps and puts the real transform back', async () => {
    const g = await startGame(defineGame({ ready() {} }));
    const n = g.world.spawn('n');
    const interp = new Interp();
    interp.track(n);
    interp.capture();
    n.position.x = 10;
    interp.capture();
    n.position.x = 20;
    interp.capture();
    interp.apply(0.5);
    expect(n.position.x).toBe(15);
    interp.restore();
    expect(n.position.x).toBe(20);
    interp.apply(0);
    expect(n.position.x).toBe(10);
    interp.restore();
    // Moved after the step (by update): left alone.
    n.position.x = 99;
    interp.apply(0.5);
    expect(n.position.x).toBe(99);
    interp.restore();
    expect(n.position.x).toBe(99);
  });

  it('does not glide a node that was placed after being tracked, or that teleported', async () => {
    const g = await startGame(defineGame({ ready() {} }));
    const n = g.world.spawn('n');
    n.add(Mesh);
    n.position.x = 5;
    g.step();
    const { interp } = stateFor(g.world);
    interp.apply(0.5);
    expect(n.position.x).toBe(5);
    interp.restore();
    n.position.x = 50;
    teleported(n);
    g.step();
    interp.apply(0.5);
    expect(n.position.x).toBe(50);
    interp.restore();
    g.dispose();
  });

  it('does not change the simulation checksum', async () => {
    const g = await startGame(defineGame({ ready(game) { game.world.spawn('a').add(Mesh); } }));
    const a = g.world.find('a')!;
    g.step();
    a.position.x = 3;
    g.step();
    const sum = g.world.checksum();
    stateFor(g.world).interp.apply(0.37);
    stateFor(g.world).interp.restore();
    expect(g.world.checksum()).toBe(sum);
    g.dispose();
  });
});

describe('behaviours without a renderer', () => {
  it('builds in Node, shares geometry, picks the first active camera and counts suns', async () => {
    const g = await startGame(defineGame({ ready() {} }));
    const root = g.world.root;
    for (let i = 0; i < 100; i++) g.world.spawn(`b${i}`).add(Mesh, { shape: 'box', color: '#ff0000' });
    expect(cacheSizes()).toEqual({ materials: 1, geometries: 1 });
    const off = g.world.spawn('off');
    off.add(Camera, { active: false });
    const on = g.world.spawn('on');
    on.add(Camera, { fov: 40 });
    expect(activeCamera(root)).toBe(on);
    const sun = g.world.spawn('sun').add(Light, { type: 'sun', castShadow: true });
    expect(stateFor(g.world).suns).toBe(1);
    sun.node.destroy();
    g.step();
    expect(stateFor(g.world).suns).toBe(0);
    g.dispose();
    expect(cacheSizes()).toEqual({ materials: 0, geometries: 0 });
  });

  it('changes colour live and swaps the shared material', async () => {
    const g = await startGame(defineGame({ ready() {} }));
    const m = g.world.spawn('m').add(Mesh, { color: '#ff0000' });
    m.color = '#00ff00';
    g.world.update(0, 0);
    expect(cacheSizes().materials).toBe(1);
    g.dispose();
  });

  it('instances write matrices without a renderer', async () => {
    const g = await startGame(defineGame({ ready() {} }));
    const inst = instances(g.world.root, { shape: 'box', color: '#00ff00', max: 1000 });
    inst.count = 1000;
    for (let i = 0; i < 1000; i++) inst.set(i, { x: i, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.5);
    expect(inst.count).toBe(1000);
    inst.count = 5000;
    expect(inst.count).toBe(1000);
    inst.dispose();
    g.dispose();
  });
});
