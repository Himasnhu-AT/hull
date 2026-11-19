// Game flow: the title flyover, Holdout (waves of titans, the Behemoth on wave 3), the Training Yard (cut every
// wooden dummy against the clock), Seal the Breach (escort the shifter's giant and the boulder to the breach),
// The Twelfth Sortie (missions/scout.ts), Free Flight, score and combos, and the in-game tutorial.
// Internal mode ids stay 'expedition' (Holdout), 'gate' (Seal the Breach) and 'scout' (The Twelfth Sortie).
import * as THREE from 'hull/three';
import * as keys from './keys';
import { GateMission } from './missions/gate';
import { ScoutMission } from './missions/scout';
import { MISSIONS, missionList, unlock } from './missions/index';
import { CAST, GIANT, MISSION, PLACE, TAGLINE } from './brand';
import { track, trackChapterDone, trackDeath, trackModeStart, trackMove, trackRescue, trackWave } from './analytics';
import type { Cuttable, Game as GameState, GameMode, HitPart, HitResult, SpawnRequest } from './types';
import { R, afterMs } from './sim';
export type { SpawnRequest };
import type { Player } from './player/player';
import { CFG } from './config';

type PlayMode = Exclude<GameMode, 'menu'>;
const SCORED = new Set<GameMode>(['expedition', 'gate', 'scout']);
// each mode's sky and light (world.setAtmosphere); a mission can pick its own per chapter
const ATMOSPHERE: Partial<Record<GameMode, string>> = { gate: 'varn' };

type SpawnArea = 'field' | 'forest' | 'town';
interface Wave { msg: string; field: number; forest: number; town: number; abnormal: number; sizes: [number, number]; behemoth?: boolean }
const WAVES: Wave[] = [
  { msg: 'WAVE 1 — TITANS IN THE FIELD', field: 4, forest: 0, town: 0, abnormal: 0, sizes: [4, 9] },
  { msg: `WAVE 2 — THEY'RE COMING OUT OF ${PLACE.forest.toUpperCase()}`, field: 3, forest: 3, town: 0, abnormal: 1, sizes: [5, 13] },
  { msg: 'WAVE 3', field: 2, forest: 0, town: 3, abnormal: 1, sizes: [4, 12], behemoth: true },
  { msg: `WAVE 4 — INTO ${PLACE.forest.toUpperCase()}`, field: 1, forest: 6, town: 0, abnormal: 2, sizes: [6, 15] },
];


/** The tutorial's running counters (what the player has done so far this step). */
interface TutorialState { step: number; t: number; doneT: number; steerT: number; boostT: number; payoutT: number; cuts: number; seen: Set<string> }
/** A hint the HUD shows: `keys` are action ids drawn as keycaps, `{action}` in text becomes that action's key. */
export interface Hint {
  id: string;
  keys: string[];
  text: string;
  done?: (p: Player, s: TutorialState) => boolean;
  when?: (p: Player) => boolean;
  modes?: GameMode[];
}

// Tutorial steps: each shows until the player has actually done it (or 14 s pass). Keys are actions (keys.ts) and
// {action} in the text becomes the player's key for it, so the hints follow any rebinding.
const STEPS: Hint[] = [
  { id: 'horse', keys: ['forward', 'gas'], text: 'On horseback: {forward} gallop, {strafeL} {strafeR} steer. {gas} stands up and leaps off; {ropeL} / {ropeR} fire a rope straight off the horse', done: (p) => !p.riding, when: (p) => !!p.riding },
  { id: 'rope', keys: ['ropeR'], text: 'Hold {ropeR} to fire your right rope at the {ropeR} marker', done: (p) => p.odm.attachedCount() > 0 },
  { id: 'zip', keys: ['ropeL', 'ropeR'], text: 'Hold {ropeL} and {ropeR} together to zip forward between both anchors', done: (p) => p.odm.attachedCount() === 2 },
  { id: 'steer', keys: ['left', 'right'], text: 'Turn with {left} / {right} or the mouse. Let go of {ropeL} / {ropeR} to fly free, then grab the next anchor', done: (p, s) => s.steerT > 0.6 },
  { id: 'gas', keys: ['gas'], text: 'Hold {gas} for a gas boost ({jump} jumps)', done: (p, s) => s.boostT > 0.6 },
  { id: 'cut', keys: ['jump'], text: 'In the air {jump} cuts. Hit the nape on the back of the neck, fast', done: (p, s) => s.cuts > 0, modes: ['training', 'expedition', 'gate'] },
  { id: 'aim', keys: ['left', 'right', 'skip'], text: 'Ropes go where you face: turn to put the marker on the tree you want. {skip} skips to the next anchor', done: (p, s) => s.steerT > 1.5 },
  { id: 'slack', keys: ['back'], text: 'On a rope, hold {back} to let the wire out for a longer swing', done: (p, s) => s.payoutT > 0.5 },
  { id: 'hang', keys: ['hang'], text: 'On a rope, {hang} locks the lines and you hang there: {forward} / {back} winch you up and down, {strafeL} {strafeR} swing', done: (p) => p.hang },
  { id: 'wallrun', keys: ['forward', 'jump'], text: 'Ropes off, meet a wall at an angle holding {forward}: you run along it. {jump} kicks you off', done: (p) => !!p.wallRun },
  { id: 'climb', keys: ['forward'], text: 'Run or fly square into a wall holding {forward}: you run up it, then climb ({strafeL} {strafeR} sideways, {back} down)', done: (p) => !!p.cling },
];

const NO_ANCHOR: Hint = { id: 'no-anchor', keys: ['forward', 'gas'], text: 'Nothing in rope range yet: run toward the trees or titans ({jump} jumps the parapet)' };

/** The Behemoth, as the cutscene reads it (titans/titan.ts). */
interface BreachTitan { dead: boolean; breach: { t: number; kicked: boolean } | null; finishBreach?(): void }
/**
 * The cutscene's cameras: from x, y, z looking at x, y, z, field of view, and the drift of the camera in m/s.
 * 0 the giant rising over the wall (from the Reach, low); 1 the kick, side on by the gate; 2 from inside the
 * town as the doors come in; 3 from high off the wall as it boils away; 4 the breach from the street, for the order.
 */
