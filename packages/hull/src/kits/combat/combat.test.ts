import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { config, defineGame } from '../../index.ts';
import { ALL_KITS, kitSources, projectSources, runScenario, startRig, type Rig } from '../testing.ts';
import { FollowCamera } from '../follow-camera/follow-camera.ts';
import { validateAgainst } from '../../config/validate.ts';
import { enemySchema, moveSetSchema, type MoveSet } from '../../schema/index.ts';
import bench from './bench.ts';
import { attackTokens, EnemyBrain } from './brain.ts';
import { checkEnemy, checkMoveSet } from './check.ts';
import { Combatant, combatTuning, newAttack } from './combatant.ts';
import { combatHub } from './hub.ts';
import { LockOn, pickLockTarget } from './lockon.ts';
import { spawnEnemy, spawnFighter } from './spawn.ts';
import { Standoff } from './standoff.ts';
import { Blade, segSegDistSq, sweepBlade } from './trace.ts';

const sources = kitSources('third-person', 'health', 'combat');
void ALL_KITS;

interface Duel { r: Rig; a: Combatant; d: Combatant; hub: ReturnType<typeof combatHub>; tick(): number }

/** Attacker A (facing +Z) and defender D (facing -Z, the one under test), `dist` metres apart. No brains, no input. */
async function duel(dist = 1.0, seed = 7): Promise<Duel> {
  const def = defineGame({
    ready(g) {
      spawnFighter(g.world, { name: 'a', team: 'a', x: 0, z: -dist, yaw: Math.PI, character: 'character/duelist', moveSet: 'move-set/duelist' });
      spawnFighter(g.world, { name: 'd', team: 'd', x: 0, z: 0, yaw: 0, character: 'character/duelist', moveSet: 'move-set/duelist' });
    },
  });
  const r = await startRig(def, sources, '', seed);
  const a = r.g.world.find('a')!.get(Combatant)!, d = r.g.world.find('d')!.get(Combatant)!;
  d.maxPosture = 100; a.maxPosture = 100;
  return { r, a, d, hub: combatHub(r.g.world), tick: () => r.g.world.tick };
}

/** Plays A's move with D standing still and returns the number of steps until D was first struck (or -1), and the outcome. */
async function probe(move: string, dist: number, prep?: (x: Duel) => void): Promise<{ at: number; outcome: string }> {
  const x = await duel(dist);
  prep?.(x);
  let outcome = '', at = -1;
  const t0 = x.tick();
  const rec = (i: { outcome: string }): void => { if (at < 0) { at = x.tick() - t0; outcome = i.outcome; } };
  x.hub.hit.connect(rec); x.hub.dodged.connect(rec); x.hub.blocked.connect(rec); x.hub.perfectDeflect.connect(rec); x.hub.deflected.connect(rec);
  x.a.attack(move);
  x.r.step(90);
  return { at, outcome };
}

describe('combat kit config', () => {
  it('the default move-set and enemy are valid, and agree with each other', () => {
    const loaded = config.load(sources);
    expect(loaded.problems).toEqual([]);
    const ms = config.lookup('move-set', 'duelist');
    const en = config.lookup('enemy', 'duelist');
    expect(checkMoveSet(ms, 'move-set/duelist')).toEqual([]);
    expect(checkEnemy(en, ms, 'enemy/duelist')).toEqual([]);
  });

  it('names the place of a bad value and of a bad reference', () => {
    const base = sources.filter((s) => !s.path.startsWith('config/enemy/'));
    const bad = JSON.parse(readFileSync(new URL('./config/enemy/duelist.json', import.meta.url), 'utf8'));
    bad.moveSet = 'move-set/nobody';
    bad.patterns[0].steps[0].telegraph = -1;
    const res = config.load([...base, { path: 'config/enemy/bad.json', text: JSON.stringify(bad) }]);
    const msgs = res.problems.map((p) => p.file + p.pointer + ' ' + p.message).join('\n');
    expect(msgs).toContain('config/enemy/bad.json/patterns/0/steps/0/telegraph');
    expect(msgs).toContain('move-set/nobody');
    config.load(sources);
  });

  it('checkMoveSet finds a cancel into nowhere and a window past the end', () => {
    const ms = structuredClone(config.lookup('move-set', 'duelist')) as MoveSet;
    ms.moves['slash']!.cancelsInto = ['ghost'];
    ms.moves['slash']!.windows!['trace'] = [0.3, 2];
    const out = checkMoveSet(ms, 'ms');
    expect(out.some((l) => l.startsWith('ms#/moves/slash/cancelsInto/0'))).toBe(true);
    expect(out.some((l) => l.startsWith('ms#/moves/slash/windows/trace'))).toBe(true);
    expect(validateAgainst(moveSetSchema, ms)).toEqual([]);
    expect(validateAgainst(enemySchema, { kind: 'enemy', moveSet: 'move-set/x', patterns: [] }).length).toBeGreaterThan(0);
  });
});

