import { input, type InputView } from 'hull/input';

// The two doors between the simulation and the outside world. Game code reads input and plays sounds only through
// here, so a test can swap in a recording and a counter without a browser.

export const rig: { input: InputView } = { input };

// The same options audio.play takes (volume, pitch, at, spatial, params), so spatial sound needs no cast.
import type { PlayOptions } from 'hull/audio';
export type PlayOpts = PlayOptions;
type Player = { play(id: string, opts?: PlayOpts): unknown };

/** Sounds are effects, not state: they never change what the simulation does. */
export const sound = {
  /** Replaces the speakers (tests). */
  sink: null as null | ((id: string, opts?: PlayOpts) => void),
  play(id: string, opts?: PlayOpts): void {
    if (sound.sink) { sound.sink(id, opts); return; }
    // The page fills globalThis.hull as each view mounts, after `ready`, so it is read at the moment of the play.
    (globalThis as { hull?: { audio?: Player } }).hull?.audio?.play(id, opts);
  },
};
