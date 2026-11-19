// One recent game on the launcher: its picture, its name, when it was last opened, and a ⋯ menu to rename it, show it in
// Finder, drop it from the list or move it to the Trash. Renaming edits the name in place; Enter keeps it, Escape does not.

import { useEffect, useRef, useState, type JSX } from 'react';
import type { HullApp, RecentProject } from '../../shared/appApi.ts';
import { Icon } from '../ui/Icon.tsx';

export interface RecentCardProps {
  app: HullApp; r: RecentProject; when: string; delay: number; disabled: boolean;
  onOpen(): void;
  /** The list changed (renamed, removed, trashed): `next` replaces the entry, null drops it. */
  onChange(next: RecentProject | null): void;
  onError(message: string): void;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function RecentCard({ app, r, when, delay, disabled, onOpen, onChange, onError }: RecentCardProps): JSX.Element {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(r.title);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menu) return;
    const out = (e: PointerEvent): void => { if (!box.current?.contains(e.target as Node)) { setMenu(false); setConfirm(false); } };
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { setMenu(false); setConfirm(false); } };
    window.addEventListener('pointerdown', out); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', out); window.removeEventListener('keydown', key); };
  }, [menu]);
  useEffect(() => { if (renaming) { field.current?.focus(); field.current?.select(); } }, [renaming]);

  const act = async (f: () => Promise<void>): Promise<void> => { setBusy(true); try { await f(); } catch (e) { onError(msg(e)); } finally { setBusy(false); } };
  const rename = (): void => {
    const t = name.trim();
    setRenaming(false);
    if (!t || t === r.title) { setName(r.title); return; }
    void act(async () => { const kept = await app.renameProject(r.root, t); onChange({ ...r, title: kept }); });
  };

  return (
    <div className={`l-rcard${menu ? ' menu' : ''}`} ref={box} style={{ animationDelay: `${delay}ms` }}>
      <button className="l-rpic" onClick={onOpen} disabled={disabled || busy || renaming} aria-label={`Open ${r.title}`} title={r.root}>
        {r.cover ? <img src={r.cover} alt="" draggable={false} /> : <span className="l-rmark" aria-hidden="true">{r.title.trim().charAt(0).toUpperCase() || '?'}</span>}
      </button>
      <div className="l-rbody">
        {renaming
          ? <input ref={field} className="l-rname" value={name} maxLength={80} aria-label="New name" onChange={(e) => setName(e.target.value)} onBlur={rename}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } else if (e.key === 'Escape') { setName(r.title); setRenaming(false); } }} />
          : <b title={r.title}>{r.title}</b>}
        <small>{busy ? 'One moment...' : when}</small>
      </div>
      <button className="l-rdots" aria-label={`More for ${r.title}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => { setMenu((m) => !m); setConfirm(false); }}><Icon name="more" size={16} /></button>
      {menu && (
        <div className="l-rmenu" role="menu">
          {!confirm ? (
            <>
              <button role="menuitem" onClick={() => { setMenu(false); onOpen(); }}><Icon name="play" size={13} />Open</button>
              <button role="menuitem" onClick={() => { setMenu(false); setName(r.title); setRenaming(true); }}><Icon name="edit" size={13} />Rename</button>
              <button role="menuitem" onClick={() => { setMenu(false); void app.reveal(r.root); }}><Icon name="folder" size={13} />Show in Finder</button>
              <hr />
              <button role="menuitem" onClick={() => { setMenu(false); void act(async () => { await app.forgetRecent(r.root); onChange(null); }); }}><Icon name="close" size={13} />Remove from list</button>
              <button role="menuitem" className="danger" onClick={() => setConfirm(true)}><Icon name="trash" size={13} />Move to Trash...</button>
            </>
          ) : (
            <div className="l-rconfirm" role="alertdialog" aria-label={`Move ${r.title} to the Trash`}>
              <p>Move <b>{r.title}</b> to the Trash? You can put it back from the Trash in Finder.</p>
              <div><button className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
                <button className="btn danger" onClick={() => { setMenu(false); setConfirm(false); void act(async () => { await app.trashProject(r.root); onChange(null); }); }}>Move to Trash</button></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
