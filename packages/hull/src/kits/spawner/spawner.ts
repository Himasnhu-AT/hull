import { Behaviour, signal, type Node, type World } from '../../core/index.ts';
import { num, tunables } from '../../config/index.ts';
import { Collider } from '../../physics/index.ts';
import { Mesh, teleported } from '../../render/index.ts';
import type { UiView } from '../../ui/index.ts';
import { flagsOf, GROUP, KitUi, LAYER, upFrom, type KitFlags, type LevelLike } from '../common.ts';
import { Health } from '../health/health.ts';
import { kitIO } from '../io.ts';
import { newWalk, walk, type WalkState } from '../walker.ts';

export const spawnerTuning = tunables('spawner', {
  firstDelay: num(2, { min: 0, max: 60, step: 0.5, unit: 's', help: 'Seconds before the first wave.' }),
  wavePause: num(5, { min: 0, max: 120, step: 0.5, unit: 's', widget: 'slider', help: 'Seconds between a cleared wave and the next.' }),
  firstCount: num(3, { min: 1, max: 100, step: 1, widget: 'dial', help: 'Enemies in the first wave.' }),
  countGrowth: num(2, { min: 0, max: 50, step: 1, widget: 'dial', help: 'Extra enemies in each later wave.' }),
  maxAlive: num(10, { min: 1, max: 200, step: 1, help: 'The wave waits for room below this.' }),
  interval: num(0.6, { min: 0.05, max: 10, step: 0.05, unit: 's', help: 'Seconds between two spawns of a wave.' }),
  minDistance: num(10, { min: 0, max: 100, step: 1, unit: 'm', help: 'Nothing spawns closer than this to the target.' }),
});

export const enemyTuning = tunables('enemy', {
  speed: num(3.2, { min: 0.5, max: 15, step: 0.1, unit: 'm/s', widget: 'dial' }),
  speedPerWave: num(0.15, { min: 0, max: 2, step: 0.05, unit: 'm/s', help: 'Extra speed each wave.' }),
  health: num(60, { min: 1, max: 1000, step: 5, widget: 'dial' }),
  damage: num(6, { min: 0, max: 200, step: 1, widget: 'dial', help: 'Hurt dealt by one bite.' }),
  reach: num(1.3, { min: 0.5, max: 5, step: 0.1, unit: 'm' }),
  attackInterval: num(0.9, { min: 0.1, max: 5, step: 0.05, unit: 's' }),
  accel: num(25, { min: 2, max: 200, step: 1, unit: 'm/s²' }),
});

const TUNE = { jumpHeight: 0, gravity: 26, coyoteTime: 0, airControl: 0.3 };

/**
 * A plain enemy: walks at the nearest player and bites when close. A body capsule (zone "body") and a head sphere
 * (zone "head") are the hit zones; both sit on the `enemy` layer and a hit on either hurts this node's Health.
 * It is only a stand-in for the kit's wave logic: a game with real enemies passes its own `factory` to the Spawner.
 */
export class Chaser extends Behaviour {
  static override state = ['walk', 'cool'];
  speed = 3.2;
  damage = 12;
  walk: WalkState = newWalk();
  cool = 0;
  private col!: Collider;
  private flags!: KitFlags;

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.col = this.node.get(Collider)!;
    const h = this.node.get(Health);
    h?.damaged.connect(() => kitIO.play('sound/hit'), this.node);
    h?.died.connect(() => this.node.destroy(), this.node);
  }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused) return;
    if (this.cool > 0) this.cool -= dt;
    const people = this.world.group(GROUP.player);
    let best = Infinity;
    let target: Node | null = null;
    const p = this.node.position;
    for (let i = 0; i < people.length; i++) {
      const d = Math.hypot(people[i]!.position.x - p.x, people[i]!.position.z - p.z);
      if (d < best) { best = d; target = people[i]!; }
    }
    let wx = 0;
    let wz = 0;
    if (target !== null) {
      const dx = target.position.x - p.x;
      const dz = target.position.z - p.z;
      if (best > enemyTuning.reach * 0.8) { wx = dx / best; wz = dz / best; }
      if (best > 0.01) this.node.rotation.y = Math.atan2(-dx, -dz);
      if (best < enemyTuning.reach && this.cool <= 0) {
        const hp = upFrom(target, Health);
        if (hp && hp.damage(this.damage, '', this.node) > 0) this.cool = enemyTuning.attackInterval;
      }
    }
    walk(this.col, this.walk, wx, wz, this.speed, enemyTuning.accel, false, LAYER.world | LAYER.player, TUNE, dt);
  }
}

