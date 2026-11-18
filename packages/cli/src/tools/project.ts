// The project server's methods (dev/protocol.ts `Methods`) as tools. One definition each gives the command line, the MCP
// tool and (through the same registry shape) Marl AI: input and output JSON Schemas, a summary, the CLI shape.
// A method tool does no work itself: it calls the project server through `ctx.project`, so an edit made here is
// validated, journaled and pushed to the open app exactly like one made in the Inspector.
import type { Problem } from 'hull';
import type { Methods } from 'hull/dev/protocol';
import { defineTool, type CliShape, type ToolDef } from '../tool.ts';

type Schema = Record<string, unknown>;
const obj = (properties: Schema, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) });
const num = (description?: string): Schema => ({ type: 'number', ...(description ? { description } : {}) });
const arr = (items: Schema): Schema => ({ type: 'array', items });
const anyValue = (description: string): Schema => ({ description });
const author: Schema = { type: 'string', description: "Who made the change. Defaults to the caller: over MCP, 'ai:<client name>'." };
const exp: Schema = { type: 'string', description: "Edit this experiment's copy instead of the project." };

const problem: Schema = obj({ file: str(), pointer: str(), line: num(), col: num(), rule: str(), message: str() }, ['file', 'message']);
const problems = arr(problem);
/** MCP's structured results must be objects, so a list comes back as { items }. */
const list = (items: Schema, key = 'items'): Schema => obj({ ok: { type: 'boolean' }, problems, [key]: arr(items) }, [key]);
const writeResult = obj({ ok: { type: 'boolean' }, problems }, ['ok', 'problems']);
const delta: Schema = { type: 'object', description: 'One difference: file, kind (json|tunable|lines|asset|file), op, target, path, from, to, and the plain-words text.', properties: { file: str(), kind: str(), op: str(), target: str(), path: str(), text: str() }, required: ['file', 'kind', 'op', 'target', 'path', 'text'], additionalProperties: true };
const historyChange: Schema = { type: 'object', description: 'A change in the timeline: id, short, at, by, line, kind, message, details, parents, checkpoints.', properties: { id: str(), short: str(), at: str(), by: str(), line: str(), kind: str(), message: str(), details: arr(str()), parents: arr(str()), checkpoints: arr(str()) }, required: ['id', 'short', 'at', 'by', 'line', 'kind', 'message'], additionalProperties: true };
const expInfo: Schema = { type: 'object', properties: { name: str(), status: { enum: ['active', 'adopted', 'discarded'] }, from: str(), tip: str(), changes: num(), createdAt: str(), by: str(), gameUrl: str() }, required: ['name', 'status', 'from', 'tip', 'changes', 'createdAt', 'by'], additionalProperties: true };
const empty = obj({});
const idsHelp = 'Ids, checkpoint names, "main" or an experiment name.';
const controlOp: Schema = {
  description: 'One of: {"op":"step","n":60} (pause and run n fixed steps) | {"op":"press","key":"KeyW"} | {"op":"release","key":"KeyW"} | {"op":"state","nodes":["player"]} (tick, time, checksum and the position of the named nodes) | {"op":"screenshot"} (PNG, base64).',
  oneOf: [
    obj({ op: { const: 'step' }, n: num() }, ['op', 'n']),
    obj({ op: { const: 'press' }, key: str('A KeyboardEvent code like KeyW or Space.') }, ['op', 'key']),
    obj({ op: { const: 'release' }, key: str() }, ['op', 'key']),
    obj({ op: { const: 'state' }, nodes: arr(str('A `world.find` path.')) }, ['op']),
    obj({ op: { const: 'screenshot' } }, ['op']),
  ],
};

type MethodName = keyof Methods;
interface Spec {
  method: MethodName;
  /** What a list result is called (default `items`). The review tool already said `entries`. */
  key?: string;
  summary: string;
  input: Schema;
  output: Schema;
  cli?: CliShape;
  /** Turns the command line's words into the method's params (everything arrives as strings). */
  fromCli?(input: Record<string, unknown>): Record<string, unknown>;
  format?(out: unknown): string[];
}

