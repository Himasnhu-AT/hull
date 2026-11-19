// AOTT: audio engine. Everything is synthesised at runtime with the Web Audio API
// (no audio files). Every public method is safe to call before init() and when audio is unavailable.
//
//   const audio = new Audio();  audio.init();                     // first user gesture
//   audio.setListener(pos, fwd, up)                                // every frame (THREE.Vector3-like {x,y,z})
//   audio.hookFire(side) hookHit(material[, pos]) hookRetract(side) hookMiss()
//   audio.setReel(0..1) setGas(0..1) setWind(m/s)                  // continuous loops, call every frame
//   audio.slash(hit) napeKill() bladeBreak() bladeSwap() refill() impact(0..1) land(0..1) grabbed() eaten() hurt()
//   audio.titanStep|titanGroan|titanFall|steamHiss(pos, sizeMetres) behemothAppear()
//   audio.footstep(surface, 0..1, wall) setScrape(0..1) whoosh(0..1, pan) kickOff(0..1) speedBurst()   // traversal
//   audio.reelLock(on) wireCreak(0..1) wireSnap(0..1) climbGrab(surface, 0..1) mantle()
//   audio.combo(n) rescuePickup() rescueDeliver() civilianCry(pos, 0..1) civilianLost() uiHover() uiClick() uiBack()
//   audio.setMusic(0..1) setAction(0..1) setHeartbeat(0..1)  toggleMute() -> muted
//
// Graph:  one-shots/loops -> sfx bus (ducked by the kill) -> danger low-pass ┐      ┌ reverb send (generated IR, ~2.5 s)
//         kill / stingers / UI -> top bus ───────────────────────────────────┤
//         music layers -> music bus ─────────────────────────────────────────┴-> compressor -> soft clip -> mute -> out
// Files: dsp.ts (helpers, Rig), sfx.ts (gear, combat, titans), moves.ts (traversal), cues.ts (stingers, voices, UI),
//        loops.ts (reel/gas/wind/scrape/heartbeat), music.ts (score), this file (engine).
import { Rig, clamp, noiseBuffer, impulseResponse, satCurve } from './dsp';
import type { NoiseKind } from './dsp';
import { ReelLoop, GasLoop, WindLoop, ScrapeLoop, Heartbeat } from './loops';
import { Music } from './music';
import * as sfx from './sfx';
import * as moves from './moves';
import * as cues from './cues';
import { wallMs } from '../realtime';

const MUSIC_LEVEL = 0.095;
const SFX_LEVEL = 0.9;
// Minimum seconds between two one-shots of a category (protects against per-frame retriggering).
const MIN_GAP: Record<string, number> = {
  thump: 0.07, slash: 0.07, hurt: 0.25, grab: 0.6, eaten: 1, kill: 0.12, swap: 0.15, refill: 0.5, break: 0.15, groan: 0.12, behemoth: 3,
  foot: 0.085, whoosh: 0.11, lock: 0.09, creak: 0.45, snap: 0.12, climb: 0.13, mantle: 0.4, kick: 0.12, burst: 1.2, gasKick: 0.12,
  combo: 0.14, rescue: 0.25, cry: 0.22, lost: 0.6, uiHover: 0.035, uiClick: 0.05,
};

/** Anything with x/y/z (a THREE.Vector3 in practice). */
export type Vec3Like = { x: number; y: number; z: number };

export interface InitOptions {
  /** Use this (Offline)AudioContext instead of creating one (tests). */
  context?: BaseAudioContext;
  /** Do not start the music timer. */
  manual?: boolean;
  /** Connect the master chain here instead of to the context's destination (a Hull mixer bus). */
  destination?: AudioNode;
}

/** Options of `Audio._dest`: output gain, stereo pan, target bus, reverb send. */
export interface DestOpts { vol?: number; pan?: number; to?: AudioNode | null; rev?: number; revScale?: number }
/** Options of `Audio._place`. */
export interface PlaceOpts { ref?: number; rolloff?: number; cut?: number; air?: number }
/** A spatialised one-shot's input: feed `in`; `g` = distance gain, `d` = distance, `rev` = reverb scale. */
export interface Placed { in: BiquadFilterNode; g: number; d: number; rev: number }

type LegacyAudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

export class Audio {
  ctx: BaseAudioContext | null;
  ready: boolean;
  muted: boolean;
  /** dev: rethrow synthesis errors instead of logging one warning */
  strict: boolean;
  music: Music | null;
  lpos: Vec3Like; lfwd: Vec3Like; lup: Vec3Like;

  // the graph (exists once init() has succeeded)
  noise!: Record<NoiseKind, AudioBuffer>;
  satHard!: Float32Array<ArrayBuffer>;
  /** Main SFX bus: everything in the world. Ducked for a moment by the nape kill, low-passed by the heartbeat. */
  sfx!: GainNode;
  /** Priority bus (the kill itself, stingers, UI, heartbeat): never ducked, never low-passed. */
  sfxTop!: GainNode;
  /** The danger low-pass on the main SFX bus (wide open unless setHeartbeat is up). */
  sfxLp!: BiquadFilterNode;
  musicBus!: GainNode;
  comp!: DynamicsCompressorNode;
  master!: GainNode;
  conv!: ConvolverNode;
  revIn!: GainNode;
  analyser!: AnalyserNode;
  reelLoop!: ReelLoop;
  gasLoop!: GasLoop;
  windLoop!: WindLoop;
  scrapeLoop!: ScrapeLoop;
  heart!: Heartbeat;

  _offline: boolean;
  _active: Record<string, number>;
  _last: Record<string, number>;
  _total: number;
  _hrtf: number;
  _fresh: Rig[];
  _warned: boolean;
  _lastResume: number;
  _pendingMusic: number;
  _pendingAction: number | null;
  _pendingLoops: { reel: number; gas: number; wind: number; scrape: number; heart: number };
  _rigsLive: number;
  _hidden?: boolean;
  _visWatch?: boolean;
  _gestureArmed?: boolean;

  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.strict = false; // dev: rethrow synthesis errors instead of logging one warning
    this.music = null;

    this.lpos = { x: 0, y: 0, z: 0 };
    this.lfwd = { x: 0, y: 0, z: -1 };
    this.lup = { x: 0, y: 1, z: 0 };

