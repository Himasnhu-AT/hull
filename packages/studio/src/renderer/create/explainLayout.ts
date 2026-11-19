// A flow drawing's layout: layers by distance from the roots, left to right. No React, so it is tested in Node.
// A root is a node nothing points to (the first node when every node is pointed to). Each node sits one layer after the
// nearest root that reaches it; nodes nothing reaches go in a last layer. An edge that goes back (or sideways) in the layers
// is drawn as an arc over the top, so loops stay readable.

export interface FlowIn { nodes: { id: string; text: string; kind?: 'step' | 'ask' | 'end' }[]; edges: { from: string; to: string; label?: string }[] }
export interface LaidNode { id: string; lines: string[]; kind: 'step' | 'ask' | 'end'; layer: number; x: number; y: number; w: number; h: number }
export interface LaidEdge { from: string; to: string; label?: string; back: boolean; d: string; lx: number; ly: number }
export interface FlowLayout { nodes: LaidNode[]; edges: LaidEdge[]; width: number; height: number }

export const NODE_W = 148;
export const NODE_H = 46;
const GAP_X = 56;
const GAP_Y = 22;
const PAD = 16;
const ARC = 30;
const WRAP = 22;

/** Words wrapped to lines of at most `max` characters, at most three lines (the last one cut with an ellipsis). */
export function wrap(text: string, max = WRAP): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur && (cur + ' ' + w).length > max) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > 3) { const keep = lines.slice(0, 3); keep[2] = keep[2]!.slice(0, Math.max(1, max - 1)) + '…'; return keep; }
  return lines.length ? lines : [''];
}

/** The layer of each node: breadth-first from the roots. */
export function layers(flow: FlowIn): Map<string, number> {
  const ids = new Set(flow.nodes.map((n) => n.id));
  const edges = flow.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const pointed = new Set(edges.map((e) => e.to));
  let roots = flow.nodes.filter((n) => !pointed.has(n.id)).map((n) => n.id);
  if (roots.length === 0 && flow.nodes[0]) roots = [flow.nodes[0].id];
  const layer = new Map<string, number>();
  let frontier = roots;
  for (const r of roots) layer.set(r, 0);
  while (frontier.length > 0) {
    const nextF: string[] = [];
    for (const id of frontier) for (const e of edges) if (e.from === id && !layer.has(e.to)) { layer.set(e.to, layer.get(id)! + 1); nextF.push(e.to); }
    frontier = nextF;
  }
  const last = Math.max(-1, ...layer.values()) + 1;
  for (const n of flow.nodes) if (!layer.has(n.id)) layer.set(n.id, last);
  return layer;
}

export function layoutFlow(flow: FlowIn): FlowLayout {
  const layer = layers(flow);
  const cols: string[][] = [];
  for (const n of flow.nodes) { const l = layer.get(n.id)!; (cols[l] ??= []).push(n.id); }
  const tallest = Math.max(1, ...cols.map((c) => (c ? c.length : 0)));
  const colH = tallest * NODE_H + (tallest - 1) * GAP_Y;
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, l) => {
    if (!col) return;
    const h = col.length * NODE_H + (col.length - 1) * GAP_Y;
    col.forEach((id, i) => pos.set(id, { x: PAD + l * (NODE_W + GAP_X), y: PAD + ARC + (colH - h) / 2 + i * (NODE_H + GAP_Y) }));
  });
  const nodes: LaidNode[] = flow.nodes.map((n) => ({ id: n.id, lines: wrap(n.text), kind: n.kind ?? 'step', layer: layer.get(n.id)!, ...pos.get(n.id)!, w: NODE_W, h: NODE_H }));
  const at = new Map(nodes.map((n) => [n.id, n] as const));
  const edges: LaidEdge[] = [];
  for (const e of flow.edges) {
    const a = at.get(e.from), b = at.get(e.to);
    if (!a || !b) continue;
    const back = b.layer <= a.layer;
    if (!back) {
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
      const mx = (x1 + x2) / 2;
      edges.push({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}), back, d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`, lx: mx, ly: (y1 + y2) / 2 - 5 });
    } else {
      // Over the top of both nodes, from the top middle of one to the top middle of the other.
      const x1 = a.x + a.w / 2, y1 = a.y, x2 = b.x + b.w / 2, y2 = b.y;
      const top = Math.min(y1, y2) - ARC;
      edges.push({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}), back, d: `M${x1} ${y1} C${x1} ${top} ${x2} ${top} ${x2} ${y2}`, lx: (x1 + x2) / 2, ly: top + 4 });
    }
  }
  const width = PAD * 2 + cols.length * NODE_W + Math.max(0, cols.length - 1) * GAP_X;
  const height = PAD * 2 + ARC + colH;
  return { nodes, edges, width, height };
}
