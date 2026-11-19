// Step 3, Build. SLOT: worker D replaces the inside (stages on the left, pieces on the right); keep the props.
//   rpc        the project connection
//   project    the open project
//   onPlay()   the person pressed Play: the shell opens Play and fix
// For now: a short note and a "Play" button.

import type { JSX } from 'react';
import type { OpenedProject } from '../../shared/appApi.ts';
import type { RpcClient } from '../lib/rpc.ts';

export interface BuildScreenProps { rpc: RpcClient; project: OpenedProject; onPlay(): void }

export function BuildScreen({ onPlay }: BuildScreenProps): JSX.Element {
  return (
    <div className="cr-pad">
      <h2>Building</h2>
      <p className="cr-sub">The builder will make the game stage by stage and show you each piece here. That arrives soon. The game is already playable.</p>
      <div className="cr-row"><button className="btn primary lg" onClick={onPlay}>Play</button></div>
    </div>
  );
}