const CUT_SHOTS: readonly number[][] = [
  [62, 5, 104, 0, 40, 28, 52, -1.6, 0.5, -2.4],
  [-36, 8, 24, 0, 9, 9, 56, 1.2, 0.2, 0.6],
  [9, 4.5, -46, 0, 11, 2, 52, -0.4, 0.3, 1.8],
  [-78, 64, 52, 0, 34, 28, 48, 2, 0.6, -1],
  [-13, 3.2, -31, 0, 7.5, 4, 46, 0.5, 0.15, 0.8],
];
/** Stone dust (fx.steam's colours): pale grit thinning to grey. */
const DUST = [new THREE.Color(0xcfc6b6), new THREE.Color(0xb3aa9b), new THREE.Color(0x8f887c)];

const BEST_KEY = 'aott.trainingBest';
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* storage blocked: records just aren't kept */ } },
};

/** Event payloads this module listens for. */
interface KillEvent { titan?: Cuttable; by?: { name: string } | null }
interface HitEvent { damage: number; result?: (HitResult & { covered?: boolean; angle?: number; timing?: number }) | null; point: THREE.Vector3; part: HitPart | string; titan?: Cuttable }
interface DeathEvent { cause?: 'eaten' | 'struck' | 'fell' | string }
interface StepEvent { position?: THREE.Vector3; size?: number }
interface AllyEvent { ally: { name: string } }

/** A mission script driven by the flow (missions/gate.ts, missions/scout.ts). */
type Mission = GateMission | ScoutMission;

export class Game {
  g: GameState;
  gate: GateMission;
  scout: ScoutMission;
  /** Titans waiting to be built, one every 50 ms. */
  _spawnQ: SpawnRequest[] = [];
  _spawnT = 0;
  /** Which chapter of the current mission. */
  chapter = 0;
  wave = 0;
  score = 0;
  combo = 1;
  comboT = 0;
  /** Seconds until the next wave (Holdout). */
  waveClear = 0;
  /** Holdout never runs dry: seconds this wave has run (the next one comes on a clock too) and until the next straggler. */
  waveT = 0;
  trickleT = 0;
  /** Bumps on every start / menu, so delayed callbacks from an older run can tell they're stale. */
  run = 0;
  hint: Hint | null = null;
  tut: TutorialState = { step: 0, t: 0, doneT: 0, steerT: 0, boostT: 0, payoutT: 0, cuts: 0, seen: new Set() };
  startTime = 0;
  /** Holdout: the Behemoth has kicked the gate in. From then on the titans make for the town. */
  breached = false;
  /** The Behemoth at the gate, told as a cutscene: the titan, seconds in, which shot and how long it has run,
   *  seconds since the Behemoth went (-1: still there), and the titans stood still for it. */
  cut: { titan: BreachTitan; t: number; shot: number; st: number; after: number; held: { aiEnabled: boolean; alive: boolean }[] } | null = null;
  /** The Behemoth has appeared / been spawned this Holdout run. */
  behemoth = false;
  behemothSpawned = false;
  trainStart: number | null = null;
  trainEnd: number | null = null;
  trainSpeeds: number[] = [];

  constructor(game: GameState) {
    this.g = game;
    this.gate = new GateMission(this);
    this.scout = new ScoutMission(this);
    const ev = game.events;
    ev.on('titan:killed', (e: KillEvent) => this._onKill(e));
    ev.on('player:hit', (e: HitEvent) => this._onHit(e));
    ev.on('player:died', (e: DeathEvent) => this._onDeath(e));
    ev.on('titan:step', (e: StepEvent) => this._onStep(e));
    ev.on('training:cut', () => this._onCut());
    // 'behemoth' is the Behemoth's kind id
    ev.on('behemoth:appear', (e: { titan?: BreachTitan }) => {
      game.hud?.message?.(`${GIANT.behemoth.toUpperCase()} HAS APPEARED`, e?.titan?.breach ? 2.4 : 4.5, 'big');
      game.player.cam.trauma = 1;
      this.behemoth = true;
      if (e?.titan?.breach && game.mode === 'expedition') this._startCut(e.titan);
    });
    ev.on('gate:breached', (e: { position?: THREE.Vector3 }) => this._onBreach(e));
    ev.on('player:grabbed', () => game.hud?.message?.(keys.fill('GRABBED! MASH {jump} TO CUT FREE'), 2.2, 'warn'));
    ev.on('player:escaped', () => game.hud?.message?.('CUT FREE!', 1.2, 'info'));
    // the squad on the radio
    ev.on('ally:grabbed', (e: AllyEvent) => {
      game.hud?.feed?.(`It's got me — HELP!`, 'warn', e.ally.name);
      game.hud?.message?.(`${e.ally.name.toUpperCase()} IS GRABBED — CUT THE HAND OR THE NAPE!`, 2.6, 'warn');
    });
    ev.on('ally:freed', (e: AllyEvent) => {
      game.hud?.feed?.(this.g.player.alive ? 'Thanks — I owe you one!' : 'I\'m out!', 'radio', e.ally.name);
      if (SCORED.has(this.g.mode)) { this.score += 300; game.hud?.message?.('COMRADE SAVED  +300', 1.6, 'info'); }
    });
    ev.on('ally:eaten', (e: AllyEvent) => game.hud?.feed?.(`${e.ally.name} was eaten.`, 'warn'));
    ev.on('player:wireGrabbed', () => game.hud?.message?.(keys.fill('IT HAS YOUR WIRE! LET GO OR {jump} TO CUT'), 2, 'warn'));
    ev.on('player:wireCut', () => game.hud?.message?.('WIRE CUT', 1.1, 'info'));
    ev.on('player:shaken', () => game.hud?.message?.('SHAKEN OFF!', 1.2, 'warn'));
    ev.on('player:slapped', () => game.hud?.message?.('SWATTED OFF ITS NECK!', 1.2, 'warn'));
    ev.on('player:trampled', () => game.hud?.message?.('THROWN FROM THE SADDLE!', 1.6, 'warn'));
    ev.on('titan:windup', (e: { kind?: string }) => { if (e.kind === 'charge' && game.player?.riding) game.hud?.message?.('ABNORMAL CHARGING — BREAK AWAY!', 1.8, 'warn'); });
    ev.on('player:bladeBroken', () => game.hud?.message?.(game.player.spares > 0 ? 'Blades dull: swapping to a fresh pair' : 'NO BLADES LEFT: rest on the ground, a roof or a branch to fit new ones, or find a supply depot', game.player.spares > 0 ? 1.1 : 2.5, 'warn'));
    // Seal the Breach (src/missions/gate.ts). The speakers are the gate squad's names (gate.ts SQUAD).
    let lastHurt = -9;
    ev.on('carrier:hurt', (e: { carrier: { hp: number } }) => {
      const c = e.carrier;
      if (game.time - lastHurt > 7) { lastHurt = game.time; game.hud?.message?.(`THEY'RE ON ${CAST.shifter.toUpperCase()}: CUT THEM OFF HIM`, 2, 'warn'); }
      if (c.hp <= 50) this.gate._say(CAST.squadLeaderShort, `${CAST.shifter}'s taking a beating! Keep them off him!`);
      if (c.hp <= 25) this.gate._say(CAST.flareOfficer, 'He can\'t take much more!');
    });
    ev.on('carrier:down', () => this.gate.onDown());
    ev.on('carrier:sealed', () => this.gate.onSealed());
    ev.on('carrier:fallen', () => this.gate.onFallen());
    // the new moves, the first time each is used in a sitting (do players find them?), and every rescue
    ev.on('player:wallrun', (e: { start?: boolean }) => { if (e?.start) trackMove('wall_run', game.mode); });
    ev.on('player:runup', () => trackMove('wall_climb', game.mode));
    ev.on('player:hang', (e: { on?: boolean }) => { if (e?.on) trackMove('hang', game.mode); });
    ev.on('civilian:saved', (e: { total: number }) => trackRescue(game.mode, e.total));
    let lastNone = -9;
    ev.on('hook:none', () => {
      if (game.time - lastNone < 3) return;
      lastNone = game.time;
      game.hud?.message?.('Nothing to anchor to on that side: get closer to trees, buildings or titans', 2, 'info');
    });
  }