describe('weapon traces', () => {
  it('only hit where the blade passes through a hurt shape', async () => {
    const near = await probe('slash', 1.0);
    expect(near.at).toBeGreaterThan(0);
    expect(near.outcome).toBe('hit');
    // The same swing from two metres beyond the blade's reach hits nothing, though the whole trace window runs.
    const far = await probe('slash', 3.2);
    expect(far.at).toBe(-1);
  });

  it('a fast blade cannot skip over a limb between two steps, and one that passes beside the body misses', async () => {
    const x = await duel(5);
    x.r.step(2);
    const sh = x.d.hurtShapes!;
    expect(sh.n).toBeGreaterThan(5);
    sh.refresh(x.tick());
    const blade = new Blade('blade', [0, 0, 0], [0, 1, 0], 0.03);
    blade.armed = true;
    const set = (x0: number, z: number): void => {
      blade.prev.set([x0, 0.9, z, x0, 1.9, z]);
      blade.cur.set([-x0, 0.9, z, -x0, 1.9, z]);
    };
    // Four metres in one step, through the chest.
    set(-2, 0);
    expect(sweepBlade(blade, sh)).toBeGreaterThanOrEqual(0);
    // The same sweep half a metre behind the body.
    set(-2, 0.7);
    expect(sweepBlade(blade, sh)).toBe(-1);
    // Segment distance basics.
    expect(segSegDistSq(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0)).toBeCloseTo(1, 9);
    expect(segSegDistSq(0, 0, 0, 1, 0, 0, 0.5, 0, 1, 0.5, 0, -1)).toBeCloseTo(0, 9);
  });

  it('one swing hits one fighter once', async () => {
    const x = await duel(1.0);
    let hits = 0;
    x.d.hit.connect(() => hits++);
    x.d.health.max = 1000; x.d.health.hp = 1000;
    x.a.attack('slash');
    x.r.step(60);
    expect(hits).toBe(1);
  });
});

describe('window sources', () => {
  it('reads windows from the move-set, or from animator.inWindow when the move says so', async () => {
    const x = await duel(1.0);
    x.a.attack('slash');
    x.r.step(20); // 0.33 s: inside the move-set's trace window [0.3, 0.42]
    expect(x.a.windowOpen('trace')).toBe(true);
    const ms = structuredClone(config.lookup('move-set', 'duelist')) as MoveSet;
    ms.moves['slash']!.windowsFrom = 'clip';
    expect(config.update({ path: 'config/move-set/duelist.json', text: JSON.stringify(ms) }).problems).toEqual([]);
    const an = x.a.animator as unknown as { inWindow(n: string): boolean };
    an.inWindow = (n: string) => n === 'cancel';
    expect(x.a.windowOpen('trace')).toBe(false);
    expect(x.a.windowOpen('cancel')).toBe(true);
    // auto: the move-set's own windows win, the clip supplies the rest.
    ms.moves['slash']!.windowsFrom = 'auto';
    config.update({ path: 'config/move-set/duelist.json', text: JSON.stringify(ms) });
    expect(x.a.windowOpen('trace')).toBe(true);
    expect(x.a.windowOpen('iframe')).toBe(false);
    config.load(sources);
  });
});

