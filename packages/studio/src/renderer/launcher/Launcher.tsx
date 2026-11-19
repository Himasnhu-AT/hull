// The launcher: one box for the idea first. Under it, quieter choices: start from a template, Community, Recent, Open folder.

import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { CommunityGame, HullApp, OpenedProject, RecentProject, TemplateInfo } from '../../shared/appApi.ts';
import { useOnboarding } from '../onboarding/open.tsx';
import { useSettings } from '../settings/open.tsx';
import { Composer } from '../create/Composer.tsx';
import { ModelPicker } from '../create/ModelPicker.tsx';
import { Icon } from '../ui/Icon.tsx';
import { RecentCard } from './RecentCard.tsx';

type Pane = 'idea' | 'recent' | 'new' | 'community';

const EXAMPLES: { label: string; idea: string }[] = [
  { label: 'Wave shooter', idea: 'A first-person arena where waves of drones come at me and I pick up ammo between rounds.' },
  { label: 'Gem run', idea: 'A small arena where I run and jump to collect gems before the clock runs out.' },
  { label: 'Samurai island', idea: 'A third-person samurai game on a windy island. One swordswoman against raiders. Every enemy shows what it is about to do and I answer with my blade.' },
];

const ago = (iso: string): string => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s) || s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

const msg = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

function Mark(): JSX.Element {
  // A hull seen from the side: one simple shape, in the accent colour.
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="10" fill="var(--accent-solid)" /><path d="M8 22h24l-4 8H12z" fill="#fff" /><path d="M20 9v11M20 9l8 9h-8" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg>
  );
}

