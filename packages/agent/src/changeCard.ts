// The "change" card that ends a fix run: a title in plain words, the piece, one line per value, and the newest history change.
import type { UiBlock } from 'hull/dev/protocol';
import { historySince, plainTitle, summarize } from './changes.ts';
import type { HullTools } from './hullTools.ts';

export async function changeCard(tools: HullTools, base: string | undefined, kinds: ReadonlySet<string>, finalText: string, run: number): Promise<Extract<UiBlock, { kind: 'change' }> | undefined> {
  const items = await historySince(tools, base);
  const changed = summarize(items, kinds);
  if (!changed.lines.length) return undefined;
  const piece = changed.pieces[0] ?? changed.lines[0]!.label;
  return { id: 'change-' + run, kind: 'change', title: plainTitle(finalText, piece), piece, lines: changed.lines, ...(changed.newest ? { change: changed.newest } : {}) };
}
