// AOTT's sound, played through Hull. The game keeps calling the methods it always did (footstep, hookFire, setReel,
// titanGroan, setMusic...); each is a thin map onto a `sound` recipe in config/sound/ played with hull/audio's
// `play(id, { at, volume, params })`, or onto a live voice (the winch, the gas jet, the wind, the scrape, the heartbeat,
// the score) that is fed one number. The mix is config/mixer/main.json. Nothing here makes a node.
//
// Calls are safe before init() and when audio is unavailable: they are remembered or dropped, never thrown.
import type { AudioView, SoundHandle } from 'hull/audio';
import { registerAottGenerators } from './gens';
import { registerAottLive } from './live';

/** Anything with x/y/z (a THREE.Vector3 in practice). */
export type Vec3Like = { x: number; y: number; z: number };
/** Which launcher: 0 / 'left' / 'l' is the left one, anything else the right. */
export type Side = number | string | null | undefined;
type Pos = Vec3Like | null | undefined;

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const finite = (v: number | undefined, d: number): number => (v !== undefined && Number.isFinite(v) ? v : d);
const isLeft = (side: Side): boolean => side === 0 || side === 'left' || side === 'l';
const SURFACES = ['stone', 'wood', 'bark', 'roof', 'metal', 'flesh', 'ground'];
const surfaceOf = (s?: string): string => (s && SURFACES.includes(s) ? s : 'ground');
const FAR = 400;

/** The recorded variants of a sound that scales with a number: the nearest one plays, louder or softer by the ratio of the old level curves. */
function nearest(values: readonly number[], x: number): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (Math.abs(Math.log(values[i]! / x)) < Math.abs(Math.log(values[best]! / x))) best = i;
  return best;
}

export class Audio {
  ready = false;
  muted = false;
  /** Kept for callers that set it: nothing here throws into the game. */
  strict = false;
  /** True when init() ran before the page had mounted Hull's audio; the host calls init() again once it has. */
  wanted = false;

  private view: AudioView | null = null;
  private readonly getView: () => AudioView | null | undefined;
  private pending = { reel: 0, gas: 0, wind: 0, scrape: 0, heart: 0, music: 0, action: 0.3 };
  private loops: { reel?: SoundHandle; gas?: SoundHandle; wind?: SoundHandle; scrape?: SoundHandle; heart?: SoundHandle; score?: SoundHandle } = {};
  private gasLevel = 0;
  private heartApplied = 0;
  private readonly lpos: [number, number, number] = [0, 0, 0];
  private readonly lfwd: [number, number, number] = [0, 0, -1];

  constructor(getView: () => AudioView | null | undefined = () => (globalThis as { hull?: { audio?: AudioView } }).hull?.audio) {
    this.getView = getView;
    registerAottGenerators();
    registerAottLive();
  }

  // ───────────────────────────────────────────────────────────────────────── lifecycle

  /** Start the continuous sounds on Hull's audio. Idempotent; returns true when sound is available. */
  init(): boolean {
    if (this.ready) return true;
    const v = this.getView();
    if (!v) { this.wanted = true; return false; }
    this.wanted = false;
    this.view = v;
    this.ready = true;
    const p = this.pending;
    this.loops.reel = v.play('sound/loop/reel');
    this.loops.gas = v.play('sound/loop/gas');
    this.loops.wind = v.play('sound/loop/wind');
    this.loops.scrape = v.play('sound/loop/scrape');
    this.loops.heart = v.play('sound/loop/heartbeat');
    this.loops.score = v.play('sound/music/score');
    this.loops.reel?.set?.({ level: p.reel });
    this.loops.gas?.set?.({ level: p.gas });
    this.loops.wind?.set?.({ speed: p.wind });
    this.loops.scrape?.set?.({ level: p.scrape });
    this.loops.heart?.set?.({ level: p.heart });
    this.loops.score?.set?.({ intensity: p.music, action: p.action });
    if (this.muted) v.setBus('master', -80);
    return true;
  }