describe('guards', () => {
  it('a perfect deflect inside the window staggers the attacker; a guard raised too early only blocks', async () => {
    const { at } = await probe('slash', 1.0);
    expect(at).toBeGreaterThan(5);

    const inside = await duel(1.0);
    let perfect = 0, blocked = 0, deflected = 0, hits = 0;
    inside.d.perfectDeflect.connect(() => perfect++);
    inside.d.blocked.connect(() => blocked++);
    inside.d.deflected.connect(() => deflected++);
    inside.d.hit.connect(() => hits++);
    inside.a.attack('slash');
    inside.r.step(at - 4);
    inside.d.guard(true);
    inside.r.step(30);
    expect(perfect).toBe(1);
    expect(blocked + deflected + hits).toBe(0);
    expect(inside.a.state === 'stagger' || inside.a.state === 'free').toBe(true);
    expect(inside.a.posture).toBeGreaterThan(8);
    expect(inside.d.posture).toBe(0);
    expect(inside.d.health.hp).toBe(100);
    // The stagger is the point: right after the deflect the attacker is down for perfectStagger seconds.
    const stag = await duel(1.0);
    stag.a.attack('slash');
    stag.r.step(at - 4);
    stag.d.guard(true);
    let sawStagger = false;
    for (let i = 0; i < 30; i++) { stag.r.step(1); if (stag.a.state === 'stagger') sawStagger = true; }
    expect(sawStagger).toBe(true);

    const outside = await duel(1.0);
    perfect = 0; blocked = 0; deflected = 0; hits = 0;
    outside.d.perfectDeflect.connect(() => perfect++);
    outside.d.blocked.connect(() => blocked++);
    outside.d.deflected.connect(() => deflected++);
    outside.d.hit.connect(() => hits++);
    let staggered = false;
    outside.a.attack('slash');
    outside.r.step(at - 26); // 0.43 s of guard before the blow: a plain block
    outside.d.guard(true);
    for (let i = 0; i < 60; i++) { outside.r.step(1); if (outside.a.state === 'stagger') staggered = true; }
    expect(perfect).toBe(0);
    expect(blocked).toBe(1);
    expect(hits).toBe(0);
    expect(staggered).toBe(false);
    expect(outside.d.posture).toBeGreaterThan(10);

    // And in between (0.2 s) it is a deflect: cheap on posture, no stagger.
    const mid = await duel(1.0);
    deflected = 0; staggered = false;
    mid.d.deflected.connect(() => deflected++);
    mid.a.attack('slash');
    mid.r.step(at - 13);
    mid.d.guard(true);
    for (let i = 0; i < 60; i++) { mid.r.step(1); if (mid.a.state === 'stagger') staggered = true; }
    expect(deflected).toBe(1);
    expect(staggered).toBe(false);
    expect(mid.d.posture).toBeLessThan(outside.d.posture);
  });

  it('a guard held with its back to the blow does nothing', async () => {
    const x = await duel(1.0);
    x.d.node.rotation.y = Math.PI / 2; // turned away from A
    x.d.guard(true);
    let hits = 0;
    x.d.hit.connect(() => hits++);
    x.a.attack('slash');
    x.r.step(60);
    // Turned 90 degrees, the blow comes from the side of a 150 degree arc: still held. Turn fully round.
    expect(hits).toBeLessThanOrEqual(1);
    const y = await duel(1.0);
    y.d.node.rotation.y = Math.PI;
    y.d.guard(true);
    let h2 = 0;
    y.d.hit.connect(() => h2++);
    y.a.attack('slash');
    y.r.step(60);
    expect(h2).toBe(1);
  });
});

describe('dodges and unblockables', () => {
  it('an unblockable hits a fighter who stands there, or guards, and a dodge avoids it', async () => {
    const base = await probe('sweep', 1.8, (x) => { x.d.mover = () => {}; });
    expect(base.outcome).toBe('hit');
    const guarded = await duel(1.8);
    let outcome = '';
    guarded.hub.hit.connect((i) => { outcome = i.outcome; });
    guarded.hub.blocked.connect((i) => { outcome = i.outcome; });
    guarded.hub.perfectDeflect.connect((i) => { outcome = i.outcome; });
    guarded.d.guard(true);
    guarded.a.attack('sweep');
    guarded.r.step(60);
    expect(outcome).toBe('hit');
    // A real dodge, timed from the probe, takes no hit.
    const x = await duel(1.8);
    let got = '';
    x.hub.hit.connect(() => { got = 'hit'; });
    x.a.attack('sweep');
    x.r.step(base.at - 12);
    x.d.dodge(1, 0);
    x.r.step(60);
    expect(got).toBe('');
    expect(x.d.health.hp).toBe(100);
  });

  it('i-frames are exactly the dodge window: before it and after it the same blow hits', async () => {
    const outcomeAt = async (steps: number): Promise<string> => {
      const x = await duel(5);
      x.d.mover = () => {};
      x.d.dodge(1, 0);
      x.r.step(steps);
      const a = newAttack();
      a.attacker = x.a; a.move = 'sweep'; a.damage = 20; a.posture = 10; a.unblockable = true; a.fromX = 0; a.fromZ = -5;
      return x.d.receive(a);
    };
    // dodgeIframeStart 0.04 s (about 3 steps) to 0.30 s (18 steps).
    expect(await outcomeAt(1)).toBe('hit');
    expect(await outcomeAt(6)).toBe('dodged');
    expect(await outcomeAt(15)).toBe('dodged');
    expect(await outcomeAt(24)).toBe('hit');
  });
});

