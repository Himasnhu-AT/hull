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
  /** Only this game hears it (the id the app put on its frame, ?hull-client=). Without it, every game does. */
  client?: string;
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
  /** Tick, time, checksum, the position of the named nodes (`world.find` paths), the game's probes and how many errors are unread. */
  | { op: 'state'; nodes?: string[] }
  /** The drawn frame as PNG, with the UI layer (`.hull-ui`) painted over it. `ui: false` gives the canvas alone. */
  | { op: 'screenshot'; ui?: boolean; width?: number; height?: number }
  /** What a person could read on the UI layer now: the ui-screens showing and every text, button and bar, top to bottom (80 at most). */
  | { op: 'ui' }
  /** Click the button whose text matches (case-insensitive) or the nth (from 0): it fires what a person's click fires. A miss answers with the buttons there are. */
  | { op: 'click'; button: string | number }
  /** One node in full: transform, groups, children, and each behaviour's state. */
  | { op: 'inspect'; node: string }
  /** The node paths under `root` (default: the whole world) with their behaviour names, `depth` levels deep (default 3). */
  | { op: 'tree'; root?: string; depth?: number }
  /** Step one tick at a time until `when` holds or `max` ticks have passed. */
  | { op: 'until'; when: ControlCond; max: number }
  /** The errors and warnings the game raised (ring of 50, repeats counted). `clear` empties the ring. `unread` answers only those nobody has read yet, and marks nothing read (what problems.list uses). */
  | { op: 'errors'; clear?: boolean; unread?: boolean }
  /** Start the game again from `ready` with the same seed, paused at tick 0. */
  | { op: 'restart' }
  /** Step `steps` ticks (default 120) and time them, then time as many drawn frames. Advances the game. */
  | { op: 'perf'; steps?: number }
  /** Mouse movement as the input layer gets it under pointer lock. Buttons go through press/release with key Mouse0, Mouse1, Mouse2. */
  | { op: 'look'; dx: number; dy: number }
  /** `count` screenshots (2 to 12), `every` ticks apart, tiled in reading order into one PNG with each tick written in a corner. Tiles are at most 320 px wide; with `width`/`height` each tile is captured at that size and the sheet is scaled down together to fit 1920x1080. */
  | { op: 'frames'; count: number; every: number; width?: number; height?: number };

export type ControlCmp = '<' | '<=' | '>' | '>=' | '==' | '!=';
/** What `until` waits for. `field` is "x" | "y" | "z" or "<BehaviourName>.<field>"; `event` is a trace id the recent feed would show, like "sound/thud". */
export type ControlCond =
  | { node: string; field: string; cmp: ControlCmp; value: number | string | boolean }
  | { probe: string; cmp: ControlCmp; value: number | string | boolean }
  | { event: string };

export interface NodeState { found: boolean; x: number; y: number; z: number }
export interface ControlState {
  tick: number; time: number; checksum: string; paused: boolean; nodes: Record<string, NodeState>;
  /** Keys and buttons the game's input holds down now, so a script can tell a key that reached the game from one that did not. */
  held: string[];
  /** What the game's `probe(name, read)` calls report now. */
  probes: Record<string, number | string | boolean>;
  /** Errors and warnings raised since the last `errors` op. */
  errors: number;
}
export interface ControlShot { png: string; width: number; height: number }
export interface ControlUntil extends ControlState { met: boolean; steps: number }
export interface ControlInspect {
  found: boolean; path: string;
  position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number];
  groups?: string[]; children?: string[];
  behaviours?: { name: string; state: Record<string, unknown> }[];
}
export interface ControlTree { lines: string[]; more: number }
/** One error or warning. file, line and col point into the project's src/ (or the engine source) in the original TypeScript. */
export interface GameError {
  level: 'error' | 'warn'; message: string; tick: number; time: number; count: number;
  file?: string; line?: number; col?: number;
  /** At most 6 frames, project-relative. The game sends the browser's own text; the project server maps it to the sources. */
  stack?: string | string[];
}
export interface ControlErrors { items: GameError[] }
export interface ControlPerf {
  stepMs: { avg: number; p95: number; max: number };
  frameMs: { avg: number; p95: number; max: number };
  drawCalls: number; triangles: number; nodes: number;
}
export type { ControlUi, ControlClick, UiItem } from '../ui/inspect.ts';
export interface ControlFrames extends ControlShot { ticks: number[] }

