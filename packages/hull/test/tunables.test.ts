import { beforeEach, describe, expect, it } from 'vitest';
import { config, tuningIdOf, tuningProblems, bool, choice, color, curve, listTunables, num, range, resetTunables, setTunable, tunables, vec } from '../src/config/index.ts';

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
    expect(p.jumpHeight).toBe(2.2);
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

describe('tuning overrides (config/tuning/<block>.json)', () => {
  const file = (body: object) => ({ path: 'config/tuning/player.json', text: JSON.stringify({ kind: 'tuning', ...body }) });
  beforeEach(() => { config.load([]); });

  it('names the file after the block in kebab case', () => {
    expect(tuningIdOf('thirdPerson')).toBe('third-person');
    expect(tuningIdOf('player')).toBe('player');
  });

  it('takes values from the file for the keys it holds and keeps code values for the rest', () => {
    const p = make();
    config.update(file({ runSpeed: 20 }));
    expect(p.runSpeed).toBe(20);
    expect(p.jumpHeight).toBe(2.2);
    expect(listTunables().find((t) => t.key === 'runSpeed')!.initial).toBe(12.5);
  });

  it('applies a file that was loaded before the block was declared', () => {
    config.load([file({ runSpeed: 9 })]);
    const p = make();
    expect(p.runSpeed).toBe(9);
  });

  it('follows live changes, and a removed key or file goes back to the code value', () => {
    const p = make();
    config.update(file({ runSpeed: 20, jumpHeight: 3 }));
    config.update(file({ runSpeed: 21 }));
    expect([p.runSpeed, p.jumpHeight]).toEqual([21, 2.2]);
    config.remove('config/tuning/player.json');
    expect(p.runSpeed).toBe(12.5);
  });

  it('keeps the code value and names file#/key when a value is not allowed', () => {
    const p = make();
    config.update(file({ runSpeed: 99, jumpHeight: -1, nope: 1 }));
    expect(p.runSpeed).toBe(12.5);
    expect(p.jumpHeight).toBe(2.2);
    const probs = tuningProblems().map((x) => `${x.file}#${x.pointer}`);
    expect(probs).toEqual(expect.arrayContaining(['config/tuning/player.json#/runSpeed', 'config/tuning/player.json#/jumpHeight', 'config/tuning/player.json#/nope']));
  });
});
