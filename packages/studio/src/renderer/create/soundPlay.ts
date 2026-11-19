// A sound card plays its sound the way the Sound bench does: render the recipe with the engine (the project's own when it has
// code generators, the Studio's otherwise), then play the buffer. The engine loads once per game page.

import type { RpcClient } from '../lib/rpc.ts';
import { loadAudio, loadProjectAudio, type AudioApi } from '../lib/audioApi.ts';

const engines = new Map<string, Promise<AudioApi>>();

function engineFor(gameUrl: string): Promise<AudioApi> {
  let e = engines.get(gameUrl);
  if (!e) {
    e = loadProjectAudio(gameUrl).then((a) => a ?? loadAudio());
    // A failed load is tried again on the next press.
    e.catch(() => engines.delete(gameUrl));
    engines.set(gameUrl, e);
  }
  return e;
}

export async function playSound(rpc: RpcClient, gameUrl: string, id: string): Promise<void> {
  const audio = await engineFor(gameUrl);
  const doc = await rpc.call('config.read', { id });
  // A `pick` source looks other sounds up in the project bundle's own registry, so fill it first (as the bench does).
  if (audio.config && (doc.value as { source?: { type?: string } } | null)?.source?.type === 'pick') {
    const all = (await rpc.call('library.list', {})).filter((i) => i.kind === 'sound');
    const docs = await Promise.all(all.map((i) => rpc.call('config.read', { id: i.id }).catch(() => null)));
    audio.config.load(docs.filter((d) => d !== null).map((d) => ({ path: d.path, text: d.text })));
  }
  audio.playBuffer(await audio.renderSound(doc.value));
}
