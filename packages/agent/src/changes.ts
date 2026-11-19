// What a run changed, read back from the history: the pieces (review keys) and one line per value, for the "change" card of a
// fix and for the pieces of a build stage. Pure parsing here; the calls into the tools are historySince, historyHead, configKinds.
import type { HullTools } from './hullTools.ts';

export interface HistoryItem { id: string; by?: string; message?: string; details?: string[]; kind?: string }
export interface ChangeLine { label: string; from: string; to: string }
export interface Parsed {
  /** Review key of the piece this detail is about: a config id ('sound/thud'), 'tunables:<block>', or undefined for code and the brief. */
  piece?: string;
  line: ChangeLine;
}

/**
 * One line of a history change's details. The history writes them as:
 *   "tuning/arena: crateCount 14 → 20"   a config value
 *   "player.runSpeed 7 → 8"              a tunable
 *   "src/x.ts added (1 lines)"           code (or "changed (+3 -1 lines)")
 *   "GAME.md added (5 lines)"            the brief
 * kinds are the config kinds of the project, to tell "sound/thud" from "src/x.ts".
 */
export function parseDetail(detail: string, kinds: ReadonlySet<string>): Parsed | undefined {
  const cfg = /^([a-z0-9-]+\/[^:\s]+): (\S+) (.*?) → (.*)$/.exec(detail);
  if (cfg && kinds.has(cfg[1]!.split('/')[0]!)) return { piece: cfg[1]!, line: { label: cfg[2]!, from: cfg[3]!, to: cfg[4]! } };
  const cfgWhole = /^([a-z0-9-]+\/[^:\s]+):? (added|created|removed|deleted)\b(.*)$/.exec(detail);
  if (cfgWhole && kinds.has(cfgWhole[1]!.split('/')[0]!)) return { piece: cfgWhole[1]!, line: { label: cfgWhole[1]!, from: '', to: (cfgWhole[2]! + cfgWhole[3]!).trim() } };
  const tun = /^(\w+)\.(\w+) (.*?) → (.*)$/.exec(detail);
  if (tun) return { piece: 'tunables:' + tun[1], line: { label: tun[2]!, from: tun[3]!, to: tun[4]! } };
  const code = /^(src\/\S+) (.*)$/.exec(detail);
  if (code) return { line: { label: code[1]!, from: '', to: codeSummary(code[2]!) } };
  return undefined;
}

/** "added (1 lines)" or "changed (+3 -1 lines)" to "+N -M lines". */
function codeSummary(rest: string): string {
  const pm = /\+(\d+) -(\d+)/.exec(rest);
  if (pm) return '+' + pm[1] + ' -' + pm[2] + ' lines';
  const n = /\((\d+) lines?\)/.exec(rest);
  if (n) return /removed|deleted/.test(rest) ? '-' + n[1] + ' lines' : '+' + n[1] + ' lines';
  return rest;
}

/** The history changes newer than base (newest first); with no base, everything listed. */
export async function historySince(tools: HullTools, base: string | undefined, limit = 100): Promise<HistoryItem[]> {
  const r = await tools.call('history.list', { limit });
  const items = ((r.value as { items?: HistoryItem[] } | undefined)?.items ?? []).filter((i) => i.kind !== 'start');
  if (!base) return items;
  const at = items.findIndex((i) => i.id === base);
  return at < 0 ? items : items.slice(0, at);
}

export async function historyHead(tools: HullTools): Promise<string | undefined> {
  const r = await tools.call('history.list', { limit: 1 });
  return ((r.value as { items?: HistoryItem[] } | undefined)?.items ?? [])[0]?.id;
}

export async function configKinds(tools: HullTools): Promise<Set<string>> {
  const r = await tools.call('library.list', {});
  return new Set(((r.value as { items?: { kind: string }[] } | undefined)?.items ?? []).map((i) => i.kind).filter((k) => k !== 'game'));
}

export interface Changed { pieces: string[]; lines: ChangeLine[]; newest?: string }

/** Pieces and value lines in the changes after base, in the order they were made, each piece once. */
export function summarize(items: readonly HistoryItem[], kinds: ReadonlySet<string>): Changed {
  const pieces: string[] = [];
  const lines: ChangeLine[] = [];
  for (const item of [...items].reverse()) {
    for (const d of item.details ?? []) {
      const p = parseDetail(d, kinds);
      if (!p) continue;
      if (p.piece && !pieces.includes(p.piece)) pieces.push(p.piece);
      lines.push(p.line);
    }
  }
  return { pieces, lines, ...(items[0] ? { newest: items[0].id } : {}) };
}

/** A card title in plain words: the first sentence of what the model said last, if short; else "Changed <piece>". */
export function plainTitle(finalText: string, piece: string): string {
  const first = finalText.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '';
  const t = first.replace(/[.!?]+$/, '').trim();
  return t && t.length <= 90 ? t : 'Changed ' + piece;
}
