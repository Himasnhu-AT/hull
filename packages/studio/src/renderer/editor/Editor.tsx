// The editor: title bar, Library, viewport (Game, Sound), Inspector and Dock. It talks to the project only through
// the protocol (lib/rpc.ts); the game view is an iframe of the project server's game page.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { OpenedProject } from '../../shared/appApi.ts';
import { RpcClient, studioUrl } from '../lib/rpc.ts';
import { Icon } from '../ui/Icon.tsx';
import { Dock, type DockTab } from './Dock.tsx';
import { Inspector } from './Inspector.tsx';
import { Library } from './Library.tsx';
import { BenchView, type BenchKind } from '../benches/Benches.tsx'; // w3-app-benches
import { SoundBench } from './SoundBench.tsx';
import { TitleBar, type BuildState, type Panels } from './TitleBar.tsx';
import { useProject, idFromPath } from './useProject.ts';
import { useSplit } from './useSplit.ts';

type View = 'game' | 'sound' | BenchKind; // w3-app-benches: character, vfx, look

interface Toast { text: string; error?: boolean; action?: { label: string; run(): void } }

const fmtBytes = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`);

export function Editor(props: { project: OpenedProject; platform: string; onClose(): void }): JSX.Element | null {
  // Created in an effect, not during render, so React's double-mount in development closes only the first client.
  const [rpc, setRpc] = useState<RpcClient | null>(null);
  const url = props.project.url;
  useEffect(() => {
    const c = new RpcClient(studioUrl(url));
    setRpc(c);
    return () => c.close();
  }, [url]);
  return rpc ? <EditorBody key={rpc.id} rpc={rpc} {...props} /> : null;
}

function EditorBody({ rpc, project, platform, onClose }: { rpc: RpcClient; project: OpenedProject; platform: string; onClose(): void }): JSX.Element {
  const p = useProject(rpc);

  const [panels, setPanels] = useState<Panels>({ lib: true, dock: true, insp: true });
  const [view, setView] = useState<View>('game');
  const [dockTab, setDockTab] = useState<DockTab>('console');
  const [selected, setSelected] = useState<string | null>(null);
  const [build, setBuild] = useState<BuildState>('idle');
  const [toast, setToast] = useState<Toast | null>(null);
  const [gameKey, setGameKey] = useState(0);
  const [ctl, setCtl] = useState({ paused: false, timeScale: 1 });
  const baselines = useRef(new Map<string, unknown>());
  const search = useRef<HTMLInputElement>(null);
  const split = useSplit();

  // The game's own report is the truth; between reports the buttons show what was just asked.
  useEffect(() => { if (p.report) setCtl({ paused: p.report.paused, timeScale: p.report.timeScale }); }, [p.report]);

  const control = useCallback((c: Parameters<typeof rpc.call<'game.control'>>[1], local?: Partial<typeof ctl>) => {
    if (local) setCtl((s) => ({ ...s, ...local }));
    rpc.call('game.control', c).catch((e: Error) => p.log('error', `Could not control the game: ${e.message}`, 'app'));
  }, [rpc, p]);

  const reveal = useCallback((path: string) => {
    const abs = path.startsWith('/') ? path : `${project.root}/${path}`;
    void window.hullApp?.reveal(abs);
  }, [project.root]);

  const runBuild = useCallback(async () => {
    if (build === 'running') return;
    setBuild('running');
    setPanels((s) => ({ ...s, dock: true }));
    setDockTab('console');
    p.log('info', 'Build started', 'build');
    try {
      const r = await rpc.call('tool.call', { name: 'build' });
      const out = (r.output ?? {}) as { outDir?: string; files?: { path: string; bytes: number; gzip?: number }[] };
      if (r.ok) {
        const dir = out.outDir ?? `${project.root}/dist`;
        const files = out.files ?? [];
        const total = files.reduce((n, f) => n + f.bytes, 0);
        for (const f of files) p.log('info', `${f.path}  ${fmtBytes(f.bytes)}${f.gzip ? ` (${fmtBytes(f.gzip)} gzip)` : ''}`, 'build');
        p.log('ok', `Build finished${total ? `: ${files.length} file${files.length === 1 ? '' : 's'}, ${fmtBytes(total)}` : ''} in ${dir}`, 'build');
        setToast({ text: 'Build finished', action: { label: 'Open folder', run: () => { void window.hullApp?.reveal(dir); } } });
      } else {
        for (const pr of r.problems) p.log('error', `${pr.file}${pr.line ? `:${pr.line}${pr.col ? `:${pr.col}` : ''}` : pr.pointer ? `#${pr.pointer}` : ''}  ${pr.message}`, 'build', idFromPath(pr.file) ?? undefined);
        if (r.problems.length === 0) p.log('error', 'Build failed with no details. Check the server output.', 'build');
        setToast({ text: `Build failed: ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}`, error: true });
      }
    } catch (e) {
      p.log('error', `Build failed: ${e instanceof Error ? e.message : String(e)}`, 'build');
      setToast({ text: 'Build failed', error: true });
    } finally { setBuild('idle'); }
  }, [build, rpc, p, project.root]);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 8000); return () => clearTimeout(t); }, [toast]);

  // Shortcuts people expect: Space plays or pauses, "." steps, Cmd or Ctrl K finds, Cmd or Ctrl B builds.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPanels((s) => ({ ...s, lib: true })); setTimeout(() => search.current?.focus(), 0); }
      else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); void runBuild(); }
      else if (!typing && !mod && e.key === ' ' && (t?.tagName !== 'BUTTON')) { e.preventDefault(); control({ paused: !ctl.paused }, { paused: !ctl.paused }); }
      else if (!typing && !mod && e.key === '.') control({ step: 1 }, { paused: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [control, ctl.paused, runBuild]);

  const items = p.library ?? [];
  const item = items.find((i) => i.id === selected) ?? null;
  const sounds = useMemo(() => items.filter((i) => i.kind === 'sound'), [items]);
  const changed = useMemo(() => new Set(p.journal.map((c) => c.target)), [p.journal]);
  const problemCount = Math.max(p.problems.length, items.reduce((n, i) => n + i.problems, 0));

  const select = useCallback((id: string) => setSelected(id), []);
  const openFromConsole = useCallback((id: string) => { setSelected(id); setPanels((s) => ({ ...s, insp: true })); }, []);

  const { lib, insp, dock } = panels;
  const w = split.sizes;
  const cols = `${lib ? `${w.lib}px ` : ''}minmax(0, 1fr)${insp ? ` ${w.insp}px` : ''}`;
  const rows = `44px minmax(0, 1fr)${dock ? ` ${w.dock}px` : ''}`;
  const mid = [lib ? 'lib' : '', 'view', insp ? 'insp' : ''].filter(Boolean);
  const areas = [
    `"${mid.map(() => 'top').join(' ')}"`,
    `"${mid.join(' ')}"`,
    ...(dock ? [`"${mid.map((m) => (m === 'view' ? 'dock' : m)).join(' ')}"`] : []),
  ].join(' ');

  const gameNote = p.status !== 'open' ? 'Connecting...' : p.report ? 'Live: edits apply while it runs' : 'Waiting for the game to start';

  return (
    <div className="win" style={{ gridTemplateColumns: cols, gridTemplateRows: rows, gridTemplateAreas: areas }}>
      <TitleBar
        platform={platform} title={project.title} paused={ctl.paused} timeScale={ctl.timeScale} connected={p.status === 'open'}
        problems={problemCount} build={build} panels={panels}
        onTogglePanel={(k) => setPanels((s) => ({ ...s, [k]: !s[k] }))}
        onPlay={() => control({ paused: !ctl.paused }, { paused: !ctl.paused })}
        onStep={() => control({ step: 1 }, { paused: true })}
        onRestart={() => control({ restart: true })}
        onSpeed={(s) => control({ timeScale: s }, { timeScale: s })}
        onBuild={() => void runBuild()}
        onProblems={() => { setPanels((s) => ({ ...s, dock: true })); setDockTab('console'); }}
        onClose={onClose}
      />

      {lib && <Library ref={search} items={p.library} error={p.libraryError} selected={selected} changed={changed} onSelect={select} />}

      <main className="view">
        <div className="bar">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={view === 'game'} className={`tab${view === 'game' ? ' on' : ''}`} onClick={() => setView('game')}><Icon name="game" />Game</button>
            <button role="tab" aria-selected={view === 'sound'} className={`tab${view === 'sound' ? ' on' : ''}`} onClick={() => setView('sound')}><Icon name="audio" />Sound</button>
            {/* w3-app-benches */}
            <button role="tab" aria-selected={view === 'character'} className={`tab${view === 'character' ? ' on' : ''}`} onClick={() => setView('character')}><Icon name="characters" />Character</button>
            <button role="tab" aria-selected={view === 'vfx'} className={`tab${view === 'vfx' ? ' on' : ''}`} onClick={() => setView('vfx')}><Icon name="world" />VFX</button>
            <button role="tab" aria-selected={view === 'look'} className={`tab${view === 'look' ? ' on' : ''}`} onClick={() => setView('look')}><Icon name="sliders" />Look</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span className="note">{view === 'game' ? gameNote : view === 'sound' ? 'Rendered offline from the file' : 'Runs the real engine; edits show live'}</span>
            {view === 'game' && <button className="btn ghost" onClick={() => setGameKey((k) => k + 1)} title="Reload the game page" aria-label="Reload the game page" style={{ padding: '0 6px' }}><Icon name="reload" /></button>}
          </div>
        </div>
        <div className="stage">
          {view === 'game' && (
            <>
              <iframe key={gameKey} title="Game" src={project.gameUrl} allow="autoplay; gamepad; fullscreen" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms" />
              {p.report && (
                <div className="hud glass" aria-label="Game status">
                  <span><b>tick</b>{p.report.tick}</span><span><b>time</b>{p.report.time.toFixed(2)} s</span><span><b>fps</b>{Math.round(p.report.fps)}</span><span><b>speed</b>{p.report.timeScale}×</span>
                </div>
              )}
              {ctl.paused && p.report && <div className="badge glass"><Icon name="pause" size={13} />Paused. Use Step to advance one tick.</div>}
              {p.status !== 'open' && <div className="badge glass warn"><Icon name="warn" size={13} />{p.status === 'closed' ? 'Lost the connection to the project. Reconnecting...' : 'Connecting to the project...'}</div>}
            </>
          )}
          {view === 'sound' && <SoundBench rpc={rpc} sounds={sounds} selected={selected} onSelect={select} />}
          {(view === 'character' || view === 'vfx' || view === 'look') && <BenchView key={view} kind={view} rpc={rpc} items={items} selected={selected} onSelect={select} />}
        </div>
      </main>

      {insp && (
        <Inspector rpc={rpc} item={item} library={items} tunables={p.tunables} baselines={baselines} setTunableLocal={p.setTunableLocal}
          onOpenSound={(id) => { setSelected(id); setView('sound'); }} reveal={reveal} />
      )}

      {dock && <Dock tab={dockTab} onTab={setDockTab} logs={p.logs} problems={p.problems} journal={p.journal} onClear={p.clearLogs} onOpen={openFromConsole} />}

      {lib && <div className={`splitter v${split.active === 'lib' ? ' drag' : ''}`} style={{ left: w.lib - 3 }} {...split.bind('lib', 1, 200, 420)} role="separator" aria-orientation="vertical" aria-label="Resize Library" />}
      {insp && <div className={`splitter v${split.active === 'insp' ? ' drag' : ''}`} style={{ right: w.insp - 3 }} {...split.bind('insp', -1, 260, 560)} role="separator" aria-orientation="vertical" aria-label="Resize Inspector" />}
      {dock && <div className={`splitter h${split.active === 'dock' ? ' drag' : ''}`} style={{ bottom: w.dock - 3, left: lib ? w.lib : 0, right: insp ? w.insp : 0 }} {...split.bind('dock', -1, 120, 520, 'y')} role="separator" aria-orientation="horizontal" aria-label="Resize Dock" />}

      {toast && (
        <div className={`toast glass${toast.error ? ' err' : ''}`} role="status">
          {toast.text}
          {toast.action && <button className="btn" onClick={toast.action.run}><Icon name="folder" />{toast.action.label}</button>}
          <button className="btn ghost" onClick={() => setToast(null)} aria-label="Dismiss" style={{ padding: '0 6px' }}><Icon name="close" /></button>
        </div>
      )}
    </div>
  );
}