  // ---------------------------------------------------------------- modes
  toMenu(): void {
    const g = this.g;
    this.run++;
    g.mode = 'menu';
    g.paused = false;
    this._stopTraining();
    this.gate.dispose(); this.scout.dispose();
    g.world?.setGate?.(true); g.gateSealed = false; g.squadHome = null; this.breached = false;
    g.world?.rebuildTown?.();
    if (this.cut) { this.cut = null; g.cutscene = false; g.cine = null; }
    g.board?.end();
    g.world?.setAtmosphere?.('day');
    g.hud?.hideDeath?.(); g.hud?.hidePause?.(); g.hud?.hideTrainingResult?.();
    g.input.unlock?.();
    g.titans?.clear?.();
    g.civilians?.begin(null);
    this.hint = null;
    // a few titans wandering the field behind the menu for atmosphere
    this._spawnSome('field', 3, [5, 12], 0);
    g.audio?.setMusic?.(0.15);
    g.hud?.showMenu?.((mode: PlayMode, opts?: { chapter?: number }) => this.start(mode, opts), missionList());
  }

  /** Start a mode. opts.chapter: which chapter of a mission (MISSIONS in missions/index.ts). */
  start(mode: PlayMode, opts: { chapter?: number } = {}): void {
    const g = this.g;
    if (mode === 'training' && !g.training) mode = 'free';
    this.chapter = opts.chapter ?? 0;
    this.run++;
    g.hud?.hideMenu?.(); g.hud?.hideDeath?.(); g.hud?.hidePause?.(); g.hud?.hideTrainingResult?.();
    // every run is played full screen; this is called from the click or key that started it
    g.fullscreen?.();
    g.audio?.init?.();
    g.paused = false;
    g.mode = mode;
    trackModeStart(mode, this.chapter);
    g.titans?.clear?.();
    // people to save: stragglers in the Reach in Holdout, the townsfolk of Varn in Seal the Breach
    g.civilians?.begin(mode === 'expedition' ? { areas: ['field'], max: 5, townsfolk: 7 } : mode === 'gate' ? { areas: ['town'], max: 6, townsfolk: 0 } : null);
    for (const a of g.allies || []) a.revive?.();
    this._stopTraining();
    this.gate.dispose(); this.scout.dispose();
    // Holdout starts with the gate shut behind you: it stands until the Behemoth comes for it (wave 3)
    g.world?.setGate?.(mode !== 'expedition'); g.gateSealed = mode === 'expedition'; this.breached = false;
    g.world?.rebuildTown?.();
    if (this.cut) { this.cut = null; g.cutscene = false; g.cine = null; }
    // In Holdout the squad holds ground of its own (the Reach before the gate; later the gate and the streets
    // behind it): it hunts there whatever you do. Everywhere else it flies with you.
    g.squadHome = mode === 'expedition' ? new THREE.Vector3(0, 30, 95) : null;
    if (g.titans) g.titans.advance = mode === 'expedition';
    g.board?.begin(mode);
    g.world?.setAtmosphere?.(mode === 'scout' ? this.scout.atmosphere(this.chapter) : ATMOSPHERE[mode] || 'day');
    this.wave = 0; this.score = 0; this.combo = 1; this.comboT = 0; this.behemoth = false; this.behemothSpawned = false; this.waveClear = 0; this.waveT = 0; this.trickleT = 0;
    this.startTime = g.time;
    this._spawnQ = []; this._spawnT = 0;
    this.trainStart = null; this.trainEnd = null; this.trainSpeeds = [];

    // where you start: the wall top for Holdout, the forest edge for Free Flight, the course start for Training
    let sp: { position: THREE.Vector3; yaw?: number } = g.world?.playerSpawn || { position: new THREE.Vector3(0, 50.6, 0), yaw: 0 };
    if (mode === 'free') {
      const d = (g.world?.supplyDepots || []).filter((x) => x.position.z > 120).sort((a, b) => a.position.z - b.position.z)[0];
      if (d) sp = { position: d.position.clone(), yaw: 0 };
    }
    if (mode === 'gate') sp = this.gate.spawn();   // on a roof by the boulder, with the elite squad
    if (mode === 'scout') sp = this.scout.spawn(this.chapter);
    if (mode === 'training' && g.training) {
      g.training.start();
      g.trainingActive = true;
      if (g.training.spawn) sp = g.training.spawn;
      this.trainStart = g.time;
    }
    g.player.reset(sp.position.clone().add(new THREE.Vector3(0, 0.6, 0)), sp.yaw ?? 0);
    g.player.infiniteGas = !SCORED.has(mode);
    if (mode === 'training') g.player.spares = 99;

    // Holdout rides out like the Outriders: mounted, just outside the breached gate
    const herd = g.herd;
    if (mode === 'expedition' && herd?.horses?.length) {
      const h = herd.horses[0];
      h.pos.set(0, g.collision.groundHeight(0, 34), 34); h.yaw = 0; h.speed = 12; h.home.copy(h.pos);
      h.rider = g.player; g.player.riding = h; g.player.yaw = 0;
      h.saddle(g.player.pos); g.player.prev.copy(g.player.pos);
      // the squad rides out with you in a wedge, cloaks streaming
      const SLOTS: [number, number][] = [[-5, -4], [5, -4], [-10, -9], [10, -9], [0, -10], [-15, -14], [15, -14]];
      (g.allies || []).forEach((a, i) => {
        const hh = herd.horses[i + 1];
        if (!hh || !SLOTS[i]) return;
        const [sx, sz] = SLOTS[i];
        hh.pos.set(sx, g.collision.groundHeight(sx, 34 + sz), 34 + sz); hh.yaw = 0; hh.speed = 12; hh.home.copy(hh.pos);
        a.dismount?.(true);
        a.mount?.(hh, { x: -sx, z: sz });    // slot x is to the leader's right: world -x when facing +z
      });
    } else for (const a of g.allies || []) a.dismount?.(true);
    this._startTutorial();
    if (mode === 'expedition') {
      g.hud?.message?.(TAGLINE.toUpperCase(), 2.6, 'big');
      this.waveClear = 2.5; // first wave after the title card
      g.audio?.setMusic?.(0.5);
    } else if (mode === 'gate') {
      this.gate.start();
      g.civilians?.spawn(4);
    } else if (mode === 'scout') {
      this.scout.start(this.chapter);
    } else if (mode === 'training') {
      g.hud?.message?.(`${MISSION.training.toUpperCase()}: cut every dummy's nape. The clock is running.`, 3.5, 'info');
      g.audio?.setMusic?.(0.4);
    } else {
      g.hud?.message?.(`${MISSION.free.toUpperCase()}: ${PLACE.forest} is yours. Infinite gas.`, 3.5, 'info');
      g.audio?.setMusic?.(0.25);
    }
  }

