// Player settings: volume per bus, quality, fullscreen, look options and key bindings. Kept as one JSON file, applied
// to the audio buses, the render view, the input overrides and the window when the game starts and on every change.
import { config } from '../config/index.ts';
import type { Overrides } from '../input/map.ts';
import type { Quality } from '../render/backend.ts';
import { planMixer } from '../audio/mixer-plan.ts';
import type { Mixer } from '../schema/mixer.ts';
import type { Report, Store } from './types.ts';

export const QUALITIES: readonly Quality[] = ['low', 'medium', 'high'];

/** What each quality means besides the render view's own switch: the cap on the device pixel ratio. */
export const QUALITY_PRESETS: Readonly<Record<Quality, { pixelRatioCap: number }>> = {
  low: { pixelRatioCap: 1 },
  medium: { pixelRatioCap: 1.5 },
  high: { pixelRatioCap: 2 },
};

export interface SettingsValues {
  /** Per bus, 0 to 1 of the level the mixer file gives that bus. Buses not listed are at 1. */
  volume: Record<string, number>;
  quality: Quality;
  fullscreen: boolean;
  /** Games read these two when they turn mouse or stick movement into a look rotation (see `look()`). */
  invertY: boolean;
  sensitivity: number;
  /** The player's key changes, exactly what `input.overrides()` returns. */
  bindings: Overrides;
}

export const DEFAULT_SETTINGS: Readonly<SettingsValues> = {
  volume: {},
  quality: 'medium',
  fullscreen: false,
  invertY: false,
  sensitivity: 1,
  bindings: {},
};

