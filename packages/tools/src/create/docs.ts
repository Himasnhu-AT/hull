// What an agent reads to learn Hull without leaving its tools (docs/IDEA-TO-PLAY.md section 4.2): every kit's README, the
// kit catalogue, the guides, and one generated summary of each public entry of the hull package. Everything is found from
// the hull package's own location, never from the project's root, so a project made anywhere that depends on hull
// gets the same documents.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import ts from 'typescript6';
import { kinds } from 'hull/schema';
import type { DocItem } from 'hull/dev/protocol';

export interface DocSource { id: string; title: string; kind: DocItem['kind']; text(): string }

/** The folder of the hull package (the one with src/ in it), found by asking Node where 'hull' resolves. */
export function hullDir(): string {
  const entry = createRequire(import.meta.url).resolve('hull');
  return dirname(dirname(entry));
}

const titleOf = (text: string, fallback: string): string => /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? fallback;
const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8');
const read = (p: string): string => readFileSync(p, 'utf8');

/** Kit READMEs and the catalogue, then the guides that exist next to the package (the repository's docs/ folder), then the API summaries. */
export function docSources(): DocSource[] {
  const hull = hullDir();
  const out: DocSource[] = [];
  // The guide to the engine comes first: it is what an agent reads before it writes a line.
  const engine = join(hull, 'docs', 'ENGINE.md');
  if (existsSync(engine)) out.push({ id: 'guide/engine', title: titleOf(read(engine), 'Writing a game with Hull'), kind: 'guide', text: () => read(engine) });
  const kits = join(hull, 'src', 'kits');
  if (existsSync(join(kits, 'README.md'))) out.push({ id: 'kit/index', title: 'Kits', kind: 'kit', text: () => kitIndex(kits) });
  let names: string[] = [];
  try { names = readdirSync(kits).sort(); } catch { /* no kits folder */ }
  for (const n of names) {
    const p = join(kits, n, 'README.md');
    if (statSync(join(kits, n)).isDirectory() && existsSync(p)) out.push({ id: `kit/${n}`, title: titleOf(read(p), n), kind: 'kit', text: () => read(p) });
  }
  const guides = join(hull, '..', '..', 'docs');
  for (const [id, file, fallback] of [['guide/schemas', 'SCHEMAS.md', 'Config file formats'], ['guide/workflow', 'WORKFLOW.md', 'The workflow']] as const) {
    const p = join(guides, file);
    if (existsSync(p)) out.push({ id, title: titleOf(read(p), fallback), kind: 'guide', text: () => read(p) });
  }
  for (const e of apiEntries(hull)) {
    if (e.name === 'three') { out.push({ id: 'api/three', title: `API: ${e.import}`, kind: 'api', text: () => THREE_NOTE }); continue; }
    // An entry too big for one document is an index plus one part per group (api/kits/level): the parts come from the built summary.
    const ids = [...apiDocs(hull).keys()].filter((k) => k === e.name || k.startsWith(`${e.name}/`)).sort();
    for (const id of ids.length ? ids : [e.name]) out.push({ id: `api/${id}`, title: id === e.name ? `API: ${e.import}` : `API: ${e.import}: ${id.slice(e.name.length + 1)}`, kind: 'api', text: () => apiText(hull, id, e) });
  }
  return out;
}

/** hull/three re-exports all of three.js, so a list of its exports says nothing a reader can use; this says what it is for. */
const THREE_NOTE = `# API: hull/three

\`hull/three\` is the engine's own copy of three.js (all of it re-exported). Use it only when a game already builds its
visuals as three.js objects (procedural meshes, ShaderMaterial, merged geometry) and cannot be written with \`Mesh\`, materials
and \`shape\` from \`hull/render\`. Everything else should go through hull/render and config.

How: import what you need from 'hull/three' (never from 'three': the check refuses it, and a second copy breaks \`instanceof\`),
build an \`Object3D\`, and add it to a node with the \`SceneObject\` behaviour; it then follows the node and the running backend
draws it. The game still never creates a renderer or owns the frame loop. GLSL you write only runs on WebGL2, so pin
\`render.backend\` to webgl2 in hull.json. For three.js's own API read three.js's documentation.
`;

/** The kit catalogue, built from the kit folders so a new kit cannot be left out: the name is the folder, the line is the README's first paragraph. */
function kitIndex(kits: string): string {
  const head = read(join(kits, 'README.md')).trimEnd();
  const rows: string[] = [];
  for (const n of readdirSync(kits).sort()) {
    const p = join(kits, n, 'README.md');
    if (!statSync(join(kits, n)).isDirectory() || !existsSync(p)) continue;
    rows.push(`| \`${n}\` | ${firstSentence(read(p))} |`);
  }
  return `${head}\n\n## The kits\n\n| Kit | What it gives you (read it with docs.read kit/<name>) |\n|---|---|\n${rows.join('\n')}\n`;
}

