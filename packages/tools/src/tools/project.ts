// The project server's methods (dev/protocol.ts `Methods`) as tools. One definition each gives the app's call, the MCP
// tool and (through the same registry shape) Marl AI: input and output JSON Schemas and a summary.
// A method tool does no work itself: it calls the project server through `ctx.project`, so an edit made here is
// validated, journaled and pushed to the open app exactly like one made in the Inspector.
import type { Problem } from 'hull';
import { explainSchema } from 'hull/schema';
import type { Methods } from 'hull/dev/protocol';
import { defineTool, type ToolDef } from '../tool.ts';

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
const cmpSchema: Schema = { enum: ['<', '<=', '>', '>=', '==', '!='] };
const cmpValue: Schema = { type: ['number', 'string', 'boolean'] };
const condSchema: Schema = {
  description: 'What until waits for: {node, field, cmp, value} (field is "x", "y", "z" or "<BehaviourName>.<field>") | {node, near: [x, z], within} (true when the node is within that many metres of the point on the floor plane, height ignored) | {probe, cmp, value} | {event: "<trace id>"} (an id the recent feed shows, like sound/thud).',
  oneOf: [
    obj({ node: str('A world.find path.'), field: str('x, y, z or <BehaviourName>.<field>.'), cmp: cmpSchema, value: cmpValue }, ['node', 'field', 'cmp', 'value']),
    obj({ node: str('A world.find path.'), near: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, z] on the floor plane.' }, within: num('Metres, 0 or more.') }, ['node', 'near', 'within']),
    obj({ probe: str('A name the game registered with probe(name, read).'), cmp: cmpSchema, value: cmpValue }, ['probe', 'cmp', 'value']),
    obj({ event: str('A trace id like sound/thud.') }, ['event']),
  ],
};
const arrange = ' FOR ARRANGING A TEST, not for playing: a run that uses it is not a replay of real input.';
const controlOp: Schema = {
  description: 'One control op. Time moves only by step/until/perf/frames, so a run is the same every time. A step that makes game code throw fails with "file:line:col: Error: message", the mapped stack and a note that the world may be part-stepped: restart before trusting state.',
  oneOf: [
    obj({ op: { const: 'step' }, n: num('Fixed steps to run (pauses the game).') }, ['op', 'n']),
    obj({ op: { const: 'press' }, key: str('A KeyboardEvent code like KeyW or Space, or Mouse0 / Mouse1 / Mouse2 for a mouse button.') }, ['op', 'key']),
    obj({ op: { const: 'release' }, key: str('The same key code as press.') }, ['op', 'key']),
    obj({ op: { const: 'state' }, nodes: arr(str('A world.find path.')) }, ['op']),
    obj({ op: { const: 'screenshot' }, ui: { type: 'boolean', description: 'false: the 3D view only, without the UI layer (HUD, menus). Default true.' }, width: num('Picture width in pixels, 16 to 1920, for this one picture only (the page is put back after). Default: the page\'s own size, 640 headless.'), height: num('Picture height in pixels, 16 to 1080.') }, ['op']),
    obj({ op: { const: 'ui' } }, ['op']),
    obj({ op: { const: 'click' }, button: { type: ['string', 'number'], description: 'The text of a button (case-insensitive) or its number counting from 0 among the buttons showing.' } }, ['op', 'button']),
    obj({ op: { const: 'inspect' }, node: str('A world.find path.') }, ['op', 'node']),
    obj({ op: { const: 'tree' }, root: str('A world.find path to start at; default the whole world.'), depth: num('Levels below the root, default 3.') }, ['op']),
    obj({ op: { const: 'until' }, when: condSchema, max: num('Most ticks to step before giving up.') }, ['op', 'when', 'max']),
    obj({ op: { const: 'errors' }, clear: { type: 'boolean', description: 'true: empty the ring after reading it.' }, unread: { type: 'boolean', description: 'true: only what nobody has read yet, and mark nothing read.' } }, ['op']),
    obj({ op: { const: 'restart' } }, ['op']),
    obj({ op: { const: 'teleport' }, node: str('A world.find path.'), to: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'The node\'s new [x, y, z].' }, yaw: num('Radians; also turns the kits\' FirstPerson.yaw and ThirdPerson.facing. Without it the facing stays.') }, ['op', 'node', 'to']),
    obj({ op: { const: 'set' }, node: str('A world.find path.'), field: str('<BehaviourName>.<field>, like Health.hp.'), value: cmpValue }, ['op', 'node', 'field', 'value']),
    obj({ op: { const: 'perf' }, steps: num('Steps and frames to time, default 120. Advances the game that many ticks.') }, ['op']),
    obj({ op: { const: 'look' }, dx: num('Mouse movement in pixels, right is positive.'), dy: num('Mouse movement in pixels, down is positive.') }, ['op', 'dx', 'dy']),
    obj({ op: { const: 'frames' }, count: num('How many pictures, 2 to 12.'), every: num('Ticks to step between pictures.'), width: num('Each picture is captured this many pixels wide (16 to 1920; the page is put back after), then the whole sheet is scaled down together to fit 1920x1080. Without width and height, tiles are at most 320 px wide.'), height: num('Each picture\'s height before that scaling, 16 to 1080.') }, ['op', 'count', 'every']),
  ],
};
// One line per op, in the tool's description (a oneOf branch has no room for prose in most clients).
export const controlOpHelp = [
  'step {n}: run n fixed steps, paused after.',
  'press / release {key}: hold or let go of a key (KeyW, Space) or a mouse button (Mouse0..2).',
  'state {nodes?}: tick, time, checksum, positions of the named nodes, held keys, probes (what the game registered with probe(name, read)), errors (unread count).',
  'inspect {node}: transform, groups, children and each behaviour\'s state fields.',
  'tree {root?, depth?}: node paths with behaviour names, 200 lines at most.',
  'until {when, max}: step one tick at a time until the condition holds (a field, a probe, an event, or {node, near: [x, z], within}: the node is within that many metres on the floor plane); answers state plus met and steps.',
  'errors {clear?}: exceptions, window errors, console.error/warn from the page, with file:line:col in the TypeScript source; ring of 50, repeats counted.',
  'restart: the game starts again from ready with the same seed, paused at tick 0.',
  'teleport {node, to: [x, y, z], yaw?}: move the node, tell the renderer it jumped and clear a kit body\'s velocity; answers its new position.' + arrange + ' Never use it to get past something a player could not.',
  'set {node, field: "<BehaviourName>.<field>", value}: change one number, string or boolean field (not an object or a method) to a value of the same type; answers the old and new value.' + arrange,
  'perf {steps?}: ms per step and per frame (avg, p95, max), draw calls, triangles, node count.',
  'look {dx, dy}: mouse movement as under pointer lock.',
  'frames {count, every, width?, height?}: count screenshots every ticks apart, tiled into one picture with each tick written on it; tiles are at most 320 px wide, or with width/height each tile is that size and the sheet is scaled down to fit 1920x1080.',
  'screenshot {ui?, width?, height?}: the frame as a picture, with the HUD and menus; width and height (up to 1920x1080) render this one picture at that size and put the page back.',
  'ui: what a person could read on the UI layer now: screens (ids of the ui-screens showing) and items (text, button, bar with value and max, top to bottom, 80 at most).',
  'click {button}: click the button whose text matches (case-insensitive) or the nth (from 0); fires what a person\'s click does. A miss answers with the buttons there are. press / release of Enter, Space, Escape, Tab and the arrows also reach the UI layer: a focused button activates on Enter or Space.',
].join(' ');

