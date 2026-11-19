import type { JSX } from 'react';
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
}

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
        <button className={`chip${p.agents ? ' on' : ''}`} data-agents-toggle onClick={p.onAgents} aria-expanded={p.agents} title="Connect Claude Code, Codex or another MCP client to this project"><Icon name="plug" />Agents</button>
        {p.problems > 0 && <button className="chip" onClick={p.onProblems} title="Show problems in the Console"><Icon name="warn" />Problems <span className="count">{p.problems}</span></button>}
        <button className="btn" onClick={p.onBuild} disabled={p.build === 'running' || !p.connected} title="Build one JavaScript file for the web and desktop (Cmd B)">
          <Icon name={p.build === 'running' ? 'reload' : 'build'} className={p.build === 'running' ? 'spin' : undefined} />{p.build === 'running' ? 'Building' : 'Build'}
        </button>
        <div className="ptog" role="group" aria-label="Panels">
          {toggles.map((t) => <button key={t.key} className={`pt${p.panels[t.key] ? ' on' : ''}`} aria-pressed={p.panels[t.key]} aria-label={t.label} title={`${p.panels[t.key] ? 'Hide' : 'Show'} ${t.label}`} onClick={() => p.onTogglePanel(t.key)}><Icon name={t.icon} /></button>)}
          <button className="pt" disabled aria-label="AI chat" title="AI chat: coming after M1"><Icon name="chat" /></button>
        </div>
      </div>
    </header>
  );
}
