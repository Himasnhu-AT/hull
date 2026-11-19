// The entry Hull starts: one node, `aott`, carrying the host behaviour that is the whole game (host.ts). The simulation
// runs at 120 Hz, as the standalone game's physics always did (hull.json step).
import { defineGame } from 'hull';
import { AottHost } from './host';
import { bindWorld } from './sim';

export default defineGame({
  stepRate: 120,
  async ready(game) {
    bindWorld(game.world);
    const node = game.world.spawn('aott');
    const host = node.add(AottHost);
    await host.boot(game, node);
  },
});
