// The reviews of the project (approved, needs-change, note) kept fresh: review.list on open, review.changed as they come.

import { useCallback, useEffect, useState } from 'react';
import type { ReviewEntry } from 'hull/dev/protocol';
import type { RpcClient } from '../lib/rpc.ts';

export function useReviews(rpc: RpcClient): [ReviewEntry[], (e: ReviewEntry) => void] {
  const [list, setList] = useState<ReviewEntry[]>([]);
  useEffect(() => {
    let live = true;
    const load = (): void => { rpc.call('review.list', {}).then((r) => { if (live) setList(r); }, () => { /* older server: every card stays new */ }); };
    const offs = [rpc.onStatus((s) => { if (s === 'open') load(); }), rpc.on('review.changed', load)];
    if (rpc.status === 'open') load();
    return () => { live = false; offs.forEach((o) => o()); };
  }, [rpc]);
  const put = useCallback((e: ReviewEntry) => setList((l) => [...l.filter((x) => x.key !== e.key), e]), []);
  return [list, put];
}
