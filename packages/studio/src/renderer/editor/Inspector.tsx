// The Inspector: a form for the selected Library item. Config files get their form from the JSON Schema (config.read),
// tunables from tunables.list. Every edit shows at once; a throttled call keeps the file (and the running game) up to date.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MutableRefObject } from 'react';
import type { Problem } from 'hull';
import type { LibraryItem, TunableWire } from 'hull/dev/protocol';
import type { RpcClient } from '../lib/rpc.ts';
import { buildForm, groupFields, tunableFields, advancedCount, type FormGroup } from '../lib/schemaForm.ts';
import { setAtPointer, throttle, sameJson } from '../lib/math.ts';
import { Dial, FieldView, type Change } from '../ui/widgets.tsx';
import { Icon } from '../ui/Icon.tsx';
import { problemPlace } from './useProject.ts';

export type Baselines = MutableRefObject<Map<string, unknown>>;

interface Props {
  rpc: RpcClient;
  item: LibraryItem | null;
  library: LibraryItem[];
  tunables: TunableWire[];
  baselines: Baselines;
  setTunableLocal(block: string, key: string, value: unknown): void;
  onOpenSound(id: string): void;
  reveal(path: string): void;
}

const SEND_MS = 70;

function msg(p: Problem): string { return p.message; }

/** The groups of a form, with the dials gathered in their own grid. */
function Groups({ groups, values, baseKey, baselines, problems, refs, onChange }: {
  groups: FormGroup[]; values: (ptr: string) => unknown; baseKey: string; baselines: Baselines;
  problems: Record<string, string[]>; refs: (kind: string) => string[]; onChange: Change;
}): JSX.Element {
  const probsFor = (ptr: string): string[] => Object.entries(problems).filter(([p]) => p === ptr || p.startsWith(`${ptr}/`)).flatMap(([, m]) => m);
  return (
    <>
      {groups.map((g) => (
        <section className="grp" key={g.name} aria-label={g.name}>
          <div className="gt">{g.name}</div>
          {g.dials.length > 0 && (
            <div className="dials">
              {g.dials.map((f) => <Dial key={f.pointer} field={f} value={values(f.pointer)} baseline={baselines.current.get(`${baseKey}\0${f.pointer}`)} problems={probsFor(f.pointer)} refOptions={[]} onChange={onChange} />)}
            </div>
          )}
          {g.fields.map((f) => <FieldView key={f.pointer} field={f} value={values(f.pointer)} baseline={baselines.current.get(`${baseKey}\0${f.pointer}`)} problems={probsFor(f.pointer)} refOptions={f.refKind ? refs(f.refKind) : []} onChange={onChange} />)}
        </section>
      ))}
    </>
  );
}

function Header({ id, kind, path, line, onReveal, extra }: { id: string; kind: string; path: string; line?: number; onReveal(): void; extra?: JSX.Element }): JSX.Element {
  return (
    <div className="insp-h">
      <div className="id"><b title={id}>{id}</b><span className="kind">{kind}</span></div>
      <button className="pathlink" onClick={onReveal} title="Show in Finder"><Icon name="file" size={13} /><span>{path}{line ? `:${line}` : ''}</span></button>
      {extra}
    </div>
  );
}

function Orphans({ problems, covered }: { problems: Record<string, string[]>; covered: Set<string> }): JSX.Element | null {
  const rest = Object.entries(problems).filter(([p]) => ![...covered].some((c) => p === c || p.startsWith(`${c}/`)));
  if (rest.length === 0) return null;
  return (
    <div className="probs" role="alert">
      {rest.flatMap(([p, ms]) => ms.map((m, i) => <div className="p" key={`${p}${i}`}><Icon name="warn" size={13} style={{ color: 'var(--warn)' }} /><span>{m} <code>{p || '(file)'}</code></span></div>))}
    </div>
  );
}

/* ---------- a config file ---------- */

