import type { RpcClient } from '../lib/rpc.ts';
export async function g(rpc: RpcClient) {
  const all = (await rpc.call('library.list', {})).filter((i) => i.kind === 'sound');
  const docs = await Promise.all(all.map((i) => rpc.call('config.read', { id: i.id }).catch(() => null)));
  return docs;
}
