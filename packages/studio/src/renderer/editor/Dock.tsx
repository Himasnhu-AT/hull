import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import type { Problem } from 'hull';
import type { Change } from 'hull/dev/protocol';
import { Icon } from '../ui/Icon.tsx';
import { idFromPath, problemPlace, type LogLine } from './useProject.ts';

export type DockTab = 'console' | 'changes' | 'history';

const clock = (t: number | string): string => new Date(t).toTimeString().slice(0, 8);

const show = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? 'nothing' : s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

interface Props {
  tab: DockTab;
  onTab(t: DockTab): void;
  logs: LogLine[];
  problems: Problem[];
  journal: Change[];
  onClear(): void;
  onOpen(id: string): void;
  /** The History panel (history/HistoryPanel) and how many of its changes are flagged. */
  history?: ReactNode;
  /** The Changes panel (history/ChangesPanel): the diff since the Studio opened. Without it the tab lists the journal. */
  changes?: ReactNode;
  flagged?: number;
}

export function Dock({ tab, onTab, logs, problems, journal, onClear, onOpen, history, changes, flagged = 0 }: Props): JSX.Element {
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { const b = body.current; if (b && stick.current && tab === 'console') b.scrollTop = b.scrollHeight; }, [logs, problems, tab]);

  return (
    <section className="dock" aria-label="Dock">
      <div className="dock-h">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'console'} className={`tab${tab === 'console' ? ' on' : ''}`} onClick={() => onTab('console')}>
            <Icon name="console" />Console{problems.length > 0 && <span className="count">{problems.length}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'changes'} className={`tab${tab === 'changes' ? ' on' : ''}`} onClick={() => onTab('changes')}>
            <Icon name="history" />Changes{journal.length > 0 && <span style={{ color: 'var(--faint)', fontSize: 11 }}>{journal.length}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'history'} className={`tab${tab === 'history' ? ' on' : ''}`} onClick={() => onTab('history')}>
            <Icon name="branch" />History{flagged > 0 && <span className="count">{flagged}</span>}
          </button>
        </div>
        {tab === 'console' && <button className="btn ghost" onClick={onClear} disabled={logs.length === 0}><Icon name="trash" />Clear</button>}
      </div>
      {tab === 'history' && <div className="dock-b" style={{ overflow: 'hidden' }}>{history}</div>}
      {tab === 'changes' && changes && <div className="dock-b" style={{ overflow: 'hidden' }}>{changes}</div>}
      <div className="dock-b" hidden={tab === 'history' || (tab === 'changes' && !!changes)} ref={body} onScroll={(e) => { const t = e.currentTarget; stick.current = t.scrollHeight - t.scrollTop - t.clientHeight < 24; }}>
        {tab === 'console' && (
          <div role="log" aria-live="polite">
            {problems.map((p, i) => {
              const id = idFromPath(p.file);
              return (
                <div key={`p${i}`} className="logl prob error">
                  <span className="t">problem</span><span className="src">{p.rule}</span>
                  <span className="m">{id ? <button onClick={() => onOpen(id)}>{problemPlace(p)}</button> : problemPlace(p)}{`  ${p.message}`}</span>
                </div>
              );
            })}
            {logs.map((l) => (
              <div key={l.id} className={`logl ${l.level}`}>
                <span className="t">{clock(l.at)}</span><span className="src">{l.source}</span>
                <span className="m">{l.message}{l.open && <> <button onClick={() => onOpen(l.open!)}>{l.open}</button></>}</span>
              </div>
            ))}
            {logs.length === 0 && problems.length === 0 && <div className="dock-empty">Nothing here yet. Build output, problems and what the game prints show up in the Console.</div>}
          </div>
        )}
        {tab === 'changes' && (
          <div>
            {journal.map((c, i) => (
              <div key={`${c.at}${i}`} className="hist" title={`${c.target} ${c.path}`}>
                <span className="mono" style={{ color: 'var(--faint)' }}>{clock(c.at)}</span>
                <span className={`who${c.by.startsWith('ai') ? ' ai' : ''}`}>{c.by === 'you' ? 'you' : c.by.replace(/^(ai|marl):/, '$1 ')}</span>
                <span className="mono tgt">{c.target}</span>
                <span className="mono chg">{c.path} {show(c.from)} {'→'} <span className="to">{show(c.to)}</span></span>
              </div>
            ))}
            {journal.length === 0 && <div className="dock-empty">No changes yet. Every edit, yours or the AI's, is recorded here with who made it.</div>}
          </div>
        )}
      </div>
    </section>
  );
}
