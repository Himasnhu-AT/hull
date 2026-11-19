// Step 4, the Play tab: the game, a "Just now" strip of what it did, and "Something is off" (also the N key), which freezes the game
// and hands the moment to the builder column. The game stays mounted when the tab changes (the shell hides it), so it keeps running.
//   rpc            the project connection
//   project        the open project (its gameUrl is the game page)
//   onAttach(p)    attach a piece to the builder column (Everything's Change uses it)
//   active         this tab is showing: the N key works only then
//   moment         the frozen moment the shell holds, or null
//   onFreeze(m, p) the game froze (m) with these pieces, or the person carried on (null)

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { GameMoment, RecentEvent } from 'hull/dev/protocol';
import type { OpenedProject } from '../../shared/appApi.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { clock, KIND_WORD, mergeRecent, piecesOf } from './recentStrip.ts';
import type { AttachedPiece } from './types.ts';

export interface PlayScreenProps {
  rpc: RpcClient; project: OpenedProject; onAttach(piece: AttachedPiece): void;
  active?: boolean; moment?: GameMoment | null; onFreeze?: (m: GameMoment | null, pieces: AttachedPiece[]) => void;
}

const KIND_ICON: Record<RecentEvent['kind'], IconName> = { sound: 'audio', anim: 'gameplay', vfx: 'sliders', actor: 'characters' };

const editable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export function PlayScreen({ rpc, project, active = true, moment = null, onFreeze }: PlayScreenProps): JSX.Element {
  const [paused, setPaused] = useState(false);
  const [strip, setStrip] = useState<RecentEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stripRef = useRef(strip);
  stripRef.current = strip;
  const control = useCallback((c: { paused?: boolean; restart?: boolean }): void => { rpc.call('game.control', c).catch(() => { /* the game is not up yet */ }); }, [rpc]);

  // The game pushes what it did; the strip keeps the last five.
  useEffect(() => {
    let live = true;
    const load = (): void => { rpc.call('game.recent', { seconds: 6 }).then((r) => { if (live) setStrip((s) => mergeRecent(s, r.items)); }, () => { /* no game connected yet */ }); };
    const offs = [rpc.on('game.recent', (p) => { if (live) setStrip((s) => mergeRecent(s, p.items)); }), rpc.onStatus((s) => { if (s === 'open') load(); })];
    if (rpc.status === 'open') load();
    return () => { live = false; offs.forEach((o) => o()); };
  }, [rpc]);

  const freeze = useCallback(async (only?: RecentEvent): Promise<void> => {
    if (busy || moment) return;
    setBusy(true); setError(null);
    try {
      const m = await rpc.call('game.moment', {}, { timeoutMs: 20_000 });
      setPaused(true);
      onFreeze?.(m, piecesOf(only ? [only] : stripRef.current));
    } catch (e) { setError(`Could not freeze the game: ${e instanceof Error ? e.message : String(e)}`); } finally { setBusy(false); }
  }, [busy, moment, rpc, onFreeze]);

  // The moment going away (a note was sent, or Esc) lets the game carry on.
  const had = useRef(false);
  useEffect(() => {
    if (had.current && !moment) { setPaused(false); control({ paused: false }); }
    had.current = moment !== null;
  }, [moment, control]);

  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape' && moment) { onFreeze?.(null, []); return; }
      if ((e.key === 'n' || e.key === 'N') && !editable(e.target) && !moment) { e.preventDefault(); void freeze(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [active, moment, freeze, onFreeze]);

  return (
    <div className="cr-playwrap">
      <div className={`cr-gamebox${moment ? ' is-frozen' : ''}`}>
        <iframe title="Game" src={project.gameUrl} allow="autoplay; gamepad; fullscreen" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms" />
        {moment && (
          <div className="cr-frozen glass" role="status">
            <b>Frozen at {clock(moment.time)}</b>
            <span>Say what is off in the Builder column. Esc carries on.</span>
            <button className="cr-link" onClick={() => onFreeze?.(null, [])}>Carry on</button>
          </div>
        )}
      </div>
      <div className="cr-under">
        <button className="btn" disabled={moment !== null} onClick={() => { setPaused(!paused); control({ paused: !paused }); }}><Icon name={paused ? 'play' : 'pause'} size={13} />{paused ? 'Play' : 'Pause'}</button>
        <button className="btn" onClick={() => { setPaused(false); control({ restart: true }); }}><Icon name="reset" size={13} />Restart</button>
        <div className="cr-recent" aria-label="Just now in the game">
          <span className="cr-lab">Just now</span>
          {strip.length === 0 && <span className="cr-sub">Nothing yet. Play and it fills.</span>}
          {strip.map((e) => (
            <button key={`${e.at}|${e.kind}|${e.id}`} className="chip cr-rchip" onClick={() => void freeze(e)} disabled={busy || moment !== null} title={`${KIND_WORD[e.kind]}: freeze the game with only this one`}>
              <Icon name={KIND_ICON[e.kind]} size={12} />{e.label}
            </button>
          ))}
        </div>
        <button className="cr-off" onClick={() => void freeze()} disabled={busy || moment !== null}>Something is off <kbd>N</kbd></button>
      </div>
      {error && <div className="note-err" role="alert">{error}</div>}
    </div>
  );
}
