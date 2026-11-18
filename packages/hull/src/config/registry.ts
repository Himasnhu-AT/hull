import type { Manifest } from '../schema/index.ts';
import { kinds, manifestSchema } from '../schema/index.ts';
import { scanJson } from './scan.ts';
import type { ConfigRegistry, ConfigSource, IdOf, Kind, LoadResult, Problem, HullKinds } from './types.ts';
import { collectRefs, validateAgainst, type RefUse } from './validate.ts';

const MANIFEST = 'hull.json';
const PREFIX = 'config/';

interface Entry { path: string; kind: string; id: string; fullId: string; value: unknown; refs: RefUse[]; refPos: (p: string) => { line: number; col: number } }
// `loose` carries the references of a file that failed its schema, so one run reports a bad field and a missing id
// together instead of making the author fix them one at a time.
interface Checked { entry?: Entry; manifest?: { value: Manifest; refs: RefUse[]; refPos: Entry['refPos'] }; loose?: { refs: RefUse[]; refPos: Entry['refPos'] }; problems: Problem[] }

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
}

const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Parse and schema-check one file. Does not look at other files. */
function check(src: ConfigSource): Checked {
  const file = normalize(src.path);
  const scanned = scanJson(src.text);
  if (!scanned.ok) return { problems: [{ file, rule: 'parse', message: `invalid JSON: ${scanned.message}`, line: scanned.line, col: scanned.col }] };
  const at = (pointer: string, prefer?: 'value' | 'key'): { line: number; col: number } => scanned.locate(pointer, prefer);
  const problemsOf = (schema: object): Problem[] =>
    validateAgainst(schema, scanned.value).map((r) => ({ file, pointer: r.pointer, ...at(r.pointer, r.prefer), message: r.message, rule: 'schema' }));
  const refPos = (p: string): { line: number; col: number } => scanned.locate(p);

  if (file === MANIFEST) {
    const problems = problemsOf(manifestSchema);
    if (problems.length) return { problems, loose: { refs: collectRefs(manifestSchema, scanned.value), refPos } };
    return { manifest: { value: deepFreeze(scanned.value as Manifest), refs: collectRefs(manifestSchema, scanned.value), refPos }, problems };
  }

  if (!file.startsWith(PREFIX) || !file.endsWith('.json')) return { problems: [{ file, rule: 'schema', message: 'config files live under config/<kind>/ and end in .json' }] };
  const rest = file.slice(PREFIX.length, -'.json'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return { problems: [{ file, rule: 'schema', message: 'config files live in a folder named after their kind: config/<kind>/<name>.json' }] };
  const kind = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  const schema = kinds[kind];
  if (!schema) {
    return { problems: [{ file, rule: 'schema', message: `there is no kind "${kind}" (known kinds: ${Object.keys(kinds).join(', ')})` }] };
  }
  const v = scanned.value;
  const declared = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)['kind'] : undefined;
  if (typeof declared === 'string' && declared !== kind) {
    return {
      problems: [{ file, pointer: '/kind', ...at('/kind'), rule: 'kind-mismatch', message: `kind is "${declared}" but the file is in config/${kind}/, so it must be "${kind}"` }],
    };
  }
  const problems = problemsOf(schema);
  if (problems.length) return { problems, loose: { refs: collectRefs(schema, v), refPos } };
  return { entry: { path: file, kind, id, fullId: `${kind}/${id}`, value: deepFreeze(v), refs: collectRefs(schema, v), refPos }, problems };
}

function refProblems(file: string, refs: RefUse[], refPos: Entry['refPos'], has: (id: string) => boolean): Problem[] {
  const out: Problem[] = [];
  for (const r of refs) {
    const field = r.pointer.slice(r.pointer.lastIndexOf('/') + 1);
    const pos = refPos(r.pointer);
    if (!r.id.startsWith(`${r.kind}/`)) {
      out.push({ file, pointer: r.pointer, ...pos, rule: 'ref', message: `${field} must be the id of a ${r.kind} (like "${r.kind}/name"), got "${r.id}"` });
    } else if (!has(r.id)) {
      out.push({ file, pointer: r.pointer, ...pos, rule: 'ref', message: `${field} refers to "${r.id}", but there is no such ${r.kind} (expected config/${r.id}.json)` });
    }
  }
  return out;
}

