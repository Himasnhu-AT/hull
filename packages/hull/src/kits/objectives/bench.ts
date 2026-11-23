import { defineGame } from '../../core/index.ts';
import { GROUP } from '../common.ts';
import { Hud } from '../hud/hud.ts';
import { Objectives } from './objectives.ts';

/** Bench scene: three goals on the HUD; the scenario counts gems and opens a door. */
export default defineGame({
  ready(g) {
    g.world.spawn('hud').add(Hud);
    const node = g.world.spawn('objectives').addTo(GROUP.save);
    const o = node.add(Objectives);
    o.add('gems', 'Collect the gems', { count: 5 });
    o.add('door', 'Open the door');
    o.add('exit', 'Reach the exit');
  },
});
