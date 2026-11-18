// Finds `tunables('block', { key: num(1.2, { ... }) })` in a source file with the TypeScript parser, reports where each
// literal is, and rewrites exactly those characters. Only literals that are the first argument of num, bool, color,
// vec, choice, range or curve directly inside a tunables call are ever touched (ARCHITECTURE section 4).
import ts from 'typescript6';

export type TunableKind = 'num' | 'bool' | 'color' | 'vec' | 'choice' | 'range' | 'curve';
const kinds: ReadonlySet<string> = new Set(['num', 'bool', 'color', 'vec', 'choice', 'range', 'curve']);

export interface FoundTunable {
  block: string;
  key: string;
  kind: TunableKind;
  value: unknown;
  opts: Record<string, unknown>;
  /** The literal's first character (1-based). */
  line: number;
  col: number;
  /** The literal's character span in the source text. */
  start: number;
  end: number;
  /** For vec and range: the span of each element, so a rewrite keeps comments between them. */
  elements?: { start: number; end: number }[];
  quote: "'" | '"' | '`';
  /** True when every part of the call was read statically (needed to compile the block to constants). */
  literal: boolean;
}

export interface FoundBlock { block: string; start: number; end: number; tunables: FoundTunable[]; complete: boolean }

const NO = Symbol('not a literal');

/** The value of a literal expression, or NO when it is not one this module understands. */
function literalValue(n: ts.Expression): unknown {
  if (ts.isParenthesizedExpression(n)) return literalValue(n.expression);
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (ts.isPrefixUnaryExpression(n) && n.operand.kind === ts.SyntaxKind.NumericLiteral) {
    const v = Number((n.operand as ts.NumericLiteral).text);
    if (n.operator === ts.SyntaxKind.MinusToken) return -v;
    if (n.operator === ts.SyntaxKind.PlusToken) return v;
    return NO;
  }
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isArrayLiteralExpression(n)) {
    const out: unknown[] = [];
    for (const e of n.elements) {
      const v = ts.isSpreadElement(e) ? NO : literalValue(e);
      if (v === NO) return NO;
      out.push(v);
    }
    return out;
  }
  if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) return literalValue(n.expression);
  return NO;
}

function objectValue(n: ts.Expression | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!n || !ts.isObjectLiteralExpression(n)) return out;
  for (const p of n.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
    if (name === undefined) continue;
    const v = literalValue(p.initializer);
    if (v !== NO) out[name] = v;
  }
  return out;
}

const calleeName = (c: ts.CallExpression): string | undefined => (ts.isIdentifier(c.expression) ? c.expression.text : undefined);

/** Every tunables block in a file. Parse errors are not reported here; `parseErrors` does that. */
export function findTunables(file: string, text: string): FoundBlock[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const blocks: FoundBlock[] = [];
  const posOf = (offset: number): { line: number; col: number } => {
    const p = sf.getLineAndCharacterOfPosition(offset);
    return { line: p.line + 1, col: p.character + 1 };
  };

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && calleeName(n) === 'tunables' && n.arguments.length === 2) {
      const nameArg = n.arguments[0]!;
      const spec = n.arguments[1]!;
      if ((ts.isStringLiteral(nameArg) || ts.isNoSubstitutionTemplateLiteral(nameArg)) && ts.isObjectLiteralExpression(spec)) {
        const block: FoundBlock = { block: nameArg.text, start: n.getStart(sf), end: n.end, tunables: [], complete: true };
        for (const p of spec.properties) {
          const t = ts.isPropertyAssignment(p) ? tunableOf(nameArg.text, p) : undefined;
          if (t) block.tunables.push(t); else block.complete = false;
        }
        blocks.push(block);
      }
    }
    ts.forEachChild(n, visit);
  };

  const tunableOf = (block: string, p: ts.PropertyAssignment): FoundTunable | undefined => {
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
    const call = p.initializer;
    if (key === undefined || !ts.isCallExpression(call)) return undefined;
    const kind = calleeName(call);
    if (!kind || !kinds.has(kind) || call.arguments.length === 0) return undefined;
    const lit = call.arguments[0]!;
    const value = literalValue(lit);
    if (value === NO) return undefined;
    const optsArg = kind === 'choice' ? call.arguments[2] : call.arguments[1];
    const opts = objectValue(optsArg);
    if (kind === 'choice') {
      const options = call.arguments[1] ? literalValue(call.arguments[1]) : NO;
      if (!Array.isArray(options)) return undefined;
      opts['options'] = options;
    }
    const start = lit.getStart(sf);
    let inner = lit;
    while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner)) inner = inner.expression;
    const elements = ts.isArrayLiteralExpression(inner) && (kind === 'vec' || kind === 'range')
      ? inner.elements.map((e) => ({ start: e.getStart(sf), end: e.end }))
      : undefined;
    const quote = (ts.isStringLiteral(inner) ? text[inner.getStart(sf)] : "'") as "'" | '"' | '`';
    return {
      block, key, kind: kind as TunableKind, value, opts, ...posOf(start), start, end: lit.end,
      ...(elements ? { elements } : {}), quote, literal: true,
    };
  };

  visit(sf);
  return blocks;
}

