// The AOTT host: what main.ts was in the standalone game, minus everything Hull owns. It builds the shared `game`
// object, loads each subsystem (a module that fails is logged and left null, as before), and runs the whole frame as one
// fixed step of the Hull loop at 120 Hz: input, the soldier's physics, titans, comrades, civilians, the flow, effects,
// the camera. So `game.step(n)` (the dev control port, the headless tests) plays exactly n steps of the game.
//
// What Hull owns now: the renderer and its frame loop (mountRender), the tone mapping, exposure, sky light and post
// chain (config/look/*.json), the devices and the key map (hull/input), the AudioContext (hull/audio). The game's own
// three.js scene hangs under a SceneObject; its camera is the Hull Camera's. The browser-only parts (HUD, effects,
// sound, pointer lock) are skipped when there is no document, so a Node run plays the same simulation.
import { Behaviour, type Game as HullGame, type Node } from 'hull';
import type { AudioView } from 'hull/audio';
import { input as hullInput, type InputView } from 'hull/input';
import { Camera, SceneObject, backendScene } from 'hull/render';
import * as THREE from 'hull/three';
import { CFG } from './config';
import { Input } from './input';
import * as keys from './keys';
import { CollisionWorld } from './core/collision';
import { Player } from './player/player';
import type { PlayerModel } from './player/model';
import { Game as Flow } from './game';
import { litMaterial } from './core/style';
import { installAerialFog } from './core/look';
import { FS } from './world/terrain';
import { Digest } from './digest';
import { R, bindWorld } from './sim';
import type { Game, GameEvents, GameMode, HitTestHit, HudState, NapeMarker, HookTargetMarker, ThreatMarker, WorldHandle } from './types';

type Handler = (payload?: any) => void;
class Events implements GameEvents {
  map = new Map<string, Handler[]>();
  on(n: string, f: Handler): void { let a = this.map.get(n); if (!a) this.map.set(n, a = []); a.push(f); }
  off(n: string, f: Handler): void { const a = this.map.get(n); if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } }
  emit(n: string, p?: unknown): void { const a = this.map.get(n); if (a) for (const f of a.slice()) { try { f(p); } catch (e) { console.error(n, e); } } }
}

/** True in Node: no document, so no HUD, effects, sound or pointer lock. */
const HEADLESS = typeof document === 'undefined';

/** What a start asks for. A browser reads the page's query (`?play=expedition&notitans`); a test passes its own. */
export interface BootOptions {
  /** A mode to start at once instead of the title ('expedition', 'gate', 'scout', 'training', 'free'). */
  play?: string;
  noTitans?: boolean;
  /** Dev check of the look's post: `?fx=speed` holds the speed cue at full, `?fx=impact` holds the hit pulse. */
  fx?: string;
  noAllies?: boolean;
  noHorses?: boolean;
  noCivilians?: boolean;
  /** How many comrades (0 to 5). */
  allies?: number;
  /** Mouse sensitivity multiplier. */
  sens?: number;
}

/** Where the headless tests put the input they drive (a Hull InputCore); a browser leaves it null and uses the mounted one. */
export const hub: { view: InputView | null; options: BootOptions; audio: AudioView | null } = { view: null, options: {}, audio: null };

function queryOptions(): BootOptions {
  if (HEADLESS || typeof location === 'undefined') return {};
  const p = new URLSearchParams(location.search);
  return {
    ...(p.has('play') ? { play: p.get('play') ?? '' } : {}),
    ...(p.has('fx') ? { fx: p.get('fx') ?? '' } : {}),
    noTitans: p.has('notitans'), noAllies: p.has('noallies'), noHorses: p.has('nohorses'), noCivilians: p.has('nocivilians'),
    ...(p.has('allies') ? { allies: +(p.get('allies') ?? 5) } : {}),
    sens: +(p.get('sens') || 1),
  };
}

function isPlaying(mode: string): mode is Exclude<GameMode, 'menu'> {
  return mode === 'expedition' || mode === 'gate' || mode === 'scout' || mode === 'free' || mode === 'training';
}

