// The project protocol: how the Hull app's front end and a running game talk to the project server.
// JSON-RPC 2.0 over one WebSocket. The server runs inside the app's main process today and on Marl's machines
// later; nothing on the other side of this file may touch the disk.
//
// Clients say who they are in the URL: ws://host:port/?role=studio or ?role=game.
// - studio: the app's editor. Calls methods, receives every push.
// - game: the running game's dev runtime (dev/runtime.ts). Receives config, tunable and control pushes; sends
//   `game.report` notifications. Any number of games may be connected (the editor's view, a bench, a second window).
//
// CONTRACT (M1). Types only. Adding a method or a push is fine; changing one means telling every worker that uses it.

import type { Problem } from '../config/types.ts';

export type Author = 'you' | `ai:${string}` | `marl:${string}`;

export interface ProjectInfo {
  root: string;
  title: string;
  /** Where the game's dev page is served (the editor's game view loads it in a frame). */
  gameUrl: string;
  manifest: unknown;
}

/** One row of the Library: a config file or a tunables block. */
export interface LibraryItem {
  /** Config id ('sound/sword/hit') or 'tunables:<block>' for a code block. */
  id: string;
  kind: string;
  /** Where it lives: 'config/sound/sword/hit.json' or 'src/player/tuning.ts'. */
  path: string;
  title: string;
  note?: string;
  problems: number;
  /** For a tunables block: 'kit' when it is declared by an engine kit rather than the project's own code. */
  source?: 'code' | 'kit';
}

/** A tunable as the Inspector sees it: the dev-runtime info plus where its literal is in the source. */
export interface TunableWire {
  block: string;
  key: string;
  kind: 'num' | 'bool' | 'color' | 'vec' | 'choice' | 'range' | 'curve';
  value: unknown;
  opts: Record<string, unknown>;
  /** The literal's place, so the Inspector can show and the server can rewrite it. */
  file: string;
  line: number;
  col: number;
  /** 'code': the literal is in the project's src/ and edits rewrite it. 'kit': a kit's block in the engine; the project's values live in config/tuning/<block>.json. Absent means 'code'. */
  source?: 'code' | 'kit';
  /** Kit tunables: the value in the kit's code, which the reset arrow returns to by removing the key from the file. `value` is what the project uses now. */
  initial?: unknown;
  /** Kit tunables: the file that holds the project's values, e.g. 'config/tuning/third-person.json'. */
  overrides?: string;
}

export interface WriteResult {
  ok: boolean;
  problems: Problem[];
}

/** A recorded change (M1 keeps them in .hull/journal.jsonl; M2 replays them into the history store). */
export interface Change {
  at: string;
  by: Author;
  /** Config id or 'tunables:<block>'. */
  target: string;
  /** JSON pointer for config, the key for tunables. */
  path: string;
  from: unknown;
  to: unknown;
}

// ---- M2: history and experiments ------------------------------------------------------------------------------------

/** Who made a recorded change. `disk` is an edit made outside Hull (an editor, git). */
export type HistoryAuthor = Author | 'disk';

/** One difference between two states of the project, by path (config JSON), by name (tunables), or by lines. */
export interface ChangeDelta {
  /** The file: 'config/tuning/jump.json' or 'src/tuning.ts'. */
  file: string;
  kind: 'json' | 'tunable' | 'lines' | 'asset' | 'file';
  op: 'set' | 'add' | 'remove';
  /** Config id ('tuning/jump', 'hull.json'), 'tunables:<block>', or the file path for lines, assets and files. */
  target: string;
  /** JSON pointer for json, the tunable key for tunables, '' otherwise. */
  path: string;
  from?: unknown;
  to?: unknown;
  /** For kind 'lines'. */
  added?: number;
  removed?: number;
  /** The plain-words line the timeline shows, like 'tuning/jump: height 2.2 → 2.6'. */
  text: string;
}

/** A change in the timeline (a commit in the history store). */
export interface HistoryChange {
  /** Full commit id; any unambiguous prefix or a checkpoint name is accepted wherever an id is asked for. */
  id: string;
  short: string;
  at: string;
  by: HistoryAuthor;
  /** 'main' or the experiment's name. */
  line: string;
  kind: 'start' | 'change' | 'restore' | 'merge';
  /** The one-line description in plain words. */
  message: string;
  /** Every delta's text, one per line. */
  details: string[];
  parents: string[];
  /** Checkpoint names pointing here. */
  checkpoints: string[];
}

export interface ExpInfo {
  name: string;
  status: 'active' | 'adopted' | 'discarded';
  /** The change it started from. */
  from: string;
  /** Its newest change (equals `from` until it is tuned). */
  tip: string;
  changes: number;
  createdAt: string;
  by: HistoryAuthor;
  /** The experiment's own game page (active experiments only), so two can run side by side. */
  gameUrl?: string;
}

/** A value changed on both sides of a merge. `target#path` is the key for `resolve`. */
export interface MergeConflict {
  file: string;
  kind: ChangeDelta['kind'];
  target: string;
  path: string;
  base?: unknown;
  ours?: unknown;
  theirs?: unknown;
}

