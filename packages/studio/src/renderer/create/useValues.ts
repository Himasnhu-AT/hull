// The data behind a values table: the numbers now (tunables.list or config.read) and the changes since the stage's earlier point.

import { useEffect, useMemo, useState } from 'react';
import type { ChangeDelta, TunableWire } from 'hull/dev/protocol';
import type { RpcClient } from '../lib/rpc.ts';
import { configValues, tunableValues, type ValuesView } from './valuesTable.ts';

/** What changed between two history points; null while loading, when either point is unknown, or when the history cannot say. */
export function useDeltas(rpc: RpcClient, from: string | undefined, to: string | undefined): ChangeDelta[] | null {
  const [deltas, setDeltas] = useState<ChangeDelta[] | null>(null);
  useEffect(() => {
    setDeltas(null);
    if (!from || !to) return;
    let live = true;
    const load = (): void => { rpc.call('history.diff', { from, to }).then((r) => { if (live) setDeltas(r.deltas); }, () => { /* no Before column */ }); };
    const off = rpc.onStatus((s) => { if (s === 'open') load(); });
    if (rpc.status === 'open') load();
    return () => { live = false; off(); };
  }, [rpc, from, to]);
  return deltas;
}

/** The table for a review key ('tunables:<block>' or a tuning config id); null until the numbers have loaded. */
export function useValues(rpc: RpcClient, key: string, deltas: ChangeDelta[] | null): ValuesView | null {
  const [tunables, setTunables] = useState<TunableWire[] | null>(null);
  const [config, setConfig] = useState<{ schema: unknown; value: unknown } | null>(null);
  const isTunables = key.startsWith('tunables:');
  useEffect(() => {
    let live = true;
    const load = (): void => {
      if (isTunables) rpc.call('tunables.list', {}).then((r) => { if (live) setTunables(r); }, () => { /* keep what we had */ });
      else rpc.call('config.read', { id: key }).then((r) => { if (live) setConfig({ schema: r.schema, value: r.value }); }, () => { /* keep what we had */ });
    };
    const offs = [rpc.onStatus((s) => { if (s === 'open') load(); }), rpc.on('config.changed', (c) => { if (!isTunables && c.id === key) load(); })];
    if (rpc.status === 'open') load();
    return () => { live = false; offs.forEach((o) => o()); };
  }, [rpc, key, isTunables]);
  return useMemo(() => {
    if (isTunables) return tunables ? tunableValues(key.slice('tunables:'.length), tunables, deltas) : null;
    return config ? configValues(key, config.schema, config.value, deltas) : null;
  }, [isTunables, key, tunables, config, deltas]);
}