function ConfigForm({ rpc, id, path, library, baselines, onOpenSound, reveal }: { rpc: RpcClient; id: string; path: string; library: LibraryItem[]; baselines: Baselines; onOpenSound(id: string): void; reveal(p: string): void }): JSX.Element {
  const [doc, setDoc] = useState<{ value: unknown; schema: unknown } | null>(null);
  const [problems, setProblems] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const lastEdit = useRef(0);
  const throttles = useRef(new Map<string, ReturnType<typeof throttle<[unknown]>>>());
  const idRef = useRef(id);
  idRef.current = id;

  const read = useCallback((first: boolean) => {
    rpc.call('config.read', { id }).then((r) => {
      if (idRef.current !== id) return;
      if (first) {
        // The baseline is what the file said when the project was opened (or first looked at): the reset arrows go back to it.
        const walk = (schema: unknown): void => {
          for (const g of buildForm(schema, r.value, { showAdvanced: true })) for (const f of [...g.dials, ...g.fields]) {
            const k = `${id}\0${f.pointer}`;
            if (!baselines.current.has(k)) baselines.current.set(k, structuredClone(f.value));
          }
        };
        walk(r.schema);
      }
      setDoc({ value: r.value, schema: r.schema });
      const byPtr: Record<string, string[]> = {};
      for (const p of r.problems) (byPtr[p.pointer ?? ''] ??= []).push(msg(p));
      setProblems(byPtr);
      setError(null);
    }, (e: Error) => setError(e.message));
  }, [rpc, id, baselines]);

  useEffect(() => {
    setDoc(null); setProblems({}); setError(null); setShowAll(false);
    for (const t of throttles.current.values()) t.cancel();
    throttles.current.clear();
    read(true);
    // A change from elsewhere (an agent, an editor on disk) arrives here; our own echo is ignored for a moment.
    const off = rpc.on('config.changed', (p) => { if (p.id === id && Date.now() - lastEdit.current > 600) read(false); });
    return () => { off(); for (const t of throttles.current.values()) t.flush(); };
  }, [rpc, id, read]);

  const sent = useRef(new Map<string, unknown>());
  const send = useCallback((pointer: string, value: unknown) => {
    // The end of a drag repeats the last value; the file and the Changes list should not see it twice.
    if (sent.current.has(pointer) && sameJson(sent.current.get(pointer), value)) return;
    sent.current.set(pointer, value);
    rpc.call('config.set', { id, pointer, value, author: 'you' }).then((r) => {
      setProblems((cur) => {
        const next = { ...cur };
        for (const k of Object.keys(next)) if (k === pointer) delete next[k];
        if (!r.ok) next[pointer] = r.problems.map(msg);
        return next;
      });
    }, (e: Error) => setProblems((cur) => ({ ...cur, [pointer]: [e.message] })));
  }, [rpc, id]);

  const onChange = useCallback<Change>((pointer, value, final) => {
    lastEdit.current = Date.now();
    setDoc((d) => (d ? { ...d, value: setAtPointer(d.value, pointer, value) } : d));
    let t = throttles.current.get(pointer);
    if (!t) throttles.current.set(pointer, (t = throttle((v: unknown) => send(pointer, v), SEND_MS)));
    t(value);
    if (final) t.flush();
  }, [send]);

  const groups = useMemo(() => (doc ? buildForm(doc.schema, doc.value, { showAdvanced: showAll }) : []), [doc, showAll]);
  const hidden = doc ? advancedCount(doc.schema, doc.value) : 0;
  const covered = useMemo(() => new Set(groups.flatMap((g) => [...g.dials, ...g.fields].map((f) => f.pointer))), [groups]);
  const refs = useCallback((kind: string) => library.filter((l) => l.kind === kind).map((l) => l.id), [library]);
  const valueAt = useCallback((ptr: string) => (doc ? ptr.split('/').slice(1).reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc.value) : undefined), [doc]);

  const total = Object.values(problems).flat().length;
  return (
    <>
      <Header id={id} kind={id.split('/')[0] ?? ''} path={path} onReveal={() => reveal(path)}
        extra={id.startsWith('sound/') ? <button className="btn" onClick={() => onOpenSound(id)} style={{ alignSelf: 'flex-start' }}><Icon name="audio" />Open in Sound bench</button> : undefined} />
      <div className="insp-b">
        {error && <p className="empty-note" role="alert" style={{ color: 'var(--danger)' }}>Could not read {id}: {error}</p>}
        {!doc && !error && <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>}
        {doc && <Orphans problems={problems} covered={covered} />}
        {doc && groups.length === 0 && <p className="empty-note">This file has nothing the Inspector can show. Its schema describes no fields.</p>}
        {doc && <Groups groups={groups} values={valueAt} baseKey={id} baselines={baselines} problems={problems} refs={refs} onChange={onChange} />}
        {doc && hidden > 0 && <div style={{ padding: '10px 14px' }}><button className="btn ghost" onClick={() => setShowAll((s) => !s)}>{showAll ? 'Hide advanced fields' : `Show all (${hidden} more)`}</button></div>}
      </div>
      <div className="insp-f"><span>{total > 0 ? `${total} problem${total === 1 ? '' : 's'}` : 'Valid'}</span><span>Edits save to the file</span></div>
    </>
  );
}