export interface ExpAdoptResult {
  ok: boolean;
  /** Nothing is written while conflicts are open: send `resolve` ('ours' | 'theirs' per `target#path`) and call again. */
  conflicts: MergeConflict[];
  problems: Problem[];
  change?: HistoryChange;
}

export interface GameControl {
  paused?: boolean;
  /** Run exactly n fixed steps (implies paused afterwards). */
  step?: number;
  timeScale?: number;
  /** Start the game again from `ready` with the same seed. */
  restart?: boolean;
}

// ---- M3: the control port --------------------------------------------------------------------------------------------
// An agent drives a running game over the game's own socket: the server sends `game.rpc` to the game, the game answers
// with a `game.result` notification. Time moves only by `step`, so a script gives the same run every time.

export type ControlOp =
  /** Pause and run exactly `n` fixed steps. */
  | { op: 'step'; n: number }
  /** Hold a key (a KeyboardEvent `code`, like 'KeyW' or 'Space') until released. It reaches the game through the input map. */
  | { op: 'press'; key: string }
  | { op: 'release'; key: string }
  /** Tick, time, checksum, and the position of the named nodes (`world.find` paths). */
  | { op: 'state'; nodes?: string[] }
  /** The drawn frame as PNG. */
  | { op: 'screenshot' };

export interface NodeState { found: boolean; x: number; y: number; z: number }
export interface ControlState {
  tick: number; time: number; checksum: string; paused: boolean; nodes: Record<string, NodeState>;
  /** Keys and buttons the game's input holds down now, so a script can tell a key that reached the game from one that did not. */
  held: string[];
}
export interface ControlShot { png: string; width: number; height: number }

export interface GameReport {
  tick: number;
  time: number;
  paused: boolean;
  timeScale: number;
  fps: number;
  checksum?: string;
}

/** A preview the Content Browser draws: numbers and colours only, read from the asset's text. */
export type ContentThumb =
  | { type: 'material'; color: string; roughness: number; metalness: number }
  | { type: 'look'; sky: [string, string, string]; fog: string }
  | { type: 'vfx'; colors: string[] }
  | { type: 'sound'; bars: number[] | null; length: number }
  | { type: 'character'; colors: string[] };

/** A place that names an asset: another config (by pointer) or a string literal in src/. */
export interface AssetRef {
  kind: 'config' | 'code';
  file: string;
  id?: string;
  pointer?: string;
  line: number;
  col: number;
}

export interface AssetResult {
  ok: boolean;
  problems: Problem[];
  /** The places that block (or were rewritten by) the operation. */
  refs?: AssetRef[];
  created?: string[];
  gone?: string[];
}

