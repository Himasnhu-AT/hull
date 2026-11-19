// Step 4, the Play tab. SLOT: worker D adds the Just now strip and "Something is off"; keep the props.
//   rpc            the project connection
//   project        the open project (its gameUrl is the game page)
//   onAttach(p)    attach a piece to the builder column (the strip's chips use it)
// The builder column is not drawn here: the shell puts it beside this screen.
// For now: the game frame with play / pause / restart.

import { useState, type JSX } from 'react';
import type { OpenedProject } from '../../shared/appApi.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { Icon } from '../ui/Icon.tsx';
import type { AttachedPiece } from './types.ts';

export interface PlayScreenProps { rpc: RpcClient; project: OpenedProject; onAttach(piece: AttachedPiece): void }

export function PlayScreen({ rpc, project }: PlayScreenProps): JSX.Element {
  const [paused, setPaused] = useState(false);
  const control = (c: { paused?: boolean; restart?: boolean }): void => { rpc.call('game.control', c).catch(() => { /* the game is not up yet */ }); };
  return (
    <div className="cr-playwrap">
      <div className="cr-gamebox">
        <iframe title="Game" src={project.gameUrl} allow="autoplay; gamepad; fullscreen" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms" />
      </div>
      <div className="cr-under">
        <button className="btn" onClick={() => { setPaused(!paused); control({ paused: !paused }); }}><Icon name={paused ? 'play' : 'pause'} size={13} />{paused ? 'Play' : 'Pause'}</button>
        <button className="btn" onClick={() => { setPaused(false); control({ restart: true }); }}><Icon name="reset" size={13} />Restart</button>
      </div>
    </div>
  );
}
