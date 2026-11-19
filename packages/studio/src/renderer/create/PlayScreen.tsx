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
import { chips, clock, frameUrl, KIND_WORD, mergeRecent, piecesOf } from './recentStrip.ts';
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

let frameN = 0;

export function PlayScreen({ rpc, project, active = true, moment = null, onFreeze }: PlayScreenProps): JSX.Element {
  // The game page in this frame names itself with this id (?hull-client=), so the moment, the strip and pause all aim at the
  // game the person sees, never at a headless page a tool opened.
  const [client] = useState(() => `app${Date.now().toString(36)}${(frameN++).toString(36)}`);
  const frameSrc = frameUrl(project.gameUrl, client);
  const [paused, setPaused] = useState(false);
  const [strip, setStrip] = useState<RecentEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stripRef = useRef(strip);
  stripRef.current = strip;
  const control = useCallback((c: { paused?: boolean; restart?: boolean }): void => { rpc.call('game.control', { ...c, client }).catch(() => { /* the game is not up yet */ }); }, [rpc, client]);

  // The game pushes what it did; the strip keeps the last five.
  useEffect(() => {
    let live = true;
    const load = (): void => { rpc.call('game.recent', { seconds: 6, client }).then((r) => { if (live) setStrip((s) => mergeRecent(s, r.items)); }, () => { /* no game connected yet */ }); };
    const offs = [rpc.on('game.recent', (p) => { if (live && p.client === client) setStrip((s) => mergeRecent(s, p.items)); }), rpc.onStatus((s) => { if (s === 'open') load(); })];
    if (rpc.status === 'open') load();
    return () => { live = false; offs.forEach((o) => o()); };
  }, [rpc, client]);

  const freeze = useCallback(async (only?: RecentEvent): Promise<void> => {
    if (busy || moment) return;
    setBusy(true); setError(null);
    try {
      const m = await rpc.call('game.moment', { client }, { timeoutMs: 20_000 });
      setPaused(true);
      onFreeze?.(m, piecesOf(only ? [only] : stripRef.current));
    } catch (e) { setError(`Could not freeze the game: ${e instanceof Error ? e.message : String(e)}`); } finally { setBusy(false); }
  }, [busy, moment, rpc, onFreeze, client]);

  // The moment going away (a note was sent, or Esc) lets the game carry on.
  const had = useRef(false);
  useEffect(() => {
    if (had.current && !moment) { setPaused(false); control({ paused: false }); }
    had.current = moment !== null;
  }, [moment, control]);

  // The game frame is another origin and keeps the keys while the person plays: the dev runtime tells us about N and Escape.
  const freezeRef = useRef(freeze);
  freezeRef.current = freeze;
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!active) return;
    const m = (e: MessageEvent): void => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const hull = (e.data as { hull?: unknown } | null)?.hull;
      if (hull === 'note' && !moment) void freezeRef.current();
      else if (hull === 'resume' && moment) onFreeze?.(null, []);
    };
    window.addEventListener('message', m);
    return () => window.removeEventListener('message', m);
  }, [active, moment, onFreeze]);

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
        <iframe ref={frameRef} title="Game" src={frameSrc} allow="autoplay; gamepad; fullscreen" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms" />
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
          {chips(strip).map((c) => (
            <button key={`${c.event.kind}|${c.event.id}`} className="chip cr-rchip" onClick={() => void freeze(c.event)} disabled={busy || moment !== null} title={`${KIND_WORD[c.event.kind]}: freeze the game with only this one`}>
              <Icon name={KIND_ICON[c.event.kind]} size={12} />{c.event.label}{c.count > 1 ? ` ×${c.count}` : ''}
            </button>
          ))}
        </div>
        <button className="cr-off" onClick={() => void freeze()} disabled={busy || moment !== null}>Something is off <kbd>N</kbd></button>
      </div>
      {error && <div className="note-err" role="alert">{error}</div>}
    </div>
  );
}
