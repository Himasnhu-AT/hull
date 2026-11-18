// The History panel (a Dock tab): the timeline in plain words with experiments drawn as branches, filters, the selected
// change's details, and the actions: restore, checkpoint, start an experiment from here. Experiments have their own list
// with Edit, Compare, Adopt and Discard.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { ChangeDelta, HistoryChange } from 'hull/dev/protocol';
import { Icon } from '../ui/Icon.tsx';
import type { HistoryState } from './useHistory.ts';
import { ago, authorClass, authorLabel, isAi, laneColor, layout, plain, type LaneRow } from './plain.ts';
import './history.css';

const ROW = 30;
const LANE_W = 14;

type Filter = 'all' | 'you' | 'ai' | 'flagged';

export const Chip = ({ by }: { by: HistoryChange['by'] }): JSX.Element => <span className={`hx-who ${authorClass(by)}`}>{authorLabel(by)}</span>;

/** The one-line summary of a change in plain words: 'jump height 2.2 → 2.6', and '+2 more' when it set several values. */
export function summary(c: HistoryChange, deltas: ChangeDelta[] | undefined): { text: string; scope?: string; more: number } {
  if (c.kind === 'start') return { text: 'Project created', more: 0 };
  if (c.kind === 'merge' || c.kind === 'restore') return { text: c.message, more: 0 };
  if (!deltas || deltas.length === 0) return { text: c.message, more: 0 };
  const first = plain(deltas[0]!);
  return { text: first.text, scope: first.scope, more: deltas.length - 1 };
}

/** The lane drawing of one row: lines through, the dot, curves for forks and merges. */
function Lanes({ row, width, selected }: { row: LaneRow; width: number; selected: boolean }): JSX.Element {
  const x = (lane: number): number => 8 + lane * LANE_W;
  const mid = ROW / 2;
  return (
    <svg className="hx-lanes" width={width} height={ROW} viewBox={`0 0 ${width} ${ROW}`} aria-hidden="true">
      {row.lines.map((l) => (
        <line key={l.lane} x1={x(l.lane)} x2={x(l.lane)} y1={l.part === 'bottom' ? mid : 0} y2={l.part === 'top' ? mid : ROW} stroke={laneColor(l.lane)} strokeWidth="2" strokeLinecap="round" opacity="0.8" />
      ))}
      {row.forkFrom.map((lane) => <path key={`f${lane}`} d={`M${x(lane)} 0 C${x(lane)} ${mid * 0.9} ${x(0)} ${mid * 0.1} ${x(0)} ${mid}`} fill="none" stroke={laneColor(lane)} strokeWidth="2" strokeLinecap="round" opacity="0.8" />)}
      {row.mergeFrom.map((lane) => <path key={`m${lane}`} d={`M${x(lane)} 0 C${x(lane)} ${mid * 0.9} ${x(0)} ${mid * 0.1} ${x(0)} ${mid}`} fill="none" stroke={laneColor(lane)} strokeWidth="2" strokeLinecap="round" opacity="0.8" strokeDasharray="3 3" />)}
      <circle cx={x(row.lane)} cy={mid} r={row.change.kind === 'merge' ? 5 : 4.2} fill={row.change.kind === 'start' || row.change.kind === 'merge' ? 'var(--panel)' : laneColor(row.lane)} stroke={laneColor(row.lane)} strokeWidth="2" />
      {selected && <circle cx={x(row.lane)} cy={mid} r="8" fill="none" stroke="var(--text)" strokeWidth="1.2" opacity="0.7" />}
    </svg>
  );
}

function NameForm({ placeholder, label, initial, onSubmit, onCancel }: { placeholder: string; label: string; initial?: string; onSubmit(name: string): void; onCancel(): void }): JSX.Element {
  const [v, setV] = useState(initial ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <form className="hx-name" onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSubmit(v.trim()); }}>
      <input ref={ref} className="field-in" value={v} placeholder={placeholder} aria-label={label} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }} />
      <button className="btn primary" type="submit" disabled={!v.trim()}>{label}</button>
      <button className="btn ghost" type="button" onClick={onCancel} aria-label="Cancel"><Icon name="close" /></button>
    </form>
  );
}

