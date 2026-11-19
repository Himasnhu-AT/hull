// Share: Build writes the game to one JavaScript file with a page to open it, lists the files with their sizes and offers the folder.
//   rpc, project   as everywhere
//   onBack()       back to playing

import { useEffect, useState, type JSX } from 'react';
import type { OpenedProject } from '../../shared/appApi.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { fmtBytes, placeOf, useBuild, type BuildResult } from './useBuild.ts';

export interface ShareScreenProps { rpc: RpcClient; project: OpenedProject; onBack(): void }

export function ShareScreen({ rpc, project, onBack }: ShareScreenProps): JSX.Element {
  const b = useBuild(rpc, project.root);
  const [result, setResult] = useState<BuildResult | null>(null);
  const go = async (): Promise<void> => { setResult(null); const r = await b.run(); if (r) setResult(r); };
  // Seconds since Build was pressed, so a long build shows it is still going.
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (b.state !== 'running') { setSecs(0); return; }
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [b.state]);
  const [details, setDetails] = useState(false);
  return (
    <div className="cr-pad">
      <h2>Share it</h2>
      <p className="cr-sub">Build writes the whole game to one JavaScript file, with a page to open it. Put the folder on any website.</p>
      <div className="cr-row">
        <button className="btn primary lg" onClick={() => void go()} disabled={b.state === 'running'}>{b.state === 'running' ? `Building... ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : result?.ok === false ? 'Build again' : 'Build'}</button>
        <button className="btn lg" onClick={onBack}>Back to playing</button>
      </div>
      {b.state === 'running' && <p className="cr-sub sh-wait">Checking the code, then bundling the game. This usually takes under a minute.</p>}
      {result?.ok === false && (
        <div className="sh-fail" role="alert">
          <div className="sh-fail-h"><b>{result.problems.length > 0 ? `The build found ${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}` : 'The build did not finish'}</b></div>
          <p>{result.problems.length > 0 ? 'Fix these, or ask the builder to, then build again.' : 'Nothing was written. Press Build again; if it keeps failing, the details below say why.'}</p>
          {result.problems.length > 0 && <ul className="sh-probs">{result.problems.slice(0, 8).map((p, i) => <li key={i}><span className="mono">{placeOf(p)}</span><span>{p.message}</span></li>)}</ul>}
          {result.error && (
            <>
              <button className="cr-link" onClick={() => setDetails((d) => !d)}>{details ? 'Hide details' : 'Show details'}</button>
              {details && <pre className="cr-crash-text">{result.error}</pre>}
            </>
          )}
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
