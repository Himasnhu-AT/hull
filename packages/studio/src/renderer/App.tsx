import { useCallback, useEffect, useState, type JSX } from 'react';
import type { HullApp, OpenedProject } from '../shared/appApi.ts';
import { CreateShell } from './create/CreateShell.tsx';
import { Launcher } from './launcher/Launcher.tsx';

export function App({ app }: { app: HullApp }): JSX.Element {
  // `idea` is set only for a project made from the idea box: it starts on the Brief step.
  const [open, setOpen] = useState<{ project: OpenedProject; idea?: string } | null>(null);
  const [ready, setReady] = useState(false);

  // Web dev mode can open a project at start (`--project <dir>`); in Electron this resolves to nothing.
  useEffect(() => { void app.initialProject().then((p) => { if (p) setOpen({ project: p }); }, () => {}).finally(() => setReady(true)); }, [app]);

  const close = useCallback(() => { setOpen(null); void app.closeProject(); }, [app]);

  if (!ready) return <div className="fatal" aria-busy="true" />;
  if (open) return <CreateShell key={open.project.root} project={open.project} platform={app.platform} idea={open.idea} onClose={close} />;
  return <Launcher app={app} onOpen={(project, idea) => setOpen({ project, ...(idea ? { idea } : {}) })} />;
}