export const SENSITIVITY_RANGE = { min: 0.25, max: 3 } as const;
const VERSION = 1;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Takes whatever was on disk and returns settings that are safe to apply; reports each field it had to drop. */
export function sanitize(raw: unknown, defaults: SettingsValues, report: Report = () => {}): SettingsValues {
  const out: SettingsValues = { ...defaults, volume: { ...defaults.volume }, bindings: { ...defaults.bindings } };
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;
  const bool = (k: string): boolean | undefined => {
    if (!(k in o)) return undefined;
    if (typeof o[k] === 'boolean') return o[k] as boolean;
    report(`settings#/${k}: expected true or false, using the default`);
    return undefined;
  };
  if (o['volume'] && typeof o['volume'] === 'object') {
    for (const [bus, v] of Object.entries(o['volume'] as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out.volume[bus] = clamp(v, 0, 1);
      else report(`settings#/volume/${bus}: expected a number from 0 to 1, dropped`);
    }
  }
  if ('quality' in o) {
    if (QUALITIES.includes(o['quality'] as Quality)) out.quality = o['quality'] as Quality;
    else report(`settings#/quality: "${String(o['quality'])}" is not low, medium or high, using the default`);
  }
  out.fullscreen = bool('fullscreen') ?? out.fullscreen;
  out.invertY = bool('invertY') ?? out.invertY;
  if ('sensitivity' in o) {
    const s = o['sensitivity'];
    if (typeof s === 'number' && Number.isFinite(s)) out.sensitivity = clamp(s, SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max);
    else report('settings#/sensitivity: expected a number, using the default');
  }
  if (o['bindings'] && typeof o['bindings'] === 'object') {
    out.bindings = {};
    for (const [action, slots] of Object.entries(o['bindings'] as Record<string, unknown>)) {
      if (!slots || typeof slots !== 'object') { report(`settings#/bindings/${action}: expected slots, dropped`); continue; }
      const clean: Record<string, string[]> = {};
      for (const [slot, list] of Object.entries(slots as Record<string, unknown>)) {
        if (Array.isArray(list) && list.every((x) => typeof x === 'string')) clean[slot] = list as string[];
        else report(`settings#/bindings/${action}/${slot}: expected a list of key names, dropped`);
      }
      out.bindings[action] = clean;
    }
  }
  return out;
}

/** The parts of the game that settings reach. Each is optional: a game without audio just has no `audio`. */
export interface ApplyTargets {
  audio?: { setBus(bus: string, db: number): void };
  render?: { setQuality(q: Quality): void };
  input?: { setOverrides(o: Overrides): void; overrides(): Overrides; onBindingsChanged(fn: () => void): () => void };
  /** Called with the wanted state; the platform's fullscreen setter fits. */
  fullscreen?: (on: boolean) => void;
  /** Level in dB of each bus as the mixer file authors it. Default: read from `mixer/main`, else the built-in mixer. */
  busLevels?: Record<string, number>;
  /** Called with the pixel ratio cap of the chosen quality. */
  pixelRatioCap?: (cap: number) => void;
}

export interface Settings {
  readonly values: Readonly<SettingsValues>;
  /** Merges `patch`, keeps it, applies what changed. Out-of-range values are clamped, not thrown. */
  set(patch: Partial<SettingsValues>): void;
  setVolume(bus: string, v: number): void;
  reset(): void;
  onChange(fn: (values: Readonly<SettingsValues>) => void): () => void;
  /** Applies everything now and again on each change. Returns a function that stops applying. */
  apply(targets: ApplyTargets): () => void;
  /** Look input after the player's options: `out` is written; nothing is allocated. */
  look(dx: number, dy: number, out: { x: number; y: number }): void;
}

export interface SettingsOptions {
  store: Store;
  defaults?: Partial<SettingsValues>;
  report?: Report;
}

export const dbForVolume = (authoredDb: number, v: number): number => (v <= 0 ? -80 : authoredDb + 20 * Math.log10(v));

function authoredLevels(): Record<string, number> {
  const mixer = config.has('mixer/main') ? (config.lookup('mixer', 'main') as Mixer) : undefined;
  const out: Record<string, number> = {};
  for (const b of planMixer(mixer).buses) out[b.name] = b.levelDb;
  return out;
}

export function createSettings(opts: SettingsOptions): Settings {
  const report = opts.report ?? ((m: string) => console.warn(`[hull settings] ${m}`));
  const defaults: SettingsValues = { ...DEFAULT_SETTINGS, ...opts.defaults, volume: { ...opts.defaults?.volume }, bindings: { ...opts.defaults?.bindings } };
  const fresh = (): SettingsValues => ({ ...defaults, volume: { ...defaults.volume }, bindings: { ...defaults.bindings } });

  let values: SettingsValues = fresh();
  const text = opts.store.read('settings', 'settings');
  if (text !== null) {
    try {
      const file = JSON.parse(text) as { values?: unknown } | null;
      if (file && typeof file === 'object' && file.values) values = sanitize(file.values, defaults, report);
      else report('settings: not a Hull settings file, using the defaults');
    } catch (e) {
      report(`settings: corrupt (${(e as Error).message}), using the defaults`);
    }
  }

  const listeners = new Set<(v: Readonly<SettingsValues>) => void>();
  const persist = (): void => {
    if (!opts.store.write('settings', 'settings', JSON.stringify({ version: VERSION, values }))) report('settings: could not be saved (storage refused the write)');
  };
  const emit = (): void => { for (const fn of [...listeners]) fn(values); };

  const self: Settings = {
    get values() { return values; },
    set(patch) {
      const merged = sanitize({ ...values, ...patch, volume: { ...values.volume, ...patch.volume } }, defaults, report);
      values = merged;
      persist();
      emit();
    },
    setVolume(bus, v) { self.set({ volume: { [bus]: v } }); },
    reset() { values = fresh(); persist(); emit(); },
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    look(dx, dy, out) {
      out.x = dx * values.sensitivity;
      out.y = dy * values.sensitivity * (values.invertY ? -1 : 1);
    },
    apply(t) {
      const levels = t.busLevels ?? authoredLevels();
      const offs: (() => void)[] = [];
      const last = { volume: new Map<string, number>(), quality: '', fullscreen: null as boolean | null, bindings: '' };
      const push = (v: Readonly<SettingsValues>, first: boolean): void => {
        if (t.audio) {
          // A bus the player never touched stays at what the mixer file says: only a changed volume is pushed.
          const buses = new Set([...Object.keys(v.volume), ...last.volume.keys()]);
          for (const bus of buses) {
            const vol = v.volume[bus] ?? 1;
            if (last.volume.get(bus) === vol || (vol === 1 && !last.volume.has(bus))) continue;
            last.volume.set(bus, vol);
            t.audio.setBus(bus, dbForVolume(levels[bus] ?? 0, vol));
          }
        }
        if (v.quality !== last.quality) {
          last.quality = v.quality;
          t.render?.setQuality(v.quality);
          t.pixelRatioCap?.(QUALITY_PRESETS[v.quality].pixelRatioCap);
        }
        if (t.fullscreen && v.fullscreen !== last.fullscreen) {
          // The window starts out windowed: only a wanted fullscreen (or a change) asks it to move.
          if (!(first && !v.fullscreen)) t.fullscreen(v.fullscreen);
          last.fullscreen = v.fullscreen;
        }
        const b = JSON.stringify(v.bindings);
        if (t.input && b !== last.bindings) {
          last.bindings = b;
          if (JSON.stringify(t.input.overrides()) !== b) t.input.setOverrides(v.bindings);
        }
      };
      push(values, true);
      offs.push(self.onChange((v) => push(v, false)));
      if (t.input) {
        // A rebind made on the key-binding screen is kept as soon as it happens.
        const input = t.input;
        offs.push(input.onBindingsChanged(() => {
          const now = input.overrides();
          const json = JSON.stringify(now);
          if (json !== JSON.stringify(values.bindings)) {
            values = { ...values, bindings: now };
            last.bindings = json;
            persist();
            emit();
          }
        }));
      }
      return () => { for (const f of offs.splice(0)) f(); };
    },
  };
  return self;
}
