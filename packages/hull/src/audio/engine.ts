// The live audio engine: one AudioContext, the mixer's buses, a shared reverb, and a voice per play.
//
//   sound ─► voice gain ─► [air low-pass ─► pan] ─► bus ─► ... ─► master ─► compressor ─► limiter ─► out
//                 └─ send ─► reverb ─► master
//
// Everything is safe to call before the first user gesture and when Web Audio is missing: a play that cannot be
// heard is dropped, and a thing that fails is reported once and skipped, never thrown into the game.
import { config } from '../config/index.ts';
import { hashString, RandomStream } from '../core/random.ts';
import type { Game } from '../core/types.ts';
import type { Mixer } from '../schema/mixer.ts';
import type { Sound } from '../schema/sound.ts';
import { makeImpulse } from './dsp.ts';
import { buildSound, hasGenerator, type Built } from './generators.ts';
import { planMixer, type MixerPlan } from './mixer-plan.ts';
import { dbToLinear } from './plan.ts';
import { airCutoff, distanceBetween, distanceGain, panFor, type Vec3 } from './spatial.ts';

export interface PlayOptions {
  /** Linear gain multiplier on top of the sound's level. Default 1. */
  volume?: number;
  /** Speed multiplier on top of the sound's pitch. Default 1. */
  pitch?: number;
  /** World position: the sound is attenuated and panned against the listener. Fixed for the length of the play. */
  at?: Vec3;
}

export interface SoundHandle { stop(): void }

export interface AudioView {
  /** `id` is 'sound/sword/hit' or just 'sword/hit'. Returns a handle (for loops), or undefined if nothing played. */
  play(id: string, opts?: PlayOptions): SoundHandle | undefined;
  /** Set a bus level in dB, now. The next mixer file change puts it back to what the file says. */
  setBus(bus: string, db: number): void;
  /** Where the ears are. `forward` defaults to -z, the way a default camera looks. */
  setListener(position: Vec3, forward?: Vec3): void;
  /** 'running', 'suspended' (waiting for a gesture), 'unavailable' (no Web Audio). */
  readonly state: 'running' | 'suspended' | 'unavailable';
  /**
   * The engine's AudioContext, or null when Web Audio is unavailable. For a game that makes its own sound with Web
   * Audio (a synth written in code): it shares this context, so there is one clock and one resume-on-gesture.
   */
  readonly context: AudioContext | null;
  /** A mixer bus's input node ('master' by default), so a game's own graph can join the mix; undefined if there is no such bus. */
  bus(name?: string): AudioNode | undefined;
  dispose(): void;
}

export interface MountOptions {
  /** Mixer id, 'mixer/main' by default; the defaults apply if there is no such file. */
  mixer?: string;
  /** Where reports go. Default: console.warn. */
  onError?: (message: string) => void;
  /** For tests: make the context yourself. */
  createContext?: () => AudioContext;
}

interface Voice { built: Built; end: number }
interface LoopVoice { entry: Entry; out: AudioNode; nodes: AudioNode[]; gain: number; nextAt: number; current: Built | null; stopped: boolean }

interface Entry {
  id: string;
  sound: Sound | null;
  unwatch: (() => void) | null;
  voices: Voice[];
  lastStart: number;
  plays: number;
  bag: number[];
  seq: number;
  loops: LoopVoice[];
}

const REVERB_SECONDS = 1.4;
const LOOKAHEAD = 0.15;

const noop: AudioView = {
  play: () => undefined,
  setBus: () => {},
  setListener: () => {},
  state: 'unavailable',
  context: null,
  bus: () => undefined,
  dispose: () => {},
};

