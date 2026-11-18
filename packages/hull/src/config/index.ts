// hull config: the registry of config files, validation, typed access, live updates and tunables.
// Runs in Node and the browser: it never reads the disk. The command line and the dev server read files and
// hand them in as text, so the same code serves a remote project later.
//
// CONTRACT STUB. The config worker replaces `declare` with the implementation.

/** Every id per kind, written by `hull check` / `hull dev` into .hull/gen/ids.ts through module augmentation. */
export interface HullIds {}

/** Value types per kind, filled in by the schema module (packages/hull/src/schema). */
export interface HullKinds {}

export type Kind = keyof HullKinds & string;
export type IdOf<K extends string> = K extends keyof HullIds ? HullIds[K] : string;

/** A problem names its place: file:line:col for code, file#/json/pointer for config. */
export interface Problem {
  file: string;
  /** JSON pointer inside a config file, e.g. '/layers/0/freq'. */
  pointer?: string;
  line?: number;
  col?: number;
  message: string;
  /** Short machine-readable rule name: 'schema', 'ref', 'kind-mismatch', 'parse', 'house-rule', 'types'. */
  rule: string;
}

/** A config file handed to the registry: its path relative to the project root, and its text. */
export interface ConfigSource { path: string; text: string }

export interface LoadResult { ok: boolean; problems: Problem[]; ids: Record<string, string[]> }

export interface ConfigRegistry {
  /** Parse, validate and resolve references for every file; replaces the whole set. */
  load(files: readonly ConfigSource[]): LoadResult;
  /** Dev: one file changed or was added. Validates it; on success replaces the value and calls watchers. */
  update(file: ConfigSource): LoadResult;
  remove(path: string): void;
  get<K extends Kind>(kind: K, id: IdOf<K>): HullKinds[K];
  has(id: string): boolean;
  ids(kind: string): readonly string[];
  /** Full id, e.g. 'sound/sword/hit'. Returns an unsubscribe. */
  watch(id: string, fn: (now: unknown) => void): () => void;
  /** Source text for .hull/gen/ids.ts. */
  idsModule(): string;
}

export declare function createRegistry(): ConfigRegistry;

/** The registry the game reads; the dev runtime and builds fill it before `ready`. */
export declare const config: ConfigRegistry;

// ---- tunables: values that live in code ---------------------------------------------------------------------

export interface NumOpts { min?: number; max?: number; step?: number; unit?: string; widget?: 'slider' | 'dial' | 'number'; help?: string }
export interface Tunable<T> { readonly kind: 'num' | 'bool' | 'color' | 'vec' | 'choice' | 'range' | 'curve'; readonly value: T; readonly opts: object }

export declare function num(value: number, opts?: NumOpts): Tunable<number>;
export declare function bool(value: boolean, opts?: { help?: string }): Tunable<boolean>;
export declare function color(value: string, opts?: { help?: string }): Tunable<string>;
export declare function vec(value: readonly [number, number, number], opts?: NumOpts): Tunable<[number, number, number]>;
export declare function choice<const C extends readonly string[]>(value: C[number], options: C, opts?: { help?: string }): Tunable<C[number]>;
export declare function range(value: readonly [number, number], opts?: NumOpts): Tunable<[number, number]>;
export declare function curve(value: readonly (readonly [number, number])[], opts?: { help?: string }): Tunable<[number, number][]>;

export type TunableValues<S extends Record<string, Tunable<unknown>>> = { readonly [K in keyof S]: S[K]['value'] };

/** Declares a block of values owned by code. Properties are getters over cells the dev runtime can set. */
export declare function tunables<S extends Record<string, Tunable<unknown>>>(name: string, spec: S): TunableValues<S>;

export interface TunableInfo { block: string; key: string; kind: Tunable<unknown>['kind']; value: unknown; initial: unknown; opts: object }

/** Dev runtime: every declared tunable. */
export declare function listTunables(): TunableInfo[];
/** Dev runtime: `setTunable('player.runSpeed', 14)`; validated against the tunable's opts. */
export declare function setTunable(path: string, value: unknown): Problem | null;
