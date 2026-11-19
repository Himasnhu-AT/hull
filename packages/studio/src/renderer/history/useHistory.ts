// The editor's view of history and experiments: the timeline, the experiments, and the actions on them. Everything comes
// from protocol calls and pushes (history.*, exp.*); nothing from disk.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Problem } from 'hull';
import type { ChangeDelta, ExpAdoptResult, ExpInfo, HistoryChange, MergeConflict } from 'hull/dev/protocol';
import type { RpcClient } from '../lib/rpc.ts';
import { isAi } from './plain.ts';

export interface Adopting { name: string; conflicts: MergeConflict[]; busy: boolean; error?: string }

export interface HistoryState {
  changes: HistoryChange[];
  exps: ExpInfo[];
  loaded: boolean;
  error: string | null;
  /** Authorship problems: AI changes over a value you set. */
  flags: Problem[];
  /** Ids of AI changes that overwrote something you set. */
  flagged: Map<string, Problem[]>;
  /** The deltas of a change, fetched once (history.diff). Undefined until it arrives. */
  /** The newest main-line change when the Studio first loaded: "what changed since I opened this". */
  openedId: string | null;
  deltasOf(id: string): ChangeDelta[] | undefined;
  ensureDeltas(id: string): void;
  restore(id: string): Promise<boolean>;
  checkpoint(name: string, id?: string): Promise<boolean>;
  startExp(name: string, from?: string): Promise<ExpInfo | null>;
  discard(name: string): Promise<void>;
  /** Starts an adopt; conflicts open the dialog (`adopting`), which finishes with `resolveAdopt`. */
  adopt(name: string): Promise<void>;
  adopting: Adopting | null;
  resolveAdopt(choice: Record<string, 'ours' | 'theirs'>): Promise<void>;
  cancelAdopt(): void;
}

const keyOf = (c: { target: string; path: string }): string => `${c.target}#${c.path}`;

/** Does this authorship problem belong to this delta? The message names `target#path` or `block.key`. */
export function problemMatches(p: Problem, by: string, d: ChangeDelta): boolean {
  if (p.rule !== 'authorship' || !p.message.startsWith(`${by} changed `)) return false;
  const name = d.kind === 'tunable' ? `${d.target.replace(/^tunables:/, '')}.${d.path}` : keyOf(d);
  return p.message.includes(`${name} from`) || p.message.includes(`${name}/`);
}

/** The starting point of "since I opened the Studio" survives a page reload of the same tab, as long as that change still exists. */
function rememberedOpen(changes: HistoryChange[]): string | null {
  const key = `hull.opened:${typeof location === 'undefined' ? '' : location.origin}`;
  try {
    const kept = sessionStorage.getItem(key);
    if (kept && changes.some((c) => c.id === kept && c.line === 'main')) return kept;
    const fresh = changes.find((x) => x.line === 'main')?.id ?? null;
    if (fresh) sessionStorage.setItem(key, fresh);
    return fresh;
  } catch { return changes.find((x) => x.line === 'main')?.id ?? null; }
}