interface HullViews { render?: { setLook(id: string): void; setQuality(q: 'low' | 'medium' | 'high'): void; setPixelRatioCap(c: number): void; setSpeed(v: number): void; impact(at?: readonly [number, number, number] | null, strength?: number): void; cancelImpact(): void; holdImpact(k: number | null, at?: readonly [number, number, number] | null): void }; audio?: AudioView }
const views = (): HullViews | undefined => (globalThis as { hull?: HullViews }).hull;

const STEP = 1 / CFG.physicsHz;
const QUALITY_NAMES = ['LOW', 'MEDIUM', 'HIGH'] as const;
const QUALITY_TIERS = ['low', 'medium', 'high'] as const;
const _n = new THREE.Vector3();
const _tp = new THREE.Vector3(), _cf = new THREE.Vector3(), _cr = new THREE.Vector3(), _cu = new THREE.Vector3();
const _hookTargets: HookTargetMarker[] = [{ x: 0, y: 0, visible: false, valid: false, attached: false }, { x: 0, y: 0, visible: false, valid: false, attached: false }];
const _threats: ThreatMarker[] = [];
const _markers: NapeMarker[] = [];

async function load<M, T>(imp: () => Promise<M>, fn: (m: M) => T | Promise<T>): Promise<T | null> {
  try { const m = await imp(); return await fn(m); }
  catch (e) { console.error('[module failed]', imp.toString(), e); return null; }
}

/** The Hull behaviour that is the game: one per run, on the node `aott`. */
export class AottHost extends Behaviour {
  // The checksum sees this: a digest of the simulation that lives outside Hull's nodes.
  static override state = ['digest'] as const;
  digest = 0;

  g!: Game;
  private acc = 0;
  private fpsT = 0;
  private frames = 0;
  private qualityApplied = false;
  private keysAttached = false;
  private camera!: Camera;
  private readonly sum = new Digest();
  private opts: BootOptions = {};

  /** Builds the game object and every subsystem; resolves when the run can start stepping. */
  async boot(hull: HullGame, node: Node): Promise<void> {
    const opts = this.opts = { ...queryOptions(), ...hub.options };
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9cc4e4);
    scene.fog = new THREE.Fog(0xa9c6dc, 200, 1500);
    node.add(SceneObject, { object: scene });

    // The soldier's camera is the Hull Camera's: the game moves it, the render bridge draws through it.
    const eye = hull.world.spawn('camera');
    this.camera = eye.add(Camera, { fov: CFG.cam.fov, near: 0.1, far: 4000 });
    const camera = this.camera.view!;

    const game = {
      scene, camera, hull, events: new Events(), time: 0, mode: 'menu', hitstop: 0,
      collision: new CollisionWorld(hull.world), settings: { sens: opts.sens || 1, invertY: false },
      fx: null, impactFrame: null, audio: null, hud: null, titans: null, training: null,
      trainingActive: false, allies: [], herd: null, quality: 2,
    } as unknown as Game;
    this.g = game;
    game.input = new Input(hub.view ?? hullInput);
    if (!HEADLESS) {
      installAerialFog();
      (window as unknown as { game: Game }).game = game;   // handy for debugging; tests go through the control port
      (window as unknown as { cfg: typeof CFG }).cfg = CFG;   // the live tunables, to read a value back from the console
      const fl = document.createElement('div');
      fl.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:3;mix-blend-mode:screen';
      document.body.appendChild(fl);
      let a = 0, raf = 0;
      const fade = () => { a *= 0.82; fl.style.opacity = a.toFixed(3); if (a > 0.01) raf = requestAnimationFrame(fade); else { fl.style.opacity = '0'; raf = 0; } };
      game.flash = (k = 0.5) => { a = Math.max(a, k); fl.style.opacity = a.toFixed(3); if (!raf) raf = requestAnimationFrame(fade); };
    } else game.flash = () => {};
    game.fps = 120;