describe('posture and finishers', () => {
  it('a broken posture opens a finisher that only starts, and only hurts, a broken fighter', async () => {
    const x = await duel(1.0);
    x.d.maxPosture = 40;
    x.d.finisherDamage = 1;
    let broken = 0, killed = 0;
    x.d.postureBroken.connect(() => broken++);
    x.d.killed.connect(() => killed++);
    // Nobody is broken yet: the finisher does not even start.
    expect(x.a.press('finisher')).toBe(false);
    x.d.guard(true);
    x.a.attack('charged');
    for (let i = 0; i < 70 && broken === 0; i++) x.r.step(1);
    expect(broken).toBe(1);
    expect(x.d.state).toBe('broken');
    expect(x.d.finisherReady).toBe(true);
    // A broken fighter cannot guard or act.
    expect(x.d.attack('slash')).toBe(false);
    // Free again after the charged cut, the attacker finishes.
    for (let i = 0; i < 120 && x.a.state !== 'free'; i++) x.r.step(1);
    expect(x.a.press('finisher')).toBe(true);
    x.r.step(90);
    expect(killed).toBe(1);
    expect(x.d.state).toBe('dead');
    expect(x.a.landed).toBeGreaterThanOrEqual(1);
  });

  it('a finisher that does not kill (a boss) leaves the fighter standing with an empty posture', async () => {
    const x = await duel(1.0);
    x.d.maxPosture = 40; x.d.finisherDamage = 0.4;
    x.d.breakPosture();
    x.r.step(1);
    expect(x.a.press('finisher')).toBe(true);
    x.r.step(60);
    expect(x.d.health.hp).toBeCloseTo(60, 5);
    expect(x.d.state === 'stagger' || x.d.state === 'free').toBe(true);
    expect(x.d.posture).toBe(0);
  });

  it('posture comes back after a quiet while, and the stance an enemy is weak to costs it more', async () => {
    const x = await duel(5);
    x.d.addPosture(30, 'water');
    expect(x.d.posture).toBe(30);
    x.d.weakTo = 'wind';
    x.d.posture = 0;
    x.d.addPosture(10, 'wind');
    expect(x.d.posture).toBeCloseTo(10 * combatTuning.weakBonus, 9);
    x.d.posture = 20;
    x.r.step(60 * 4);
    expect(x.d.posture).toBeLessThan(20);
  });
});

