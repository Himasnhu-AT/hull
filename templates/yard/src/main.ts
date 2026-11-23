import { Behaviour, defineGame, probe, type Node, type World } from 'hull';
import { Camera, teleported } from 'hull/render';
import { AimFollow, FollowCamera, GROUP, Health, Hud, Interactable, Interactor, Inventory, LAYER, Level, NavGrid, Objectives, PauseMenu,
  ResultScreen, SaveSlots, ThirdPerson, TitleScreen, Weapon, scatterPickups, spawnGrunt, type LevelMarker } from 'hull/kits';

// Relic Yard: carry three relics to the altar while sentries hunt you. The world is config/level/yard.json; every rule
// below is a kit wired the way its README says, plus about thirty lines of this game's own: the player, the sentries,
// and what taking and placing a relic mean. Spawn order is fixed-update order: title, pause, then the world.
const HOME = 3;
const RESPAWN = 10;

/** A relic hides while its Interactable is off, so a loaded save shows the same yard it saved. */
class Relic extends Behaviour {
  override fixedUpdate(): void { this.node.object3d.visible = this.node.get(Interactable)!.enabled; }
}

function spawnPlayer(w: World, at: LevelMarker): Node {
  const me = w.spawn('player');
  me.position.set(at.x, 0, at.z);
  me.add(Health, { max: 100, hp: 100 });
  const tp = me.add(ThirdPerson, { character: 'character/soldier' });
  const cam = w.spawn('camera');
  cam.add(Camera, { fov: 60 });
  cam.add(FollowCamera);
  const aim = w.spawn('aim', me); // forward of the swing and of the interact search: the way the body faces
  aim.add(AimFollow, { source: tp });
  aim.add(Weapon, { action: 'attack', damage: 40, range: 2.4, rate: 2.5, radius: 0.7, height: 1.1, sound: 'sound/swing', mask: LAYER.world | LAYER.enemy })
    .fired.connect(() => tp.animator?.trigger('attack'), aim);
  aim.add(Interactor, { height: 1.1 });
  return me;
}

export default defineGame({
  ready(game) {
    const w = game.world;
    const title = w.spawn('title').add(TitleScreen, { title: 'Relic Yard', subtitle: 'Carry three relics to the altar. Sentries hunt you.' });
    const results = w.spawn('results').add(ResultScreen);
    w.spawn('pause').add(PauseMenu);
    w.spawn('saves').add(SaveSlots);

    const level = w.spawn('level').add(Level, { level: 'yard' });
    w.spawn('nav').add(NavGrid, { bounds: level.bounds }); // after the level: it bakes the level's solids
    const start = level.marker('start')!;
    const me = spawnPlayer(w, start);
    const hp = me.get(Health)!;
    const bag = me.add(Inventory, { capacity: 1, stack: 2 });
    scatterPickups(w, level, 'health', 3, { amount: 30, respawn: 20 });

    const goals = w.spawn('objectives').addTo(GROUP.save).add(Objectives);
    const openGoals = (): void => { goals.add('relics', 'Carry the relics home', { count: HOME }); };
    openGoals();
    const home = (): number => goals.get('relics')?.have ?? 0;
    let t0 = 0;
    let epoch = 0; // a sentry waiting to come back belongs to one run; Play again starts a new one
    const hud = w.spawn('hud').add(Hud);
    const score = (): number => home() * 100 + bag.count('relic') * 25;
    hud.score(score).timer(() => w.time - t0, { countDown: false }).bar('Health', () => hp.hp, hp.max);

    const relics = level.things('prefab/relic');
    relics.forEach((n, i) => {
      n.name = 'relic' + i; // saves match nodes by name
      n.add(Relic);
      const it = n.add(Interactable, { prompt: 'Take the relic', once: true, radius: 1.8, height: 0.7 });
      it.used.connect(() => { if (bag.add('relic') > 0) hud.message('Now reach the altar', 2); else it.enabled = true; });
    });
    const altar = level.things('prefab/altar')[0]!.add(Interactable, { prompt: 'Place a relic', radius: 2.5, height: 0.8 });
    altar.used.connect(() => { if (bag.remove('relic')) goals.progress('relics'); else hud.message('Find a relic first', 2); });

    const sentries = level.markers('sentry/');
    const sendSentry = (m: LevelMarker): void => {
      const run = epoch;
      const s = spawnGrunt(w, m.x, m.z, 1); // a Chaser: it walks the NavGrid's paths around the yard
      s.get(Health)!.died.connect(() => w.after(RESPAWN, () => { if (run === epoch) sendSentry(m); }));
    };
    sentries.forEach(sendSentry);

    const finish = (won: boolean): void => { results.show(won, { Time: Math.round(w.time - t0), Relics: home(), Health: Math.round(hp.hp) }); };
    goals.allDone.connect(() => finish(true));
    hp.died.connect(() => finish(false));
    title.begun.connect(() => { t0 = w.time; hud.message('Find the relics', 3); });
    results.again.connect(() => {
      epoch++;
      me.position.set(start.x, 0, start.z);
      teleported(me);
      hp.revive();
      bag.clear('relic');
      for (const r of relics) r.get(Interactable)!.enabled = true;
      goals.remove('relics');
      openGoals();
      for (const e of [...w.group(GROUP.enemy)]) e.destroy();
      sentries.forEach(sendSentry);
      t0 = w.time;
    });

    probe('score', score);
    probe('relicsHome', home);
    probe('carrying', () => bag.count('relic'));
    probe('hp', () => hp.hp);
    probe('sentries', () => w.group(GROUP.enemy).length);
  },
});