// What a crashed screen tells the person: a sentence in plain words and the error text for whoever has to fix it. No React here.

export interface CrashText { what: string; detail: string }

/** `screen` is the screen's name as the person knows it ("Share"). The detail is the message with the first line of the stack. */
export function crashText(screen: string, error: unknown): CrashText {
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error) ?? 'unknown error');
  const place = (e.stack ?? '').split('\n').find((l) => /\bat\b|@/.test(l))?.trim() ?? '';
  const message = e.message.length > 400 ? `${e.message.slice(0, 398)}...` : e.message;
  return {
    what: `${screen} stopped working. The rest of the app is fine and your game is untouched.`,
    detail: [`${e.name}: ${message}`, place].filter(Boolean).join('\n'),
  };
}