  get state(): 'running' | 'suspended' | 'unavailable' | 'none' {
    return this.view ? this.view.state : 'none';
  }

  /** The score's chord, so the stingers land in its harmony (D minor while the score is not running). */
  private chord(): { pc: number; third: number } {
    const c = (this.loops.score?.voice?.['chord'] as (() => { pc: number; third: number }) | undefined)?.();
    return c ?? { pc: 2, third: 3 };
  }

  private play(id: string, o: { volume?: number; at?: Pos; ref?: number; params?: Record<string, number> } = {}): void {
    const v = this.view;
    if (!v) return;
    v.play('sound/' + id, {
      ...(o.volume !== undefined && o.volume !== 1 ? { volume: o.volume } : {}),
      ...(o.params ? { params: o.params } : {}),
      ...(o.at && Number.isFinite(o.at.x + o.at.y + o.at.z) ? { at: [o.at.x, o.at.y, o.at.z] as [number, number, number], spatial: { ref: o.ref ?? 8, max: FAR } } : {}),
    });
  }

  setListener(position?: Vec3Like | null, forward?: Vec3Like | null, _up?: Vec3Like | null): void {
    const l = this.lpos, f = this.lfwd;
    if (position && Number.isFinite(position.x + position.y + position.z)) { l[0] = position.x; l[1] = position.y; l[2] = position.z; }
    if (forward && Number.isFinite(forward.x + forward.y + forward.z) && forward.x * forward.x + forward.y * forward.y + forward.z * forward.z > 1e-8) { f[0] = forward.x; f[1] = forward.y; f[2] = forward.z; }
    this.view?.setListener(l, f);
  }

  // ───────────────────────────────────────────────────────────────────────── tether gear

  hookFire(side?: Side): void { this.play(isLeft(side) ? 'gear/hook-fire-left' : 'gear/hook-fire-right'); }
  hookHit(material?: string, position?: Pos): void { this.play('gear/hook-hit-' + surfaceOf(material), { at: position, ref: 25 }); }
  hookRetract(side?: Side): void { this.play(isLeft(side) ? 'gear/hook-retract-left' : 'gear/hook-retract-right'); }
  hookMiss(): void { this.play('gear/hook-miss'); }

  // ───────────────────────────────────────────────────────────────────────── continuous

  setReel(level: number): void { this.pending.reel = level; this.loops.reel?.set?.({ level }); }
  setGas(level: number): void {
    const prev = this.gasLevel;
    this.gasLevel = clamp(Number.isFinite(level) ? level : 0, 0, 1);
    this.pending.gas = level;
    this.loops.gas?.set?.({ level });
    // the valve opening: a thump and a chuff under the first instant of a burst
    if (this.gasLevel > 0.5 && prev < 0.15) this.play('gear/gas-kick', { params: { level: this.gasLevel } });
  }
  setWind(speed: number): void { this.pending.wind = speed; this.loops.wind?.set?.({ speed }); }
  /** 0..1 every frame: boots and gear dragging along stone or bark. */
  setScrape(level: number): void { this.pending.scrape = level; this.loops.scrape?.set?.({ level }); }
  /** 0..1 every frame: the low-HP heartbeat (70 to 140 bpm) and a low-pass closing over the world's sound. */
  setHeartbeat(level: number): void {
    const l = clamp(Number.isFinite(level) ? level : 0, 0, 1);
    this.pending.heart = l;
    this.loops.heart?.set?.({ level: l });
    const v = this.view;
    if (!v) return;
    const on = l > 0.02;
    if (on ? Math.abs(l - this.heartApplied) > 0.01 : this.heartApplied > 0) {
      const nyq = (v.context?.sampleRate ?? 48000) / 2;
      v.setBusLowpass('sfx', on ? nyq * Math.pow(3000 / nyq, Math.pow(l, 0.8)) : null, on ? 0.25 : 0.15);
      this.heartApplied = on ? l : 0;
    }
  }

  // ───────────────────────────────────────────────────────────────────────── traversal

