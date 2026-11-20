// The doors between a kit and the outside world: input, sound, saves and the UI layer. Kits read and write only
// through here, so a test swaps in a headless input and a counter, and the page fills in the rest as it mounts.
import { input, type InputView } from '../input/index.ts';
import { createSaves, localStore, memoryStore, type Platform, type Saves, type Store } from '../platform/index.ts';
import type { UiView } from '../ui/index.ts';

import type { PlayOptions } from '../audio/engine.ts';

/** The same options `audio.play` takes (volume, pitch, `at`, `spatial`, `params`), so spatial sound needs no cast. */
export type PlayOpts = PlayOptions;
interface Views { ui?: UiView; audio?: { play(id: string, opts?: PlayOpts): unknown }; platform?: Platform }
const views = (): Views => (globalThis as { hull?: Views }).hull ?? {};

let saves: Saves | null = null;

export const kitIO = {
  /** Replaced by a headless InputCore in tests. */
  input: input as InputView,
  /** Replaces the speakers (tests). Sounds are effects only: they never change what the simulation does. */
  sink: null as null | ((id: string, opts?: PlayOpts) => void),
  play(id: string, opts?: PlayOpts): void {
    if (kitIO.sink) { kitIO.sink(id, opts); return; }
    views().audio?.play(id, opts);
  },
  /** The mounted UI layer, or null before the page mounts it (and in Node). */
  ui(): UiView | null { return views().ui ?? null; },
  /** The platform's saves when the page has one, else saves kept in localStorage (browser) or memory (tests). */
  saves(): Saves {
    const p = views().platform;
    if (p) return p.saves;
    if (!saves) {
      let store: Store = memoryStore();
      try {
        const ls = (globalThis as { localStorage?: Storage }).localStorage;
        if (ls) store = localStore('hull-kits', ls);
      } catch { /* blocked site data */ }
      saves = createSaves({ store, version: 1 });
    }
    return saves;
  },
  /** Tests: use these saves from now on (null goes back to the default). */
  useSaves(s: Saves | null): void { saves = s; },
};
