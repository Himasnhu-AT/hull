// A small JSON Schema checker for tool input: type, required, properties, additionalProperties, enum, const, oneOf, items.
// Written by hand so every front (MCP, the app, Hull's agent) answers a wrong call the same way, naming the tool and the field,
// and no dependency is needed. Anything else in a schema (description, x-ui, default) is ignored.

type Schema = Record<string, unknown>;

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const matches = (t: string, v: unknown): boolean => (t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);
const show = (v: unknown): string => { const s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 40 ? s.slice(0, 39) + '…' : s; };

/** The first problem with `value` against `schema` as a sentence about `at` (a field path), or null when it fits. */
function check(schema: unknown, value: unknown, at: string): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as Schema;
  const label = at || 'input';
  if ('const' in s && JSON.stringify(s['const']) !== JSON.stringify(value)) return `"${label}" must be ${show(s['const'])}`;
  if (Array.isArray(s['enum']) && !s['enum'].some((e) => JSON.stringify(e) === JSON.stringify(value))) return `"${label}" must be one of ${s['enum'].map(show).join(', ')} (got ${show(value)})`;
  const t = s['type'];
  if (t !== undefined) {
    const types = Array.isArray(t) ? (t as string[]) : [t as string];
    if (!types.some((x) => matches(x, value))) return `"${label}" must be ${types.join(' or ')} (got ${typeOf(value)})`;
  }
  if (Array.isArray(s['oneOf'])) {
    const branches = s['oneOf'] as unknown[];
    const fails = branches.map((b) => check(b, value, at));
    if (fails.every((f) => f !== null)) {
      // For an object with a discriminating const (op, kind...), the branch it names explains the failure better than "no branch".
      const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
      const named = obj ? branches.findIndex((b) => { const p = (b as Schema)['properties'] as Record<string, Schema> | undefined; return p && Object.entries(p).some(([k, d]) => d && 'const' in d && obj[k] === d['const']); }) : -1;
      if (named >= 0) return fails[named]!;
      const have = branches.map((b) => { const p = (b as Schema)['properties'] as Record<string, Schema> | undefined; const d = p && Object.values(p).find((x) => x && 'const' in x); return d ? show(d['const']) : null; }).filter(Boolean);
      return have.length ? `"${label}" matches none of the forms (${have.join(', ')})` : `"${label}" matches none of the allowed forms: ${fails[0]}`;
    }
  }
  if (s['type'] === 'object' || s['properties']) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const o = value as Record<string, unknown>;
    const props = (s['properties'] ?? {}) as Record<string, unknown>;
    const path = (k: string): string => (at ? `${at}.${k}` : k);
    // A misspelt field is the likelier mistake than a missing one, and it explains the missing one: name it first.
    if (s['additionalProperties'] === false) for (const k of Object.keys(o)) if (o[k] !== undefined && !(k in props)) return `unknown field "${path(k)}" (fields: ${Object.keys(props).join(', ') || 'none'})`;
    for (const k of (s['required'] as string[] | undefined) ?? []) if (o[k] === undefined) return `"${path(k)}" is required`;
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      if (k in props) { const e = check(props[k], v, path(k)); if (e) return e; }
      else if (s['additionalProperties'] === false) return `unknown field "${path(k)}" (fields: ${Object.keys(props).join(', ') || 'none'})`;
      else if (s['additionalProperties'] && typeof s['additionalProperties'] === 'object') { const e = check(s['additionalProperties'], v, path(k)); if (e) return e; }
    }
  }
  if (Array.isArray(value) && s['items']) {
    for (let i = 0; i < value.length; i++) { const e = check(s['items'], value[i], `${at}[${i}]`); if (e) return e; }
  }
  return null;
}

/** Throws `<tool>: <what is wrong>` when `input` does not fit `schema`. An undefined input counts as {}. */
export function validateInput(tool: string, schema: unknown, input: unknown): void {
  const e = check(schema, input ?? {}, '');
  if (e) throw new Error(`${tool}: ${e.replace(/^"input" /, 'input ')}`);
}