const explainInput: Schema = JSON.parse(JSON.stringify(explainSchema)) as Schema;
const recentEvent: Schema = obj({ at: num('Game time in seconds.'), kind: { enum: ['sound', 'anim', 'vfx', 'actor'] }, id: str(), label: str(), node: str() }, ['at', 'kind', 'id', 'label']);
const briefDoc: Schema = obj({ exists: { type: 'boolean' }, title: str(), text: str(), sections: arr(obj({ id: str(), title: str(), text: str() }, ['id', 'title', 'text'])) }, ['exists', 'title', 'text', 'sections']);
const stageState: Schema = obj({ id: { enum: ['world', 'actors', 'animations', 'rules', 'sounds', 'effects', 'screens'] }, status: { enum: ['waiting', 'building', 'ready', 'failed'] }, summary: str(), checkpoint: str(), pieces: arr(str("Review keys: config ids, 'tunables:<block>', 'explain:<id>'.")) }, ['id', 'status', 'pieces']);
const createState: Schema = obj({ idea: str(), step: { enum: ['idea', 'brief', 'build', 'play'] }, briefApproved: { type: 'boolean' }, stages: arr(stageState) }, ['idea', 'step', 'briefApproved', 'stages']);

type MethodName = keyof Methods;
interface Spec {
  method: MethodName;
  /** What a list result is called (default `items`). The review tool already said `entries`. */
  key?: string;
  summary: string;
  input: Schema;
  output: Schema;
  format?(out: unknown): string[];
  /** See ToolDef.plainText. */
  plainText?: boolean;
  /** Shapes what the server answered before the tool returns it (the server's own answer stays whole for the app). */
  shape?(out: unknown, input: Record<string, unknown>): unknown;
}

