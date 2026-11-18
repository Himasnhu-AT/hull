// Editing an experiment from the Inspector. The Inspector knows one project: it reads values with config.read and
// tunables.list and writes with config.set and tunables.set. While an experiment is open this wraps the client so the
// same Inspector reads the experiment's values and writes go to the experiment (the `exp` parameter of those methods).

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeDelta, TunableWire } from 'hull/dev/protocol';
import type { RpcClient } from '../lib/rpc.ts';
import { setAtPointer } from '../lib/math.ts';
import type { Baselines } from '../editor/Inspector.tsx';

/** The project's values with an experiment's differences laid over them (deltas from `exp.compare('main', name)`). */
export function overlayTunables(list: TunableWire[], deltas: readonly ChangeDelta[]): TunableWire[] {
  const mine = deltas.filter((d) => d.kind === 'tunable' && d.op !== 'remove');
  if (mine.length === 0) return list;
  return list.map((t) => {
    const d = mine.find((x) => x.target === `tunables:${t.block}` && x.path === t.key);
    return d ? { ...t, value: d.to } : t;
  });
}

/** A config file's parsed value with an experiment's differences laid over it. */
export function overlayConfig(value: unknown, id: string, deltas: readonly ChangeDelta[]): unknown {
  let out = value;
  for (const d of deltas) if (d.kind === 'json' && d.target === id && d.op !== 'remove') out = setAtPointer(out, d.path, d.to);
  return out;
}

export interface ExpEditing {
  rpc: RpcClient;
  tunables: TunableWire[];
  setTunableLocal(block: string, key: string, value: unknown): void;
  baselines: Baselines;
}

const SEP = '\u0000';

/**
 * `exp` is the open experiment or null for the project itself. Returns what the Inspector should be given. The
 * wrapped client is stable per experiment, so the Inspector's own effects do not restart on every render.
 */
export function useExpEditing(rpc: RpcClient, exp: string | null, projectTunables: TunableWire[], projectLocal: (b: string, k: string, v: unknown) => void, projectBaselines: Baselines, version: unknown): ExpEditing {
  // Both are tagged with the experiment they belong to, so a switch never shows the previous experiment's values for a render.
  const [read, setRead] = useState<{ exp: string; deltas: ChangeDelta[] } | null>(null);
  const [edits, setEdits] = useState<{ exp: string; map: Map<string, unknown> } | null>(null);
  // Every experiment keeps its own baselines: the "reset to" value of a dial.
  const baselines = useMemo<Baselines>(() => ({ current: new Map() }), [exp]);

  // Read what the experiment differs in; again when it changes (version) so adopting or restoring shows.
  useEffect(() => {
    if (!exp) return;
    let live = true;
    rpc.call('exp.compare', { a: 'main', b: exp }).then((r) => { if (live) setRead({ exp, deltas: r.deltas }); }, () => {});
    return () => { live = false; };
  }, [rpc, exp, version]);

  const wrapped = useMemo<RpcClient>(() => {
    if (!exp) return rpc;
    const call = (async (method: string, params: Record<string, unknown>) => {
      if (method === 'config.set' || method === 'tunables.set') return rpc.call(method as 'config.set', { ...params, exp } as never);
      const r = await rpc.call(method as 'project.info', params as never);
      if (method === 'config.read') {
        const cfg = r as unknown as { id: string; value: unknown; text: string };
        const d = (await rpc.call('exp.compare', { a: 'main', b: exp }).catch(() => ({ deltas: [] as ChangeDelta[] }))).deltas;
        const value = overlayConfig(cfg.value, cfg.id, d);
        return { ...cfg, value, text: JSON.stringify(value, null, 2) };
      }
      return r;
    }) as unknown as RpcClient['call'];
    return { call, on: rpc.on.bind(rpc), onStatus: rpc.onStatus.bind(rpc), get status() { return rpc.status; }, close: () => {}, id: rpc.id } as unknown as RpcClient;
  }, [rpc, exp]);

  const tunables = useMemo(() => {
    if (!exp) return projectTunables;
    const base = overlayTunables(projectTunables, read?.exp === exp ? read.deltas : []);
    const map = edits?.exp === exp ? edits.map : null;
    return map && map.size > 0 ? base.map((t) => (map.has(`${t.block}${SEP}${t.key}`) ? { ...t, value: map.get(`${t.block}${SEP}${t.key}`) } : t)) : base;
  }, [exp, projectTunables, read, edits]);

  const setTunableLocal = useCallback((b: string, k: string, v: unknown) => {
    if (!exp) { projectLocal(b, k, v); return; }
    setEdits((s) => ({ exp, map: new Map(s?.exp === exp ? s.map : []).set(`${b}${SEP}${k}`, v) }));
  }, [exp, projectLocal]);

  return exp ? { rpc: wrapped, tunables, setTunableLocal, baselines } : { rpc, tunables: projectTunables, setTunableLocal: projectLocal, baselines: projectBaselines };
}
