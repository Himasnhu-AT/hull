// Step 1, Idea: the idea this game started from, read back from the flow state (so it is there after the app was closed and the
// game reopened), and a quiet way back to the launcher. A game that did not start from an idea says so in one line.
//   rpc               the project connection
//   idea              what the person typed in the launcher this session ('' when not made just now)
//   onStartAnother()  go back to the launcher

import type { JSX } from 'react';
import type { RpcClient } from '../lib/rpc.ts';
import { useCreateState } from './useCreate.ts';

export interface IdeaScreenProps { rpc: RpcClient; idea: string; onStartAnother(): void }

export function IdeaScreen({ rpc, idea, onStartAnother }: IdeaScreenProps): JSX.Element {
  const create = useCreateState(rpc);
  const text = (create?.idea ?? '').trim() || idea.trim();
  return (
    <div className="cr-pad">
      <h2>Your idea</h2>
      {text
        ? <blockquote className="cr-idea">{text}</blockquote>
        : create === null
          ? <div className="skeleton" />
          : <p className="cr-sub">This game did not start from an idea. It began from a template or a folder.</p>}
      <div className="cr-row"><button className="btn ghost" onClick={onStartAnother}>Start another game</button></div>
    </div>
  );
}
