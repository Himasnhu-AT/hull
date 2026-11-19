// The Content Browser: the project's folders and assets, organised the way Unreal's is. The folder tree on the left, tiles or a
// list on the right, a details pane with "Referenced by" and "Uses". It shares ONE selection with the Library (the id the Editor
// holds), and every change of the project goes through the asset tools of the project server: the Studio never touches the disk.
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { AssetRef, AssetResult, ContentThumb, LibraryItem } from 'hull/dev/protocol';
import { leaveBox } from '../lib/keys.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { Icon } from '../ui/Icon.tsx';
import { Details, type Refs } from './Details.tsx';
import { buildEntries, buildFolders, canDrop, canDropFolder, childFolders, chipsIn, countIn, crumbs, filterEntries, folderName, idIn, isFiltering, kindOfDir, parentDir, uniqueName, validName, visibleEntries, type Entry, type Filter } from './model.ts';
import { Menu, Modal, NameEdit, type MenuItem } from './parts.tsx';
import { Thumb } from './Thumb.tsx';
import './content.css';

interface Data { folders: string[]; code: { path: string; bytes: number }[]; creatable: string[]; thumbs: Record<string, ContentThumb> }

interface Props {
  rpc: RpcClient;
  items: LibraryItem[] | null;
  error: string | null;
  selected: string | null;
  changed: ReadonlySet<string>;
  /** Selecting: the same call the Library makes. */
  onSelect(id: string): void;
  /** Double-click or Enter: the asset's bench, or the Inspector. */
  onOpen(id: string): void;
  onReveal(path: string): void;
  notify(text: string, error?: boolean): void;
  wide: boolean;
  onWide(): void;
}

type Nav = { t: 'folder'; dir: string; key: string } | { t: 'entry'; e: Entry; key: string };
type Dialog =
  | { type: 'blocked'; what: string; refs: AssetRef[]; message?: string }
  | { type: 'confirm-delete'; label: string; ids: string[]; folders: string[] }
  | { type: 'move'; keys: string[] }
  | { type: 'folder'; under: string }
  | { type: 'problem'; title: string; lines: string[] };

const pref = <T,>(key: string, d: T): T => { try { const v = localStorage.getItem(key); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } };
const save = (key: string, v: unknown): void => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage may be blocked */ } };
const KIND_LABEL: Record<string, string> = { 'input-map': 'input-map' };
const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

