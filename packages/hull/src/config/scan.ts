// A small strict JSON parser that remembers where every value and key starts, so a problem at a JSON pointer can be
// given a line and column. Error positions are 1-based; columns count UTF-16 units.

export interface Pos { line: number; col: number }

export type Scanned =
  | { ok: true; value: unknown; locate(pointer: string, prefer?: 'value' | 'key'): Pos }
  | { ok: false; message: string; line: number; col: number };

class Fail extends Error {
  constructor(message: string, readonly offset: number) { super(message); }
}

const escapeKey = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');

export function scanJson(text: string): Scanned {
  const values = new Map<string, number>();
  const keys = new Map<string, number>();
  let i = 0;

  const ws = (): void => { while (i < text.length && ' \t\n\r'.includes(text[i] as string)) i++; };
  const found = (): string => (i >= text.length ? 'the end of the file' : `'${text[i]}'`);

  const value = (ptr: string): unknown => {
    ws();
    values.set(ptr, i);
    const c = text[i];
    if (c === '{') return object(ptr);
    if (c === '[') return array(ptr);
    if (c === '"') return string();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (m) { i += m[0].length; return Number(m[0]); }
    throw new Fail(`expected a value but found ${found()}`, i);
  };

  const string = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      const ch = text.charCodeAt(i);
      if (ch < 0x20) throw new Fail('a string cannot contain a line break', i);
      i += text[i] === '\\' ? 2 : 1;
    }
    if (i >= text.length) throw new Fail('the string is not closed', start);
    i++;
    try { return JSON.parse(text.slice(start, i)) as string; } catch { throw new Fail('the string has a bad escape', start); }
  };

  const object = (ptr: string): unknown => {
    const out: Record<string, unknown> = {};
    i++;
    ws();
    if (text[i] === '}') { i++; return out; }
    for (;;) {
      ws();
      if (text[i] !== '"') throw new Fail(`expected a property name but found ${found()}`, i);
      const keyAt = i;
      const key = string();
      const child = `${ptr}/${escapeKey(key)}`;
      keys.set(child, keyAt);
      ws();
      if (text[i] !== ':') throw new Fail(`expected ':' after the property name but found ${found()}`, i);
      i++;
      const v = value(child);
      Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return out; }
      throw new Fail(`expected ',' or '}' but found ${found()}`, i);
    }
  };

  const array = (ptr: string): unknown => {
    const out: unknown[] = [];
    i++;
    ws();
    if (text[i] === ']') { i++; return out; }
    for (;;) {
      out.push(value(`${ptr}/${out.length}`));
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return out; }
      throw new Fail(`expected ',' or ']' but found ${found()}`, i);
    }
  };

  const posOf = (offset: number): Pos => {
    let line = 1;
    let lineStart = 0;
    for (let k = 0; k < offset && k < text.length; k++) {
      if (text[k] === '\n') { line++; lineStart = k + 1; }
    }
    return { line, col: offset - lineStart + 1 };
  };

  try {
    const v = value('');
    ws();
    if (i < text.length) throw new Fail(`unexpected ${found()} after the end of the value`, i);
    return {
      ok: true,
      value: v,
      // Walks up to the nearest pointer that exists, so a missing field points at its parent object.
      locate(pointer, prefer = 'value') {
        let p = pointer;
        for (;;) {
          const at = (prefer === 'key' ? keys.get(p) : undefined) ?? values.get(p);
          if (at !== undefined) return posOf(at);
          if (p === '') return { line: 1, col: 1 };
          p = p.slice(0, p.lastIndexOf('/'));
        }
      },
    };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, message: e.message, ...posOf(e.offset) };
    throw e;
  }
}