    this._offline = false;
    this._active = Object.create(null);
    this._last = Object.create(null);
    this._total = 0;
    this._hrtf = 0;
    this._fresh = [];
    this._warned = false;
    this._lastResume = 0;
    this._pendingMusic = 0;
    this._pendingAction = null;
    this._pendingLoops = { reel: 0, gas: 0, wind: 0, scrape: 0, heart: 0 };
    this._rigsLive = 0;
  }

  // ───────────────────────────────────────────────────────────────────────── lifecycle

  /**
   * Create the AudioContext and the whole graph. Call from a user gesture. Idempotent; returns true when audio works.
   * opts.context: use this (Offline)AudioContext instead of creating one (tests); opts.manual: do not start timers.
   */
  init(opts: InitOptions = {}): boolean {
    if (this.ready) {
      this._resumeMaybe(true);
      return true;
    }
    try {
      const Ctor = typeof window !== 'undefined' ? window.AudioContext || (window as LegacyAudioWindow).webkitAudioContext : null;
      const ctx: BaseAudioContext | null = opts.context || (Ctor ? new Ctor({ latencyHint: 'interactive' }) : null);
      if (!ctx) return false;
      this.ctx = ctx;
      this._offline = !!opts.context && typeof (ctx as OfflineAudioContext).startRendering === 'function';

      // noise sources
      this.noise = {
        white: noiseBuffer(ctx, 'white', 3),
        pink: noiseBuffer(ctx, 'pink', 5),
        brown: noiseBuffer(ctx, 'brown', 5),
      };
      this.satHard = satCurve(3.5);

      // master chain: buses -> compressor (limiter-ish) -> soft clip -> mute gain -> destination
      this.sfx = ctx.createGain();
      this.sfx.gain.value = SFX_LEVEL;
      this.sfxTop = ctx.createGain();
      this.sfxTop.gain.value = SFX_LEVEL;
      this.sfxLp = ctx.createBiquadFilter();
      this.sfxLp.type = 'lowpass';
      this.sfxLp.frequency.value = ctx.sampleRate / 2; // at Nyquist a low-pass is the identity
      this.sfxLp.Q.value = 0.5;
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = MUSIC_LEVEL;
      const pre = ctx.createGain();
      pre.gain.value = 1;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -16;
      this.comp.knee.value = 10;
      this.comp.ratio.value = 8;
      this.comp.attack.value = 0.003;
      this.comp.release.value = 0.2;
      const makeup = ctx.createGain();
      makeup.gain.value = 1;
      const clip = ctx.createWaveShaper();
      clip.curve = satCurve(0.9);
      clip.oversample = '2x';
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.sfx.connect(this.sfxLp); this.sfxLp.connect(pre);
      this.sfxTop.connect(pre);
      this.musicBus.connect(pre);
      pre.connect(this.comp); this.comp.connect(makeup); makeup.connect(clip); clip.connect(this.master);
      this.master.connect(opts.destination ?? ctx.destination);

      // outdoor-ish reverb send for big sounds (generated impulse response, ~2.5 s)
      this.conv = ctx.createConvolver();
      this.conv.buffer = impulseResponse(ctx, 2.6, { rt60: 2.3, pre: 0.012, bright: 0.85, dark: 0.2, slap: true, early: true });
      this.revIn = ctx.createGain();
      this.revIn.gain.value = 1;
      const revOut = ctx.createGain();
      revOut.gain.value = 0.85;
      this.revIn.connect(this.conv); this.conv.connect(revOut); revOut.connect(this.sfx);

      // analyser for dev tooling
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;
      clip.connect(this.analyser);

      // listener
      this._applyListener();

      // continuous loops (created once)
      this.reelLoop = new ReelLoop(this);
      this.gasLoop = new GasLoop(this);
      this.windLoop = new WindLoop(this);
      this.scrapeLoop = new ScrapeLoop(this);
      this.heart = new Heartbeat(this);

      this.music = new Music(this);
      this.ready = true;
      if (!opts.manual) this.music.start();

      this.reelLoop.set(this._pendingLoops.reel);
      this.gasLoop.set(this._pendingLoops.gas);
      this.windLoop.set(this._pendingLoops.wind);
      this.scrapeLoop.set(this._pendingLoops.scrape);
      this.heart.set(this._pendingLoops.heart);
      if (this._pendingAction !== null) this.music.setAction(this._pendingAction);

      if (!this._offline) {
        this._resumeMaybe(true);
        if (ctx.state !== 'running') this._armGestureResume();
        this._watchVisibility();
      }
      return true;
    } catch (e) {
      console.warn('[audio] unavailable:', e);
      this.ready = false;
      if (this.music) this.music.stop();
      try { if (this.ctx && !opts.context) (this.ctx as AudioContext).close(); } catch (e2) { /* ignore */ }
      this.ctx = null;
      this.music = null;
      return false;
    }
  }

  get state(): AudioContextState | 'none' {
    return this.ctx ? this.ctx.state : 'none';
  }

  _running(): boolean {
    return this.ready && !!this.ctx && (this._offline || this.ctx.state === 'running');
  }

  _resumeMaybe(force = false): void {
    const ctx = this.ctx as AudioContext | null;
    if (!ctx || this._offline || this._hidden || ctx.state === 'running' || ctx.state === 'closed') return;
    const nowMs = wallMs();
    if (!force && nowMs - this._lastResume < 1000) return;
    this._lastResume = nowMs;
    try {
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }

  /** Silence everything while the tab is hidden (the game loop stops, so loops would otherwise hang on their last value). */
  _watchVisibility(): void {
    if (this._visWatch || typeof document === 'undefined') return;
    this._visWatch = true;
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx || this._offline) return;
      if (document.hidden) {
        this._hidden = true;
        try { (this.ctx as AudioContext).suspend(); } catch (e) { /* ignore */ }
      } else {
        this._hidden = false;
        this._resumeMaybe(true);
      }
    });
  }

  _armGestureResume(): void {
    if (this._gestureArmed || typeof window === 'undefined') return;
    this._gestureArmed = true;
    const evs = ['pointerdown', 'keydown', 'touchstart', 'mousedown'];
    const go = () => {
      this._resumeMaybe(true);
      if (this.ctx?.state === 'running') {
        for (const e of evs) window.removeEventListener(e, go, true);
        this._gestureArmed = false;
      }
    };
    for (const e of evs) window.addEventListener(e, go, true);
  }

  // ───────────────────────────────────────────────────────────────────────── plumbing used by sfx/music

  /** Allocate a one-shot rig in category `cat` (at most `max` alive at once); null when audio is off or the voice cap is hit. */
  _rig(cat: string, max = 8): Rig | null {
    if (!this._running()) return null;
    if ((this._active[cat] | 0) >= max || this._total >= 90) return null;
    const gap = MIN_GAP[cat];
    if (gap) {
      const t = (this.ctx as BaseAudioContext).currentTime;
      if (t - (this._last[cat] || -9) < gap) return null; // retriggering faster than this just smears into noise
      this._last[cat] = t;
    }
    const r = new Rig(this, cat);
    this._active[cat] = (this._active[cat] | 0) + 1;
    this._total++;
    this._fresh.push(r);
    return r;
  }

  _release(r: Rig): void {
    if (!r.cat) return;
    this._active[r.cat]--;
    this._total--;
  }

  /** Output stage for a one-shot: gain -> (stereo pan) -> bus (default sfx, or `to`), plus a reverb send. */
  _dest(r: Rig, o: DestOpts = {}): GainNode {
    const g = r.gain(o.vol == null ? 1 : o.vol);
    let n: AudioNode = g;
    if (o.pan && r.ctx.createStereoPanner) {
      const p = r.ctx.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      r.nodes.push(p);
      g.connect(p);
      n = p;
    }
    n.connect(o.to || this.sfx);
    if (o.rev && o.rev > 0) {
      const s = r.gain(o.rev * (o.revScale == null ? 1 : o.revScale));
      n.connect(s);
      s.connect(this.revIn);
    }
    return g;
  }

  /**
   * Spatialise a one-shot at world position `pos` for a source of `size` metres. Returns { in, g, d, rev } where `in`
   * is the node to feed (air-absorption lowpass -> PannerNode -> sfx bus), or null when too far to be audible.
   */
  _place(r: Rig, pos: Vec3Like | null | undefined, size: number, { ref, rolloff = 1, cut = 0.004, air = 8000 }: PlaceOpts = {}): Placed | null {
    const has = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z);
    const l = this.lpos;
    const d = has ? Math.hypot(pos.x - l.x, pos.y - l.y, pos.z - l.z) : 30;
    ref = ref == null ? clamp(size * 1.6, 3, 80) : ref;
    const g = ref / (ref + rolloff * Math.max(0, d - ref));
    if (g < cut) return null;
    const lp = r.filter('lowpass', clamp(air / (1 + d / 140), 500, 18000), 0.5);
    if (has && pos) {
      const hrtf = this._hrtf < 8;
      if (hrtf) {
        this._hrtf++;
        r.onDispose(() => { this._hrtf--; });
      }
      const p = r.ctx.createPanner();
      p.panningModel = hrtf ? 'HRTF' : 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = ref;
      p.maxDistance = 20000;
      p.rolloffFactor = rolloff;
      if (p.positionX) {
        p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
      } else p.setPosition(pos.x, pos.y, pos.z);
      r.nodes.push(p);
      lp.connect(p);
      p.connect(this.sfx);
    } else lp.connect(this.sfx);
    return { in: lp, g, d, rev: clamp(g * 1.6, 0.12, 1) };
  }

  /** Briefly pull the music down (e.g. under the Behemoth's arrival). */
  _duckMusic(amount = 0.4, attack = 0.2, hold = 3): void {
    if (!this.musicBus || !this.ctx) return;
    const g = this.musicBus.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(MUSIC_LEVEL * amount, t, attack / 3);
    g.setTargetAtTime(MUSIC_LEVEL, t + hold, 0.9);
  }

  /** Pull the main SFX bus down for a moment so a hero sound on the top bus lands in the clear. */
  _duckSfx(amount = 0.5, hold = 0.2, release = 0.35): void {
    if (!this.sfx || !this.ctx) return;
    const g = this.sfx.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(SFX_LEVEL * amount, t, 0.006);
    g.setTargetAtTime(SFX_LEVEL, t + hold, release / 3);
  }

  _applyListener(): void {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    const p = this.lpos, f = this.lfwd, u = this.lup;
    if (L.positionX) {
      L.positionX.value = p.x; L.positionY.value = p.y; L.positionZ.value = p.z;
      L.forwardX.value = f.x; L.forwardY.value = f.y; L.forwardZ.value = f.z;
      L.upX.value = u.x; L.upY.value = u.y; L.upZ.value = u.z;
    } else {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  _run<A extends unknown[]>(fn: (au: Audio, ...args: A) => void, ...args: A): void {
    if (!this.ready) return;
    try {
      this._fresh.length = 0;
      fn(this, ...args);
      for (const r of this._fresh) r.seal();
    } catch (e) {
      for (const r of this._fresh) r.abort();
      if (this.strict) throw e;
      if (!this._warned) {
        this._warned = true;
        console.warn('[audio] error in', fn.name, e);
      }
    } finally {
      this._fresh.length = 0;
    }
  }

  // ───────────────────────────────────────────────────────────────────────── contract API

  setListener(position?: Vec3Like | null, forward?: Vec3Like | null, up?: Vec3Like | null): void {
    const l = this.lpos, f = this.lfwd, u = this.lup;
    if (position && Number.isFinite(position.x + position.y + position.z)) { l.x = position.x; l.y = position.y; l.z = position.z; }
    if (forward && Number.isFinite(forward.x + forward.y + forward.z) && forward.x * forward.x + forward.y * forward.y + forward.z * forward.z > 1e-8) { f.x = forward.x; f.y = forward.y; f.z = forward.z; }
    if (up && Number.isFinite(up.x + up.y + up.z) && up.x * up.x + up.y * up.y + up.z * up.z > 1e-8) { u.x = up.x; u.y = up.y; u.z = up.z; }
    if (!this.ready) return;
    try {
      this._resumeMaybe();
      this._applyListener();
    } catch (e) {
      if (this.strict) throw e;
    }
  }

  // tether gear
  hookFire(side?: sfx.Side): void { this._run(sfx.hookFire, side); }
  hookHit(material?: string, position?: Vec3Like | null): void { this._run(sfx.hookHit, material, position); }
  hookRetract(side?: sfx.Side): void { this._run(sfx.hookRetract, side); }
  hookMiss(): void { this._run(sfx.hookMiss); }

  // continuous loops
  setReel(level: number): void {
    this._pendingLoops.reel = level;
    if (this.ready) this._guard(() => this.reelLoop.set(level));
  }
  setGas(level: number): void {
    this._pendingLoops.gas = level;
    if (this.ready) this._guard(() => this.gasLoop.set(level));
  }
  setWind(speed: number): void {
    this._pendingLoops.wind = speed;
    if (this.ready) this._guard(() => this.windLoop.set(speed));
  }
  /** 0..1 every frame: boots and gear dragging along stone or bark (wall run, skid, sliding down a trunk). */
  setScrape(level: number): void {
    this._pendingLoops.scrape = level;
    if (this.ready) this._guard(() => this.scrapeLoop.set(level));
  }
  /** 0..1 every frame: low-HP / danger heartbeat (70 -> 140 bpm) plus a gentle low-pass on the world's SFX. */
  setHeartbeat(level: number): void {
    this._pendingLoops.heart = level;
    if (this.ready) this._guard(() => this.heart.set(level));
  }

  // traversal
  /** One running footfall on a collider material; `wall` = a wall-run step (lighter, scuffier, brighter). */
  footstep(surface?: string, strength = 0.5, wall = false): void { this._run(moves.footstep, surface, strength, wall); }
  /** A fast fly-by (trunk, wall corner, limb); `pan` -1..1 is the side it passed on. */
  whoosh(strength = 0.5, pan = 0): void { this._run(moves.whoosh, strength, pan); }
  /** The brake-reel latching (on) or releasing (off). */
  reelLock(on: boolean): void { this._run(moves.reelLock, !!on); }
  /** Steel wire under load creaking / singing (every 1-3 s while hanging). */
  wireCreak(strength = 0.5): void { this._run(moves.wireCreak, strength); }
  /** A wire snapping taut: twang plus a low thud. */
  wireSnap(strength = 0.5): void { this._run(moves.wireSnap, strength); }
  /** A hand or boot catching while climbing. */
  climbGrab(surface?: string, strength = 0.5): void { this._run(moves.climbGrab, surface, strength); }
  /** Hauling up over a ledge. */
  mantle(): void { this._run(moves.mantle); }
  /** Kicking off a wall or trunk: boot thump plus a gas puff. */
  kickOff(strength = 0.6): void { this._run(moves.kickOff, strength); }
  /** Crossing into very high speed: a short crack-whoosh accent. */
  speedBurst(): void { this._run(moves.speedBurst); }

  // stingers, voices, UI
  /** Kill-chain stinger for combo level n (2..9), in the score's current harmony. */
  combo(n: number): void { this._run(cues.combo, n); }
  rescuePickup(): void { this._run(cues.rescuePickup); }
  rescueDeliver(): void { this._run(cues.rescueDeliver); }
  /** A stranded civilian calling for help from `position`; urgency raises pitch and roughness. */
  civilianCry(position?: Vec3Like | null, urgency = 0.5): void { this._run(cues.civilianCry, position, urgency); }
  civilianLost(): void { this._run(cues.civilianLost); }
  uiHover(): void { this._run(cues.uiHover); }
  uiClick(): void { this._run(cues.uiClick); }
  uiBack(): void { this._run(cues.uiBack); }

  // combat
  slash(hit?: unknown): void { this._run(sfx.slash, !!hit); }
  napeKill(): void { this._run(sfx.napeKill); }
  bladeBreak(): void { this._run(sfx.bladeBreak); }
  bladeSwap(): void { this._run(sfx.bladeSwap); }
  refill(): void { this._run(sfx.refill); }
  impact(strength?: number): void { this._run(sfx.impact, strength); }
  land(strength?: number): void { this._run(sfx.land, strength); }
  grabbed(): void { this._run(sfx.grabbed); }
  eaten(): void { this._run(sfx.eaten); }
  hurt(): void { this._run(sfx.hurt); }
  whistle(): void { this._run(sfx.whistle); }

  // titans (3D)
  titanStep(position?: Vec3Like | null, size?: number): void { this._run(sfx.titanStep, position, size); }
  titanGroan(position?: Vec3Like | null, size?: number): void { this._run(sfx.titanGroan, position, size); }
  titanFall(position?: Vec3Like | null, size?: number): void { this._run(sfx.titanFall, position, size); }
  steamHiss(position?: Vec3Like | null, size?: number): void { this._run(sfx.steamHiss, position, size); }
  /** The Behemoth's arrival: thunder crack, boom, rumble and a deep roar. */
  behemothAppear(): void { this._run(sfx.behemothAppear); }
  // music / mute
  setMusic(intensity: number): void {
    const i = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
    this._pendingMusic = i;
    const m = this.music;
    if (this.ready && m) this._guard(() => m.setIntensity(i));
  }

  /**
   * 0..1 every frame: how intense the moment is (speed, titans close, combo). Leans the score's percussion, ostinato
   * and tempo on top of the mode's setMusic intensity; smoothed inside, so it can be fed raw.
   */
  setAction(level: number): void {
    const a = clamp(Number.isFinite(level) ? level : 0, 0, 1);
    this._pendingAction = a;
    const m = this.music;
    if (this.ready && m) this._guard(() => m.setAction(a));
  }

  /** Toggle mute for everything; returns the new muted state. */
  toggleMute(): boolean {
    return this.setMuted(!this.muted);
  }

  setMuted(m: boolean): boolean {
    this.muted = !!m;
    if (this.ready) {
      this._guard(() => {
        const g = this.master.gain;
        const t = (this.ctx as BaseAudioContext).currentTime;
        g.cancelScheduledValues(t);
        g.setTargetAtTime(this.muted ? 0 : 1, t, 0.03);
      });
    }
    return this.muted;
  }

  _guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (this.strict) throw e;
      if (!this._warned) {
        this._warned = true;
        console.warn('[audio]', e);
      }
    }
  }
}

export default Audio;