  /**
   * A mission chapter is done: save the next chapter as open and show the result, with NEXT CHAPTER when there
   * is one. r: { title, win (false: the story goes on, it's not a defeat), delay (ms) }.
   */
  chapterDone(mode: 'gate' | 'scout', r: { title?: string; win?: boolean; delay?: number } = {}): void {
    const g = this.g, p = g.player, ch = this.chapter;
    const m = MISSIONS.find((x) => x.id === mode);
    const hasNext = m && ch + 1 < m.chapters.length;
    if (hasNext) unlock(mode, ch + 1);
    trackChapterDone(mode, ch);
    const run = this.run;
    afterMs(() => {
      if (this.run !== run) return;
      g.input.unlock?.();
      g.hud?.showDeath?.({ cause: r.title || 'CHAPTER COMPLETE', win: true, kills: p.stats.kills, score: this.score, time: Math.round(g.time - (this.startTime || 0)), retryLabel: 'PLAY AGAIN' },
        () => this.start(mode, { chapter: ch }), () => this.toMenu(), hasNext ? () => this.start(mode, { chapter: ch + 1 }) : null);
    }, r.delay ?? 2500);
  }

  _stopTraining(): void {
    const g = this.g;
    if (g.trainingActive) g.training?.stop?.();
    g.trainingActive = false;
  }

  _nextWave(): void {
    const g = this.g;
    const idx = this.wave;
    const w = WAVES[Math.min(idx, WAVES.length - 1)];
    const scale = 1 + Math.max(0, idx - WAVES.length + 1) * 0.35;
    this.wave++;
    this.waveT = 0; this.trickleT = 6;
    trackWave(this.wave);
    // each wave cuts more people off: out in the Reach, in Varn once titans are through the gate, at the forest edge
    g.civilians?.spawn(Math.min(4, 2 + (idx >> 1)), this.breached ? ['town'] : ['field']);
    g.hud?.message?.(idx >= WAVES.length ? `WAVE ${this.wave} — THE HORDE GROWS` : w.msg, 3, 'big');
    // the first wave walks right up to the wall: within rope range of the wall top, so you can zip down onto them
    // (once the gate is down they come up close to it, and some are already in the streets)
    this._spawnSome('field', Math.round(w.field * scale), w.sizes, Math.round(w.abnormal * scale * 0.5), idx === 0 ? { zMin: 45, zMax: 100, xMax: 85 } : this.breached ? { zMin: 45, zMax: 170, xMax: 130 } : null);
    this._spawnSome('forest', Math.round(w.forest * scale * (this.breached ? 0.5 : 1)), w.sizes, Math.round(w.abnormal * scale * 0.5));
    if (this.breached) this._spawnSome('town', Math.round((w.town + (w.forest ? Math.ceil(w.forest * 0.5) : 0)) * scale), w.sizes, 0);
    // the Behemoth comes on wave 3, then again every sixth wave if it isn't already standing at the wall
    // The Behemoth comes once: on wave 3, for the gate. It kicks it in and is gone, and it does not come back.
    const behemothWave = !!w.behemoth && !this.breached && idx < WAVES.length;
    if (behemothWave && !(g.titans?.titans || []).some((t: Cuttable) => t.alive && t.kind === 'behemoth')) {
      this.behemothSpawned = true;
      const run = this.run, breach = !this.breached;
      // only if this is still the same Holdout run (not a restart or another mode). 'behemoth': the Behemoth's kind id
      afterMs(() => { if (this.run === run && g.mode === 'expedition' && g.player.alive) g.titans?.spawn?.({ kind: 'behemoth', position: new THREE.Vector3(0, 0, 28), yaw: Math.PI, breach }); }, 3500);
    }
    g.audio?.setMusic?.(Math.min(1, 0.55 + this.wave * 0.12));
  }