const assetRef: Schema = obj({ kind: { enum: ['config', 'code'] }, file: str(), id: str(), pointer: str(), line: num(), col: num() }, ['kind', 'file', 'line', 'col']);
const assetResult: Schema = obj({ ok: { type: 'boolean' }, problems, refs: arr(assetRef), created: arr(str()), gone: arr(str()) }, ['ok', 'problems']);
const refLines = (o: unknown): string[] => ((o as { refs?: { file: string; pointer?: string; line: number; col: number }[] }).refs ?? []).map((r) => `  ${r.file}${r.pointer ? '#' + r.pointer : ''}:${r.line}:${r.col}`);


const codeWrite = obj({ ok: { type: 'boolean', description: 'False for a refusal and also when the write was kept but the type check found problems; see written.' }, written: { type: 'boolean' }, problems, elsewhere: num('Type problems found in other files (run check).'), created: { type: 'boolean' }, line: num(), replaced: num(), importers: arr(obj({ file: str(), line: num(), col: num(), specifier: str() }, ['file', 'line', 'col', 'specifier'])) }, ['ok', 'written', 'problems']);
const codeFmt = (verb: string) => (o: unknown): string[] => {
  const r = o as { written: boolean; problems: unknown[]; elsewhere?: number; line?: number };
  if (!r.written) return ['nothing written'];
  const here = r.problems.length ? r.problems.length + ' type problem(s) in this file (listed above): fix them.' : 'No type problems in this file.';
  return [verb + (r.line ? ' at line ' + r.line : '') + '; kept in the history. ' + here + (r.elsewhere ? ' ' + r.elsewhere + ' more in other files: run check.' : '')];
};
const typecheck: Schema = { type: 'boolean', description: 'Run the type check on the file after writing (default true). Turn it off for the first of several related edits, then check once.' };

