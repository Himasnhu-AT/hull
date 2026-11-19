// Share: Build writes the game to one JavaScript file with a page to open it, lists the files with their sizes and offers the folder.
//   rpc, project   as everywhere
//   onBack()       back to playing

import { useState, type JSX } from 'react';
import type { OpenedProject } from '../../shared/appApi.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { fmtBytes, placeOf, useBuild, type BuildResult } from './useBuild.ts';

export interface ShareScreenProps { rpc: RpcClient; project: OpenedProject; onBack(): void }

export function ShareScreen({ rpc, project, onBack }: ShareScreenProps): JSX.Element {
  const b = useBuild(rpc, project.root);
  const [result, setResult] = useState<BuildResult | null>(null);
  const go = async (): Promise<void> => { setResult(null); const r = await b.run(); if (r) setResult(r); };
  return (
    <div className="cr-pad">
      <h2>Share it</h2>
      <p className="cr-sub">Build writes the whole game to one JavaScript file, with a page to open it. Put the folder on any website.</p>
      <div className="cr-row">
        <button className="btn primary lg" onClick={() => void go()} disabled={b.state === 'running'}>{b.state === 'running' ? 'Building...' : 'Build'}</button>
        <button className="btn lg" onClick={onBack}>Back to playing</button>
      </div>
      {result?.ok === false && (
        <div className="note-err" role="alert">
          {result.error ?? (result.problems.length === 0 ? 'The build failed with no details.' : `The build found ${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}:`)}
          {result.problems.slice(0, 8).map((p, i) => <div key={i} className="mono">{placeOf(p)}  {p.message}</div>)}
        </div>
      )}
      {result?.ok && (
        <div className="cr-built" role="status">
          <b>Built {result.files.length} file{result.files.length === 1 ? '' : 's'}{result.total ? `, ${fmtBytes(result.total)}` : ''}</b>
          <ul>{result.files.map((f) => <li key={f.path}><span className="mono">{f.path}</span><span className="cr-sub">{fmtBytes(f.bytes)}{f.gzip ? `, ${fmtBytes(f.gzip)} compressed` : ''}</span></li>)}</ul>
          <div className="cr-row"><button className="btn" onClick={() => void window.hullApp?.reveal(result.dir)}>Open folder</button><span className="cr-sub mono">{result.dir}</span></div>
        </div>
      )}
      <dl className="cr-facts">
        <dt>Website</dt><dd>Upload the folder to any static host. It opens with the page that Build writes.</dd>
        <dt>Desktop</dt><dd>Package wraps the same file as an app for this computer. It is a separate step and this screen does not run it.</dd>
      </dl>
    </div>
  );
}