  /** One running footfall on a collider material; `wall` = a wall-run step. */
  footstep(surface?: string, strength = 0.5, wall = false): void {
    const s = clamp(finite(strength, 0.5), 0, 1);
    this.play('traversal/footstep-' + surfaceOf(surface) + (wall ? '-wall' : ''), { volume: (0.26 + 0.4 * s) / 0.46 });
  }
  whoosh(strength = 0.5, pan = 0): void {
    const s = clamp(finite(strength, 0.5), 0, 1);
    if (s < 0.03) return;
    this.play('traversal/whoosh', { params: { strength: s, pan: clamp(finite(pan, 0), -1, 1) } });
  }
  reelLock(on: boolean): void { this.play(on ? 'gear/reel-lock-on' : 'gear/reel-lock-off'); }
  wireCreak(strength = 0.5): void { this.play('gear/wire-creak', { params: { strength: clamp(finite(strength, 0.5), 0, 1) } }); }
  wireSnap(strength = 0.5): void {
    const s = clamp(finite(strength, 0.5), 0, 1);
    if (s < 0.03) return;
    const hard = s >= 0.55;
    this.play('gear/wire-snap-' + (hard ? 'hard' : 'soft'), { volume: (0.35 + 0.5 * s) / (0.35 + 0.5 * (hard ? 0.8 : 0.3)) });
  }
  climbGrab(surface?: string, strength = 0.5): void {
    const s = clamp(finite(strength, 0.5), 0, 1);
    const hard = surface === 'stone' || surface === 'roof' || surface === 'metal';
    this.play('traversal/climb-grab-' + (hard ? 'hard' : 'soft'), { volume: (0.3 + 0.4 * s) / 0.5 });
  }
  mantle(): void { this.play('traversal/mantle'); }
  kickOff(strength = 0.6): void {
    const s = clamp(finite(strength, 0.6), 0, 1);
    if (s < 0.03) return;
    const hard = s >= 0.55;
    this.play('traversal/kick-off-' + (hard ? 'hard' : 'soft'), { volume: (0.35 + 0.5 * s) / (0.35 + 0.5 * (hard ? 0.8 : 0.3)) });
  }
  speedBurst(): void { this.play('traversal/speed-burst'); }

  // ───────────────────────────────────────────────────────────────────────── stingers, voices, UI

  combo(n: number): void { this.play('stinger/combo', { params: { n: clamp(Math.round(finite(n, 2)), 2, 9), ...this.chord() } }); }
  rescuePickup(): void { this.play('stinger/rescue-pickup', { params: { ...this.chord() } }); }
  rescueDeliver(): void { this.play('stinger/rescue-deliver', { params: { ...this.chord() } }); }
  civilianCry(position?: Pos, urgency = 0.5): void { this.play('voice/civilian-cry', { at: position, ref: 18, params: { urgency: clamp(finite(urgency, 0.5), 0, 1) } }); }
  civilianLost(): void { this.play('stinger/civilian-lost', { params: { ...this.chord() } }); }
  uiHover(): void { this.play('ui/hover'); }
  uiClick(): void { this.play('ui/click'); }
  uiBack(): void { this.play('ui/back'); }
  whistle(): void { this.play('ui/whistle'); }

  // ───────────────────────────────────────────────────────────────────────── combat

