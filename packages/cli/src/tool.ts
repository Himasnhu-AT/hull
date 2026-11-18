// A tool is defined once. main.ts turns it into a command today; the MCP server and Marl AI read the same list.
import type { Problem } from 'hull';

export interface ToolContext {
  /** Project root (the folder holding hull.json). */
  root: string;
  /** Who is acting: 'you', 'ai:<agent>', 'marl:<model>'. Recorded in the history. */
  author: string;
  /** The running project server, when the tool is called from inside one (the app, or `hull dev`). Tools that need a game start their own otherwise. */
  server?: { url: string; gameUrl: string };
  log(line: string): void;
  signal: AbortSignal;
}

/** How the command line maps words onto a tool's input object. Other fronts ignore it. */
export interface CliShape {
  args?: { name: string; description: string; optional?: boolean }[];
  options?: { name: string; flags: string; description: string; default?: string }[];
}

export interface ToolDef<I, O> {
  name: string;
  summary: string;
  /** JSON Schema of the input; the same object gives the CLI flags and the MCP tool schema. */
  input: unknown;
  output: unknown;
  cli?: CliShape;
  /** Human-readable lines for output that is not a problem list. */
  format?(out: O): string[];
  run(ctx: ToolContext, input: I): Promise<O>;
}

export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

/** What tools that find problems return; the CLI prints them and sets the exit code from them. */
export interface ProblemOutput { ok: boolean; problems: Problem[] }

/** `file:line:col: message` for code, `file#/pointer (line:col): message` for config. */
export function formatProblem(p: Problem): string {
  const pos = p.line !== undefined ? `${p.line}:${p.col ?? 1}` : '';
  if (p.pointer !== undefined) return `${p.file}#${p.pointer}${pos ? ` (${pos})` : ''}: ${p.message}`;
  return `${p.file}${pos ? `:${pos}` : ''}: ${p.message}`;
}
