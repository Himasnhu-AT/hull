import { describe, expect, it } from 'vitest';
import { createRegistry } from '../src/config/index.ts';
import { startGame, type Game } from '../src/core/index.ts';
import { InputCore, compileMap, wireInput, type StepSnapshot } from '../src/input/index.ts';
import type { InputMap } from '../src/schema/index.ts';

const MAP: InputMap = {
  kind: 'input-map',
  actions: {
    jump: { type: 'button', keys: ['Space', 'J'], pad: 'south' },
    fire: { type: 'button', keys: ['Mouse0'], pad: 'triggerR' },
    move: { type: 'axis2', keys: { up: ['W'], down: ['S'], left: ['A'], right: ['D'] }, pad: 'stickL' },
    look: { type: 'axis2', mouse: 'delta', pad: 'stickR', sensitivity: 2 },
    zoom: { type: 'axis', mouse: 'wheel' },
    pause: { type: 'button', keys: ['Escape'], rebind: false },
  },
  groups: { Move: ['move', 'jump'] },
};

interface Rig { game: Game; core: InputCore; log: string[]; moves: string[]; frame(steps: number): void }

// A game with a probe system that writes what each fixed step saw, driven only by game.frame (no real time).
async function rig(map: InputMap = MAP): Promise<Rig> {
  const game = await startGame({ ready: () => {} }, { stepRate: 60 });
  const core = new InputCore(() => game.world.tick);
  core.setMap(map, 'input-map/test');
  wireInput(game, core);
  const log: string[] = [];
  const moves: string[] = [];
  game.world.system('probe', {
    fixedUpdate() {
      const m = core.action('move');
      moves.push(`${m.x.toFixed(3)},${m.y.toFixed(3)}`);
      const j = core.action('jump');
      const l = core.action('look');
      log.push(`${game.world.tick}:${j.down ? 'D' : '-'}${j.pressed ? 'P' : '-'}${j.released ? 'R' : '-'} look=${l.x},${l.y}`);
    },
  });
  return { game, core, log, moves, frame: (n) => game.frame(n / 60) };
}

describe('edges are never lost', () => {
  it('1 step per frame: pressed is seen by that step only', async () => {
    const r = await rig();
    r.core.keyDown('Space');
    r.frame(1);
    r.frame(1);
    r.core.keyUp('Space');
    r.frame(1);
    r.frame(1);
    expect(r.log).toEqual(['1:DP- look=0,0', '2:D-- look=0,0', '3:--R look=0,0', '4:--- look=0,0']);
  });

  it('3 steps per frame: the first step sees the edge, the others see the held state', async () => {
    const r = await rig();
    r.core.keyDown('Space');
    r.frame(3);
    r.core.keyUp('Space');
    r.frame(3);
    expect(r.log).toEqual([
      '1:DP- look=0,0', '2:D-- look=0,0', '3:D-- look=0,0',
      '4:--R look=0,0', '5:--- look=0,0', '6:--- look=0,0',
    ]);
  });

  it('0 steps in a frame: the press waits for the next step, and so does a later release', async () => {
    const r = await rig();
    r.core.keyDown('Space');
    r.frame(0);
    r.frame(0);
    r.core.keyUp('Space');
    r.frame(0);
    expect(r.log).toEqual([]);
    r.frame(1);
    // Pressed and released both happened before any step ran: the step sees both, and a down for that step.
    expect(r.log).toEqual(['1:DPR look=0,0']);
    r.frame(1);
    expect(r.log[1]).toBe('2:--- look=0,0');
  });

  it('a tap that starts and ends between two samples still gives pressed and released', async () => {
    const r = await rig();
    r.core.keyDown('KeyJ');
    r.core.keyUp('KeyJ');
    r.frame(1);
    expect(r.log).toEqual(['1:DPR look=0,0']);
  });

  it('two keys on one action: the second does not give a second press, and the action stays down', async () => {
    const r = await rig();
    r.core.keyDown('Space');
    r.frame(1);
    r.core.keyDown('KeyJ');
    r.frame(1);
    r.core.keyUp('Space');
    r.frame(1);
    r.core.keyUp('KeyJ');
    r.frame(1);
    expect(r.log.map((l) => l.slice(2, 5))).toEqual(['DP-', 'D--', 'D--', '--R']);
  });

  it('frame-level readers keep the edge after several steps ran', async () => {
    const r = await rig();
    r.core.keyDown('Space');
    r.frame(3);
    const j = r.core.action('jump');
    expect(j.pressed).toBe(false);
    expect(j.framePressed).toBe(true);
    r.frame(1);
    expect(j.framePressed).toBe(false);
  });

  it('game.step(n) samples too', async () => {
    const r = await rig();
    r.core.keyDown('Space');
    r.game.step(2);
    expect(r.log).toEqual(['1:DP- look=0,0', '2:D-- look=0,0']);
  });
});

