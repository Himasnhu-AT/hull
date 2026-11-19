// Step 2, Brief. SLOT: worker D replaces the inside (the chat that writes GAME.md); keep the props.
//   rpc          the project connection (protocol methods and pushes)
//   project      the open project
//   idea         what the person typed in the launcher ('' when the project did not start from an idea)
//   onApproved() called when the brief is approved: the shell moves on to Build
// For now: shows the idea and a "Build it" button.

import type { JSX } from 'react';
import type { OpenedProject } from '../../shared/appApi.ts';
import type { RpcClient } from '../lib/rpc.ts';

export interface BriefScreenProps { rpc: RpcClient; project: OpenedProject; idea: string; onApproved(): void }

export function BriefScreen({ idea, onApproved }: BriefScreenProps): JSX.Element {
  return (
    <div className="cr-pad">
      <h2>Your idea</h2>
      {idea ? <blockquote className="cr-idea">{idea}</blockquote> : <p className="cr-sub">This game did not start from an idea. You can still go on to build it.</p>}
      <p className="cr-sub">The builder will ask a few questions and write the brief here. That arrives soon.</p>
      <div className="cr-row"><button className="btn primary lg" onClick={onApproved}>Build it</button></div>
    </div>
  );
}
