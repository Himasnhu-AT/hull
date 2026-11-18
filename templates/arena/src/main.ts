import { defineGame } from 'hull';
import { Camera } from 'hull/render';
import { Gem } from './gem.ts';
import { Hud } from './hud.ts';
import { Level } from './level.ts';
import { CameraRig, Player } from './player.ts';
import { Round } from './round.ts';
import { arena, camera } from './tuning.ts';

// The order of spawns is the order of fixed updates: level and round first, then the player, then the gems and the
// camera, which both read where the player ended up this step.
export default defineGame({
  ready(game) {
    const w = game.world;
    w.spawn('level').add(Level);
    const round = w.spawn('round');
    round.add(Round);
    round.add(Hud);

    const me = w.spawn('player');
    me.position.set(0, 0, 0);
    me.add(Player);

    for (let i = 0; i < arena('gemCount'); i++) w.spawn(`gem${i}`).add(Gem);

    const eye = w.spawn('camera');
    eye.add(Camera, { fov: camera.fov });
    eye.add(CameraRig);
  },
});