/** Game to server: what the engine's trace hook heard since the last batch (dev/recent.ts), oldest first. */
export interface GameEvents { items: RecentEvent[] }

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
  | { type: 'material'; color: string; roughness: number; metalness: number; emissive?: string }
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

/** `ok` is false for a refusal (nothing written) and also when the write was kept but the type check found problems; `written` tells them apart. */
export interface CodeWriteResult {
  ok: boolean;
  written: boolean;
  problems: Problem[];
  /** Problems the type check found in other files than the one written (the check tool lists them). */
  elsewhere?: number;
  created?: boolean;
  /** Edits: the 1-based line of the first change. */
  line?: number;
  replaced?: number;
  importers?: { file: string; line: number; col: number; specifier: string }[];
}

export interface AssetResult {
  ok: boolean;
  problems: Problem[];
  /** The places that block (or were rewritten by) the operation. */
  refs?: AssetRef[];
  created?: string[];
  gone?: string[];
  /** kit.add: the kit's files the project already had, left alone. */
  kept?: string[];
}

/** One kit as kit.list shows it. */
export interface KitItem {
  kit: string;
  /** The first sentence of the kit's README. */
  summary: string;
  /** The config ids the kit ships, like 'material/floor'. kit.add copies the ones the project lacks. */
  config: string[];
  /** The names the kit adds to 'hull/kits'. */
  exports: string[];
}