const SPECS: Spec[] = [
  { method: 'project.info', summary: 'The project: root, title, manifest and where its game page is served.', input: empty, output: obj({ root: str(), title: str(), gameUrl: str(), manifest: {} }, ['root', 'title', 'gameUrl']) },
  { method: 'project.launch', summary: "The page options the game opens with, like start=camp&look=night (no leading ?). With no query it reads the kept options; with one it keeps them for this project (the Studio's Game view applies them) and returns the game page URL with them.", input: obj({ query: str('Like start=camp&look=night. An empty string clears them.') }), output: obj({ query: str(), url: str() }, ['query', 'url']), format: (o) => [(o as { url: string }).url] },
  { method: 'library.list', summary: 'Every config file and tunables block in the project, with its problem count.', input: empty, output: list(obj({ id: str(), kind: str(), path: str(), title: str(), note: str(), problems: num() }, ['id', 'kind', 'path', 'title', 'problems'])),
    format: (o) => (o as { items: { id: string; kind: string; problems: number }[] }).items.map((i) => `${i.id}  ${i.kind}${i.problems ? `  ${i.problems} problems` : ''}`) },
  { method: 'config.read', summary: 'A config file: its text, parsed value and current problems. The JSON Schema is left out unless schema is true (it is many times the size of the file).', input: obj({ id: str("Config id like 'sound/sword/hit'; 'game' (or 'hull.json') is the game manifest."), schema: { type: 'boolean', description: 'Also return the kind\'s JSON Schema.' } }, ['id']), output: obj({ id: str(), path: str(), text: str(), value: {}, schema: {}, problems }, ['id', 'path', 'text', 'problems']),
  shape: (out, input) => { if (input['schema'] === true || !out || typeof out !== 'object') return out; const { schema: _s, ...rest } = out as Record<string, unknown>; return rest; },
  format: (o) => [(o as { text: string }).text] },
  { method: 'config.set', summary: "Set one field of a config file; id 'game' (or 'hull.json') edits the game manifest. Validated first (a write may not add a problem), formatting kept, recorded in the history with its author.", input: obj({ id: str("Config id like 'sound/sword/hit'; 'game' (or 'hull.json') is the game manifest."), pointer: str('JSON pointer of the field, like /height.'), value: anyValue('The new JSON value.'), author, exp }, ['id', 'pointer', 'value']), output: writeResult,
 },
  { method: 'tunables.list', summary: 'Every tunable in src/ with its kind, value, options and where its literal is.', input: empty, output: list(obj({ block: str(), key: str(), kind: str(), value: {}, opts: { type: 'object' }, file: str(), line: num(), col: num() }, ['block', 'key', 'kind', 'value', 'file', 'line', 'col'])),
    format: (o) => (o as { items: { block: string; key: string; value: unknown }[] }).items.map((t) => `${t.block}.${t.key} = ${JSON.stringify(t.value)}`) },
  { method: 'tunables.set', summary: 'Change a tunable: rewrites its literal in the .ts file (re-parsed and type-checked first) and updates running games without a reload.', input: obj({ block: str('The tunables block, like player.'), key: str(), value: anyValue('The new value.'), author, exp }, ['block', 'key', 'value']), output: writeResult,
 },
  { method: 'content.list', summary: 'The Content Browser data: every folder under config/, the code files in src/, the kinds that can be created from nothing, and a preview (colours, levels) per asset.', input: empty, output: obj({ folders: arr(str()), code: arr(obj({ path: str(), bytes: num() }, ['path', 'bytes'])), creatable: arr(str()), thumbs: { type: 'object', additionalProperties: true } }, ['folders', 'code', 'creatable', 'thumbs']) },
  { method: 'asset.refs', summary: "Who names an asset (other configs by JSON pointer, string literals in src/) and which assets its own file names.", input: obj({ id: str("Config id like 'material/soldier-jacket'.") }, ['id']), output: obj({ ok: { type: 'boolean' }, problems, referencedBy: arr(assetRef), uses: arr(obj({ id: str(), pointer: str() }, ['id'])) }, ['ok', 'problems', 'referencedBy', 'uses']),
    format: (o) => { const r = o as { referencedBy: { file: string; line: number; col: number }[]; uses: { id: string }[] }; return [`referenced by ${r.referencedBy.length}`, ...r.referencedBy.map((x) => `  ${x.file}:${x.line}:${x.col}`), `uses ${r.uses.length}`, ...r.uses.map((u) => `  ${u.id}`)]; } },
  { method: 'asset.new', summary: 'Create a config asset of any kind from its starter document, one that passes check (level and prefab included; a level or prefab starter also creates material/starter when the project has none). Then change it with config.set. Validated, recorded in the history with its author.', input: obj({ kind: str(), id: str("The new id, like 'sound/combat/clash'."), author }, ['kind', 'id']), output: assetResult, format: (o) => [...((o as { created?: string[] }).created ?? []).map((i) => `created ${i}`)] },
  { method: 'kit.list', summary: "Every kit with its one-line summary, the config files it ships (material/floor ...) and the names it adds to 'hull/kits'. A kit's code reads its config, and the project has none until kit.add copies it.", input: empty, output: list(obj({ kit: str(), summary: str(), config: arr(str()), exports: arr(str()) }, ['kit', 'summary', 'config', 'exports'])),
    format: (o) => (o as { items: { kit: string; summary: string; config: string[] }[] }).items.map((k) => `${k.kit}  ${k.summary}${k.config.length ? `  [config: ${k.config.join(', ')}]` : ''}`) },
  { method: 'kit.add', summary: "Copy a kit's config files into the project's config/ (the files the kit's code reads: materials, sounds, screens, a level). Files the project already has are kept and listed as kept; one that differs from the kit's is also listed in differs, and an input-map missing actions the kit's map has gains them (merged: {'input-map/fps': ['interact']}), never changing an action it already has. Validated, recorded in the history with its author. check names the kit to add when a kit is imported without its config.", input: obj({ kit: str("A kit from kit.list, like 'level' or 'menu'."), author }, ['kit']), output: obj({ ok: { type: 'boolean' }, problems, created: arr(str()), kept: arr(str()), differs: arr(str()), merged: { type: 'object', additionalProperties: arr(str()) } }, ['ok', 'problems']),
    format: (o) => [...((o as { created?: string[] }).created ?? []).map((i) => `added ${i}`), ...((o as { kept?: string[] }).kept ?? []).map((i) => `kept ${i}`), ...((o as { differs?: string[] }).differs ?? []).map((i) => `differs from the kit's ${i}`), ...Object.entries((o as { merged?: Record<string, string[]> }).merged ?? {}).map(([id, a]) => `merged into ${id}: ${a.join(', ')}`)] },
  { method: 'asset.duplicate', summary: 'Copy an asset to a new id (default: <id>-copy).', input: obj({ id: str(), to: str(), author }, ['id']), output: assetResult, format: (o) => [...((o as { created?: string[] }).created ?? []).map((i) => `created ${i}`)] },
  { method: 'asset.rename', summary: 'Change an asset id, or a folder path. Every reference in other configs and in src/ string literals is rewritten in the same step; refused if the target exists or the kind would change.', input: obj({ id: str('An asset id or a folder like sound/combat.'), to: str('The new id or folder path.'), author }, ['id', 'to']), output: assetResult, format: (o) => ['renamed', ...refLines(o)] },
  { method: 'asset.move', summary: 'Move assets or folders into a folder of the same kind (sound/combat). References are rewritten like a rename.', input: obj({ ids: arr(str()), folder: str(), author }, ['ids', 'folder']), output: assetResult, format: (o) => ['moved', ...refLines(o)] },
  { method: 'asset.delete', summary: 'Delete assets or whole folders. Refused, with every place that still names one, while any reference exists.', input: obj({ ids: arr(str()), author }, ['ids']), output: assetResult, format: (o) => ['deleted'] },
  { method: 'folder.new', summary: 'Create an empty folder inside a config kind, like sound/combat.', input: obj({ path: str(), author }, ['path']), output: writeResult },
  { method: 'code.list', summary: 'Every file under src/ with its size in bytes.', input: empty, output: list(obj({ path: str(), bytes: num() }, ['path', 'bytes'])),
    format: (o) => (o as { items: { path: string; bytes: number }[] }).items.map((f) => f.path + '  ' + f.bytes + ' B') },
  { method: 'code.read', summary: 'Read a file of src/ (path like src/main.ts), whole or the lines from..to (1-based, inclusive).', input: obj({ path: str('Like src/main.ts.'), from: num(), to: num() }, ['path']), output: obj({ ok: { type: 'boolean' }, problems, path: str(), text: str(), from: num(), to: num(), total: num() }, ['ok', 'problems']),
    format: (o) => [(o as { text?: string }).text ?? ''] },
  { method: 'code.search', summary: 'Search src/ for a literal string (or a regex with regex:true). Returns file:line:col and the line. Narrow with path (a file or folder under src/).', input: obj({ pattern: str(), regex: { type: 'boolean' }, ignoreCase: { type: 'boolean' }, path: str(), limit: num('At most this many matches (default 100, max 500).') }, ['pattern']), output: obj({ ok: { type: 'boolean' }, problems, matches: arr(obj({ file: str(), line: num(), col: num(), text: str() }, ['file', 'line', 'col', 'text'])), truncated: { type: 'boolean' } }, ['ok', 'problems', 'matches', 'truncated']),
    format: (o) => { const r = o as { matches: { file: string; line: number; col: number; text: string }[]; truncated: boolean }; return [...r.matches.map((m) => m.file + ':' + m.line + ':' + m.col + ': ' + m.text.trim()), ...(r.truncated ? ['(more matches: narrow the search)'] : [])]; } },
  { method: 'code.edit', summary: 'Edit code in src/ by exact-string replace: old must match the file exactly once (add surrounding lines if it matches several; or set all). Written atomically, recorded in the history under the caller, the open game reloads. The file is then type-checked: problems come back as file:line:col but the edit stays, so fix them with another edit. For a changed value prefer config_set or tunables_set.', input: obj({ path: str('Like src/player.ts.'), old: str('The exact text to replace.'), new: str('The replacement.'), all: { type: 'boolean', description: 'Replace every copy of old.' }, typecheck, author }, ['path', 'old', 'new']), output: codeWrite, format: codeFmt('edited') },
  { method: 'code.write', summary: 'Create a file under src/, or overwrite one whole. Same safety, history record and type check as code.edit. Prefer code_edit for a change to an existing file.', input: obj({ path: str('Like src/enemies/slime.ts.'), text: str('The whole file.'), typecheck, author }, ['path', 'text']), output: codeWrite, format: codeFmt('written') },
  { method: 'code.delete', summary: 'Delete a file of src/. Refused, with each place (file:line:col), while another file imports it or hull.json names it.', input: obj({ path: str(), author }, ['path']), output: codeWrite, format: () => ['deleted'] },
  { method: 'journal.list', summary: 'The recent changes made through the server, newest last.', input: obj({ limit: num() }), output: list({ type: 'object', properties: { at: str(), by: str(), target: str(), path: str(), from: {}, to: {} }, required: ['at', 'by', 'target', 'path'], additionalProperties: true }),
 },
  { method: 'history.list', summary: 'The timeline, newest first, across the main line and every experiment. `by` says who made each change.', input: obj({ limit: num(), line: str("'main' or an experiment name.") }), output: list(historyChange),
    format: (o) => (o as { items: { short: string; by: string; message: string }[] }).items.map((c) => `${c.short}  ${c.by}  ${c.message}`) },
  { method: 'history.diff', summary: `What changed between two states, in plain words. ${idsHelp}`, input: obj({ from: str('Defaults to the parent of `to`.'), to: str() }, ['to']), output: obj({ from: { type: ['string', 'null'] }, to: str(), deltas: arr(delta) }, ['to', 'deltas']),
  format: (o) => (o as { deltas: { text: string }[] }).deltas.map((d) => d.text) },
  { method: 'history.restore', summary: 'Put the project back as it was at a change. Itself a new change, so it can be undone.', input: obj({ id: str(), author }, ['id']), output: obj({ ok: { type: 'boolean' }, problems, change: historyChange }, ['ok', 'problems']), },
  { method: 'history.patch', summary: `A compact line diff of one file between two states (to may be "main", the project as it is now). ${idsHelp}`, input: obj({ from: str('Defaults to the parent of \`to\`.'), to: str(), file: str('Like src/tuning.ts.') }, ['to', 'file']), output: obj({ file: str(), lines: arr(obj({ op: str(), n: num(), text: str() }, ['op', 'n', 'text'])), binary: { type: 'boolean' } }, ['file', 'lines']),
    format: (o) => (o as { lines: { op: string; text: string }[] }).lines.map((l) => (l.op === 'add' ? '+ ' : l.op === 'del' ? '- ' : l.op === 'gap' ? '...' : '  ') + l.text) },
  { method: 'history.revert', summary: `Put one file, or one field of a config file (pointer), back as it was at a change or checkpoint. Validated like history.restore and recorded as a new change. ${idsHelp}`, input: obj({ from: str(), file: str('Like config/look/dawn.json.'), pointer: str('JSON pointer of one field; leave out for the whole file.'), author }, ['from', 'file']), output: obj({ ok: { type: 'boolean' }, problems, change: historyChange }, ['ok', 'problems']), },
  { method: 'history.checkpoint', summary: 'Name a change so it can be returned to (default: the newest).', input: obj({ name: str(), id: str() }, ['name']), output: obj({ name: str(), id: str() }, ['name', 'id']), },
  { method: 'exp.start', summary: 'Make a working copy under .hull/exp/<name>/ to try changes without touching the project.', input: obj({ name: str(), from: str(), author }, ['name']), output: expInfo, },
  { method: 'exp.list', summary: 'Experiments and their status.', input: empty, output: list(expInfo), format: (o) => (o as { items: { name: string; status: string; changes: number }[] }).items.map((e) => `${e.name}  ${e.status}  ${e.changes} changes`) },
  { method: 'exp.compare', summary: 'The value differences between two lines (main or an experiment), a to b.', input: obj({ a: str(), b: str() }, ['a', 'b']), output: obj({ a: str(), b: str(), deltas: arr(delta) }, ['a', 'b', 'deltas']),  format: (o) => (o as { deltas: { text: string }[] }).deltas.map((d) => d.text) },
  { method: 'exp.adopt', summary: 'Three-way merge an experiment into the project. With conflicts nothing is written: call again with `resolve` ("ours" | "theirs" per "target#path").', input: obj({ name: str(), author, resolve: { type: 'object', additionalProperties: { enum: ['ours', 'theirs'] } } }, ['name']), output: obj({ ok: { type: 'boolean' }, conflicts: arr({ type: 'object', additionalProperties: true }), problems, change: historyChange }, ['ok', 'conflicts', 'problems']), },
  { method: 'exp.discard', summary: 'Close an experiment. Its changes stay in the timeline.', input: obj({ name: str() }, ['name']), output: obj({ ok: { type: 'boolean' } }, ['ok']), },
  { method: 'game.control', summary: 'Pause, resume, step, scale time or restart every connected game.', input: obj({ paused: { type: 'boolean' }, step: num('Run exactly n fixed steps (pauses afterwards).'), timeScale: num(), restart: { type: 'boolean' } }), output: empty },
  { method: 'game.run', summary: 'Run one control op on the running game and return its answer. Time moves only by step, so a script gives the same run every time. Ops: ' + controlOpHelp + ' With no app open, a headless game page is opened for you. After a code change the page reloads: the op waits up to 10 s for it to reconnect, and the answer has reloaded: true when a reload happened during the call (its tick then restarted).', input: obj({ control: controlOp, client: str('A specific game client; default is the project\'s first.') }, ['control']), output: { description: 'step/state/until: {tick,time,checksum,paused,nodes,held,probes,errors} (until adds met, steps); screenshot/frames: {png (base64),width,height}; inspect, tree, errors, perf: as listed; ui: {screens, items}; click: {clicked, buttons}; press/release/look: {}; teleport: {node, position, yaw}; set: {node, field, old, new}.', type: 'object', additionalProperties: true },
 },
  { method: 'problems.list', summary: 'Config problems and authorship problems (AI changes over values you set), as the app shows them.', input: empty, output: obj({ ok: { type: 'boolean' }, problems }, ['ok', 'problems']) },
  { method: 'review.list', summary: 'Review notes: what has been checked and what needs a change.', input: obj({ open: { type: 'boolean' } }), key: 'entries', output: list({ type: 'object', properties: { key: str(), state: str(), note: str() }, required: ['key', 'state'], additionalProperties: true }, 'entries'), },
  { method: 'review.set', summary: 'Set the review state of a config id or tunables block; the app updates live.', input: obj({ key: str(), state: { enum: ['unreviewed', 'approved', 'needs-change'] }, note: str(), author }, ['key', 'state']), output: obj({ ok: { type: 'boolean' }, problems, entry: { type: 'object', additionalProperties: true } }, ['ok', 'problems']), },
  { method: 'review.note', summary: 'Write a note on a piece without changing its review state (empty text clears it); the app updates live.', input: obj({ key: str(), note: str(), author }, ['key', 'note']), output: obj({ ok: { type: 'boolean' }, problems, entry: { type: 'object', additionalProperties: true } }, ['ok', 'problems']), },
  // ---- M11: idea to play (docs/IDEA-TO-PLAY.md section 4) --------------------------------------------------------------
  { method: 'brief.read', summary: 'The game brief: GAME.md at the project root, split into its "## " sections (premise, what-you-do, controls, cast, world, rules, look-and-sound, first-playable, not-in-the-first-version). exists is false before the first write.', input: empty, output: briefDoc, format: (o) => [(o as { text: string }).text || '(no brief yet)'] },
  { method: 'brief.write', summary: 'Write the brief. Pass "section" ({id, text}; id is the title in kebab case like "what-you-do"; a new section goes in the standard order, other sections stay as they are) or "text" for the whole file. Written atomically, recorded in the history under your name, and shown live in the app. Write one section at a time so the person can read the brief fill in.', input: obj({ text: str('The whole GAME.md. Starts with "# Title".'), section: obj({ id: str(), title: str('Only for a new section whose title is not the standard one.'), text: str('The section body, without its "## " heading.') }, ['id', 'text']), author }), output: obj({ ok: { type: 'boolean' }, problems, doc: briefDoc }, ['ok', 'problems']) },
    { method: 'docs.list', summary: 'The documents that teach Hull, guide/engine first (read it before writing code): the kit catalogue ("kit/index") and one per kit ("kit/combat"), the config formats ("guide/schemas"), the workflow ("guide/workflow"), and each module\'s exports ("api/core", ...). notBuilt names the config kinds the schema guide describes that have no schema yet. Read one with docs.read, find one with docs.search.', input: empty, output: obj({ ok: { type: 'boolean' }, problems, items: arr(obj({ id: str(), title: str(), kind: { enum: ['kit', 'guide', 'api'] }, bytes: num() }, ['id', 'title', 'kind', 'bytes'])), notBuilt: arr(str()) }, ['items']),
    format: (o) => [...(o as { items: { id: string; title: string; bytes: number }[] }).items.map((i) => i.id + '  ' + i.title + '  (' + i.bytes + ' bytes)'), ...((o as { notBuilt?: string[] }).notBuilt?.length ? ['not built (documented, no schema): ' + (o as { notBuilt: string[] }).notBuilt.join(', ')] : [])] },
  { method: 'docs.read', summary: 'Read one document from docs.list as markdown. Pass section (a heading, like "Lifecycle") to get just that part; a document is long, a section is what you need.', input: obj({ id: str('An id from docs.list, like guide/engine, kit/combat or api/audio.'), section: str('A heading of the document, in any case; a start of it is enough. Unknown: the answer lists the sections.') }, ['id']), output: obj({ ok: { type: 'boolean' }, problems, id: str(), title: str(), text: str(), sections: arr(str()) }, ['ok', 'problems']), format: (o) => [(o as { text?: string }).text ?? ''], plainText: true },
  { method: 'docs.search', summary: 'Find where the documents talk about something: words in the query must all appear in a section. Returns {id, section, line}; open it with docs.read {id, section}.', input: obj({ query: str('Words, like "pickup respawn" or "tunables block".') }, ['query']), output: list(obj({ id: str(), section: str(), line: str() }, ['id', 'section', 'line'])),
    format: (o) => (o as { items: { id: string; section: string; line: string }[] }).items.map((h) => h.id + (h.section ? '#' + h.section : '') + '  ' + h.line) },
  { method: 'explain.list', summary: 'The explain documents: drawings (flowchart, map with marks, table, picture) of pieces the person cannot judge by looking or listening, each with a plain sentence on what was decided.', input: empty, output: list(explainInput),
    format: (o) => (o as { items: { id: string; stage: string; title: string }[] }).items.map((d) => d.id + '  ' + d.stage + '  ' + d.title) },
  { method: 'explain.write', summary: 'Keep an explain document (a flow of nodes and edges, a map with marks, a table or a picture) for a rule, enemy behaviour, world layout or balance the person cannot see. Validated first: an edge must name nodes the flow has. An existing id is replaced and its review resets (review key "explain:<id>"). Stored in .hull/explain/<id>.json with your name.', input: obj({ doc: explainInput, author }, ['doc']), output: writeResult },
  { method: 'create.get', summary: 'Where the project is in the idea-to-play flow: the idea, the step (idea, brief, build, play), whether the brief is approved, and the seven build stages (world, actors, animations, rules, sounds, effects, screens) with their status and the pieces each made.', input: empty, output: createState },
  { method: 'create.set', summary: 'Record progress in the flow. "patch" sets idea, step or briefApproved; "stage" ({id, status, summary, checkpoint, pieces}) updates one stage. Returns the whole state; the app updates live.', input: obj({ patch: obj({ idea: str(), step: { enum: ['idea', 'brief', 'build', 'play'] }, briefApproved: { type: 'boolean' } }), stage: { ...stageState, required: ['id'] }, author }), output: createState },
  { method: 'game.recent', summary: 'What the running game just did, newest first: sounds started, animation states entered, effects spawned, characters that came alive, each with its game time and a plain label. Use it to answer what just played when the person says something felt off.', input: obj({ seconds: num('How far back, in game seconds (default 4).'), client: str('A specific game client.') }), output: list(recentEvent),
    format: (o) => (o as { items: { at: number; kind: string; id: string; label: string }[] }).items.map((e) => e.at.toFixed(2) + 's  ' + e.kind + '  ' + e.label + '  (' + e.id + ')') },
  { method: 'game.moment', summary: 'Freeze the game now: pauses it and returns a screenshot (PNG, base64), the tick, the game time and the recent events. Resume with game.control {paused:false}.', input: obj({ client: str('A specific game client.') }), output: obj({ tick: num(), time: num(), png: str(), width: num(), height: num(), recent: arr(recentEvent) }, ['tick', 'time', 'png', 'width', 'height', 'recent']) },
];

