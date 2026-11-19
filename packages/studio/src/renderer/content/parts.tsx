// Small parts of the Content Browser: the popup menu, the inline name editor and the modal.
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { Icon, type IconName } from '../ui/Icon.tsx';

export interface MenuItem { label: string; icon?: IconName; hint?: string; danger?: boolean; disabled?: boolean; run?(): void; sep?: boolean }

/** A popup menu at a point. Arrow keys move, Enter runs, Escape and an outside click close it. */
export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose(): void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [at, setAt] = useState(() => items.findIndex((i) => !i.sep && !i.disabled));
  useLayoutEffect(() => {
    const r = ref.current;
    if (r) setPos({ x: Math.max(8, Math.min(x, window.innerWidth - r.offsetWidth - 8)), y: Math.max(8, Math.min(y, window.innerHeight - r.offsetHeight - 8)) });
    r?.focus();
  }, [x, y]);
  useEffect(() => {
    const away = (e: PointerEvent): void => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('blur', onClose); };
  }, [onClose]);
  const step = (d: 1 | -1): void => {
    let i = at;
    for (let n = 0; n < items.length; n++) { i = (i + d + items.length) % items.length; if (!items[i]!.sep && !items[i]!.disabled) break; }
    setAt(i);
  };
  const run = (it: MenuItem): void => { if (it.disabled || it.sep) return; onClose(); it.run?.(); };
  return (
    <div ref={ref} className="cb-menu glass" role="menu" tabIndex={-1} style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); const it = items[at]; if (it) run(it); }
      }}
      onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => it.sep
        ? <div key={i} className="sep" role="separator" />
        : (
          <button key={i} role="menuitem" className={`mi${i === at ? ' on' : ''}${it.danger ? ' danger' : ''}`} disabled={it.disabled} onMouseEnter={() => setAt(i)} onClick={() => run(it)}>
            {it.icon ? <Icon name={it.icon} /> : <span className="gap" />}
            <span className="lb">{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ))}
    </div>
  );
}

/** An inline text box for a name. Enter keeps it, Escape drops it; both end on key-up (see lib/keys.ts for why). */
export function NameEdit({ value, onCommit, onCancel }: { value: string; onCommit(v: string): void; onCancel(): void }): JSX.Element {
  const [v, setV] = useState(value);
  const cancelled = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input ref={ref} className="cb-name-in" value={v} aria-label="Name" spellCheck={false}
      onChange={(e) => setV(e.target.value)} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') cancelled.current = true; }}
      onKeyUp={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
      onBlur={() => { if (cancelled.current || v === value) onCancel(); else onCommit(v.trim()); }} />
  );
}

/** A centred sheet over a dimmed page. Escape closes it. */
export function Modal({ title, onClose, children, foot }: { title: string; onClose(): void; children: ReactNode; foot?: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  return (
    <div className="cb-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="cb-modal glass" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <h3>{title}</h3>
        <div className="mb">{children}</div>
        {foot && <div className="mf">{foot}</div>}
      </div>
    </div>
  );
}
