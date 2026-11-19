// The preview of a card. The content browser's Thumb draws most kinds; a theme, an input map and the two animation kinds would
// show only an icon there, so this reads the config (one config.read) and draws swatches, keys or names instead.

import { useEffect, useState, type JSX } from 'react';
import type { ContentThumb } from 'hull/dev/protocol';
import { Thumb } from '../content/Thumb.tsx';
import { PREVIEW_KINDS, previewOf, type ConfigPreview } from './configPreview.ts';
import { useBuilder } from './useBuilder.tsx';

function usePreview(id: string, kind: string, wanted: boolean): ConfigPreview | null {
  const { rpc } = useBuilder();
  const [p, setP] = useState<ConfigPreview | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    const load = (): void => { rpc.call('config.read', { id }).then((r) => { if (live) setP(previewOf(kind, r.value)); }, () => { /* the card keeps its icon */ }); };
    const offs = [rpc.onStatus((s) => { if (s === 'open') load(); }), rpc.on('config.changed', (c) => { if (c.id === id) load(); })];
    if (rpc.status === 'open') load();
    return () => { live = false; offs.forEach((o) => o()); };
  }, [rpc, id, kind, wanted]);
  return wanted ? p : null;
}

export function PieceThumb({ id, kind, thumb }: { id: string; kind: string; thumb: ContentThumb | undefined }): JSX.Element {
  const p = usePreview(id, kind, thumb === undefined && PREVIEW_KINDS.has(kind));
  if (!p) return <Thumb kind={kind} thumb={thumb} />;
  return (
    <div className={`ct cr-cfg cr-cfg-${p.type}`} aria-hidden="true">
      {p.type === 'swatches' && (
        <div className="cr-sw-row">
          {p.swatches.map((s) => <span key={s.name} className="cr-swatch" title={`${s.name} ${s.color}`}><i style={{ background: s.color }} /><small>{s.name}</small></span>)}
          {p.more > 0 && <small className="cr-more">+{p.more}</small>}
        </div>
      )}
      {p.type === 'keys' && (
        <ul className="cr-keys">
          {p.rows.map((r) => <li key={r.action}><span>{r.action}</span><kbd>{r.keys || '-'}</kbd></li>)}
          {p.more > 0 && <li className="cr-more">and {p.more} more</li>}
        </ul>
      )}
      {p.type === 'names' && (
        <div className="cr-names">
          <small>{p.label}</small>
          <p>{p.names.map((n) => <span key={n} className="chip">{n}</span>)}{p.more > 0 && <span className="cr-more">+{p.more}</span>}</p>
        </div>
      )}
    </div>
  );
}