const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function createRegistry(): ConfigRegistry {
  const files = new Map<string, Entry>();
  const byId = new Map<string, Entry>();
  const watchers = new Map<string, Set<(now: unknown) => void>>();
  let manifestValue: Manifest | undefined;

  const idsNow = (): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const k of Object.keys(kinds)) out[k] = [];
    for (const e of files.values()) (out[e.kind] ??= []).push(e.id);
    for (const list of Object.values(out)) list.sort();
    return out;
  };
  const result = (problems: Problem[]): LoadResult => ({ ok: problems.length === 0, problems, ids: idsNow() });

  const put = (e: Entry): void => { files.set(e.path, e); byId.set(e.fullId, e); };
  const drop = (path: string): void => {
    const e = files.get(path);
    if (e) { files.delete(path); byId.delete(e.fullId); }
  };

  return {
    load(sources) {
      files.clear();
      byId.clear();
      manifestValue = undefined;
      const problems: Problem[] = [];
      const checked: { file: string; c: Checked }[] = [];
      for (const s of sources) {
        const c = check(s);
        problems.push(...c.problems);
        checked.push({ file: normalize(s.path), c });
        if (c.entry) put(c.entry);
        if (c.manifest) manifestValue = c.manifest.value;
      }
      const has = (id: string): boolean => byId.has(id);
      for (const { file, c } of checked) {
        if (c.entry) problems.push(...refProblems(file, c.entry.refs, c.entry.refPos, has));
        if (c.manifest) problems.push(...refProblems(file, c.manifest.refs, c.manifest.refPos, has));
        if (c.loose) problems.push(...refProblems(file, c.loose.refs, c.loose.refPos, has));
      }
      return result(problems);
    },

    update(src) {
      const c = check(src);
      const file = normalize(src.path);
      const problems = [...c.problems];
      const staged = c.entry;
      const has = (id: string): boolean => byId.has(id) || staged?.fullId === id;
      if (staged) {
        const clash = byId.get(staged.fullId);
        if (clash && clash.path !== staged.path) problems.push({ file, rule: 'schema', message: `id "${staged.fullId}" is already used by ${clash.path}` });
        problems.push(...refProblems(file, staged.refs, staged.refPos, has));
      }
      if (c.manifest) problems.push(...refProblems(file, c.manifest.refs, c.manifest.refPos, has));
      if (c.loose) problems.push(...refProblems(file, c.loose.refs, c.loose.refPos, has));
      if (problems.length) return result(problems);
      if (staged) {
        put(staged);
        for (const fn of [...(watchers.get(staged.fullId) ?? [])]) fn(staged.value);
      }
      if (c.manifest) manifestValue = c.manifest.value;
      return result([]);
    },

    remove(path) {
      const p = normalize(path);
      if (p === MANIFEST) manifestValue = undefined;
      else drop(p);
    },

    get<K extends Kind>(kind: K, id: IdOf<K>): HullKinds[K] {
      const e = byId.get(`${kind}/${id}`);
      if (!e) throw new Error(`config ${kind}/${id} does not exist (expected config/${kind}/${id}.json)`);
      return e.value as HullKinds[K];
    },
    has: (id) => byId.has(id),
    ids: (kind) => idsNow()[kind] ?? [],

    watch(id, fn) {
      let set = watchers.get(id);
      if (!set) { set = new Set(); watchers.set(id, set); }
      set.add(fn);
      return () => { set.delete(fn); };
    },

    idsModule() {
      const ids = idsNow();
      const lines = Object.keys(ids).sort().map((k) => `    ${k}: ${ids[k]!.length ? ids[k]!.map(quote).join(' | ') : 'never'};`);
      return [
        '// Generated by hull from config/. Do not edit: it is rewritten by `hull check` and `hull dev`.',
        'export {};',
        '',
        "declare module 'hull' {",
        '  interface HullIds {',
        ...lines,
        '  }',
        '}',
        '',
      ].join('\n');
    },

    manifest: () => manifestValue,
  };
}

/** Validates hull.json on its own (schema only; references need the whole project, use `load`). */
export function checkManifest(src: ConfigSource): { value?: Manifest; problems: Problem[] } {
  const c = check({ path: MANIFEST, text: src.text });
  const problems = c.problems.map((p) => ({ ...p, file: normalize(src.path) }));
  return c.manifest ? { value: c.manifest.value, problems } : { problems };
}