const json = (s: string): unknown => { try { return JSON.parse(s); } catch { return s; } };

const SPECS: Spec[] = [
  { method: 'project.info', summary: 'The project: root, title, manifest and where its game page is served.', input: empty, output: obj({ root: str(), title: str(), gameUrl: str(), manifest: {} }, ['root', 'title', 'gameUrl']) },
  { method: 'library.list', summary: 'Every config file and tunables block in the project, with its problem count.', input: empty, output: list(obj({ id: str(), kind: str(), path: str(), title: str(), note: str(), problems: num() }, ['id', 'kind', 'path', 'title', 'problems'])),
    format: (o) => (o as { items: { id: string; kind: string; problems: number }[] }).items.map((i) => `${i.id}  ${i.kind}${i.problems ? `  ${i.problems} problems` : ''}`) },
  { method: 'config.read', summary: 'A config file: its text, parsed value, JSON Schema and current problems.', input: obj({ id: str("Config id like 'sound/sword/hit', or 'hull.json'.") }, ['id']), output: obj({ id: str(), path: str(), text: str(), value: {}, schema: {}, problems }, ['id', 'path', 'text', 'problems']),
    cli: { args: [{ name: 'id', description: 'config id' }] }, format: (o) => [(o as { text: string }).text] },
  { method: 'config.set', summary: 'Set one field of a config file. Validated first (a write may not add a problem), formatting kept, recorded in the history with its author.', input: obj({ id: str(), pointer: str('JSON pointer of the field, like /height.'), value: anyValue('The new JSON value.'), author, exp }, ['id', 'pointer', 'value']), output: writeResult,
    cli: { args: [{ name: 'id', description: 'config id' }, { name: 'pointer', description: 'JSON pointer' }, { name: 'value', description: 'JSON value' }] }, fromCli: (i) => ({ ...i, value: json(String(i['value'])) }) },
  { method: 'tunables.list', summary: 'Every tunable in src/ with its kind, value, options and where its literal is.', input: empty, output: list(obj({ block: str(), key: str(), kind: str(), value: {}, opts: { type: 'object' }, file: str(), line: num(), col: num() }, ['block', 'key', 'kind', 'value', 'file', 'line', 'col'])),
    format: (o) => (o as { items: { block: string; key: string; value: unknown }[] }).items.map((t) => `${t.block}.${t.key} = ${JSON.stringify(t.value)}`) },
  { method: 'tunables.set', summary: 'Change a tunable: rewrites its literal in the .ts file (re-parsed and type-checked first) and updates running games without a reload.', input: obj({ block: str('The tunables block, like player.'), key: str(), value: anyValue('The new value.'), author, exp }, ['block', 'key', 'value']), output: writeResult,
    cli: { args: [{ name: 'block', description: 'tunables block' }, { name: 'key', description: 'tunable key' }, { name: 'value', description: 'JSON value' }] }, fromCli: (i) => ({ ...i, value: json(String(i['value'])) }) },
  { method: 'journal.list', summary: 'The recent changes made through the server, newest last.', input: obj({ limit: num() }), output: list({ type: 'object', properties: { at: str(), by: str(), target: str(), path: str(), from: {}, to: {} }, required: ['at', 'by', 'target', 'path'], additionalProperties: true }),
    cli: { options: [{ name: 'limit', flags: '--limit <n>', description: 'How many' }] }, fromCli: (i) => ({ ...(i['limit'] !== undefined ? { limit: Number(i['limit']) } : {}) }) },
  { method: 'history.list', summary: 'The timeline, newest first, across the main line and every experiment. `by` says who made each change.', input: obj({ limit: num(), line: str("'main' or an experiment name.") }), output: list(historyChange),
    cli: { options: [{ name: 'limit', flags: '--limit <n>', description: 'How many' }, { name: 'line', flags: '--line <name>', description: 'main or an experiment' }] }, fromCli: (i) => ({ ...(i['limit'] !== undefined ? { limit: Number(i['limit']) } : {}), ...(i['line'] !== undefined ? { line: i['line'] } : {}) }),
    format: (o) => (o as { items: { short: string; by: string; message: string }[] }).items.map((c) => `${c.short}  ${c.by}  ${c.message}`) },
  { method: 'history.diff', summary: `What changed between two states, in plain words. ${idsHelp}`, input: obj({ from: str('Defaults to the parent of `to`.'), to: str() }, ['to']), output: obj({ from: { type: ['string', 'null'] }, to: str(), deltas: arr(delta) }, ['to', 'deltas']),
    cli: { args: [{ name: 'to', description: 'change id, checkpoint, main or experiment' }], options: [{ name: 'from', flags: '--from <id>', description: 'the earlier state' }] }, format: (o) => (o as { deltas: { text: string }[] }).deltas.map((d) => d.text) },
  { method: 'history.restore', summary: 'Put the project back as it was at a change. Itself a new change, so it can be undone.', input: obj({ id: str(), author }, ['id']), output: obj({ ok: { type: 'boolean' }, problems, change: historyChange }, ['ok', 'problems']), cli: { args: [{ name: 'id', description: 'change id or checkpoint' }] } },
  { method: 'history.checkpoint', summary: 'Name a change so it can be returned to (default: the newest).', input: obj({ name: str(), id: str() }, ['name']), output: obj({ name: str(), id: str() }, ['name', 'id']), cli: { args: [{ name: 'name', description: 'checkpoint name' }] } },
  { method: 'exp.start', summary: 'Make a working copy under .hull/exp/<name>/ to try changes without touching the project.', input: obj({ name: str(), from: str(), author }, ['name']), output: expInfo, cli: { args: [{ name: 'name', description: 'experiment name' }] } },
  { method: 'exp.list', summary: 'Experiments and their status.', input: empty, output: list(expInfo), format: (o) => (o as { items: { name: string; status: string; changes: number }[] }).items.map((e) => `${e.name}  ${e.status}  ${e.changes} changes`) },
  { method: 'exp.compare', summary: 'The value differences between two lines (main or an experiment), a to b.', input: obj({ a: str(), b: str() }, ['a', 'b']), output: obj({ a: str(), b: str(), deltas: arr(delta) }, ['a', 'b', 'deltas']), cli: { args: [{ name: 'a', description: 'line a' }, { name: 'b', description: 'line b' }] }, format: (o) => (o as { deltas: { text: string }[] }).deltas.map((d) => d.text) },
  { method: 'exp.adopt', summary: 'Three-way merge an experiment into the project. With conflicts nothing is written: call again with `resolve` ("ours" | "theirs" per "target#path").', input: obj({ name: str(), author, resolve: { type: 'object', additionalProperties: { enum: ['ours', 'theirs'] } } }, ['name']), output: obj({ ok: { type: 'boolean' }, conflicts: arr({ type: 'object', additionalProperties: true }), problems, change: historyChange }, ['ok', 'conflicts', 'problems']), cli: { args: [{ name: 'name', description: 'experiment name' }] } },
  { method: 'exp.discard', summary: 'Close an experiment. Its changes stay in the timeline.', input: obj({ name: str() }, ['name']), output: obj({ ok: { type: 'boolean' } }, ['ok']), cli: { args: [{ name: 'name', description: 'experiment name' }] } },
  { method: 'game.control', summary: 'Pause, resume, step, scale time or restart every connected game.', input: obj({ paused: { type: 'boolean' }, step: num('Run exactly n fixed steps (pauses afterwards).'), timeScale: num(), restart: { type: 'boolean' } }), output: empty },
  { method: 'game.run', summary: 'Run one control op on the running game and return its answer. Time moves only by `step`, so a script gives the same run every time. With no app open, a headless game page is opened for you.', input: obj({ control: controlOp, client: str('A specific game client; default is the project\'s first.') }, ['control']), output: { description: 'step/state: {tick,time,checksum,paused,nodes}; screenshot: {png (base64),width,height}; press/release: {}.', type: 'object', additionalProperties: true },
    cli: { args: [{ name: 'op', description: 'step | press | release | state | screenshot' }, { name: 'arg', description: 'step count, key, or comma-separated node paths', optional: true }] },
    fromCli: (i) => {
      const op = String(i['op']); const a = i['arg'] as string | undefined;
      if (op === 'step') return { control: { op, n: Number(a ?? 1) } };
      if (op === 'press' || op === 'release') return { control: { op, key: a } };
      if (op === 'state') return { control: { op, ...(a ? { nodes: a.split(',') } : {}) } };
      return { control: { op } };
    } },
  { method: 'problems.list', summary: 'Config problems and authorship problems (AI changes over values you set), as the app shows them.', input: empty, output: obj({ ok: { type: 'boolean' }, problems }, ['ok', 'problems']) },
  { method: 'review.list', summary: 'Review notes: what has been checked and what needs a change.', input: obj({ open: { type: 'boolean' } }), key: 'entries', output: list({ type: 'object', properties: { key: str(), state: str(), note: str() }, required: ['key', 'state'], additionalProperties: true }, 'entries'), cli: { options: [{ name: 'open', flags: '--open', description: 'Only open notes' }] } },
  { method: 'review.set', summary: 'Set the review state of a config id or tunables block; the app updates live.', input: obj({ key: str(), state: { enum: ['unreviewed', 'approved', 'needs-change'] }, note: str(), author }, ['key', 'state']), output: obj({ ok: { type: 'boolean' }, problems, entry: { type: 'object', additionalProperties: true } }, ['ok', 'problems']), cli: { args: [{ name: 'key', description: 'config id or tunables:<block>' }, { name: 'state', description: 'unreviewed | approved | needs-change' }], options: [{ name: 'note', flags: '--note <text>', description: 'A note' }] } },
  { method: 'review.note', summary: 'Write a note on a piece without changing its review state (empty text clears it); the app updates live.', input: obj({ key: str(), note: str(), author }, ['key', 'note']), output: obj({ ok: { type: 'boolean' }, problems, entry: { type: 'object', additionalProperties: true } }, ['ok', 'problems']), cli: { args: [{ name: 'key', description: 'config id or tunables:<block>' }, { name: 'note', description: 'the note' }] } },
];

