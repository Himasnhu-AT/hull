// The conversation: the person's notes, the builder's text (with a caret while it streams), cards, one quiet line for the tool
// calls of a run, and plain permission requests. With "show what the builder sends" on, each item shows the event behind it.

import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { UiBlock } from './blocks/UiBlock.tsx';
import { eventOf, workingSummary, type Item, type Transcript } from './transcript.ts';
import { useBuilder } from './useBuilder.tsx';

function Working({ item }: { item: Extract<Item, { k: 'working' }> }): JSX.Element {
  const s = workingSummary(item.tools);
  return (
    <details className="cr-work">
      <summary><i className={`cr-dot ${s.busy ? 'building' : s.failed ? 'failed' : 'ready'}`} aria-hidden="true" />{s.line}</summary>
      <ul>{item.tools.map((t) => <li key={t.id}><span>{t.title}</span><span className="cr-k">{t.status === 'completed' ? 'done' : t.status === 'failed' ? 'failed' : 'working'}</span></li>)}</ul>
    </details>
  );
}

function Perm({ item }: { item: Extract<Item, { k: 'perm' }> }): JSX.Element {
  const { answer } = useBuilder();
  return (
    <div className="cr-ui" role="group" aria-label={item.tool.title}>
      <b>{item.tool.title}</b>
      <div className="cr-opts">
        {item.options.map((o) => <button key={o.id} className="btn" aria-pressed={item.answer?.optionId === o.id} disabled={item.answer !== undefined} onClick={() => answer(item.reqId, o.id)}>{o.name}</button>)}
      </div>
    </div>
  );
}

function Row({ item }: { item: Item }): JSX.Element {
  switch (item.k) {
    case 'user': return <div className="cr-msg you">{item.text}{item.chips.length > 0 && <div className="cr-chips">{item.chips.map((c) => <span key={c} className="chip">{c}</span>)}</div>}</div>;
    case 'agent': return <div className={`cr-msg ai${item.live ? ' typing' : ''}`}>{item.text}</div>;
    case 'ui': return <UiBlock item={item} />;
    case 'working': return <Working item={item} />;
    case 'perm': return <Perm item={item} />;
    case 'note': return <div className={item.error ? 'note-err' : 'cr-sub'} role={item.error ? 'alert' : undefined}>{item.text}</div>;
  }
}

export interface TranscriptViewProps { t: Transcript; showEvents: boolean; label: string; className?: string; empty?: ReactNode }

export function TranscriptView({ t, showEvents, label, className = '', empty }: TranscriptViewProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Follow the end while the builder writes, unless the person scrolled up to read.
  useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; });
  return (
    <div ref={ref} className={`cr-log ${showEvents ? 'show-ev' : ''} ${className}`} tabIndex={0} role="log" aria-label={label} aria-live="polite"
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
      {t.items.length === 0 && empty}
      {t.items.map((i) => (
        <div key={i.key} className={`cr-row-item ${i.k}`}>
          {showEvents && <div className="cr-ev mono">{eventOf(i)}</div>}
          <Row item={i} />
        </div>
      ))}
    </div>
  );
}