/** Builds one Chaser at (x, z): the default enemy of a Spawner. */
export function spawnGrunt(world: World, x: number, z: number, wave: number): Node {
  const n = world.spawn('grunt');
  n.position.set(x, 0, z);
  const hp = enemyTuning.health * (1 + 0.1 * (wave - 1));
  n.add(Health, { max: hp, hp, invulnAfterHit: 0 });
  n.addTo(GROUP.enemy);
  n.add(Collider, { shape: { type: 'capsule', radius: 0.4, height: 1.7, center: [0, 0.85, 0] }, layer: LAYER.enemy, tag: 'body' });
  const body = world.spawn('body', n);
  body.position.y = 0.85;
  body.scale.set(0.8, 1.7, 0.8);
  body.add(Mesh, { shape: 'capsule', material: 'material/enemy' });
  const head = world.spawn('head', n);
  head.position.y = 1.62;
  head.add(Collider, { shape: { type: 'sphere', radius: 0.26 }, layer: LAYER.enemy, tag: 'head' });
  const skull = world.spawn('skull', head);
  skull.scale.setScalar(0.5);
  skull.add(Mesh, { shape: 'sphere', material: 'material/enemy-head' });
  n.add(Chaser, { speed: enemyTuning.speed + enemyTuning.speedPerWave * (wave - 1), damage: enemyTuning.damage });
  teleported(n);
  return n;
}

/**
 * Waves of enemies. Wait `firstDelay`, spawn `firstCount` (growing by `countGrowth` each wave) one every `interval`
 * seconds, wait until all are dead, rest `wavePause`, repeat; `maxWaves` above 0 stops after that many. Spawn spots
 * are free floor of the level at least `minDistance` from the target, from the world's 'spawner' random stream.
 */
