// The compare view: two lines of the project running side by side, and the list of values that differ. Each row shows
// old → new and what adopting either side would do to the project.

import { useEffect, useState, type JSX } from 'react';
import type { ChangeDelta } from 'hull/dev/protocol';
import type { RpcClient } from '../lib/rpc.ts';
import { Icon } from '../ui/Icon.tsx';
import type { HistoryState } from './useHistory.ts';
import { laneColor, plain, say } from './plain.ts';
import './history.css';

interface Props { rpc: RpcClient; h: HistoryState; mainUrl: string; a: string; b: string; onPick(a: string, b: string): void; version: unknown }

const deltasKey = (d: ChangeDelta): string => `${d.target}#${d.path}`;

export function Compare({ rpc, h, mainUrl, a, b, onPick, version }: Props): JSX.Element {
  const active = h.exps.filter((e) => e.status === 'active');
  const lines = ['main', ...active.map((e) => e.name)];
  const urlOf = (n: string): string | undefined => (n === 'main' ? mainUrl : active.find((e) => e.name === n)?.gameUrl);
  const [diff, setDiff] = useState<ChangeDelta[] | null>(null);
  const [vsMain, setVsMain] = useState<{ a: ChangeDelta[]; b: ChangeDelta[] }>({ a: [], b: [] });
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDiff(null);
    const against = (n: string): Promise<ChangeDelta[]> => (n === 'main' ? Promise.resolve([]) : rpc.call('exp.compare', { a: 'main', b: n }).then((r) => r.deltas));
    Promise.all([rpc.call('exp.compare', { a, b }), against(a), against(b)]).then(([d, da, db]) => { if (live) { setDiff(d.deltas); setVsMain({ a: da, b: db }); setErr(null); } }, (e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [rpc, a, b, version]);

  const laneIndex = (n: string): number => (n === 'main' ? 0 : 1 + [...h.exps].sort((x, y) => x.createdAt.localeCompare(y.createdAt)).findIndex((e) => e.name === n));
  const side = (n: 'a' | 'b', d: ChangeDelta): ChangeDelta | undefined => vsMain[n].find((x) => deltasKey(x) === deltasKey(d));

  const frame = (n: string): JSX.Element => {
    const url = urlOf(n);
    const info = h.exps.find((e) => e.name === n);
    return (
      <div className="hx-frame">
        <div className="hx-frame-h">
          <i className="hx-dot" style={{ background: laneColor(laneIndex(n)) }} />
          <b>{n}</b>
          <span className="hx-sub">{n === 'main' ? 'the project' : info?.changes ? `${info.changes} change${info.changes === 1 ? '' : 's'}` : 'untouched'}</span>
          {n !== 'main' && <button className="btn" onClick={() => void h.adopt(n)}><Icon name="check" />Adopt {n}</button>}
        </div>
        <div className="hx-frame-b">{url ? <iframe title={`Game: ${n}`} src={url} allow="autoplay; gamepad; fullscreen" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms" /> : <div className="hx-empty">This line has no game page.</div>}</div>
      </div>
    );
  };

  // What adopting a side does to this value in the project.
  const hint = (n: 'a' | 'b', d: ChangeDelta): string => {
    const val = say(n === 'a' ? d.from : d.to);
    if ((n === 'a' ? a : b) === 'main') return `main keeps ${val}`;
    const own = side(n, d);
    return own ? `main ${say(own.from)} → ${val}` : 'no change to main';
  };

  return (
    <div className="hx-compare">
      <div className="hx-cbar">
        <select className="field-in" value={a} onChange={(e) => onPick(e.target.value, b)} aria-label="Left side">{lines.map((l) => <option key={l} value={l}>{l}</option>)}</select>
        <span className="hx-sub">against</span>
        <select className="field-in" value={b} onChange={(e) => onPick(a, e.target.value)} aria-label="Right side">{lines.map((l) => <option key={l} value={l}>{l}</option>)}</select>
        <span className="hx-sub hx-grow">Same seed on both, so a difference you see is a difference in the values.</span>
      </div>
      <div className="hx-frames">{frame(a)}{frame(b)}</div>
      <div className="hx-diff" aria-label="What differs">
        <div className="hx-diff-h">
          <b>{diff ? `${diff.length} value${diff.length === 1 ? '' : 's'} differ` : 'Comparing...'}</b>
          <span className="hx-sub">{a} → {b}; the last column says what adopting a side does to the project</span>
        </div>
        {err && <div className="hx-empty">Could not compare: {err}</div>}
        {diff?.length === 0 && <div className="hx-empty">These two have the same values.</div>}
        <div className="hx-drows">
          {diff?.map((d) => {
            const p = plain(d);
            return (
              <div className="hx-drow" key={deltasKey(d)} title={d.file}>
                <span className="hx-scope">{p.scope}</span>
                <span className="hx-what">{p.what}</span>
                <span className="hx-vals"><span className="hx-old" title={a}>{p.op === 'add' ? 'not set' : p.from}</span><span className="hx-arrow">→</span><span className="hx-new" title={b}>{p.op === 'remove' ? 'removed' : p.to}</span></span>
                <span className="hx-hints">
                  <span className="hx-hint"><i className="hx-dot" style={{ background: laneColor(laneIndex(a)) }} />{a}: {hint('a', d)}</span>
                  <span className="hx-hint"><i className="hx-dot" style={{ background: laneColor(laneIndex(b)) }} />{b}: {hint('b', d)}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
