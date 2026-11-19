import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { HullApp, OpenedProject } from '../shared/appApi.ts';
import { CreateShell } from './create/CreateShell.tsx';
import { Launcher } from './launcher/Launcher.tsx';
import { SettingsCtx, type SettingsOpener, type SettingsSection } from './settings/open.tsx';
import { Settings } from './settings/Settings.tsx';

export function App({ app }: { app: HullApp }): JSX.Element {
  // `idea` is set only for a project made from the idea box: it starts on the Brief step.
  const [open, setOpen] = useState<{ project: OpenedProject; idea?: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<{ section?: SettingsSection | undefined; onKeysSaved?: (() => void) | undefined } | null>(null);

  // Web dev mode can open a project at start (`--project <dir>`); in Electron this resolves to nothing.
  useEffect(() => { void app.initialProject().then((p) => { if (p) setOpen({ project: p }); }, () => {}).finally(() => setReady(true)); }, [app]);

  const close = useCallback(() => { setOpen(null); void app.closeProject(); }, [app]);
  const opener = useMemo<SettingsOpener>(() => ({ open: (section, onKeysSaved) => setSettings({ section, onKeysSaved }) }), []);

  // Cmd+, (Ctrl+, elsewhere) opens Settings from anywhere, as in every Mac app; again closes it.
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === ',' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) { e.preventDefault(); setSettings((s) => (s ? null : {})); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  if (!ready) return <div className="fatal" aria-busy="true" />;
  return (
    <SettingsCtx.Provider value={opener}>
      {open
        ? <CreateShell key={open.project.root} project={open.project} platform={app.platform} idea={open.idea} onClose={close} />
        : <Launcher app={app} onOpen={(project, idea) => setOpen({ project, ...(idea ? { idea } : {}) })} />}
      {settings && <Settings app={app} project={open?.project ?? null} section={settings.section} onKeysSaved={settings.onKeysSaved} onClose={() => setSettings(null)} />}
    </SettingsCtx.Provider>
  );
}
