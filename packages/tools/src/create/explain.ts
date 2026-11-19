// Explain documents: .hull/explain/<id>.json, one drawing per piece the person cannot judge by looking or listening
// (docs/IDEA-TO-PLAY.md section 2). A write is validated against hull's explain schema before it is kept, and the file is
// replaced atomically. The document carries its author and time; the review store hashes it under 'explain:<id>'.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Problem } from 'hull';
import { explainProblems } from 'hull/schema/check';
import type { Author, ExplainDoc } from 'hull/dev/protocol';

export const EXPLAIN_DIR = '.hull/explain';
export const EXPLAIN_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const fileOf = (id: string): string => `${EXPLAIN_DIR}/${id}.json`;

/** Everything wrong with a document, named by file#/pointer. An empty list means it can be kept. */
export function checkExplain(doc: unknown): Problem[] {
  const id = (doc as { id?: unknown } | null)?.id;
  const file = typeof id === 'string' && EXPLAIN_ID.test(id) ? fileOf(id) : `${EXPLAIN_DIR}/<id>.json`;
  return explainProblems(doc).map((p) => ({ file, pointer: p.pointer, rule: 'explain', message: p.message }));
}

/** Every stored document, by id. A file that does not parse or does not validate is skipped (list shows what is sound). */
export function listExplain(root: string): ExplainDoc[] {
  let names: string[];
  try { names = readdirSync(join(root, EXPLAIN_DIR)).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  const out: ExplainDoc[] = [];
  for (const n of names) {
    try {
      const v = JSON.parse(readFileSync(join(root, EXPLAIN_DIR, n), 'utf8')) as unknown;
      if (checkExplain(v).length === 0) out.push(v as ExplainDoc);
    } catch { /* unreadable: left out */ }
  }
  return out;
}

export function writeExplain(root: string, doc: ExplainDoc, by: Author): { ok: boolean; problems: Problem[] } {
  const problems = checkExplain(doc);
  if (problems.length) return { ok: false, problems };
  const kept: ExplainDoc = { ...doc, by, at: new Date().toISOString() };
  const dir = join(root, EXPLAIN_DIR);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${doc.id}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`);
  renameSync(tmp, join(dir, `${doc.id}.json`));
  return { ok: true, problems: [] };
}

/** The review hash of 'explain:<id>': the document without its author and time, so saving the same drawing again keeps its approval. Null when there is no such document. */
export function explainHash(root: string, id: string): string | null {
  if (!EXPLAIN_ID.test(id) || !existsSync(join(root, fileOf(id)))) return null;
  try {
    const { by: _by, at: _at, ...rest } = JSON.parse(readFileSync(join(root, fileOf(id)), 'utf8')) as Record<string, unknown>;
    return createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 6);
  } catch { return null; }
}
