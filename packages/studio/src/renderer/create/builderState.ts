// The pill beside "Brief" and "Builder": what the builder is doing, from the person's side. No React here.
//   needs     the builder cannot start until the person adds a key
//   waiting   cards the builder has asked and is waiting on (a question, the approve card)
//   working   a run is going, or about to start

export interface BuilderStateInput { needs: boolean; waiting: number; working: boolean }
export interface BuilderPill { text: string; cls: 'ok' | 'warn' | '' }

export function builderPill({ needs, waiting, working }: BuilderStateInput): BuilderPill {
  if (needs) return { text: 'needs a key', cls: 'warn' };
  // A run that waits on the person is not working: the next move is theirs.
  if (waiting > 0) return { text: 'waiting for you', cls: 'warn' };
  if (working) return { text: 'working', cls: '' };
  return { text: 'ready', cls: 'ok' };
}