/** Methods the server answers. */
export interface Methods extends CreateMethods {
  'project.info': { params: Record<string, never>; result: ProjectInfo };
  /**
   * The page options the game opens with (`start=camp&look=night`, no leading `?`). Called with no `query` it reads them; with one it
   * keeps them (in .hull/launch.json, per project) and returns the cleaned query. `url` is the game page with them applied.
   */
  'project.launch': { params: { query?: string }; result: { query: string; url: string } };
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
  /** Runs one control op on a connected game and returns its answer. `client` names the game (the app's frame loads the game page with ?hull-client=<id>); without it, the first game in a frame, and a headless page a tool opened only when no other is connected. */
  'game.run': { params: { control: ControlOp; client?: string }; result: ControlState | ControlShot | ControlUntil | ControlInspect | ControlTree | ControlErrors | ControlPerf | ControlFrames | Record<string, never> };
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
  /** Every kit with its one-line summary, the config files it ships and the names it exports. */
  'kit.list': { params: Record<string, never>; result: { ok: boolean; problems: Problem[]; items: KitItem[] } };
  /** Copies a kit's config files into config/ (existing files are left alone and listed as kept), validated and recorded like any write. */
  'kit.add': { params: { kit: string; author?: Author }; result: AssetResult };
  'asset.duplicate': { params: { id: string; to?: string; author?: Author }; result: AssetResult };
  /** Changes an id (or a folder's path). Every reference in other configs and in src/ is rewritten in the same step. */
  'asset.rename': { params: { id: string; to: string; author?: Author }; result: AssetResult };
  /** Moves assets and folders into a folder of the same kind. References are rewritten like a rename. */
  'asset.move': { params: { ids: string[]; folder: string; author?: Author }; result: AssetResult };
  /** Deletes assets (or whole folders). Refused, with the places, while anything still names one. */
  'asset.delete': { params: { ids: string[]; author?: Author }; result: AssetResult };
  'folder.new': { params: { path: string; author?: Author }; result: AssetResult };
  /** Every file under src/ with its size. */
  'code.list': { params: Record<string, never>; result: { ok: boolean; problems: Problem[]; items: { path: string; bytes: number }[] } };
  /** A file of src/, or the lines from..to (1-based, inclusive). */
  'code.read': { params: { path: string; from?: number; to?: number }; result: { ok: boolean; problems: Problem[]; path?: string; text?: string; from?: number; to?: number; total?: number } };
  /** Literal (or regex) search over src/: file:line:col and the line. */
  'code.search': { params: { pattern: string; regex?: boolean; ignoreCase?: boolean; path?: string; limit?: number }; result: { ok: boolean; problems: Problem[]; matches: { file: string; line: number; col: number; text: string }[]; truncated: boolean } };
  /** Exact-string replace that must match once (or `all`). Written atomically, recorded with its author; type problems in the file come back but the write stays. */
  'code.edit': { params: { path: string; old: string; new: string; all?: boolean; typecheck?: boolean; author?: Author }; result: CodeWriteResult };
  /** Creates or overwrites a file under src/. Same safety and record as code.edit. */
  'code.write': { params: { path: string; text: string; typecheck?: boolean; author?: Author }; result: CodeWriteResult };
  /** Deletes a file of src/. Refused, with the places, while another file imports it or hull.json names it. */
  'code.delete': { params: { path: string; author?: Author }; result: CodeWriteResult };
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
export interface Pushes extends CreatePushes {
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
  /** From games only: the answer to `game.rpc`. On failure `stack` is the browser's stack text and `partStepped` says a step threw midway. */
  'game.result': { id: number; ok: boolean; result?: unknown; error?: string; stack?: string; partStepped?: boolean };
  'review.changed': { entry: ReviewEntry };
  'problems': { problems: Problem[] };
  'log': { level: 'info' | 'warn' | 'error'; message: string; source: 'server' | 'game' | 'tool' };
  /** Source code changed: the game page reloads itself (Vite HMR); studios refresh tunables.list. */
  'source.changed': { path: string };
}

export type MethodName = keyof Methods;
export type PushName = keyof Pushes;

// ---- M11: idea to play -------------------------------------------------------------------------------------------------
// CONTRACT for docs/IDEA-TO-PLAY.md section 4. Types only. `CreateMethods` and `CreatePushes` are part of `Methods` and `Pushes`
// (they extend them above).

/** Something the running game just did, for the "Just now" strip and for a frozen moment. Game time, never wall time. */
export interface RecentEvent {
  /** Game time in seconds when it happened. */
  at: number;
  kind: 'sound' | 'anim' | 'vfx' | 'actor';
  /** The config id when there is one ('sound/sword/hit', 'vfx/clash-sparks', 'character/aya'), else the node's path. */
  id: string;
  /** A plain name for a chip: 'Clash', 'Stone cut', 'Ashblade'. */
  label: string;
  /** The node it happened on, when known. */
  node?: string;
}

/** A frozen moment sent with a note: what the person was looking at. */
export interface GameMoment { tick: number; time: number; png: string; width: number; height: number; recent: RecentEvent[] }

/** The brief is GAME.md at the project root, split at its "## " headings. A section's id is its title in kebab case. */
export interface BriefSection { id: string; title: string; text: string }
export interface BriefDoc { exists: boolean; title: string; text: string; sections: BriefSection[] }

/** The build's stages, in the order they run. */
export type StageId = 'world' | 'actors' | 'animations' | 'rules' | 'sounds' | 'effects' | 'screens';

/** A drawing for a piece the person cannot judge by looking or listening. */
export type ExplainBody =
  | { type: 'flow'; nodes: { id: string; text: string; kind?: 'step' | 'ask' | 'end' }[]; edges: { from: string; to: string; label?: string }[] }
  /** A picture of a place (a PNG data URL) with numbered marks; x and y are 0..1 of the picture. */
  | { type: 'map'; image: string; width: number; height: number; marks: { x: number; y: number; label: string }[] }
  | { type: 'table'; columns: string[]; rows: (string | number)[][] }
  | { type: 'image'; image: string; width: number; height: number };

/** One explained piece, kept in .hull/explain/<id>.json. Reviewed under the key 'explain:<id>'. */
export interface ExplainDoc {
  /** Lower-case letters, digits and dashes. */
  id: string;
  title: string;
  stage: StageId;
  /** One or two plain sentences: what was decided and why it is drawn this way. */
  why: string;
  body: ExplainBody;
  /** Config ids and src/ files this explains. */
  covers?: string[];
  by?: Author;
  at?: string;
}

export interface StageState {
  id: StageId;
  status: 'waiting' | 'building' | 'ready' | 'failed';
  /** What the stage made, in a sentence, for the next stage's prompt and for the person. */
  summary?: string;
  /** The history checkpoint saved when it passed. */
  checkpoint?: string;
  /** Review keys of the pieces it made: config ids, 'tunables:<block>', 'explain:<id>'. */
  pieces: string[];
}

/** Where a project is in the flow, kept in .hull/create.json. A project without the file is at step 'play' with no stages. */
export interface CreateState { idea: string; step: 'idea' | 'brief' | 'build' | 'play'; briefApproved: boolean; stages: StageState[] }

/** A document an agent can read to learn Hull: a kit's README, a guide, or the summary of the public API. */
export interface DocItem { id: string; title: string; kind: 'kit' | 'guide' | 'api'; bytes: number }

export interface CreateMethods {
  'brief.read': { params: Record<string, never>; result: BriefDoc };
  /** Writes GAME.md whole (`text`) or one section (`section`, added in the standard order when new). Recorded with its author. */
  'brief.write': { params: { text?: string; section?: { id: string; title?: string; text: string }; author?: Author }; result: WriteResult & { doc?: BriefDoc } };
  'docs.list': { params: Record<string, never>; result: { items: DocItem[]; notBuilt: string[] } };
  'docs.read': { params: { id: string; section?: string }; result: { ok: boolean; problems: Problem[]; id?: string; title?: string; text?: string; sections?: string[] } };
  'docs.search': { params: { query: string }; result: { items: { id: string; section: string; line: string }[] } };
  'explain.list': { params: Record<string, never>; result: { items: ExplainDoc[] } };
  /** Validated against the explain schema before it is kept; an id that exists is replaced. */
  'explain.write': { params: { doc: ExplainDoc; author?: Author }; result: WriteResult };
  'create.get': { params: Record<string, never>; result: CreateState };
  /** Merges `patch` into the state; `stage` updates the stage with that id (the seven stages always exist, in order). */
  'create.set': { params: { patch?: Partial<Omit<CreateState, 'stages'>>; stage?: Partial<StageState> & { id: StageId }; author?: Author }; result: CreateState };
  /** What the game did in the last `seconds` of game time (default 4), newest first. */
  'game.recent': { params: { seconds?: number; client?: string }; result: { items: RecentEvent[] } };
  /** Pauses the game and returns the drawn frame with the tick, the time and the recent events. */
  'game.moment': { params: { client?: string }; result: GameMoment };
}

/** Pushed to every studio. `game.recent` carries only the new events, at most ten times a second. */
export interface CreatePushes {
  /** `client` is the game that did it, so a studio keeps only its own frame's events. */
  'game.recent': { items: RecentEvent[]; client?: string };
  'brief.changed': BriefDoc;
  'explain.changed': { id: string };
  'create.changed': CreateState;
}

/**
 * A piece of interface the builder sends into the conversation (docs/IDEA-TO-PLAY.md section 4.4). It is sent whole, and
 * sent again with the same id to update it. `ask` and `approve` wait for the person; the others do not.
 */
export type UiBlock =
  | { id: string; kind: 'ask'; question: string; options: string[]; answer?: string }
  | { id: string; kind: 'approve'; question: string; detail?: string; yes: string; no: string; answer?: 'yes' | 'no' }
  | { id: string; kind: 'brief'; title: string; sections: (BriefSection & { status: 'writing' | 'done' | 'changed' })[] }
  | { id: string; kind: 'stages'; stages: StageState[] }
  | { id: string; kind: 'pieces'; stage: StageId; keys: string[] }
  | { id: string; kind: 'explain'; doc: ExplainDoc }
  /** A fix: what changed on which piece. `change` is the history change id, for Keep and Put back. */
  | { id: string; kind: 'change'; title: string; piece: string; lines: { label: string; from: string; to: string }[]; change?: string };

/** The `_meta` keys Hull adds to ACP messages. */
export const HULL_META = { ui: 'hull.ui', mode: 'hull.mode', stage: 'hull.stage' } as const;
export type AgentMode = 'brief' | 'build' | 'fix';
