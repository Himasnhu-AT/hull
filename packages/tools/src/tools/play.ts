import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Problem } from 'hull';
import { defineTool } from '../tool.ts';
import { runScript, validateScript, type PlayReport, type PlayScript } from '../play/run.ts';

export interface PlayInput {
  /** The script itself. */
  script?: PlayScript;
  /** Or a path to a JSON script, relative to the project (like tests/play/walk.json). */
  file?: string;
  /** Rewrite golden images instead of comparing against them. */
  update?: boolean;
  /** The agent-browser executable. */
  browser?: string;
}

export const play = defineTool<PlayInput, PlayReport>({
  name: 'play',
  summary: 'Runs a step script in a headless browser: press keys, step game ticks, read state, compare screenshots to golden images.',
  input: {
    type: 'object',
    properties: {
      script: {
        type: 'object',
        description: 'Steps run in order, by game ticks (never real time). A failed step stops the script. Screenshots are compared with tests/golden/<name>.png (written on first run).',
        properties: {
          viewport: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] },
          tolerance: { type: 'object', properties: { channel: { type: 'number', description: 'Largest per-channel difference (0-255) still counted as the same pixel. Default 8.' }, pixels: { type: 'number', description: 'How many pixels may differ more than that. Default 0.' } } },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              description: 'One of {step:n} | {press:"KeyW"} | {release:"KeyW"} | {hold:"KeyW", steps:n} | {read:["player"]} | {check:{node,axis,min?,max?}} | {screenshot:"name", channel?, pixels?}',
              additionalProperties: true,
            },
          },
        },
        required: ['steps'],
      },
      file: { type: 'string', description: 'Path to a JSON script file in the project, instead of `script`.' },
      update: { type: 'boolean', description: 'Rewrite the golden images from this run.' },
      browser: { type: 'string', description: 'The agent-browser executable (default: agent-browser).' },
    },
    additionalProperties: false,
  },
  output: { type: 'object', required: ['ok', 'steps'] },
  format: (o) => [
    ...o.steps.map((s) => `${s.ok ? 'ok  ' : 'FAIL'} ${s.index} ${JSON.stringify(s.step)} @tick ${s.tick}${s.detail ? `  ${s.detail}` : ''}`),
    `${o.ok ? 'played' : 'failed'}: tick ${o.tick}, checksum ${o.checksum}`,
  ],
  async run(ctx, input) {
    let script = input.script;
    let file = input.file ?? 'play script';
    if (!script) {
      if (!input.file) throw new Error('play needs a "script" or a "file"');
      const abs = resolve(ctx.root, input.file);
      if (!abs.startsWith(`${resolve(ctx.root)}/`)) throw new Error(`${input.file} is outside the project`);
      try { script = JSON.parse(readFileSync(abs, 'utf8')) as PlayScript; } catch (e) { throw new Error(`${input.file}: ${(e as Error).message}`); }
    }
    const problems: Problem[] = validateScript(file, script);
    if (problems.length) return { ok: false, problems, steps: [], tick: 0, checksum: '' };

    // Inside the app a project server is already running. From the command line or MCP, start one for the run.
    let own: { close(): Promise<void> } | undefined;
    let server = ctx.server;
    if (!server) {
      const { startProjectServer } = await import('../server/index.ts');
      const s = await startProjectServer({ root: ctx.root, port: 0, historyQuietMs: 60_000 });
      own = s;
      server = { url: s.url, gameUrl: s.gameUrl };
    }
    try {
      return await runScript({ root: ctx.root, file, script, server, update: input.update === true, browser: input.browser ?? 'agent-browser', signal: ctx.signal });
    } finally { await own?.close(); }
  },
});