/** Methods that are already registry tools under another front (`check`, `build`) or are the registry's own entry point. */
export const projectTools: readonly ToolDef<unknown, unknown>[] = SPECS.map((s) => defineTool<Record<string, unknown>, unknown>({
  name: s.method,
  summary: s.summary,
  input: s.input,
  output: s.output,
  format: (out) => (s.format ? s.format(out) : [JSON.stringify(out, null, 2)]),
  ...(s.plainText ? { plainText: true } : {}),
  async run(ctx, input) {
    if (!ctx.project) throw new Error(`${s.method} needs the project server`);
    let params: Record<string, unknown> = { ...input };
    if (s.method === 'config.read') delete params['schema'];
    // Whoever calls is the author, unless the caller names one.
    if ((s.input['properties'] as Schema)['author'] && params['author'] === undefined) params = { ...params, author: ctx.author };
    const out = await ctx.project.call(s.method, params);
    const o = out as { ok?: boolean; problems?: Problem[] } | null;
    if (s.method === 'problems.list') return { ok: (out as Problem[]).length === 0, problems: out };
    const shaped = s.shape ? s.shape(out, input) : out;
    return Array.isArray(shaped) ? { ok: true, problems: [], [s.key ?? 'items']: shaped } : (shaped as typeof o);
  },
})) as unknown as readonly ToolDef<unknown, unknown>[];