describe('mouse look and wheel', () => {
  it('movement is consumed by the first step after the frame and none is lost over empty frames', async () => {
    const r = await rig();
    r.core.mouseMove(3, 1);
    r.frame(0);
    r.core.mouseMove(2, 0);
    r.frame(3);
    r.frame(1);
    // sensitivity 2: (3+2)*2 and 1*2 arrive at step 1; nothing after.
    expect(r.log.map((l) => l.split(' ')[1])).toEqual(['look=10,2', 'look=0,0', 'look=0,0', 'look=0,0']);
  });

  it('wheel is an axis and a tap source', async () => {
    const r = await rig();
    r.core.wheel(100);
    r.core.wheel(100);
    r.frame(1);
    expect(r.core.action('zoom').value).toBe(2);
    r.frame(1);
    expect(r.core.action('zoom').value).toBe(0);
  });
});

describe('axes and the gamepad', () => {
  it('keyboard diagonal has length 1; up is negative y', async () => {
    const r = await rig();
    r.core.keyDown('KeyW');
    r.core.keyDown('KeyD');
    r.frame(1);
    const out = { x: 0, y: 0 };
    r.core.vec2('move', out);
    expect(out.x).toBeCloseTo(Math.SQRT1_2);
    expect(out.y).toBeCloseTo(-Math.SQRT1_2);
  });

  it('stick inside the dead zone reads zero, outside it is rescaled', async () => {
    const r = await rig();
    r.core.setPad([], [0.1, 0.05, 0, 0]);
    r.frame(1);
    expect(r.core.action('move').value).toBe(0);
    r.core.setPad([], [1, 0, 0, 0]);
    r.frame(1);
    expect(r.core.action('move').x).toBeCloseTo(1);
    r.core.setPad([], [0.575, 0, 0, 0]);
    r.frame(1);
    expect(r.core.action('move').x).toBeCloseTo(0.5);
  });

  it('a pad button is a press once, and a trigger is analog', async () => {
    const r = await rig();
    const b = new Array<number>(17).fill(0);
    b[0] = 1;
    r.core.setPad(b, [0, 0, 0, 0]);
    r.frame(1);
    r.core.setPad(b, [0, 0, 0, 0]);
    r.frame(1);
    expect(r.log.map((l) => l.slice(2, 5))).toEqual(['DP-', 'D--']);
    b[0] = 0;
    b[7] = 0.8;
    r.core.setPad(b, [0, 0, 0, 0]);
    r.frame(1);
    expect(r.core.action('fire').value).toBeCloseTo(0.8);
  });

  it('losing focus releases everything', async () => {
    const r = await rig();
    r.core.keyDown('Space');
    r.frame(1);
    r.core.releaseAll();
    r.frame(1);
    expect(r.log.map((l) => l.slice(2, 5))).toEqual(['DP-', '--R']);
  });
});

describe('record and play', () => {
  const script = (r: Rig, i: number): void => {
    if (i === 0) r.core.keyDown('Space');
    if (i === 1) { r.core.mouseMove(4, -2); r.core.keyUp('Space'); }
    if (i === 3) { r.core.keyDown('KeyW'); r.core.mouseMove(1, 1); }
    if (i === 5) r.core.keyUp('KeyW');
  };
  const frames = [1, 3, 0, 2, 1, 2, 1];

  it('replays what every step saw, whatever the frame sizes', async () => {
    const live = await rig();
    const rec = live.core.record();
    frames.forEach((n, i) => { script(live, i); live.frame(n); });
    const list = rec.stop();
    expect(list).toHaveLength(frames.reduce((a, b) => a + b, 0));
    expect(list[0]).toEqual({ jump: { d: 1, p: 1 } });

    const wire: StepSnapshot[] = JSON.parse(JSON.stringify(list));
    const replay = await rig();
    const player = replay.core.play(wire);
    // Different frame sizes on purpose: determinism is per step, not per frame.
    for (let i = 0; i < list.length; i++) replay.frame(1);
    expect(replay.log).toEqual(live.log);
    expect(replay.moves).toEqual(live.moves);
    expect(live.moves.some((m) => m !== '0.000,0.000')).toBe(true);
    expect(player.done).toBe(true);
  });

  it('play ignores the real devices', async () => {
    const r = await rig();
    r.core.play([{}, { jump: { d: 1, p: 1 } }]);
    r.core.keyDown('Space');
    r.frame(1);
    r.frame(1);
    r.frame(1);
    expect(r.log.map((l) => l.slice(2, 5))).toEqual(['---', 'DP-', '---']);
  });
});