  /** The Behemoth's kick has landed: the gate is gone, the titans turn for the town, and the squad goes in after them. */
  _onBreach(e: { position?: THREE.Vector3 }): void {
    const g = this.g;
    if (this.breached || g.mode !== 'expedition') return;
    this.breached = true;
    g.world?.setGate?.(true, true); g.gateSealed = false;
    // the doors go in: splinters, stone, dust, and the ground jumps
    const at = new THREE.Vector3(), n = new THREE.Vector3(0, 0.35, -1).normalize();
    for (let i = 0; i < 22; i++) {
      at.set((R.fx() - 0.5) * 15, R.fx() * 18, 4 - R.fx() * 12);
      g.fx?.impact?.(at, n, i % 3 ? 'wood' : 'stone');
      if (i % 3 === 0) g.fx?.steam?.(at, 5 + R.fx() * 5, 2.2);
    }
    // a wall of stone dust rolls down the tunnel and out into the street, and hangs there
    for (let i = 0; i < 16; i++) {
      at.set((R.fx() - 0.5) * 18, 1 + R.fx() * 14, 6 - R.fx() * 34);
      g.fx?.steam?.(at, 9 + R.fx() * 9, 4 + R.fx() * 3, DUST);
    }
    g.fx?.sparks?.(at.set(0, 9, 4), n, 40);
    g.audio?.titanFall?.(at.set(0, 8, 5), 45); g.audio?.impact?.(1);
    g.player.cam.trauma = 1; g.flash(0.45);
    if (!this.cut) this._callToArms();          // (in the cutscene the order comes at its end)
    g.titans?.setMarch(true);
    g.squadHome = new THREE.Vector3(0, 30, -45);
    g.civilians?.panic();
    g.audio?.setMusic?.(0.95);
    track('gate_breached', { wave: this.wave });
  }

  /** Your order to the squad, once the gate has gone: shouted, answered, and up on the objective bar from then on. */
  _callToArms(): void {
    const g = this.g;
    g.hud?.message?.(`THE GATE IS DOWN — HOLD IT, AND GET THE PEOPLE UP`, 5, 'big');
    g.hud?.feed?.(`Everyone into ${PLACE.town}! People onto the roofs, and hold that gate!`, 'radio', 'You');
    const live = (g.allies || []).filter((a) => a.alive && !a.grabbedBy);
    const say = ['On it!', `Roofs first — we've got them!`, 'Nothing gets past the gate!'];
    live.slice(0, 3).forEach((a, i) => afterMs(() => { if (g.mode === 'expedition' && a.alive) g.hud?.feed?.(say[i], 'radio', a.name); }, 900 + i * 800));
  }

  // ---------------------------------------------------------------- the Behemoth at the gate: a cutscene
  /**
   * The Behemoth has risen at the gate. The view leaves you for it: the giant over the wall, the kick, the doors
   * going in, the giant boiling away, then the breach with the titans coming and your order to the squad. You are
   * held where you are meanwhile (nothing can touch you) and the other titans stand still. Jump or cut skips it.
   */
  _startCut(titan: BreachTitan): void {
    const g = this.g, p = g.player;
    if (this.cut) return;
    const held = (g.titans?.titans || []).filter((t) => t !== (titan as unknown) && t.alive && t.aiEnabled) as unknown as { aiEnabled: boolean; alive: boolean }[];
    for (const t of held) t.aiEnabled = false;
    this.cut = { titan, t: 0, shot: -1, st: 0, after: -1, held };
    g.cutscene = true;
    g.cine = { shot: null, focus: null, bars: true };
    p.prev.copy(p.pos); p.odm.releaseAll(true);
    g.board?.show(false);
  }
  _endCut(): void {
    const g = this.g, C = this.cut;
    if (!C) return;
    this.cut = null;
    for (const t of C.held) if (t.alive) t.aiEnabled = true;
    g.cutscene = false; g.cine = null;
    g.hud?.hideSubtitle?.();
    g.player.grabImmune = Math.max(g.player.grabImmune, 2.5);
    if (this.breached) this._callToArms();
  }
  _cutscene(dt: number): void {
    const C = this.cut, g = this.g;
    if (!C) return;
    const b = C.titan, gone = !!b.dead || !b.breach;
    C.t += dt; C.st += dt;
    if (g.mode !== 'expedition' || !g.player.alive) { this._endCut(); return; }
    // jump / cut / Enter: enough of that
    if (C.t > 0.7 && (g.input.actHit('jump') || g.input.actHit('cut') || g.input.hit('Enter'))) { b.finishBreach?.(); this._endCut(); return; }
    const bt = b.breach ? b.breach.t : 99;
    if (gone && C.after < 0) { C.after = 0; }
    if (C.after >= 0) C.after += dt;
    const shot = C.after >= 0 ? 4 : bt < 1.45 ? 0 : bt < 3.95 ? 1 : bt < 5.5 ? 2 : 3;
    if (shot !== C.shot) {
      C.shot = shot; C.st = 0;
      if (shot === 4) g.hud?.subtitle?.('You', `Everyone into ${PLACE.town}! Get the people up onto the roofs — and hold that gate!`, 3.4);
    }
    const k = C.st;
    const S = CUT_SHOTS[shot];
    if (g.cine) g.cine.shot = {
      pos: (o) => o.set(S[0] + S[7] * k, S[1] + S[8] * k, S[2] + S[9] * k),
      look: (o) => o.set(S[3], S[4], S[5]),
      fov: S[6],
    };
    if (C.after > 3.4 || C.t > 16) this._endCut();
  }

