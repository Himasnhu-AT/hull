// What a fight looks and sounds like: the combat hub's signals turned into sparks, flashes, blood and the sounds the kit
// does not play itself. Effects and sounds never change the simulation.
import { Behaviour } from 'hull';
import { vfx } from 'hull/vfx';
import { Combatant, combatHub, kitIO, type HitInfo } from 'hull/kits';

const at = { x: 0, y: 0, z: 0 };
const dir = { x: 0, y: 1, z: 0 };

export class Feel extends Behaviour {
  override ready(): void {
    const hub = combatHub(this.world);
    const spot = (i: HitInfo): typeof at => { at.x = i.x; at.y = i.y; at.z = i.z; return at; };
    hub.hit.connect((i) => { vfx.burst('vfx/blood-mist', spot(i), dir); kitIO.play('sound/hit/flesh'); }, this.node);
    hub.blocked.connect((i) => { vfx.burst('vfx/clash-sparks', spot(i), dir); kitIO.play('sound/hit/block'); }, this.node);
    hub.deflected.connect((i) => { vfx.burst('vfx/clash-sparks', spot(i), dir); vfx.burst('vfx/deflect-flash', spot(i), dir); }, this.node);
    hub.perfectDeflect.connect((i) => {
      vfx.burst('vfx/clash-sparks', spot(i), dir);
      vfx.burst('vfx/perfect-flash', spot(i), dir);
      kitIO.play('sound/perfect-deflect');
    }, this.node);
    hub.postureBroken.connect((i) => { vfx.burst('vfx/clash-sparks', spot(i), dir); }, this.node);
    hub.moveStarted.connect((who: Combatant, move: string) => {
      if (who.team !== 'player') return;
      const p = who.node.position;
      at.x = p.x; at.y = p.y + 1.1; at.z = p.z;
      dir.x = -Math.sin(who.yaw); dir.y = 0; dir.z = -Math.cos(who.yaw);
      if (!move.startsWith('finisher')) vfx.burst('vfx/slash-arc', at, dir);
      dir.x = 0; dir.y = 1; dir.z = 0;
    }, this.node);
    hub.killed.connect((i) => { vfx.burst('vfx/blood-mist', spot(i), dir); }, this.node);
  }
}
