/// <reference types="node" />
// The soldier's model builds from config/character/soldier.json and config/material/soldier-*.json: with the shipped files
// it is the body that was drawn before they existed (same vertices), and an edit of a file builds it again.
import { config } from 'hull';
import { projectSources } from 'hull/kits/testing';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PlayerModel, SOLDIER_DEFAULT, soldierRig } from './model.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

const positions = (m: PlayerModel): Float32Array => m.body.geometry.getAttribute('position').array as Float32Array;
const colors = (m: PlayerModel): Float32Array => m.body.geometry.getAttribute('color').array as Float32Array;

describe('soldier model from config', () => {
  it('is the same body with the shipped files as from the literals, and follows an edit', () => {
    const plain = new PlayerModel(null);
    const refPos = Float32Array.from(positions(plain)), refCol = Float32Array.from(colors(plain));
    const refArm = plain.j.armL.sh.position.toArray();
    plain.dispose();
    expect(refArm).toEqual([...SOLDIER_DEFAULT.shoulder]);

    const r = config.load(projectSources(root));
    expect(r.problems).toEqual([]);
    expect(soldierRig()).toEqual(SOLDIER_DEFAULT);
    const m = new PlayerModel(null);
    expect(Array.from(positions(m))).toEqual(Array.from(refPos));
    expect(Array.from(colors(m))).toEqual(Array.from(refCol));
    const body = m.body;

    // Widen the shoulders and recolour the jacket in the files; the next update builds a new body from them.
    const c = structuredClone(config.lookup('character', 'soldier'));
    c.body.bones!.find((b) => b.name === 'armL')!.offset = [-0.3, 0.405, 0];
    expect(config.update({ path: 'config/character/soldier.json', text: JSON.stringify(c) }).problems).toEqual([]);
    const mat = { ...config.lookup('material', 'soldier-jacket'), color: '#ff0000' };
    expect(config.update({ path: 'config/material/soldier-jacket.json', text: JSON.stringify(mat) }).problems).toEqual([]);
    m.update(1 / 120, { position: { x: 0, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 }, grounded: true } as never);
    expect(m.body).not.toBe(body);
    expect(m.j.armL.sh.position.x).toBeCloseTo(0.3, 6);
    expect(m.j.armR.sh.position.x).toBeCloseTo(-0.3, 6);
    expect(Array.from(colors(m))).not.toEqual(Array.from(refCol));
    m.dispose();
  });
});