/* ---------- a block of tunables ---------- */

function TunablesForm({ rpc, block, path, tunables, baselines, setTunableLocal, reveal }: { rpc: RpcClient; block: string; path: string; tunables: TunableWire[]; baselines: Baselines; setTunableLocal(b: string, k: string, v: unknown): void; reveal(p: string): void }): JSX.Element {
  const mine = useMemo(() => tunables.filter((t) => t.block === block), [tunables, block]);
  const [problems, setProblems] = useState<Record<string, string[]>>({});
  const throttles = useRef(new Map<string, ReturnType<typeof throttle<[unknown]>>>());
  const sent = useRef(new Map<string, unknown>());
  const baseKey = `tunables:${block}`;
  for (const t of mine) { const k = `${baseKey}\0${t.key}`; if (!baselines.current.has(k)) baselines.current.set(k, structuredClone(t.value)); }

  useEffect(() => () => { for (const t of throttles.current.values()) t.flush(); }, [block]);

  const onChange = useCallback<Change>((key, value, final) => {
    setTunableLocal(block, key, value);
    let t = throttles.current.get(key);
    if (!t) {
      throttles.current.set(key, (t = throttle((v: unknown) => {
        if (sent.current.has(key) && sameJson(sent.current.get(key), v)) return;
        sent.current.set(key, v);
        rpc.call('tunables.set', { block, key, value: v, author: 'you' }).then((r) => {
          setProblems((cur) => { const n = { ...cur }; delete n[key]; if (!r.ok) n[key] = r.problems.map(msg); return n; });
        }, (e: Error) => setProblems((cur) => ({ ...cur, [key]: [e.message] })));
      }, SEND_MS)));
    }
    t(value);
    if (final) t.flush();
  }, [rpc, block, setTunableLocal]);

  const fields = useMemo(() => tunableFields(mine), [mine]);
  const groups = useMemo(() => groupFields(fields), [fields]);
  const byKey = useMemo(() => new Map(mine.map((t) => [t.key, t.value])), [mine]);
  const probs = useMemo(() => Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, v])), [problems]);
  const first = mine[0];
  return (
    <>
      <Header id={baseKey} kind="tunables" path={first?.file ?? path} line={first?.line} onReveal={() => reveal(first?.file ?? path)} />
      <div className="insp-b">
        {mine.length === 0 && <p className="empty-note">No tunables are declared in this block right now. Start the game and they appear here.</p>}
        <Groups groups={groups} values={(k) => byKey.get(k)} baseKey={baseKey} baselines={baselines} problems={probs} refs={() => []} onChange={onChange} />
      </div>
      <div className="insp-f"><span>Values live in code</span><span>Edits rewrite the literal</span></div>
    </>
  );
}

export function Inspector({ rpc, item, library, tunables, baselines, setTunableLocal, onOpenSound, reveal }: Props): JSX.Element {
  return (
    <aside className="insp" aria-label="Inspector">
      {!item && (
        <div className="insp-b">
          <p className="empty-note" style={{ padding: '16px 14px' }}>Nothing selected. Pick something in the Library to tune it here: a sound, a material, a block of numbers from your code.</p>
        </div>
      )}
      {item && item.kind === 'tunables'
        ? <TunablesForm key={item.id} rpc={rpc} block={item.title} path={item.path} tunables={tunables} baselines={baselines} setTunableLocal={setTunableLocal} reveal={reveal} />
        : item && <ConfigForm key={item.id} rpc={rpc} id={item.id} path={item.path} library={library} baselines={baselines} onOpenSound={onOpenSound} reveal={reveal} />}
    </aside>
  );
}

export { problemPlace, sameJson };
