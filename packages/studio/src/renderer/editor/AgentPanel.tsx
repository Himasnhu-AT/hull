import { useEffect, useRef, useState, type JSX } from 'react';
import type { OpenedProject } from '../../shared/appApi.ts';
import { Icon } from '../ui/Icon.tsx';

// How to connect a local agent to the open project. The app hosts the MCP endpoint; this only shows the lines to paste.
const lines = (m: OpenedProject['mcp'], root: string): { id: string; label: string; text: string }[] => [
  { id: 'claude', label: 'Claude Code', text: `claude mcp add --transport http hull ${m.url}` },
  { id: 'codex', label: 'Codex (~/.codex/config.toml)', text: `[mcp_servers.hull]\ncommand = "node"\nargs = ["${m.launcher}", "${root}"]` },
  { id: 'url', label: 'Any MCP client (streamable HTTP)', text: m.url },
];

export function AgentPanel({ project, onClose }: { project: OpenedProject; onClose(): void }): JSX.Element {
  const [copied, setCopied] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent): void => { if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-agents-toggle]')) onClose(); };
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    addEventListener('pointerdown', away); addEventListener('keydown', key);
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', key); };
  }, [onClose]);
  const copy = (id: string, text: string): void => { void navigator.clipboard?.writeText(text); setCopied(id); setTimeout(() => setCopied(''), 1200); };
  return (
    <div className="agents glass" ref={ref} role="dialog" aria-label="Connect an agent">
      <h3><Icon name="plug" size={14} />Connect an agent</h3>
      <p>The app serves this project to local agents over MCP while it is open. Changes they make are recorded under their name and show up here live.</p>
      {lines(project.mcp, project.root).map((l) => (
        <div key={l.id} className="ag-row">
          <div className="ag-h"><span>{l.label}</span><button className="btn ghost" onClick={() => copy(l.id, l.text)}>{copied === l.id ? 'Copied' : 'Copy'}</button></div>
          <pre className="mono">{l.text}</pre>
        </div>
      ))}
      <p className="ag-foot">With the app closed, an agent can start the same server itself with the Codex-style command above.</p>
    </div>
  );
}
