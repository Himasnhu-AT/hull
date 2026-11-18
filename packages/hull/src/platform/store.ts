import { NAME_RE, type Area, type Store } from './types.ts';

/** In memory: tests, and the fallback when a browser refuses localStorage (private window, blocked site data). */
export function memoryStore(): Store & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const key = (a: Area, n: string): string => `${a}/${n}`;
  return {
    files,
    read: (a, n) => files.get(key(a, n)) ?? null,
    write(a, n, t) { files.set(key(a, n), t); return true; },
    remove(a, n) { files.delete(key(a, n)); },
    list: (a) => [...files.keys()].filter((k) => k.startsWith(`${a}/`)).map((k) => k.slice(a.length + 1)).sort(),
  };
}

interface StorageLike {
  readonly length: number;
  key(i: number): string | null;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/**
 * localStorage under `hull:<gameId>:<area>:<name>`. Every call is guarded: storage can throw at any time (quota,
 * blocked site data), and a game must not die because a save did not stick.
 */
export function localStore(gameId: string, storage: StorageLike): Store {
  const prefix = (a: Area): string => `hull:${gameId}:${a}:`;
  return {
    read(a, n) { try { return storage.getItem(prefix(a) + n); } catch { return null; } },
    write(a, n, t) { try { storage.setItem(prefix(a) + n, t); return true; } catch { return false; } },
    remove(a, n) { try { storage.removeItem(prefix(a) + n); } catch { /* nothing to remove */ } },
    list(a) {
      const out: string[] = [];
      try {
        const p = prefix(a);
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k && k.startsWith(p)) out.push(k.slice(p.length));
        }
      } catch { /* an empty list is the honest answer */ }
      return out.sort();
    },
  };
}

/** Rejects a name that is not a plain slot name before it reaches any store. */
export function checkName(kind: string, name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`${kind} "${name}" is not valid: use 1 to 64 letters, digits, "-" or "_"`);
}
