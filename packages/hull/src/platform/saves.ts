// Versioned JSON saves. A save file is `{ hull: 'save', version, savedAt, data }`. Reading runs the migrations from the
// file's version up to the game's, so an old save keeps working; a file that is corrupt, or newer than the game, is
// reported once and skipped, never thrown at the game.
import { checkName } from './store.ts';
import type { Report, Store } from './types.ts';

/** `migrations[n]` turns data of version n into data of version n + 1. */
export type Migrations = Record<number, (data: unknown) => unknown>;

export interface SaveInfo { slot: string; version: number; savedAt: number }

export interface SavesOptions {
  store: Store;
  /** The version of the data the game writes now. */
  version: number;
  migrations?: Migrations;
  report?: Report;
  /** For tests. Saves are not simulation, so the wall clock is fine here. */
  now?: () => number;
}

export interface Saves {
  /** Throws if the slot name is not plain (a bug in the game). Returns false when the store refused the write. */
  write(slot: string, data: unknown): boolean;
  /** The migrated data, or null when the slot is empty, corrupt or from a newer game. */
  read<T = unknown>(slot: string): T | null;
  /** Readable slots, newest first. Corrupt ones are left out (and reported). */
  list(): SaveInfo[];
  delete(slot: string): void;
}

interface Envelope { hull: 'save'; version: number; savedAt: number; data: unknown }

export function createSaves(opts: SavesOptions): Saves {
  const { store, version, migrations = {} } = opts;
  const now = opts.now ?? Date.now;
  const reported = new Set<string>();
  const report = (slot: string, message: string): void => {
    const key = `${slot}:${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    (opts.report ?? ((m: string) => console.warn(`[hull saves] ${m}`)))(`saves/${slot}: ${message}`);
  };

  function parse(slot: string): Envelope | null {
    const text = store.read('saves', slot);
    if (text === null) return null;
    let env: unknown;
    try { env = JSON.parse(text); } catch (e) { report(slot, `corrupt, skipped (${(e as Error).message})`); return null; }
    const o = env as Partial<Envelope> | null;
    if (!o || typeof o !== 'object' || o.hull !== 'save' || !Number.isInteger(o.version) || (o.version as number) < 1 || !('data' in o)) {
      report(slot, 'not a Hull save file, skipped');
      return null;
    }
    return o as Envelope;
  }

  return {
    write(slot, data) {
      checkName('save slot', slot);
      const env: Envelope = { hull: 'save', version, savedAt: now(), data };
      return store.write('saves', slot, JSON.stringify(env));
    },
    read<T>(slot: string): T | null {
      checkName('save slot', slot);
      const env = parse(slot);
      if (!env) return null;
      if (env.version > version) { report(slot, `was written by a newer version of the game (save v${env.version}, game v${version}), skipped`); return null; }
      let data = env.data;
      for (let v = env.version; v < version; v++) {
        const step = migrations[v];
        if (!step) { report(slot, `has no migration from version ${v} to ${v + 1}, skipped`); return null; }
        try { data = step(data); } catch (e) { report(slot, `migration ${v} to ${v + 1} failed (${(e as Error).message}), skipped`); return null; }
      }
      return data as T;
    },
    list() {
      const out: SaveInfo[] = [];
      for (const slot of store.list('saves')) {
        const env = parse(slot);
        if (env) out.push({ slot, version: env.version, savedAt: Number(env.savedAt) || 0 });
      }
      return out.sort((a, b) => b.savedAt - a.savedAt || (a.slot < b.slot ? -1 : 1));
    },
    delete(slot) {
      checkName('save slot', slot);
      store.remove('saves', slot);
    },
  };
}
