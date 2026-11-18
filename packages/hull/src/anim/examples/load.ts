/// <reference types="vite/client" />
// The example characters, clips and graphs as config sources, for tests and the bench page. Vite inlines the files
// as text; under vitest (Node) they are read from disk.
import type { ConfigSource } from '../../config/types.ts';

const raw = import.meta.glob<string>('./config/**/*.json', { query: '?raw', import: 'default', eager: true });

/** Every example file as `config/<kind>/<id>.json` plus its text. */
export function exampleSources(): ConfigSource[] {
  return Object.entries(raw).map(([path, text]) => ({ path: `config/${path.slice('./config/'.length)}`, text }));
}
