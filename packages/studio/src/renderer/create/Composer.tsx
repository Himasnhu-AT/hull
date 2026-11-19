// The box the person writes in, shaped like a chat app's: one rounded field that grows with the text, the send button inside it.
// Enter sends, Shift+Enter makes a new line. While a run goes and the box is empty, the button stops the run.
// The text lives in the builder (a card's Change link fills it).

import { useEffect, useLayoutEffect, useRef, type JSX } from 'react';
import { Icon } from '../ui/Icon.tsx';

export interface ComposerProps {
  value: string;
  onChange(s: string): void;
  onSend(): void;
  label: string;
  placeholder: string;
  /** Changes when something outside filled the box: focus it. */
  nonce?: number;
  busy?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  /** Focus on mount (the empty chat, like a new conversation). */
  autoFocus?: boolean;
  sendLabel?: string;
}

const MAX = 220;

export function Composer({ value, onChange, onSend, label, placeholder, nonce, busy, onStop, disabled, autoFocus, sendLabel = 'Send' }: ComposerProps): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && nonce) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }, [nonce]);
  useEffect(() => { if (autoFocus && !disabled) ref.current?.focus(); }, [autoFocus, disabled]);
  // Grow with the text up to a limit, then scroll: measured before paint so the box never flickers.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX)}px`;
    el.style.overflowY = el.scrollHeight > MAX ? 'auto' : 'hidden';
  }, [value]);
  const empty = value.trim() === '';
  const stop = busy && onStop && empty;
  return (
    <form className={`cmp${disabled ? ' off' : ''}`} onSubmit={(e) => { e.preventDefault(); if (!disabled && !empty) onSend(); }} onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); ref.current?.focus(); } }}>
      <textarea ref={ref} rows={1} value={value} disabled={disabled} aria-label={label} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!disabled && !empty) onSend(); } }} />
      {stop
        ? <button className="cmp-btn" type="button" onClick={onStop} aria-label="Stop the builder" title="Stop"><Icon name="stop" size={14} /></button>
        : <button className="cmp-btn" type="submit" disabled={disabled || empty} aria-label={sendLabel} title={`${sendLabel} (Enter)`}><Icon name="up" size={16} /></button>}
    </form>
  );
}
