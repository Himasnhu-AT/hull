// The dev runtime's error ring: the last 50 distinct errors and warnings the game raised, repeats counted. Pure (no window,
// no clock): the runtime gives it the tick and time, so it runs in a test the same as in the page.
import type { GameError } from './protocol.ts';

export const ERROR_RING = 50;
const MAX_MESSAGE = 600;
const MAX_FRAMES = 12;

/** What the page knows about one error: the browser's own stack text, not yet mapped to the sources. */
export interface RawError extends GameError { stack?: string }

export interface ErrorRing {
  /** Records one error or warning. A repeat (same level, message and first stack frame) only raises its count. Returns true when it was new. */
  add(level: 'error' | 'warn', message: string, stack: string | undefined, tick: number, time: number): boolean;
  /** Errors and warnings recorded since the last `take`. */
  unread(): number;
  /** The ring, oldest first. Marks everything read; `clear` also empties it. */
  take(clear: boolean): RawError[];
  /** Same as `take(false)` without marking anything read. */
  peek(): RawError[];
  /** For a restart: the ring as JSON text to hand to the next page, and back. */
  dump(): string;
  load(text: string): void;
}

/** Keeps only the frame lines of a browser stack ("    at f (url:1:2)"), at most MAX_FRAMES; the message line goes. */
export function frameLines(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split('\n').filter((l) => /^\s*at /.test(l)).slice(0, MAX_FRAMES);
  return lines.length ? lines.join('\n') : undefined;
}

export function createErrorRing(): ErrorRing {
  let items: RawError[] = [];
  let unread = 0;
  const keys = new Map<RawError, string>();
  const keyOf = (level: string, message: string, stack: string | undefined): string => `${level}|${message}|${stack?.split('\n')[0] ?? ''}`;
  const add: ErrorRing['add'] = (level, message, stack, tick, time) => {
    const msg = message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}...` : message;
    const frames = frameLines(stack);
    const key = keyOf(level, msg, frames);
    unread++;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (keys.get(it) === key) { it.count++; it.tick = tick; it.time = time; return false; }
    }
    const it: RawError = { level, message: msg, tick, time, count: 1 };
    if (frames) it.stack = frames;
    items.push(it);
    keys.set(it, key);
    if (items.length > ERROR_RING) keys.delete(items.shift()!);
    return true;
  };
  return {
    add,
    unread: () => unread,
    take(clear) {
      const out = items.map((i) => ({ ...i }));
      unread = 0;
      if (clear) { items = []; keys.clear(); }
      return out;
    },
    peek: () => items.map((i) => ({ ...i })),
    dump: () => JSON.stringify(items),
    load(text) {
      try {
        const list = JSON.parse(text) as RawError[];
        if (!Array.isArray(list)) return;
        for (const it of list.slice(-ERROR_RING)) {
          if (!it || typeof it.message !== 'string' || (it.level !== 'error' && it.level !== 'warn')) continue;
          // add() counts this as one occurrence; the carried item already says how many there were.
          add(it.level, it.message, it.stack, it.tick, it.time);
          const extra = Math.max(0, (Number(it.count) || 1) - 1);
          const key = keyOf(it.level, it.message.length > MAX_MESSAGE ? `${it.message.slice(0, MAX_MESSAGE)}...` : it.message, frameLines(it.stack));
          for (let i = items.length - 1; i >= 0; i--) if (keys.get(items[i]!) === key) { items[i]!.count += extra; break; }
        }
        unread = 0;
      } catch { /* a bad dump is just forgotten */ }
    },
  };
}