  _spawnSome(area: SpawnArea, count: number, sizes: readonly number[], abnormals: number, box: { zMin: number; zMax: number; xMax: number } | null = null): void {
    const g = this.g;
    if (!g.titans?.spawn || count <= 0) return;
    const zones = (g.world?.titanSpawns || []).filter((z) => z.area === area);
    const FALLBACK: Record<SpawnArea, { center: THREE.Vector3; radius: number }> = { field: { center: new THREE.Vector3(0, 0, 100), radius: 70 }, forest: { center: new THREE.Vector3(0, 0, 260), radius: 120 }, town: { center: new THREE.Vector3(0, 0, -80), radius: 40 } };
    const fallback = FALLBACK[area];
    for (let i = 0; i < count; i++) {
      const z = zones.length ? zones[(R.sim() * zones.length) | 0] : fallback;
      const a = R.sim() * Math.PI * 2, r = Math.sqrt(R.sim()) * z.radius;
      const pos = new THREE.Vector3(z.center.x + Math.cos(a) * r, 0, z.center.z + Math.sin(a) * r);
      if (box) {
        pos.z = box.zMin + R.sim() * (box.zMax - box.zMin);
        pos.x = (R.sim() * 2 - 1) * box.xMax;
      }
      pos.y = g.collision.groundHeight(pos.x, pos.z);
      const h = sizes[0] + R.sim() * (sizes[1] - sizes[0]);
      // queued: building a titan takes milliseconds, so a wave arrives over a few frames instead of in one long hitch
      this._spawnQ.push({ kind: i < abnormals ? 'abnormal' : 'normal', height: h, position: pos, yaw: R.sim() * Math.PI * 2 });
    }
  }

  // ---------------------------------------------------------------- tutorial
  _startTutorial(): void {
    const t = this.tut;
    t.step = 0; t.t = 0; t.doneT = 0; t.steerT = 0; t.boostT = 0; t.payoutT = 0; t.cuts = 0;
    this.hint = null;
  }
  _tutorial(dt: number): void {
    const g = this.g, p = g.player, t = this.tut;
    if (!p.alive || g.mode === 'menu') { this.hint = null; return; }
    if (!p.grounded && p.turn) t.steerT += dt;
    if (p.boosting) t.boostT += dt;
    if (p.payout) t.payoutT += dt;
    // skip steps already learnt this session, and ones that don't apply to this mode
    const skip = (h: Hint) => t.seen.has(h.id) || (h.modes && !h.modes.includes(g.mode)) || (h.when && !h.when(p));
    while (t.step < STEPS.length && skip(STEPS[t.step])) t.step++;
    if (t.step >= STEPS.length) { this.hint = null; return; }
    const s = STEPS[t.step];
    if (t.doneT > 0) {
      t.doneT -= dt;
      if (t.doneT <= 0) { t.seen.add(s.id); t.step++; t.t = 0; this.hint = null; }
      return;
    }
    t.t += dt;
    if (t.t < 1.2) { this.hint = null; return; }   // let the title card breathe first
    this.hint = s;
    // nothing in rope range yet: say how to get somewhere that has anchors instead
    if ((s.id === 'rope' || s.id === 'zip') && !p.targets[0].valid && !p.targets[1].valid) {
      this.hint = NO_ANCHOR;
      t.t = Math.min(t.t, 10);   // don't time this step out while there's nothing to hook
    }
    if (s.done?.(p, t) || t.t > 15) t.doneT = 0.7;
  }

  // ---------------------------------------------------------------- events
  _onHit(e: HitEvent): void {
    const g = this.g;
    const { damage, result, point, part } = e;
    if (part === 'nape' || e.titan?.kind === 'dummy') this.tut.cuts++;
    if (!g.hud?.damageNumber) return;
    const sp = point.clone().project(g.camera);
    if (sp.z < 1) {
      const x = (sp.x * 0.5 + 0.5) * innerWidth, y = (-sp.y * 0.5 + 0.5) * innerHeight;
      g.hud.damageNumber(damage, x, y, !!result?.killed);
    }
    if (!result?.killed && part === 'nape' && result?.effect === 'shallow') {
      // say what went wrong: the angle, its shoulders, or the speed; and that the wound is there to finish
      const why: string = result.covered ? 'IT COVERED ITS NAPE: wait for the shoulders to drop'
        : (result.angle ?? 1) < 0.8 ? 'FROM THE SIDE: come round behind the neck and cut across it'
          : (result.timing ?? 1) < 0.65 ? 'MISTIMED: swing just as you reach it'
            : keys.fill('TOO SLOW: come in faster ({gas} on the rope)');
      g.hud?.message?.(e.titan?.kind === 'dummy' ? why : `WOUNDED — ${why}`, 1.8, 'warn');
    }
    if (result?.effect === 'blind') g.hud?.message?.('BLINDED', 1, 'info');
    if (result?.effect === 'cripple') g.hud?.message?.('LEG OFF: IT\'S DOWN', 1.2, 'info');
    if (result?.effect === 'sever') g.hud?.message?.('ARM OFF', 1, 'info');
  }