/** Syntax errors in a file, as sentences with a place. Empty when it parses. */
export function parseErrors(file: string, text: string): { line: number; col: number; message: string }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const diags = (sf as unknown as { parseDiagnostics: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  return diags.map((d) => {
    const p = sf.getLineAndCharacterOfPosition(d.start);
    return { line: p.line + 1, col: p.character + 1, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') };
  });
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A plain sentence when `v` is not allowed for this tunable, otherwise null. Mirrors the runtime's own check. */
export function whyNot(t: Pick<FoundTunable, 'kind' | 'key' | 'opts'>, v: unknown): string | null {
  const { min, max } = t.opts as { min?: number; max?: number };
  const bounds = (n: number): string | null => {
    if (min !== undefined && n < min) return `${t.key} must be at least ${min}, got ${n}`;
    if (max !== undefined && n > max) return `${t.key} must be at most ${max}, got ${n}`;
    return null;
  };
  switch (t.kind) {
    case 'num': return isNum(v) ? bounds(v) : `${t.key} must be a number, got ${JSON.stringify(v)}`;
    case 'bool': return typeof v === 'boolean' ? null : `${t.key} must be true or false, got ${JSON.stringify(v)}`;
    case 'color': return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? null : `${t.key} must be a colour like #rrggbb, got ${JSON.stringify(v)}`;
    case 'choice': {
      const options = (t.opts['options'] ?? []) as string[];
      return typeof v === 'string' && options.includes(v) ? null : `${t.key} must be one of ${options.join(', ')}, got ${JSON.stringify(v)}`;
    }
    case 'vec': {
      if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) return `${t.key} must be three numbers [x, y, z], got ${JSON.stringify(v)}`;
      for (const n of v as number[]) { const r = bounds(n); if (r) return r; }
      return null;
    }
    case 'range': {
      if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum)) return `${t.key} must be two numbers [min, max], got ${JSON.stringify(v)}`;
      const [lo, hi] = v as [number, number];
      if (lo > hi) return `${t.key} must have min no larger than max, got [${lo}, ${hi}]`;
      return bounds(lo) ?? bounds(hi);
    }
    case 'curve': {
      if (!Array.isArray(v) || v.length === 0) return `${t.key} must be a list of [t, value] points`;
      let last = 0;
      for (const p of v as unknown[]) {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(isNum)) return `${t.key} points must be [t, value] numbers, got ${JSON.stringify(p)}`;
        const x = p[0] as number;
        if (x < 0 || x > 1) return `${t.key} point t must be between 0 and 1, got ${x}`;
        if (x < last) return `${t.key} points must be in order of t, got ${x} after ${last}`;
        last = x;
      }
      return null;
    }
  }
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const numText = (n: number): string => (Object.is(n, -0) ? '0' : String(n));

function literalText(t: FoundTunable, v: unknown): string {
  switch (t.kind) {
    case 'num': return numText(v as number);
    case 'bool': return String(v);
    case 'color':
    case 'choice': {
      const q = t.quote === '`' ? "'" : t.quote;
      const s = (v as string).replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`);
      return `${q}${s}${q}`;
    }
    case 'vec':
    case 'range': return `[${(v as number[]).map(numText).join(', ')}]`;
    case 'curve': return `[${(v as number[][]).map((p) => `[${p.map(numText).join(', ')}]`).join(', ')}]`;
  }
}

export type RewriteResult = { ok: true; text: string; line: number; col: number } | { ok: false; message: string; line?: number; col?: number };

/**
 * Sets one tunable's literal. The new value is checked against the tunable's own limits, the text is spliced at the
 * literal's span (vec and range element by element, so comments between elements survive), and the result is parsed
 * again: it must have no syntax errors and must read back as exactly the value that was asked for.
 */
export function rewriteTunable(file: string, text: string, block: string, key: string, value: unknown): RewriteResult {
  const found = findTunables(file, text).filter((b) => b.block === block);
  if (found.length === 0) return { ok: false, message: `there is no tunables block "${block}" in ${file}` };
  const t = found[0]!.tunables.find((x) => x.key === key);
  if (!t) return { ok: false, message: `${file}: block "${block}" has no literal tunable "${key}"` };
  const bad = whyNot(t, value);
  if (bad) return { ok: false, message: bad, line: t.line, col: t.col };

  let out: string;
  if (t.elements && Array.isArray(value) && t.elements.length === value.length) {
    out = text;
    for (let i = t.elements.length - 1; i >= 0; i--) {
      const e = t.elements[i]!;
      out = out.slice(0, e.start) + numText((value as number[])[i]!) + out.slice(e.end);
    }
  } else {
    out = text.slice(0, t.start) + literalText(t, value) + text.slice(t.end);
  }

  const errs = parseErrors(file, out);
  if (errs.length) return { ok: false, message: `the rewrite would break ${file}: ${errs[0]!.message}`, line: errs[0]!.line, col: errs[0]!.col };
  const again = findTunables(file, out).filter((b) => b.block === block)[0]?.tunables.find((x) => x.key === key);
  if (!again || !sameValue(again.value, value)) return { ok: false, message: `the rewrite of ${block}.${key} did not read back as ${JSON.stringify(value)}`, line: t.line, col: t.col };
  return { ok: true, text: out, line: again.line, col: again.col };
}

/** For builds: replaces each fully literal tunables block with a frozen object of its values. */
export function compileTunables(file: string, text: string): string | null {
  const blocks = findTunables(file, text).filter((b) => b.complete);
  if (blocks.length === 0) return null;
  let out = text;
  for (const b of [...blocks].sort((x, y) => y.start - x.start)) {
    const body = b.tunables.map((t) => `${JSON.stringify(t.key)}: ${JSON.stringify(t.value)}`).join(', ');
    out = `${out.slice(0, b.start)}Object.freeze({ ${body} })${out.slice(b.end)}`;
  }
  return out;
}
