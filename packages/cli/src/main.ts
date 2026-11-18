import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import type { Problem } from 'hull';
import { formatProblem, type ToolDef } from './tool.ts';
import { tools } from './tools/index.ts';

/** Nearest folder at or above `from` holding hull.json; `from` itself if none (so `hull new` works anywhere). */
export function findRoot(from: string): string {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(join(d, 'hull.json'))) return d;
    if (dirname(d) === d) return resolve(from);
  }
}

/** Human-readable output: problems first, then whatever the tool says about itself. */
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

export function buildProgram(): Command {
  const program = new Command('hull').description('Hull game engine').option('--root <dir>', 'project folder');
  const groups = new Map<string, Command>();
  for (const tool of tools) {
    // 'review.list' is `hull review list`.
    const [group, sub] = tool.name.split('.');
    let parent: Command = program;
    if (sub) {
      if (!groups.has(group!)) groups.set(group!, program.command(group!).description(`${group} tools`));
      parent = groups.get(group!)!;
    }
    const cmd = parent.command(sub ?? tool.name).description(tool.summary).option('--json', 'print the output object as JSON');
    for (const a of tool.cli?.args ?? []) cmd.argument(a.optional ? `[${a.name}]` : `<${a.name}>`, a.description);
    for (const o of tool.cli?.options ?? []) cmd.option(o.flags, o.description, o.default);
    cmd.action(async (...raw: unknown[]) => {
      const command = raw[raw.length - 1] as Command;
      const opts = command.opts<{ json?: boolean } & Record<string, unknown>>();
      const names = (tool.cli?.args ?? []).map((a) => a.name);
      const input: Record<string, unknown> = { ...opts };
      delete input.json;
      names.forEach((n, i) => (input[n] = raw[i]));
      const abort = new AbortController();
      process.on('SIGINT', () => { abort.abort(); process.exit(0); });
      const rootOpt = program.opts<{ root?: string }>().root;
      const root = rootOpt ? resolve(rootOpt) : tool.name === 'new' ? process.cwd() : findRoot(process.cwd());
      try {
        const out = await tool.run({ root, author: 'you', log: (l) => console.error(l), signal: abort.signal }, input);
        console.log(opts.json ? JSON.stringify(out, null, 2) : render(tool, out).join('\n'));
        if (failed(out)) process.exitCode = 1;
        // The dev server keeps the process alive on its own; everything else ends here.
        if (tool.name !== 'dev') process.exit(process.exitCode ?? 0);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (opts.json) console.log(JSON.stringify({ ok: false, problems: [{ file: '', message, rule: 'error' }] }));
        else console.error(`hull ${tool.name}: ${message}`);
        process.exit(1);
      }
    });
  }
  program.command('mcp').description('Serves the tools to an AI agent over MCP (stdio). Point the agent at this command.').action(async () => {
    const rootOpt = program.opts<{ root?: string }>().root;
    const { serveMcp } = await import('./mcp/server.ts');
    await serveMcp({ root: rootOpt ? resolve(rootOpt) : findRoot(process.cwd()), tools, input: process.stdin, output: process.stdout, log: (l) => console.error(l) });
    process.exit(0);
  });
  return program;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bin/hull.js')) {
  await buildProgram().parseAsync(process.argv);
}