    // ---- fallback pieces (used only if a module is missing)
    const fallbackWorld = (): WorldHandle => {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), litMaterial(0x6f9a4a, { roughness: 0.95 }));
      g.receiveShadow = true; scene.add(g);
      game.collision.setGround(() => 0);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2400, 50, 12), litMaterial(0xb8ab92, { roughness: 0.95 }));
      wall.position.set(0, 25, 0); scene.add(wall);
      game.collision.addBox({ center: new THREE.Vector3(0, 25, 0), halfExtents: new THREE.Vector3(1200, 25, 6), material: 'stone' });
      return {
        playerSpawn: { position: new THREE.Vector3(0, 50.5, 0), yaw: 0 }, supplyDepots: [{ position: new THREE.Vector3(40, 51, 0), radius: 4 }],
        titanSpawns: [], fogColor: new THREE.Color(0xa9c6dc), update() {},
      };
    };
    const fallbackModel = (): PlayerModel => {
      const root = new THREE.Group();
      root.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.0, 4, 8), litMaterial(0x7a5a3a)));
      scene.add(root);
      const model = {
        root, hookOrigin: null,
        update(_dt: number, s: { position: THREE.Vector3; forward: THREE.Vector3 }) { root.position.copy(s.position); root.lookAt(root.position.clone().add(s.forward)); },
      };
      return model as unknown as PlayerModel;
    };

    // ---- boot
    game.world = (await load(() => import('./world/world'), (m) => m.buildWorld(game) as WorldHandle)) || fallbackWorld();
    {
      // each atmosphere (Seal the Breach's smoke, the Sortie's dawn) is a look of its own: Hull bakes its sky light from it
      const world = game.world;
      const setAtmosphere = world.setAtmosphere?.bind(world);
      // the nape cut's hit moment is the engine's impact pulse (real time, so hit-stop does not freeze it)
      game.impactFrame = {
        get active() { return false; },
        trigger(position, strength = 1) { views()?.render?.impact(position ? [position.x, position.y, position.z] : null, strength); },
        cancel() { views()?.render?.cancelImpact(); },
      };
      if (setAtmosphere) world.setAtmosphere = (kind: string) => { setAtmosphere(kind); views()?.render?.setLook(`look/${kind}`); };
    }
    if (!HEADLESS) {
      game.fx = await load(() => import('./fx/effects'), (m) => new m.Effects(game));
      game.hud = await load(() => import('./ui/hud'), (m) => new m.Hud(game));
    }
    // sound: every call goes to Hull's audio (recipes in config/sound, the mix in config/mixer/main.json). A Node run has none
    // unless a test hands in a view to record the plays (hub.audio). A page that asks for sound before Hull has mounted its
    // audio waits for the first frame (update() below).
    if (!HEADLESS || hub.audio) game.audio = await load(() => import('./audio/audio'), (m) => new m.Audio(() => hub.audio ?? views()?.audio));
    game.titans = opts.noTitans ? null : await load(() => import('./titans/titans'), (m) => new m.TitanManager(game));
    game.training = await load(() => import('./titans/dummies'), (m) => new m.TrainingCourse(game));
    game.trainingActive = false;
    // everything that can be cut (titans + training dummies), and one hit test over all of it
    const _targets: ReturnType<Game['targetList']> = [];
    game.targetList = () => {
      _targets.length = 0;
      for (const t of game.titans?.titans || []) _targets.push(t);
      if (game.trainingActive) for (const t of game.training?.titans || []) _targets.push(t);
      return _targets;
    };
    game.hitTest = (c, r) => {
      const a: HitTestHit[] = game.titans?.hitTest?.(c, r) || [];
      if (game.trainingActive && game.training?.hitTest) { const b = game.training.hitTest(c, r); if (b?.length) return [...a, ...b]; }
      return a;
    };

    game.player = new Player(game);
    game.player.model = (await load(() => import('./player/model'), (m) => {
      const pm = new m.PlayerModel(game); pm.autoGas = false;
      if (pm.root && !pm.root.parent) scene.add(pm.root);
      return pm;
    })) || fallbackModel();
    game.flow = new Flow(game);

    game.herd = opts.noHorses ? null : await load(() => import('./player/horse'), (m) => new m.Herd(game));
    game.allies = [];
    if (!opts.noAllies) await load(() => import('./player/ally'), async (am) => {
      const mm = await import('./player/model');
      const starts: [number, number, number][] = [[-40, 55, 150], [30, 70, 230], [-80, 45, 300], [90, 60, 190], [0, 80, 360]];
      starts.slice(0, opts.allies ?? 5).forEach(([x, y, z], i) => {
        const model = new mm.PlayerModel(game);
        model.autoGas = false;
        if (model.root && !model.root.parent) scene.add(model.root);
        game.allies.push(new am.Ally(game, model, new THREE.Vector3(x, y, z), i * 1.37 + 0.5));
      });
    });

    game.civilians = opts.noCivilians ? null : await load(() => import('./npc/civilians'), (m) => new m.Civilians(game));
    if (!HEADLESS) game.board = await load(() => import('./ui/board'), (m) => new m.Board(game));

    if (!HEADLESS) this.wireBrowser(game);
    this.wireQuality(game);
    game.showControls = true;

    const play = opts.play;
    if (play !== undefined) game.flow.start(isPlaying(play) ? play : 'free');
    else game.flow.toMenu();
    if (!HEADLESS) (window as unknown as { stepGame: (dt: number) => void; READY: boolean }).stepGame = (dt) => hull.step(Math.max(1, Math.round(dt * CFG.physicsHz)));
    if (!HEADLESS) (window as unknown as { READY: boolean }).READY = true;
  }

  /** Full screen, pointer lock, pause and the few keys the HUD does not own. DOM only. */
  private wireBrowser(game: Game): void {
    type FsDoc = Document & { webkitFullscreenElement?: Element | null };
    type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
    const isFull = () => !!(document.fullscreenElement || (document as FsDoc).webkitFullscreenElement);
    const params = new URLSearchParams(location.search);
    let embedded = false;
    try { embedded = window.self !== window.top; } catch { embedded = true; }
    game.fullscreen = () => {
      // the whole page, not the canvas: the HUD is a sibling of it and would be left behind
      const el = document.documentElement as FsEl;
      // Inside Hull's app the game is a panel of the editor: taking the whole screen would hide the Inspector.
      if (isFull() || params.has('window') || embedded) return;
      try {
        if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => { /* refused */ });
        else el.webkitRequestFullscreen?.();
      } catch { /* refused */ }
    };
    const resume = () => { game.paused = false; game.hud?.hidePause?.(); game.fullscreen?.(); };
    const pause = () => { if (!isPlaying(game.mode) || !game.player.alive || game.paused) return; game.paused = true; game.hud?.showPause?.(resume); };
    game.pause = pause; game.resume = resume;
    game.input.onLockChange = (locked) => { if (!locked) pause(); };
    game.input.onLockDenied = () => game.hud?.message?.('Mouse look is not available here: the arrow keys steer', 3, 'info');
    const surface = document.getElementById('app') ?? document.body;
    surface.addEventListener('click', () => {
      if (isPlaying(game.mode) && !game.paused) game.fullscreen?.();
      if (isPlaying(game.mode) && !game.paused && !game.input.locked && !game.input.lockDenied && game.player.alive) game.input.lock();
    });
    // the free-cursor fallback turns while the cursor is pushed against an edge
    addEventListener('mousemove', (e) => { game.input.cx = e.clientX; game.input.cy = e.clientY; game.input.inside = true; });
    document.addEventListener('mouseleave', () => { game.input.inside = false; });
    // Esc leaves full screen (the browser's rule, not ours). That pauses, and resuming goes back in.
    const onFullChange = () => { if (!isFull()) pause(); };
    document.addEventListener('fullscreenchange', onFullChange);
    document.addEventListener('webkitfullscreenchange', onFullChange);
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const act = keys.actionOf(keys.keyName(e));
      if (act === 'mute') game.audio?.toggleMute?.();
      if (act === 'card') game.showControls = !game.showControls;
      if (act === 'board') game.board?.toggle();
      if (e.code === 'Escape' && game.board?.open) game.board.show(false);
      if ((e.code === 'Escape' || act === 'pause') && isPlaying(game.mode)) { if (game.paused) resume(); else pause(); }
      if (act === 'quality') { game._qualityLocked = true; game.setQuality((game.quality + 2) % 3); }
    });
    addEventListener('blur', () => pause());
  }

  /** Quality: 2 high, 1 medium, 0 low. Picked automatically from the frame rate in the first seconds of play (only ever stepping down), and G cycles it. */
  private wireQuality(game: Game): void {
    // The engine's tiers own shadows (none on low), the shadow map's size and the post chain; the look owns the shadow range.
    const Q: { ratio: number; allyRange: number }[] = [
      { ratio: 0.75, allyRange: 120 },
      { ratio: 1, allyRange: 180 },
      { ratio: HEADLESS ? 1 : Math.min(devicePixelRatio, 1.75), allyRange: 260 },
    ];
    game.setQuality = (q, say = true) => {
      q = Math.max(0, Math.min(2, q)); game.quality = q;
      const cfg = Q[q];
      const r = views()?.render;
      r?.setQuality(QUALITY_TIERS[q]);
      r?.setPixelRatioCap(cfg.ratio);
      game.allyRange = cfg.allyRange;
      if (say) game.hud?.message?.(`GRAPHICS: ${QUALITY_NAMES[q]}${say === 'auto' ? ` (auto, ${keys.label('quality')} to change)` : ''}`, 2, 'info');
    };
    game.setQuality(2, false);
    let autoT = 0, autoN = 0, autoSum = 0;
    game.autoQuality = (dt, playing) => {
      if (!playing || game.paused || game._qualityLocked || autoT > 12) return;
      autoT += dt;
      if (autoT < 2) return;                 // let shaders and the first wave settle
      autoSum += dt; autoN++;
      if (autoN >= 120) {
        const fps = autoN / autoSum;
        autoN = 0; autoSum = 0;
        if (fps < 42 && game.quality > 0) game.setQuality(game.quality - 1, 'auto');
      }
    };
  }

  /**
   * One step of the game, at 120 Hz. This is the whole AOTT frame: hit-stop and slow motion scale the game's own
   * time, the soldier's input is read once, the soldier's physics runs once per whole unit of that time, everything else
   * updates with the scaled step, then the camera has moved to where the picture will be drawn.
   */
  override fixedUpdate(dt: number): void {
    const game = this.g;
    if (!game?.flow) return;   // still booting
    const { player, input } = game;
    game._frameDt = dt;
    input.begin();
    if (game.paused) { game.board?.update(dt); this.finish(); return; }

    // kill moment: a freeze-frame (hit-stop), then a short slow-motion that eases back to full speed
    let simDt = dt;
    if (game.hitstop > 0) { game.hitstop -= dt; simDt = dt * 0.1; }
    else if ((game.slowmo ?? 0) > 0) {
      game.slowmo = (game.slowmo ?? 0) - dt;
      const d = game.slowmoDur || 0.4;
      simDt = dt * (0.22 + 0.78 * Math.pow(1 - Math.max(0, game.slowmo) / d, 2));
    }
    if (game.killCam) { game.killCam.t += dt; if (game.killCam.t >= game.killCam.dur) game.killCam = null; }
    game.time += simDt;

    const playing = isPlaying(game.mode);
    if (!HEADLESS) input.edgeTurn(dt, innerWidth, innerHeight);
    input.freeLook = playing && !input.locked && input.lockDenied && player.alive;
    if (playing && !game.cutscene) player.handleInput(input, dt);
    this.acc += simDt;
    let n = 0;
    while (this.acc >= STEP - 1e-12 && n < 12) {
      if (playing && !game.cutscene) player.fixedUpdate(STEP);
      for (const a of game.allies) a.fixedUpdate(STEP);
      game.herd?.fixedUpdate(STEP);
      this.acc -= STEP; n++;
    }
    if (this.acc < 0) this.acc = 0;
    if (n === 12) this.acc = 0;
    // with whole steps (normal time) the newest state is what is drawn; in slow motion the leftover blends the last two
    const alpha = simDt >= dt ? 1 : Math.min(1, this.acc / STEP);
    try { game.titans?.update(simDt); } catch (e) { console.error('titans.update', e); game._titanErr = (game._titanErr || 0) + 1; if (game._titanErr > 5) game.titans = null; }
    if (game.trainingActive) { try { game.training?.update(simDt); } catch (e) { console.error('training.update', e); } }
    game.collision.updateDynamic();
    if (playing) player.update(simDt, alpha);
    else this.menuCamera();
    game.world?.setFoliageFocus?.(playing ? player.render : null);
    for (const a of game.allies) a.update(simDt, alpha);
    game.herd?.update(simDt);
    try { game.civilians?.update(simDt); } catch (e) { console.error('civilians.update', e); }
    game.board?.update(dt);
    game.flow.update(simDt);
    try { game.fx?.update(simDt); } catch (e) { console.error('fx.update', e); }
    const camera = game.camera;
    try { game.world?.update?.(simDt, camera.position); } catch (e) { console.error('world.update', e); }
    // the Greatwood breathes: leaves drift down around you under the canopy
    if (game.fx?.leaves && camera.position.z > 190 + FS && camera.position.y < 110 && R.fx() < simDt * 2.2) {
      _n.set(camera.position.x + (R.fx() - 0.5) * 40, camera.position.y + 8 + R.fx() * 14, camera.position.z + (R.fx() - 0.3) * 40);
      game.fx.leaves(_n, 2);
    }

    // (the shadow frustum follows the camera, a little ahead along the view and texel-snapped: the look's sun does that)
    this.finish();
  }

  /** The draw reads the camera's field of view from the Hull Camera, and the checksum reads the digest. */
  private finish(): void {
    const game = this.g;
    this.camera.fov = game.camera.fov;
    this.camera.near = game.camera.near;
    this.camera.far = game.camera.far;
    const p = game.player, s = this.sum.reset();
    s.num(game.time).vec(p.pos).vec(p.vel).num(p.hp).num(game.flow.score).num(game.flow.wave || 0).num(p.alive ? 1 : 0);
    const ts = game.titans?.titans;
    if (ts) { s.num(ts.length); for (const t of ts) s.vec(t.position).num(t.alive ? 1 : 0); }
    for (const a of game.allies) s.vec(a.pos);
    this.digest = s.value;
  }

  /** A frame to draw: the HUD, the scene-level state the game owns, the first-frame setup. Never changes the simulation. */
  override update(dt: number): void {
    const game = this.g;
    if (!game?.flow) return;
    if (!this.keysAttached) { this.keysAttached = true; keys.attach(hub.view ?? hullInput); }
    if (game.audio?.wanted && (hub.audio ?? views()?.audio)) game.audio.init();
    if (!this.qualityApplied && views()?.render) { this.qualityApplied = true; game.setQuality(game.quality, false); views()?.render?.setLook('look/' + (game.world?.atmosphere || 'day')); }
    // fog colour and the background follow the game's own scene (the Greatwood's canopy haze)
    const rs = backendScene(this.world);
    if (rs) { rs.fog = game.scene.fog; rs.background = game.scene.background; }
    this.frames++; this.fpsT += dt;
    if (this.fpsT > 1) { game.fps = this.frames / this.fpsT; this.frames = 0; this.fpsT = 0; }
    const playing = isPlaying(game.mode);
    game.autoQuality?.(dt, playing);
    // the speed cue the look draws (post.speedBlur): nothing under 32 m/s, full at 82, none when the soldier is down
    const fxHold = this.opts.fx;
    views()?.render?.setSpeed(fxHold === 'speed' ? 1 : playing && game.player.alive ? Math.min(1, Math.max(0, (game.player.speed - 32) / 50)) : 0);
    if (fxHold === 'impact') views()?.render?.holdImpact(1, null);
    if (!HEADLESS) game.hud?.update?.(this.hudState(playing));
  }

  /** Everything the HUD shows. */
  private hudState(playing: boolean): HudState {
    const game = this.g, p = game.player, camera = game.camera;
    const toScreen = (v: THREE.Vector3, out: { x: number; y: number }): boolean => {
      _tp.copy(v).project(camera);
      out.x = (_tp.x * 0.5 + 0.5) * innerWidth; out.y = (-_tp.y * 0.5 + 0.5) * innerHeight;
      return _tp.z < 1 && Math.abs(_tp.x) < 1.05 && Math.abs(_tp.y) < 1.05;
    };
    _markers.length = 0; _threats.length = 0;
    if (playing) {
      camera.getWorldDirection(_cf); _cr.crossVectors(_cf, camera.up).normalize(); _cu.crossVectors(_cr, _cf).normalize();
      for (const t of game.targetList()) {
        if (!t.alive || !t.napeWorld) continue;
        const nw = t.napeWorld();
        if (!nw?.center) continue;
        const d = nw.center.distanceTo(p.render);
        if (d > 110) continue;
        const m: NapeMarker = { x: 0, y: 0, visible: false, distance: d };
        m.visible = toScreen(nw.center, m);
        _markers.push(m);
        // off-screen titans within 90 m: a chevron pointing at them (danger when it is reaching for you)
        if (!m.visible && t.kind !== 'dummy' && d < 90) {
          // radar mapping: straight ahead is up, behind you is down
          _tp.subVectors(t.position, camera.position);
          const angle = Math.atan2(_tp.dot(_cr), _tp.x * _cf.x + _tp.z * _cf.z);
          _threats.push({ angle, danger: (t.threat || 0) > 0.5 || d < 25, distance: d });
        }
      }
      for (let i = 0; i < 2; i++) {
        const h = p.odm.hooks[i], T = p.targets[i], o = _hookTargets[i];
        o.attached = h.attached;
        o.valid = h.attached || T.valid;
        // markers glide to a new anchor instead of jumping (and snap when they first appear)
        const wasVis = o.visible, px = o.x, py = o.y;
        o.visible = !game.killCam && o.valid && toScreen(h.attached ? h.anchor : T.point, o);
        if (o.visible && wasVis) { const k = 1 - Math.exp(-22 * (game._frameDt || 0.016)); o.x = px + (o.x - px) * k; o.y = py + (o.y - py) * k; }
      }
    }
    return {
      playing, mode: game.mode,
      gas: p.infiniteGas ? 1 : p.odm.gas, blade: p.blade, bladesSpare: p.spares, hp: Math.max(0, p.hp),
      kills: p.stats.kills, score: game.flow.score, speed: playing ? p.speed : 0, combo: game.flow.combo,
      hooks: p.odm.hooks.map((h: { state: string }) => ({ state: h.state === 'retracting' ? 'idle' : h.state })),
      aim: { valid: p.aim.valid, distance: p.aim.distance, lockTitan: p.aim.lockTitan },
      napeMarkers: _markers, hookTargets: _hookTargets, threats: _threats,
      objective: playing ? game.flow.objective() : '', fps: game.fps,
      grabbed: !!p.grabbedBy, struggle: p.struggle, swapping: p.swapT > 0, wave: game.flow.wave,
      timer: game.flow.timer(), targets: game.flow.trainingTargets(), hint: playing && !game.killCam && !game.cine?.bars ? game.flow.hint : null,
      controlsCard: playing && !!game.showControls && !game.killCam, cinematic: playing && (!!game.killCam || !!game.cine?.bars),
    };
  }

  // cinematic title flyover: drift along the Ashwall, looking out over the Reach toward the Greatwood
  private menuCamera(): void {
    const game = this.g, camera = game.camera;
    const t = game.time * 0.05;
    const x = Math.sin(t) * 160;
    camera.position.set(x, 64 + Math.sin(t * 1.7) * 6, -18 + Math.cos(t * 0.8) * 8);
    _n.set(x * 0.4 + Math.sin(t * 0.6) * 60, 26, 300 + FS * 0.6);
    camera.up.set(0, 1, 0);
    camera.lookAt(_n);
    if (Math.abs(camera.fov - 62) > 0.01) { camera.fov = 62; camera.updateProjectionMatrix(); }
    game.audio?.setWind?.(6);
    game.audio?.setReel?.(0); game.audio?.setGas?.(0);
    if (game.player?.model?.root) game.player.model.root.visible = false;
  }
}

/** The AOTT game object of a started Hull game (for tests and the dev console). */
export function aottOf(hull: HullGame): Game {
  const host = hull.world.find('aott')?.get(AottHost);
  if (!host?.g) throw new Error('aottOf: this game has not booted AOTT');
  return host.g;
}