/** The first sentence of the first paragraph after the title, on one line, without table-breaking bars. */
export function firstSentence(readme: string): string {
  const body = readme.replace(/^#.*\n/, '').trim().split(/\n\s*\n/)[0] ?? '';
  const one = body.replace(/\s+/g, ' ').trim();
  const cut = /^(.*?[.!?])(\s|$)/.exec(one)?.[1] ?? one;
  return cut.replace(/\|/g, '/');
}

// ---- The generated API summary ------------------------------------------------------------------------------------------------

interface Entry { name: string; /** What a game writes after "from": 'hull', 'hull/audio'. */ import: string; file: string }

/** One entry per path in hull's package.json "exports" (the plain "hull" entry is called "core"; it holds core and config). */
function apiEntries(hull: string): Entry[] {
  let exp: Record<string, string> = {};
  try { exp = (JSON.parse(read(join(hull, 'package.json'))) as { exports?: Record<string, string> }).exports ?? {}; } catch { return []; }
  return Object.entries(exp)
    .filter(([, f]) => typeof f === 'string' && f.endsWith('.ts'))
    .map(([k, f]) => ({ name: k === '.' ? 'core' : k.slice(2).replace(/\//g, '-'), import: k === '.' ? 'hull' : `hull/${k.slice(2)}`, file: join(hull, f) }));
}

const cache = new Map<string, Map<string, string>>();

/** One program over every entry, built once per hull folder: the checker is the slow part, the text is cheap. */
function apiDocs(hull: string): Map<string, string> {
  let all = cache.get(hull);
  if (!all) {
    // A program that cannot be built must not turn into an empty document: say what is missing and where to look instead.
    try { all = buildApi(hull); } catch { all = new Map(); }
    cache.set(hull, all);
  }
  return all;
}

function apiText(hull: string, id: string, entry: Entry): string {
  return apiDocs(hull).get(id) ?? `# ${entry.import}\n\n(no summary could be generated; read the module's source at ${entry.file})\n`;
}

const oneLine = (s: string, max: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** A document stays under this many bytes: an agent reads it whole, and a long one costs more than the answer it holds. */
const API_LIMIT = 18_000;

interface ApiItem { name: string; line: string; members(compact: boolean): string[]; /** The group the export is filed under when an entry must be split: a kit folder, or the first folder under src/. */ group: string }

function groupOf(hull: string, file: string): string {
  const rel = file.slice(join(hull, 'src').length + 1).split('/');
  if (rel[0] === 'kits') return rel.length > 2 ? rel[1]! : 'shared';
  return rel.length > 1 ? rel[0]! : rel[0]!.replace(/\.ts$/, '');
}

function buildApi(hull: string): Map<string, string> {
  const entries = apiEntries(hull).filter((e) => e.name !== 'three');
  const program = ts.createProgram(entries.map((e) => e.file), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, strict: true, types: [],
  });
  const checker = program.getTypeChecker();
  const out = new Map<string, string>();
  for (const e of entries) {
    const sf = program.getSourceFile(e.file);
    const mod = sf && checker.getSymbolAtLocation(sf);
    const exports = mod ? checker.getExportsOfModule(mod).sort((a, b) => a.name.localeCompare(b.name)) : [];
    const items: ApiItem[] = [];
    for (const sym of exports) {
      const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
      const decl = target.declarations?.[0];
      items.push({ name: sym.name, line: signature(checker, sym.name, target, decl), members: (compact) => membersOf(checker, target, decl, compact), group: decl ? groupOf(hull, decl.getSourceFile().fileName) : 'other' });
    }
    const use = '`import { ... } from \'' + e.import + '\'`';
    const intro = [`# API: ${e.import}`, '', `${use}. Generated from the code: each export with its signature and, for a class or interface, its own public members (one line each: signature, then the first sentence of its doc comment). An inherited member is listed once, on the base class.`, ''];
    const render = (list: ApiItem[], compact = false): string[] => list.flatMap((i) => [`- ${i.line}`, ...i.members(compact)]);
    const whole = [...intro, ...render(items)].join('\n') + '\n';
    if (Buffer.byteLength(whole) <= API_LIMIT) { out.set(e.name, whole); continue; }
    // Too big for one document: this one says where each export is, and each group has a document of its own.
    const groups = new Map<string, ApiItem[]>();
    for (const i of items) groups.set(i.group, [...(groups.get(i.group) ?? []), i]);
    const index = [intro[0]!, '', `${use}. This entry is split by where the code lives; read the part that has the name you need (docs.read with the id).`, ''];
    for (const [g, list] of groups) {
      const head = [`# API: ${e.import}: ${g}`, '', `${use}. One part of ${e.import}; the index is api/${e.name}.`, ''];
      let text = [...head, ...render(list)].join('\n') + '\n';
      // A part still too long (the dev protocol's method table) keeps its members' signatures and drops their comments.
      if (Buffer.byteLength(text) > API_LIMIT) text = [...head, '(Comments left out to keep this document short; read the source for them.)', '', ...render(list, true)].join('\n') + '\n';
      out.set(`${e.name}/${g}`, text);
      index.push(`- api/${e.name}/${g}: ${list.map((i) => i.name).join(', ')}`);
    }
    out.set(e.name, index.join('\n') + '\n');
  }
  return out;
}

const F = ts.SymbolFlags;

/** The first sentence of a symbol's doc comment, on one line. */
function docOf(checker: ts.TypeChecker, sym: ts.Symbol, max: number): string {
  const text = ts.displayPartsToString(sym.getDocumentationComment(checker)).replace(/\b(e\.g|i\.e|etc|vs)\./g, '$1\x00');
  // The first sentence: up to a full stop followed by a capital letter (or the end), or the first blank line or list item.
  const first = text.split(/\n\n|\n(?=[-*@])/)[0] ?? '';
  const cut = /^([\s\S]*?[.!?])(?=\s+[A-Z`]|$)/.exec(first)?.[1] ?? first;
  return oneLine(cut.replace(/\x00/g, '.'), max);
}

/** Own public members of a class or interface, one line each. An inherited member belongs to its base's own listing. */
function membersOf(checker: ts.TypeChecker, sym: ts.Symbol, decl: ts.Declaration | undefined, compact: boolean): string[] {
  if (!decl || !(sym.flags & (F.Class | F.Interface))) return [];
  try {
    const type = checker.getDeclaredTypeOfSymbol(sym);
    // Static members live on the constructor type, not on the instance type.
    const ctor = sym.flags & F.Class ? checker.getTypeOfSymbolAtLocation(sym, decl) : undefined;
    const statics = ctor ? ctor.getProperties().filter((p) => p.name !== 'prototype') : [];
    const decls = new Set<ts.Node>(sym.declarations ?? []);
    const lines: { order: number; text: string }[] = [];
    const add = (p: ts.Symbol, isStatic: boolean): void => {
      const d = p.declarations?.[0];
      if (!d || p.name.startsWith('_') || p.name.startsWith('#')) return;
      // Own members only: one declared in a base class or interface is listed there.
      if (!decls.has(d.parent)) return;
      const mods = ts.getCombinedModifierFlags(d);
      if (mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) return;
      if (p.getJsDocTags().some((t) => t.name === 'internal')) return;
      const prefix = (isStatic ? 'static ' : '') + (mods & ts.ModifierFlags.Readonly ? 'readonly ' : '');
      const optional = p.flags & F.Optional ? '?' : '';
      // An optional member is not "or undefined" to the reader, and a member that is a function reads as a method.
      const t = p.flags & F.Optional ? checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(p, d)) : checker.getTypeOfSymbolAtLocation(p, d);
      const calls = t.getCallSignatures();
      const sig = calls.length && t.getProperties().length === 0
        ? `${p.name}${optional}${checker.signatureToString(calls[0]!)}${calls.length > 1 ? ` (+${calls.length - 1} overloads)` : ''}`
        : `${p.name}${optional}: ${checker.typeToString(t, d, ts.TypeFormatFlags.NoTruncation)}`;
      const doc = compact ? '' : docOf(checker, p, 110);
      lines.push({ order: d.getStart(), text: `  - ${oneLine(prefix + sig, compact ? 110 : 170)}${doc ? ` // ${doc}` : ''}` });
    };
    for (const p of statics) add(p, true);
    for (const p of type.getProperties()) add(p, false);
    // Source order reads the way the class does.
    return lines.sort((x, y) => x.order - y.order).map((l) => l.text);
  } catch { return []; /* a type the checker cannot print: the export's own line is still true */ }
}

function signature(checker: ts.TypeChecker, name: string, sym: ts.Symbol, decl: ts.Declaration | undefined): string {
  let sig: string;
  try {
    if (sym.flags & (F.Class | F.Interface)) {
      const t = checker.getDeclaredTypeOfSymbol(sym);
      const base = checker.getBaseTypes(t as ts.InterfaceType).map((b) => checker.typeToString(b)).join(', ');
      sig = `${sym.flags & F.Class ? 'class' : 'interface'} ${name}${base ? ` extends ${base}` : ''}`;
    } else if (sym.flags & F.TypeAlias) {
      // The source's own words for the type beat the checker's, which prints an alias as its own name.
      const node = decl && ts.isTypeAliasDeclaration(decl) ? decl.type.getText() : checker.typeToString(checker.getDeclaredTypeOfSymbol(sym));
      sig = `type ${name}${decl && ts.isTypeAliasDeclaration(decl) && decl.typeParameters ? `<${decl.typeParameters.map((p) => p.name.text).join(', ')}>` : ''} = ${node}`;
    }
    else if (sym.flags & F.Enum) sig = `enum ${name}`;
    else if (sym.flags & F.Function && decl) {
      const s = checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(sym, decl), ts.SignatureKind.Call)[0];
      sig = s ? `function ${name}${checker.signatureToString(s)}` : `function ${name}`;
    } else if (decl) sig = `const ${name}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(sym, decl))}`;
    else sig = name;
  } catch { sig = name; }
  const doc = docOf(checker, sym, 120);
  return oneLine(sig, 220) + (doc ? ` // ${doc}` : '');
}

// ---- The methods ----------------------------------------------------------------------------------------------------------------

export function listDocs(): DocItem[] {
  return docSources().map((s) => ({ id: s.id, title: s.title, kind: s.kind, bytes: bytesOf(s.text()) }));
}

/** Config kinds that docs/SCHEMAS.md describes in a heading but that have no schema yet, so nothing validates them. */
export function notBuiltKinds(): string[] {
  const p = join(hullDir(), '..', '..', 'docs', 'SCHEMAS.md');
  if (!existsSync(p)) return [];
  const found = new Set<string>();
  for (const line of read(p).split('\n')) {
    // Only a heading that says so: other headings name things in backticks too (`x-ui`).
    if (!/^##+ /.test(line) || !/not built/i.test(line)) continue;
    for (const m of line.matchAll(/`([a-z][a-z-]*)`/g)) if (!(m[1]! in kinds)) found.add(m[1]!);
  }
  return [...found].sort();
}

interface Section { title: string; slug: string; level: number; from: number; to: number }
const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The headings of a markdown text with the line range each one covers (up to the next heading of the same or a higher level). Fenced code is skipped. */
export function sectionsOf(text: string): Section[] {
  const lines = text.split('\n');
  const heads: Omit<Section, 'to'>[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^```/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.*)$/.exec(l);
    if (m) heads.push({ title: m[2]!.trim(), slug: slugOf(m[2]!), level: m[1]!.length, from: i });
  });
  return heads.map((h, k) => ({ ...h, to: heads.slice(k + 1).find((n) => n.level <= h.level)?.from ?? lines.length }));
}

/** One section of a document by heading (the heading text, its kebab-case form, or a start of it). */
export function readSection(text: string, section: string): string | null {
  const want = slugOf(section);
  const all = sectionsOf(text);
  const hit = all.find((s) => s.slug === want) ?? all.find((s) => s.slug.startsWith(want)) ?? all.find((s) => s.slug.includes(want));
  return hit ? text.split('\n').slice(hit.from, hit.to).join('\n').trimEnd() + '\n' : null;
}

export function readDoc(id: string, section?: string): { id: string; title: string; text: string; sections?: string[]; missing?: boolean } | null {
  const s = docSources().find((x) => x.id === id);
  if (!s) return null;
  const text = s.text();
  if (!section) return { id: s.id, title: s.title, text };
  const part = readSection(text, section);
  const sections = sectionsOf(text).map((x) => x.slug);
  return part === null ? { id: s.id, title: s.title, text: '', sections, missing: true } : { id: s.id, title: s.title, text: part, sections };
}

export interface DocHit { id: string; section: string; line: string }

/** Sections whose text has every word of the query, best first (more occurrences, then a heading hit). One line of context each. */
export function searchDocs(query: string, limit = 8): DocHit[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const scored: { hit: DocHit; score: number }[] = [];
  for (const s of docSources()) {
    const text = s.text();
    const lines = text.split('\n');
    const secs = sectionsOf(text);
    // A document with no headings is one section.
    const parts = secs.length ? secs : [{ title: s.title, slug: '', level: 1, from: 0, to: lines.length }];
    for (const sec of parts) {
      const body = lines.slice(sec.from, sec.to).join('\n').toLowerCase();
      if (!words.every((w) => body.includes(w) || `${s.id} ${s.title}`.toLowerCase().includes(w))) continue;
      const count = words.reduce((n, w) => n + body.split(w).length - 1, 0);
      const bonus = words.some((w) => sec.title.toLowerCase().includes(w)) ? 5 : 0;
      const line = lines.slice(sec.from, sec.to).find((l, i) => i > 0 && words.some((w) => l.toLowerCase().includes(w))) ?? lines[sec.from] ?? '';
      scored.push({ score: count + bonus + (s.kind === 'api' ? -3 : 0), hit: { id: s.id, section: sec.slug, line: line.trim().slice(0, 160) } });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.hit);
}