  slash(hit?: unknown): void { this.play(hit ? 'combat/slash-hit' : 'combat/slash-miss'); }
  /** The kill plays on the top bus while the world ducks under it for a beat: the audio hit-stop. */
  napeKill(): void { this.play('combat/nape-kill'); this.view?.duck('sfx', 7.5, 0.24, 0.4); }
  bladeBreak(): void { this.play('gear/blade-break'); }
  bladeSwap(): void { this.play('gear/blade-swap'); }
  refill(): void { this.play('gear/refill'); }
  impact(strength?: number): void {
    const s = clamp(finite(strength, 0.5), 0, 1);
    if (s < 0.02) return;
    const i = s < 0.35 ? 0 : s < 0.7 ? 1 : 2;
    this.play('combat/impact-' + ['light', 'mid', 'heavy'][i], { volume: (0.35 + 0.75 * s) / (0.35 + 0.75 * [0.2, 0.5, 0.9][i]!) });
  }
  land(strength?: number): void {
    const s = clamp(finite(strength, 0.5), 0, 1);
    if (s < 0.02) return;
    const i = s < 0.35 ? 0 : s < 0.7 ? 1 : 2;
    this.play('traversal/land-' + ['light', 'mid', 'heavy'][i], { volume: (0.3 + 0.7 * s) / (0.3 + 0.7 * [0.2, 0.5, 0.9][i]!) });
  }
  grabbed(): void { this.play('combat/grabbed'); }
  eaten(): void { this.play('combat/eaten'); }
  hurt(): void { this.play('combat/hurt'); }

  // ───────────────────────────────────────────────────────────────────────── titans (3D)

  private static readonly STEP = [3, 8, 15, 30, 60];
  private static readonly STEP_N = ['xs', 'small', 'medium', 'large', 'xl'];
  private static readonly FALL = [8, 20, 45];
  private static readonly FALL_N = ['small', 'medium', 'large'];
  private static readonly STEAM = [4, 12, 30];
  private static readonly STEAM_N = ['small', 'medium', 'large'];
  private static size(size: number | undefined, d = 10): number { return clamp(finite(size, d), 1.5, 120); }

  titanStep(position?: Pos, size?: number): void {
    const z = Audio.size(size);
    const i = nearest(Audio.STEP, z);
    const vol = (x: number): number => clamp(0.5 + x / 26, 0.5, 2.2);
    this.play('titan/step-' + Audio.STEP_N[i], { at: position, ref: clamp(z * 1.5, 4, 70), volume: vol(z) / vol(Audio.STEP[i]!) });
  }
  titanGroan(position?: Pos, size?: number): void {
    const z = Audio.size(size);
    this.play('titan/groan', { at: position, ref: clamp(z * 1.8, 5, 90), params: { size: z } });
  }
  titanFall(position?: Pos, size?: number): void {
    const z = Audio.size(size);
    const i = nearest(Audio.FALL, z);
    const vol = (x: number): number => clamp(0.7 + clamp(x / 15, 0.35, 3) * 0.35, 0.75, 1.4);
    this.play('titan/fall-' + Audio.FALL_N[i], { at: position, ref: clamp(z * 2.2, 6, 110), volume: vol(z) / vol(Audio.FALL[i]!) });
  }
  steamHiss(position?: Pos, size?: number): void {
    const z = Audio.size(size);
    const i = nearest(Audio.STEAM, z);
    const vol = (x: number): number => clamp(0.9 + x / 50, 0.9, 1.6);
    this.play('titan/steam-' + Audio.STEAM_N[i], { at: position, ref: clamp(z * 1.6, 5, 80), volume: vol(z) / vol(Audio.STEAM[i]!) });
  }
  /** The Behemoth's arrival: thunder crack, boom, rumble and a deep roar; the score ducks under it. */
  behemothAppear(): void { this.play('titan/behemoth'); this.view?.duck('music', 10.5, 4.5, 0.9); }

  // ───────────────────────────────────────────────────────────────────────── music / mute

  setMusic(intensity: number): void {
    const i = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
    this.pending.music = i;
    this.loops.score?.set?.({ intensity: i, action: this.pending.action });
  }
  /** 0..1 every frame: how intense the moment is. Smoothed inside the score. */
  setAction(level: number): void {
    const a = clamp(Number.isFinite(level) ? level : 0, 0, 1);
    this.pending.action = a;
    this.loops.score?.set?.({ intensity: this.pending.music, action: a });
  }
  toggleMute(): boolean { return this.setMuted(!this.muted); }
  setMuted(m: boolean): boolean {
    this.muted = !!m;
    this.view?.setBus('master', this.muted ? -80 : 0);
    return this.muted;
  }
}

export default Audio;
