// Asset operations on a project's config/: new, duplicate, rename, move, delete, and who refers to what. Pure planning over
// file texts, so it is tested without a server; the project server applies a plan (writes, removes) and records it.
// An id is 'kind/folder/name'. Other configs name an asset by its whole id as a JSON string value; code names it as a string
// literal. A rename or move rewrites every such place, or refuses and lists them. Ids built at run time ('sound/' + name)
// cannot be seen; the Studio says so next to the list.
import type { Problem } from 'hull';

export interface AssetRef {
  /** 'config' for another config file, 'code' for a string literal in src/. */
  kind: 'config' | 'code';
  /** Project-relative path of the file that names the asset. */
  file: string;
  /** The config id of that file, for kind 'config'. */
  id?: string;
  pointer?: string;
  line: number;
  col: number;
}

export interface Plan {
  ok: boolean;
  problems: Problem[];
  /** Final text of every file to write (new paths included). */
  writes: { path: string; text: string }[];
  /** Files to delete. */
  removes: string[];
  /** Folders to create (project-relative). */
  mkdirs: string[];
  refs: AssetRef[];
  /** The ids that now exist / no longer exist, for the journal and the game. */
  created: string[];
  gone: string[];
}

export interface Sources { configs: { path: string; text: string }[]; code: { path: string; text: string }[] }

// No part of an id may start with a dot: an id becomes the path config/<id>.json, and a part of ".." walked out of
// config/ and out of the project ('tuning/../../hull' overwrote hull.json; three more wrote beside the project).
export const ID_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+$/;
export const FOLDER_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;
const pathOfId = (id: string): string => `config/${id}.json`;
export const idOfPath = (path: string): string => path.slice('config/'.length, -'.json'.length);
const isConfigId = (path: string): boolean => path.startsWith('config/') && path.endsWith('.json');
const kindOf = (id: string): string => id.split('/')[0]!;
const fail = (file: string, message: string, refs: AssetRef[] = []): Plan => ({ ok: false, problems: [{ file, rule: 'asset', message }], writes: [], removes: [], mkdirs: [], refs, created: [], gone: [] });
const done = (p: Partial<Plan>): Plan => ({ ok: true, problems: [], writes: [], removes: [], mkdirs: [], refs: [], created: [], gone: [], ...p });

const lineCol = (text: string, at: number): { line: number; col: number } => {
  const before = text.slice(0, at);
  return { line: before.split('\n').length, col: at - before.lastIndexOf('\n') };
};

/** Every string VALUE in a JSON text (keys are skipped) with its place, in document order. */
function jsonStrings(text: string): { value: string; at: number; end: number }[] {
  const out: { value: string; at: number; end: number }[] = [];
  const re = /"((?:[^"\\]|\\.)*)"(\s*:)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (!m[2]) out.push({ value: m[1]!, at: m.index, end: m.index + m[0].length });
  return out;
}

/** JSON pointers of string values equal to a given value, in document order (aligned with jsonStrings' order). */
function pointersOf(text: string, wanted: ReadonlySet<string>): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let root: unknown;
  try { root = JSON.parse(text); } catch { return found; }
  const walk = (v: unknown, ptr: string): void => {
    if (typeof v === 'string') { if (wanted.has(v)) { const l = found.get(v) ?? []; l.push(ptr); found.set(v, l); } }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${ptr}/${i}`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${ptr}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`);
  };
  walk(root, '');
  return found;
}

const CODE_RE = /(['"`])([A-Za-z0-9_./-]+)\1/g;

const shortId = (id: string): string => id.slice(id.indexOf('/') + 1);

/**
 * String literals in code that name one of `ids`. Code names an asset by the whole id ('sound/combat/hurt') or, through the
 * engine's kind-first calls, without the kind ('combat/hurt', or config.lookup('material', 'soldier-jacket')). A short form
 * with no slash is taken only when the same line also names the kind as a literal, so an unrelated 'hurt' is left alone.
 */
export function codeMatches(text: string, ids: ReadonlySet<string>): { at: number; len: number; quote: string; id: string; short: boolean }[] {
  const byShort = new Map<string, string[]>();
  for (const id of ids) { const s = shortId(id); const l = byShort.get(s) ?? []; l.push(id); byShort.set(s, l); }
  const out: { at: number; len: number; quote: string; id: string; short: boolean }[] = [];
  CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_RE.exec(text))) {
    const lit = m[2]!;
    if (ids.has(lit)) { out.push({ at: m.index, len: m[0].length, quote: m[1]!, id: lit, short: false }); continue; }
    const cands = byShort.get(lit);
    if (!cands) continue;
    const from = text.lastIndexOf('\n', m.index) + 1;
    const to = text.indexOf('\n', m.index);
    const line = text.slice(from, to < 0 ? text.length : to);
    const withKind = cands.filter((id) => new RegExp("['\"`]" + id.split('/')[0]!.replace(/[-]/g, '\\-') + "['\"`]").test(line));
    const chosen = lit.includes('/') ? (withKind.length ? withKind : cands) : withKind;
    for (const id of chosen) out.push({ at: m.index, len: m[0].length, quote: m[1]!, id, short: true });
  }
  return out;
}

