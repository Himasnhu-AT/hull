// The launcher: start a project from a template, open a folder, or pick a recent one.

import { useEffect, useState, type JSX } from 'react';
import type { CommunityGame, HullApp, OpenedProject, RecentProject, TemplateInfo } from '../../shared/appApi.ts';
import { Icon } from '../ui/Icon.tsx';

type Pane = 'recent' | 'new' | 'community';

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

export function Launcher({ app, onOpen, startError }: { app: HullApp; onOpen(p: OpenedProject): void; startError?: string | null }): JSX.Element {
  const [recents, setRecents] = useState<RecentProject[] | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [pane, setPane] = useState<Pane>('recent');
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

  useEffect(() => {
    void app.recents().then((r) => { setRecents(r); if (r.length === 0) setPane('new'); }, () => setRecents([]));
    void app.listTemplates().then((t) => { setTemplates(t); setTpl((cur) => cur || t[0]?.name || ''); }, (e) => { setTemplates([]); setError(msg(e)); });
  }, [app]);

  const loadGames = (): void => {
    setGames(null); setGamesError(null);
    app.listCommunity().then(setGames, (e) => { setGames([]); setGamesError(msg(e)); });
  };
  useEffect(() => { if (pane === 'community' && games === null && !gamesError) loadGames(); }, [pane]); // eslint-disable-line react-hooks/exhaustive-deps

  const openGame = (g: CommunityGame, reset: boolean): Promise<void> => {
    setWorking({ id: g.id, reset }); setConfirming(null);
    return run('Opening', () => app.openCommunity(g.id, reset)).finally(() => setWorking(null));
  };

  const run = async (label: string, job: () => Promise<OpenedProject | null>): Promise<void> => {
    setBusy(label); setError(null);
    try { const p = await job(); if (p) onOpen(p); } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  };

  const openFolder = (): Promise<void> => run('Opening', async () => { const dir = await app.pickFolder('open'); return dir ? app.openProject(dir) : null; });
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
        <p className="tag">Build games with an AI. Check and tune them here.</p>
        <div className="acts">
          <button className={`act${pane === 'new' ? ' on' : ''}`} onClick={() => setPane('new')}>
            <span className="ic"><Icon name="plus" /></span><span><b>New project</b><small>Start from a template</small></span>
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
        <div className="l-foot">Library on the left, Inspector on the right, Build in the title bar.</div>
      </div>

      <div className="l-main drag">
        <div className="l-in nodrag">
          {error && <div className="note-err" role="alert">{error}</div>}

          {pane === 'recent' && (
            <>
              <div><h2>Recent projects</h2><p className="sub2">Pick one to carry on where you left off.</p></div>
              {recents === null && <div className="rlist"><div className="skeleton" /><div className="skeleton" /></div>}
              {recents && recents.length === 0 && <p className="sub2">Nothing here yet. Start a new project, or open a folder.</p>}
              {recents && recents.length > 0 && (
                <div className="rlist">
                  {recents.map((r) => (
                    <div key={r.root} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <button className="rrow" style={{ flex: 1 }} disabled={busy !== null} onClick={() => void run('Opening', () => app.openProject(r.root))}>
                        <span style={{ minWidth: 0 }}><b>{r.title}</b><small>{r.root}</small></span><span className="when">{ago(r.openedAt)}</span>
                      </button>
                      <button className="btn ghost" onClick={() => void app.forgetRecent(r.root).then(() => setRecents((l) => (l ?? []).filter((x) => x.root !== r.root)))} aria-label={`Remove ${r.title} from the list`} title="Remove from the list (keeps the files)" style={{ padding: '0 6px' }}><Icon name="close" /></button>
                    </div>
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
                <div className="glist">
                  {games.map((g) => {
                    const mine = working?.id === g.id;
                    return (
                      <article key={g.id} className="game">
                        <div className="cover">{g.cover ? <img src={g.cover} alt="" draggable={false} /> : <Icon name="game" size={28} />}</div>
                        <div className="g-body">
                          <div className="g-title"><b>{g.title}</b>{g.copy.exists && <span className="tagchip" title={g.copy.root}>Your copy</span>}</div>
                          <p className="g-note">{g.note}</p>
                          {confirming === g.id ? (
                            <div className="g-confirm" role="alertdialog" aria-label={`Reset ${g.title}`}>
                              <span>Replace your copy with the original? Your changes to it are lost.</span>
                              <button className="btn danger" onClick={() => void openGame(g, true)} disabled={busy !== null}>Reset</button>
                              <button className="btn ghost" onClick={() => setConfirming(null)}>Keep my copy</button>
                            </div>
                          ) : (
                            <div className="g-acts">
                              <button className="btn primary" onClick={() => void openGame(g, false)} disabled={busy !== null}>
                                <Icon name="play" size={12} />{mine ? (working?.reset ? 'Resetting...' : g.copy.exists ? 'Opening...' : 'Copying...') : 'Play'}
                              </button>
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
      </div>
    </div>
  );
}
