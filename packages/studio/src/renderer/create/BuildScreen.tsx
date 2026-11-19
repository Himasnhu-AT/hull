// Step 3, Build: the stages on the left, the selected stage's pieces on the right in two groups. "Look and listen" are cards the
// person can judge (preview, play a sound, Approve or Change with a note); "Explained" are drawings of what cannot be seen
// (rules, behaviour, layout, balance) with Looks right / Change. Entering Build with the brief approved and every stage waiting
// starts the build.
//   rpc        the project connection
//   project    the open project
//   onPlay()   the person pressed Play: the shell opens Play and fix

import { useEffect, useMemo, useState, type JSX } from 'react';
import type { StageId } from 'hull/dev/protocol';
import type { OpenedProject } from '../../shared/appApi.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { BuilderSetup } from './BuilderSetup.tsx';
import { canPlay, defaultStage, previousCheckpoint, readyCount, shouldStartBuild, splitPieces, STAGE_LABEL, STAGE_STATUS } from './buildView.ts';
import { ExplainCard } from './ExplainCard.tsx';
import { PieceGrid } from './PieceGrid.tsx';
import { useBuilder } from './useBuilder.tsx';
import { useCreateState, useExplainDocs } from './useCreate.ts';
import { useDeltas } from './useValues.ts';
import { ValuesCard } from './ValuesCard.tsx';

export interface BuildScreenProps { rpc: RpcClient; project: OpenedProject; onPlay(): void }

export function BuildScreen({ rpc, onPlay }: BuildScreenProps): JSX.Element {
  const b = useBuilder();
  const create = useCreateState(rpc);
  const docs = useExplainDocs(rpc);
  const [picked, setPicked] = useState<StageId | null>(null);
  const { startBuild } = b;

  useEffect(() => {
    if (!shouldStartBuild(create)) return;
    rpc.call('create.set', { patch: { step: 'build' }, author: 'you' }).catch(() => { /* the step is only a bookmark */ });
    startBuild();
  }, [create, rpc, startBuild]);

  const stages = create?.stages ?? [];
  const sel = picked ?? defaultStage(stages);
  const stage = stages.find((s) => s.id === sel);
  const { look, explained, numbers } = splitPieces(stage?.pieces ?? []);
  // What each number was before this stage: the history from the earlier stage's point to this stage's own.
  const deltas = useDeltas(rpc, previousCheckpoint(stages, sel), stage?.checkpoint);
  const shownDocs = useMemo(() => {
    const ids = new Set(explained);
    const out = explained.map((id) => docs.find((d) => d.id === id)).filter((d): d is NonNullable<typeof d> => !!d);
    for (const d of docs) if (d.stage === sel && !ids.has(d.id)) out.push(d);
    return out;
  }, [docs, explained, sel]);
  const lastSaid = [...b.lanes.build.items].reverse().find((i) => i.k === 'agent');
  const building = b.lanes.build.running || stages.some((s) => s.status === 'building');

  return (
    <div className="cr-build">
      <div className="cr-b-side">
        <div className="cr-row"><b>Building</b><span className="cr-k">{create ? `${readyCount(stages)} of ${stages.length} ready` : ''}</span></div>
        <ol className="cr-stages" aria-label="Stages">
          {stages.map((s) => (
            <li key={s.id}>
              <button aria-current={s.id === sel ? 'true' : undefined} onClick={() => setPicked(s.id)}>
                <i className={`cr-dot ${s.status}`} aria-hidden="true" />
                <span>{STAGE_LABEL[s.id]}<small>{STAGE_STATUS[s.status]}{s.status === 'ready' && s.pieces.length > 0 ? ` · ${s.pieces.length} piece${s.pieces.length === 1 ? '' : 's'}` : ''}</small></span>
              </button>
            </li>
          ))}
          {create === null && <li><div className="skeleton" /></li>}
        </ol>
        <button className="btn primary lg" onClick={onPlay} disabled={!canPlay(stages)} title={canPlay(stages) ? '' : 'World, characters and animations need to be ready first'}>Play what is there</button>
        {building
          ? <button className="btn" onClick={b.cancel}>Stop</button>
          : <button className="btn" onClick={() => void b.send('Run the build again.', { mode: 'build' })} disabled={!create?.briefApproved}>Run the build again</button>}
        <p className="cr-sub">Each stage is its own run. It writes the pieces, checks types and tests, takes a screenshot and saves a point you can return to.</p>
      </div>

      <div className="cr-b-pane">
        {b.needs && <BuilderSetup />}
        {!stage && !b.needs && <div className="skeleton" />}
        {stage && (
          <>
            <div className="cr-stagehead">
              <h2>{STAGE_LABEL[sel]}</h2>
              <span className={`pill${stage.status === 'ready' ? ' ok' : stage.status === 'failed' ? ' warn' : ''}`}>{STAGE_STATUS[stage.status]}</span>
            </div>
            {stage.summary && stage.status !== 'failed' && <p className="cr-sub">{stage.summary}</p>}
            {stage.status === 'waiting' && <p className="cr-sub">{create?.briefApproved ? 'Waiting for its turn.' : 'The brief is not approved yet.'}</p>}
            {stage.status === 'building' && <p className="cr-sub">{lastSaid && lastSaid.k === 'agent' ? lastSaid.text.trim().split('\n').pop() : 'The builder is working on this stage.'}</p>}
            {stage.status === 'failed' && (
              <div className="cr-failed" role="alert">
                <b>This stage stopped</b>
                <p>{stage.summary || 'The builder could not finish it.'}</p>
                <div className="cr-row"><button className="btn primary" onClick={() => b.retryStage(sel)} disabled={building}>Try this stage again</button></div>
              </div>
            )}
            {stage.status === 'ready' && look.length === 0 && shownDocs.length === 0 && numbers.length === 0 && <p className="cr-sub">This stage made nothing to look at or read.</p>}
            {look.length > 0 && (
              <section aria-label="Look and listen">
                <h3 className="cr-lane">Look and listen <span className="cr-cnt">{look.length}</span></h3>
                <PieceGrid keys={look} stage={sel} />
              </section>
            )}
            {shownDocs.length + numbers.length > 0 && (
              <section aria-label="Explained">
                <h3 className="cr-lane">Explained <span className="cr-cnt">{shownDocs.length + numbers.length}</span></h3>
                <div className="cr-xlist">
                  {shownDocs.map((d) => <ExplainCard key={d.id} doc={d} />)}
                  {numbers.map((k) => <ValuesCard key={k} pieceKey={k} stage={sel} deltas={deltas} />)}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
