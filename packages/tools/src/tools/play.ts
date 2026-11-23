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

const cmp = { enum: ['<', '<=', '>', '>=', '==', '!='] };
const val = { description: 'A number, string or boolean.', type: ['number', 'string', 'boolean'] };
const step = (key: string, schema: Record<string, unknown>, description: string, extra: Record<string, unknown> = {}, required: string[] = [key]): Record<string, unknown> => ({
  type: 'object', description, properties: { [key]: schema, ...extra }, required, additionalProperties: false,
});
const arrange = ' FOR ARRANGING A TEST, not for playing: a script that uses it is not a replay of real input, and the report says so.';
const cond = { description: '{node, field, cmp, value} (field is x, y, z or "<BehaviourName>.<field>") | {node, near: [x, z], within} (within that many metres on the floor plane) | {probe, cmp, value} | {event: "<trace id like sound/thud>"}', type: 'object', additionalProperties: true };
const STEP_SHAPES: Record<string, unknown>[] = [
  step('step', { type: 'number' }, 'Run n fixed ticks: {"step": 60}.'),
  step('press', { type: 'string' }, 'Hold a key (a KeyboardEvent code, or Mouse0/Mouse1/Mouse2) until released: {"press": "KeyW"}.'),
  step('release', { type: 'string' }, 'Let go of a key: {"release": "KeyW"}.'),
  step('hold', { type: 'string' }, 'Hold a key for some ticks, then release: {"hold": "KeyW", "steps": 30}.', { steps: { type: 'number' } }, ['hold', 'steps']),
  step('read', { type: 'array', items: { type: 'string' } }, 'Read the positions of named nodes into the report: {"read": ["player"]}.'),
  step('check', { type: 'object', properties: { node: { type: 'string' }, axis: { enum: ['x', 'y', 'z'] }, min: { type: 'number' }, max: { type: 'number' } }, required: ['node', 'axis'] }, 'Fail unless a node coordinate is within min/max: {"check": {"node": "player", "axis": "z", "max": -2}}.'),
  step('screenshot', { type: 'string' }, 'Compare the frame with tests/golden/<name>.png (written on first run): {"screenshot": "start"}.', { channel: { type: 'number' }, pixels: { type: 'number' }, width: { type: 'number', description: 'Render this picture at this width (16 to 1920); the golden is that size. Default: the page size, 640x360.' }, height: { type: 'number', description: 'Height, 16 to 1080.' } }),
  step('click', { type: ['string', 'number'] }, 'Click the button whose text matches (case-insensitive) or the nth (from 0); fails with the buttons there are on a miss: {"click": "Start"}.'),
  step('expectUi', { type: 'object', properties: { text: { type: 'string' }, kind: { enum: ['text', 'button', 'bar'] } }, required: ['text'] }, 'Fail unless a visible UI item contains the text (case-insensitive): {"expectUi": {"text": "Victory"}}.'),
  step('ui', { type: 'boolean' }, 'Record what the UI shows (screens and items) in the report: {"ui": true}.'),
  step('until', cond, 'Step one tick at a time until the condition holds; fails when it does not within max ticks: {"until": {"probe": "score", "cmp": ">=", "value": 3}, "max": 600}.', { max: { type: 'number' } }, ['until', 'max']),
  step('expect', { type: 'object', description: '{node, field, cmp, value} | {probe, cmp, value}', properties: { node: { type: 'string' }, field: { type: 'string' }, probe: { type: 'string' }, cmp, value: val }, required: ['cmp', 'value'] }, 'Fail unless a field or probe compares true now: {"expect": {"node": "player", "field": "Health.hp", "cmp": ">", "value": 0}}.'),
  step('teleport', { type: 'string' }, 'Move a node to [x, y, z], optionally turned to yaw radians; tells the renderer it jumped and clears a kit body\'s velocity: {"teleport": "player", "to": [4, 0, -6], "yaw": 1.57}.' + arrange, { to: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }, yaw: { type: 'number' } }, ['teleport', 'to']),
  step('set', { type: 'string' }, 'Set one number, string or boolean field of a node (not an object or a method) to a value of the same type: {"set": "player", "field": "Health.hp", "value": 5}.' + arrange, { field: { type: 'string' }, value: val }, ['set', 'field', 'value']),
  step('look', { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, 'Move the mouse as under pointer lock: {"look": [40, 0]}.'),
  step('inspect', { type: 'string' }, 'Read one node in full (transform, groups, each behaviour\'s state) into the report: {"inspect": "player"}.'),
];

export const play = defineTool<PlayInput, PlayReport>({
  name: 'play',
  summary: 'Runs a step script in a headless browser: press keys, step game ticks, read state, compare screenshots to golden images.',
  input: {
    type: 'object',
    properties: {
      script: {
        type: 'object',
        description: 'Steps run in order, by game ticks (never real time). A failed step stops the script, and so does an error the game logs (unless allowErrors). Screenshots are compared with tests/golden/<name>.png (written on first run).',
        properties: {
          viewport: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] },
          tolerance: { type: 'object', properties: { channel: { type: 'number', description: 'Largest per-channel difference (0-255) still counted as the same pixel. Default 8.' }, pixels: { type: 'number', description: 'How many pixels may differ more than that. Default 0.' } } },
          allowErrors: { type: 'boolean', description: 'By default a script fails when the game logs an error while it runs (a throw, console.error, an unhandled rejection), naming the file:line:col. true lets errors through.' },
          steps: {
            type: 'array',
            items: { oneOf: STEP_SHAPES },
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
    ...(o.warnings?.length ? [`warnings: ${o.warnings.join(' | ')}`] : []),
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

    // Inside the app a project server is already running. From a script or MCP, start one for the run.
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