export function useHistory(rpc: RpcClient, problems: Problem[], notify: (text: string, error?: boolean) => void): HistoryState {
  const [changes, setChanges] = useState<HistoryChange[]>([]);
  const [exps, setExps] = useState<ExpInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deltas, setDeltas] = useState<Map<string, ChangeDelta[]>>(() => new Map());
  const [adopting, setAdopting] = useState<Adopting | null>(null);
  const asked = useRef(new Set<string>());
  const [openedId, setOpenedId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    Promise.all([rpc.call('history.list', { limit: 400 }), rpc.call('exp.list', {})]).then(([c, e]) => { setChanges(c); setExps(e); setLoaded(true); setOpenedId((o) => o ?? rememberedOpen(c)); setError(null); }, (e: Error) => setError(e.message));
  }, [rpc]);
  // A burst of pushes is one reload.
  const soon = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(load, 120); }, [load]);

  useEffect(() => {
    const offs = [
      rpc.onStatus((s) => { if (s === 'open') load(); }),
      rpc.on('history.added', soon),
      rpc.on('exp.changed', soon),
    ];
    if (rpc.status === 'open') load();
    return () => { offs.forEach((o) => o()); if (timer.current) clearTimeout(timer.current); };
  }, [rpc, load, soon]);

  const ensureDeltas = useCallback((id: string) => {
    if (asked.current.has(id)) return;
    asked.current.add(id);
    rpc.call('history.diff', { to: id }).then((r) => setDeltas((m) => new Map(m).set(id, r.deltas)), () => asked.current.delete(id));
  }, [rpc]);
  const deltasOf = useCallback((id: string) => deltas.get(id), [deltas]);

  // AI changes are looked at once, so the ones that overwrote your values can be flagged in the list.
  useEffect(() => { for (const c of changes) if (isAi(c.by)) ensureDeltas(c.id); }, [changes, ensureDeltas]);

  const flags = useMemo(() => {
    // The server's `problems` state carries authorship problems and is pushed whenever history changes.
    return problems.filter((p) => p.rule === 'authorship');
  }, [problems]);
  const flagged = useMemo(() => {
    const out = new Map<string, Problem[]>();
    if (flags.length === 0) return out;
    for (const c of changes) {
      if (!isAi(c.by)) continue;
      const mine = (deltas.get(c.id) ?? []).flatMap((d) => flags.filter((p) => problemMatches(p, c.by, d)));
      if (mine.length > 0) out.set(c.id, mine);
    }
    return out;
  }, [changes, deltas, flags]);

  const fail = useCallback((what: string, e: unknown): void => { notify(`${what}: ${e instanceof Error ? e.message : String(e)}`, true); }, [notify]);

  const restore = useCallback(async (id: string) => {
    try {
      const r = await rpc.call('history.restore', { id, author: 'you' });
      if (!r.ok) { notify(`Could not restore: ${r.problems[0]?.message ?? 'the old state is not valid'}`, true); return false; }
      notify(`Restored. The project is back as it was at ${id.slice(0, 7)}; this is a new entry, so you can undo it.`);
      soon();
      return true;
    } catch (e) { fail('Could not restore', e); return false; }
  }, [rpc, notify, fail, soon]);

  const checkpoint = useCallback(async (name: string, id?: string) => {
    try { await rpc.call('history.checkpoint', { name, ...(id ? { id } : {}) }); notify(`Checkpoint "${name}" saved`); soon(); return true; } catch (e) { fail('Could not save the checkpoint', e); return false; }
  }, [rpc, notify, fail, soon]);

  const startExp = useCallback(async (name: string, from?: string) => {
    try { const e = await rpc.call('exp.start', { name, ...(from ? { from } : {}), author: 'you' }); notify(`Experiment "${name}" started`); soon(); return e; } catch (e) { fail('Could not start the experiment', e); return null; }
  }, [rpc, notify, fail, soon]);

  const discard = useCallback(async (name: string) => {
    try { await rpc.call('exp.discard', { name }); notify(`Experiment "${name}" closed. Its changes stay in the timeline.`); soon(); } catch (e) { fail('Could not discard', e); }
  }, [rpc, notify, fail, soon]);

  const finish = useCallback((name: string, r: ExpAdoptResult): void => {
    if (r.ok) { setAdopting(null); notify(`Adopted "${name}". It is still in the timeline.`); soon(); return; }
    if (r.conflicts.length > 0) { setAdopting({ name, conflicts: r.conflicts, busy: false }); return; }
    setAdopting(null);
    notify(`Could not adopt: ${r.problems[0]?.message ?? 'the result is not valid'}`, true);
  }, [notify, soon]);

  const adopt = useCallback(async (name: string) => {
    try { finish(name, await rpc.call('exp.adopt', { name, author: 'you' })); } catch (e) { fail('Could not adopt', e); }
  }, [rpc, finish, fail]);

  const resolveAdopt = useCallback(async (choice: Record<string, 'ours' | 'theirs'>) => {
    const a = adopting;
    if (!a) return;
    setAdopting({ ...a, busy: true });
    try { finish(a.name, await rpc.call('exp.adopt', { name: a.name, author: 'you', resolve: choice })); } catch (e) { setAdopting({ ...a, busy: false, error: e instanceof Error ? e.message : String(e) }); }
  }, [adopting, rpc, finish]);

  return { changes, exps, loaded, error, flags, flagged, openedId, deltasOf, ensureDeltas, restore, checkpoint, startExp, discard, adopt, adopting, resolveAdopt, cancelAdopt: () => setAdopting(null) };
}
