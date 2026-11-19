import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { HullApp, OpenedProject } from '../shared/appApi.ts';
import { CreateShell } from './create/CreateShell.tsx';
import { HomeBrief } from './launcher/HomeBrief.tsx';
import { Launcher } from './launcher/Launcher.tsx';
import { OnboardingHost } from './onboarding/open.tsx';
import { SettingsCtx, type SettingsOpener, type SettingsSection } from './settings/open.tsx';
import { Settings } from './settings/Settings.tsx';

// The first-run tour sits over whatever screen is showing; useOnboarding().open() from onboarding/open.tsx opens it again.
export function App({ app }: { app: HullApp }): JSX.Element {
  return <OnboardingHost><AppScreens app={app} /></OnboardingHost>;
}

function AppScreens({ app }: { app: HullApp }): JSX.Element {
  // `idea` is set only for a project made from the idea box: it starts on the Brief step.
  // A game made from an idea stays on the home page (`phase: 'brief'`) until its brief is done, then opens at Build.
  const [open, setOpen] = useState<{ project: OpenedProject; idea?: string; phase?: 'brief' | 'shell' } | null>(null);
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
      {open && open.phase !== 'brief'
        ? <CreateShell key={open.project.root} project={open.project} platform={app.platform} idea={open.idea} initialStep={open.idea ? 'build' : undefined} onClose={close} />
        : <Launcher app={app} onOpen={(project, idea) => setOpen({ project, ...(idea ? { idea, phase: 'brief' as const } : {}) })} onNew={open ? close : undefined}
            home={open ? <HomeBrief key={open.project.root} project={open.project} idea={open.idea ?? ''} onDone={() => setOpen({ ...open, phase: 'shell' })} onLeave={close} /> : undefined} />}
      {settings && <Settings app={app} project={open?.project ?? null} section={settings.section} onKeysSaved={settings.onKeysSaved} onClose={() => setSettings(null)} />}
    </SettingsCtx.Provider>
  );
}