export class Spawner extends Behaviour {
  static override state = ['wave', 'left', 'timer', 'phase', 'kills'];
  /** Makes one enemy; it must add it to the `enemy` group. */
  factory: (world: World, x: number, z: number, wave: number) => Node = spawnGrunt;
  level: LevelLike | null = null;
  maxWaves = 0;
  wave = 0;
  left = 0;
  timer = 0;
  /** 0 resting, 1 spawning, 2 fighting, 3 finished. */
  phase = 0;
  kills = 0;
  readonly waveStarted = signal<[wave: number]>();
  readonly waveCleared = signal<[wave: number]>();
  readonly spawned = signal<[enemy: Node]>();
  readonly killed = signal<[enemy: Node]>();
  private flags!: KitFlags;
  private readonly spot = { x: 0, z: 0 };

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.node.addTo(GROUP.save);
    this.timer = spawnerTuning.firstDelay;
  }

  get alive(): number { return this.world.group(GROUP.enemy).length; }

  /** After a load: the enemies of the old run are gone and the wave in the save starts again. */
  restartWave(): void {
    const old = this.world.group(GROUP.enemy);
    for (let i = old.length - 1; i >= 0; i--) old[i]!.destroy();
    if (this.phase === 1 || this.phase === 2) { this.wave = Math.max(0, this.wave - 1); this.phase = 0; }
    this.timer = spawnerTuning.wavePause;
  }

  afterLoad(): void { this.restartWave(); }

  /** Back to before the first wave: no enemies, no kills. */
  reset(): void {
    const old = this.world.group(GROUP.enemy);
    for (let i = old.length - 1; i >= 0; i--) old[i]!.destroy();
    this.wave = 0; this.left = 0; this.phase = 0; this.kills = 0;
    this.timer = spawnerTuning.firstDelay;
  }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused) return;
    if (this.timer > 0) this.timer -= dt;
    switch (this.phase) {
      case 0:
        if (this.timer <= 0) {
          this.wave++;
          this.left = Math.round(spawnerTuning.firstCount + spawnerTuning.countGrowth * (this.wave - 1));
          this.phase = 1;
          this.waveStarted.emit(this.wave);
        }
        break;
      case 1:
        if (this.left > 0) {
          if (this.timer <= 0 && this.alive < spawnerTuning.maxAlive) this.spawnOne();
        } else this.phase = 2;
        break;
      case 2:
        if (this.alive === 0) {
          this.waveCleared.emit(this.wave);
          if (this.maxWaves > 0 && this.wave >= this.maxWaves) this.phase = 3;
          else { this.phase = 0; this.timer = spawnerTuning.wavePause; }
        }
        break;
    }
  }

  private spawnOne(): void {
    const t = this.world.group(GROUP.player)[0];
    const tx = t?.position.x ?? 0;
    const tz = t?.position.z ?? 0;
    const s = this.spot;
    let ok = false;
    if (this.level) ok = this.level.freeSpot(s, 1, 'spawner', tx, tz, spawnerTuning.minDistance);
    else {
      const rnd = this.world.random('spawner');
      const a = rnd.range(0, Math.PI * 2);
      s.x = tx + Math.cos(a) * spawnerTuning.minDistance;
      s.z = tz + Math.sin(a) * spawnerTuning.minDistance;
      ok = true;
    }
    this.timer = spawnerTuning.interval;
    if (!ok) return;
    const e = this.factory(this.world, s.x, s.z, this.wave);
    this.left--;
    e.get(Health)?.died.connect(() => { this.kills++; this.killed.emit(e); }, e);
    this.spawned.emit(e);
  }
}

/** Wave number, enemies left and kills at the top right. */
export class WaveHud extends KitUi {
  protected build(ui: UiView): void {
    const sp = this.node.get(Spawner)!;
    const p = ui.root.panel({ anchor: 'top-right', label: 'Waves', width: 200 });
    p.text('WAVE', { muted: true });
    p.title('0').bind(() => sp.wave, (v) => String(v));
    p.text('').bind(() => sp.alive + (sp.phase === 1 ? sp.left : 0), (v) => `${v} left`);
    p.text('').bind(() => sp.kills, (v) => `${v} down`);
  }
}

/**
 * When the player dies: a "you died" screen, and on `jump` the player gets up at the start with full health and the
 * waves begin again. Put it on the node with the Spawner.
 */
export class GameOver extends KitUi {
  restartAction = 'jump';
  private flags!: KitFlags;
  private spawner: Spawner | null = null;
  private home = { x: 0, y: 0, z: 0 };
  private homed = false;

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.spawner = this.node.get(Spawner) ?? null;
  }

  private get dead(): boolean {
    const p = this.world.group(GROUP.player)[0];
    return !!p && (upFrom(p, Health)?.dead ?? false);
  }

  override fixedUpdate(): void {
    const p = this.world.group(GROUP.player)[0];
    if (!p) return;
    if (!this.homed) { this.home.x = p.position.x; this.home.y = p.position.y; this.home.z = p.position.z; this.homed = true; }
    if (this.flags.paused || !this.dead || !kitIO.input.action(this.restartAction).pressed) return;
    upFrom(p, Health)?.revive();
    p.position.set(this.home.x, this.home.y, this.home.z);
    teleported(p);
    this.spawner?.reset();
  }

  protected build(ui: UiView): void {
    const p = ui.root.panel({ anchor: 'center', label: 'You died' });
    p.title('You died');
    p.text('').bind(() => this.spawner?.wave ?? 0, (w) => `You reached wave ${w}. Press Space to try again.`);
    p.bindVisible(() => this.dead);
  }
}
