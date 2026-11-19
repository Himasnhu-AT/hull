// Changes: what changed in the project, newest first, in plain words, with who did it and Put back for each change.
// Put back reverts that one change field by field (history.diff, then the same validated writes the Changes tab makes), so it
// is a new entry in the list and the change it undid stays where it was.
//   rpc          the project connection

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { HistoryChange } from 'hull/dev/protocol';
import type { RpcClient } from '../lib/rpc.ts';
import { entryOf, mainLine } from './changesList.ts';
import { putBackChange } from './putBack.ts';

export interface ChangesProps { rpc: RpcClient }

export function Changes({ rpc }: ChangesProps): JSX.Element {
  const [changes, setChanges] = useState<HistoryChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [back, setBack] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = (): void => { rpc.call('history.list', { limit: 400 }).then((c) => { if (live) { setChanges(c); setError(null); } }, (e: Error) => { if (live) setError(e.message); }); };
    // A burst of pushes is one reload.
    const soon = (): void => { if (timer) clearTimeout(timer); timer = setTimeout(load, 120); };
    const offs = [rpc.onStatus((s) => { if (s === 'open') load(); }), rpc.on('history.added', soon)];
    if (rpc.status === 'open') load();
    return () => { live = false; if (timer) clearTimeout(timer); offs.forEach((o) => o()); };
  }, [rpc]);

  const list = useMemo(() => mainLine(changes ?? []), [changes]);

  const putBack = useCallback(async (c: HistoryChange) => {
    setBusy(c.id); setError(null);
    const problem = await putBackChange(rpc, c);
    if (problem) setError(problem); else setBack((s) => new Set(s).add(c.id));
    setBusy(null);
  }, [rpc]);

  if (changes === null) return <div className="cr-pad">{error ? <div className="note-err" role="alert">{error}</div> : <div className="skeleton" />}</div>;
  return (
    <div className="cr-changes">
      {error && <div className="note-err" role="alert">{error}</div>}
      {list.length === 0 && <p className="cr-sub">Nothing has changed yet.</p>}
      <ol className="cr-clist">
        {list.map((c) => {
          const e = entryOf(c);
          return (
            <li key={c.id} className="cr-change">
              <div className="cr-ch-main">
                <b>{e.title}</b>
                {e.lines.length > 0 && <ul>{e.lines.map((l, i) => <li key={i}>{l}</li>)}{e.more > 0 && <li className="cr-sub">and {e.more} more</li>}</ul>}
                <span className="cr-sub">{e.who} · {e.when}</span>
              </div>
              <div className="cr-ch-act">
                {back.has(c.id) && <span className="pill ok">put back</span>}
                {e.restore && <span className="pill">undid something</span>}
                {!e.start && <button className="btn" disabled={busy !== null} onClick={() => void putBack(c)}>{busy === c.id ? 'Putting back...' : 'Put back'}</button>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