/** Where an id is named: in other configs (string values equal to it) and in src/ (string literals equal to it). */
export function findRefs(src: Sources, ids: ReadonlySet<string>): Map<string, AssetRef[]> {
  const out = new Map<string, AssetRef[]>();
  const add = (id: string, r: AssetRef): void => { const l = out.get(id) ?? []; l.push(r); out.set(id, l); };
  for (const f of src.configs) {
    const hits = jsonStrings(f.text).filter((s) => ids.has(s.value));
    if (hits.length === 0) continue;
    const ptrs = pointersOf(f.text, ids);
    const used = new Map<string, number>();
    for (const h of hits) {
      const n = used.get(h.value) ?? 0;
      used.set(h.value, n + 1);
      const pointer = ptrs.get(h.value)?.[n];
      add(h.value, { kind: 'config', file: f.path, ...(isConfigId(f.path) ? { id: idOfPath(f.path) } : {}), ...(pointer !== undefined ? { pointer } : {}), ...lineCol(f.text, h.at) });
    }
  }
  for (const f of src.code) for (const h of codeMatches(f.text, ids)) add(h.id, { kind: 'code', file: f.path, ...lineCol(f.text, h.at) });
  return out;
}

/** What an asset's own file names: other asset ids that exist. */
export function usesOf(src: Sources, id: string): { id: string; pointer?: string }[] {
  const f = src.configs.find((c) => c.path === pathOfId(id));
  if (!f) return [];
  const known = new Set(src.configs.filter((c) => isConfigId(c.path)).map((c) => idOfPath(c.path)));
  known.delete(id);
  const wanted = new Set(jsonStrings(f.text).map((s) => s.value).filter((v) => known.has(v)));
  const ptrs = pointersOf(f.text, wanted);
  const out: { id: string; pointer?: string }[] = [];
  for (const [v, list] of ptrs) for (const pointer of list) out.push({ id: v, pointer });
  return out;
}

const ids = (src: Sources): string[] => src.configs.filter((c) => isConfigId(c.path)).map((c) => idOfPath(c.path));

/** Rewrites every reference to the keys of `map` in a config text or a code text. */
const rewriteConfig = (text: string, map: ReadonlyMap<string, string>): string => {
  let out = '', last = 0;
  for (const s of jsonStrings(text)) {
    const to = map.get(s.value);
    if (to === undefined) continue;
    out += text.slice(last, s.at) + JSON.stringify(to);
    last = s.end;
  }
  return out + text.slice(last);
};
const rewriteCode = (text: string, map: ReadonlyMap<string, string>): string => {
  let out = '', last = 0;
  for (const h of codeMatches(text, new Set(map.keys()))) {
    if (h.at < last) continue; // two candidates for one literal: the first wins
    const to = map.get(h.id)!;
    out += text.slice(last, h.at) + h.quote + (h.short ? shortId(to) : to) + h.quote;
    last = h.at + h.len;
  }
  return out + text.slice(last);
};

