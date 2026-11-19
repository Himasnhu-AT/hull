// The editor: title bar, Library, viewport (Game, Sound), Inspector and Dock. It talks to the project only through
// the protocol (lib/rpc.ts); the game view is an iframe of the project server's game page.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { OpenedProject } from '../../shared/appApi.ts';
import { RpcClient, studioUrl } from '../lib/rpc.ts';
import { Icon } from '../ui/Icon.tsx';
import { Dock, type DockTab } from './Dock.tsx';
import { ContentBrowser } from '../content/ContentBrowser.tsx';
import { Inspector } from './Inspector.tsx';
import { Library } from './Library.tsx';
import { BenchView, type BenchKind } from '../benches/Benches.tsx'; // w3-app-benches
import { SoundBench } from './SoundBench.tsx';
import { AgentPanel } from './AgentPanel.tsx';
import { TitleBar, type BuildState, type Panels } from './TitleBar.tsx';
import { useProject, idFromPath } from './useProject.ts';
// History and experiments (M2): the wiring lines are marked "history:".
import { useHistory } from '../history/useHistory.ts';
import { useExpEditing } from '../history/useExpEditing.ts';
import { HistoryPanel } from '../history/HistoryPanel.tsx';
import { ChangesPanel } from '../history/ChangesPanel.tsx';
import { ExpSwitch } from '../history/ExpSwitch.tsx';
import { Compare } from '../history/Compare.tsx';
import { AdoptDialog } from '../history/AdoptDialog.tsx';
import { useSplit } from './useSplit.ts';
import { fmtBytes, placeOf, useBuild } from '../create/useBuild.ts';

type View = 'game' | 'sound' | 'compare' | BenchKind; // w3-app-benches: character, vfx, look; w3-app-history: compare

interface Toast { text: string; error?: boolean; action?: { label: string; run(): void } }

