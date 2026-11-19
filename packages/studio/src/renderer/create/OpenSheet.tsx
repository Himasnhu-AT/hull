// A piece opened over the shell: on its existing bench (sound, character, effect, look) or in the Inspector for the rest.
// Nothing here is new: it is the editor's own bench and Inspector in a sheet, so what they do stays as it is.

import { useEffect, type JSX, type MutableRefObject } from 'react';
import type { LibraryItem, TunableWire } from 'hull/dev/protocol';
import type { OpenedProject } from '../../shared/appApi.ts';
import { BenchView } from '../benches/Benches.tsx';
import { Inspector } from '../editor/Inspector.tsx';
import { SoundBench } from '../editor/SoundBench.tsx';
import type { RpcClient } from '../lib/rpc.ts';
import { Icon } from '../ui/Icon.tsx';
import { plainName } from './shelves.ts';

export interface OpenSheetProps {
  rpc: RpcClient;
  project: OpenedProject;
  item: LibraryItem;
  library: LibraryItem[];
  tunables: TunableWire[];
  baselines: MutableRefObject<Map<string, unknown>>;
  setTunableLocal(block: string, key: string, value: unknown): void;
  onClose(): void;
}

export function OpenSheet({ rpc, project, item, library, tunables, baselines, setTunableLocal, onClose }: OpenSheetProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const k = item.kind;
  const reveal = (path: string): void => { void window.hullApp?.reveal(path.startsWith('/') ? path : `${project.root}/${path}`); };
  return (
    <div className="cr-sheet-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cr-sheet" role="dialog" aria-modal="true" aria-label={plainName(item)}>
        <div className="cr-sheet-head"><b>{plainName(item)}</b><span className="cr-k">{item.id}</span><span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button></div>
        <div className="cr-sheet-body">
          {k === 'sound' && <div className="view"><div className="stage"><SoundBench rpc={rpc} gameUrl={project.gameUrl} sounds={[item]} selected={item.id} onSelect={() => {}} /></div></div>}
          {(k === 'character' || k === 'vfx' || k === 'look') && <div className="view"><div className="stage"><BenchView key={k} kind={k} rpc={rpc} gameUrl={project.gameUrl} items={library} selected={item.id} onSelect={() => {}} /></div></div>}
          {k !== 'sound' && k !== 'character' && k !== 'vfx' && k !== 'look' && (
            <Inspector rpc={rpc} item={item} library={library} tunables={tunables} baselines={baselines} setTunableLocal={setTunableLocal} onOpenSound={() => {}} reveal={reveal} />
          )}
        </div>
      </div>
    </div>
  );
}
