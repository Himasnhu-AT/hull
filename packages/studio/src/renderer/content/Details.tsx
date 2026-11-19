// The selected asset's dependency view: who names it ("Referenced by") and which assets its own file names ("Uses").
import type { JSX } from 'react';
import type { AssetRef } from 'hull/dev/protocol';
import { Icon } from '../ui/Icon.tsx';
import { Thumb } from './Thumb.tsx';
import type { ContentThumb } from 'hull/dev/protocol';
import type { Entry } from './model.ts';

export interface Refs { referencedBy: AssetRef[]; uses: { id: string; pointer?: string }[] }

const where = (r: AssetRef): string => (r.kind === 'config' ? `${r.id ?? r.file}${r.pointer ?? ''}` : `${r.file}:${r.line}`);

export function Details({ entry, thumb, refs, loading, onOpen, onReveal, onRename, onDuplicate, onDelete }: {
  entry: Entry; thumb: ContentThumb | undefined; refs: Refs | null; loading: boolean;
  onOpen(id: string): void; onReveal(path: string): void; onRename(): void; onDuplicate(): void; onDelete(): void;
}): JSX.Element {
  return (
    <aside className="cb-details" aria-label="Asset details">
      <div className="dt-top">
        <div className="dt-thumb"><Thumb kind={entry.kind} thumb={thumb} /></div>
        <div className="dt-id"><b title={entry.key}>{entry.name}</b><span className="kind">{entry.kind}</span></div>
        <button className="pathlink" onClick={() => onReveal(entry.path)} title="Show in Finder"><Icon name="folder" /><span>{entry.path}</span></button>
        {entry.problems > 0 && <div className="dt-prob"><Icon name="warn" />{entry.problems} problem{entry.problems === 1 ? '' : 's'}</div>}
        {entry.config && (
          <div className="dt-act">
            <button className="btn" onClick={onRename}><Icon name="edit" />Rename</button>
            <button className="btn" onClick={onDuplicate}><Icon name="copy" />Duplicate</button>
            <button className="btn" onClick={onDelete}><Icon name="trash" />Delete</button>
          </div>
        )}
      </div>
      {entry.config ? (
        <div className="dt-lists">
          <h4>Referenced by{refs && <span>{refs.referencedBy.length}</span>}</h4>
          {loading && !refs && <div className="skeleton" style={{ height: 22, margin: '4px 14px' }} />}
          {refs && refs.referencedBy.length === 0 && <p className="dt-none">Nothing names this asset, so it can be deleted safely.</p>}
          {refs?.referencedBy.map((r, i) => (
            <button key={i} className="dt-row" onClick={() => (r.kind === 'config' && r.id ? onOpen(r.id) : onReveal(r.file))} title={`${r.file}:${r.line}:${r.col}`}>
              <Icon name={r.kind === 'code' ? 'console' : 'file'} /><span className="mono">{where(r)}</span>
            </button>
          ))}
          <h4>Uses{refs && <span>{refs.uses.length}</span>}</h4>
          {refs && refs.uses.length === 0 && <p className="dt-none">This asset names no other asset.</p>}
          {refs?.uses.map((u, i) => (
            <button key={i} className="dt-row" onClick={() => onOpen(u.id)}><Icon name="file" /><span className="mono">{u.id}</span>{u.pointer && <small>{u.pointer}</small>}</button>
          ))}
          <p className="dt-foot">Ids that code builds at run time ('sound/' + name) cannot be seen here.</p>
        </div>
      ) : <p className="dt-none" style={{ padding: '10px 14px' }}>{entry.kind === 'code' ? 'A code file. Double-click to show it in Finder.' : 'Edited in the Inspector.'}</p>}
    </aside>
  );
}