/** Methods the server answers. */
export interface Methods {
  'project.info': { params: Record<string, never>; result: ProjectInfo };
  'library.list': { params: Record<string, never>; result: LibraryItem[] };
  /** A config file: its text, parsed value, JSON Schema (with x-ui / x-ref) and current problems. */
  'config.read': { params: { id: string }; result: { id: string; path: string; text: string; value: unknown; schema: unknown; problems: Problem[] } };
  /** Set one field. Validated before it is kept; the file keeps its formatting; recorded with its author. */
  'config.set': { params: { id: string; pointer: string; value: unknown; author?: Author; /** Edit this experiment's copy instead of the project. */ exp?: string }; result: WriteResult };
  'tunables.list': { params: Record<string, never>; result: TunableWire[] };
  /** Rewrites the literal in the .ts file (re-parsed and type-checked first) and pushes the value to running games. */
  'tunables.set': { params: { block: string; key: string; value: unknown; author?: Author; /** Edit this experiment's copy instead of the project. */ exp?: string }; result: WriteResult };
  'journal.list': { params: { limit?: number }; result: Change[] };
  /** The timeline, newest first, across the main line and every experiment. */
  'history.list': { params: { limit?: number; line?: string }; result: HistoryChange[] };
  /** What changed: `from` defaults to the parent of `to`. Ids, checkpoint names, 'main' or an experiment name. */
  'history.diff': { params: { from?: string; to: string }; result: { from: string | null; to: string; deltas: ChangeDelta[] } };
  /** Puts the project back as it was at `id`. Itself a new change, so it can be undone. */
  'history.restore': { params: { id: string; author?: Author }; result: { ok: boolean; problems: Problem[]; change?: HistoryChange } };
  /** The compact line diff of one file between two states (`to` may be 'main': the project as it is now). */
  'history.patch': { params: { from?: string; to: string; file: string }; result: { file: string; lines: { op: 'ctx' | 'add' | 'del' | 'gap'; n: number; text: string }[]; binary: boolean } };
  /** Puts one file, or one field of a config file (`pointer`), back as it was at `from`. Validated like `history.restore`; a new change, so it can be undone. */
  'history.revert': { params: { from: string; file: string; pointer?: string; author?: Author }; result: { ok: boolean; problems: Problem[]; change?: HistoryChange } };
  'history.checkpoint': { params: { name: string; id?: string }; result: { name: string; id: string } };
  /** Makes a working copy under .hull/exp/<name>/ from `from` (default: the project's newest change). */
  'exp.start': { params: { name: string; from?: string; author?: Author }; result: ExpInfo };
  'exp.list': { params: Record<string, never>; result: ExpInfo[] };
  /** The value differences between two lines ('main' or an experiment name), a to b. */
  'exp.compare': { params: { a: string; b: string }; result: { a: string; b: string; deltas: ChangeDelta[] } };
  /** Three-way merge into the project. The experiment stays in the timeline. */
  'exp.adopt': { params: { name: string; author?: Author; resolve?: Record<string, 'ours' | 'theirs'> }; result: ExpAdoptResult };
  /** Closes the working copy. Its changes stay in the timeline. */
  'exp.discard': { params: { name: string }; result: { ok: boolean } };
  /** Forwarded to every connected game. */
  'game.control': { params: GameControl; result: Record<string, never> };
  /** Runs one control op on a connected game (the first of the project's games unless `client` is given) and returns its answer. */
  'game.run': { params: { control: ControlOp; client?: string }; result: ControlState | ControlShot | Record<string, never> };
  /** Review notes (.hull/review.json): what has been checked, what needs a change. */
  'review.list': { params: { open?: boolean }; result: ReviewEntry[] };
  'review.set': { params: { key: string; state: ReviewState; note?: string; author?: Author }; result: { ok: boolean; problems: Problem[]; entry?: ReviewEntry } };
  'review.note': { params: { key: string; note: string; author?: Author }; result: { ok: boolean; problems: Problem[]; entry?: ReviewEntry } };
  /** The Content Browser's tree and previews: every folder under config/, the code files in src/, the kinds that can be created, a preview per asset. */
  'content.list': { params: Record<string, never>; result: { folders: string[]; code: { path: string; bytes: number }[]; creatable: string[]; thumbs: Record<string, ContentThumb> } };
  /** Who names an asset ('referencedBy') and what its own file names ('uses'). */
  'asset.refs': { params: { id: string }; result: { ok: boolean; problems: Problem[]; referencedBy: AssetRef[]; uses: { id: string; pointer?: string }[] } };
  /** A new asset from the kind's starter document. */
  'asset.new': { params: { kind: string; id: string; author?: Author }; result: AssetResult };
  'asset.duplicate': { params: { id: string; to?: string; author?: Author }; result: AssetResult };
  /** Changes an id (or a folder's path). Every reference in other configs and in src/ is rewritten in the same step. */
  'asset.rename': { params: { id: string; to: string; author?: Author }; result: AssetResult };
  /** Moves assets and folders into a folder of the same kind. References are rewritten like a rename. */
  'asset.move': { params: { ids: string[]; folder: string; author?: Author }; result: AssetResult };
  /** Deletes assets (or whole folders). Refused, with the places, while anything still names one. */
  'asset.delete': { params: { ids: string[]; author?: Author }; result: AssetResult };
  'folder.new': { params: { path: string; author?: Author }; result: AssetResult };
  /** Runs a tool from the registry: 'check', 'test', 'build'. */
  /** The server's problem state: config problems plus authorship problems (what the `problems` push carries). */
  'problems.list': { params: Record<string, never>; result: Problem[] };
  'tool.call': { params: { name: string; input?: unknown }; result: { ok: boolean; output: unknown; problems: Problem[] } };
}

export type ReviewState = 'unreviewed' | 'approved' | 'needs-change';

/** One row of the review list. `stale` means the piece changed since it was reviewed: the state fell back to unreviewed. */
export interface ReviewEntry {
  /** A config id or 'tunables:<block>', optionally with '#part'. */
  key: string;
  state: ReviewState;
  note?: string;
  at?: string;
  by?: Author;
  hash: string;
  stale?: boolean;
  /** For a stale entry: the state it had when it was reviewed. */
  was?: ReviewState;
}

/** Notifications the server pushes (JSON-RPC notifications: method + params, no id). */
export interface Pushes {
  /** A config file changed (from the app, an agent, or an editor on disk). Games call config.update. */
  'config.changed': { id: string; path: string; text: string };
  'config.removed': { id: string; path: string };
  /** Games call setTunable. */
  'tunable.changed': { block: string; key: string; value: unknown };
  /** To games only. */
  'game.control': GameControl;
  /** From games, relayed to studios. */
  'game.report': GameReport & { client: string };
  'journal.added': Change;
  /** A new change in the timeline. */
  'history.added': HistoryChange;
  /** An experiment started, was edited, adopted or discarded. Games of an experiment report as client '<name>/<id>'. */
  'exp.changed': { name: string; change: 'started' | 'edited' | 'adopted' | 'discarded'; exp: ExpInfo };
  /** To games only: a control op to run, answered by the game's `game.result`. */
  'game.rpc': { id: number; control: ControlOp };
  'review.changed': { entry: ReviewEntry };
  'problems': { problems: Problem[] };
  'log': { level: 'info' | 'warn' | 'error'; message: string; source: 'server' | 'game' | 'tool' };
  /** Source code changed: the game page reloads itself (Vite HMR); studios refresh tunables.list. */
  'source.changed': { path: string };
}

export type MethodName = keyof Methods;
export type PushName = keyof Pushes;
