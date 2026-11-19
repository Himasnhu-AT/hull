// Checking an explain document needs Ajv, which a game's ship build must not carry, so this lives apart from the schema
// (schema/index.ts, which the build does import) and is reached as 'hull/schema/check' (a project's tsconfig paths map hull/<folder>/<file> to src/<folder>/<file>.ts, so the name must be a real file).
import { validateAgainst } from '../config/validate.ts';
import { explainSchema } from './explain.ts';

/**
 * Everything wrong with an explain document, each at a JSON pointer: the schema's complaints first, then the one rule a
 * schema cannot state, that every edge of a flow names nodes the flow has (and no two nodes share an id).
 */
export function explainProblems(doc: unknown): { pointer: string; message: string }[] {
  const out: { pointer: string; message: string }[] = validateAgainst(explainSchema, doc).map(({ pointer, message }) => ({ pointer, message }));
  const body = (doc as { body?: { type?: unknown; nodes?: unknown; edges?: unknown } } | null)?.body;
  if (body?.type === 'flow' && Array.isArray(body.nodes) && Array.isArray(body.edges)) {
    const ids = new Set<string>();
    (body.nodes as { id?: unknown }[]).forEach((n, i) => {
      if (typeof n?.id !== 'string') return;
      if (ids.has(n.id)) out.push({ pointer: `/body/nodes/${i}/id`, message: `two nodes are called "${n.id}"; give each node its own id` });
      ids.add(n.id);
    });
    (body.edges as { from?: unknown; to?: unknown }[]).forEach((e, i) => {
      for (const end of ['from', 'to'] as const) {
        const v = e?.[end];
        if (typeof v === 'string' && !ids.has(v)) out.push({ pointer: `/body/edges/${i}/${end}`, message: `the edge goes ${end} "${v}", but the flow has no node with that id (nodes: ${[...ids].join(', ') || 'none'})` });
      }
    });
  }
  return out;
}
