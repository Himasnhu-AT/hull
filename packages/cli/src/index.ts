// A tool is defined once and exposed as a command, as an MCP tool and to Marl AI.
// CONTRACT STUB: the cli worker fills it.
import type { Problem } from 'hull';

export interface ToolContext {
  /** Project root (the folder holding hull.json). */
  root: string;
  /** Who is acting: 'you', 'ai:<agent>', 'marl:<model>'. Recorded in the history. */
  author: string;
  log(line: string): void;
  signal: AbortSignal;
}

export interface ToolDef<I, O> {
  name: string;
  summary: string;
  /** TypeBox schemas: the same source gives the CLI flags, the MCP tool schema and validation. */
  input: unknown;
  output: unknown;
  run(ctx: ToolContext, input: I): Promise<O>;
}

export declare function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O>;
export declare const tools: readonly ToolDef<unknown, unknown>[];
export type { Problem };