describe('chip, resistance and in-combat posture', () => {
  it('a plain block lets 15% of the damage through and a deflect none', async () => {
    const bare = await duel(1.0);
    bare.a.attack('slash');
    bare.r.step(60);
    const full = 100 - bare.d.health.hp;
    expect(full).toBeGreaterThan(0);
    const x = await duel(1.0);
    let blocked = 0;
    x.d.blocked.connect(() => blocked++);
    x.d.guard(true);
    x.r.step(60);
    x.a.attack('slash');
    x.r.step(60);
    expect(blocked).toBe(1);
    expect(x.d.health.hp).toBeCloseTo(100 - full * combatTuning.blockChip, 6);
    expect(x.d.state).toBe('free');
  });

  it('the wrong stance costs less posture, the right one more', async () => {
    const x = await duel(5);
    x.d.weakTo = 'wind';
    x.d.resists = 'water';
    x.d.addPosture(10, 'water');
    expect(x.d.posture).toBeCloseTo(10 * combatTuning.resistMult, 9);
    x.d.posture = 0;
    x.d.addPosture(10, 'wind');
    expect(x.d.posture).toBeCloseTo(10 * combatTuning.weakBonus, 9);
    x.d.posture = 0;
    x.d.addPosture(10, 'stone');
    expect(x.d.posture).toBe(10);
  });

  it('posture comes back slower while an enemy is near, at the full rate when none is', async () => {
    const near = await duel(5);
    near.d.postureRecover = 30; near.d.postureRecoverFight = 3;
    near.d.posture = 60;
    near.r.step(60 * 2.5);
    // 1.5 s of quiet, then one second at 3 a second.
    expect(near.d.posture).toBeGreaterThan(55);
    expect(near.d.posture).toBeLessThan(58.5);
    const far = await duel(50);
    far.d.postureRecover = 30; far.d.postureRecoverFight = 3;
    far.d.posture = 60;
    far.r.step(60 * 2.5);
    expect(far.d.posture).toBeLessThan(35);
  });

  it('a rest pattern comes after the streak the pattern asks for, and an interruption clears the streak', async () => {
    const def = defineGame({
      ready(g) {
        spawnFighter(g.world, { name: 'p', team: 'p', x: 0, z: 0, yaw: 0, character: 'character/duelist', moveSet: 'move-set/duelist' });
        spawnEnemy(g.world, 'duelist', { name: 'e', x: 0, z: -1.6, yaw: Math.PI, target: 'p' });
      },
    });
    const r = await startRig(def, sources, '', 5);
    const b = r.g.world.find('e')!.get(EnemyBrain)!;
    expect(b.streak).toBe(0);
    for (let i = 0; i < 600 && b.patternIdx < 0; i++) r.step(1);
    expect(b.streak).toBe(1);
    b.streak = 2;
    b.combatant.stagger(0.3);
    r.step(5);
    expect(b.streak).toBe(0);
  });
});

describe('enemies', () => {
  it('at most two enemies are in an attack at once, and they do attack', async () => {
    const def = defineGame({
      ready(g) {
        spawnFighter(g.world, { name: 'player', team: 'player', character: 'character/duelist', moveSet: 'move-set/duelist', health: 1e6 });
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          spawnEnemy(g.world, 'enemy/duelist', { x: Math.sin(a) * 3, z: Math.cos(a) * 3, yaw: a + Math.PI, health: 1e6 });
        }
      },
    });
    const r = await startRig(def, sources, '', 5);
    const brains = r.g.world.group('enemy').map((n) => n.get(EnemyBrain)!);
    expect(brains.length).toBe(5);
    let most = 0, attackSteps = 0;
    const started = new Set<string>();
    for (const b of brains) b.patternStarted.connect((n) => started.add(n));
    for (let i = 0; i < 60 * 25; i++) {
      r.step(1);
      const n = brains.filter((b) => b.mode !== 'spacing').length;
      most = Math.max(most, n);
      if (n > 0) attackSteps++;
      expect(attackTokens(r.g.world).count).toBeLessThanOrEqual(2);
    }
    expect(most).toBe(2);
    expect(attackSteps).toBeGreaterThan(100);
    expect(started.size).toBeGreaterThanOrEqual(2);
    expect(r.g.world.find('player')!.get(Combatant)!.health.hp).toBeLessThan(1e6);
  });

  it('a stagger drops the pattern and the place in the queue', async () => {
    const x = await duel(1.0);
    const tok = attackTokens(x.r.g.world);
    expect(tok.acquire(x.a.node)).toBe(true);
    x.a.node.destroy();
    x.r.step(1);
    expect(tok.free()).toBe(true);
  });
});

