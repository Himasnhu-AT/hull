// The config contract types. They live in their own file so the schema module can augment `HullKinds` here.

/** Every id per kind, written by `check` / `dev` into .hull/gen/ids.ts through module augmentation. */
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

/** `ids` is per kind, with ids relative to the kind: kind 'tuning', id 'jump' for config/tuning/jump.json. */
export interface LoadResult { ok: boolean; problems: Problem[]; ids: Record<string, string[]> }

export interface ConfigRegistry {
  /** Parse, validate and resolve references for every file; replaces the whole set. A path of 'hull.json' is the manifest. */
  load(files: readonly ConfigSource[]): LoadResult;
  /** Dev: one file changed or was added. Validates it; on success replaces the value and calls watchers. */
  update(file: ConfigSource): LoadResult;
  remove(path: string): void;
  /** `id` is relative to the kind: get('tuning', 'jump') reads config/tuning/jump.json. Throws if it does not exist. */
  get<K extends Kind>(kind: K, id: IdOf<K>): HullKinds[K];
  /**
   * The same read for ids that arrive as data (a Mesh's `material`, a look named in a manifest). Engine code uses
   * this: a game's generated id types are applied when the game is checked, and engine code must not depend on
   * which ids one game happens to have. Game code uses `get`, so a wrong id is a compile error.
   */
  lookup<K extends Kind>(kind: K, id: string): HullKinds[K];
  /** Full id, e.g. 'tuning/jump'. */
  has(id: string): boolean;
  /** Ids of one kind, relative to the kind, sorted. */
  ids(kind: string): readonly string[];
  /** Called after every load, update or removal that changed the registry. Returns an unsubscribe. */
  onChange(fn: () => void): () => void;
  /** Full id, e.g. 'sound/sword/hit'. Returns an unsubscribe. */
  watch(id: string, fn: (now: unknown) => void): () => void;
  /** Source text for .hull/gen/ids.ts. */
  idsModule(): string;
  /** The validated hull.json, if one was loaded. */
  manifest(): import('../schema/index.ts').Manifest | undefined;
}

export interface NumOpts { min?: number; max?: number; step?: number; unit?: string; widget?: 'slider' | 'dial' | 'number'; help?: string }
export interface Tunable<T> { readonly kind: 'num' | 'bool' | 'color' | 'vec' | 'choice' | 'range' | 'curve'; readonly value: T; readonly opts: object }

export type TunableValues<S extends Record<string, Tunable<unknown>>> = { readonly [K in keyof S]: S[K]['value'] };

export interface TunableInfo { block: string; key: string; kind: Tunable<unknown>['kind']; value: unknown; initial: unknown; opts: object }