export function ContentBrowser(p: Props): JSX.Element {
  const { rpc, items, selected, changed, onSelect, onOpen, onReveal, notify } = p;
  const [data, setData] = useState<Data | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [dir, setDir] = useState('');
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<ReadonlySet<string>>(new Set());
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>(() => pref('hull.content.view', 'grid'));
  const [size, setSize] = useState<number>(() => pref('hull.content.size', 84));
  const [multi, setMulti] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [drag, setDrag] = useState<string[] | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set(['']));
  const [refs, setRefs] = useState<{ key: string; refs: Refs } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => save('hull.content.view', view), [view]);
  useEffect(() => save('hull.content.size', size), [size]);

  // The server's tree and previews; refetched when the Library list changes (a config changed, was added or removed).
  const load = useCallback(() => {
    rpc.call('content.list', {}).then((d) => { setData(d); setFailure(null); }, (e: Error) => setFailure(e.message));
  }, [rpc]);
  useEffect(() => { load(); }, [load, items]);

  const entries = useMemo(() => buildEntries(items ?? [], data?.code ?? []), [items, data]);
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const folders = useMemo(() => buildFolders(data?.folders ?? [], entries), [data, entries]);
  const filter: Filter = useMemo(() => ({ query, kinds, changed: onlyChanged, problems: onlyProblems, changedKeys: changed }), [query, kinds, onlyChanged, onlyProblems, changed]);
  const filtering = isFiltering(filter);

  // A folder that no longer exists (renamed, deleted) falls back to its nearest parent.
  useEffect(() => { if (data && dir && !folders.has(dir)) { let d = dir; while (d && !folders.has(d)) d = parentDir(d); setDir(d); } }, [data, dir, folders]);

  const shown = useMemo(() => visibleEntries(filterEntries(entries, filter), dir, filtering), [entries, filter, dir, filtering]);
  const subfolders = useMemo(() => (filtering ? [] : childFolders(folders, dir)), [filtering, folders, dir]);
  const nav: Nav[] = useMemo(() => [
    ...subfolders.map((d): Nav => ({ t: 'folder', dir: d, key: `dir:${d}` })),
    ...shown.map((e): Nav => ({ t: 'entry', e, key: e.key })),
  ], [subfolders, shown]);
  const chips = useMemo(() => chipsIn(entries), [entries]);

  // One selection with the Library: a selection made there shows here (and opens the folder it is in).
  useEffect(() => {
    if (!selected || multi.has(selected)) return;
    const e = byKey.get(selected);
    if (!e) return;
    setMulti(new Set([selected]));
    setAnchor(selected);
    if (!filtering && e.dir !== dir) setDir(e.dir);
  }, [selected, byKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.getElementById(`cb-${CSS.escape(selected ?? '')}`)?.scrollIntoView({ block: 'nearest' }); }, [selected, dir]);

  // A just-created asset opens in rename mode as soon as the list has it.
  useEffect(() => { if (pending && byKey.has(pending)) { setRenaming(pending); setMulti(new Set([pending])); onSelect(pending); setPending(null); } }, [pending, byKey, onSelect]);

  const entryOf = selected ? byKey.get(selected) ?? null : null;
  useEffect(() => {
    if (!entryOf || !entryOf.config) { setRefs(null); return; }
    let live = true;
    rpc.call('asset.refs', { id: entryOf.key }).then((r) => { if (live) setRefs({ key: entryOf.key, refs: { referencedBy: r.referencedBy, uses: r.uses } }); }, () => { if (live) setRefs(null); });
    return () => { live = false; };
  }, [rpc, entryOf?.key, entryOf?.config, items]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Operations (each one is a tool call; a refusal is shown with its reasons) ----------------------------------------------
  const settle = useCallback((r: AssetResult, ok: string, what: string): boolean => {
    if (r.ok) { notify(ok); load(); return true; }
    if (r.refs && r.refs.length) setDialog({ type: 'blocked', what, refs: r.refs, message: r.problems[0]?.message });
    else setDialog({ type: 'problem', title: `Could not ${what}`, lines: r.problems.map((x) => x.message) });
    return false;
  }, [notify, load]);
  const guard = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try { await fn(); } catch (e) { notify(e instanceof Error ? e.message : String(e), true); } finally { setBusy(false); }
  }, [notify]);

  const newAsset = (kind: string, at?: string): void => void guard(async () => {
    const target = at && kindOfDir(at) === kind ? at : kindOfDir(dir) === kind ? dir : `config/${kind}`;
    const name = uniqueName(entries, target, `new-${kind}`);
    const id = idIn(target, name);
    const r = await rpc.call('asset.new', { kind, id });
    if (settle(r, `Created ${id}`, `create ${id}`)) { setDir(target); setPending(id); }
  });
  const duplicate = (keys: string[]): void => void guard(async () => {
    let last = '';
    for (const k of keys) {
      const r = await rpc.call('asset.duplicate', { id: k });
      if (!settle(r, `Duplicated ${k}`, `duplicate ${k}`)) return;
      last = r.created?.[0] ?? last;
    }
    if (last) { setPending(null); setMulti(new Set([last])); setAnchor(last); onSelect(last); }
  });
  const rename = (key: string, name: string): void => {
    setRenaming(null);
    const e = byKey.get(key);
    const folder = key.startsWith('dir:');
    const from = folder ? key.slice(4) : e?.dir ?? '';
    if (!validName(name)) { notify(`${JSON.stringify(name)} is not a name: use letters, digits, - _ and .`, true); return; }
    void guard(async () => {
      const id = folder ? from.slice('config/'.length) : key;
      const to = folder ? `${parentDir(from).slice('config/'.length)}${parentDir(from) ? '/' : ''}${name}` : idIn(e!.dir, name);
      const r = await rpc.call('asset.rename', { id, to });
      const n = r.refs?.length ?? 0;
      if (settle(r, `Renamed to ${to}${n ? `. ${n} reference${n === 1 ? '' : 's'} updated` : ''}`, `rename ${id}`)) {
        if (folder) { if (dir === from || dir.startsWith(from + '/')) setDir(`config/${to}${dir.slice(from.length)}`); }
        else { setMulti(new Set([to])); setAnchor(to); if (selected === key) onSelect(to); }
      }
    });
  };
  const moveTo = (keys: string[], target: string): void => void guard(async () => {
    const ids = keys.map((k) => (k.startsWith('dir:') ? k.slice(4 + 'config/'.length) : k));
    const r = await rpc.call('asset.move', { ids, folder: target.slice('config/'.length) });
    const n = r.refs?.length ?? 0;
    if (settle(r, `Moved ${ids.length} to ${target.slice('config/'.length)}${n ? `. ${n} reference${n === 1 ? '' : 's'} updated` : ''}`, 'move')) {
      const moved = byKey.get(selected ?? '');
      if (moved && keys.includes(moved.key)) onSelect(`${target.slice('config/'.length)}/${moved.name}`);
      setMulti(new Set());
    }
  });
  const deleteKeys = (keys: string[]): void => void guard(async () => {
    const ids = keys.filter((k) => byKey.get(k)?.config);
    const folderKeys = keys.filter((k) => k.startsWith('dir:')).map((k) => k.slice(4 + 'config/'.length));
    if (ids.length + folderKeys.length === 0) return;
    // Look first: an asset something still names is refused before anyone is asked to confirm.
    const set = new Set(ids);
    const blocking: AssetRef[] = [];
    for (const id of ids) {
      const r = await rpc.call('asset.refs', { id });
      blocking.push(...r.referencedBy.filter((x) => !(x.kind === 'config' && x.id && set.has(x.id))));
    }
    const label = ids.length + folderKeys.length === 1 ? (ids[0] ?? folderKeys[0]!) : `${ids.length + folderKeys.length} items`;
    if (blocking.length) setDialog({ type: 'blocked', what: label, refs: blocking });
    else setDialog({ type: 'confirm-delete', label, ids, folders: folderKeys });
  });
  const reallyDelete = (d: Extract<Dialog, { type: 'confirm-delete' }>): void => {
    setDialog(null);
    void guard(async () => {
      const r = await rpc.call('asset.delete', { ids: [...d.ids, ...d.folders] });
      if (settle(r, `Deleted ${d.label}`, `delete ${d.label}`)) setMulti(new Set());
    });
  };
  const newFolder = (under: string, name: string): void => {
    setDialog(null);
    if (!validName(name)) { notify('Folder names use letters, digits, - _ and .', true); return; }
    void guard(async () => {
      const path = `${under.slice('config/'.length)}/${name}`;
      const r = await rpc.call('folder.new', { path });
      if (settle(r, `Created folder ${path}`, 'create the folder')) setDir(`config/${path}`);
    });
  };

  const open_ = (n: Nav): void => {
    if (n.t === 'folder') { setDir(n.dir); setMulti(new Set()); return; }
    if (n.e.kind === 'code') { onReveal(n.e.path); return; }
    onSelect(n.e.key);
    onOpen(n.e.key);
  };

  // ---- Selection ----------------------------------------------------------------------------------------------------------
  const pick = (n: Nav, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): void => {
    if (e.shiftKey && anchor) {
      const a = nav.findIndex((x) => x.key === anchor), b = nav.findIndex((x) => x.key === n.key);
      if (a >= 0 && b >= 0) { setMulti(new Set(nav.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.key))); }
    } else if (e.metaKey || e.ctrlKey) {
      setMulti((m) => { const s = new Set(m); if (s.has(n.key)) s.delete(n.key); else s.add(n.key); return s; });
      setAnchor(n.key);
    } else { setMulti(new Set([n.key])); setAnchor(n.key); }
    if (n.t === 'entry' && n.e.kind !== 'code') onSelect(n.e.key);
  };
  const keysFor = (n: Nav): string[] => (multi.has(n.key) ? [...multi] : [n.key]);

  // ---- Menus ---------------------------------------------------------------------------------------------------------------
  const creatable = data?.creatable ?? [];
  const newItems = (at?: string): MenuItem[] => creatable.map((k) => ({ label: k, icon: 'plus' as const, run: () => newAsset(k, at) }));
  const menuFor = (n: Nav, x: number, y: number): void => {
    if (!multi.has(n.key)) { setMulti(new Set([n.key])); setAnchor(n.key); if (n.t === 'entry' && n.e.kind !== 'code') onSelect(n.e.key); }
    const keys = keysFor(n);
    const entriesSel = keys.map((k) => byKey.get(k)).filter((e): e is Entry => !!e);
    const assets = entriesSel.filter((e) => e.config);
    const folderKeys = keys.filter((k) => k.startsWith('dir:') && kindOfDir(k.slice(4)) !== null);
    const mixed = [...assets.map((a) => a.key), ...folderKeys];
    const list: MenuItem[] = [{ label: 'Open', icon: 'file', hint: 'Enter', run: () => open_(n) }];
    if (n.t === 'entry') list.push({ label: 'Show in Finder', icon: 'folder', run: () => onReveal(n.e.path) });
    if (mixed.length) {
      list.push({ sep: true, label: '' });
      if (keys.length === 1) list.push({ label: 'Rename', icon: 'edit', hint: 'F2', run: () => setRenaming(keys[0]!) });
      if (assets.length) list.push({ label: 'Duplicate', icon: 'copy', hint: mac ? '⌘D' : 'Ctrl D', run: () => duplicate(assets.map((a) => a.key)) });
      list.push({ label: 'Move to folder...', icon: 'move', run: () => setDialog({ type: 'move', keys: mixed }) });
      list.push({ label: 'Delete', icon: 'trash', hint: 'Del', danger: true, run: () => deleteKeys(mixed) });
    }
    if (n.t === 'folder' && kindOfDir(n.dir)) {
      list.push({ sep: true, label: '' }, { label: 'New asset here', icon: 'plus', run: () => newAsset(kindOfDir(n.dir)!, n.dir) }, { label: 'New folder inside', icon: 'newfolder', run: () => setDialog({ type: 'folder', under: n.dir }) });
    }
    setMenu({ x, y, items: list });
  };
  const emptyMenu = (x: number, y: number): void => {
    setMenu({ x, y, items: [...(dir === '' || kindOfDir(dir) ? [{ label: 'New folder', icon: 'newfolder' as const, run: () => setDialog({ type: 'folder', under: kindOfDir(dir) ? dir : `config/${creatable[0] ?? 'sound'}` }) }] : []), { sep: true, label: '' }, ...newItems()] });
  };

  // ---- Keyboard ----------------------------------------------------------------------------------------------------------
  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if ((ev.target as HTMLElement).tagName === 'INPUT') return;
    const cols = view === 'list' ? 1 : Math.max(1, (getComputedStyle(grid.current!).gridTemplateColumns.split(' ').length));
    const cur = nav.findIndex((n) => n.key === (anchor ?? ''));
    const go = (i: number): void => {
      const n = nav[Math.max(0, Math.min(nav.length - 1, i))];
      if (!n) return;
      ev.preventDefault();
      pick(n, { metaKey: false, ctrlKey: false, shiftKey: ev.shiftKey && cur >= 0 });
      if (ev.shiftKey && cur >= 0) setAnchor(anchor);
    };
    const mod = ev.metaKey || ev.ctrlKey;
    const cNav = nav[cur];
    if (ev.key === 'ArrowRight') go(cur + 1);
    else if (ev.key === 'ArrowLeft') go(cur - 1);
    else if (ev.key === 'ArrowDown') go(cur < 0 ? 0 : cur + cols);
    else if (ev.key === 'ArrowUp') go(cur < 0 ? 0 : cur - cols);
    else if (ev.key === 'Enter' && cNav) { ev.preventDefault(); open_(cNav); }
    else if (ev.key === 'F2' && cNav) { ev.preventDefault(); if (cNav.t === 'folder' || cNav.e.config) setRenaming(cNav.key); }
    else if ((ev.key === 'Delete' || ev.key === 'Backspace') && multi.size) { ev.preventDefault(); deleteKeys([...multi]); }
    else if (mod && ev.key.toLowerCase() === 'd' && multi.size) { ev.preventDefault(); duplicate([...multi].filter((k) => byKey.get(k)?.config)); }
    else if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); setMulti(new Set(nav.map((n) => n.key))); }
    else if (ev.key === 'Escape') { setMulti(new Set()); }
    else if (ev.key === 'Backspace' && dir) setDir(parentDir(dir));
  };

  // ---- Drag and drop -----------------------------------------------------------------------------------------------------
  const dragged = (): Entry[] => (drag ?? []).map((k) => byKey.get(k)).filter((e): e is Entry => !!e);
  const droppable = (target: string): boolean => {
    if (!drag) return false;
    const folderDrags = drag.filter((k) => k.startsWith('dir:'));
    const rest = dragged();
    return (rest.length === 0 || canDrop(rest, target)) && folderDrags.every((k) => canDropFolder(k.slice(4), target)) && (rest.length + folderDrags.length) === drag.length;
  };
  const dropProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => { if (droppable(target)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropOn(target); } },
    onDragLeave: () => setDropOn((d) => (d === target ? null : d)),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); const keys = drag; setDropOn(null); setDrag(null); if (keys && droppable(target)) moveTo(keys, target); },
  });
  const dragProps = (n: Nav) => ({
    draggable: n.t === 'folder' ? kindOfDir(n.dir) !== null && parentDir(n.dir) !== '' : n.e.config,
    onDragStart: (e: React.DragEvent) => { const keys = keysFor(n); setDrag(keys); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', keys.join('\n')); },
    onDragEnd: () => { setDrag(null); setDropOn(null); },
  });

  // ---- Rendering ------------------------------------------------------------------------------------------------------------
  const Name = ({ n, name }: { n: Nav; name: string }): JSX.Element =>
    renaming === n.key ? <NameEdit value={name} onCommit={(v) => rename(n.key, v)} onCancel={() => setRenaming(null)} /> : <span className="nm" title={n.t === 'entry' ? n.e.key : n.dir}>{name}</span>;

  const badges = (e: Entry): JSX.Element => (
    <>
      {changed.has(e.key) && <span className="edot" title="Changed in this session" />}
      {e.problems > 0 && <span className="cb-prob" title={`${e.problems} problem${e.problems === 1 ? '' : 's'}`}><Icon name="warn" /></span>}
    </>
  );

  const tile = (n: Nav): JSX.Element => {
    const on = multi.has(n.key);
    if (n.t === 'folder') {
      return (
        <div key={n.key} id={`cb-${n.key}`} className={`cb-tile folder${on ? ' sel' : ''}${dropOn === n.dir ? ' drop' : ''}`} role="option" aria-selected={on}
          onClick={(e) => pick(n, e)} onDoubleClick={() => open_(n)} onContextMenu={(e) => { e.preventDefault(); menuFor(n, e.clientX, e.clientY); }} {...dragProps(n)} {...dropProps(n.dir)}>
          <div className="ct ct-folder"><Icon name="folder" /><small>{countIn(entries, n.dir)}</small></div>
          <Name n={n} name={folderName(n.dir)} />
        </div>
      );
    }
    const e = n.e;
    return (
      <div key={n.key} id={`cb-${n.key}`} className={`cb-tile${on ? ' sel' : ''}${drag?.includes(n.key) ? ' dragging' : ''}`} role="option" aria-selected={on}
        onClick={(ev) => pick(n, ev)} onDoubleClick={() => open_(n)} onContextMenu={(ev) => { ev.preventDefault(); menuFor(n, ev.clientX, ev.clientY); }} {...dragProps(n)}>
        <div className="cb-thumb"><Thumb kind={e.kind} thumb={data?.thumbs[e.key]} />{badges(e)}</div>
        <Name n={n} name={e.name} />
        <span className="kd">{KIND_LABEL[e.kind] ?? e.kind}</span>
      </div>
    );
  };

  const row = (n: Nav): JSX.Element => {
    const on = multi.has(n.key);
    const isFolder = n.t === 'folder';
    const e = n.t === 'entry' ? n.e : null;
    return (
      <div key={n.key} id={`cb-${n.key}`} className={`cb-row${on ? ' sel' : ''}${isFolder && dropOn === n.dir ? ' drop' : ''}`} role="option" aria-selected={on}
        onClick={(ev) => pick(n, ev)} onDoubleClick={() => open_(n)} onContextMenu={(ev) => { ev.preventDefault(); menuFor(n, ev.clientX, ev.clientY); }} {...dragProps(n)} {...(n.t === 'folder' ? dropProps(n.dir) : {})}>
        <span className="rt">{e ? <Thumb kind={e.kind} thumb={data?.thumbs[e.key]} /> : <div className="ct ct-folder"><Icon name="folder" /></div>}</span>
        <Name n={n} name={e ? e.name : folderName((n as { dir: string }).dir)} />
        <span className="kd">{e ? e.kind : 'folder'}</span>
        <span className="loc">{e ? (filtering ? e.dir.replace(/^config\//, '') : '') : `${countIn(entries, (n as { dir: string }).dir)} items`}</span>
        <span className="st">{e && badges(e)}</span>
      </div>
    );
  };

  const treeNode = (d: string, depth: number): JSX.Element => {
    const kids = childFolders(folders, d);
    const isOpen = open.has(d) || (d !== '' && (dir === d || dir.startsWith(d + '/')) && !open.has('~' + d));
    const here = dir === d;
    return (
      <div key={d || 'root'} role="treeitem" aria-expanded={kids.length ? isOpen : undefined} aria-selected={here}>
        <div className={`tn${here ? ' on' : ''}${dropOn === d && d ? ' drop' : ''}`} style={{ paddingLeft: 6 + depth * 14 }} onClick={() => { setDir(d); setMulti(new Set()); }}
          onContextMenu={(e) => { if (!d) return; e.preventDefault(); menuFor({ t: 'folder', dir: d, key: `dir:${d}` }, e.clientX, e.clientY); }}
          {...(d ? dropProps(d) : {})}>
          <button className={`chev${isOpen ? ' open' : ''}${kids.length ? '' : ' none'}`} tabIndex={-1} aria-label={isOpen ? 'Collapse' : 'Expand'}
            onClick={(e) => { e.stopPropagation(); setOpen((s) => { const n = new Set(s); if (isOpen) { n.delete(d); n.add('~' + d); } else { n.add(d); n.delete('~' + d); } return n; }); }}><Icon name="chevron" /></button>
          <Icon name={d === '' ? 'lib' : d === 'src' ? 'console' : 'folder'} />
          <span className="nm">{d === '' ? 'All content' : d.startsWith('config/') && d.split('/').length === 2 ? d.slice(7) : folderName(d)}</span>
          <span className="n">{countIn(entries, d)}</span>
        </div>
        {isOpen && kids.map((k) => treeNode(k, depth + 1))}
      </div>
    );
  };

  const loading = items === null && !p.error;
  const hasAny = entries.length > 0;
  const where_ = crumbs(dir);
  const none = nav.length === 0;

  return (
    <div className={`cb${p.wide ? ' wide' : ''}`} style={{ ['--tile' as string]: `${size}px` }}>
      <nav className="cb-tree" aria-label="Folders">
        <div className="th">Content</div>
        <div className="tb" role="tree">{data || items ? treeNode('', 0) : <div className="skeleton" style={{ height: 24, margin: 8 }} />}</div>
      </nav>

      <section className="cb-main">
        <div className="cb-bar">
          <ol className="cb-crumbs" aria-label="Location">
            {where_.map((c, i) => (
              <li key={c.dir} className={dropOn === c.dir && c.dir ? 'drop' : ''} {...(c.dir ? dropProps(c.dir) : {})}>
                {i > 0 && <Icon name="chevron" className="sepi" />}
                <button className={i === where_.length - 1 ? 'here' : ''} aria-current={i === where_.length - 1 ? 'location' : undefined} onClick={() => setDir(c.dir)}>{c.label}</button>
              </li>
            ))}
          </ol>
          <div className="cb-tools">
            <label className="search cb-search">
              <Icon name="search" />
              <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search content" aria-label="Search content" onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }} onKeyUp={leaveBox} />
              {query && <button className="rs" style={{ opacity: 1, pointerEvents: 'auto' }} onClick={() => setQuery('')} aria-label="Clear search"><Icon name="close" /></button>}
            </label>
            <button className="btn" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4, items: newItems() }); }} disabled={creatable.length === 0} aria-haspopup="menu"><Icon name="plus" />New</button>
            <button className="btn ghost cb-ic" onClick={() => setDialog({ type: 'folder', under: kindOfDir(dir) ? dir : `config/${creatable[0] ?? 'sound'}` })} title="New folder" aria-label="New folder"><Icon name="newfolder" /></button>
            <div className="seg" role="group" aria-label="View">
              <button className={view === 'grid' ? 'on' : ''} aria-pressed={view === 'grid'} onClick={() => setView('grid')} title="Tiles" aria-label="Tiles"><Icon name="grid" /></button>
              <button className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')} title="List" aria-label="List"><Icon name="list" /></button>
            </div>
            <input className="cb-size" type="range" min={56} max={160} step={4} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Thumbnail size" disabled={view === 'list'} />
            <button className="btn ghost cb-ic" onClick={p.onWide} title={p.wide ? 'Back to the dock' : 'Pop out to full width'} aria-label={p.wide ? 'Back to the dock' : 'Pop out to full width'} aria-pressed={p.wide}><Icon name={p.wide ? 'shrink' : 'expand'} /></button>
          </div>
        </div>

        <div className="cb-chips" role="group" aria-label="Filters">
          {chips.map((k) => (
            <button key={k} className={`chip${kinds.has(k) ? ' on' : ''}`} aria-pressed={kinds.has(k)} onClick={() => setKinds((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>{k}</button>
          ))}
          <span className="vr" />
          <button className={`chip${onlyChanged ? ' on' : ''}`} aria-pressed={onlyChanged} onClick={() => setOnlyChanged((v) => !v)}><span className="edot" />Changed</button>
          <button className={`chip warn${onlyProblems ? ' on' : ''}`} aria-pressed={onlyProblems} onClick={() => setOnlyProblems((v) => !v)}><Icon name="warn" />Problems</button>
          {filtering && <button className="chip clear" onClick={() => { setQuery(''); setKinds(new Set()); setOnlyChanged(false); setOnlyProblems(false); }}>Clear</button>}
          <span className="cb-count" aria-live="polite">{loading ? '' : `${shown.length} item${shown.length === 1 ? '' : 's'}${subfolders.length ? `, ${subfolders.length} folder${subfolders.length === 1 ? '' : 's'}` : ''}${busy ? '  working...' : ''}`}</span>
        </div>

        <div className="cb-body" onContextMenu={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('cb-grid')) { e.preventDefault(); emptyMenu(e.clientX, e.clientY); } }}
          onClick={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('cb-grid')) setMulti(new Set()); }}>
          {(failure || p.error) && !hasAny && (
            <div className="cb-state" role="alert"><Icon name="warn" /><h4>The Content Browser could not load</h4><p>{failure ?? p.error}</p><button className="btn" onClick={load}><Icon name="reload" />Try again</button></div>
          )}
          {loading && !failure && <div className={`cb-grid${view === 'list' ? ' list' : ''}`}>{Array.from({ length: 12 }, (_, i) => <div key={i} className="cb-tile"><div className="cb-thumb skeleton" /><div className="skeleton" style={{ height: 12, width: '70%' }} /></div>)}</div>}
          {!loading && !failure && !hasAny && (
            <div className="cb-state"><Icon name="lib" /><h4>This project has no content yet</h4><p>Config files (sounds, materials, looks, characters) and code show up here. Make a first asset, or ask the AI to add some.</p>
              {creatable.length > 0 && <button className="btn" onClick={() => newAsset(creatable[0]!)}><Icon name="plus" />New {creatable[0]}</button>}</div>
          )}
          {!loading && hasAny && none && (
            <div className="cb-state">
              <Icon name={filtering ? 'search' : 'folder'} />
              <h4>{filtering ? 'Nothing matches' : 'This folder is empty'}</h4>
              <p>{filtering ? 'No asset fits the search and filters in this folder.' : kindOfDir(dir) ? 'Drag assets here from another folder, or make a new one.' : 'There is nothing in this folder.'}</p>
              {filtering ? <button className="btn" onClick={() => { setQuery(''); setKinds(new Set()); setOnlyChanged(false); setOnlyProblems(false); }}>Clear filters</button>
                : kindOfDir(dir) ? <button className="btn" onClick={() => newAsset(kindOfDir(dir)!, dir)}><Icon name="plus" />New {kindOfDir(dir)}</button> : null}
            </div>
          )}
          {!loading && !none && (
            <div ref={grid} className={`cb-grid${view === 'list' ? ' list' : ''}`} role="listbox" aria-multiselectable="true" aria-label="Assets" tabIndex={0} onKeyDown={onKeyDown}>
              {view === 'list' && <div className="cb-row head" aria-hidden="true"><span /><span>Name</span><span>Kind</span><span>{filtering ? 'Folder' : ''}</span><span /></div>}
              {nav.map((n) => (view === 'grid' ? tile(n) : row(n)))}
            </div>
          )}
        </div>
      </section>

      {entryOf && (
        <Details entry={entryOf} thumb={data?.thumbs[entryOf.key]} refs={refs && refs.key === entryOf.key ? refs.refs : null} loading={entryOf.config && !refs}
          onOpen={(id) => { onSelect(id); onOpen(id); }} onReveal={onReveal} onRename={() => setRenaming(entryOf.key)} onDuplicate={() => duplicate([entryOf.key])} onDelete={() => deleteKeys([entryOf.key])} />
      )}

      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {dialog?.type === 'blocked' && (
        <Modal title={`Can't delete ${dialog.what}`} onClose={() => setDialog(null)} foot={<button className="btn" onClick={() => setDialog(null)} autoFocus>Close</button>}>
          <p className="mp">{dialog.refs.length} place{dialog.refs.length === 1 ? ' still names' : 's still name'} {dialog.refs.length === 1 ? 'it' : 'it or one of them'}. Change or remove {dialog.refs.length === 1 ? 'that reference' : 'those references'} first; nothing was deleted.</p>
          <div className="cb-reflist">
            {dialog.refs.map((r, i) => (
              <div key={i} className="rr">
                <Icon name={r.kind === 'code' ? 'console' : 'file'} />
                <span className="mono">{r.kind === 'config' ? (r.id ?? r.file) + (r.pointer ?? '') : `${r.file}:${r.line}:${r.col}`}</span>
                <button className="btn ghost" onClick={() => { setDialog(null); if (r.kind === 'config' && r.id) { onSelect(r.id); onOpen(r.id); } else onReveal(r.file); }}>{r.kind === 'config' ? 'Open' : 'Show file'}</button>
              </div>
            ))}
          </div>
          <p className="help">Ids that code builds at run time cannot be seen, so check those by hand.</p>
        </Modal>
      )}
      {dialog?.type === 'confirm-delete' && (
        <Modal title={`Delete ${dialog.label}?`} onClose={() => setDialog(null)} foot={<><button className="btn" onClick={() => setDialog(null)}>Cancel</button><button className="btn danger" onClick={() => reallyDelete(dialog)} autoFocus>Delete</button></>}>
          <p className="mp">{dialog.folders.length ? 'Nothing names ' + (dialog.ids.length ? 'these assets' : 'the assets in it') + '. ' : 'Nothing else names it. '}The change is recorded in the history, so it can be restored from there.</p>
        </Modal>
      )}
      {dialog?.type === 'problem' && (
        <Modal title={dialog.title} onClose={() => setDialog(null)} foot={<button className="btn" onClick={() => setDialog(null)} autoFocus>Close</button>}>
          {dialog.lines.map((l, i) => <p key={i} className="mp">{l}</p>)}
        </Modal>
      )}
      {dialog?.type === 'folder' && <FolderDialog under={dialog.under} onCancel={() => setDialog(null)} onMake={newFolder} kindsOf={creatable} />}
      {dialog?.type === 'move' && <MoveDialog keys={dialog.keys} folders={folders} byKey={byKey} onCancel={() => setDialog(null)} onMove={(t) => { setDialog(null); moveTo(dialog.keys, t); }} />}
    </div>
  );
}

