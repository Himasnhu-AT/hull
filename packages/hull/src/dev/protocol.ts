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

export interface GameControl {
  paused?: boolean;
  /** Run exactly n fixed steps (implies paused afterwards). */
  step?: number;
  timeScale?: number;
  /** Start the game again from `ready` with the same seed. */
  restart?: boolean;
}

export interface GameReport {
  tick: number;
  time: number;
  paused: boolean;
  timeScale: number;
  fps: number;
  checksum?: string;
}

/** Methods the server answers. */
export interface Methods {
  'project.info': { params: Record<string, never>; result: ProjectInfo };
  'library.list': { params: Record<string, never>; result: LibraryItem[] };
  /** A config file: its text, parsed value, JSON Schema (with x-ui / x-ref) and current problems. */
  'config.read': { params: { id: string }; result: { id: string; path: string; text: string; value: unknown; schema: unknown; problems: Problem[] } };
  /** Set one field. Validated before it is kept; the file keeps its formatting; recorded with its author. */
  'config.set': { params: { id: string; pointer: string; value: unknown; author?: Author }; result: WriteResult };
  'tunables.list': { params: Record<string, never>; result: TunableWire[] };
  /** Rewrites the literal in the .ts file (re-parsed and type-checked first) and pushes the value to running games. */
  'tunables.set': { params: { block: string; key: string; value: unknown; author?: Author }; result: WriteResult };
  'journal.list': { params: { limit?: number }; result: Change[] };
  /** Forwarded to every connected game. */
  'game.control': { params: GameControl; result: Record<string, never> };
  /** Runs a tool from the registry: 'check', 'test', 'build'. */
  'tool.call': { params: { name: string; input?: unknown }; result: { ok: boolean; output: unknown; problems: Problem[] } };
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
  'problems': { problems: Problem[] };
  'log': { level: 'info' | 'warn' | 'error'; message: string; source: 'server' | 'game' | 'tool' };
  /** Source code changed: the game page reloads itself (Vite HMR); studios refresh tunables.list. */
  'source.changed': { path: string };
}

export type MethodName = keyof Methods;
export type PushName = keyof Pushes;
