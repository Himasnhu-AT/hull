import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainProblems } from '../src/schema/check.ts';
import { emitSchemas } from '../src/schema/index.ts';

const dir = join(import.meta.dirname, '..', 'src', 'schema', 'examples', 'explain');
const examples = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(join(dir, f), 'utf8'))] as const);

describe('explain schema', () => {
  it('has an example of each body type, and every example is valid', () => {
    expect(examples.map(([, d]) => d.body.type).sort()).toEqual(['flow', 'image', 'map', 'table']);
    for (const [f, d] of examples) expect(explainProblems(d), f).toEqual([]);
  });
  it('is published to /schemas as explain.schema.json', () => {
    expect(Object.keys(emitSchemas())).toContain('explain.schema.json');
  });
  const flow = examples.find(([, d]) => d.body.type === 'flow')![1];
  it('rejects an edge that names a missing node, at the edge', () => {
    const bad = { ...flow, body: { ...flow.body, edges: [...flow.body.edges, { from: 'idle', to: 'nowhere' }] } };
    const p = explainProblems(bad);
    expect(p).toHaveLength(1);
    expect(p[0]!.pointer).toBe(`/body/edges/${flow.body.edges.length}/to`);
    expect(p[0]!.message).toContain('"nowhere"');
  });
  it('rejects a repeated node id, an unknown stage, a bad id and a picture that is not a data URL', () => {
    expect(explainProblems({ ...flow, body: { ...flow.body, nodes: [...flow.body.nodes, { id: 'idle', text: 'again' }] } }).map((p) => p.pointer)).toEqual([`/body/nodes/${flow.body.nodes.length}/id`]);
    expect(explainProblems({ ...flow, stage: 'combat' }).length).toBeGreaterThan(0);
    expect(explainProblems({ ...flow, id: 'Not Valid' }).length).toBeGreaterThan(0);
    const img = examples.find(([, d]) => d.body.type === 'image')![1];
    expect(explainProblems({ ...img, body: { ...img.body, image: 'http://example.com/a.png' } }).length).toBeGreaterThan(0);
  });
  it('rejects fields it does not know', () => {
    expect(explainProblems({ ...flow, mood: 'happy' }).length).toBeGreaterThan(0);
  });
});
