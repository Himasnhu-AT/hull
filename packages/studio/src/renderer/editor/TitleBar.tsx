import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { Icon, type IconName } from '../ui/Icon.tsx';

export interface Panels { lib: boolean; dock: boolean; insp: boolean }
export type BuildState = 'idle' | 'running';

interface Props {
  platform: string;
  title: string;
  paused: boolean;
  timeScale: number;
  connected: boolean;
  problems: number;
  build: BuildState;
  panels: Panels;
  onTogglePanel(p: keyof Panels): void;
  onPlay(): void;
  onStep(): void;
  onRestart(): void;
  onSpeed(s: number): void;
  onBuild(): void;
  onProblems(): void;
  onClose(): void;
  agents: boolean;
  onAgents(): void;
  view: string;
  onView(v: string): void;
  compareCount: number;
  /** Live-status line: shown as a dot with this text as its tooltip. */
  note: string;
  /** The branch picker, only when the Game view is showing. */
  branch?: ReactNode;
  onReload?(): void;
  /** The page options the game opens with, shown only in the Game view (undefined hides the field). */
  launch?: string;
  onLaunch?(query: string): void;
}

/** A small field for page options (start=camp&look=night). Enter or leaving the field keeps them and reloads the game. */
function LaunchField({ value, onCommit }: { value: string; onCommit(q: string): void }): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => { if (draft.trim().replace(/^\?/, '') !== value) onCommit(draft); };
  return (
    <input
      className="launch" value={draft} spellCheck={false} placeholder="Launch options: start=camp&look=night"
      aria-label="Launch options for the game page" title="Page options the game opens with, like start=camp or look=night. Enter applies them and reloads; kept for this project."
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyUp={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setDraft(value); }}
    />
  );
}

const VIEWS: { id: string; icon: IconName; label: string }[] = [
  { id: 'game', icon: 'game', label: 'Game' },
  { id: 'compare', icon: 'compare', label: 'Compare' },
  { id: 'sound', icon: 'audio', label: 'Sound' },
  { id: 'character', icon: 'characters', label: 'Character' },
  { id: 'vfx', icon: 'world', label: 'VFX' },
  { id: 'look', icon: 'sliders', label: 'Look' },
];

const SPEEDS: [number, string][] = [[0.25, '¼×'], [1, '1×'], [2, '2×']];

export function TitleBar(p: Props): JSX.Element {
  const toggles: { key: keyof Panels; icon: IconName; label: string }[] = [
    { key: 'lib', icon: 'lib', label: 'Library' },
    { key: 'dock', icon: 'dock', label: 'Console and Changes' },
    { key: 'insp', icon: 'insp', label: 'Inspector' },
  ];
  return (
    <header className={`top drag${p.platform === 'darwin' ? ' mac' : ''}`}>
      <div className="l">
        <button className="btn ghost" onClick={p.onClose} title="Back to your projects" aria-label="Back to your projects" style={{ padding: '0 6px' }}><Icon name="back" /></button>
        <div className="ttl"><b>{p.title}</b><span>Hull</span></div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="seg views" role="tablist" aria-label="Views">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={p.view === v.id} className={p.view === v.id ? 'on' : ''} onClick={() => p.onView(v.id)} title={v.label} aria-label={v.label}>
              <Icon name={v.icon} /><span className="vl">{v.label}</span>
              {v.id === 'compare' && p.compareCount > 0 && <span className="vc">{p.compareCount}</span>}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Play controls">
          <button className={p.paused ? '' : 'play'} onClick={p.onPlay} disabled={!p.connected} aria-label={p.paused ? 'Play' : 'Pause'} title={`${p.paused ? 'Play' : 'Pause'} the game (Space)`}>
            <Icon name={p.paused ? 'play' : 'pause'} />
          </button>
          <button onClick={p.onStep} disabled={!p.connected} aria-label="Step one tick" title="Step one tick ( . )"><Icon name="step" /></button>
          <button onClick={p.onRestart} disabled={!p.connected} aria-label="Restart the game" title="Restart from the start with the same seed"><Icon name="restart" /></button>
        </div>
        <div className="seg" role="group" aria-label="Game speed">
          {SPEEDS.map(([s, label]) => <button key={s} className={p.timeScale === s ? 'on' : ''} aria-pressed={p.timeScale === s} onClick={() => p.onSpeed(s)} disabled={!p.connected}>{label}</button>)}
        </div>
      </div>
      <div className="r">
        <span className={`live${p.connected ? ' on' : ''}`} role="status" aria-label={p.note} title={p.note} />
        {p.branch}
        {p.launch !== undefined && p.onLaunch && <LaunchField value={p.launch} onCommit={p.onLaunch} />}
        {p.onReload && <button className="btn ghost" onClick={p.onReload} title="Reload the game page" aria-label="Reload the game page" style={{ padding: '0 6px' }}><Icon name="reload" /></button>}
        <button className={`chip${p.agents ? ' on' : ''}`} data-agents-toggle onClick={p.onAgents} aria-expanded={p.agents} title="Connect Claude Code, Codex or another MCP client to this project"><Icon name="plug" /><span className="vl">Agents</span></button>
        {p.problems > 0 && <button className="chip" onClick={p.onProblems} title="Show problems in the Console"><Icon name="warn" />Problems <span className="count">{p.problems}</span></button>}
        <button className="btn" onClick={p.onBuild} disabled={p.build === 'running' || !p.connected} title="Build one JavaScript file for the web and desktop (Cmd B)">
          <Icon name={p.build === 'running' ? 'reload' : 'build'} className={p.build === 'running' ? 'spin' : undefined} /><span className="vl">{p.build === 'running' ? 'Building' : 'Build'}</span>
        </button>
        <div className="ptog" role="group" aria-label="Panels">
          {toggles.map((t) => <button key={t.key} className={`pt${p.panels[t.key] ? ' on' : ''}`} aria-pressed={p.panels[t.key]} aria-label={t.label} title={`${p.panels[t.key] ? 'Hide' : 'Show'} ${t.label}`} onClick={() => p.onTogglePanel(t.key)}><Icon name={t.icon} /></button>)}
          <button className="pt" disabled aria-label="AI chat" title="AI chat: coming after M1"><Icon name="chat" /></button>
        </div>
      </div>
    </header>
  );
}
