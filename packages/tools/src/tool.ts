// A tool is defined once: a typed function plus JSON Schemas. The Hull app calls it directly, the MCP server lists and
// calls the same objects, and Marl AI will read the same list. There is no command line.
import type { Problem } from 'hull';

export interface ToolContext {
  /** Project root (the folder holding hull.json). */
  root: string;
  /** Who is acting: 'you', 'ai:<agent>', 'marl:<model>'. Recorded in the history. */
  author: string;
  /** The running project server, when the tool is called from inside one (the app). Tools that need a game start their own otherwise. */
  server?: { url: string; gameUrl: string };
  /** The project's server, attached or started in-process on first use. Method tools (config.set, game.run, ...) call through it. */
  project?: { call(method: string, params: unknown): Promise<unknown> };
  log(line: string): void;
  signal: AbortSignal;
}

export interface ToolDef<I, O> {
  name: string;
  summary: string;
  /** JSON Schema of the input; the MCP tool schema and the app's forms come from it. */
  input: unknown;
  output: unknown;
  /** Human-readable lines for output that is not a problem list. */
  format?(out: O): string[];
  run(ctx: ToolContext, input: I): Promise<O>;
}

export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

/** What tools that find problems return; callers fail on a non-empty list. */
export interface ProblemOutput { ok: boolean; problems: Problem[] }

/** `file:line:col: message` for code, `file#/pointer (line:col): message` for config. */
export function formatProblem(p: Problem): string {
  const pos = p.line !== undefined ? `${p.line}:${p.col ?? 1}` : '';
  if (p.pointer !== undefined) return `${p.file}#${p.pointer}${pos ? ` (${pos})` : ''}: ${p.message}`;
  return `${p.file}${pos ? `:${pos}` : ''}: ${p.message}`;
}