  _onKill(e: KillEvent): void {
    const g = this.g;
    const t = e.titan;
    const size = t?.kind === 'behemoth' ? GIANT.behemoth : `a ${Math.round(t?.height || 8)} m ${t?.kind === 'abnormal' ? 'abnormal' : 'titan'}`;
    if (e.by) { g.hud?.feed?.(`${e.by.name} took down ${size}`, 'kill'); if (SCORED.has(g.mode)) this.score += 150; return; }
    g.hud?.feed?.(`You took down ${size}`, 'kill');
    if (!SCORED.has(g.mode)) return;
    const p = g.player;
    if (this.comboT > 0) this.combo = Math.min(9, this.combo + 1); else this.combo = 1;
    this.comboT = 7;
    const base = t?.kind === 'behemoth' ? 5000 : Math.round(100 + (t?.height || 8) * 25);
    const speedBonus = Math.round(p.speed * 4);
    // holding the gate: one cut down in the breach is one that never reached the streets
    const atGate = g.mode === 'expedition' && this.breached && !!t && Math.abs(t.position.x) < 40 && Math.abs(t.position.z) < 45;
    this.score += (base + speedBonus + (atGate ? 250 : 0)) * this.combo;
    if (atGate) g.hud?.message?.('CUT DOWN AT THE GATE  +250', 1.4, 'info');
    p.stats.kills++;
    // a kill keeps you moving: gas back in the canisters and the reels pulling harder for a few seconds
    if (!p.infiniteGas) p.odm.gas = Math.min(1, p.odm.gas + CFG.flow.killGas);
    p.rush = CFG.flow.rush;
    if (this.combo > 1) g.audio?.combo?.(this.combo);
    if (t?.kind === 'behemoth') { g.hud?.message?.(`${GIANT.behemoth.toUpperCase()} HAS FALLEN`, 4, 'big'); g.hitstop = 0.4; }
    else if (this.combo > 1) g.hud?.message?.(`${this.combo}× COMBO`, 1.2, 'info');
  }

  _onCut(): void {
    const g = this.g;
    if (g.mode !== 'training') return;
    const p = g.player;
    this.trainSpeeds.push(p.speed);
    p.stats.kills++;
    this.score += Math.round(200 + p.speed * 6);
    const tr = g.training;
    const left = tr?.remaining ?? 0, total = tr?.total ?? 0;
    if (left > 0) g.hud?.message?.(`CUT! ${total - left} / ${total}`, 1.2, 'info');
    else this._finishTraining();
  }

  _finishTraining(): void {
    const g = this.g;
    if (this.trainEnd != null) return;
    this.trainEnd = g.time;
    const time = this.trainEnd - (this.trainStart ?? g.time);
    const prev = parseFloat(store.get(BEST_KEY) ?? '');
    const newBest = !(prev > 0) || time < prev;
    if (newBest) store.set(BEST_KEY, time.toFixed(2));
    const avg = this.trainSpeeds.length ? this.trainSpeeds.reduce((a, b) => a + b, 0) / this.trainSpeeds.length : 0;
    g.hud?.message?.('COURSE COMPLETE', 2.5, 'big');
    g.audio?.setMusic?.(0.2);
    const run = this.run;
    afterMs(() => {
      if (this.run !== run) return;
      g.input.unlock?.();
      g.hud?.showTrainingResult?.({ time, best: newBest ? time : prev, cuts: g.training?.total ?? 0, total: g.training?.total ?? 0, avgSpeed: avg * 3.6, newBest },
        () => this.start('training'), () => this.toMenu());
    }, 1400);
  }

  _onDeath(e: DeathEvent): void {
    const g = this.g;
    const mission: Mission | undefined = g.mode === 'gate' ? this.gate : g.mode === 'scout' ? this.scout : undefined;
    if (mission?.done) return;   // the result screen is already on its way
    if (mission) mission.done = true;
    const p = g.player;
    trackDeath(g.mode, e.cause ?? 'unknown', this.wave, { seconds: g.time - (this.startTime || 0), kills: p.stats.kills, score: this.score, saved: g.civilians?.saved || 0, topSpeed: p.stats.topSpeed * 3.6 });
    const CAUSES: Record<string, string> = { eaten: 'YOU WERE EATEN', struck: 'CRUSHED BY A TITAN', fell: 'YOU FELL' };
    const cause = CAUSES[e.cause ?? ''] || 'YOU DIED';
    g.audio?.setMusic?.(0.1);
    const run = this.run, mode = g.mode, chapter = this.chapter;
    afterMs(() => {
      if (this.run !== run) return;
      g.input.unlock?.();
      g.hud?.showDeath?.({ cause, kills: p.stats.kills, score: this.score, time: Math.round(g.time - (this.startTime || 0)), wave: this.wave, topSpeed: Math.round(p.stats.topSpeed * 3.6), retryLabel: mode === 'scout' && chapter > 0 ? 'FROM THE CHECKPOINT' : mission ? 'TRY AGAIN' : null },
        () => this.start(mode === 'menu' ? 'expedition' : mode, { chapter }), () => this.toMenu());
    }, e.cause === 'eaten' ? 1400 : 900);
  }

  _onStep(e: StepEvent): void {
    const p = this.g.player;
    if (!e?.position) return;
    const d = e.position.distanceTo(p.render);
    const s = (e.size || 8) / Math.max(8, d);
    p.cam.trauma = Math.min(1, p.cam.trauma + Math.min(0.35, s * s * 0.5));
  }

