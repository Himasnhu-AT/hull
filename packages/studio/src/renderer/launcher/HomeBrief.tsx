// The brief, on the home page: the idea was sent from the box in the middle, a game folder was made for it, and the chat
// with the builder carries on here, the box at the bottom. When the brief is approved (or the person moves on), the app opens
// the game's own screens at Build.

import { useEffect, useState, type JSX } from 'react';
import type { OpenedProject } from '../../shared/appApi.ts';
import { BriefScreen } from '../create/BriefScreen.tsx';
import { ScreenBoundary } from '../create/ScreenBoundary.tsx';
import { BuilderProvider } from '../create/useBuilder.tsx';
import { RpcClient, studioUrl } from '../lib/rpc.ts';

export function HomeBrief({ project, idea, onDone, onLeave }: { project: OpenedProject; idea: string; onDone(): void; onLeave(): void }): JSX.Element | null {
  // Created in an effect, not during render, so React's double-mount in development closes only the first client.
  const [rpc, setRpc] = useState<RpcClient | null>(null);
  useEffect(() => { const c = new RpcClient(studioUrl(project.url)); setRpc(c); return () => c.close(); }, [project.url]);
  if (!rpc) return null;
  return (
    <ScreenBoundary screen="Brief" backLabel="Back to your games" onBack={onLeave}>
      <BuilderProvider key={rpc.id} rpc={rpc} project={project}>
        <BriefScreen rpc={rpc} project={project} idea={idea} onApproved={onDone} home />
      </BuilderProvider>
    </ScreenBoundary>
  );
}
