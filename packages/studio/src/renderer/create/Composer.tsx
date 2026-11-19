// The box the person writes in. Enter sends, Shift+Enter makes a new line. The text lives in the builder (a card's Change link fills it).

import { useEffect, useRef, type JSX } from 'react';

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
  rows?: number;
  sendLabel?: string;
}

export function Composer({ value, onChange, onSend, label, placeholder, nonce, busy, onStop, disabled, rows = 2, sendLabel = 'Send' }: ComposerProps): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && nonce) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }, [nonce]);
  return (
    <form className="cr-b-form" onSubmit={(e) => { e.preventDefault(); if (!disabled && value.trim()) onSend(); }}>
      <textarea ref={ref} rows={rows} value={value} disabled={disabled} aria-label={label} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!disabled && value.trim()) onSend(); } }} />
      {busy && onStop && value.trim() === '' ? <button className="btn" type="button" onClick={onStop}>Stop</button> : <button className="btn primary" type="submit" disabled={disabled || value.trim() === ''}>{sendLabel}</button>}
    </form>
  );
}