  // ---------------------------------------------------------------- per frame
  update(dt: number): void {
    const g = this.g;
    this.comboT -= dt;
    if (this.comboT <= 0) this.combo = 1;
    this._cutscene(dt);
    this._tutorial(dt);
    if (g.mode !== 'scout') this._spotting();   // (the Sortie has its own radio)
    if (this._spawnQ?.length && (this._spawnT -= dt) <= 0) {
      this._spawnT = 0.05;
      try { const q = this._spawnQ.shift(); if (q) { const t = g.titans?.spawn(q); q.then?.(t); } } catch (err) { console.warn('spawn failed', err); }
    }
    if (g.mode === 'expedition' && g.player.alive) {
      const ts = g.titans?.titans || [];
      const alive = ts.filter((t: Cuttable) => t.alive && t.kind !== 'behemoth').length;
      const behemothUp = ts.some((t: Cuttable) => t.kind === 'behemoth' && t.alive);
      if (this.waveClear > 0) {
        this.waveClear -= dt;
        if (this.waveClear <= 0) this._nextWave();
      } else if (alive === 0 && !this._spawnQ?.length && !(this.behemothSpawned && behemothUp)) {
        if (this.wave > 0) g.hud?.message?.(`WAVE ${this.wave} CLEARED`, 2.5, 'info');
        this.waveClear = 4;
      } else if (this.wave > 0) {
        // endless: the next wave marches on a clock even if some of this one are still standing, and stragglers keep
        // walking in between waves, up to a cap that grows with the wave number
        this.waveT += dt;
        const cap = Math.min(22, 6 + this.wave * 2);
        if (this.waveT > Math.max(45, 90 - this.wave * 4) && alive < cap) this._nextWave();
        else if ((this.trickleT -= dt) <= 0) {
          this.trickleT = Math.max(4, 12 - this.wave * 0.8);
          if (alive + (this._spawnQ?.length || 0) < cap) {
            const w = WAVES[Math.min(this.wave - 1, WAVES.length - 1)];
            const area: SpawnArea = R.sim() < 0.6 ? 'field' : R.sim() < 0.75 ? 'forest' : 'town';
            this._spawnSome(area, 1, w.sizes, R.sim() < 0.2 ? 1 : 0);
          }
        }
      }
    }
    // Holdout never runs out of soldiers either: a comrade who is lost is replaced from the wall after a while
    if (g.mode === 'expedition' && g.player.alive) for (const a of g.allies || []) {
      if (a.alive) { a._backT = 0; continue; }
      a._backT = (a._backT || 0) + dt;
      if (a._backT > 45) {
        a._backT = 0;
        a.revive(new THREE.Vector3((R.sim() < 0.5 ? -1 : 1) * (30 + R.sim() * 40), 53, 0));
        g.hud?.feed?.(`A fresh soldier drops in from the wall to take ${a.name}'s place`, 'radio');
      }
    }
    if (g.mode === 'gate' && g.player.alive) this.gate.update(dt);
    if (g.mode === 'scout' && g.player.alive) this.scout.update(dt);
    if (g.mode === 'training' && g.trainingActive && this.trainEnd == null && (g.training?.remaining ?? 1) === 0) this._finishTraining();
  }

  /** A comrade calls out each new titan as it comes within 110 m, by clock bearing from your heading. */
  _spotting(): void {
    const g = this.g, p = g.player;
    if (!p.alive || g.mode === 'training') return;
    const caller = (g.allies || []).find((a) => a.alive && !a.grabbedBy && !a.horse) || (g.allies || []).find((a) => a.alive && !a.grabbedBy);
    if (!caller) return;
    for (const t of g.titans?.titans || []) {
      if (!t.alive || t._spotted || t.kind === 'behemoth') continue;
      const dx = t.position.x - p.pos.x, dz = t.position.z - p.pos.z;
      if (dx * dx + dz * dz > 110 * 110) continue;
      t._spotted = true;
      const yaw = p.riding ? p.riding.yaw : p.yaw;
      let rel = Math.atan2(dx, dz) - yaw; rel = Math.atan2(Math.sin(rel), Math.cos(rel));   // + = to your left
      const hr = ((Math.round(-rel / (Math.PI / 6)) % 12) + 12) % 12 || 12;
      caller.radio(t.kind === 'abnormal' ? `Abnormal, ${hr} o'clock! Watch it!` : `Titan, ${hr} o'clock — ${Math.round(t.height)}-metre class!`);
      break;
    }
  }

  timer(): number | null {
    const g = this.g;
    if (g.mode !== 'training' || this.trainStart == null) return null;
    return (this.trainEnd ?? g.time) - this.trainStart;
  }
  trainingTargets(): { left: number; total: number } | null {
    const g = this.g;
    if (g.mode !== 'training' || !g.training) return null;
    return { left: g.training.remaining, total: g.training.total };
  }

  objective(): string {
    const g = this.g;
    if (g.mode === 'free') return `${MISSION.free.toUpperCase()} · fly ${PLACE.forest} · supply depots refill you`;
    if (g.mode === 'training') {
      const best = parseFloat(store.get(BEST_KEY) ?? '');
      return `${MISSION.training.toUpperCase()} · cut every dummy's nape${best > 0 ? ` · best ${best.toFixed(1)} s` : ''}`;
    }
    if (g.mode === 'gate') return this.gate.objective();
    if (g.mode === 'scout') return this.scout.objective();
    if (g.mode !== 'expedition') return '';
    const ts: Cuttable[] = (g.titans?.titans || []).filter((t: Cuttable) => t.alive);
    if (this.waveClear > 0 && this.wave > 0) return `Wave ${this.wave} cleared · next wave incoming${g.civilians?.summary() || ''}`;
    // nearest titan: distance and an arrow relative to where you're heading (↑ = straight ahead)
    const p = g.player;
    let near: Cuttable | null = null, nd = 1e9;
    for (const t of ts) { const d = t.position.distanceTo(p.render); if (d < nd) { nd = d; near = t; } }
    let guide = '';
    if (near) {
      const a = Math.atan2(near.position.x - p.render.x, near.position.z - p.render.z) - p.yaw;
      const rel = Math.atan2(Math.sin(a), Math.cos(a));               // > 0: to your left
      const arrows = ['↑', '↖', '←', '↙', '↓', '↘', '→', '↗'];
      guide = ` · nearest ${Math.round(nd)} m ${arrows[((Math.round(rel / (Math.PI / 4)) % 8) + 8) % 8]}`;
    }
    const inTown = this.breached ? ts.filter((t) => t.position.z < -6).length : 0;
    if (this.breached) {
      // the gate, from where you are: how far and which way (it is where they all come through)
      const ga = Math.atan2(-p.render.x, 4 - p.render.z) - p.yaw, gr = Math.atan2(Math.sin(ga), Math.cos(ga));
      const gd = Math.round(Math.hypot(p.render.x, p.render.z - 4));
      const arrows2 = ['↑', '↖', '←', '↙', '↓', '↘', '→', '↗'];
      const gate = gd > 45 ? ` · gate ${gd} m ${arrows2[((Math.round(gr / (Math.PI / 4)) % 8) + 8) % 8]}` : ' · AT THE GATE';
      return `HOLD THE GATE · WAVE ${this.wave} · Titans: ${ts.length} (${inTown} in ${PLACE.town})${gate}${g.civilians?.summary() || ''}`;
    }
    return `WAVE ${this.wave} · Titans: ${ts.length}${guide}${g.civilians?.summary() || ' · Cut the nape'}`;
  }
}
