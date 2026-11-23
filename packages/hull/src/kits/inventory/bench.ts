import { defineGame } from '../../core/index.ts';
import { ensurePhysics, LAYER } from '../common.ts';
import { FirstPerson, spawnFirstPerson } from '../fps/fps.ts';
import { Interactable, Interactor } from '../interact/interact.ts';
import { SaveSlots } from '../saves/saves.ts';
import { Inventory } from './inventory.ts';

/** Bench scene: a player with two slots and a stack limit of 3, and a crate of keys that fills it when used. */
export default defineGame({
  ready(g) {
    ensurePhysics(g.world).addGround(0, { layer: LAYER.world });
    const me = spawnFirstPerson(g.world);
    const inv = me.add(Inventory, { capacity: 2, stack: 3 });
    me.get(FirstPerson)!.eye.add(Interactor);
    g.world.spawn('saves').add(SaveSlots);
    const crate = g.world.spawn('crate');
    crate.position.set(0, 1.6, -1.5);
    crate.add(Interactable, { prompt: 'Take key' }).used.connect(() => { inv.add('key', 1); });
  },
});
