import { Behaviour, type Node } from 'hull';
import { Mesh, teleported } from 'hull/render';
import { Level } from './level.ts';
import { sound } from './rig.ts';
import { Round } from './round.ts';
import { arena, pickup, player } from './tuning.ts';

/** A gem that spins and bobs. The player touching it scores and moves it to a new free spot. */
export class Gem extends Behaviour {
  static override state = ['phase'];
  phase = 0;
  private level!: Level;
  private round!: Round;
  private who!: Node;

  override ready(): void {
    this.level = this.world.find('level')!.get(Level)!;
    this.round = this.world.find('round')!.get(Round)!;
    this.who = this.world.find('player')!;
    const stone = this.world.spawn('stone', this.node);
    // Tilted on two axes it reads as a cut stone from any side.
    stone.rotation.set(Math.PI / 4, 0, Math.PI / 4);
    stone.scale.setScalar(0.5);
    stone.add(Mesh, { shape: 'box', material: 'material/gem' });
    this.moveToFreeSpot();
    this.phase = this.world.random('pickups').range(0, 6.28);
  }

  override fixedUpdate(dt: number): void {
    const n = this.node;
    this.phase += dt;
    n.rotation.y = this.phase * pickup.spinSpeed;
    n.position.y = arena('gemHeight') + Math.sin(this.phase * pickup.bobSpeed) * pickup.bobHeight;

    if (this.round.over) return;
    const q = this.who.position;
    const reach = pickup.collectRadius + player.radius;
    const dx = q.x - n.position.x;
    const dz = q.z - n.position.z;
    // Height counts too: the player is a capsule from the feet up.
    const dy = Math.min(Math.max(n.position.y, q.y), q.y + player.height) - n.position.y;
    if (dx * dx + dz * dz + dy * dy < reach * reach) {
      this.round.score += pickup.points;
      sound.play('sound/pickup');
      this.moveToFreeSpot();
    }
  }

  /** Not inside a crate, and not on top of the player. */
  private moveToFreeSpot(): void {
    const rnd = this.world.random('pickups');
    const span = this.level.half - 1.5;
    const m = arena('gemMargin') + 0.3;
    const p = this.node.position;
    for (let i = 0; i < 50; i++) {
      const x = rnd.range(-span, span);
      const z = rnd.range(-span, span);
      if (this.level.hits(x, z, m, m)) continue;
      if (Math.hypot(x - this.who.position.x, z - this.who.position.z) < 3) continue;
      p.x = x;
      p.z = z;
      break;
    }
    teleported(this.node);
  }
}