describe('the map', () => {
  it('reports bad sources with their place and keeps working', () => {
    const c = compileMap({ kind: 'input-map', actions: { a: { type: 'button', keys: ['W', 'wat?'] }, m: { type: 'axis2', keys: ['W'] } } }, 'input-map/x');
    expect(c.problems).toEqual([
      'input-map/x#/actions/a/keys/1: "wat?" is not a key, mouse button or gamepad button name',
      'input-map/x#/actions/m/keys: a axis2 needs { up, down, left, right }, not a list',
    ]);
    expect(c.actions[0]!.slots['main']).toEqual(['KeyW']);
  });

  it('rebinding changes the sources, respects rebind:false and survives a live map change', async () => {
    const r = await rig();
    expect(r.core.rebind('jump', 'main', 0, 'K')).toEqual([]);
    expect(r.core.bindings().find((b) => b.action === 'jump')!.sources).toEqual(['KeyK', 'KeyJ', 'pad:south']);
    expect(r.core.rebind('fire', 'main', 0, 'K')).toEqual(['jump']);
    expect(() => r.core.rebind('pause', 'main', 0, 'P')).toThrow(/rebind/);
    const saved = JSON.parse(JSON.stringify(r.core.overrides()));
    r.core.setMap({ ...MAP, note: 'edited' }, 'input-map/test');
    expect(r.core.bindings().find((b) => b.action === 'jump')!.sources[0]).toBe('KeyK');
    r.core.resetBindings();
    expect(r.core.bindings().find((b) => b.action === 'jump')!.sources[0]).toBe('Space');
    r.core.setOverrides(saved);
    r.core.keyDown('KeyK');
    r.frame(1);
    expect(r.log[0]).toMatch(/DP-/);
  });

  it('capture resolves with the next key and cancels on Escape', async () => {
    const r = await rig();
    const p = r.core.capture();
    r.core.keyDown('KeyZ');
    await expect(p).resolves.toBe('KeyZ');
    const q = r.core.capture();
    r.core.keyDown('Escape');
    await expect(q).resolves.toBeNull();
    r.core.keyUp('KeyZ');
    r.core.keyUp('Escape');
  });

  it('an action asked for before the map loads is the same object afterwards', async () => {
    const game = await startGame({ ready: () => {} });
    const core = new InputCore(() => game.world.tick);
    wireInput(game, core);
    const a = core.action('jump');
    expect(a.down).toBe(false);
    core.setMap(MAP);
    core.keyDown('Space');
    game.step();
    expect(core.action('jump')).toBe(a);
    expect(a.down).toBe(true);
    expect(core.missing()).toEqual([]);
    core.action('typo');
    expect(core.missing()).toEqual(['typo']);
  });
});

describe('input-map and ui-theme schemas', () => {
  const load = (kind: string, id: string, body: unknown) =>
    createRegistry().load([{ path: `config/${kind}/${id}.json`, text: JSON.stringify(body, null, 2) }]);

  it('accepts the SCHEMAS.md example', () => {
    const res = load('input-map', 'play', {
      kind: 'input-map',
      actions: {
        move: { type: 'axis2', keys: { up: ['W', 'ArrowUp'], down: ['S'], left: ['A'], right: ['D'] }, pad: 'stickL' },
        look: { type: 'axis2', mouse: 'delta', pad: 'stickR' },
        jump: { type: 'button', keys: ['Space'], pad: 'south' },
        pause: { type: 'button', keys: ['Escape', 'P'], pad: 'start', rebind: false },
      },
      groups: { Move: ['move', 'jump'], Other: ['pause'] },
    });
    expect(res.problems).toEqual([]);
  });

  it('names the place of an input-map mistake', () => {
    const res = load('input-map', 'play', { kind: 'input-map', actions: { jump: { type: 'trigger', keys: ['Space'], deadzone: 2 } } });
    expect(res.ok).toBe(false);
    expect(res.problems.map((p) => p.pointer)).toEqual(expect.arrayContaining(['/actions/jump/type', '/actions/jump/deadzone']));
  });

  it('validates ui-theme colours and ranges', () => {
    const good = { kind: 'ui-theme', color: { panel: '#0e1012', accent: '#f0a43a' }, type: { family: 'system-ui', size: 14, labelTracking: 0.2 }, space: { gutter: 20, radius: 2 } };
    expect(load('ui-theme', 'dark', good).problems).toEqual([]);
    const bad = load('ui-theme', 'dark', { kind: 'ui-theme', color: { panel: 'red' }, type: { size: 2 } });
    expect(bad.problems.map((p) => p.pointer).sort()).toEqual(['/color/panel', '/type/size']);
  });

  it('accepts a ui-screen', () => {
    const res = load('ui-screen', 'pause', {
      kind: 'ui-screen',
      pausesGame: true,
      root: {
        panel: { align: 'center', width: 420 },
        children: [{ button: { text: 'Resume', primary: true }, on: { press: 'game.resume' } }],
      },
      states: { 'with-save': { mock: { 'save.exists': true } } },
    });
    expect(res.problems).toEqual([]);
  });
});