/** `home`: the brief chat for a game just made from an idea; it takes the main pane, and New game leaves it (`onNew`). */
export function Launcher({ app, onOpen, startError, home, onNew }: { app: HullApp; onOpen(p: OpenedProject, idea?: string): void; startError?: string | null; home?: ReactNode; onNew?: () => void }): JSX.Element {
  const [recents, setRecents] = useState<RecentProject[] | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [pane, setPane] = useState<Pane>('idea');
  const [idea, setIdea] = useState('');
  const [tpl, setTpl] = useState<string>('');
  const [title, setTitle] = useState('My Game');
  const [parent, setParent] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(startError ?? null);
  const [games, setGames] = useState<CommunityGame[] | null>(null);
  const [gamesError, setGamesError] = useState<string | null>(null);
  // The game being opened or reset, and the one asking "replace your copy?".
  const [working, setWorking] = useState<{ id: string; reset: boolean } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The game asking "update your copy to the new version?".
  const [updating, setUpdating] = useState<string | null>(null);
  const settings = useSettings();
  const tour = useOnboarding();

  useEffect(() => {
    void app.recents().then((r) => { setRecents(r); }, () => setRecents([]));
    void app.listTemplates().then((t) => { setTemplates(t); setTpl((cur) => cur || t[0]?.name || ''); }, (e) => { setTemplates([]); setError(msg(e)); });
  }, [app]);

  const loadGames = (): void => {
    setGames(null); setGamesError(null);
    app.listCommunity().then(setGames, (e) => { setGames([]); setGamesError(msg(e)); });
  };
  useEffect(() => { if (pane === 'community' && games === null && !gamesError) loadGames(); }, [pane]); // eslint-disable-line react-hooks/exhaustive-deps

  const openGame = (g: CommunityGame, reset: boolean, update = false): Promise<void> => {
    setWorking({ id: g.id, reset: reset || update }); setConfirming(null); setUpdating(null);
    return run('Opening', () => app.openCommunity(g.id, reset, update)).finally(() => setWorking(null));
  };

  const run = async (label: string, job: () => Promise<OpenedProject | null>): Promise<void> => {
    setBusy(label); setError(null);
    try { const p = await job(); if (p) onOpen(p, (p as { idea?: string }).idea); } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  };

  const openFolder = (): Promise<void> => run('Opening', async () => { const dir = await app.pickFolder('open'); return dir ? app.openProject(dir) : null; });
  const makeFromIdea = (): Promise<void> => run('Creating', () => app.createFromIdea({ idea: idea.trim() }));
  const chooseWhere = async (): Promise<void> => { const d = await app.pickFolder('location'); if (d) setParent(d); };
  const create = (): Promise<void> => run('Creating', async () => {
    let dir = parent;
    if (!dir) { dir = await app.pickFolder('location'); if (!dir) return null; setParent(dir); }
    return app.createProject({ template: tpl, title: title.trim() || 'My Game', parentDir: dir });
  });

  return (
    <div className="launcher">
      <div className="l-side drag">
        <div className="mark"><Mark /><h1>Hull</h1></div>
        <p className="tag">Describe a game. The builder makes it. You play it and say what is off.</p>
        <div className="acts">
          <button className={`act${pane === 'idea' && !home ? ' on' : ''}`} onClick={() => { setPane('idea'); setIdea(''); onNew?.(); }}>
            <span className="ic"><Icon name="plus" /></span><span><b>New game</b><small>Start from an idea</small></span>
          </button>
          <button className={`act${pane === 'new' ? ' on' : ''}`} onClick={() => setPane('new')}>
            <span className="ic"><Icon name="gameplay" /></span><span><b>Start from a template</b><small>Pick a ready base</small></span>
          </button>
          <button className="act" onClick={() => void openFolder()} disabled={busy !== null}>
            <span className="ic"><Icon name="folder" /></span><span><b>Open folder</b><small>A project you already have</small></span>
          </button>
          <button className={`act${pane === 'community' ? ' on' : ''}`} onClick={() => setPane('community')}>
            <span className="ic"><Icon name="game" /></span><span><b>Community</b><small>Games to play and open</small></span>
          </button>
          <button className={`act${pane === 'recent' ? ' on' : ''}`} onClick={() => setPane('recent')}>
            <span className="ic"><Icon name="history" /></span><span><b>Recent projects</b><small>{recents ? `${recents.length} saved` : 'Loading'}</small></span>
          </button>
        </div>
        <button className="l-set l-tour" onClick={() => tour.open()} title="A short whiteboard tour"><Icon name="play" /><span>How Hull works</span><small>4 short lessons</small></button>
        <button className="l-set" onClick={() => settings.open()} title="Settings (⌘,)"><Icon name="gear" /><span>Settings</span><small>Keys, Claude Code, Codex, MCP</small></button>
        <div className="l-foot">Your games are kept by the app. You never need to pick a folder.</div>
      </div>

      {home ? <div className="l-main l-home">{home}</div> : <div className={`l-main drag${pane === 'idea' ? ' center' : ''}`}>
        <div className="l-in nodrag">
          {error && <div className="note-err" role="alert">{error}</div>}

          {pane === 'idea' && (
            <div className="l-hero">
              <h2>What game do you want to make?</h2>
              <p className="sub2">Say it in a sentence or two. The app picks a starting point for you.</p>
              <Composer value={idea} onChange={setIdea} onSend={() => { if (idea.trim() && busy === null) void makeFromIdea(); }} label="Your game idea" autoFocus
                placeholder="A third-person samurai game on a windy island..." sendLabel={busy === 'Creating' ? 'Making your game...' : 'Make my game'} disabled={busy !== null} busy={busy === 'Creating'} footer={<ModelPicker />} />
              <div className="cr-examples" role="group" aria-label="Examples">
                {EXAMPLES.map((x) => <button type="button" key={x.label} className="chip" onClick={() => setIdea(x.idea)}>{x.label}</button>)}
              </div>
              {busy === 'Creating' && <p className="sub2 l-making">Making your game...</p>}
              {recents && recents.length > 0 && (
                <section className="l-recents" aria-label="Recent projects">
                  <div className="l-rh"><b>Pick up where you left off</b>{recents.length > 4 && <button className="btn ghost" onClick={() => setPane('recent')}>View all {recents.length}</button>}</div>
                  <div className="l-rgrid">
                    {recents.slice(0, 4).map((r, i) => (
                      <RecentCard key={r.root} app={app} r={r} when={ago(r.openedAt)} delay={120 + i * 40} disabled={busy !== null}
                        onOpen={() => void run('Opening', () => app.openProject(r.root))} onError={setError}
                        onChange={(n) => setRecents((l) => (l ?? []).flatMap((x) => (x.root !== r.root ? [x] : n ? [n] : [])))} />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {pane === 'recent' && (
            <>
              <div><h2>Recent projects</h2><p className="sub2">Pick one to carry on where you left off.</p></div>
              {recents === null && <div className="rlist"><div className="skeleton" /><div className="skeleton" /></div>}
              {recents && recents.length === 0 && <p className="sub2">Nothing here yet. Start a new project, or open a folder.</p>}
              {recents && recents.length > 0 && (
                <div className="l-rgrid l-rall">
                  {recents.map((r, i) => (
                    <RecentCard key={r.root} app={app} r={r} when={ago(r.openedAt)} delay={Math.min(i, 8) * 30} disabled={busy !== null}
                      onOpen={() => void run('Opening', () => app.openProject(r.root))} onError={setError}
                      onChange={(n) => setRecents((l) => (l ?? []).flatMap((x) => (x.root !== r.root ? [x] : n ? [n] : [])))} />
                  ))}
                </div>
              )}
            </>
          )}

          {pane === 'community' && (
            <>
              <div><h2>Community</h2><p className="sub2">Games to play and take apart. Opening one gives you your own copy to edit; the original stays as it is.</p></div>
              {games === null && <div className="glist"><div className="skeleton gsk" /></div>}
              {gamesError && (
                <div className="note-err" role="alert">Could not load the games: {gamesError} <button className="btn" onClick={loadGames} style={{ marginLeft: 8 }}>Try again</button></div>
              )}
              {games && games.length === 0 && !gamesError && <p className="sub2">No community games yet.</p>}
              {games && games.length > 0 && (
                <div className="glist cgrid">
                  {games.map((g) => {
                    const mine = working?.id === g.id;
                    return (
                      <article key={g.id} className="game ccard">
                        <button className="cover" onClick={() => void openGame(g, false)} disabled={busy !== null} aria-label={`Play ${g.title}`}>{g.cover ? <img src={g.cover} alt="" draggable={false} /> : <Icon name="game" size={28} />}<span className="cplay" aria-hidden="true"><Icon name="play" size={16} /></span></button>
                        <div className="g-body">
                          <div className="g-title"><b>{g.title}</b>{g.version && <span className="g-ver" title={g.copy.version && g.copy.version !== g.version ? `Your copy is ${g.copy.version}` : undefined}>v{g.copy.exists && g.copy.version ? g.copy.version : g.version}</span>}{g.update && <span className="g-new">v{g.update} out</span>}</div>
                          <p className="g-note">{g.note}</p>
                          {updating === g.id ? (
                            <div className="g-confirm" role="alertdialog" aria-label={`Update ${g.title}`}>
                              <span>Update your copy to v{g.update}? It replaces your copy, so your changes to it are lost.</span>
                              <button className="btn primary" onClick={() => void openGame(g, false, true)} disabled={busy !== null}>Update</button>
                              <button className="btn ghost" onClick={() => setUpdating(null)}>Not now</button>
                            </div>
                          ) : confirming === g.id ? (
                            <div className="g-confirm" role="alertdialog" aria-label={`Reset ${g.title}`}>
                              <span>Replace your copy with the original? Your changes to it are lost.</span>
                              <button className="btn danger" onClick={() => void openGame(g, true)} disabled={busy !== null}>Reset</button>
                              <button className="btn ghost" onClick={() => setConfirming(null)}>Keep my copy</button>
                            </div>
                          ) : (
                            <div className="g-acts">
                              <button className="btn primary" onClick={() => void openGame(g, false)} disabled={busy !== null}>
                                <Icon name={g.copy.exists ? 'back' : 'play'} size={12} style={g.copy.exists ? { transform: 'rotate(180deg)' } : undefined} />{mine ? (working?.reset ? (g.update ? 'Updating...' : 'Resetting...') : g.copy.exists ? 'Opening...' : g.source === 'server' ? 'Downloading...' : 'Copying...') : g.copy.exists ? 'Visit your copy' : 'Play'}
                              </button>
                              {g.update && <button className="btn" onClick={() => setUpdating(g.id)} disabled={busy !== null}><Icon name="reload" size={13} />Update to v{g.update}</button>}
                              {g.copy.exists && (
                                <button className="btn ghost" onClick={() => setConfirming(g.id)} disabled={busy !== null} aria-label={`Reset ${g.title} to the original`} title="Reset to original"><Icon name="reset" size={14} />Reset to original</button>
                              )}
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {pane === 'new' && (
            <>
              <div><h2>New project</h2><p className="sub2">Pick a template. You can change everything afterwards.</p></div>
              {templates === null && <div className="tpls"><div className="skeleton" style={{ height: 84 }} /><div className="skeleton" style={{ height: 84 }} /></div>}
              {templates && templates.length === 0 && <p className="sub2">No templates were found.</p>}
              {templates && templates.length > 0 && (
                <div className="tpls" role="radiogroup" aria-label="Template">
                  {templates.map((t) => (
                    <button key={t.name} role="radio" aria-checked={tpl === t.name} className={`tpl${tpl === t.name ? ' on' : ''}`} onClick={() => setTpl(t.name)}>
                      <b>{t.title}</b><span>{t.description}</span>
                    </button>
                  ))}
                </div>
              )}
              <form className="form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
                <label className="lab">Name<input className="field-in" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="My Game" autoFocus /></label>
                <div className="lab">Where
                  <div className="where">
                    <span className={`path${parent ? ' set' : ''}`} title={parent ?? ''}><bdo dir="ltr">{parent ?? 'Choose a folder'}</bdo></span>
                    <button type="button" className="btn" onClick={() => void chooseWhere()} style={{ height: 32 }}>Choose</button>
                  </div>
                </div>
                <div><button type="submit" className="btn primary lg" disabled={busy !== null || !tpl}>{busy === 'Creating' ? 'Creating...' : 'Create project'}</button></div>
              </form>
            </>
          )}
          {busy === 'Opening' && <p className="sub2">Starting the project server...</p>}
        </div>
      </div>}
    </div>
  );
}
