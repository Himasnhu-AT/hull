import { defineGame } from '../../core/index.ts';
import { ResultScreen, TitleScreen } from './menu.ts';

/** Bench scene: the title holds the game until Start; the result screen opens after ten seconds of play. */
export default defineGame({
  ready(g) {
    g.world.spawn('title').add(TitleScreen, { title: 'Bench Run', subtitle: 'Reach ten seconds' });
    const result = g.world.spawn('results').add(ResultScreen);
    result.again.connect(() => { g.world.after(10, () => result.show(true, { Time: '10 s' })); });
    g.world.after(10, () => result.show(true, { Time: '10 s', Kills: 0 }));
  },
});