/** Methods that are already registry tools under another front (`check`, `build`) or are the registry's own entry point. */
export const projectTools: readonly ToolDef<unknown, unknown>[] = SPECS.map((s) => defineTool<Record<string, unknown>, unknown>({
  name: s.method,
  summary: s.summary,
  input: s.input,
  output: s.output,
  ...(s.cli ? { cli: { ...s.cli, ...(s.fromCli ? { toInput: s.fromCli } : {}) } } : {}),
  format: (out) => (s.format ? s.format(out) : [JSON.stringify(out, null, 2)]),
  async run(ctx, input) {
    if (!ctx.project) throw new Error(`${s.method} needs the project server`);
    let params: Record<string, unknown> = { ...input };
    // Whoever calls is the author, unless the caller names one.
    if ((s.input['properties'] as Schema)['author'] && params['author'] === undefined) params = { ...params, author: ctx.author };
    const out = await ctx.project.call(s.method, params);
    const o = out as { ok?: boolean; problems?: Problem[] } | null;
    if (s.method === 'problems.list') return { ok: (out as Problem[]).length === 0, problems: out };
    return Array.isArray(out) ? { ok: true, problems: [], [s.key ?? 'items']: out } : o;
  },
})) as unknown as readonly ToolDef<unknown, unknown>[];