const places = (refs: readonly AssetRef[]): string => refs.map((r) => `${r.file}${r.pointer ? `#${r.pointer}` : ''}:${r.line}:${r.col}`).join('; ');

/** Folders a move expands to: an entry that is not an asset id but has assets under it is a folder. */
export function expandMoves(all: readonly string[], entries: readonly string[], folder: string): { from: string; to: string }[] | string {
  const out: { from: string; to: string }[] = [];
  for (const e of entries) {
    const short = e.split('/').at(-1)!;
    if (all.includes(e)) out.push({ from: e, to: `${folder}/${short}` });
    else {
      const inside = all.filter((a) => a.startsWith(`${e}/`));
      if (inside.length === 0) return `${e} is neither an asset nor a folder with assets`;
      for (const a of inside) out.push({ from: a, to: `${folder}/${short}/${a.slice(e.length + 1)}` });
    }
  }
  return out;
}

/** A rename or move of one or more assets. Refuses when a target exists, the kind would change, or the id is not valid. */
export function planMoves(src: Sources, moves: readonly { from: string; to: string }[]): Plan {
  const have = new Set(ids(src));
  const map = new Map<string, string>();
  const targets = new Set<string>();
  for (const m of moves) {
    if (!have.has(m.from)) return fail(pathOfId(m.from), `${m.from} does not exist`);
    if (!ID_RE.test(m.to)) return fail(pathOfId(m.from), `${m.to} is not an id like 'sound/combat/hit' (letters, digits, - _ . and /)`);
    if (kindOf(m.to) !== kindOf(m.from)) return fail(pathOfId(m.from), `${m.from} is a ${kindOf(m.from)}; it cannot move into ${kindOf(m.to)}/`);
    if (m.to === m.from) continue;
    if (targets.has(m.to) || (have.has(m.to) && !moves.some((o) => o.from === m.to))) return fail(pathOfId(m.to), `${m.to} already exists`);
    targets.add(m.to);
    map.set(m.from, m.to);
  }
  if (map.size === 0) return done({});
  const writes: { path: string; text: string }[] = [];
  const removes: string[] = [];
  const mkdirs = new Set<string>();
  const changedRefs: AssetRef[] = [];
  for (const [, refs] of findRefs(src, new Set(map.keys()))) changedRefs.push(...refs);
  for (const f of src.configs) {
    const asset = isConfigId(f.path) ? idOfPath(f.path) : undefined;
    const to = asset ? map.get(asset) : undefined;
    const text = rewriteConfig(f.text, map);
    if (to) {
      writes.push({ path: pathOfId(to), text });
      removes.push(f.path);
      mkdirs.add(pathOfId(to).split('/').slice(0, -1).join('/'));
    } else if (text !== f.text) writes.push({ path: f.path, text });
  }
  for (const f of src.code) { const text = rewriteCode(f.text, map); if (text !== f.text) writes.push({ path: f.path, text }); }
  return done({ writes, removes, mkdirs: [...mkdirs], refs: changedRefs, created: [...map.values()], gone: [...map.keys()] });
}

/** Deleting is refused while anything names the asset; the plan then carries the places. */
export function planDelete(src: Sources, targets: readonly string[]): Plan {
  const have = new Set(ids(src));
  for (const t of targets) if (!have.has(t)) return fail(pathOfId(t), `${t} does not exist`);
  const set = new Set(targets);
  const outside = (r: AssetRef): boolean => !(r.kind === 'config' && r.id !== undefined && set.has(r.id));
  const refs: AssetRef[] = [];
  const lines: string[] = [];
  for (const [id, list] of findRefs(src, set)) {
    const l = list.filter(outside);
    if (l.length) { refs.push(...l); lines.push(`${id} is named at ${places(l)}`); }
  }
  if (refs.length) return fail(pathOfId(targets[0]!), `not deleted, still referenced: ${lines.join('. ')}`, refs);
  return done({ removes: targets.map(pathOfId), gone: [...targets] });
}

/** First free `<id>-copy`, `<id>-copy-2` ... */
export function freeId(src: Sources, base: string, suffix = 'copy'): string {
  const have = new Set(ids(src));
  let id = `${base}-${suffix}`, n = 2;
  while (have.has(id)) id = `${base}-${suffix}-${n++}`;
  return id;
}

export function planDuplicate(src: Sources, id: string, to?: string): Plan {
  const f = src.configs.find((c) => c.path === pathOfId(id));
  if (!f) return fail(pathOfId(id), `${id} does not exist`);
  const target = to ?? freeId(src, id);
  if (!ID_RE.test(target)) return fail(pathOfId(id), `${target} is not a valid id`);
  if (kindOf(target) !== kindOf(id)) return fail(pathOfId(id), `a copy of ${id} must stay in ${kindOf(id)}/`);
  if (ids(src).includes(target)) return fail(pathOfId(target), `${target} already exists`);
  return done({ writes: [{ path: pathOfId(target), text: f.text }], mkdirs: [pathOfId(target).split('/').slice(0, -1).join('/')], created: [target] });
}

/**
 * A small valid document for every kind in the schema, so any asset can be created from nothing. Each passes `check` in a
 * fresh project: where it must name another asset, `NEEDS` lists the ones asset.new creates beside it when they are missing
 * (a prefab's box needs a material). Starters for kinds a kit ships come from that kit's own example file, cut down.
 */
export const STARTERS: Readonly<Record<string, unknown>> = {
  material: { kind: 'material', color: '#9aa4b2', roughness: 0.6, metalness: 0 },
  look: { kind: 'look', sky: { horizon: '#c3cdd3', mid: '#a1adb8', zenith: '#8693a2' }, fog: { color: '#c3cdd3', near: 80, far: 600 } },
  // 'sfx' is a bus every project has (the default mixer: master, sfx, ui, voice, music); 'top' was not, so the sound played on master.
  sound: { kind: 'sound', bus: 'sfx', level: -6, source: { type: 'synth', length: 0.2, layers: { tone: { from: { osc: 'sine', freq: 440 }, then: [{ envelope: { attack: 0.002, decay: 0.15 } }, { gain: -6 }] } } } },
  vfx: { kind: 'vfx', emit: { count: [4, 6] }, particle: { life: [0.4, 0.8], speed: [1, 3], size: [[0, 0.2], [1, 0.6]], color: [[0, '#ffd27a'], [1, '#c9523a']], alpha: [[0, 1], [1, 0]], sprite: 'soft' }, budget: { max: 200, fadeNear: 1 } },
  tuning: { kind: 'tuning' },
  'ui-screen': { kind: 'ui-screen', root: { panel: { align: 'center', gap: 10, width: 360 }, children: [{ title: { text: 'Title' } }, { text: { text: 'Change me' } }] } },
  'ui-theme': { kind: 'ui-theme', color: { panel: '#10141a', text: '#f4f1ea', accent: '#35e0c2' }, type: { size: 18 }, space: { gutter: 20, radius: 6 } },
  'input-map': { kind: 'input-map', actions: { jump: { type: 'button', keys: ['Space'] } } },
  mixer: { kind: 'mixer', buses: { master: { level: 0 }, sfx: { to: 'master', level: 0 }, ui: { to: 'master', level: -4 }, music: { to: 'master', level: -10 } } },
  // A walled ground with one block and the player's start marker, no prefab, so it needs only a material.
  level: {
    kind: 'level',
    ground: { size: [24, 24], material: 'material/starter' },
    walls: { height: 2.5, material: 'material/starter' },
    blocks: [{ name: 'block', at: [4, 0.6, -4], size: [1.2, 1.2, 1.2], material: 'material/starter' }],
    markers: { start: { at: [0, 0, 8], yawDeg: 0 } },
  },
  // The kit's crate prefab, with the starter material.
  prefab: {
    kind: 'prefab',
    parts: [{ name: 'box', shape: 'box', at: [0, 0.6, 0], size: [1.2, 1.2, 1.2], material: 'material/starter' }],
    collider: { shape: 'box', at: [0, 0.6, 0], size: [1.2, 1.2, 1.2] },
  },
  'anim-set': { kind: 'anim-set', clips: { idle: { type: 'generated', generator: 'humanoid/idle', loop: true } } },
  'anim-graph': { kind: 'anim-graph', layers: { base: { start: 'idle', states: { idle: { clip: 'idle' } } } } },
  character: { kind: 'character', body: { type: 'generated', recipe: 'humanoid', proportions: { height: 1.78, shoulders: 0.44, legs: 0.52, head: 0.23 } }, collider: { shape: 'capsule', radius: 0.35, height: 1.7 } },
  'move-set': {
    kind: 'move-set',
    weapon: { socket: 'handR', base: [0, 0, 0], tip: [0, 0, 0.8] },
    moves: { slash: { input: 'light', length: 0.6, damage: 10, posture: 10, reach: 1.6, windows: { telegraph: [0, 0.3], trace: [0.3, 0.45] } } },
  },
  enemy: { kind: 'enemy', moveSet: 'move-set/starter', health: 60, patterns: [{ name: 'cut', weight: 1, steps: [{ move: 'slash', telegraph: 0.4 }], recover: 1 }] },
};

/** The assets a starter names: made first, by their own starters, when the project does not have them. */
export const NEEDS: Readonly<Record<string, readonly string[]>> = {
  level: ['material/starter'],
  prefab: ['material/starter'],
  enemy: ['move-set/starter'],
};

const text = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

export function planNew(src: Sources, kind: string, given: string): Plan {
  // 'cellar' with kind 'level' means 'level/cellar': the kind is already said, so a bare name is not an error.
  // An id that starts with another kind's name ('sound/x' for a material) is still a mistake, not a nested name.
  const id = given.startsWith(`${kind}/`) || (given.split('/')[0] ?? '') in STARTERS ? given : `${kind}/${given}`;
  const starter = STARTERS[kind];
  if (!starter) return fail(`config/${kind}`, `${kind} is not a config kind (have: ${Object.keys(STARTERS).join(', ')})`);
  if (!ID_RE.test(id) || kindOf(id) !== kind) return fail(pathOfId(id), `${id} must be an id inside ${kind}/, like ${kind}/my-asset`);
  const have = new Set(ids(src));
  if (have.has(id)) return fail(pathOfId(id), `${id} already exists`);
  const writes = [{ path: pathOfId(id), text: text(starter) }];
  const created = [id];
  for (const need of NEEDS[kind] ?? []) {
    if (have.has(need) || need === id) continue;
    writes.push({ path: pathOfId(need), text: text(STARTERS[kindOf(need)]) });
    created.push(need);
  }
  const mkdirs = [...new Set(writes.map((w) => w.path.split('/').slice(0, -1).join('/')))];
  return done({ writes, mkdirs, created });
}