export function mountAudio(game: Game, opts: MountOptions = {}): AudioView {
  const reported = new Set<string>();
  const report = (key: string, message: string): void => {
    if (reported.has(key)) return;
    reported.add(key);
    (opts.onError ?? ((m: string) => console.warn(`[hull audio] ${m}`)))(message);
  };

  let ctx: AudioContext;
  try {
    ctx = opts.createContext ? opts.createContext() : new AudioContext();
  } catch (e) {
    report('context', `Web Audio is not available, sound is off (${(e as Error).message})`);
    return noop;
  }

  const entries = new Map<string, Entry>();
  const buses = new Map<string, GainNode>();
  const busTo = new Map<string, string | null>();
  let disposed = false;

  // Master chain: bus "master" -> compressor -> limiter -> out. With no compressor in the mixer the compressor
  // is set to do nothing, so the chain never changes shape.
  const compressor = ctx.createDynamicsCompressor();
  const limiter = ctx.createDynamicsCompressor();
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.1;
  compressor.connect(limiter);
  limiter.connect(ctx.destination);

  const reverb = ctx.createConvolver();
  {
    const [l, r] = makeImpulse(ctx.sampleRate, REVERB_SECONDS, 0x7265);
    const buf = ctx.createBuffer(2, l.length, ctx.sampleRate);
    buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
    reverb.buffer = buf;
  }

  const applyMixer = (plan: MixerPlan): void => {
    for (const p of plan.problems) report(`mixer:${p}`, p);
    const wanted = new Set(plan.buses.map((b) => b.name));
    for (const b of plan.buses) {
      let node = buses.get(b.name);
      if (!node) { node = ctx.createGain(); buses.set(b.name, node); }
      node.gain.setTargetAtTime(dbToLinear(b.levelDb), ctx.currentTime, 0.02);
      node.disconnect();
      busTo.set(b.name, b.to);
    }
    for (const b of plan.buses) {
      const node = buses.get(b.name)!;
      node.connect(b.to ? buses.get(b.to)! : compressor);
    }
    // A bus that left the file: keep its node (voices may still be playing into it) but send it to master.
    for (const [name, node] of buses) {
      if (!wanted.has(name)) { node.disconnect(); node.connect(buses.get('master')!); }
    }
    if (plan.compressor) {
      compressor.threshold.value = plan.compressor.threshold;
      compressor.ratio.value = plan.compressor.ratio;
      compressor.knee.value = 12;
    } else {
      compressor.threshold.value = 0;
      compressor.ratio.value = 1;
      compressor.knee.value = 0;
    }
    limiter.threshold.value = plan.limiterDb;
  };

  const mixerId = opts.mixer ?? 'mixer/main';
  const loadMixer = (): void => {
    let m: Mixer | undefined;
    try {
      m = config.has(mixerId) ? (config.lookup('mixer', mixerId.replace(/^mixer\//, '')) as Mixer) : undefined;
    } catch (e) {
      report(`mixer-load`, `${mixerId}: ${(e as Error).message}`);
    }
    applyMixer(planMixer(m, mixerId));
  };
  loadMixer();
  const unwatchMixer = config.watch(mixerId, () => loadMixer());
  reverb.connect(buses.get('master')!);

  // Browsers keep a context suspended until a gesture; resume on the first one and then stop listening.
  const gestures = ['pointerdown', 'keydown', 'touchend', 'mousedown'] as const;
  const onGesture = (): void => {
    void ctx.resume().then(() => {
      if (ctx.state === 'running' && typeof window !== 'undefined') for (const g of gestures) window.removeEventListener(g, onGesture, true);
    }, () => {});
  };
  if (typeof window !== 'undefined') for (const g of gestures) window.addEventListener(g, onGesture, true);
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

  let listener: Vec3 = [0, 0, 0];
  let forward: Vec3 = [0, 0, -1];

  const idOf = (id: string): string => (id.startsWith('sound/') ? id.slice(6) : id);

  const entryFor = (id: string): Entry => {
    const rel = idOf(id);
    let e = entries.get(rel);
    if (e) return e;
    e = { id: rel, sound: null, unwatch: null, voices: [], lastStart: -1, plays: 0, bag: [], seq: 0, loops: [] };
    entries.set(rel, e);
    const entry = e;
    if (config.has(`sound/${rel}`)) {
      try { entry.sound = config.lookup('sound', rel) as Sound; } catch (err) { report(`get:${rel}`, `sound/${rel}: ${(err as Error).message}`); }
    }
    // Live rebuild: the new recipe applies to the next play, and a looping sound restarts on it at once.
    entry.unwatch = config.watch(`sound/${rel}`, (now) => {
      entry.sound = now as Sound;
      reported.delete(`unknown:${rel}`);
      reported.delete(`build:${rel}`);
      for (const l of entry.loops) { l.current?.stop(); l.current = null; l.nextAt = ctx.currentTime; }
    });
    return entry;
  };

  const play = (id: string, o: PlayOptions = {}, depth = 0): SoundHandle | undefined => {
    if (disposed || ctx.state !== 'running') return undefined;
    const e = entryFor(id);
    const s = e.sound;
    if (!s) { report(`unknown:${e.id}`, `sound/${e.id} does not exist (expected config/sound/${e.id}.json)`); return undefined; }
    const level = dbToLinear(s.level ?? 0) * (o.volume ?? 1);

    if (s.source.type === 'pick') {
      if (depth > 4) { report(`pickdepth:${e.id}`, `sound/${e.id}#/source/from: picks nest more than 4 deep`); return undefined; }
      const from = s.source.from;
      let i = 0;
      const mode = s.source.mode ?? 'random';
      if (mode === 'sequence') i = e.seq++ % from.length;
      else if (mode === 'shuffle') {
        // A bag: every item once, in a random order, before any repeats.
        if (e.bag.length === 0) {
          const rng = new RandomStream(hashString(e.id), `bag:${e.plays}`);
          for (let k = 0; k < from.length; k++) e.bag.push(k);
          for (let k = from.length - 1; k > 0; k--) { const j = rng.int(0, k); const t = e.bag[k]!; e.bag[k] = e.bag[j]!; e.bag[j] = t; }
        }
        i = e.bag.pop()!;
      } else i = new RandomStream(hashString(e.id), `pick:${e.plays}`).int(0, from.length - 1);
      e.plays++;
      return play(from[i]!, { ...o, volume: level }, depth + 1);
    }
    if (s.source.type === 'sample') { report(`sample:${e.id}`, `sound/${e.id}#/source/type: sample sources are not built yet; skipped`); return undefined; }
    if (s.source.type === 'code' && !hasGenerator(s.source.generator)) {
      report(`gen:${e.id}`, `sound/${e.id}#/source/generator: no generator named "${s.source.generator}" is registered; skipped`);
      return undefined;
    }

    const now = ctx.currentTime;
    const lim = s.limit;
    if (lim?.minGap && now - e.lastStart < lim.minGap) return undefined;
    e.voices = e.voices.filter((v) => v.end > now);
    const maxVoices = lim?.voices ?? 8;
    if (e.voices.length + e.loops.length >= maxVoices) {
      if ((lim?.over ?? 'steal-oldest') === 'skip') return undefined;
      const oldest = e.voices.shift();
      if (oldest) oldest.built.stop();
      else return undefined;
    }

    // Place it: distance gain, air absorption and pan from the listener.
    let gain = level;
    let spatial: { cutoff: number | null; pan: number } | null = null;
    if (o.at) {
      const ref = s.spatial?.ref ?? 5;
      const max = s.spatial?.max ?? 80;
      const d = distanceBetween(listener, o.at);
      const g = distanceGain(d, ref, max);
      if (g <= 0.001) return undefined;
      gain *= g;
      spatial = { cutoff: (s.spatial?.airLowpass ?? true) ? airCutoff(d, ref, max) : null, pan: panFor(listener, forward, o.at) };
    }

    const busName = s.bus ?? 'sfx';
    let bus = buses.get(busName);
    if (!bus) {
      report(`bus:${busName}`, `sound/${e.id}#/bus: there is no bus "${busName}" in the mixer; played on master`);
      bus = buses.get('master')!;
    }
    const nodes: AudioNode[] = [];
    let out: AudioNode = bus;
    if (spatial) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = spatial.pan;
      pan.connect(bus);
      nodes.push(pan);
      out = pan;
      if (spatial.cutoff !== null) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = spatial.cutoff;
        lp.connect(pan);
        nodes.push(lp);
        out = lp;
      }
    }

    e.lastStart = now;
    e.plays++;
    const seed = hashString(e.id) + e.plays * 7919;
    const t0 = now + 0.005;
    try {
      if (s.loop) {
        const l: LoopVoice = { entry: e, out, nodes, gain, nextAt: t0, current: null, stopped: false };
        e.loops.push(l);
        loops.push(l);
        pump(l, o.pitch ?? 1);
        return { stop: () => stopLoop(l) };
      }
      const built = buildSound(ctx, s, seed, t0, out, o.pitch ?? 1, { gain, reverbIn: reverb });
      e.voices.push({ built, end: built.end });
      if (nodes.length) releaseLater(nodes, built.end - now + 0.2);
      return { stop: () => built.stop() };
    } catch (err) {
      report(`build:${e.id}`, `sound/${e.id}: ${(err as Error).message}; skipped`);
      return undefined;
    }
  };

  // Looping sounds are rebuilt one play ahead, so the loop has no gap and needs no timer.
  const loops: LoopVoice[] = [];
  const pitches = new WeakMap<LoopVoice, number>();
  const pump = (l: LoopVoice, pitch: number): void => {
    pitches.set(l, pitch);
    const s = l.entry.sound;
    if (!s) return;
    while (!l.stopped && l.nextAt < ctx.currentTime + LOOKAHEAD) {
      l.entry.plays++;
      try {
        const b = buildSound(ctx, s, hashString(l.entry.id) + l.entry.plays * 7919, l.nextAt, l.out, pitch, { gain: l.gain, reverbIn: reverb });
        l.current = b;
        l.nextAt = Math.max(l.nextAt + 0.01, b.end);
      } catch (err) {
        report(`build:${l.entry.id}`, `sound/${l.entry.id}: ${(err as Error).message}; loop stopped`);
        stopLoop(l);
        return;
      }
    }
  };
  const stopLoop = (l: LoopVoice): void => {
    l.stopped = true;
    l.current?.stop();
    const i = loops.indexOf(l);
    if (i >= 0) loops.splice(i, 1);
    const j = l.entry.loops.indexOf(l);
    if (j >= 0) l.entry.loops.splice(j, 1);
  };
  const offFrame = game.onFrame(() => {
    for (let i = 0; i < loops.length; i++) {
      const l = loops[i]!;
      pump(l, pitches.get(l) ?? 1);
    }
  });

  // Panner and low-pass nodes for a placed sound are released once the sound has ended. Audio nodes have no timer
  // of their own; the frame callback checks the list, which is empty most of the time.
  const pending: { nodes: AudioNode[]; at: number }[] = [];
  const releaseLater = (nodes: AudioNode[], seconds: number): void => { pending.push({ nodes, at: ctx.currentTime + seconds }); };
  const offClean = game.onFrame(() => {
    if (pending.length === 0) return;
    const t = ctx.currentTime;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]!;
      if (p.at > t) continue;
      for (const n of p.nodes) n.disconnect();
      pending.splice(i, 1);
    }
  });

  return {
    play: (id, o) => {
      try { return play(id, o); } catch (err) { report(`play:${id}`, `${id}: ${(err as Error).message}`); return undefined; }
    },
    setBus(name, db) {
      const b = buses.get(name);
      if (!b) { report(`setbus:${name}`, `setBus: there is no bus "${name}"`); return; }
      b.gain.setTargetAtTime(dbToLinear(db), ctx.currentTime, 0.02);
    },
    setListener(position, fwd) {
      listener = position;
      if (fwd) forward = fwd;
    },
    get state() { return disposed ? 'unavailable' : ctx.state === 'running' ? 'running' : 'suspended'; },
    get context() { return disposed ? null : ctx; },
    bus: (name = 'master') => buses.get(name),
    dispose() {
      if (disposed) return;
      disposed = true;
      offFrame();
      offClean();
      unwatchMixer();
      for (const e of entries.values()) e.unwatch?.();
      if (typeof window !== 'undefined') for (const g of gestures) window.removeEventListener(g, onGesture, true);
      void ctx.close().catch(() => {});
    },
  };
}
