// The Changes tab: what is different now from a chosen starting point (when the Studio opened, or a checkpoint), file by
// file, in plain words. Config shows field by field with the Inspector's labels; code shows the tunable and a compact
// line diff. Every row can go back through the same validated, recorded edit paths the Inspector uses.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { ChangeDelta, HistoryAuthor, TunableWire } from 'hull/dev/protocol';
import type { RpcClient } from '../lib/rpc.ts';
import { buildForm, tunableFields, type Field } from '../lib/schemaForm.ts';
import { Icon } from '../ui/Icon.tsx';
import { authorClass, authorLabel } from './plain.ts';
import { groupRows, lastAuthors, revertOrder, type ChangeRow, type FieldInfo, type FileGroup, type Revert, type Shown } from './changesView.ts';
import type { HistoryState } from './useHistory.ts';
import './history.css';

interface PatchLine { op: 'ctx' | 'add' | 'del' | 'gap'; n: number; text: string }

const Val = ({ v }: { v: Shown }): JSX.Element => <span className="cx-v">{v.swatch && <i className="cx-sw" style={{ background: v.swatch }} />}{v.text}</span>;

function Patch({ rpc, from, file, tick }: { rpc: RpcClient; from: string; file: string; tick: number }): JSX.Element {
  const [lines, setLines] = useState<PatchLine[] | null>(null);
  useEffect(() => { rpc.call('history.patch', { from, to: 'main', file }).then((r) => setLines(r.binary ? [] : r.lines), () => setLines([])); }, [rpc, from, file, tick]);
  if (!lines) return <div className="cx-patch"><div className="skeleton" style={{ height: 16 }} /></div>;
  return (
    <pre className="cx-patch" aria-label={`Line changes in ${file}`}>
      {lines.length === 0 && <span className="cx-ctx">No text to compare.</span>}
      {lines.map((l, i) => (
        <span key={i} className={`cx-l ${l.op}`}><b>{l.op === 'gap' ? '' : l.n}</b>{l.op === 'add' ? '+ ' : l.op === 'del' ? '- ' : l.op === 'gap' ? '...' : '  '}{l.text}{'\n'}</span>
      ))}
    </pre>
  );
}

interface Props {
  rpc: RpcClient;
  h: HistoryState;
  tunables: readonly TunableWire[];
  /** Bumps whenever an edit lands (the journal's length), so the list follows live edits. */
  tick: number;
  /** A Library id to show first ('look/dawn', 'tunables:hook'). */
  focus: { id: string; n: number } | null;
  notify(text: string, error?: boolean): void;
}

