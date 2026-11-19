import { describe, expect, it } from 'vitest';
import { layers, layoutFlow, NODE_W, wrap } from './explainLayout.ts';

const raider = {
  nodes: [{ id: 'watch', text: 'Watch the player' }, { id: 'near', text: 'Is the player close?', kind: 'ask' as const }, { id: 'tell', text: 'Raise the blade' }, { id: 'cut', text: 'Cut' }, { id: 'rest', text: 'Recover', kind: 'end' as const }],
  edges: [{ from: 'watch', to: 'near' }, { from: 'near', to: 'tell', label: 'yes' }, { from: 'near', to: 'watch', label: 'no' }, { from: 'tell', to: 'cut' }, { from: 'cut', to: 'rest' }],
};

describe('explain flow layout', () => {
  it('puts each node one layer after the nearest root that reaches it', () => {
    const l = layers({ nodes: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }, { id: 'c', text: 'c' }, { id: 'd', text: 'd' }], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }] });
    expect([...l.entries()]).toEqual([['a', 0], ['b', 1], ['c', 1], ['d', 2]]);
  });

  it('a loop does not hang: the node that closes it is the first one when nothing is a root', () => {
    const l = layers({ nodes: [{ id: 'x', text: 'x' }, { id: 'y', text: 'y' }], edges: [{ from: 'x', to: 'y' }, { from: 'y', to: 'x' }] });
    expect(l.get('x')).toBe(0);
    expect(l.get('y')).toBe(1);
  });

  it('nodes nothing reaches are put in a last layer; edges to unknown nodes are dropped', () => {
    const f = layoutFlow({ nodes: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }, { id: 'lone', text: 'lone' }, { id: 'zz', text: 'zz' }], edges: [{ from: 'a', to: 'b' }, { from: 'zz', to: 'zz' }, { from: 'a', to: 'nope' }] });
    expect(f.edges.map((e) => e.to)).toEqual(['b', 'zz']);
    // lone is a root of its own (nothing points to it), so it sits in layer 0 with a and zz? zz points to itself, so it is not a root.
    expect(f.nodes.find((n) => n.id === 'lone')!.layer).toBe(0);
    expect(f.nodes.find((n) => n.id === 'zz')!.layer).toBe(2);
  });

  it('lays the raider loop out left to right with the "no" edge as an arc over the top', () => {
    const f = layoutFlow(raider);
    const x = (id: string): number => f.nodes.find((n) => n.id === id)!.x;
    expect(x('watch')).toBeLessThan(x('near'));
    expect(x('near')).toBeLessThan(x('tell'));
    expect(x('tell')).toBeLessThan(x('cut'));
    const no = f.edges.find((e) => e.label === 'no')!;
    expect(no.back).toBe(true);
    expect(f.edges.filter((e) => e.back)).toHaveLength(1);
    expect(f.width).toBeGreaterThanOrEqual(5 * NODE_W);
    expect(f.nodes.every((n) => n.x >= 0 && n.y >= 0 && n.x + n.w <= f.width && n.y + n.h <= f.height)).toBe(true);
  });

  it('wraps long text into at most three lines', () => {
    expect(wrap('Is the player close?')).toEqual(['Is the player close?']);
    const lines = wrap('The raider decides whether to cut, to wait, or to call another raider over to help it');
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.at(-1)!.endsWith('…')).toBe(true);
  });
});
