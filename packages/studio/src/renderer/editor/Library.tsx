import { forwardRef, useMemo, useState, type JSX } from 'react';
import type { LibraryItem } from 'hull/dev/protocol';
import { leaveBox } from '../lib/keys.ts';
import { DOMAINS, groupLibrary, type Domain, type LibraryFilter } from '../lib/library.ts';
import { Icon, type IconName } from '../ui/Icon.tsx';

const DOMAIN_ICON: Record<Domain, IconName> = {
  Gameplay: 'gameplay', Characters: 'characters', Audio: 'audio', World: 'world', Interface: 'interface', Input: 'input', Other: 'other',
};
void DOMAINS;

interface Props {
  items: LibraryItem[] | null;
  error: string | null;
  selected: string | null;
  changed: ReadonlySet<string>;
  onSelect(id: string): void;
}

export const Library = forwardRef<HTMLInputElement, Props>(function Library({ items, error, selected, changed, onSelect }, searchRef): JSX.Element {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [closed, setClosed] = useState<ReadonlySet<Domain>>(new Set());
  const groups = useMemo(() => groupLibrary(items ?? [], { query, filter, changed }), [items, query, filter, changed]);
  const searching = query.trim() !== '' || filter !== 'all';
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

  return (
    <aside className="lib" aria-label="Library">
      <div style={{ padding: '10px 10px 6px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label className="search">
          <Icon name="search" />
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find anything" aria-label="Find in the Library"
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }} onKeyUp={leaveBox} />
          {query ? <button className="rs" style={{ opacity: 1, pointerEvents: 'auto' }} onClick={() => setQuery('')} aria-label="Clear search"><Icon name="close" /></button> : <span className="kbd">{mac ? '⌘K' : 'Ctrl K'}</span>}
        </label>
        <div className="seg full" role="group" aria-label="Filter">
          {(['all', 'changed', 'problems'] as const).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'changed' ? 'Changed' : 'Problems'}</button>
          ))}
        </div>
      </div>
      <div style={{ overflow: 'auto', padding: '0 6px 12px', flex: 1, minHeight: 0 }}>
        {items === null && !error && <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 4px' }}><div className="skeleton" style={{ height: 28 }} /><div className="skeleton" style={{ height: 28 }} /><div className="skeleton" style={{ height: 28 }} /></div>}
        {error && <p className="empty-note">The Library could not load: {error}</p>}
        {groups.map((g) => {
          const open = searching || !closed.has(g.domain);
          return (
            <div key={g.domain}>
              <button className={`dom${open ? ' open' : ''}`} aria-expanded={open}
                onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(g.domain)) n.delete(g.domain); else n.add(g.domain); return n; })}>
                <Icon name="chevron" className="chev" />
                <Icon name={DOMAIN_ICON[g.domain]} />
                {g.domain}
                {g.attention && <span className="dot" title="Something here has a problem" />}
                <span className="n">{g.count}</span>
              </button>
              {open && g.rows.map((r) => r.type === 'sub'
                ? <div key={`s:${g.domain}:${r.label}`} className="sub">{r.label}</div>
                : (
                  <button key={r.item.id} className={`row${r.item.id === selected ? ' sel' : ''}${r.item.path ? '' : ''}`} aria-pressed={r.item.id === selected} onClick={() => onSelect(r.item.id)} title={r.item.note ?? r.item.path}>
                    <span className="nm">{r.short}</span><span className="kd">{r.item.kind}</span>
                    {changed.has(r.item.id) && <span className="edot" title="Changed in this session" />}
                    {r.item.problems > 0 && <span className="st-warn" title={`${r.item.problems} problem${r.item.problems === 1 ? '' : 's'}`}><Icon name="warn" /></span>}
                  </button>
                ))}
            </div>
          );
        })}
        {items !== null && groups.length === 0 && (
          <p className="empty-note">{items.length === 0 ? 'This project has no config files or tunables yet. Ask the AI to add some, and they appear here.' : filter === 'problems' ? 'No problems. Everything validates.' : filter === 'changed' ? 'Nothing changed in this session yet.' : `Nothing matches "${query}".`}</p>
        )}
      </div>
    </aside>
  );
});