/** The experiments, as branches: colour, state, and what you can do. */
export function ExpList({ h, lanes, openExp, onOpen, onCompare }: { h: HistoryState; lanes: string[]; openExp: string | null; onOpen(name: string | null): void; onCompare(a: string, b: string): void }): JSX.Element {
  const exps = [...h.exps].sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
  if (exps.length === 0) return <div className="hx-empty">No experiments. Start one from any change to try a different tuning without touching the project.</div>;
  return (
    <div className="hx-exps">
      {exps.map((e) => {
        const lane = Math.max(1, lanes.indexOf(e.name));
        const open = openExp === e.name;
        return (
          <div key={e.name} className={`hx-exp${e.status !== 'active' ? ' done' : ''}${open ? ' open' : ''}`}>
            <i className="hx-dot" style={{ background: laneColor(lane) }} />
            <div className="hx-exp-n">
              <b>{e.name}</b>
              <span className="hx-sub">{e.status !== 'active' ? e.status : open ? 'editing' : e.changes === 0 ? 'untouched' : `${e.changes} change${e.changes === 1 ? '' : 's'}`}</span>
            </div>
            {e.status === 'active' && (
              <div className="hx-acts">
                <button className={`btn${open ? ' on' : ''}`} onClick={() => onOpen(open ? null : e.name)} title="Show this experiment in the Game view and send Inspector edits to it">{open ? 'Close' : 'Edit'}</button>
                <button className="btn" onClick={() => onCompare('main', e.name)} disabled={!e.gameUrl} title="Run it next to main"><Icon name="compare" />Compare</button>
                <button className="btn" onClick={() => void h.adopt(e.name)} title="Merge this experiment into the project. It stays in the timeline."><Icon name="check" />Adopt</button>
                <button className="btn ghost" onClick={() => void h.discard(e.name)} title="Close the working copy. Its changes stay in the timeline." aria-label={`Discard ${e.name}`}><Icon name="trash" /></button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Details({ h, change, onProblems }: { h: HistoryState; change: HistoryChange; onProblems(): void }): JSX.Element {
  const deltas = h.deltasOf(change.id);
  const [mode, setMode] = useState<'none' | 'exp' | 'check'>('none');
  const [busy, setBusy] = useState(false);
  useEffect(() => { h.ensureDeltas(change.id); setMode('none'); }, [change.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const flags = h.flagged.get(change.id) ?? [];
  const tip = h.changes.find((c) => c.line === 'main');
  const isTip = tip?.id === change.id;
  return (
    <div className="hx-card">
      <div className="hx-card-h">
        <Chip by={change.by} />
        <span className="hx-sub">{ago(change.at)} · {change.line === 'main' ? 'main' : `experiment ${change.line}`}</span>
        <span className="mono hx-id">{change.short}</span>
      </div>
      <div className="hx-lines">
        {deltas === undefined && change.details.map((d, i) => <div key={i} className="hx-line">{d}</div>)}
        {deltas?.map((d, i) => {
          const p = plain(d);
          return (
            <div key={i} className="hx-line" title={`${d.file}`}>
              <span className="hx-scope">{p.scope}</span>
              <span className="hx-what">{p.what}</span>
              {d.kind === 'lines' || d.kind === 'asset' || d.kind === 'file' ? <span className="hx-sub">{d.op}</span> : p.op === 'set' ? <><span className="hx-old">{p.from}</span><span className="hx-arrow">→</span><span className="hx-new">{p.to}</span></> : <span className="hx-new">{p.op === 'add' ? `added ${p.to}` : 'removed'}</span>}
            </div>
          );
        })}
        {deltas?.length === 0 && change.details.length === 0 && <div className="hx-sub">{change.kind === 'start' ? 'Where history begins.' : 'No value differences.'}</div>}
      </div>
      {flags.length > 0 && (
        <div className="hx-flag" role="alert">
          <Icon name="warn" size={14} />
          <div>
            {flags.map((p, i) => <div key={i}>{p.message}</div>)}
            <button className="hx-link" onClick={onProblems}>See it in Problems</button>
          </div>
        </div>
      )}
      {change.checkpoints.length > 0 && <div className="hx-cps">{change.checkpoints.map((n) => <span key={n} className="hx-cp"><Icon name="flag" size={11} />{n}</span>)}</div>}
      {mode === 'none' && (
        <div className="hx-acts">
          <button className="btn" disabled={busy || isTip} title={isTip ? 'This is how the project is now' : 'Put the project back as it was here. This becomes a new entry, so it can be undone.'} onClick={() => { setBusy(true); void h.restore(change.id).finally(() => setBusy(false)); }}><Icon name="reset" />Restore this</button>
          <button className="btn" onClick={() => setMode('exp')}><Icon name="branch" />Experiment from here</button>
          <button className="btn ghost" onClick={() => setMode('check')}><Icon name="flag" />Checkpoint</button>
        </div>
      )}
      {mode === 'exp' && <NameForm placeholder="Name, like floaty-jump" label="Start" initial={`idea-${h.exps.length + 1}`} onCancel={() => setMode('none')} onSubmit={(n) => { void h.startExp(n, change.id).then(() => setMode('none')); }} />}
      {mode === 'check' && <NameForm placeholder="Name, like before-the-boss" label="Save" onCancel={() => setMode('none')} onSubmit={(n) => { void h.checkpoint(n, change.id).then(() => setMode('none')); }} />}
    </div>
  );
}

interface Props { h: HistoryState; openExp: string | null; onOpenExp(name: string | null): void; onCompare(a: string, b: string): void; onProblems(): void }

export function HistoryPanel({ h, openExp, onOpenExp, onCompare, onProblems }: Props): JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');
  const [line, setLine] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  const { rows, lanes } = useMemo(() => layout(h.changes, h.exps), [h.changes, h.exps]);
  const width = 16 + Math.max(1, lanes.length) * LANE_W;
  // The first screenful of rows is read so their lines are in words (history.diff, one call each, cached).
  useEffect(() => { for (const c of h.changes.slice(0, 40)) h.ensureDeltas(c.id); }, [h.changes]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = rows.filter((r) => {
    const c = r.change;
    if (line && c.line !== line) return false;
    if (filter === 'you') return !isAi(c.by);
    if (filter === 'ai') return isAi(c.by);
    if (filter === 'flagged') return h.flagged.has(c.id);
    return true;
  });
  const selected = h.changes.find((c) => c.id === picked) ?? h.changes[0] ?? null;
  const flaggedCount = h.flagged.size;
  const aiCount = h.changes.filter((c) => isAi(c.by)).length;

  if (!h.loaded) return <div className="dock-empty">{h.error ? `Could not read the history: ${h.error}` : 'Reading the history...'}</div>;

  return (
    <div className="hx">
      <div className="hx-bar">
        <div className="hx-filters" role="group" aria-label="Filter the timeline">
          <button className={`chip${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>All</button>
          <button className={`chip${filter === 'you' ? ' on' : ''}`} onClick={() => setFilter('you')}>You</button>
          <button className={`chip${filter === 'ai' ? ' on' : ''}`} onClick={() => setFilter('ai')}>AI{aiCount > 0 && <span className="hx-n">{aiCount}</span>}</button>
          <button className={`chip${filter === 'flagged' ? ' on' : ''}${flaggedCount > 0 ? ' alert' : ''}`} onClick={() => setFilter('flagged')}><Icon name="warn" size={12} />Over your values{flaggedCount > 0 && <span className="count">{flaggedCount}</span>}</button>
        </div>
        <select className="field-in hx-line-pick" value={line} onChange={(e) => setLine(e.target.value)} aria-label="Show one line">
          <option value="">All lines</option>
          {lanes.map((l) => <option key={l} value={l}>{l === 'main' ? 'main' : `experiment ${l}`}</option>)}
        </select>
      </div>
      <div className="hx-body">
        <div className="hx-list" role="list" aria-label="Timeline">
          {shown.length === 0 && <div className="hx-empty">{filter === 'flagged' ? 'Nothing the AI changed has overwritten a value you set.' : 'Nothing matches.'}</div>}
          {shown.map((r) => {
            const c = r.change;
            const s = summary(c, h.deltasOf(c.id));
            const sel = selected?.id === c.id;
            const flags = h.flagged.get(c.id);
            return (
              <button key={c.id} role="listitem" className={`hx-row${sel ? ' sel' : ''}${flags ? ' flagged' : ''}`} onClick={() => setPicked(c.id)} aria-current={sel}>
                <Lanes row={r} width={width} selected={sel} />
                <span className="hx-txt">
                  {s.scope && <span className="hx-scope">{s.scope}</span>}
                  <span className={`hx-msg${c.kind === 'start' ? ' quiet' : ''}`}>{s.text}</span>
                  {s.more > 0 && <span className="hx-more">+{s.more} more</span>}
                </span>
                {c.line !== 'main' && <span className="hx-line-tag" style={{ color: laneColor(Math.max(1, lanes.indexOf(c.line))) }}><Icon name="branch" size={11} />{c.line}</span>}
                {c.checkpoints.map((n) => <span key={n} className="hx-cp"><Icon name="flag" size={11} />{n}</span>)}
                {flags && <span className="hx-flagicon" title={flags[0]!.message}><Icon name="warn" size={13} /></span>}
                <Chip by={c.by} />
                <span className="hx-time">{ago(c.at)}</span>
              </button>
            );
          })}
        </div>
        <aside className="hx-side" aria-label="Experiments and details">
          <div className="hx-sec">Experiments</div>
          <ExpList h={h} lanes={lanes} openExp={openExp} onOpen={onOpenExp} onCompare={onCompare} />
          <div className="hx-sec">Selected change</div>
          {selected && <Details h={h} change={selected} onProblems={onProblems} />}
        </aside>
      </div>
    </div>
  );
}