export function ChangesPanel({ rpc, h, tunables, tick, focus, notify }: Props): JSX.Element {
  const [since, setSince] = useState<string>('opened');
  const base = since === 'opened' ? h.openedId : since;
  const [deltas, setDeltas] = useState<ChangeDelta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [rev, setRev] = useState(0);
  const [schemas, setSchemas] = useState<Map<string, Field[]>>(() => new Map());
  const asked = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkpoints = useMemo(() => h.changes.flatMap((c) => c.checkpoints.map((name) => ({ name, at: c.at }))), [h.changes]);

  // A burst of edits (a drag) is one refresh.
  const refresh = useCallback(() => {
    if (!base) { setDeltas([]); return; }
    rpc.call('history.diff', { from: base, to: 'main' }).then((r) => { setDeltas(r.deltas); setError(null); }, (e: Error) => setError(e.message));
  }, [rpc, base]);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refresh, deltas === null ? 0 : 500);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [refresh, tick, h.changes.length, rev]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Inspector's labels need each changed config file's schema.
  useEffect(() => {
    for (const d of deltas ?? []) {
      if (d.kind !== 'json' || asked.current.has(d.target)) continue;
      asked.current.add(d.target);
      rpc.call('config.read', { id: d.target }).then((r) => {
        const f = buildForm(r.schema, r.value, { showAdvanced: true }).flatMap((g) => [...g.dials, ...g.fields]);
        setSchemas((m) => new Map(m).set(d.target, f));
      }, () => undefined);
    }
  }, [deltas, rpc]);

  const tunableInfo = useMemo(() => new Map(tunableFields(tunables).map((f, i) => [`tunables:${tunables[i]!.block}#${f.key}`, f])), [tunables]);
  const lookup = useCallback((target: string, pointer: string): FieldInfo | undefined => {
    if (target.startsWith('tunables:')) return tunableInfo.get(`${target}#${pointer}`);
    return schemas.get(target)?.find((f) => f.pointer === pointer);
  }, [schemas, tunableInfo]);

  // Who changed each file: the main-line changes after the starting point, oldest first.
  const steps = useMemo(() => {
    const after: typeof h.changes = [];
    for (const c of h.changes) { if (c.id === base) break; if (c.line === 'main') after.push(c); }
    return after.reverse();
  }, [h.changes, base]);
  useEffect(() => { for (const c of steps) h.ensureDeltas(c.id); }, [steps]); // eslint-disable-line react-hooks/exhaustive-deps
  const authors = useMemo(() => lastAuthors(steps.map((c) => ({ by: c.by as HistoryAuthor, deltas: h.deltasOf(c.id) ?? [] }))), [steps, h]);

  const groups = useMemo(() => groupRows(deltas ?? [], lookup, authors), [deltas, lookup, authors]);
  useEffect(() => { if (focus) { const g = groups.find((x) => x.ids.includes(focus.id) || x.file === focus.id); if (g) setPick(g.file); } }, [focus, groups.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = groups.find((g) => g.file === pick) ?? groups[0];

  const run = useCallback(async (r: Revert, from: string): Promise<boolean> => {
    try {
      const res = r.via === 'config.set' ? await rpc.call('config.set', { id: r.id, pointer: r.pointer, value: r.value, author: 'you' })
        : r.via === 'tunables.set' ? await rpc.call('tunables.set', { block: r.block, key: r.key, value: r.value, author: 'you' })
          : await rpc.call('history.revert', { from, file: r.file, ...(r.pointer !== undefined ? { pointer: r.pointer } : {}), author: 'you' });
      if (!res.ok) { notify(`Could not revert: ${res.problems[0]?.message ?? 'the old value is not valid now'}`, true); return false; }
      return true;
    } catch (e) { notify(`Could not revert: ${e instanceof Error ? e.message : String(e)}`, true); return false; }
  }, [rpc, notify]);

  const revertRow = async (row: ChangeRow): Promise<void> => { if (base && await run(row.revert, base)) setRev((n) => n + 1); };
  const revertFile = async (g: FileGroup): Promise<void> => {
    if (!base) return;
    if (await run({ via: 'history.revert', file: g.file }, base)) { notify(`${g.title} is back as it was`); setRev((n) => n + 1); }
  };
  const revertAll = async (): Promise<void> => {
    if (!base) return;
    const r = await rpc.call('history.restore', { id: base, author: 'you' }).catch((e: Error) => ({ ok: false, problems: [{ message: e.message }] }));
    if (r.ok) { notify('Everything is back as it was'); setRev((n) => n + 1); } else notify(`Could not revert: ${r.problems[0]?.message ?? 'the old state is not valid'}`, true);
  };

  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <div className="cx">
      <div className="hx-bar">
        <label className="cx-since">Since
          <select className="select hx-line-pick" value={since} onChange={(e) => { setSince(e.target.value); setDeltas(null); setPick(null); }} aria-label="Compare against">
            <option value="opened">I opened the Studio</option>
            {checkpoints.map((c) => <option key={c.name} value={c.name}>Checkpoint: {c.name}</option>)}
          </select>
        </label>
        <span className="hx-n">{deltas === null ? '' : total === 0 ? 'Nothing changed' : `${total} change${total === 1 ? '' : 's'} in ${groups.length} file${groups.length === 1 ? '' : 's'}`}</span>
        {total > 0 && <button className="btn ghost" onClick={() => void revertAll()} title="Put the whole project back as it was at the starting point"><Icon name="reset" />Revert all</button>}
      </div>
      {error && <div className="dock-empty" role="alert">Could not read the changes: {error}</div>}
      {!error && deltas !== null && total === 0 && <div className="dock-empty">Nothing is different from {since === 'opened' ? 'when you opened the Studio' : `checkpoint "${since}"`}. Edit a value in the Inspector, or let an agent work, and the difference shows here.</div>}
      {total > 0 && cur && (
        <div className="cx-body">
          <div className="cx-files" role="listbox" aria-label="Changed files">
            {groups.map((g) => (
              <button key={g.file} role="option" aria-selected={g === cur} className={`cx-file${g === cur ? ' sel' : ''}`} onClick={() => setPick(g.file)} title={g.file}>
                <span className="cx-fn">{g.title}</span>
                {g.by && <span className={`hx-who ${authorClass(g.by)}`}>{authorLabel(g.by)}</span>}
                <span className="cx-n">{g.rows.length}</span>
              </button>
            ))}
          </div>
          <div className="cx-detail">
            <div className="cx-dh">
              <span className="mono cx-path">{cur.file}</span>
              {cur.kind !== 'config' && base && <button className="btn ghost" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(cur.file)) n.delete(cur.file); else n.add(cur.file); return n; })} aria-pressed={open.has(cur.file)}>Lines</button>}
              <button className="btn ghost" onClick={() => void revertFile(cur)}><Icon name="reset" />Revert file</button>
            </div>
            {cur.rows.map((r) => (
              <div key={r.key} className="cx-row">
                <span className="cx-what">{r.path.map((p, i) => <span key={i}>{i > 0 && <em> › </em>}{p}</span>)}</span>
                <span className="cx-chg">
                  {r.from && <Val v={r.from} />}
                  {r.from && r.to && <em className="cx-ar">→</em>}
                  {r.to && <Val v={r.to} />}
                  {r.note && <span className="cx-note">{r.note}</span>}
                </span>
                <button className="rs show" onClick={() => void revertRow(r)} aria-label={`Revert ${r.path.join(' ')}`} title="Put it back"><Icon name="reset" /></button>
              </div>
            ))}
            {base && (cur.kind !== 'config' ? open.has(cur.file) || cur.rows.every((r) => r.kind === 'lines' || r.kind === 'file') : false) && <Patch rpc={rpc} from={base} file={cur.file} tick={rev + tick} />}
          </div>
        </div>
      )}
    </div>
  );
}
