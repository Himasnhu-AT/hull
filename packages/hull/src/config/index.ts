// hull config: the registry of config files, validation, typed access, live updates and tunables.
// Runs in Node and the browser: it never reads the disk. The command line and the dev server read files and
// hand them in as text, so the same code serves a remote project later.
import { createRegistry } from './registry.ts';
import { bindTunables } from './tunables.ts';

export * from './types.ts';
export { createRegistry, checkManifest } from './registry.ts';
export { num, bool, color, vec, choice, range, curve, tunables, listTunables, setTunable, resetTunables, bindTunables, tuningProblems, tunableProblem, tuningIdOf } from './tunables.ts';

/** The registry the game reads; the dev runtime and builds fill it before `ready`. */
export const config = createRegistry();
bindTunables(config);