function FolderDialog({ under, onCancel, onMake, kindsOf }: { under: string; onCancel(): void; onMake(under: string, name: string): void; kindsOf: string[] }): JSX.Element {
  const [where, setWhere] = useState(under);
  const [name, setName] = useState('');
  void kindsOf;
  return (
    <Modal title="New folder" onClose={onCancel} foot={<><button className="btn" onClick={onCancel}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={() => onMake(where, name.trim())}>Create</button></>}>
      <label className="fld-l">Inside<input className="field-in" value={where.replace(/^config\//, '')} onChange={(e) => setWhere('config/' + e.target.value.replace(/^\/+|\/+$/g, ''))} spellCheck={false} aria-label="Parent folder" /></label>
      <label className="fld-l">Name<input className="field-in" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="combat" spellCheck={false} aria-label="Folder name"
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onMake(where, name.trim()); }} /></label>
    </Modal>
  );
}

function MoveDialog({ keys, folders, byKey, onCancel, onMove }: { keys: string[]; folders: ReadonlySet<string>; byKey: ReadonlyMap<string, Entry>; onCancel(): void; onMove(dir: string): void }): JSX.Element {
  const dragged = keys.map((k) => byKey.get(k)).filter((e): e is Entry => !!e);
  const kind = dragged[0]?.kind ?? kindOfDir(keys[0]?.slice(4) ?? '') ?? '';
  const options = [...folders].filter((f) => kindOfDir(f) === kind && !keys.includes('dir:' + f) && !keys.some((k) => k.startsWith('dir:') && (f + '/').startsWith(k.slice(4) + '/'))).sort();
  const [to, setTo] = useState(options[0] ?? '');
  return (
    <Modal title={`Move ${keys.length} to a folder`} onClose={onCancel} foot={<><button className="btn" onClick={onCancel}>Cancel</button><button className="btn primary" disabled={!to} onClick={() => onMove(to)}>Move</button></>}>
      {options.length === 0 ? <p className="mp">There is no other {kind} folder. Make one first.</p> : (
        <div className="cb-pick" role="listbox" aria-label="Folders">
          {options.map((o) => <button key={o} role="option" aria-selected={o === to} className={o === to ? 'on' : ''} onClick={() => setTo(o)} onDoubleClick={() => onMove(o)}><Icon name="folder" />{o.replace(/^config\//, '')}</button>)}
        </div>
      )}
      <p className="help">Anything that names a moved asset is updated in the same step.</p>
    </Modal>
  );
}
