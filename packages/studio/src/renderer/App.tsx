import { useCallback, useEffect, useState, type JSX } from 'react';
import type { HullApp, OpenedProject } from '../shared/appApi.ts';
import { Editor } from './editor/Editor.tsx';
import { Launcher } from './launcher/Launcher.tsx';

export function App({ app }: { app: HullApp }): JSX.Element {
  const [project, setProject] = useState<OpenedProject | null>(null);
  const [ready, setReady] = useState(false);

  // Web dev mode can open a project at start (`--project <dir>`); in Electron this resolves to nothing.
  useEffect(() => { void app.initialProject().then((p) => { if (p) setProject(p); }, () => {}).finally(() => setReady(true)); }, [app]);

  const close = useCallback(() => { setProject(null); void app.closeProject(); }, [app]);

  if (!ready) return <div className="fatal" aria-busy="true" />;
  if (project) return <Editor key={project.root} project={project} platform={app.platform} onClose={close} />;
  return <Launcher app={app} onOpen={setProject} />;
}
