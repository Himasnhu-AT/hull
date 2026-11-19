// Line-level helpers shared by the diff and the merge: a longest-common-subsequence match and a three-way merge of
// lines. Files in a game project are small, so a plain table is fast enough and easy to trust.

/** Pairs of equal lines (index in a -> index in b), in order, as a longest common subsequence. */
export function lcs(a: readonly string[], b: readonly string[]): Map<number, number> {
  const out = new Map<number, number>();
  // Common head and tail are matched directly; the table only covers what is left between them.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) { out.set(head, head); head++; }
  let ea = a.length;
  let eb = b.length;
  const tail: [number, number][] = [];
  while (ea > head && eb > head && a[ea - 1] === b[eb - 1]) { ea--; eb--; tail.push([ea, eb]); }
  const n = ea - head;
  const m = eb - head;
  if (n > 0 && m > 0) {
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = a[head + i] === b[head + j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) { out.set(head + i, head + j); i++; j++; }
      else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++;
      else j++;
    }
  }
  for (const [x, y] of tail.reverse()) out.set(x, y);
  return out;
}

export const splitLines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/** How many lines were added and removed going from a to b. */
export function lineStats(a: string, b: string): { added: number; removed: number } {
  const x = splitLines(a);
  const y = splitLines(b);
  const kept = lcs(x, y).size;
  return { added: y.length - kept, removed: x.length - kept };
}

export interface LineConflict {
  /** 1-based first line of the region in the merged output. */
  line: number;
  base: string[];
  ours: string[];
  theirs: string[];
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((l, i) => l === b[i]);

/**
 * Three-way merge by lines. Lines that both sides kept from the base anchor the merge; between two anchors a side that
 * did not change takes the other's version, and two different changes are a conflict (ours is kept in the output and the
 * conflict is listed, or taken from `pick` when the caller already decided).
 */
export function merge3Lines(
  base: readonly string[], ours: readonly string[], theirs: readonly string[],
  pick?: (c: LineConflict) => 'ours' | 'theirs' | undefined,
): { lines: string[]; conflicts: LineConflict[] } {
  const ma = lcs(base, ours);
  const mb = lcs(base, theirs);
  const anchors: number[] = [];
  for (let i = 0; i < base.length; i++) if (ma.has(i) && mb.has(i)) anchors.push(i);
  const lines: string[] = [];
  const conflicts: LineConflict[] = [];
  let pb = 0;
  let pa = 0;
  let pt = 0;
  const region = (eb: number, ea: number, et: number): void => {
    const b = base.slice(pb, eb);
    const o = ours.slice(pa, ea);
    const t = theirs.slice(pt, et);
    if (same(o, t) || same(b, t)) lines.push(...o);
    else if (same(b, o)) lines.push(...t);
    else {
      const c: LineConflict = { line: lines.length + 1, base: b, ours: o, theirs: t };
      const choice = pick?.(c);
      if (choice === undefined) conflicts.push(c);
      lines.push(...(choice === 'theirs' ? t : o));
    }
  };
  for (const i of anchors) {
    const ai = ma.get(i)!;
    const ti = mb.get(i)!;
    region(i, ai, ti);
    lines.push(base[i]!);
    pb = i + 1; pa = ai + 1; pt = ti + 1;
  }
  region(base.length, ours.length, theirs.length);
  return { lines, conflicts };
}
