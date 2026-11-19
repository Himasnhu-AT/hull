// The game's code sound generators, registered for the Studio's sound bench (hull.json "generators"). The game does the
// same inside audio.ts when it starts; this is only the registration, with no audio engine behind it.
import { registerAottGenerators } from './gens';
import { registerAottLive } from './live';

export default function registerGenerators(): void {
  registerAottGenerators();
  registerAottLive();
}
