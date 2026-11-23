import { Behaviour, signal, type Node } from '../../core/index.ts';
import { num, tunables } from '../../config/index.ts';
import { teleported } from '../../render/index.ts';
import { flagsOf, GROUP, upFrom, type KitFlags } from '../common.ts';
import { FirstPerson } from '../fps/fps.ts';
import { Health } from '../health/health.ts';
import { kitIO } from '../io.ts';
import { ThirdPerson } from '../third-person/third-person.ts';

export const checkpointTuning = tunables('checkpoint', {
  delay: num(2, { min: 0, max: 20, step: 0.1, unit: 's', widget: 'slider', help: 'How long a dead player waits before coming back.' }),
  invuln: num(1.5, { min: 0, max: 10, step: 0.1, unit: 's', help: 'Nothing hurts the player this long after coming back.' }),
  radius: num(2, { min: 0.3, max: 20, step: 0.1, unit: 'm', help: 'Reach of a Checkpoint that does not set its own radius.' }),
});

/**
 * Remembers where the player comes back after dying, and brings them back. Put it on the player (next to its Health):
 * it waits `delay` seconds after `died`, revives the Health at the last checkpoint with full hit points, and a short
 * invulnerability. Until a checkpoint is touched it uses where the player started. The point is saved with the save
 * kit (the node joins the `save` group).
 */
export class Respawn extends Behaviour {
  static override state = ['x', 'y', 'z', 'yaw', 'id', 'timer', 'waiting', 'deaths'];
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  /** Id of the checkpoint last reached ("" for the start). */
  id = '';
  /** Seconds to wait after dying; negative uses the tuning. */
  delay = -1;
  timer = 0;
  waiting = false;
  deaths = 0;
  sound = 'sound/checkpoint';
  readonly respawned = signal<[x: number, y: number, z: number]>();
  private health: Health | null = null;
  private flags!: KitFlags;

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.node.addTo(GROUP.save);
    this.x = this.node.position.x;
    this.y = this.node.position.y;
    this.z = this.node.position.z;
    this.yaw = this.node.rotation.y;
    this.health = upFrom(this.node, Health) ?? null;
    this.health?.died.connect(() => this.onDied(), this.node);
  }

  /** Makes this the place to come back to. */
  set(x: number, y: number, z: number, yaw: number, id = ''): void {
    this.x = x; this.y = y; this.z = z; this.yaw = yaw; this.id = id;
  }

  private onDied(): void {
    this.waiting = true;
    this.deaths++;
    this.timer = this.delay >= 0 ? this.delay : checkpointTuning.delay;
  }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused || !this.waiting) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.waiting = false;
    this.bringBack();
  }

  private bringBack(): void {
    const n = this.node;
    n.position.set(this.x, this.y, this.z);
    const fp = n.get(FirstPerson);
    const tp = n.get(ThirdPerson);
    if (fp) { fp.yaw = this.yaw; fp.pitch = 0; fp.walk.vx = 0; fp.walk.vy = 0; fp.walk.vz = 0; }
    if (tp) { tp.facing = this.yaw; tp.walk.vx = 0; tp.walk.vy = 0; tp.walk.vz = 0; }
    n.rotation.y = this.yaw;
    teleported(n);
    if (this.health) {
      this.health.revive();
      this.health.invuln = checkpointTuning.invuln;
    }
    this.respawned.emit(this.x, this.y, this.z);
  }
}

/**
 * A place that counts as reached when a player (a node in the `player` group) comes within `radius` horizontally and
 * `height` above or below the node. It tells that player's Respawn to come back here, facing the node's own yaw.
 */
export class Checkpoint extends Behaviour {
  static override state = ['reached'];
  /** Name for saves and game code; defaults to the node's name. */
  id = '';
  radius = 0;
  /** How far above or below the node still counts. */
  height = 2;
  reached = false;
  readonly touched = signal<[by: Node]>();
  private flags!: KitFlags;

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.node.addTo(GROUP.save);
    if (this.id === '') this.id = this.node.name;
  }

  override fixedUpdate(_dt: number): void {
    if (this.flags.paused) return;
    const takers = this.world.group(GROUP.player);
    const r = this.radius > 0 ? this.radius : checkpointTuning.radius;
    const p = this.node.position;
    for (let i = 0; i < takers.length; i++) {
      const who = takers[i]!;
      const dx = who.position.x - p.x;
      const dz = who.position.z - p.z;
      if (dx * dx + dz * dz > r * r || Math.abs(who.position.y - p.y) > this.height) continue;
      const re = who.get(Respawn);
      if (!re || re.id === this.id) continue;
      re.set(p.x, p.y, p.z, this.node.rotation.y, this.id);
      this.reached = true;
      if (re.sound !== '') kitIO.play(re.sound);
      this.touched.emit(who);
    }
  }
}