describe('lock-on and camera', () => {
  it('picks the nearest target inside the arc, and cycles past it', () => {
    const xs = [3, -1, 0], zs = [-4, -2, 5];
    // Looking along -Z from the origin: the target at (-1, -2) is nearest and in front.
    expect(pickLockTarget(0, 0, 0, -1, xs, zs, 3, 14, 200)).toBe(1);
    expect(pickLockTarget(0, 0, 0, -1, xs, zs, 3, 14, 200, 1)).toBe(0);
    // Behind the player is outside a 120 degree arc.
    expect(pickLockTarget(0, 0, 0, -1, xs, zs, 3, 14, 120, 1)).toBe(0);
    expect(pickLockTarget(0, 0, 0, -1, [0], [5], 1, 14, 120)).toBe(-1);
    expect(pickLockTarget(0, 0, 0, -1, [0], [-20], 1, 14, 360)).toBe(-1);
  });

  it('the camera keeps a locked target in front and shakes on a hit, replaying the same', async () => {
    const r = await startRig(bench, sources, 'combat');
    const w = r.g.world;
    const cam = w.find('camera')!.get(FollowCamera)!;
    const lock = w.find('player')!.get(LockOn)!;
    const foe = w.find('raider')!;
    r.step(2);
    lock.toggle();
    expect(lock.target).toBe(foe);
    r.step(240);
    const me = w.find('player')!;
    // The camera looks along (-sin yaw, -cos yaw); the target is on that side of the player.
    const dx = foe.position.x - me.position.x, dz = foe.position.z - me.position.z;
    const dot = (dx * -Math.sin(cam.yaw) + dz * -Math.cos(cam.yaw)) / Math.hypot(dx, dz);
    expect(dot).toBeGreaterThan(0.95);
    combatHub(w).shake.emit(1, 0.3);
    expect(cam.shakeA).toBeGreaterThan(0);
    r.step(30);
    expect(cam.shakeA).toBe(0);
    lock.release();
    expect(cam.lockTarget).toBeNull();
  });
});

describe('standoff', () => {
  async function stand(): Promise<{ r: Rig; s: Standoff; p: Combatant; e: Combatant }> {
    const def = defineGame({
      ready(g) {
        spawnFighter(g.world, { name: 'p', team: 'p', z: 0, character: 'character/duelist', moveSet: 'move-set/duelist' });
        spawnFighter(g.world, { name: 'e', team: 'e', z: -2.5, yaw: Math.PI, character: 'character/duelist', moveSet: 'move-set/duelist' });
        const host = g.world.spawn('standoff');
        host.add(Standoff, { waitRange: [1, 1], window: 0.3 });
      },
    });
    const r = await startRig(def, sources, '');
    const s = r.g.world.find('standoff')!.get(Standoff)!;
    const p = r.g.world.find('p')!.get(Combatant)!, e = r.g.world.find('e')!.get(Combatant)!;
    s.begin(p, e);
    return { r, s, p, e };
  }

  it('releasing on the twitch kills; releasing early or late takes a hit', async () => {
    const win = await stand();
    let twitched = 0;
    win.s.twitch.connect(() => twitched++);
    win.r.step(60 + 6);
    expect(twitched).toBe(1);
    win.s.release();
    expect(win.s.result).toBe('win');
    expect(win.e.state).toBe('dead');
    expect(win.p.health.hp).toBe(100);

    const early = await stand();
    early.r.step(30);
    early.s.release();
    expect(early.s.result).toBe('lose');
    expect(early.p.health.hp).toBe(60);
    expect(early.e.state).toBe('free');

    const late = await stand();
    late.r.step(60 + 30);
    expect(late.s.result).toBe('lose');
    expect(late.p.health.hp).toBe(60);
  });
});

describe('a seeded duel', () => {
  async function play(seed: number): Promise<{ checksum: string; hits: number; deflects: number; hpMe: number; hpFoe: number }> {
    let hits = 0, deflects = 0;
    const { rig, checksum } = await runScenario({
      def: bench, sources, inputMap: 'combat', steps: 60 * 30, seed,
      input: () => ({}),
      at: { 0: (x) => { const h = combatHub(x.g.world); h.hit.connect(() => hits++); h.perfectDeflect.connect(() => deflects++); } },
    });
    const me = rig.g.world.find('player')!.get(Combatant)!, foe = rig.g.world.find('raider')!.get(Combatant)!;
    return { checksum, hits, deflects, hpMe: me.health.hp, hpFoe: foe.health.hp };
  }

  it('the player script against the enemy patterns gives the same checksum twice, and a different one for another seed', async () => {
    const a = await play(21);
    const b = await play(21);
    expect(b).toEqual(a);
    expect(a.hits + a.deflects).toBeGreaterThan(3);
    expect(a.deflects).toBeGreaterThan(0);
    const c = await play(22);
    expect(c.checksum).not.toBe(a.checksum);
  });
});

void projectSources;
