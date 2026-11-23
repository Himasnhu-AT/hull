// Helpers for calling a tool as a function: from the app, from the maintainers' scripts and from tests.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Problem } from 'hull';
import { formatProblem, type ToolContext, type ToolDef } from './tool.ts';
import { tools } from './tools/index.ts';
import { projectTools } from './tools/project.ts';
import { openProject } from './server/link.ts';
import { validateInput } from './validate.ts';

/** Nearest folder at or above `from` holding hull.json; `from` itself if none. */
export function findRoot(from: string): string {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(join(d, 'hull.json'))) return d;
    if (dirname(d) === d) return resolve(from);
  }
}

/** Every tool: the registry plus the project methods (where both have a name, the registry's wins for file-only use). */
export const allTools: readonly ToolDef<unknown, unknown>[] = [...tools, ...projectTools.filter((m) => !tools.some((t) => t.name === m.name))];

/** Human-readable lines: problems first, then whatever the tool says about itself. */
export function render(tool: ToolDef<unknown, unknown>, out: unknown): string[] {
  const lines: string[] = [];
  const problems = (out as { problems?: Problem[] } | null)?.problems ?? [];
  for (const p of problems) lines.push(formatProblem(p));
  if (tool.format) lines.push(...tool.format(out));
  else if (problems.length === 0) lines.push(`${tool.name}: ok`);
  else lines.push(`${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  return lines;
}

export function failed(out: unknown): boolean {
  const o = out as { ok?: boolean; problems?: unknown[] } | null;
  return o?.ok === false || (o?.problems?.length ?? 0) > 0;
}

/** Runs a tool by name on a project. A project method goes through the project's server (the open app's, or one started for the call). */
export async function runTool(root: string, name: string, input: unknown = {}, ctx: Partial<ToolContext> = {}): Promise<unknown> {
  const tool = allTools.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool "${name}" (have: ${allTools.map((t) => t.name).join(', ')})`);
  validateInput(name, tool.input, input);
  const base: ToolContext = { root, author: 'you', log: () => {}, signal: new AbortController().signal, ...ctx };
  if (!projectTools.some((t) => t.name === name) || tools.some((t) => t.name === name)) return tool.run(base, input);
  const link = await openProject({ root, log: base.log });
  try { return await tool.run({ ...base, project: { call: (m, p) => link.call(m, p) } }, input); } finally { await link.close(); }
}
