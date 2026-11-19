/// <reference types="node" />
// The modelled bodies build headless (no GL), fit their characters' sockets, replace the rigid stand-in and stay inside a
// draw-call budget for a crowd of eight.
import { fileURLToPath } from 'node:url';
import * as THREE from 'hull/three';
import { config, defineGame, type Node } from 'hull';
import { Animator } from 'hull/anim';
import { projectSources, runScenario } from 'hull/kits/testing';
import { describe, expect, it } from 'vitest';
import { Dress, KINDS, type Kind } from './index';

const sources = projectSources(fileURLToPath(new URL('../..', import.meta.url)));

/** Where each held thing ends along -Y of its hand, per the character config's own sockets. */
const REACH: Record<Kind, { bone: string; tip: number }> = {
  aya: { bone: 'handR', tip: -0.91 },
  ashblade: { bone: 'handR', tip: -0.96 },
  ashpike: { bone: 'handR', tip: -1.4 },
  hulk: { bone: 'handR', tip: -1.44 },
  ashkite: { bone: 'handL', tip: -0.82 }, // the arrow rests 0.1 below the hand, its head 0.72 further
  kagari: { bone: 'handR', tip: -1.3 },
};

const drawn = (root: THREE.Object3D): { meshes: number; standIns: number; mine: number } => {
  let meshes = 0, standIns = 0, mine = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.userData['ironleafBody']) { mine++; meshes++; } else if (m.visible) { standIns++; meshes++; }
  });
  return { meshes, standIns, mine };
};

describe('Ironleaf models', () => {
  it('dresses every kind: stand-in hidden, parts on the bones, the weapon ends where its socket says, a crowd of 8 stays cheap', async () => {
    const nodes = new Map<Kind, Node>();
    const def = defineGame({
      stepRate: 60,
      ready(game) {
        let i = 0;
        for (const k of KINDS) {
          const n = game.world.spawn('c-' + k);
          n.position.x = i++ * 2;
          const m = game.world.spawn('model', n);
          m.add(Animator, { character: 'character/' + k });
          m.add(Dress, { kind: k });
          nodes.set(k, n);
        }
      },
    });
    const run = await runScenario({ def, sources, inputMap: 'ironleaf', steps: 4, input: () => ({}) });
    const report: string[] = [];
    let crowd = 0;
    for (const k of KINDS) {
      const model = nodes.get(k)!.children.find((c) => c.name === 'model')!;
      const dress = model.get(Dress)!;
      const body = dress.current;
      expect(body, k).toBeTruthy();
      const d = drawn(model.object3d);
      expect(d.standIns, k + ' stand-in still visible').toBe(0);
      expect(d.mine, k).toBeGreaterThan(20);
      report.push(k + ' ' + d.mine);
      if (k !== 'aya' && k !== 'kagari') crowd += d.mine; // the Band: the same four kinds twice is the 8-strong camp
      // The held thing ends at the socket's reach, in its hand's space.
      const a = model.get(Animator)!;
      const hand = a.bone(REACH[k].bone)!;
      const box = new THREE.Box3();
      hand.updateWorldMatrix(true, true);
      const inv = new THREE.Matrix4().copy(hand.matrixWorld).invert();
      body!.sword.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.updateWorldMatrix(true, false);
        const g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
        g.computeBoundingBox();
        box.union(g.boundingBox!);
      });
      // The bow is held across the hand, so only the arrow (along -Y) is measured for the archer.
      if (k === 'ashkite') {
        const arrow = hand.children.find((c) => c.name === 'arrow')!;
        const ab = new THREE.Box3().setFromObject(arrow).applyMatrix4(inv);
        expect(ab.min.y).toBeLessThan(REACH[k].tip + 0.05);
        expect(ab.min.y).toBeGreaterThan(REACH[k].tip - 0.05);
      } else {
        expect(box.min.y, k + ' reach').toBeLessThan(REACH[k].tip + 0.03);
        expect(box.min.y, k + ' reach').toBeGreaterThan(REACH[k].tip - 0.1);
      }
    }
    // Eight enemies: 2 of each of the four kinds, plus Aya and Kagari's own cost would be one each.
    const eight = crowd * 2;
    console.log('ironleaf models, parts per body: ' + report.join(', ') + '; 8 enemies draw ' + eight + ' meshes (before the shadow pass)');
    expect(eight).toBeLessThan(900);
    // Aya's sword goes to the scabbard and back.
    const aya = nodes.get('aya')!.children.find((c) => c.name === 'model')!.get(Dress)!;
    const sword = aya.current!.sword;
    const hand = aya.node.get(Animator)!.bone('handR')!;
    expect(sword.parent).toBe(hand);
    aya.sheathed = true;
    run.rig.g.step?.();
    aya.update();
    expect(sword.parent).toBe(aya.node.get(Animator)!.bone('hips'));
    aya.sheathed = false;
    aya.update();
    expect(sword.parent).toBe(hand);
    run.rig.g.dispose();
  }, 60000);

  it('every spring chain (ponytails, sashes, scarf, banner, cape, coat panels) swings when its body moves and settles after', async () => {
    const nodes = new Map<Kind, Node>();
    const def = defineGame({
      stepRate: 60,
      ready(game) {
        let i = 0;
        for (const k of KINDS) {
          const n = game.world.spawn('c-' + k);
          n.position.x = i++ * 3;
          const m = game.world.spawn('model', n);
          m.add(Animator, { character: 'character/' + k });
          m.add(Dress, { kind: k });
          nodes.set(k, n);
        }
      },
    });
    const run = await runScenario({ def, sources, inputMap: 'ironleaf', steps: 2, input: () => ({}) });
    const g = run.rig.g;
    for (const k of KINDS) {
      const model = nodes.get(k)!.children.find((c) => c.name === 'model')!;
      const a = model.get(Animator)!;
      const graph = config.lookup('anim-graph', k) as unknown as { springs: Record<string, { chain: string[] }> };
      const mids = Object.entries(graph.springs).map(([name, s]) => ({ name, bone: s.chain[1] ?? s.chain[0]! }));
      expect(mids.length, k + ' has springs').toBeGreaterThan(0);
      const lean = (b: string): number => { const q = a.bone(b)!.quaternion; return Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z); };
      for (let i = 0; i < 60; i++) { g.step(1); a.render(1, 1 / 60); }
      const rest = mids.map((m) => lean(m.bone));
      const peak = mids.map(() => 0);
      // Run along x for a third of a second, then stop dead: the chains lag behind and then catch up.
      const n = nodes.get(k)!;
      for (let i = 0; i < 20; i++) { n.position.x += 0.12; g.step(1); a.render(1, 1 / 60); mids.forEach((m, j) => { peak[j] = Math.max(peak[j]!, lean(m.bone)); }); }
      for (let i = 0; i < 12; i++) { g.step(1); a.render(1, 1 / 60); mids.forEach((m, j) => { peak[j] = Math.max(peak[j]!, lean(m.bone)); }); }
      mids.forEach((m, j) => expect(peak[j]! - rest[j]!, k + ' ' + m.name + ' swings').toBeGreaterThan(0.01));
      for (let i = 0; i < 300; i++) { g.step(1); a.render(1, 1 / 60); }
      mids.forEach((m, j) => expect(Math.abs(lean(m.bone) - rest[j]!), k + ' ' + m.name + ' settles').toBeLessThan(0.02));
    }
    g.dispose();
  }, 60000);
});
