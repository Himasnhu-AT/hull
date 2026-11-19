// A one-line bar for a note: what should change about this piece. Enter sends, Escape closes.

import { useEffect, useRef, useState, type JSX } from 'react';

export interface NoteBarProps { label: string; placeholder?: string; busy?: boolean; onSend(note: string): void; onCancel(): void }

export function NoteBar({ label, placeholder, busy, onSend, onCancel }: NoteBarProps): JSX.Element {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const send = (): void => { const t = text.trim(); if (t) onSend(t); };
  return (
    <form className="cr-notebar" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <input ref={ref} value={text} onChange={(e) => setText(e.target.value)} aria-label={label} placeholder={placeholder ?? 'What should change?'}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }} />
      <button className="btn primary" type="submit" disabled={busy || text.trim() === ''}>Send</button>
      <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}
