// What an agent reads to learn Hull without leaving its tools (docs/IDEA-TO-PLAY.md section 4.2): every kit's README, the
// kit catalogue, the guides, and one generated summary of each public entry of the hull package. Everything is found from
// the hull package's own location, never from the project's root, so a project made anywhere that depends on hull
// gets the same documents.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import ts from 'typescript6';
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
  const kits = join(hull, 'src', 'kits');
  if (existsSync(join(kits, 'README.md'))) out.push({ id: 'kit/index', title: titleOf(read(join(kits, 'README.md')), 'Kits'), kind: 'kit', text: () => read(join(kits, 'README.md')) });
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
  for (const e of apiEntries(hull)) out.push({ id: `api/${e.name}`, title: `API: ${e.import}`, kind: 'api', text: () => apiText(hull, e) });
  return out;
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
function apiText(hull: string, entry: Entry): string {
  let all = cache.get(hull);
  if (!all) { all = buildApi(hull); cache.set(hull, all); }
  return all.get(entry.name) ?? `# ${entry.import}\n\n(no summary)\n`;
}

const oneLine = (s: string, max: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

function buildApi(hull: string): Map<string, string> {
  const entries = apiEntries(hull);
  const program = ts.createProgram(entries.map((e) => e.file), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, strict: true, types: [],
  });
  const checker = program.getTypeChecker();
  const out = new Map<string, string>();
  for (const e of entries) {
    const sf = program.getSourceFile(e.file);
    const lines: string[] = [`# API: ${e.import}`, '', `\`import { ... } from '${e.import}'\`. Generated from the code; names and signatures only (read the module's README or the source for more).`, ''];
    const mod = sf && checker.getSymbolAtLocation(sf);
    const exports = mod ? checker.getExportsOfModule(mod).sort((a, b) => a.name.localeCompare(b.name)) : [];
    for (const sym of exports) {
      const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
      const decl = target.declarations?.[0];
      lines.push(`- ${signature(checker, sym.name, target, decl)}`);
    }
    out.set(e.name, lines.join('\n') + '\n');
  }
  return out;
}

function signature(checker: ts.TypeChecker, name: string, sym: ts.Symbol, decl: ts.Declaration | undefined): string {
  const F = ts.SymbolFlags;
  let sig: string;
  try {
    if (sym.flags & F.Class) {
      const t = checker.getDeclaredTypeOfSymbol(sym);
      const base = checker.getBaseTypes(t as ts.InterfaceType).map((b) => checker.typeToString(b)).join(', ');
      sig = `class ${name}${base ? ` extends ${base}` : ''}`;
    } else if (sym.flags & F.Interface) sig = `interface ${name}`;
    else if (sym.flags & F.TypeAlias) {
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
  const doc = ts.displayPartsToString(sym.getDocumentationComment(checker)).split(/\n|\. /)[0] ?? '';
  return oneLine(sig, 220) + (doc ? ` // ${oneLine(doc, 120)}` : '');
}

// ---- The methods ----------------------------------------------------------------------------------------------------------------

export function listDocs(): DocItem[] {
  return docSources().map((s) => ({ id: s.id, title: s.title, kind: s.kind, bytes: bytesOf(s.text()) }));
}

export function readDoc(id: string): { id: string; title: string; text: string } | null {
  const s = docSources().find((x) => x.id === id);
  return s ? { id: s.id, title: s.title, text: s.text() } : null;
}
