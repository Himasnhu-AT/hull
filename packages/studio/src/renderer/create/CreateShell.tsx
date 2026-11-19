// What the app shows for an open project (M11): a title bar with the five-step rail, and the screen for the step.
// Advanced shows today's editor as it is; the switch is remembered per project. A project opened from Recent, Community
// or a template starts on Play and fix; one made from an idea starts on Brief.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { GameMoment } from 'hull/dev/protocol';
import type { OpenedProject } from '../../shared/appApi.ts';
import { Editor } from '../editor/Editor.tsx';
import { useProject } from '../editor/useProject.ts';
import { RpcClient, studioUrl } from '../lib/rpc.ts';
import { Icon } from '../ui/Icon.tsx';
import { BriefScreen } from './BriefScreen.tsx';
import { BuilderColumn } from './BuilderColumn.tsx';
import { BuildScreen } from './BuildScreen.tsx';
import { Changes } from './Changes.tsx';
import { mainLine } from './changesList.ts';
import { Everything } from './Everything.tsx';
import { OpenSheet } from './OpenSheet.tsx';
import { PlayScreen } from './PlayScreen.tsx';
import { ShareScreen } from './ShareScreen.tsx';
import { BuilderProvider } from './useBuilder.tsx';
import { STEPS, type AttachedPiece, type PlayTab, type Step } from './types.ts';

const advancedKey = (root: string): string => `hull.advanced:${root}`;
function readAdvanced(root: string): boolean { try { return localStorage.getItem(advancedKey(root)) === '1'; } catch { return false; } }
function writeAdvanced(root: string, on: boolean): void { try { localStorage.setItem(advancedKey(root), on ? '1' : '0'); } catch { /* storage may be blocked: the switch just is not remembered */ } }

export interface CreateShellProps {
  project: OpenedProject;
  platform: string;
  /** What the person typed in the launcher; present only for a project made from an idea. */
  idea?: string | undefined;
  onClose(): void;
}

export function CreateShell({ project, platform, idea, onClose }: CreateShellProps): JSX.Element {
  const [advanced, setAdvanced] = useState(() => readAdvanced(project.root));
  const [step, setStep] = useState<Step>(idea ? 'brief' : 'play');
  const [tab, setTab] = useState<PlayTab>('play');
  const [attached, setAttached] = useState<AttachedPiece[]>([]);
  const flip = (on: boolean): void => { setAdvanced(on); writeAdvanced(project.root, on); };

  if (advanced) {
    return (
      <>
        <Editor project={project} platform={platform} onClose={onClose} />
        <button className="cr-simple glass" onClick={() => flip(false)} title="Go back to the simple view">Simple view</button>
      </>
    );
  }
  return <ShellBody project={project} platform={platform} idea={idea ?? ''} onClose={onClose} step={step} setStep={setStep} tab={tab} setTab={setTab} attached={attached} setAttached={setAttached} onAdvanced={() => flip(true)} />;
}

interface BodyProps {
  project: OpenedProject; platform: string; idea: string; onClose(): void;
  step: Step; setStep(s: Step): void; tab: PlayTab; setTab(t: PlayTab): void;
  attached: AttachedPiece[]; setAttached(a: AttachedPiece[]): void; onAdvanced(): void;
}

function ShellBody(props: BodyProps): JSX.Element | null {
  // Created in an effect, not during render, so React's double-mount in development closes only the first client.
  const [rpc, setRpc] = useState<RpcClient | null>(null);
  const url = props.project.url;
  useEffect(() => { const c = new RpcClient(studioUrl(url)); setRpc(c); return () => c.close(); }, [url]);
  return rpc ? <ShellScreens key={rpc.id} rpc={rpc} {...props} /> : null;
}

/** How many changes the main line has, kept fresh as the history grows. */
function useChangeCount(rpc: RpcClient): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => { rpc.call('history.list', { limit: 400 }).then((c) => { if (live) setN(mainLine(c).filter((x) => x.kind !== 'start').length); }, () => {}); };
    const offs = [rpc.onStatus((s) => { if (s === 'open') load(); }), rpc.on('history.added', load)];
    if (rpc.status === 'open') load();
    return () => { live = false; offs.forEach((o) => o()); };
  }, [rpc]);
  return n;
}

