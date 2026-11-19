// The flow state (create.get, kept fresh by create.changed) and the explain documents (explain.list, explain.changed).

import { useEffect, useState } from 'react';
import type { CreateState, ExplainDoc, LibraryItem } from 'hull/dev/protocol';
import type { RpcClient } from '../lib/rpc.ts';

export function useCreateState(rpc: RpcClient): CreateState | null {
  const [state, setState] = useState<CreateState | null>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => { rpc.call('create.get', {}).then((s) => { if (live) setState(s); }, () => { /* an older server has no flow state */ }); };
    const offs = [rpc.onStatus((s) => { if (s === 'open') load(); }), rpc.on('create.changed', (s) => { if (live) setState(s); })];
    if (rpc.status === 'open') load();
    return () => { live = false; offs.forEach((o) => o()); };
  }, [rpc]);
  return state;
}

export function useExplainDocs(rpc: RpcClient): ExplainDoc[] {
  const [items, setItems] = useState<ExplainDoc[]>([]);
  useEffect(() => {
    let live = true;
    const load = (): void => { rpc.call('explain.list', {}).then((r) => { if (live) setItems(r.items); }, () => { /* none yet */ }); };
    const offs = [rpc.onStatus((s) => { if (s === 'open') load(); }), rpc.on('explain.changed', load)];
    if (rpc.status === 'open') load();
    return () => { live = false; offs.forEach((o) => o()); };
  }, [rpc]);
  return items;
}

/** The project's pieces, refreshed (after a short pause) when a config file changes or goes. */
export function useLibrary(rpc: RpcClient): LibraryItem[] | null {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = (): void => { rpc.call('library.list', {}).then((r) => { if (live) setItems(r); }, () => { /* keep what we had */ }); };
    const soon = (): void => { if (timer) clearTimeout(timer); timer = setTimeout(load, 200); };
    const offs = [rpc.onStatus((s) => { if (s === 'open') load(); }), rpc.on('config.changed', soon), rpc.on('config.removed', soon)];
    if (rpc.status === 'open') load();
    return () => { live = false; if (timer) clearTimeout(timer); offs.forEach((o) => o()); };
  }, [rpc]);
  return items;
}
