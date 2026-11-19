// An explained piece: the drawing, the sentence on why it is drawn this way, and Looks right / Change. Reviewed under the key
// 'explain:<id>'. Change opens a note bar; sending it marks the piece "needs change" and gives the note to the builder.

import { useState, type JSX } from 'react';
import type { ExplainDoc, StageId } from 'hull/dev/protocol';
import { explainKey } from './buildView.ts';
import { ExplainDrawing } from './ExplainDrawing.tsx';
import { NoteBar } from './NoteBar.tsx';
import { TAG_TEXT } from './shelves.ts';
import { useExplainDocs } from './useCreate.ts';
import { useBuilder } from './useBuilder.tsx';

export function ExplainCard({ doc, compact }: { doc: ExplainDoc; compact?: boolean | undefined }): JSX.Element {
  const b = useBuilder();
  const key = explainKey(doc.id);
  const tag = b.pieces.tag(key);
  const [changing, setChanging] = useState(false);
  return (
    <article className={`cr-xcard${compact || doc.body.type === 'flow' ? ' compact' : ''}`} aria-label={doc.title}>
      <div className="cr-xfig"><ExplainDrawing body={doc.body} uid={doc.id} /></div>
      <div className="cr-cb">
        <div className="cr-name"><b>{doc.title}</b><span className={`cr-tag inline ${tag}`}>{TAG_TEXT[tag]}</span></div>
        <p className="cr-why">{doc.why}</p>
        <div className="cr-ca">
          <button className="btn" onClick={() => void b.pieces.approve(key)} disabled={tag === 'approved'}>{tag === 'approved' ? 'Looks right' : 'Looks right'}</button>
          <button className="btn" onClick={() => setChanging(!changing)}>Change</button>
        </div>
        {changing && (
          <NoteBar label={`What should change about ${doc.title}`} placeholder="What is wrong with this?" onCancel={() => setChanging(false)}
            onSend={(note) => { void b.pieces.note(key, note).then((ok) => { if (!ok) return; setChanging(false); void b.send(`Change ${doc.title}: ${note}`, { mode: 'build', stage: doc.stage as StageId, about: [key] }); }); }} />
        )}
      </div>
    </article>
  );
}

/** The same card for an explain document named by id (the stage lists keys, not documents). */
export function ExplainCardById({ id, compact }: { id: string; stage?: StageId; compact?: boolean }): JSX.Element {
  const { rpc } = useBuilder();
  const doc = useExplainDocs(rpc).find((d) => d.id === id);
  if (!doc) return <div className="cr-card cr-missing"><div className="cr-cb"><div className="cr-name"><b>{id}</b></div><p>Loading the drawing...</p></div></div>;
  return <ExplainCard doc={doc} compact={compact} />;
}
