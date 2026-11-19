// Set one JSON pointer inside a file's text by splicing, so everything the author arranged (indentation, key order,
// blank lines, inline arrays, the final newline) stays exactly as it was. Only the value's own characters change.

interface Member { key?: string; keyStart: number; node: Node }
interface Node { type: 'object' | 'array' | 'scalar'; start: number; end: number; members: Member[] }

class Bad extends Error {}

/** A small span-keeping JSON parser. The input is trusted to be valid JSON (callers scan it first). */
function parse(text: string): Node {
  let i = 0;
  const ws = (): void => { while (i < text.length && ' \t\n\r'.includes(text[i] as string)) i++; };
  const str = (): string => {
    const s = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(s, i)) as string;
  };
  const value = (): Node => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{' || c === '[') {
      const type = c === '{' ? 'object' : 'array';
      const close = c === '{' ? '}' : ']';
      const members: Member[] = [];
      i++;
      ws();
      if (text[i] === close) { i++; return { type, start, end: i, members }; }
      for (;;) {
        ws();
        const keyStart = i;
        let key: string | undefined;
        if (type === 'object') { key = str(); ws(); i++; }
        const node = value();
        members.push({ ...(key !== undefined ? { key } : {}), keyStart, node });
        ws();
        if (text[i] === ',') { i++; continue; }
        i++;
        return { type, start, end: i, members };
      }
    }
    if (c === '"') { str(); return { type: 'scalar', start, end: i, members: [] }; }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
    if (!m) throw new Bad(`invalid JSON at offset ${i}`);
    i += m[0].length;
    return { type: 'scalar', start, end: i, members: [] };
  };
  return value();
}

const unescape = (s: string): string => s.replace(/~1/g, '/').replace(/~0/g, '~');
const escape = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');
export const pointerSegments = (pointer: string): string[] => (pointer === '' ? [] : pointer.slice(1).split('/').map(unescape));

/** The value at a pointer in parsed data, or undefined. */
export function valueAtPointer(root: unknown, pointer: string): unknown {
  let cur = root;
  for (const s of pointerSegments(pointer)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

const lineIndent = (text: string, at: number): string => {
  const from = text.lastIndexOf('\n', at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(from, at))![0];
};

function indentUnit(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return '  ';
  const ws = m[1]!;
  return ws.startsWith('\t') ? '\t' : ws;
}

const isContainer = (v: unknown): v is object => v !== null && typeof v === 'object';

function inline(v: unknown): string {
  if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(', ')}]` : '[]';
  if (isContainer(v)) {
    const e = Object.entries(v).filter(([, x]) => x !== undefined);
    return e.length ? `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(v);
}

function multi(v: unknown, base: string, unit: string, nl: string): string {
  if (!isContainer(v)) return JSON.stringify(v);
  const pad = base + unit;
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[${nl}${v.map((x) => pad + multi(x, pad, unit, nl)).join(`,${nl}`)}${nl}${base}]`;
  }
  const e = Object.entries(v).filter(([, x]) => x !== undefined);
  if (!e.length) return '{}';
  return `{${nl}${e.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${multi(x, pad, unit, nl)}`).join(`,${nl}`)}${nl}${base}}`;
}

/** Short and flat values stay on one line, like a person would write them; anything else is spread out. */
function render(v: unknown, base: string, unit: string, nl: string, keepInline?: boolean): string {
  if (!isContainer(v)) return JSON.stringify(v);
  const flat = inline(v);
  const nested = Object.values(v).some(isContainer);
  const oneLine = keepInline ?? (!nested && flat.length <= 60);
  return oneLine ? flat : multi(v, base, unit, nl);
}

export type EditResult = { ok: true; text: string } | { ok: false; message: string };

/**
 * Returns the text with `pointer` set to `value`. An existing value is replaced in place; a missing object key or an
 * array index one past the end is appended after the last member; missing parents are created as objects.
 */
export function setJsonPointer(text: string, pointer: string, value: unknown): EditResult {
  let root: Node;
  try { root = parse(text); } catch (e) { return { ok: false, message: (e as Error).message }; }
  if (value === undefined) return { ok: false, message: 'a JSON value cannot be undefined' };
  const segs = pointerSegments(pointer);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const unit = indentUnit(text);
  const splice = (from: number, to: number, s: string): EditResult => ({ ok: true, text: text.slice(0, from) + s + text.slice(to) });

  let node = root;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const where = segs.slice(0, i).length ? `/${segs.slice(0, i).map(escape).join('/')}` : 'the file root';
    if (node.type === 'scalar') return { ok: false, message: `${where} is not an object or array, so ${seg} cannot be set inside it` };

    let child: Member | undefined;
    if (node.type === 'object') {
      child = node.members.find((m) => m.key === seg);
    } else {
      if (!/^(0|[1-9]\d*)$|^-$/.test(seg)) return { ok: false, message: `${seg} is not an array index (at ${where})` };
      const idx = seg === '-' ? node.members.length : Number(seg);
      if (idx > node.members.length) return { ok: false, message: `index ${idx} is past the end of the array at ${where} (length ${node.members.length})` };
      child = node.members[idx];
    }
    if (child) { node = child.node; continue; }

    // Missing: the rest of the path becomes new objects, appended after the last member.
    let built: unknown = value;
    for (let k = segs.length - 1; k > i; k--) built = { [segs[k]!]: built };
    const keyText = node.type === 'object' ? `${JSON.stringify(seg)}: ` : '';
    const nodeIndent = lineIndent(text, node.start);
    const last = node.members[node.members.length - 1];
    if (!last) {
      const inner = nodeIndent + unit;
      const [open, close] = node.type === 'object' ? ['{', '}'] : ['[', ']'];
      return splice(node.start, node.end, `${open}${nl}${inner}${keyText}${render(built, inner, unit, nl)}${nl}${nodeIndent}${close}`);
    }
    const first = node.members[0]!;
    if (text.slice(node.start, first.keyStart).includes('\n')) {
      const memberIndent = lineIndent(text, first.keyStart);
      return splice(last.node.end, last.node.end, `,${nl}${memberIndent}${keyText}${render(built, memberIndent, unit, nl)}`);
    }
    return splice(last.node.end, last.node.end, `, ${keyText}${inline(built)}`);
  }

  // Replace in place; a container that was written on one line stays on one line.
  const old = text.slice(node.start, node.end);
  const wasInline = node.type !== 'scalar' ? !old.includes('\n') : undefined;
  return splice(node.start, node.end, render(value, lineIndent(text, node.start), unit, nl, wasInline));
}
