// The line you are editing: main or one experiment. It sits in the Game view's bar, next to the reload button.
// Starting an experiment here begins at the project's newest change.

import { useEffect, useRef, useState, type JSX } from 'react';
import { Icon } from '../ui/Icon.tsx';
import type { HistoryState } from './useHistory.ts';
import { laneColor } from './plain.ts';
import './history.css';

export function ExpSwitch({ h, openExp, onOpenExp }: { h: HistoryState; openExp: string | null; onOpenExp(name: string | null): void }): JSX.Element {
  const [menu, setMenu] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const active = h.exps.filter((e) => e.status === 'active');
  const lane = (n: string): number => 1 + [...h.exps].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).findIndex((e) => e.name === n);

  useEffect(() => {
    if (!menu) return;
    const off = (e: PointerEvent): void => { if (!box.current?.contains(e.target as Node)) { setMenu(false); setNaming(false); } };
    window.addEventListener('pointerdown', off);
    return () => window.removeEventListener('pointerdown', off);
  }, [menu]);

  const start = (): void => {
    const n = name.trim();
    if (!n) return;
    void h.startExp(n).then((e) => { if (e) { onOpenExp(e.name); setMenu(false); setNaming(false); setName(''); } });
  };

  return (
    <div className="hx-switch" ref={box}>
      <button className={`btn${openExp ? ' hx-editing' : ''}`} onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} title="Which line the Game view shows and the Inspector edits">
        <Icon name="branch" />{openExp ?? 'main'}<Icon name="chevron" size={11} style={{ transform: 'rotate(90deg)' }} />
      </button>
      {menu && (
        <div className="hx-menu glass" role="menu">
          <button role="menuitemradio" aria-checked={!openExp} className={`hx-mi${!openExp ? ' on' : ''}`} onClick={() => { onOpenExp(null); setMenu(false); }}>
            <i className="hx-dot" style={{ background: laneColor(0) }} />main<span className="hx-sub">the project</span>
          </button>
          {active.map((e) => (
            <button key={e.name} role="menuitemradio" aria-checked={openExp === e.name} className={`hx-mi${openExp === e.name ? ' on' : ''}`} onClick={() => { onOpenExp(e.name); setMenu(false); }}>
              <i className="hx-dot" style={{ background: laneColor(lane(e.name)) }} />{e.name}<span className="hx-sub">{e.changes === 0 ? 'untouched' : `${e.changes} change${e.changes === 1 ? '' : 's'}`}</span>
            </button>
          ))}
          <div className="hx-rule" />
          {!naming
            ? <button role="menuitem" className="hx-mi" onClick={() => { setName(`idea-${h.exps.length + 1}`); setNaming(true); }}><Icon name="plus" />Start an experiment here</button>
            : (
              <form className="hx-name" onSubmit={(e) => { e.preventDefault(); start(); }}>
                <input autoFocus className="field-in" value={name} onChange={(e) => setName(e.target.value)} aria-label="Experiment name" placeholder="Name" />
                <button className="btn primary" type="submit" disabled={!name.trim()}>Start</button>
              </form>
            )}
        </div>
      )}
    </div>
  );
}