/** The page URL with the launch options applied (the project server keeps and cleans them). */
const withLaunch = (url: string, query: string): string => (query ? url + (url.includes('?') ? '&' : '?') + query : url);

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
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [view, setView] = useState<View>('game');
  const [dockTab, setDockTab] = useState<DockTab>('console');
  // The Content Browser can pop out to the full window width, over the Library and the Inspector columns.
  const [dockWide, setDockWide] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [gameKey, setGameKey] = useState(0);
  // Page options the game opens with (start=camp&look=night). The project server keeps them per project; the frame applies them.
  const [launch, setLaunch] = useState('');
  useEffect(() => { let live = true; rpc.call('project.launch', {}).then((r) => { if (live) setLaunch(r.query); }, () => { /* an older server keeps none */ }); return () => { live = false; }; }, [rpc]);
  const applyLaunch = useCallback((q: string) => {
    rpc.call('project.launch', { query: q }).then((r) => { setLaunch(r.query); setGameKey((k) => k + 1); }, () => setToast({ text: 'Could not keep the launch options', error: true }));
  }, [rpc]);
  const [ctl, setCtl] = useState({ paused: false, timeScale: 1 });
  const baselines = useRef(new Map<string, unknown>());
  const search = useRef<HTMLInputElement>(null);
  const split = useSplit();
  // history: the timeline, the experiments, which line the Game view and the Inspector are on, and the compare pair.
  const notify = useCallback((text: string, error?: boolean) => setToast({ text, ...(error ? { error } : {}) }), []);
  const h = useHistory(rpc, p.problems, notify);
  const [openExp, setOpenExp] = useState<string | null>(null);
  const [pair, setPair] = useState<{ a: string; b: string }>({ a: 'main', b: '' });
  const openInfo = h.exps.find((e) => e.name === openExp && e.status === 'active');
  // An experiment that was adopted or discarded closes; one just started may not be in the list yet.
  useEffect(() => { if (openExp && h.exps.some((e) => e.name === openExp && e.status !== 'active')) setOpenExp(null); }, [openExp, h.exps]);
  const ed = useExpEditing(rpc, openInfo ? openInfo.name : null, p.tunables, p.setTunableLocal, baselines, `${openInfo?.tip}/${openInfo?.changes}`);
  const compareExps = useCallback((a: string, b: string) => { setPair({ a, b }); setView('compare'); }, []);
  const compareNow = (() => {
    const active = h.exps.filter((e) => e.status === 'active').map((e) => e.name);
    const a = pair.a === 'main' || active.includes(pair.a) ? pair.a : 'main';
    const b = pair.b && pair.b !== a && (pair.b === 'main' || active.includes(pair.b)) ? pair.b : (['main', ...active].find((n) => n !== a) ?? 'main');
    return { a, b };
  })();

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

  const builder = useBuild(rpc, project.root);
  const build: BuildState = builder.state;
  const runBuild = useCallback(async () => {
    if (build === 'running') return;
    setPanels((s) => ({ ...s, dock: true }));
    setDockTab('console');
    p.log('info', 'Build started', 'build');
    const r = await builder.run();
    if (!r) return;
    if (r.ok) {
      for (const f of r.files) p.log('info', `${f.path}  ${fmtBytes(f.bytes)}${f.gzip ? ` (${fmtBytes(f.gzip)} gzip)` : ''}`, 'build');
      p.log('ok', `Build finished${r.total ? `: ${r.files.length} file${r.files.length === 1 ? '' : 's'}, ${fmtBytes(r.total)}` : ''} in ${r.dir}`, 'build');
      setToast({ text: 'Build finished', action: { label: 'Open folder', run: () => { void window.hullApp?.reveal(r.dir); } } });
    } else if (r.error) {
      p.log('error', `Build failed: ${r.error}`, 'build');
      setToast({ text: 'Build failed', error: true });
    } else {
      for (const pr of r.problems) p.log('error', `${placeOf(pr)}  ${pr.message}`, 'build', idFromPath(pr.file) ?? undefined);
      if (r.problems.length === 0) p.log('error', 'Build failed with no details. Check the server output.', 'build');
      setToast({ text: `Build failed: ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}`, error: true });
    }
  }, [build, builder, p]);

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
  // history: authorship problems (AI over your values) come from the check and are listed with the others.
  const allProblems = useMemo(() => [...p.problems, ...h.flags.filter((f) => !p.problems.some((x) => x.message === f.message))], [p.problems, h.flags]);
  const problemCount = Math.max(allProblems.length, items.reduce((n, i) => n + i.problems, 0));

  const select = useCallback((id: string) => setSelected(id), []);
  // Double-click or Enter in the Content Browser: select it, show the Inspector and open the bench that matches its kind.
  const openAsset = useCallback((id: string) => {
    setSelected(id);
    setPanels((s) => ({ ...s, insp: true }));
    const kind = (p.library ?? []).find((i) => i.id === id)?.kind;
    if (kind === 'sound') setView('sound');
    else if (kind === 'character' || kind === 'vfx' || kind === 'look') setView(kind);
  }, [p.library]);
  const toggleWide = useCallback(() => { setDockWide((v) => { if (!v) split.grow('dock', Math.round(window.innerHeight * 0.55)); return !v; }); }, [split.grow]);
  // changes-diff: a file clicked in the Library's Changed filter opens its diff in the Changes tab (and is selected too).
  const [changeFocus, setChangeFocus] = useState<{ id: string; n: number } | null>(null);
  const openChange = useCallback((id: string) => { setPanels((s) => ({ ...s, dock: true })); setDockTab('changes'); setChangeFocus((f) => ({ id, n: (f?.n ?? 0) + 1 })); }, []);
  const openFromConsole = useCallback((id: string) => { setSelected(id); setPanels((s) => ({ ...s, insp: true })); }, []);

  const { lib, insp, dock } = panels;
  const w = split.sizes;
  const cols = `${lib ? `${w.lib}px ` : ''}minmax(0, 1fr)${insp ? ` ${w.insp}px` : ''}`;
  const rows = `44px minmax(0, 1fr)${dock ? ` ${w.dock}px` : ''}`;
  const mid = [lib ? 'lib' : '', 'view', insp ? 'insp' : ''].filter(Boolean);
  const areas = [
    `"${mid.map(() => 'top').join(' ')}"`,
    `"${mid.join(' ')}"`,
    ...(dock ? [`"${mid.map((m) => (dockWide ? 'dock' : m === 'view' ? 'dock' : m)).join(' ')}"`] : []),
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
        agents={agentsOpen} onAgents={() => setAgentsOpen((v) => !v)}
        view={view} onView={(v) => setView(v as View)} compareCount={h.exps.filter((e) => e.status === 'active').length}
        note={view === 'game' ? (openInfo ? `Experiment ${openInfo.name}: edits go to it, not to main` : gameNote) : view === 'compare' ? 'Two lines running side by side' : view === 'sound' ? 'Rendered offline from the file' : 'Runs the real engine; edits show live'}
        branch={view === 'game' ? <ExpSwitch h={h} openExp={openInfo ? openInfo.name : null} onOpenExp={setOpenExp} /> : undefined}
        launch={view === 'game' ? launch : undefined} onLaunch={applyLaunch}
        onReload={view === 'game' ? () => setGameKey((k) => k + 1) : undefined}
      />
      <AgentPanel project={project} open={agentsOpen} onClose={() => setAgentsOpen(false)} />

      {lib && <Library ref={search} items={p.library} error={p.libraryError} selected={selected} changed={changed} onSelect={select} onOpenChanged={openChange} />}

      <main className="view">
        <div className="stage">
          {view === 'game' && (
            <>
              <iframe key={`${gameKey}${openInfo?.name ?? ''}`} title="Game" src={withLaunch(openInfo?.gameUrl ?? project.gameUrl, launch)} allow="autoplay; gamepad; fullscreen" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms" />
              {openInfo && <div className="hx-stagebadge glass"><Icon name="branch" size={13} />experiment {openInfo.name}</div>}
              {p.report && !openInfo && (
                <div className="hud glass" aria-label="Game status">
                  <span><b>tick</b>{p.report.tick}</span><span><b>time</b>{p.report.time.toFixed(2)} s</span><span><b>fps</b>{Math.round(p.report.fps)}</span><span><b>speed</b>{p.report.timeScale}×</span>
                </div>
              )}
              {ctl.paused && p.report && <div className="badge glass"><Icon name="pause" size={13} />Paused. Use Step to advance one tick.</div>}
              {p.status !== 'open' && <div className="badge glass warn"><Icon name="warn" size={13} />{p.status === 'closed' ? 'Lost the connection to the project. Reconnecting...' : 'Connecting to the project...'}</div>}
            </>
          )}
          {view === 'compare' && <Compare rpc={rpc} h={h} mainUrl={project.gameUrl} a={compareNow.a} b={compareNow.b} onPick={(a, b) => setPair({ a, b })} version={h.exps.map((e) => `${e.name}${e.tip}`).join()} />}
          {view === 'sound' && <SoundBench rpc={rpc} gameUrl={project.gameUrl} sounds={sounds} selected={selected} onSelect={select} />}
          {(view === 'character' || view === 'vfx' || view === 'look') && <BenchView key={view} kind={view} rpc={rpc} gameUrl={project.gameUrl} items={items} selected={selected} onSelect={select} />}
        </div>
      </main>

      {insp && (
        <Inspector key={openInfo?.name ?? 'main'} rpc={ed.rpc} item={item} library={items} tunables={ed.tunables} baselines={ed.baselines} setTunableLocal={ed.setTunableLocal}
          onOpenSound={(id) => { setSelected(id); setView('sound'); }} reveal={reveal} />
      )}

      {dock && <Dock tab={dockTab} onTab={(t) => { setDockTab(t); if (t === 'content') split.grow('dock', 340); }} logs={p.logs} problems={allProblems} journal={p.journal} onClear={p.clearLogs} onOpen={openFromConsole}
        flagged={h.flagged.size}
        content={<ContentBrowser rpc={rpc} items={p.library} error={p.libraryError} selected={selected} changed={changed} onSelect={select} onOpen={openAsset} onReveal={reveal} notify={notify} wide={dockWide} onWide={toggleWide} />}
        changes={<ChangesPanel rpc={rpc} h={h} tunables={p.tunables} tick={p.journal.length} focus={changeFocus} notify={notify} />}
        history={<HistoryPanel h={h} openExp={openInfo ? openInfo.name : null} onOpenExp={setOpenExp} onCompare={compareExps} onProblems={() => setDockTab('console')} />} />}

      {lib && <div className={`splitter v${split.active === 'lib' ? ' drag' : ''}`} style={{ left: w.lib - 3 }} {...split.bind('lib', 1, 200, 420)} role="separator" aria-orientation="vertical" aria-label="Resize Library" />}
      {insp && <div className={`splitter v${split.active === 'insp' ? ' drag' : ''}`} style={{ right: w.insp - 3 }} {...split.bind('insp', -1, 260, 560)} role="separator" aria-orientation="vertical" aria-label="Resize Inspector" />}
      {dock && <div className={`splitter h${split.active === 'dock' ? ' drag' : ''}`} style={{ bottom: w.dock - 3, left: lib && !dockWide ? w.lib : 0, right: insp && !dockWide ? w.insp : 0 }} {...split.bind('dock', -1, 120, Math.max(520, window.innerHeight - 160), 'y')} role="separator" aria-orientation="horizontal" aria-label="Resize Dock" />}

      <AdoptDialog h={h} />

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
