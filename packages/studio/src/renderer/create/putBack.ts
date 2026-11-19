// Put back one change: every field it changed goes back to what it was, through the same validated writes as the Changes list,
// so the history gets a new entry and the change it undid stays where it was.

import type { HistoryChange } from 'hull/dev/protocol';
import type { Revert } from '../history/changesView.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { putBackRows } from './changesList.ts';

async function applyRevert(rpc: RpcClient, r: Revert, from: string): Promise<string | null> {
  const res = r.via === 'config.set' ? await rpc.call('config.set', { id: r.id, pointer: r.pointer, value: r.value, author: 'you' })
    : r.via === 'tunables.set' ? await rpc.call('tunables.set', { block: r.block, key: r.key, value: r.value, author: 'you' })
      : await rpc.call('history.revert', { from, file: r.file, ...(r.pointer !== undefined ? { pointer: r.pointer } : {}), author: 'you' });
  return res.ok ? null : (res.problems[0]?.message ?? 'the old value is not valid now');
}

/** Null when it worked, else what went wrong in a sentence. */
export async function putBackChange(rpc: RpcClient, c: HistoryChange): Promise<string | null> {
  const from = c.parents[0];
  if (!from) return 'This is the start of the project; there is nothing before it to go back to.';
  try {
    const diff = await rpc.call('history.diff', { to: c.id });
    for (const row of putBackRows(diff.deltas)) {
      const problem = await applyRevert(rpc, row.revert, from);
      if (problem) return `Could not put it back: ${problem}`;
    }
    return null;
  } catch (e) { return `Could not put it back: ${e instanceof Error ? e.message : String(e)}`; }
}

/** The same, for a change named by its id (a change card carries only the id). */
export async function putBackById(rpc: RpcClient, id: string): Promise<string | null> {
  try {
    const c = (await rpc.call('history.list', { limit: 400 })).find((x) => x.id === id);
    return c ? await putBackChange(rpc, c) : 'That change is no longer in the history.';
  } catch (e) { return `Could not put it back: ${e instanceof Error ? e.message : String(e)}`; }
}