function ShellScreens({ rpc, project, platform, idea, onClose, step, setStep, tab, setTab, attached, setAttached, onAdvanced }: BodyProps & { rpc: RpcClient }): JSX.Element {
  const p = useProject(rpc);
  const baselines = useRef(new Map<string, unknown>());
  const [sheet, setSheet] = useState<string | null>(null);
  const [moment, setMoment] = useState<GameMoment | null>(null);
  const changeCount = useChangeCount(rpc);
  const library = p.library;
  const open = library?.find((i) => i.id === sheet) ?? null;

  const attach = useCallback((piece: AttachedPiece) => {
    setAttached([...attached.filter((a) => a.key !== piece.key), piece]);
    setSheet(null);
  }, [attached, setAttached]);
  const play = useCallback(() => { setTab('play'); setStep('play'); }, [setTab, setStep]);
  // A freeze keeps the moment and the pieces that just played for the next note; carrying on drops both.
  const freeze = useCallback((m: GameMoment | null, pieces: AttachedPiece[]) => {
    setMoment(m);
    setAttached(m ? [...attached, ...pieces.filter((p) => !attached.some((a) => a.key === p.key))] : []);
  }, [attached, setAttached]);
  const builder = (
    <BuilderColumn project={project} attached={attached} onClearAttached={() => setAttached([])} moment={moment} onClearMoment={() => freeze(null, [])}
      onRemoveAttached={(k) => setAttached(attached.filter((a) => a.key !== k))} onSent={() => { setMoment(null); setAttached([]); }} />
  );

  return (
    <BuilderProvider rpc={rpc} project={project}>
    <div className="cr">
      <header className={`cr-top drag${platform === 'darwin' ? ' mac' : ''}`}>
        <button className="btn ghost nodrag" onClick={onClose} aria-label="Back to your games" title="Back to your games"><Icon name="back" size={14} /></button>
        <b className="cr-title" title={project.title}>{project.title}</b>
        <nav aria-label="Steps"><ol className="cr-rail">
          {STEPS.map((s, i) => (
            <li key={s.id}><button className="nodrag" title={s.label} aria-current={step === s.id ? 'step' : undefined} onClick={() => setStep(s.id)}><span className="cr-n">{i + 1}</span><span className="cr-lbl">{s.label}</span></button></li>
          ))}
        </ol></nav>
        <span style={{ flex: 1 }} />
        {step === 'play' && (
          <div className="seg nodrag" role="tablist" aria-label="Views">
            <button role="tab" aria-selected={tab === 'play'} className={tab === 'play' ? 'on' : ''} onClick={() => setTab('play')}>Play</button>
            <button role="tab" aria-selected={tab === 'everything'} className={tab === 'everything' ? 'on' : ''} onClick={() => setTab('everything')}>Everything{library ? <span className="cr-cnt">{library.length}</span> : null}</button>
            <button role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>Changes{changeCount !== null ? <span className="cr-cnt">{changeCount}</span> : null}</button>
          </div>
        )}
        <button className="btn nodrag" onClick={() => setStep('share')}>Share</button>
        <button className="cr-switch nodrag" role="switch" aria-checked={false} onClick={onAdvanced} title="Show the full editor"><span className="cr-knob" />Advanced</button>
      </header>

      <main className="cr-main">
        {step === 'idea' && (
          <div className="cr-pad">
            <h2>{idea ? 'Your idea' : 'Where this game started'}</h2>
            {idea ? <blockquote className="cr-idea">{idea}</blockquote> : <p className="cr-sub">This game started from a template or a folder, not from an idea you typed.</p>}
            <div className="cr-row"><button className="btn lg" onClick={onClose}>Start a different game</button></div>
          </div>
        )}
        {step === 'brief' && <BriefScreen rpc={rpc} project={project} idea={idea} onApproved={() => setStep('build')} />}
        {step === 'build' && <BuildScreen rpc={rpc} project={project} onPlay={play} />}
        {step === 'share' && <ShareScreen rpc={rpc} project={project} onBack={play} />}
        {step === 'play' && (
          <div className="cr-playgrid">
            <div className="cr-pane">
              {/* The game stays mounted when the tab changes, so it keeps running. */}
              <div style={{ display: tab === 'play' ? 'contents' : 'none' }}><PlayScreen rpc={rpc} project={project} onAttach={attach} active={tab === 'play'} moment={moment} onFreeze={freeze} /></div>
              {tab === 'everything' && <Everything rpc={rpc} project={project} library={library} onAttach={attach} onOpen={setSheet} />}
              {tab === 'changes' && <Changes rpc={rpc} />}
            </div>
            {builder}
          </div>
        )}
      </main>

      {open && <OpenSheet rpc={rpc} project={project} item={open} library={library ?? []} tunables={p.tunables} baselines={baselines} setTunableLocal={p.setTunableLocal} onClose={() => setSheet(null)} />}
    </div>
    </BuilderProvider>
  );
}
