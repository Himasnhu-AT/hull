import { beforeEach, describe, expect, it } from 'vitest';
import { bool, choice, color, curve, listTunables, num, range, resetTunables, setTunable, tunables, vec } from '../src/config/index.ts';

beforeEach(() => resetTunables());

const make = () =>
  tunables('player', {
    runSpeed: num(12.5, { min: 0, max: 30, unit: 'm/s' }),
    jumpHeight: num(2.2, { min: 0.5, max: 8 }),
    doubleJump: bool(false),
    trail: color('#f0a43a'),
    pos: vec([0, 1, 2], { min: -10, max: 10 }),
    mode: choice('walk', ['walk', 'run'] as const),
    spread: range([1, 2], { min: 0, max: 5 }),
    ease: curve([[0, 0], [1, 1]]),
  });

describe('tunables', () => {
  it('reads current values through getters', () => {
    const p = make();
    expect(p.runSpeed).toBe(12.5);
    expect(p.mode).toBe('walk');
    expect(listTunables().map((t) => `${t.block}.${t.key}`)).toContain('player.trail');
    expect(Object.keys(p)).toContain('runSpeed');
  });

  it('sets a valid value and the getter sees it', () => {
    const p = make();
    expect(setTunable('player.runSpeed', 14)).toBeNull();
    expect(p.runSpeed).toBe(14);
    expect(setTunable('player.trail', '#112233')).toBeNull();
    expect(setTunable('player.pos', [1, 2, 3])).toBeNull();
    expect(setTunable('player.mode', 'run')).toBeNull();
    expect(setTunable('player.spread', [0, 3])).toBeNull();
    expect(setTunable('player.ease', [[0, 0], [0.5, 2], [1, 1]])).toBeNull();
    expect(p.pos).toEqual([1, 2, 3]);
    const info = listTunables().find((t) => t.key === 'runSpeed');
    expect(info).toMatchObject({ value: 14, initial: 12.5, kind: 'num' });
  });

  it('rejects bad values and keeps the old one', () => {
    const p = make();
    expect(setTunable('player.runSpeed', 99)).toMatchObject({ rule: 'tunable', pointer: '/player/runSpeed', message: 'runSpeed must be at most 30, got 99' });
    expect(setTunable('player.runSpeed', 'fast')).not.toBeNull();
    expect(setTunable('player.trail', 'red')).not.toBeNull();
    expect(setTunable('player.mode', 'fly')?.message).toBe('mode must be one of walk, run, got "fly"');
    expect(setTunable('player.pos', [1, 2])).not.toBeNull();
    expect(setTunable('player.spread', [3, 1])).not.toBeNull();
    expect(setTunable('player.ease', [[2, 0]])).not.toBeNull();
    expect(setTunable('player.nothing', 1)?.message).toBe('there is no tunable "player.nothing"');
    expect(p.runSpeed).toBe(12.5);
  });

  it('refuses a duplicate block name', () => {
    make();
    expect(() => make()).toThrow('declared twice');
  });
});
